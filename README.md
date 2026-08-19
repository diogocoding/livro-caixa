# Livro-Caixa — finanças automatizadas (Pluggy + Cloudflare)

Sistema que puxa transações das suas contas/cartões automaticamente (via Open Finance,
usando a Pluggy), guarda tudo num banco D1, e mostra num dashboard (instalável como app,
com notificação push) que atualiza sozinho — sem precisar digitar nada, só de vez em
quando ajustar uma categoria ou definir uma meta.

**Custo: R$ 0.** Pluggy é gratuito para uso pessoal, e Workers + D1 + Pages do Cloudflare
têm plano free mais que suficiente para o volume de dados de duas pessoas.

<!-- 🎬 GIF/vídeo de demonstração da interface (com dados fictícios) aqui -->
<img width="1152" height="648" alt="1° (3) (1) (1)" src="https://github.com/user-attachments/assets/3c111b62-7d18-41c4-9f58-a3f6257fbd57" />


---

## O que o sistema faz

- **Sincroniza sozinho**, a cada 10 minutos, todas as contas/cartões conectados na Pluggy.
- **Categoriza automaticamente** por palavra-chave na descrição (ajustável), e lembra de
  qualquer correção manual feita no dashboard — não sobrescreve de novo no próximo sync.
- **Dashboard** com resumo por categoria, por mês, por pessoa, evolução de saldo e gastos
  frequentes.
- **Faturas de cartão** — lista as últimas faturas fechadas/abertas, com filtro por período.
- **Empréstimos e financiamentos** — saldo devedor, parcelas pagas/restantes, taxa de juros.
- **Metas de gasto por categoria**, com barra de progresso.
- **Previsão de saldo (30 dias)**, com base na média de gasto real dos últimos meses.
- **Alerta de fatura perto de vencer** (3 dias) e de **meta de categoria estourada**.
- **Notificação push** desses alertas direto no celular, via PWA instalável.
- **Tema claro/escuro.**

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

## 2. Criar o banco D1 e rodar as migrations (5 min)

```bash
npm install -g wrangler
wrangler login   # ou: export CLOUDFLARE_API_TOKEN=seu-token (útil em Codespaces)

cd financas/worker
wrangler d1 create financas-db
# copie o "database_id" que aparecer e cole em wrangler.toml
```

Rode o schema base e, em seguida, **todas** as migrations em ordem (cada uma adiciona uma
feature — empréstimos, financiamento, histórico de saldo, faturas, metas/push):

```bash
cd ..
wrangler d1 execute financas-db --file=schema.sql --remote
wrangler d1 execute financas-db --file=migration_001_pagination.sql --remote
wrangler d1 execute financas-db --file=migration_002_loans.sql --remote
wrangler d1 execute financas-db --file=migration_003_financiamento.sql --remote
wrangler d1 execute financas-db --file=migration_004_balance_history.sql --remote
wrangler d1 execute financas-db --file=migration_005_bills.sql --remote
wrangler d1 execute financas-db --file=migration_006_goals_push.sql --remote
```

Se estiver configurando do zero, rode todas em sequência. Se estiver **atualizando** um
banco já existente, rode só as migrations que ainda não foram aplicadas.

## 3. Instalar as dependências do Worker (1 min)

```bash
cd worker
npm install
```

Isso baixa o `@pushforge/builder`, biblioteca usada pra montar e assinar as notificações
push (as libs tradicionais de Web Push não rodam em Cloudflare Workers).

## 4. Configurar os secrets do Worker (5 min)

```bash
wrangler secret put PLUGGY_CLIENT_ID
wrangler secret put PLUGGY_CLIENT_SECRET
wrangler secret put API_SECRET
# ^ invente uma senha qualquer, forte — protege a sua própria API

wrangler secret put PLUGGY_ITEM_MAP
# quando pedir o valor, cole algo como:
# [{"itemId":"seu-item-id-aqui","personId":"you"},{"itemId":"item-id-dele-aqui","personId":"partner"}]
```

Para as notificações push funcionarem, configure também os 3 secrets **VAPID** (gere o seu
par de chaves com `npx @pushforge/builder vapid`, ou use um já gerado):

```bash
wrangler secret put VAPID_PUBLIC_KEY
wrangler secret put VAPID_PRIVATE_KEY
# ^ cole o JSON inteiro numa linha só, ex: {"alg":"ES256","key_ops":["sign"], ... }
wrangler secret put VAPID_SUBJECT
# ^ ex: mailto:seuemail@gmail.com (sem espaço em volta dos dois-pontos)
```

Sem os secrets VAPID configurados, o resto do app funciona normal — só o sino de
notificação avisa que o servidor não tem push configurado.

## 5. Deploy do Worker (1 min)

```bash
wrangler deploy
```

Isso te dá uma URL tipo `https://financas-worker.SEU-USUARIO.workers.dev`.
Teste: `curl -H "Authorization: Bearer SUA_SENHA" https://.../api/sync` — deve sincronizar
e trazer o resumo das transações puxadas.

O cron já está configurado (`wrangler.toml`) pra rodar sozinho **a cada 10 minutos**,
sincronizando as contas e checando alertas de fatura/meta — sem vocês precisarem fazer nada.

### Deploy automático do Worker via GitHub Actions

O repo já tem `.github/workflows/deploy-worker.yml`: toda vez que algo em `worker/` é
alterado e enviado pra branch `main`, o worker é re-deployado sozinho. Pra isso funcionar,
configure em **GitHub > Settings > Secrets and variables > Actions**:

- `CLOUDFLARE_API_TOKEN` = um API Token da Cloudflare com permissão de editar Workers/D1
  (Dashboard > My Profile > API Tokens > Create Token).

## 6. Deploy do frontend no Cloudflare Pages, com as credenciais automáticas (5 min, só uma vez)

A URL do Worker e a senha da API **não ficam no código**. Elas são injetadas
automaticamente pelo `build.sh` (na raiz do repo) toda vez que o Cloudflare Pages faz o
deploy, a partir de variáveis de ambiente configuradas no painel — nunca são commitadas
no Git nem digitadas por vocês no site. O `build.sh` também copia o manifest, o service
worker e os ícones do PWA pro build final.

1. Suba o repositório inteiro (incluindo `build.sh` e a pasta `frontend/`) pro GitHub.
2. No Cloudflare, vá em **Workers & Pages > Create > Pages > Connect to Git** e escolha o repo.
3. Em **Build settings**:
   - **Build command**: `bash build.sh`
   - **Build output directory**: `dist`
4. Em **Settings > Environment variables**, adicione (em "Production", e repita em "Preview" se for usar):
   - `API_URL` = a URL do Worker do passo 5 (ex: `https://financas-worker.SEU-USUARIO.workers.dev`)
   - `API_SECRET` = o mesmo valor que você definiu com `wrangler secret put API_SECRET` no passo 4
     — marque como **"Encrypt"** (o Cloudflare esconde o valor no painel depois de salvo, só ele
     consegue usar na hora do build)
5. Clique em **Save and Deploy**. Pronto — o dashboard já sobe funcionando, sem tela de "Config" e
   sem nada pra vocês digitarem depois disso. Todo novo deploy (a cada push no repo) já injeta tudo
   de novo sozinho.

## 7. Proteger com o Cloudflare Zero Trust (só no frontend)

Coloque o **Access Application do Zero Trust só na URL do Pages** (`livro-caixa.pages.dev` ou o domínio
que você configurar), com uma política permitindo apenas o e-mail de vocês dois (login por
código de e-mail ou conta Google — sem senha fixa pra ninguém esquecer).

**Não coloque Access na frente do Worker** (`financas-worker...workers.dev`). O Worker já tem sua
própria proteção (o `API_SECRET`, injetado automaticamente como vimos acima), e colocar Access nele
também quebra as chamadas do navegador (o Access intercepta o `fetch()` com uma página de login em
vez de responder com CORS). Como só quem passa pelo login do Access consegue sequer abrir a página e
enxergar esse segredo, a combinação das duas camadas já cobre o "só eu e meu namorado" sem
burocracia extra no dia a dia.

## 8. Instalar como app no celular (PWA)

Abra a URL do Pages no navegador do celular e use a opção **"Instalar app"** (não
"Adicionar à tela inicial" — essa cria só um atalho comum, sem ícone/tela cheia de verdade).
Depois de instalado, toque no **sino** no header do app pra ativar as notificações push
(fatura perto de vencer, meta de categoria estourada).

> Se o app já foi instalado antes de uma atualização no `manifest.json` ou no `sw.js`,
> desinstale e instale de novo — o navegador guarda em cache a versão antiga desses
> arquivos e não atualiza sozinho na hora.

---

## Como funciona, por dentro

- **`worker/`** — Cloudflare Worker que: (a) autentica na Pluggy, (b) a cada 10 minutos
  (cron) busca transações/faturas/empréstimos novos de cada conta conectada e grava no D1,
  (c) confere alertas de fatura/meta e dispara push quando necessário, (d) expõe a API
  abaixo pro frontend.
- **`schema.sql` + `migration_*.sql`** — schema do banco: contas, transações, categorias
  (com meta de gasto mensal), faturas, empréstimos, histórico de saldo, inscrições push e
  alertas de meta já disparados (pra não repetir notificação).
- **`frontend/index.html`** — dashboard estático (sem framework, JS puro + Chart.js),
  hospedado no Cloudflare Pages, que consome a API do Worker.
- **`frontend/manifest.json` + `frontend/sw.js`** — tornam o dashboard instalável como PWA
  (ícone, tela cheia sem barra do navegador, cache do "shell" pra abrir rápido) e cuidam de
  receber e exibir as notificações push.

### Rotas da API (Worker)

Todas exigem o header `Authorization: Bearer <API_SECRET>`.

| Rota | Método | O que faz |
|---|---|---|
| `/api/sync` | GET | Força sincronização de todas as contas (também roda via cron) |
| `/api/recategorize` | GET | Reaplica as regras de categorização em todas as transações já salvas |
| `/api/transactions` | GET | Lista transações (filtros: `from`, `to`, `category`, `person`, `accountId`) |
| `/api/transactions/:id` | PATCH | Atualiza a categoria de uma transação manualmente |
| `/api/summary` | GET | Resumo agregado por categoria/mês/pessoa |
| `/api/accounts` | GET | Lista contas conectadas (saldo, limite) |
| `/api/bills` | GET | Lista faturas de cartão |
| `/api/loans` | GET | Lista empréstimos/financiamentos (saldo devedor, parcelas) |
| `/api/debt-history` | GET | Histórico de evolução da dívida |
| `/api/categories` | GET | Lista categorias com meta de gasto mensal (`monthly_budget`) |
| `/api/categories/:name` | PATCH | Define/remove a meta de gasto de uma categoria |
| `/api/push/vapid-public-key` | GET | Retorna a chave pública VAPID (usada pelo frontend pra se inscrever) |
| `/api/push/subscribe` | POST | Registra a inscrição de notificação push do navegador |
| `/api/push/unsubscribe` | POST | Remove uma inscrição |

## Categorização

A Pluggy categoriza automaticamente só no plano pago (feature "Enrichment"). No plano
gratuito, o Worker usa um mapeamento simples por palavra-chave na descrição da transação
(`mapMerchantToCategory` em `worker/src/index.js`) — ajustem essas regras conforme os
nomes que aparecerem nos seus extratos. Qualquer categoria que vocês corrigirem manualmente
no dashboard fica "travada" (não é sobrescrita no próximo sync) — não é aprendizado
automático, é só uma trava por transação específica.

## Notificações push

O worker manda push quando, no cron de 10 em 10 minutos, detecta:
- uma **fatura entrando na janela de 3 dias** antes do vencimento (marcada como já avisada
  pra não repetir, via coluna `alerted_due_soon` em `bills`);
- uma **meta de categoria estourada** no mês (uma notificação por categoria/mês, controlada
  pela tabela `budget_alerts`).

Se o sino aparecer avisando "servidor sem VAPID configurado", revise o passo 4 acima.

## Sobre o uso deste repositório

Este projeto foi construído com apoio do Claude Code para acelerar a implementação, com
arquitetura, modelo de dados e decisões de segurança definidos por nós. É um projeto de
uso pessoal — se for rodar o seu próprio, configure suas próprias credenciais da Pluggy e
do Cloudflare (nenhuma credencial real fica versionada aqui, veja `.gitignore` e a seção
de secrets acima).

## Próximos passos possíveis (não incluídos ainda)

- Notificação por e-mail/WhatsApp além do push
- Tela de "dívidas" separada, com plano de quitação priorizado por juros
- Exportar relatório mensal em PDF
