interface Env {
  DB: D1Database;
  RD_CONVERSAS_TOKEN?: string;
}

type SyncAnchor = {
  id: number;
  name: string;
  wallet_name: string;
  next_page: number;
  next_index: number;
  reached_end: number;
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

type CachedWalletRow = {
  wallet_name: string | null;
};

const RD_API_BASE = 'https://api.tallos.com.br';
const RD_TIMEOUT_MS = 12_000;
const SOURCE_PAGE_SIZE = 20;
const MAX_SOURCE_PAGES_PER_RUN = 3;
const DETAIL_REQUESTS_PER_RUN = 6;
const DETAIL_DELAY_MS = 1_200;

export async function runBackgroundWalletSync(env: Env): Promise<void> {
  if (!env.DB) {
    console.warn('Background wallet sync skipped: D1 DB is not configured.');
    return;
  }

  const token = env.RD_CONVERSAS_TOKEN?.trim();
  if (!token) {
    console.warn('Background wallet sync skipped: RD_CONVERSAS_TOKEN is not configured.');
    return;
  }

  await ensureCacheSchema(env);

  const anchor = await selectSyncAnchor(env);
  if (!anchor) {
    console.log('Background wallet sync skipped: no active seller with mapped wallet.');
    return;
  }

  if (anchor.reached_end === 1) {
    console.log('Background wallet sync completed: the global RD contact scan already reached the end.', {
      anchorSellerId: anchor.id,
      anchorSellerName: anchor.name,
      page: anchor.next_page,
    });
    return;
  }

  let nextPage = anchor.next_page;
  let nextIndex = anchor.next_index;
  let reachedEnd = anchor.reached_end;
  let pagesScanned = 0;
  let detailRequests = 0;
  let contactsSaved = 0;
  let walletsResolved = 0;
  let invalidDetails = 0;
  let rateLimited = false;

  while (pagesScanned < MAX_SOURCE_PAGES_PER_RUN && reachedEnd !== 1) {
    let payload: unknown;
    try {
      payload = await rdGet(token, `/v2/customers?page=${nextPage}&limit=${SOURCE_PAGE_SIZE}&channels=whatsapp`);
    } catch (error) {
      if (error instanceof RdRateLimitError) {
        rateLimited = true;
        break;
      }
      throw error;
    }

    const rawCustomers = extractCollection(payload, ['customers', 'data', 'items', 'results']);
    pagesScanned += 1;

    if (rawCustomers.length === 0) {
      reachedEnd = 1;
      nextIndex = 0;
      break;
    }

    const customers = rawCustomers
      .map(normalizeCustomerSummary)
      .filter((customer): customer is CustomerSummary => Boolean(customer));

    let stoppedInsidePage = false;

    for (let index = nextIndex; index < customers.length; index += 1) {
      let customer = customers[index];

      if (!customer.currentWallet) {
        const cached = await env.DB.prepare(
          `SELECT wallet_name
             FROM rd_contact_cache
            WHERE rd_contact_id = ? OR phone = ?
            ORDER BY CASE WHEN rd_contact_id = ? THEN 0 ELSE 1 END
            LIMIT 1`,
        )
          .bind(customer.id, customer.phone, customer.id)
          .first<CachedWalletRow>();

        if (cached?.wallet_name) {
          customer = { ...customer, currentWallet: cached.wallet_name };
        } else {
          if (detailRequests >= DETAIL_REQUESTS_PER_RUN) {
            nextIndex = index;
            stoppedInsidePage = true;
            break;
          }

          const e164Phone = normalizePhoneForRd(customer.phone);
          if (!e164Phone) {
            invalidDetails += 1;
          } else {
            if (detailRequests > 0) await sleep(DETAIL_DELAY_MS);
            detailRequests += 1;

            try {
              const detail = await rdGetOptional(
                token,
                `/v2/contacts/${encodeURIComponent(e164Phone)}/exists?channel=whatsapp`,
              );
              if (detail) customer = mergeContactDetail(customer, detail);
            } catch (error) {
              if (error instanceof RdRateLimitError) {
                rateLimited = true;
                nextIndex = index;
                stoppedInsidePage = true;
                break;
              }
              if (error instanceof RdBadRequestError) {
                invalidDetails += 1;
              } else {
                throw error;
              }
            }
          }
        }
      }

      await upsertCachedContact(env, customer);
      contactsSaved += 1;
      if (customer.currentWallet) walletsResolved += 1;
      nextIndex = index + 1;
    }

    if (stoppedInsidePage) break;

    if (nextIndex >= customers.length) {
      const isLastPage = rawCustomers.length < SOURCE_PAGE_SIZE;
      if (isLastPage) {
        reachedEnd = 1;
        nextIndex = 0;
      } else {
        nextPage += 1;
        nextIndex = 0;
      }
    }
  }

  await saveSyncState(env, anchor.id, nextPage, nextIndex, reachedEnd);

  console.log('Background wallet sync run finished.', {
    anchorSellerId: anchor.id,
    anchorSellerName: anchor.name,
    pagesScanned,
    detailRequests,
    contactsSaved,
    walletsResolved,
    invalidDetails,
    rateLimited,
    nextPage,
    nextIndex,
    reachedEnd: reachedEnd === 1,
  });
}

async function selectSyncAnchor(env: Env): Promise<SyncAnchor | null> {
  const existing = await env.DB.prepare(
    `SELECT s.id,
            s.name,
            s.wallet_name,
            st.next_page,
            st.next_index,
            st.reached_end
       FROM rd_contact_sync_state st
       JOIN sellers s ON s.id = st.seller_id
      WHERE s.active = 1
        AND s.wallet_name IS NOT NULL
        AND TRIM(s.wallet_name) <> ''
      ORDER BY st.reached_end DESC,
               st.next_page DESC,
               st.next_index DESC,
               s.id ASC
      LIMIT 1`,
  ).first<SyncAnchor>();

  if (existing) return existing;

  const seller = await env.DB.prepare(
    `SELECT id, name, wallet_name
       FROM sellers
      WHERE active = 1
        AND wallet_name IS NOT NULL
        AND TRIM(wallet_name) <> ''
      ORDER BY id ASC
      LIMIT 1`,
  ).first<{ id: number; name: string; wallet_name: string }>();

  if (!seller) return null;

  return {
    ...seller,
    next_page: 1,
    next_index: 0,
    reached_end: 0,
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

async function saveSyncState(
  env: Env,
  sellerId: number,
  nextPage: number,
  nextIndex: number,
  reachedEnd: number,
): Promise<void> {
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
    .bind(sellerId, nextPage, nextIndex, reachedEnd)
    .run();
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

async function rdGet(token: string, path: string): Promise<unknown> {
  const result = await rdFetch(token, path, false);
  if (result === null) throw new Error('RD returned an empty resource.');
  return result;
}

async function rdGetOptional(token: string, path: string): Promise<unknown | null> {
  return rdFetch(token, path, true);
}

async function rdFetch(token: string, path: string, allowNotFound: boolean): Promise<unknown | null> {
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
    if (response.status === 400) throw new RdBadRequestError();
    if (response.status === 429) throw new RdRateLimitError();
    if (!response.ok) {
      const body = await safeResponseText(response);
      throw new Error(`RD contacts HTTP ${response.status}: ${body.slice(0, 300)}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizePhoneForRd(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return null;
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
    const found = findContactRecord(payload[key], depth + 1);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function safeResponseText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RdRateLimitError extends Error {}
class RdBadRequestError extends Error {}
