/**
 * Worker de Finanças — sincroniza dados da Pluggy (Open Finance) num banco D1
 * e expõe uma API pro frontend consumir.
 *
 * Rotas:
 *   GET  /api/sync              -> força sincronização de todas as contas (também roda via cron)
 *   GET  /api/transactions      -> lista transações (filtros: from, to, category, person, accountId)
 *   GET  /api/summary           -> resumo agregado por categoria/mês/pessoa
 *   GET  /api/accounts          -> lista contas conectadas (saldo, limite)
 *   PATCH /api/transactions/:id -> atualiza categoria manualmente
 *
 * Todas as rotas exigem header:  Authorization: Bearer <API_SECRET>
 * (API_SECRET é definido como secret do Worker, é só uma senha compartilhada entre vocês dois)
 */

const PLUGGY_BASE = 'https://api.pluggy.ai';

// -------------------- Auth com a Pluggy --------------------

async function getPluggyApiKey(env) {
  const cached = await env.KV_CACHE?.get?.('pluggy_api_key').catch(() => null);
  if (cached) return cached;

  const res = await fetch(`${PLUGGY_BASE}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: env.PLUGGY_CLIENT_ID,
      clientSecret: env.PLUGGY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Falha ao autenticar na Pluggy: ${res.status} ${await res.text()}`);
  const data = await res.json();
  // apiKey expira em 2h, cacheamos por 100 min se houver KV configurado
  await env.KV_CACHE?.put?.('pluggy_api_key', data.apiKey, { expirationTtl: 6000 }).catch(() => {});
  return data.apiKey;
}

async function pluggyFetch(env, path, apiKey) {
  const res = await fetch(`${PLUGGY_BASE}${path}`, {
    headers: { 'X-API-KEY': apiKey },
  });
  if (!res.ok) throw new Error(`Pluggy ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

// -------------------- Sync --------------------

/**
 * ITEM_MAP vem do env como JSON: [{ "itemId": "...", "personId": "you" }, { "itemId": "...", "personId": "partner" }]
 * Cada item = uma conexão bancária (um de vocês pode ter mais de um item se conectar mais de um banco).
 */
function getItemMap(env) {
  try {
    return JSON.parse(env.PLUGGY_ITEM_MAP || '[]');
  } catch {
    return [];
  }
}

// Processa no MÁXIMO uma conta, uma página (até 500 transações) por chamada.
// Isso mantém cada execução leve o suficiente pra não estourar o limite de CPU
// do Worker no plano gratuito. Pra puxar todo o histórico, chame /api/sync
// repetidamente (o dashboard e o cron já fazem isso sozinhos).
async function syncAll(env) {
  const apiKey = await getPluggyApiKey(env);
  const itemMap = getItemMap(env);
  const allAccountIds = [];

  // Atualiza a lista de contas (isso é rápido, poucas chamadas)
  for (const { itemId, personId } of itemMap) {
    const accountsResp = await pluggyFetch(env, `/accounts?itemId=${itemId}`, apiKey);
    for (const acc of accountsResp.results || []) {
      await env.DB.prepare(
        `INSERT INTO accounts (id, item_id, person_id, name, type, subtype, balance, credit_limit, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, balance=excluded.balance, credit_limit=excluded.credit_limit, updated_at=datetime('now')`
      ).bind(
        acc.id, itemId, personId,
        acc.name || acc.marketingName || acc.type,
        acc.type, acc.subtype || null,
        acc.balance ?? null,
        acc.creditData?.creditLimit ?? null
      ).run();
      allAccountIds.push(acc.id);
    }
  }

  // Acha a próxima conta que ainda não terminou de sincronizar o histórico
  const pending = await env.DB.prepare(
    `SELECT a.id FROM accounts a
     LEFT JOIN sync_state s ON s.account_id = a.id
     WHERE COALESCE(s.done, 0) = 0
     LIMIT 1`
  ).first();

  if (!pending) {
    return { status: 'tudo sincronizado', totalContas: allAccountIds.length };
  }

  const result = await syncOnePage(env, apiKey, pending.id);
  return { contaProcessada: pending.id, ...result };
}

async function syncOnePage(env, apiKey, accountId) {
  const state = await env.DB.prepare(
    `SELECT cursor FROM sync_state WHERE account_id = ?1`
  ).bind(accountId).first();

  // A Pluggy descontinuou o antigo /transactions (paginação por página) em favor do
  // /v2/transactions, que usa paginação por cursor (campo 'next' na resposta).
  const url = state?.cursor
    ? `/v2/transactions${state.cursor}`
    : `/v2/transactions?accountId=${accountId}`;

  const resp = await pluggyFetch(env, url, apiKey);
  const stmt = env.DB.prepare(
    `INSERT INTO transactions
       (id, account_id, date, description, amount, currency, pluggy_category, category, status,
        installment_number, total_installments, merchant_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7,
             COALESCE((SELECT category FROM transactions WHERE id = ?1 AND category_override = 1), ?7),
             ?8, ?9, ?10, ?11)
     ON CONFLICT(id) DO UPDATE SET
       date=excluded.date, description=excluded.description, amount=excluded.amount,
       status=excluded.status,
       category = CASE WHEN (SELECT category_override FROM transactions WHERE id = ?1) = 1
                        THEN (SELECT category FROM transactions WHERE id = ?1)
                        ELSE excluded.pluggy_category END`
  );

  let count = 0;
  for (const tx of resp.results || []) {
    await stmt.bind(
      tx.id, accountId, tx.date, tx.description, tx.amount,
      tx.currencyCode || 'BRL',
      mapMerchantToCategory(tx),
      tx.status,
      tx.creditCardMetadata?.installmentNumber ?? null,
      tx.creditCardMetadata?.totalInstallments ?? null,
      tx.merchant?.name ?? null
    ).run();
    count++;
  }

  const done = resp.next ? 0 : 1;
  await env.DB.prepare(
    `INSERT INTO sync_state (account_id, last_synced_at, cursor, done)
     VALUES (?1, datetime('now'), ?2, ?3)
     ON CONFLICT(account_id) DO UPDATE SET
       last_synced_at = datetime('now'), cursor = ?2, done = ?3`
  ).bind(accountId, resp.next || null, done).run();

  return { transacoesNestaPagina: count, contaCompleta: !!done, temMaisPaginas: !done };
}

// Fallback simples de categorização quando a Pluggy não manda 'category'
// (categoria automática enriquecida é feature paga da Pluggy; isso aqui é um mapeamento básico por palavra-chave,
// calibrado com os extratos reais de vocês — ajustem/adicionem regras conforme surgirem nomes novos)
function mapMerchantToCategory(tx) {
  const d = (tx.description || '').toLowerCase();

  const rules = [
    // --- Cartão / Dívida (renegociação, juros, encargos, pagamento de fatura de outro cartão) ---
    [/renegocia|pendenc|rotativo|encargo|juros|iof\b/, 'Cartão / Dívida'],

    // --- Contas de casa (utilidades, gás, telefonia, lavanderia) ---
    [/luz|energia|enel|cemig|cpfl|celpe/, 'Contas de casa'],
    [/agua|saneago|sabesp|compesa/, 'Contas de casa'],
    [/\bgas\b|nilson ?gas/, 'Contas de casa'],
    [/\btim\b|vivo|claro|oi\s|plano nucel|net(flix)?fone/, 'Contas de casa'],
    [/lav\s?60|lavanderia/, 'Contas de casa'],

    [/aluguel|condomin/, 'Moradia'],

    // --- Assinaturas (streaming, apps, software, academia) ---
    [/netflix|spotify|amazon prime|disney|hbo|youtube premium/, 'Assinaturas'],
    [/wellhub|gympass|smartfit|academia/, 'Assinaturas'],
    [/anthropic|claude|chatgpt|openai|midjourney/, 'Assinaturas'],
    [/assistenciasa|assist[eê]ncia t[eé]c/, 'Assinaturas'],

    // --- Transporte ---
    [/uber|99\s?ride|dl\*99|tembici|posto|ipiranga|combust/, 'Transporte'],

    // --- Mercado (compras de casa/mês) ---
    [/mercado(?!livre)|supermercado|atacad|hortifruti|comercial de aliment/, 'Mercado'],
    [/mercadolivre|ec \*mercadolivre/, 'Outros'], // compras online gerais, não mercado

    // --- Alimentação (lanches, delivery do dia a dia — diferente de "Mercado") ---
    [/lanche|ifood|99food|comedoria/, 'Alimentação'],

    // --- Saúde ---
    [/farmacia|drogaria|extra farma|hospital|clinica|suplement|clicouconsulta/, 'Saúde'],

    // --- Lazer / cuidado pessoal ---
    [/barber|cabelei|salao de beleza|shopee|maxmulti/, 'Lazer'],

    // --- Transferências para pessoas (PIX nominal) — revisem manualmente, pode ser
    // repasse de conta de casa, ajuda a alguém, diarista etc. ---
    [/tiagorenan|tiago renan|sandravaleria|boa vista$|alyson felipe|carlito mo/, 'Transferências'],

    [/fatura|pagamento.*cart/, 'Cartão / Dívida'],
  ];

  for (const [re, cat] of rules) if (re.test(d)) return cat;
  return 'Outros';
}

// -------------------- API --------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

function checkAuth(req, env) {
  const auth = req.headers.get('Authorization') || '';
  return auth === `Bearer ${env.API_SECRET}`;
}

async function handleTransactions(req, env) {
  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const category = url.searchParams.get('category');
  const person = url.searchParams.get('person');

  let query = `SELECT t.*, a.person_id, a.name as account_name
               FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE 1=1`;
  const binds = [];
  if (from) { query += ` AND t.date >= ?`; binds.push(from); }
  if (to) { query += ` AND t.date <= ?`; binds.push(to); }
  if (category) { query += ` AND t.category = ?`; binds.push(category); }
  if (person) { query += ` AND a.person_id = ?`; binds.push(person); }
  query += ` ORDER BY t.date DESC LIMIT 1000`;

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json(results);
}

async function handleSummary(req, env) {
  const url = new URL(req.url);
  const months = Number(url.searchParams.get('months') || 6);

  const byCategory = await env.DB.prepare(
    `SELECT category, SUM(amount) as total, COUNT(*) as n
     FROM transactions
     WHERE date >= date('now', '-1 months', 'start of month') AND amount > 0
     GROUP BY category ORDER BY total DESC`
  ).all();

  const byMonth = await env.DB.prepare(
    `SELECT strftime('%Y-%m', date) as month, a.person_id,
            SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as gastos
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE date >= date('now', '-${months} months')
     GROUP BY month, a.person_id ORDER BY month ASC`
  ).all();

  const byPerson = await env.DB.prepare(
    `SELECT a.person_id, SUM(CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END) as total
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE date >= date('now', 'start of month')
     GROUP BY a.person_id`
  ).all();

  const accounts = await env.DB.prepare(`SELECT * FROM accounts`).all();

  // Parcelas em aberto: soma do que ainda falta pagar de compras parceladas
  // (assume valor igual por parcela, que é como a maioria dos cartões brasileiros funciona)
  const upcoming = await env.DB.prepare(
    `SELECT category, SUM(amount * (total_installments - installment_number)) as total
     FROM transactions
     WHERE total_installments IS NOT NULL AND installment_number IS NOT NULL
       AND installment_number < total_installments AND amount > 0
     GROUP BY category ORDER BY total DESC`
  ).all();

  return json({
    byCategory: byCategory.results,
    byMonth: byMonth.results,
    byPerson: byPerson.results,
    accounts: accounts.results,
    upcoming: upcoming.results,
  });
}

async function handleUpdateCategory(req, env, id) {
  const body = await req.json();
  if (!body.category) return json({ error: 'category é obrigatório' }, 400);
  await env.DB.prepare(
    `UPDATE transactions SET category = ?1, category_override = 1 WHERE id = ?2`
  ).bind(body.category, id).run();
  return json({ ok: true });
}

// Corrige de uma vez as categorias das transações já sincronizadas (não mexe em nada
// que já foi editado manualmente). Roda 1x só, direto no banco, sem chamar a Pluggy de novo.
async function handleRecategorize(env) {
  const result = await env.DB.prepare(`
    UPDATE transactions
    SET category = CASE
      WHEN LOWER(description) LIKE '%renegocia%' OR LOWER(description) LIKE '%pendenc%' OR LOWER(description) LIKE '%rotativo%' OR LOWER(description) LIKE '%encargo%' OR LOWER(description) LIKE '%juros%' OR LOWER(description) LIKE '%iof%' THEN 'Cartão / Dívida'
      WHEN LOWER(description) LIKE '%luz%' OR LOWER(description) LIKE '%energia%' OR LOWER(description) LIKE '%enel%' OR LOWER(description) LIKE '%cemig%' OR LOWER(description) LIKE '%cpfl%' OR LOWER(description) LIKE '%celpe%' THEN 'Contas de casa'
      WHEN LOWER(description) LIKE '%agua%' OR LOWER(description) LIKE '%saneago%' OR LOWER(description) LIKE '%sabesp%' OR LOWER(description) LIKE '%compesa%' THEN 'Contas de casa'
      WHEN LOWER(description) LIKE '%gas%' THEN 'Contas de casa'
      WHEN LOWER(description) LIKE '%tim %' OR LOWER(description) LIKE '%tim.%' OR LOWER(description) LIKE '%vivo%' OR LOWER(description) LIKE '%claro%' OR LOWER(description) LIKE '%plano nucel%' THEN 'Contas de casa'
      WHEN LOWER(description) LIKE '%lav60%' OR LOWER(description) LIKE '%lav 60%' OR LOWER(description) LIKE '%lavanderia%' THEN 'Contas de casa'
      WHEN LOWER(description) LIKE '%aluguel%' OR LOWER(description) LIKE '%condomin%' THEN 'Moradia'
      WHEN LOWER(description) LIKE '%netflix%' OR LOWER(description) LIKE '%spotify%' OR LOWER(description) LIKE '%amazon prime%' OR LOWER(description) LIKE '%disney%' OR LOWER(description) LIKE '%hbo%' THEN 'Assinaturas'
      WHEN LOWER(description) LIKE '%wellhub%' OR LOWER(description) LIKE '%gympass%' OR LOWER(description) LIKE '%smartfit%' THEN 'Assinaturas'
      WHEN LOWER(description) LIKE '%anthropic%' OR LOWER(description) LIKE '%claude%' OR LOWER(description) LIKE '%chatgpt%' OR LOWER(description) LIKE '%openai%' THEN 'Assinaturas'
      WHEN LOWER(description) LIKE '%assistenciasa%' THEN 'Assinaturas'
      WHEN LOWER(description) LIKE '%uber%' OR LOWER(description) LIKE '%99 ride%' OR LOWER(description) LIKE '%dl*99%' OR LOWER(description) LIKE '%dl *99%' OR LOWER(description) LIKE '%tembici%' OR LOWER(description) LIKE '%posto%' OR LOWER(description) LIKE '%ipiranga%' THEN 'Transporte'
      WHEN LOWER(description) LIKE '%mercadolivre%' OR LOWER(description) LIKE '%mercado livre%' OR LOWER(description) LIKE '%ec *mercado%' THEN 'Outros'
      WHEN LOWER(description) LIKE '%mercado%' OR LOWER(description) LIKE '%supermercado%' OR LOWER(description) LIKE '%atacad%' OR LOWER(description) LIKE '%hortifruti%' OR LOWER(description) LIKE '%comercial de aliment%' THEN 'Mercado'
      WHEN LOWER(description) LIKE '%lanche%' OR LOWER(description) LIKE '%ifood%' OR LOWER(description) LIKE '%99food%' OR LOWER(description) LIKE '%comedoria%' THEN 'Alimentação'
      WHEN LOWER(description) LIKE '%farmacia%' OR LOWER(description) LIKE '%drogaria%' OR LOWER(description) LIKE '%extra farma%' OR LOWER(description) LIKE '%hospital%' OR LOWER(description) LIKE '%clinica%' OR LOWER(description) LIKE '%suplement%' OR LOWER(description) LIKE '%clicouconsulta%' OR LOWER(description) LIKE '%medprev%' THEN 'Saúde'
      WHEN LOWER(description) LIKE '%barber%' OR LOWER(description) LIKE '%cabelei%' OR LOWER(description) LIKE '%shopee%' THEN 'Lazer'
      WHEN LOWER(description) LIKE '%tiagorenan%' OR LOWER(description) LIKE '%tiago renan%' OR LOWER(description) LIKE '%sandravaleria%' OR LOWER(description) LIKE '%boa vista%' OR LOWER(description) LIKE '%alyson felipe%' OR LOWER(description) LIKE '%carlito mo%' THEN 'Transferências'
      WHEN LOWER(description) LIKE '%fatura%' THEN 'Cartão / Dívida'
      WHEN LOWER(description) LIKE '%pix%' OR LOWER(description) LIKE '%transfer%' OR LOWER(description) LIKE '%ted %' THEN 'Transferências'
      ELSE 'Outros'
    END
    WHERE category_override = 0
  `).run();
  return json({ ok: true, linhasAtualizadas: result.meta?.changes ?? null });
}

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,PATCH,OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization,Content-Type',
        },
      });
    }

    if (!checkAuth(req, env)) return json({ error: 'unauthorized' }, 401);

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/api/sync') return json({ synced: await syncAll(env) });
      if (path === '/api/recategorize') return await handleRecategorize(env);
      if (path === '/api/transactions') return await handleTransactions(req, env);
      if (path === '/api/summary') return await handleSummary(req, env);
      if (path === '/api/accounts') {
        const { results } = await env.DB.prepare('SELECT * FROM accounts').all();
        return json(results);
      }
      if (path.startsWith('/api/transactions/') && req.method === 'PATCH') {
        const id = path.split('/').pop();
        return await handleUpdateCategory(req, env, id);
      }
      return json({ error: 'not found' }, 404);
    } catch (err) {
      return json({ error: String(err.message || err) }, 500);
    }
  },

  // Roda sozinho todo dia às 06:00 UTC (03:00 horário de Brasília) — configurado no wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};