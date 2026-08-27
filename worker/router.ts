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

type ContactCacheRow = {
  rd_contact_id: string;
  phone: string;
  name: string;
  email: string | null;
  wallet_name: string | null;
  tags_json: string;
  last_message_json: string | null;
  synced_at: string;
};

type SyncStateRow = {
  seller_id: number;
  next_page: number;
  next_index: number;
  reached_end: number;
  last_sync_at: string | null;
};

const SESSION_COOKIE = 'rdassist_session';
const RD_API_BASE = 'https://api.tallos.com.br';
const RD_TIMEOUT_MS = 12_000;
const SOURCE_PAGE_SIZE = 50;
const MAX_SOURCE_PAGES_PER_SYNC = 3;
const DETAIL_REQUESTS_PER_SYNC = 4;
const DETAIL_DELAY_MS = 400;
const CACHE_PAGE_SIZE = 50;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const contactsRoute = url.pathname.match(/^\/api\/sellers\/(\d+)\/contacts$/);
    const syncRoute = url.pathname.match(/^\/api\/sellers\/(\d+)\/contacts\/sync$/);

    if (!contactsRoute && !syncRoute) {
      return baseWorker.fetch(request, env);
    }

    try {
      ensureDatabase(env);
      const user = await requireUser(env, request);
      const sellerId = Number((contactsRoute ?? syncRoute)?.[1]);
      const seller = await requireSellerAccess(env, user, sellerId);

      if (!seller.wallet_name) {
        throw new HttpError(409, 'wallet_not_mapped', 'Este vendedor ainda nao possui uma carteira mapeada.');
      }

      await ensureCacheSchema(env);

      if (contactsRoute && request.method === 'GET') {
        const page = positiveInt(url.searchParams.get('page'), 1);
        const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
        return json(await loadCachedWalletContacts(env, seller, page, search));
      }

      if (syncRoute && request.method === 'POST') {
        enforceSameOrigin(request);
        ensureRdToken(env);
        const result = await syncWalletContacts(env, seller);
        return json(result, result.rateLimited ? 200 : 200);
      }

      return json({ error: 'method_not_allowed', message: 'Metodo nao permitido.' }, 405);
    } catch (error) {
      if (error instanceof HttpError) {
        return json(
          {
            error: error.code,
            message: error.message,
            ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
          },
          error.status,
        );
      }

      console.error('Wallet contacts error', error);
      return json({ error: 'internal_error', message: 'Erro interno ao carregar a carteira.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function loadCachedWalletContacts(env: Env, seller: SellerAccessRow, page: number, search: string) {
  const walletName = seller.wallet_name;
  if (!walletName) throw new HttpError(409, 'wallet_not_mapped', 'Este vendedor ainda nao possui uma carteira mapeada.');

  const whereParts = ['LOWER(TRIM(wallet_name)) = LOWER(TRIM(?))'];
  const bindings: Array<string | number> = [walletName];

  if (search) {
    const like = `%${search}%`;
    const digits = search.replace(/\D/g, '');
    whereParts.push(`(
      name LIKE ? COLLATE NOCASE
      OR email LIKE ? COLLATE NOCASE
      OR phone LIKE ? COLLATE NOCASE
      OR REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', '') LIKE ?
    )`);
    bindings.push(like, like, like, `%${digits || search}%`);
  }

  const where = whereParts.join(' AND ');
  const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM rd_contact_cache WHERE ${where}`)
    .bind(...bindings)
    .first<{ total: number }>();

  const offset = (page - 1) * CACHE_PAGE_SIZE;
  const rows = await env.DB.prepare(
    `SELECT rd_contact_id, phone, name, email, wallet_name, tags_json, last_message_json, synced_at
       FROM rd_contact_cache
      WHERE ${where}
      ORDER BY name COLLATE NOCASE ASC, rd_contact_id ASC
      LIMIT ? OFFSET ?`,
  )
    .bind(...bindings, CACHE_PAGE_SIZE, offset)
    .all<ContactCacheRow>();

  const syncState = await getSyncState(env, seller.id);
  const total = count?.total ?? 0;

  return {
    seller: {
      id: seller.id,
      name: seller.name,
      rdEmployeeId: seller.rd_employee_id,
      walletName,
    },
    contacts: rows.results.map(cacheRowToContact),
    page,
    pageSize: CACHE_PAGE_SIZE,
    total,
    hasMore: offset + rows.results.length < total,
    sync: {
      nextSourcePage: syncState.next_page,
      nextSourceIndex: syncState.next_index,
      reachedEnd: syncState.reached_end === 1,
      lastSyncAt: syncState.last_sync_at,
    },
    note: total > 0
      ? 'Contatos exibidos pelo cache local. Buscar e paginar nao gera novas chamadas para a RD.'
      : 'Ainda nao ha contatos desta carteira no cache. Use Sincronizar proximo lote para importar da RD com limite controlado.',
  };
}

async function syncWalletContacts(env: Env, seller: SellerAccessRow) {
  const walletName = seller.wallet_name;
  if (!walletName) throw new HttpError(409, 'wallet_not_mapped', 'Este vendedor ainda nao possui uma carteira mapeada.');

  let state = await getSyncState(env, seller.id);
  if (state.reached_end === 1) {
    return {
      ok: true,
      synced: 0,
      matchedWallet: 0,
      detailRequests: 0,
      pagesScanned: 0,
      rateLimited: false,
      reachedEnd: true,
      nextSourcePage: state.next_page,
      nextSourceIndex: state.next_index,
      message: 'A sincronizacao ja chegou ao fim da listagem da RD. O cache pode ser reiniciado futuramente para uma nova varredura.',
    };
  }

  let synced = 0;
  let matchedWallet = 0;
  let detailRequests = 0;
  let pagesScanned = 0;
  let rateLimited = false;
  let retryAfterSeconds: number | null = null;

  while (pagesScanned < MAX_SOURCE_PAGES_PER_SYNC && state.reached_end !== 1) {
    let payload: unknown;
    try {
      payload = await rdGet(
        env,
        `/v2/customers?page=${state.next_page}&limit=${SOURCE_PAGE_SIZE}&channels=whatsapp`,
      );
    } catch (error) {
      if (error instanceof HttpError && error.code === 'rd_rate_limited') {
        rateLimited = true;
        retryAfterSeconds = error.retryAfterSeconds;
        break;
      }
      throw error;
    }

    const rawCustomers = extractCollection(payload, ['customers', 'data', 'items', 'results']);
    pagesScanned += 1;

    if (rawCustomers.length === 0) {
      state = { ...state, reached_end: 1, next_index: 0 };
      break;
    }

    const normalized = rawCustomers
      .map(normalizeCustomerSummary)
      .filter((customer): customer is CustomerSummary => Boolean(customer));

    let stoppedInsidePage = false;

    for (let index = state.next_index; index < normalized.length; index += 1) {
      let customer = normalized[index];

      if (!customer.currentWallet) {
        const cached = await getFreshCachedContact(env, customer);
        if (cached.fresh) {
          customer = mergeCachedContact(customer, cached.row);
        } else {
          if (detailRequests >= DETAIL_REQUESTS_PER_SYNC) {
            state = { ...state, next_index: index };
            stoppedInsidePage = true;
            break;
          }

          if (detailRequests > 0) await sleep(DETAIL_DELAY_MS);

          try {
            const digits = customer.phone.replace(/\D/g, '');
            if (digits) {
              const detailPayload = await rdGetOptional(
                env,
                `/v2/contacts/${encodeURIComponent(digits)}/exists?channel=whatsapp`,
              );
              detailRequests += 1;
              if (detailPayload) customer = mergeContactDetail(customer, detailPayload);
            }
          } catch (error) {
            if (error instanceof HttpError && error.code === 'rd_rate_limited') {
              rateLimited = true;
              retryAfterSeconds = error.retryAfterSeconds;
              state = { ...state, next_index: index };
              stoppedInsidePage = true;
              break;
            }
            throw error;
          }
        }
      }

      await upsertCachedContact(env, customer);
      synced += 1;
      if (sameWallet(customer.currentWallet, walletName)) matchedWallet += 1;
      state = { ...state, next_index: index + 1 };
    }

    if (stoppedInsidePage) break;

    if (state.next_index >= normalized.length) {
      const reachedEnd = rawCustomers.length < SOURCE_PAGE_SIZE;
      state = {
        ...state,
        next_page: reachedEnd ? state.next_page : state.next_page + 1,
        next_index: 0,
        reached_end: reachedEnd ? 1 : 0,
      };
    }
  }

  await saveSyncState(env, state);

  const cachedForWallet = await env.DB.prepare(
    'SELECT COUNT(*) AS total FROM rd_contact_cache WHERE LOWER(TRIM(wallet_name)) = LOWER(TRIM(?))',
  )
    .bind(walletName)
    .first<{ total: number }>();

  return {
    ok: true,
    synced,
    matchedWallet,
    cachedForWallet: cachedForWallet?.total ?? 0,
    detailRequests,
    pagesScanned,
    rateLimited,
    retryAfterSeconds,
    reachedEnd: state.reached_end === 1,
    nextSourcePage: state.next_page,
    nextSourceIndex: state.next_index,
    message: rateLimited
      ? `A RD limitou temporariamente as requisicoes. O que ja foi processado ficou salvo no cache${retryAfterSeconds ? `; tente novamente em cerca de ${retryAfterSeconds}s` : ''}.`
      : 'Lote sincronizado com sucesso. O cache foi atualizado sem repetir consultas de detalhe desnecessarias.',
  };
}

async function ensureCacheSchema(env: Env): Promise<void> {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rd_contact_cache (
      rd_contact_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT,
      wallet_name TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      last_message_json TEXT,
      synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
  ).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_rd_contact_cache_wallet ON rd_contact_cache(wallet_name)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_rd_contact_cache_phone ON rd_contact_cache(phone)').run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rd_contact_sync_state (
      seller_id INTEGER PRIMARY KEY,
      next_page INTEGER NOT NULL DEFAULT 1,
      next_index INTEGER NOT NULL DEFAULT 0,
      reached_end INTEGER NOT NULL DEFAULT 0,
      last_sync_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE
    )`,
  ).run();
}

async function getSyncState(env: Env, sellerId: number): Promise<SyncStateRow> {
  const existing = await env.DB.prepare(
    `SELECT seller_id, next_page, next_index, reached_end, last_sync_at
       FROM rd_contact_sync_state
      WHERE seller_id = ?
      LIMIT 1`,
  )
    .bind(sellerId)
    .first<SyncStateRow>();

  return existing ?? {
    seller_id: sellerId,
    next_page: 1,
    next_index: 0,
    reached_end: 0,
    last_sync_at: null,
  };
}

async function saveSyncState(env: Env, state: SyncStateRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rd_contact_sync_state (seller_id, next_page, next_index, reached_end, last_sync_at, updated_at)
     VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(seller_id) DO UPDATE SET
       next_page = excluded.next_page,
       next_index = excluded.next_index,
       reached_end = excluded.reached_end,
       last_sync_at = CURRENT_TIMESTAMP,
       updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(state.seller_id, state.next_page, state.next_index, state.reached_end)
    .run();
}

async function getFreshCachedContact(
  env: Env,
  customer: CustomerSummary,
): Promise<{ fresh: boolean; row: ContactCacheRow | null }> {
  const row = await env.DB.prepare(
    `SELECT rd_contact_id, phone, name, email, wallet_name, tags_json, last_message_json, synced_at
       FROM rd_contact_cache
      WHERE rd_contact_id = ? OR phone = ?
      ORDER BY CASE WHEN rd_contact_id = ? THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(customer.id, customer.phone, customer.id)
    .first<ContactCacheRow>();

  if (!row) return { fresh: false, row: null };
  const freshness = await env.DB.prepare("SELECT ? > datetime('now', '-6 hours') AS fresh")
    .bind(row.synced_at)
    .first<{ fresh: number }>();
  return { fresh: freshness?.fresh === 1, row };
}

async function upsertCachedContact(env: Env, customer: CustomerSummary): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rd_contact_cache (
       rd_contact_id, phone, name, email, wallet_name, tags_json, last_message_json, synced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(rd_contact_id) DO UPDATE SET
       phone = excluded.phone,
       name = excluded.name,
       email = COALESCE(excluded.email, rd_contact_cache.email),
       wallet_name = COALESCE(excluded.wallet_name, rd_contact_cache.wallet_name),
       tags_json = excluded.tags_json,
       last_message_json = COALESCE(excluded.last_message_json, rd_contact_cache.last_message_json),
       synced_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      customer.id,
      customer.phone,
      customer.name,
      customer.email,
      customer.currentWallet,
      JSON.stringify(customer.tags),
      customer.lastMessage ? JSON.stringify(customer.lastMessage) : null,
    )
    .run();
}

function cacheRowToContact(row: ContactCacheRow): CustomerSummary {
  return {
    id: row.rd_contact_id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    currentWallet: row.wallet_name,
    tags: parseStringArray(row.tags_json),
    lastMessage: parseLastMessage(row.last_message_json),
  };
}

function mergeCachedContact(summary: CustomerSummary, row: ContactCacheRow | null): CustomerSummary {
  if (!row) return summary;
  const cached = cacheRowToContact(row);
  return {
    id: summary.id || cached.id,
    name: summary.name || cached.name,
    phone: summary.phone || cached.phone,
    email: summary.email ?? cached.email,
    currentWallet: summary.currentWallet ?? cached.currentWallet,
    tags: summary.tags.length > 0 ? summary.tags : cached.tags,
    lastMessage: summary.lastMessage ?? cached.lastMessage,
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
  )
    .bind(tokenHash)
    .first<SessionUser>();

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
    )
      .bind(sellerId)
      .first<SellerAccessRow>();
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
    )
      .bind(user.id, sellerId)
      .first<SellerAccessRow>();
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
    if (response.status === 429) {
      const retryHeader = response.headers.get('Retry-After');
      const retryAfterSeconds = retryHeader ? Number.parseInt(retryHeader, 10) : null;
      throw new HttpError(
        429,
        'rd_rate_limited',
        retryAfterSeconds && Number.isFinite(retryAfterSeconds)
          ? `A RD atingiu o limite temporario de requisicoes. Tente novamente em aproximadamente ${retryAfterSeconds} segundos.`
          : 'A RD atingiu o limite temporario de requisicoes. Aguarde um pouco e tente novamente.',
        retryAfterSeconds && Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
      );
    }
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
    currentWallet: walletNameFromRecord(value),
    tags: normalizeTags(value.tags ?? value.selected_tags),
    lastMessage: normalizeLastMessage(value.last_message_data ?? value.lastMessage),
  };
}

function mergeContactDetail(summary: CustomerSummary, payload: unknown): CustomerSummary {
  const detail = findContactRecord(payload);
  if (!detail) return summary;
  const tags = normalizeTags(detail.tags ?? detail.selected_tags);

  return {
    id: firstString(detail, ['_id', 'id', 'customer_id', 'customerId']) ?? summary.id,
    name: firstString(detail, ['full_name', 'name', 'whatsapp_name']) ?? summary.name,
    phone: firstString(detail, ['cel_phone', 'phone', 'cellphone', 'whatsapp']) ?? summary.phone,
    email: firstString(detail, ['email']) ?? summary.email,
    currentWallet: walletNameFromRecord(detail) ?? summary.currentWallet,
    tags: tags.length > 0 ? tags : summary.tags,
    lastMessage: normalizeLastMessage(detail.last_message_data ?? detail.lastMessage) ?? summary.lastMessage,
  };
}

function findContactRecord(payload: unknown, depth = 0): Record<string, unknown> | null {
  if (!isRecord(payload) || depth > 4) return null;

  if (
    'cel_phone' in payload
    || 'phone' in payload
    || 'current_wallet' in payload
    || 'wallet_name' in payload
    || 'full_name' in payload
  ) {
    return payload;
  }

  for (const key of ['data', 'customer', 'contact', 'result', 'item']) {
    const nested = payload[key];
    const found = findContactRecord(nested, depth + 1);
    if (found) return found;
  }

  return null;
}

function walletNameFromRecord(record: Record<string, unknown>): string | null {
  for (const key of ['current_wallet', 'wallet_name', 'walletName', 'wallet']) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }
    if (isRecord(value)) {
      const nested = firstString(value, ['name', 'title', 'wallet_name', 'walletName', 'label']);
      if (nested) return nested;
    }
  }
  return null;
}

function normalizeLastMessage(value: unknown): CustomerSummary['lastMessage'] {
  if (!isRecord(value)) return null;
  return {
    content: firstString(value, ['content', 'message', 'text']),
    channel: firstString(value, ['channel']),
    createdAt: firstString(value, ['created_at', 'createdAt', 'date']),
  };
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' || typeof item === 'number') {
      const text = String(item).trim();
      if (text) tags.add(text);
      continue;
    }
    if (isRecord(item)) {
      const text = firstString(item, ['name', 'title', 'label', 'tag']);
      if (text) tags.add(text);
    }
  }
  return [...tags];
}

function sameWallet(currentWallet: string | null, expectedWallet: string | null): boolean {
  if (!currentWallet || !expectedWallet) return false;
  return currentWallet.trim().localeCompare(expectedWallet.trim(), 'pt-BR', { sensitivity: 'base' }) === 0;
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

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function parseLastMessage(value: string | null): CustomerSummary['lastMessage'] {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizeLastMessage(parsed);
  } catch {
    return null;
  }
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

function enforceSameOrigin(request: Request): void {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  if (origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'invalid_origin', 'Origem da requisicao nao permitida.');
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}
