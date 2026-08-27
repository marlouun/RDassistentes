# RD Assistentes

Painel interno para assistentes comerciais da Brunx, integrado ao RD Station Conversas e ao RD Station CRM.

## Objetivo inicial

- autenticação própria para assistentes;
- vínculo assistente -> vendedor padrão, com troca controlada quando permitido;
- consulta da carteira do vendedor;
- visualização do histórico de conversas;
- envio de mensagens pela API do RD Station Conversas;
- visão da fila comercial quando os dados estiverem disponíveis pela API;
- criação de negociações no RD Station CRM em nome do vendedor;
- auditoria das ações realizadas pelo painel.

## Arquitetura planejada

- Frontend: React + Vite
- Backend: Cloudflare Workers
- Banco: Cloudflare D1
- Hospedagem: Cloudflare Pages + Workers

## Segurança

Segredos da RD Station nunca devem ser commitados neste repositório. Tokens, JWTs e chaves serão configurados apenas no backend via secrets/variáveis de ambiente do Cloudflare.

> Projeto em fase inicial de implementação.
