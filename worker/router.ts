import baseWorker from './index';

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOTSTRAP_SECRET?: string;
  RD_CONVERSAS_TOKEN?: string;
  RD_CRM_TOKEN?: string;
}

type Role = 'admin' | 'assistant';

type SessionUser = {
  id: number;
  name: string;
  email: string;
  role: Role;
};

type SellerAccessRow = {
  id: number;
  name: string;
  rd_employee_id: string | null;
  wallet_name: string | null;
};

type CustomerSummary = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  currentWallet: string | null;
  tags: string[];
  lastMessage: {
    content: string | null;
    channel: string | null;
    createdAt: string | null;
  } | null;
};

const SESSION_COOKIE = 'rdassist_session';
const RD_API_BASE = 'https://api.tallos.com.br';
const RD_TIMEOUT_MS = 12_000;
const SOURCE_PAGE_SIZE = 20;
const MAX_SOURCE_PAGES_PER_REQUEST = 2;
const MAX_MATCHES_PER_REQUEST = 20;
const DETAIL_CONCURRENCY = 8;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const contactsRoute = url.pathname.match(/^\/api\/sellers\/(\d+)\/contacts$/);

    if (!contactsRoute || request.method !== 'GET') {
      return baseWorker.fetch(request, env);
    }

    try {
      ensureDatabase(env);
      ensureRdToken(env);

      const user = await requireUser(env, request);
      const sellerId = Number(contactsRoute[1]);
      const seller = await requireSellerAccess(env, user, sellerId);
      if (!seller.wallet_name) {
        throw new HttpError(409, 'wallet_not_mapped', 'Este vendedor ainda nao possui uma carteira mapeada.');
      }

      const cursor = positiveInt(url.searchParams.get('cursor'), 1);
      const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
      const result = await loadWalletContacts(env, seller, cursor, search);

      return json({
        seller: {
          id: seller.id,
          name: seller.name,
          rdEmployeeId: seller.rd_employee_id,
          walletName: seller.wallet_name,
        },
        ...result,
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code, message: error.message }, error.status);
      }
      console.error('Wallet contacts error', error);
      return json({ error: 'internal_error', message: 'Erro interno ao carregar a carteira.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function loadWalletContacts(env: Env, seller: SellerAccessRow, startPage: number, search: string) {
  const matches: CustomerSummary[] = [];
  let page = startPage;
  let reachedEnd = false;
  let scannedPages = 0;

  while (scannedPages < MAX_SOURCE_PAGES_PER_REQUEST && matches.length < MAX_MATCHES_PER_REQUEST && !reachedEnd) {
    const payload = await rdGet(env, `/v2/customers?page=${page}&limit=${SOURCE_PAGE_SIZE}&channels=whatsapp`);
    const rawCustomers = extractCollection(payload, ['customers', 'data', 'items', 'results']);
    scannedPages += 1;

    if (rawCustomers.length === 0) {
      reachedEnd = true;
      break;
    }

    const normalized = rawCustomers
      .map(normalizeCustomerSummary)
      .filter((customer): customer is CustomerSummary => Boolean(customer));

    const enriched = await mapLimit(normalized, DETAIL_CONCURRENCY, async (customer) => {
      if (customer.currentWallet) return customer;
      const digits = customer.phone.replace(/\D/g, '');
      if (!digits) return customer;

      const detailPayload = await rdGetOptional(env, `/v2/contacts/${encodeURIComponent(digits)}/exists?channel=whatsapp`);
      if (!detailPayload) return customer;
      return mergeContactDetail(customer, detailPayload);
    });

    for (const customer of enriched) {
      if (!sameWallet(customer.currentWallet, seller.wallet_name)) continue;
      if (!matchesSearch(customer, search)) continue;
      matches.push(customer);
      if (matches.length >= MAX_MATCHES_PER_REQUEST) break;
    }

    if (rawCustomers.length < SOURCE_PAGE_SIZE) {
      reachedEnd = true;
    } else {
      page += 1;
    }
  }

  return {
    contacts: matches.slice(0, MAX_MATCHES_PER_REQUEST),
    nextCursor: reachedEnd ? null : page,
    scannedPages,
    sourcePage: startPage,
    note: 'A API da RD lista contatos sem filtro nativo por carteira; o backend percorre os contatos em lotes e valida current_wallet no detalhe.',
  };
}

async function requireUser(env: Env, request: Request): Promise<SessionUser> {
  const rawToken = getCookie(request, SESSION_COOKIE);
  if (!rawToken) throw new HttpError(401, 'unauthorized', 'Sessao nao encontrada.');

  const tokenHash = await sha256(rawToken);
  const user = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.expires_at > CURRENT_TIMESTAMP
        AND u.active = 1
      LIMIT 1`,
  ).bind(tokenHash).first<SessionUser>();

  if (!user) throw new HttpError(401, 'unauthorized', 'Sessao expirada ou invalida.');
  await env.DB.prepare('UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token_hash = ?').bind(tokenHash).run();
  return user;
}

async function requireSellerAccess(env: Env, user: SessionUser, sellerId: number): Promise<SellerAccessRow> {
  if (!Number.isInteger(sellerId) || sellerId <= 0) {
    throw new HttpError(400, 'invalid_seller', 'Vendedor invalido.');
  }

  let seller: SellerAccessRow | null;
  if (user.role === 'admin') {
    seller = await env.DB.prepare(
      `SELECT id, name, rd_employee_id, wallet_name
         FROM sellers
        WHERE id = ? AND active = 1
        LIMIT 1`,
    ).bind(sellerId).first<SellerAccessRow>();
  } else {
    seller = await env.DB.prepare(
      `SELECT s.id, s.name, s.rd_employee_id, s.wallet_name
         FROM user_sellers us
         JOIN sellers s ON s.id = us.seller_id
        WHERE us.user_id = ?
          AND us.seller_id = ?
          AND us.can_select = 1
          AND s.active = 1
        LIMIT 1`,
    ).bind(user.id, sellerId).first<SellerAccessRow>();
  }

  if (!seller) throw new HttpError(403, 'seller_forbidden', 'Voce nao possui acesso a este vendedor.');
  return seller;
}

async function rdGet(env: Env, path: string): Promise<unknown> {
  const result = await rdFetch(env, path, false);
  if (result === null) throw new HttpError(502, 'rd_upstream_error', 'A RD nao retornou o recurso esperado.');
  return result;
}

async function rdGetOptional(env: Env, path: string): Promise<unknown | null> {
  return rdFetch(env, path, true);
}

async function rdFetch(env: Env, path: string, allowNotFound: boolean): Promise<unknown | null> {
  const token = ensureRdToken(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RD_TIMEOUT_MS);

  try {
    const response = await fetch(`${RD_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (allowNotFound && response.status === 404) return null;
    if (response.status === 401) throw new HttpError(502, 'rd_unauthorized', 'A RD rejeitou o token configurado (401).');
    if (response.status === 403) throw new HttpError(502, 'rd_forbidden', 'O token da RD nao possui permissao para consultar contatos (403).');
    if (!response.ok) {
      console.error('RD contacts upstream error', { path, status: response.status });
      throw new HttpError(502, 'rd_upstream_error', `A RD retornou erro HTTP ${response.status}.`);
    }

    try {
      return await response.json();
    } catch {
      throw new HttpError(502, 'rd_invalid_response', 'A RD retornou uma resposta que nao e JSON.');
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new HttpError(504, 'rd_timeout', 'A RD demorou demais para responder os contatos.');
    }
    console.error('RD contacts request failed', error);
    throw new HttpError(502, 'rd_unavailable', 'Nao foi possivel consultar os contatos no RD Station Conversas.');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCustomerSummary(value: unknown): CustomerSummary | null {
  if (!isRecord(value)) return null;
  const id = firstString(value, ['_id', 'id', 'customer_id', 'customerId']);
  const phone = firstString(value, ['cel_phone', 'phone', 'cellphone', 'whatsapp']) ?? '';
  if (!id || !phone) return null;

  return {
    id,
    name: firstString(value, ['full_name', 'name', 'whatsapp_name']) ?? phone,
    phone,
    email: firstString(value, ['email']),
    currentWallet: firstString(value, ['current_wallet', 'wallet_name', 'walletName', 'wallet']),
    tags: stringArray(value.tags),
    lastMessage: normalizeLastMessage(value.last_message_data),
  };
}

function mergeContactDetail(summary: CustomerSummary, payload: unknown): CustomerSummary {
  const detail = extractDetail(payload);
  if (!detail) return summary;
  return {
    id: firstString(detail, ['_id', 'id', 'customer_id', 'customerId']) ?? summary.id,
    name: firstString(detail, ['full_name', 'name', 'whatsapp_name']) ?? summary.name,
    phone: firstString(detail, ['cel_phone', 'phone', 'cellphone', 'whatsapp']) ?? summary.phone,
    email: firstString(detail, ['email']) ?? summary.email,
    currentWallet: firstString(detail, ['current_wallet', 'wallet_name', 'walletName', 'wallet']) ?? summary.currentWallet,
    tags: stringArray(detail.tags).length > 0 ? stringArray(detail.tags) : summary.tags,
    lastMessage: normalizeLastMessage(detail.last_message_data) ?? summary.lastMessage,
  };
}

function extractDetail(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.data)) return payload.data;
  if (isRecord(payload.customer)) return payload.customer;
  if (isRecord(payload.contact)) return payload.contact;
  return payload;
}

function normalizeLastMessage(value: unknown): CustomerSummary['lastMessage'] {
  if (!isRecord(value)) return null;
  return {
    content: firstString(value, ['content', 'message', 'text']),
    channel: firstString(value, ['channel']),
    createdAt: firstString(value, ['created_at', 'createdAt', 'date']),
  };
}

function sameWallet(currentWallet: string | null, expectedWallet: string | null): boolean {
  if (!currentWallet || !expectedWallet) return false;
  return currentWallet.trim().localeCompare(expectedWallet.trim(), 'pt-BR', { sensitivity: 'base' }) === 0;
}

function matchesSearch(contact: CustomerSummary, search: string): boolean {
  if (!search) return true;
  const text = search.toLocaleLowerCase('pt-BR');
  const digits = search.replace(/\D/g, '');
  return (
    contact.name.toLocaleLowerCase('pt-BR').includes(text) ||
    (contact.email ?? '').toLocaleLowerCase('pt-BR').includes(text) ||
    contact.phone.toLocaleLowerCase('pt-BR').includes(text) ||
    (digits.length > 0 && contact.phone.replace(/\D/g, '').includes(digits))
  );
}

function extractCollection(payload: unknown, keys: string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) {
      for (const nestedKey of keys) {
        const nested = value[nestedKey];
        if (Array.isArray(nested)) return nested;
      }
    }
  }
  return [];
}

async function mapLimit<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return null;
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function ensureDatabase(env: Env): asserts env is Env & { DB: D1Database } {
  if (!env.DB) throw new HttpError(503, 'database_not_configured', 'Banco D1 ainda nao esta conectado ao Worker.');
}

function ensureRdToken(env: Env): string {
  const token = env.RD_CONVERSAS_TOKEN?.trim();
  if (!token) throw new HttpError(503, 'rd_conversas_not_configured', 'Token do RD Station Conversas nao configurado no Worker.');
  return token;
}

function baseHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: baseHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
