# RD Assistentes

Painel interno para assistentes comerciais da Brunx, integrado ao RD Station Conversas e ao RD Station CRM.

## Escopo planejado

- autenticação própria para assistentes;
- vínculo assistente -> vendedor padrão, com troca controlada quando permitido;
- consulta da carteira do vendedor;
- visualização do histórico de conversas;
- envio de mensagens pela API do RD Station Conversas;
- visão da fila comercial quando os dados estiverem disponíveis pela API;
- criação de negociações no RD Station CRM em nome do vendedor;
- auditoria das ações realizadas pelo painel.

## Arquitetura

- Frontend: React + Vite
- Backend: Cloudflare Worker
- Assets: Cloudflare Workers Static Assets
- Banco: Cloudflare D1
- Deploy: Cloudflare Workers com integração GitHub

O Worker atende as rotas `/api/*` e serve o frontend React no restante do domínio. Isso permite usar sessão via cookie `HttpOnly`, sem expor os tokens da RD no JavaScript do navegador.

## Segurança

- Tokens da RD nunca são enviados ao frontend.
- Tokens/JWTs devem ser cadastrados como Secrets no Cloudflare.
- Senhas do painel são armazenadas usando PBKDF2-SHA256 com salt aleatório e 210.000 iterações.
- Sessões usam token aleatório de 256 bits; somente o hash do token é armazenado no D1.
- Cookie de sessão: `HttpOnly`, `Secure` e `SameSite=Strict`.
- Bloqueio temporário após tentativas repetidas de login.
- Ações relevantes possuem estrutura de auditoria no banco.
- Arquivos `.env` e `.dev.vars` reais são ignorados pelo Git.

## Deploy no Cloudflare

### 1. Criar/importar o Worker pelo GitHub

Na criação do projeto use:

- Repositório: `marlouun/RDassistentes`
- Production branch: `main`
- Build command: `npm run build`
- Deploy command: `npx wrangler deploy`
- Root directory: `/`

O arquivo `wrangler.toml` já aponta para `worker/index.ts` e publica a pasta `dist` como Static Assets.

### 2. Criar o D1

Crie um banco chamado `rd-assistentes` no painel do Cloudflare.

Depois, no Worker, abra **Settings > Bindings > Add binding > D1 Database** e configure:

- Variable name: `DB`
- Database: `rd-assistentes`

O código espera exatamente o binding `DB`.

### 3. Aplicar a migration

Abra o banco D1 no painel e execute o arquivo `migrations/0001_initial.sql` no console SQL.

Também é possível aplicar por Wrangler:

```bash
npx wrangler d1 migrations apply rd-assistentes --remote
```

### 4. Configurar segredos

Em **Settings > Variables and Secrets**, cadastre como secrets:

- `BOOTSTRAP_SECRET`
- `RD_CONVERSAS_TOKEN` (quando a integração RD for habilitada)
- `RD_CRM_TOKEN` (quando a integração CRM for habilitada)

Nunca coloque valores reais no repositório.

`CLOUDFLARE_API_TOKEN` é apenas uma credencial de deploy quando necessária. Ela não é usada pela aplicação em runtime. Se um token for exposto em print, chat ou commit, revogue-o e gere outro.

### 5. Testar o Worker

Após o deploy, abra:

`/api/health`

O retorno esperado é semelhante a:

```json
{
  "ok": true,
  "service": "rd-assistentes",
  "runtime": "cloudflare-worker"
}
```

### 6. Criar o primeiro administrador

Com o projeto publicado, D1 conectado e `BOOTSTRAP_SECRET` configurado, faça uma única chamada `POST /api/bootstrap`:

```json
{
  "name": "Administrador",
  "email": "admin@empresa.com.br",
  "password": "uma-senha-forte-com-12-ou-mais-caracteres",
  "bootstrapSecret": "o-mesmo-valor-do-BOOTSTRAP_SECRET"
}
```

O bootstrap só funciona enquanto a tabela de usuários estiver vazia.

## Desenvolvimento

Frontend somente:

```bash
npm run dev
```

Worker + frontend compilado:

```bash
npm run cf:dev
```

Validação:

```bash
npm run typecheck
npm run build
```

Deploy manual:

```bash
npm run cf:deploy
```

## Próximas etapas

Esta fundação ainda não chama a API da RD. As próximas etapas conectarão, nesta ordem:

1. funcionários/vendedores e carteiras;
2. contatos da carteira;
3. histórico e envio de mensagens;
4. fila comercial, conforme o que a API expuser;
5. criação de negociações no RD CRM com responsável e campos dinâmicos.
