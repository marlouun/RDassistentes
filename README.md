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
- Backend: Cloudflare Pages Functions (runtime Workers)
- Banco: Cloudflare D1
- Hospedagem: Cloudflare Pages

O frontend e a API ficam no mesmo domínio. Isso permite usar sessão via cookie `HttpOnly`, sem expor token de autenticação no JavaScript do navegador.

## Segurança

- Tokens da RD nunca são enviados ao frontend.
- Tokens/JWTs devem ser cadastrados como Secrets no Cloudflare.
- Senhas do painel são armazenadas usando PBKDF2-SHA256 com salt aleatório e 210.000 iterações.
- Sessões usam token aleatório de 256 bits; somente o hash do token é armazenado no D1.
- Cookie de sessão: `HttpOnly`, `Secure` e `SameSite=Strict`.
- Bloqueio temporário após tentativas repetidas de login.
- Ações relevantes possuem estrutura de auditoria no banco.
- Arquivos `.env` e `.dev.vars` reais são ignorados pelo Git.

## Primeiro setup

### 1. Instalar dependências

```bash
npm install
```

### 2. Criar o D1

```bash
npx wrangler d1 create rd-assistentes
```

Copie o `database_id` retornado pelo Cloudflare e substitua `REPLACE_WITH_D1_DATABASE_ID` em `wrangler.toml`.

### 3. Aplicar a migration

Local:

```bash
npx wrangler d1 migrations apply rd-assistentes --local
```

Produção:

```bash
npx wrangler d1 migrations apply rd-assistentes --remote
```

### 4. Configurar segredos

Para desenvolvimento, copie `.dev.vars.example` para `.dev.vars` e preencha localmente.

Em produção, cadastre os valores no painel do Cloudflare/Pages. Nunca coloque valores reais no repositório.

Segredos previstos:

- `BOOTSTRAP_SECRET`
- `RD_CONVERSAS_TOKEN`
- `RD_CRM_TOKEN`

### 5. Criar o primeiro administrador

Com o projeto publicado e o D1 configurado, faça uma única chamada `POST /api/bootstrap`:

```json
{
  "name": "Administrador",
  "email": "admin@empresa.com.br",
  "password": "uma-senha-forte-com-12-ou-mais-caracteres",
  "bootstrapSecret": "o-mesmo-valor-do-BOOTSTRAP_SECRET"
}
```

O bootstrap só funciona enquanto a tabela de usuários estiver vazia. Depois que o primeiro usuário é criado, a rota passa a retornar conflito e não cria novos administradores.

## Desenvolvimento

Frontend:

```bash
npm run dev
```

Validação:

```bash
npm run typecheck
npm run build
```

Para testar Pages Functions + D1 localmente, gere primeiro o build e use Wrangler Pages Dev.

## O que esta primeira etapa ainda não faz

Esta fundação não chama a API da RD ainda. As próximas etapas conectarão, nesta ordem:

1. funcionários/vendedores e carteiras;
2. contatos da carteira;
3. histórico e envio de mensagens;
4. fila comercial, conforme o que a API expuser;
5. criação de negociações no RD CRM com responsável e campos dinâmicos.
