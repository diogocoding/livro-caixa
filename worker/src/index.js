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

      // Faturas (atuais e futuras) — só existe em cartão de crédito
      if (acc.type === 'CREDIT') {
        try {
          const billsResp = await pluggyFetch(env, `/bills?accountId=${acc.id}`, apiKey);
          for (const bill of billsResp.results || []) {
            await env.DB.prepare(
              `INSERT INTO bills (id, account_id, person_id, due_date, total_amount, minimum_payment, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET
                 due_date=excluded.due_date, total_amount=excluded.total_amount,
                 minimum_payment=excluded.minimum_payment, updated_at=datetime('now')`
            ).bind(
              bill.id, acc.id, personId, bill.dueDate,
              bill.totalAmount ?? null, bill.minimumPaymentAmount ?? null
            ).run();
          }
        } catch (e) {
          // se o banco não expuser faturas futuras, segue o sync normalmente
        }
      }

      // Grava 1 snapshot de saldo por dia (não a cada sync) — usado no gráfico de evolução da dívida
      const today = new Date().toISOString().slice(0, 10);
      const already = await env.DB.prepare(
        `SELECT id FROM balance_history WHERE account_id = ?1 AND date(recorded_at) = ?2 LIMIT 1`
      ).bind(acc.id, today).first();
      if (!already) {
        await env.DB.prepare(
          `INSERT INTO balance_history (account_id, balance) VALUES (?1, ?2)`
        ).bind(acc.id, acc.balance ?? null).run();
      }
    }

    // Empréstimos são um produto separado do cartão/conta — nem todo banco expõe isso,
    // então uma lista vazia aqui é normal (não é erro).
    try {
      const loansResp = await pluggyFetch(env, `/loans?itemId=${itemId}`, apiKey);
      for (const loan of loansResp.results || []) {
        await env.DB.prepare(
          `INSERT INTO loans (id, item_id, person_id, contract_number, loan_type, principal_amount,
             outstanding_balance, interest_rate, installment_amount, number_of_installments,
             paid_installments, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))
           ON CONFLICT(id) DO UPDATE SET
             outstanding_balance=excluded.outstanding_balance,
             paid_installments=excluded.paid_installments,
             updated_at=datetime('now')`
        ).bind(
          loan.id, itemId, personId,
          loan.contractNumber ?? null,
          loan.type ?? null,
          loan.contractAmount ?? null,
          loan.outstandingBalance ?? null,
          loan.interestRate?.monthlyRate ?? null,
          loan.installmentAmount ?? null,
          loan.numberOfInstallments ?? null,
          loan.paidInstallments ?? null
        ).run();
      }
    } catch (e) {
      // Se a Pluggy não tiver o produto de empréstimo habilitado ou não houver
      // empréstimo nessa conta, apenas segue o sync normalmente.
    }
  }

  // Acha a próxima conta que ainda não terminou o backfill do histórico
  const pending = await env.DB.prepare(
    `SELECT a.id FROM accounts a
     LEFT JOIN sync_state s ON s.account_id = a.id
     WHERE COALESCE(s.done, 0) = 0
     LIMIT 1`
  ).first();

  if (pending) {
    const result = await syncOnePage(env, apiKey, pending.id);
    return { modo: 'backfill', contaProcessada: pending.id, ...result };
  }

  // Todas as contas já têm o histórico completo: agora é sync incremental (só o que é novo)
  const staleAccount = await env.DB.prepare(
    `SELECT account_id, last_synced_at FROM sync_state
     WHERE done = 1
     ORDER BY last_synced_at ASC
     LIMIT 1`
  ).first();

  if (!staleAccount) {
    return { status: 'nada pra sincronizar ainda', totalContas: allAccountIds.length };
  }

  const result = await syncIncremental(env, apiKey, staleAccount.account_id, staleAccount.last_synced_at);
  return { modo: 'incremental', contaProcessada: staleAccount.account_id, ...result };
}

// Depois que o histórico todo já foi puxado, isso roda a cada sync (a cada 10 min via cron)
// só buscando transações novas desde a última vez, sem reprocessar tudo de novo.
async function syncIncremental(env, apiKey, accountId, lastSyncedAt) {
  // Busca com uma folga de 3 dias pra trás, pra pegar qualquer transação que
  // ainda estava "pendente" e virou "processada" nesse intervalo (comum em cartão de crédito)
  const dateFrom = new Date(new Date(lastSyncedAt + 'Z').getTime() - 3 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  const resp = await pluggyFetch(env, `/v2/transactions?accountId=${accountId}&dateFrom=${dateFrom}`, apiKey);
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
      tx.id, accountId, tx.date, tx.description, tx.amountInAccountCurrency ?? tx.amount,
      tx.currencyCode || 'BRL',
      mapMerchantToCategory(tx),
      tx.status,
      tx.creditCardMetadata?.installmentNumber ?? null,
      tx.creditCardMetadata?.totalInstallments ?? null,
      tx.merchant?.name ?? null
    ).run();
    count++;
  }

  await env.DB.prepare(
    `UPDATE sync_state SET last_synced_at = datetime('now') WHERE account_id = ?1`
  ).bind(accountId).run();

  return { transacoesNovas: count };
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
      tx.id, accountId, tx.date, tx.description, tx.amountInAccountCurrency ?? tx.amount,
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
  const pluggyCat = (tx.category || '').toLowerCase();

  const rules = [
    // --- Investimentos (não é gasto — é dinheiro migrando pra aplicação, volta depois) ---
    [/aplicac?[aã]o rdb|resgate rdb|\bcdb\b|tesouro direto|\blci\b|\blca\b|fundo de investimento/, 'Investimentos'],

    // --- Financiamento/Crediário (parcelamento de loja, diferente do "Cartão / Dívida" que é rotativo/juros) ---
    [/parc0\d\/0\d|crediario|financ/, 'Financiamento'],

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

  // Se nenhuma regra específica bateu, usa dados estruturados como último recurso:
  // qualquer compra parcelada (2x ou mais) que não caiu em nenhuma categoria específica
  // provavelmente é financiamento de loja (mesmo sem o nome "PARC" na descrição).
  if ((tx.creditCardMetadata?.totalInstallments ?? 0) > 1) return 'Financiamento';
  if (/loan|financing/.test(pluggyCat)) return 'Financiamento';

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

  let query = `SELECT t.*, a.person_id, a.name as account_name, a.type as account_type
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

  // A Pluggy usa sinais opostos dependendo do tipo de conta:
  // CARTÃO DE CRÉDITO: positivo = gasto (compra), negativo = pagamento/estorno.
  // CONTA CORRENTE: negativo = gasto (saída), positivo = entrada (PIX recebido, salário).
  // Essa expressão SQL calcula o "gasto de verdade" considerando os dois casos.
  const GASTO_EXPR = `CASE
    WHEN a.type = 'CREDIT' THEN (CASE WHEN t.amount > 0 THEN t.amount ELSE 0 END)
    ELSE (CASE WHEN t.amount < 0 THEN -t.amount ELSE 0 END)
  END`;

  // Transferências e Investimentos não são "gasto" de verdade (é dinheiro migrando de conta
  // ou indo pra aplicação, não saindo do patrimônio do casal) — por isso ficam de fora do
  // total de "gasto no mês", mas continuam visíveis nos lançamentos crus se quiserem conferir.
  const NAO_E_GASTO = `('Transferências', 'Investimentos')`;

  const byCategory = await env.DB.prepare(
    `SELECT t.category as category, SUM(${GASTO_EXPR}) as total, COUNT(*) as n
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date >= date('now', 'start of month') AND t.category NOT IN ${NAO_E_GASTO}
     GROUP BY t.category HAVING total > 0 ORDER BY total DESC`
  ).all();

  const byMonth = await env.DB.prepare(
    `SELECT strftime('%Y-%m', t.date) as month, a.person_id,
            SUM(${GASTO_EXPR}) as gastos
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date >= date('now', '-${months} months') AND t.category NOT IN ${NAO_E_GASTO}
     GROUP BY month, a.person_id ORDER BY month ASC`
  ).all();

  const byPerson = await env.DB.prepare(
    `SELECT a.person_id, SUM(${GASTO_EXPR}) as total
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date >= date('now', 'start of month') AND t.category NOT IN ${NAO_E_GASTO}
     GROUP BY a.person_id`
  ).all();

  // Categoria por pessoa (pra saber onde cada um gasta mais, não só quanto)
  const byCategoryPerson = await env.DB.prepare(
    `SELECT a.person_id, t.category, SUM(${GASTO_EXPR}) as total
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date >= date('now', 'start of month') AND t.category NOT IN ${NAO_E_GASTO}
     GROUP BY a.person_id, t.category HAVING total > 0 ORDER BY total DESC`
  ).all();

  // Transferências/Investimentos separados, só informativo (não entra no "gasto")
  const movimentacoes = await env.DB.prepare(
    `SELECT t.category, SUM(${GASTO_EXPR}) as total
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date >= date('now', 'start of month') AND t.category IN ${NAO_E_GASTO}
     GROUP BY t.category HAVING total > 0`
  ).all();

  // Gasto fixo vs variável (usa o campo "type" já cadastrado na tabela categories)
  const byFixedVariable = await env.DB.prepare(
    `SELECT COALESCE(c.type, 'variavel') as tipo, SUM(${GASTO_EXPR}) as total
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN categories c ON c.name = t.category
     WHERE t.date >= date('now', 'start of month') AND t.category NOT IN ${NAO_E_GASTO}
     GROUP BY tipo`
  ).all();

  const accounts = await env.DB.prepare(`SELECT * FROM accounts`).all();

  // Parcelas em aberto: só existe em cartão de crédito (é onde tem creditCardMetadata).
  // Vem com a divisão por pessoa e a contagem de compras/parcelas restantes, não só o valor.
  const upcoming = await env.DB.prepare(
    `SELECT a.person_id, category,
            SUM(amount * (total_installments - installment_number)) as total,
            COUNT(*) as compras_ativas,
            SUM(total_installments - installment_number) as parcelas_restantes
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE total_installments IS NOT NULL AND installment_number IS NOT NULL
       AND installment_number < total_installments AND amount > 0
     GROUP BY a.person_id, category ORDER BY total DESC`
  ).all();

  // Comparação com o mês anterior (mesma métrica, mês -1)
  const byMonthTotal = await env.DB.prepare(
    `SELECT strftime('%Y-%m', t.date) as month, SUM(${GASTO_EXPR}) as total
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.date >= date('now', '-2 months', 'start of month')
     GROUP BY month ORDER BY month ASC`
  ).all();

  // Gastos mais frequentes (recorrência no dia a dia, últimos 3 meses), separado por pessoa
  const frequentes = await env.DB.prepare(
    `SELECT a.person_id, t.description, t.category, COUNT(*) as n, SUM(${GASTO_EXPR}) as total, AVG(${GASTO_EXPR}) as media
     FROM transactions t JOIN accounts a ON a.id = t.account_id
     WHERE t.category NOT IN ${NAO_E_GASTO} AND t.date >= date('now', '-3 months')
     GROUP BY a.person_id, t.description HAVING n >= 2
     ORDER BY n DESC, total DESC LIMIT 20`
  ).all();

  return json({
    byCategory: byCategory.results,
    byMonth: byMonth.results,
    byMonthTotal: byMonthTotal.results,
    byPerson: byPerson.results,
    byCategoryPerson: byCategoryPerson.results,
    byFixedVariable: byFixedVariable.results,
    movimentacoes: movimentacoes.results,
    frequentes: frequentes.results,
    accounts: accounts.results,
    upcoming: upcoming.results,
  });
}

async function handleBills(env, req) {
  const url = new URL(req.url);
  const all = url.searchParams.get('all') === '1';
  const where = all ? '' : `WHERE b.due_date >= date('now', '-2 months')`;
  const { results } = await env.DB.prepare(
    `SELECT b.*, a.name as account_name FROM bills b JOIN accounts a ON a.id = b.account_id
     ${where}
     ORDER BY b.due_date ASC`
  ).all();
  return json(results);
}

async function handleDebtHistory(env) {
  const { results } = await env.DB.prepare(
    `SELECT date(bh.recorded_at) as day, a.person_id, SUM(bh.balance) as total
     FROM balance_history bh JOIN accounts a ON a.id = bh.account_id
     WHERE a.type = 'CREDIT'
     GROUP BY day, a.person_id ORDER BY day ASC`
  ).all();
  return json(results);
}

async function handleLoans(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM loans ORDER BY outstanding_balance DESC`
  ).all();
  return json(results);
}

// Corrige transações em moeda estrangeira que já foram salvas com o valor errado
// (em dólar em vez de real) antes da correção do amountInAccountCurrency.
async function handleFixForeignCurrency(env) {
  const apiKey = await getPluggyApiKey(env);
  const { results: accounts } = await env.DB.prepare(`SELECT id FROM accounts`).all();
  let corrigidas = 0;

  for (const acc of accounts) {
    const { results: txs } = await env.DB.prepare(
      `SELECT id FROM transactions WHERE account_id = ?1 AND currency != 'BRL' AND category_override = 0`
    ).bind(acc.id).all();

    for (const tx of txs) {
      try {
        const resp = await pluggyFetch(env, `/transactions/${tx.id}`, apiKey);
        const valorCerto = resp.amountInAccountCurrency ?? resp.amount;
        await env.DB.prepare(`UPDATE transactions SET amount = ?1 WHERE id = ?2`).bind(valorCerto, tx.id).run();
        corrigidas++;
      } catch (e) {
        // segue pra próxima se essa transação específica der erro
      }
    }
  }
  return json({ ok: true, transacoesCorrigidas: corrigidas });
}

// Endpoint de diagnóstico: chama a Pluggy AO VIVO (não usa o banco) pra ver a resposta
// crua do endpoint de empréstimos — útil pra saber se "vazio" é falta de empréstimo
// mesmo, ou se é a Pluggy recusando o produto pra essas contas.
async function handleDebugLoans(env) {
  const apiKey = await getPluggyApiKey(env);
  const itemMap = getItemMap(env);
  const debug = [];
  for (const { itemId, personId } of itemMap) {
    try {
      const resp = await pluggyFetch(env, `/loans?itemId=${itemId}`, apiKey);
      debug.push({ itemId, personId, ok: true, resultados: resp.results?.length ?? 0, raw: resp });
    } catch (e) {
      debug.push({ itemId, personId, ok: false, erro: String(e.message || e) });
    }
  }
  return json(debug);
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
      WHEN LOWER(description) LIKE '%aplicacao rdb%' OR LOWER(description) LIKE '%aplicação rdb%' OR LOWER(description) LIKE '%resgate rdb%' OR LOWER(description) LIKE '%cdb%' OR LOWER(description) LIKE '%tesouro direto%' THEN 'Investimentos'
      WHEN LOWER(description) LIKE '%parc0%/0%' OR LOWER(description) LIKE '%crediario%' OR LOWER(description) LIKE '%financ%' THEN 'Financiamento'
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
      WHEN total_installments IS NOT NULL AND total_installments > 1 THEN 'Financiamento'
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
      if (path === '/api/loans') return await handleLoans(env);
      if (path === '/api/debug-loans') return await handleDebugLoans(env);
      if (path === '/api/debt-history') return await handleDebtHistory(env);
      if (path === '/api/fix-foreign-currency') return await handleFixForeignCurrency(env);
      if (path === '/api/bills') return await handleBills(env, req);
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