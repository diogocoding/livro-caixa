# Livro-Caixa — finanças automatizadas (Pluggy + Cloudflare)

Sistema que puxa transações das suas contas/cartões automaticamente (via Open Finance,
usando a Pluggy) todo dia de madrugada, guarda tudo num banco D1, e mostra num dashboard
que atualiza sozinho — sem precisar digitar nada, só de vez em quando ajustar uma categoria.

**Custo: R$ 0.** Meu Pluggy é gratuito para uso pessoal, e Workers + D1 + Pages do Cloudflare
têm plano free mais que suficiente para o volume de dados de duas pessoas.

---

## 1. Conectar os bancos na Pluggy (10 min)

1. Crie conta em **https://meu.pluggy.ai** (cada um de vocês pode usar o mesmo e-mail, ou
   criar duas contas separadas — tanto faz, o importante é o passo 6).
2. Clique em **"Conectar Minha Conta"** e conecte o cartão/conta de cada um de vocês
   (repita para cada banco).
3. Crie conta em **https://dashboard.pluggy.ai**.
4. Crie uma **aplicação** no Dashboard (uma só, pros dois).
5. Copie o **Client ID** e o **Client Secret** — vai precisar deles no passo 3 abaixo.
6. Dentro da aplicação, escolha o conector **MeuPluggy**, faça login com a conta do passo 1,
   e autorize. Repita para cada conta bancária conectada. Anote o **itemId** de cada uma
   (aparece no Dashboard, em "Items" — geralmente um item por pessoa/banco).

## 2. Criar o banco D1 (2 min)

```bash
npm install -g wrangler
wrangler login

cd financas/worker
wrangler d1 create financas-db
# copie o "database_id" que aparecer e cole em wrangler.toml
```

Depois, rode o schema:

```bash
wrangler d1 execute financas-db --file=../schema.sql --remote
```

## 3. Configurar os secrets do Worker (3 min)

```bash
wrangler secret put PLUGGY_CLIENT_ID
wrangler secret put PLUGGY_CLIENT_SECRET
wrangler secret put API_SECRET
# ^ invente uma senha qualquer, forte — protege a sua própria API

wrangler secret put PLUGGY_ITEM_MAP
# quando pedir o valor, cole algo como:
# [{"itemId":"seu-item-id-aqui","personId":"you"},{"itemId":"item-id-dele-aqui","personId":"partner"}]
```

## 4. Deploy do Worker (1 min)

```bash
wrangler deploy
```

Isso te dá uma URL tipo `https://financas-worker.SEU-USUARIO.workers.dev`.
Teste: `curl -H "Authorization: Bearer SUA_SENHA" https://.../api/sync` — deve sincronizar
e trazer o resumo das transações puxadas.

O cron já está configurado (`wrangler.toml`) pra rodar sozinho **todo dia às 03h (horário de Brasília)**,
sem vocês precisarem fazer nada.

## 5. Deploy do frontend no Cloudflare Pages (2 min)

```bash
cd ../frontend
wrangler pages deploy . --project-name=livro-caixa
```

Ou, se preferir pelo GitHub: suba a pasta `frontend/` num repo e conecte esse repo em
**Cloudflare Pages > Create Project > Connect to Git** (build command vazio, output = raiz).

## 6. Configurar o dashboard

Abra a URL que o Pages te deu, clique em **"config"** no canto superior direito, e cole:
- **URL do Worker**: a URL do passo 4
- **Senha da API**: o `API_SECRET` que você definiu no passo 3

Pronto — o dashboard já carrega os dados. Clique em **"↻ sincronizar agora"** pra forçar
uma atualização manual a qualquer momento (fora do sync automático diário).

---

## Como funciona, por dentro

- **`worker/`** — Cloudflare Worker que: (a) autentica na Pluggy, (b) todo dia de madrugada
  (cron) busca transações novas de cada conta conectada e grava no D1, (c) expõe uma API
  simples (`/api/transactions`, `/api/summary`, `/api/accounts`) pro frontend.
- **`schema.sql`** — schema do banco: contas, transações, categorias, orçamento por categoria.
- **`frontend/index.html`** — dashboard estático (sem framework, só JS puro + Chart.js),
  hospedado no Cloudflare Pages, que consome a API do Worker.

## Categorização

A Pluggy categoriza automaticamente só no plano pago (feature "Enrichment"). No plano
gratuito, o Worker usa um mapeamento simples por palavra-chave na descrição da transação
(`mapMerchantToCategory` em `worker/src/index.js`) — ajustem essas regras conforme os
nomes que aparecerem nos seus extratos. Qualquer categoria que vocês corrigirem manualmente
no dashboard fica "travada" (não é sobrescrita no próximo sync).

## Próximos passos possíveis (não incluídos ainda)

- Alertas automáticos (ex: e-mail/WhatsApp quando o cartão passar de X% do limite)
- Meta de orçamento por categoria com barra de progresso
- Tela de "dívidas" separada, com plano de quitação priorizado por juros
