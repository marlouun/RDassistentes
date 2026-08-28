import { compactDecrypt, importJWK, type JWK } from 'jose';

interface Env {
  DB: D1Database;
  RD_CONVERSAS_TOKEN?: string;
  RD_CONVERSAS_PRIVATE_JWK?: string;
}

type Role = 'admin' | 'assistant';

type SessionUser = {
  id: number;
  name: string;
  email: string;
  role: Role;
};

type SellerRow = {
  id: number;
  name: string;
  rd_employee_id: string | null;
  wallet_name: string | null;
};

type OpenContact = {
  rd_contact_id: string;
  name: string;
  phone: string;
  email: string | null;
  lastMessage: unknown;
};

type ConversationMessage = {
  id: string;
  content: string;
  sentBy: 'customer' | 'operator' | 'bot' | 'unknown';
  type: string;
  createdAt: string | null;
  operatorName: string | null;
};

const SESSION_COOKIE = 'rdassist_session';
const RD_API_BASE = 'https://api.tallos.com.br';
const RD_TIMEOUT_MS = 15_000;
const HISTORY_PAGE_SIZE = 100;
const REPORT_PAGE_SIZE = 40;
const MAX_REPORT_PAGES = 3;
const REPORT_WINDOW_DAYS = 89;

export async function handleOpenAttendances(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const contactsRoute = url.pathname.match(/^\/api\/sellers\/(\d+)\/conversation-contacts$/);
  const messagesRoute = url.pathname.match(/^\/api\/sellers\/(\d+)\/contacts\/([^/]+)\/messages$/);

  if (!contactsRoute && !messagesRoute) return null;

  try {
    ensureDatabase(env);
    const user = await requireUser(env, request);
    const sellerId = Number((contactsRoute ?? messagesRoute)?.[1]);
    const seller = await requireSellerAccess(env, user, sellerId);

    if (!seller.rd_employee_id) {
      throw new HttpError(409, 'seller_not_synced', 'Este vendedor ainda nao possui ID de funcionario da RD.');
    }

    if (contactsRoute) {
      if (request.method !== 'GET') return json({ error: 'method_not_allowed', message: 'Metodo nao permitido.' }, 405);
      const search = (url.searchParams.get('search') ?? '').trim().slice(0, 120);
      return json(await listOpenAttendanceContacts(env, seller, search));
    }

    const contactId = decodeURIComponent(messagesRoute?.[2] ?? '');
    const contact = await requireOpenContactAccess(env, seller, contactId);

    if (request.method === 'GET') {
      const page = positiveInt(url.searchParams.get('page'), 1);
      return json(await loadHistory(env, contact, page));
    }

    if (request.method === 'POST') {
      enforceSameOrigin(request);
      return json(await sendMessage(env, seller, contact, request));
    }

    return json({ error: 'method_not_allowed', message: 'Metodo nao permitido.' }, 405);
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    console.error('Open attendances route failed', error);
    return json({ error: 'internal_error', message: 'Erro interno ao processar os atendimentos abertos.' }, 500);
  }
}

async function listOpenAttendanceContacts(env: Env, seller: SellerRow, search: string) {
  const { contacts, startDate, endDate, reportCount } = await fetchOpenAttendanceContacts(env, seller);
  const term = search.toLocaleLowerCase('pt-BR');
  const digits = search.replace(/\D/g, '');

  const filtered = search
    ? contacts.filter((contact) => {
        const haystack = `${contact.name} ${contact.phone} ${contact.email ?? ''}`.toLocaleLowerCase('pt-BR');
        if (haystack.includes(term)) return true;
        return Boolean(digits) && contact.phone.replace(/\D/g, '').includes(digits);
      })
    : contacts;

  return {
    seller: {
      id: seller.id,
      name: seller.name,
      walletName: seller.wallet_name ?? '',
      rdEmployeeId: seller.rd_employee_id,
    },
    contacts: filtered.map((contact) => ({
      id: contact.rd_contact_id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      lastMessage: contact.lastMessage,
    })),
    source: 'rd_open_attendances',
    status: 'opened',
    reportType: 'customers',
    reportCount,
    window: { startDate, endDate },
    note: 'Consultado diretamente na RD. Nenhum contato desta listagem e gravado no D1.',
  };
}

async function requireOpenContactAccess(env: Env, seller: SellerRow, contactId: string): Promise<OpenContact> {
  if (!contactId) throw new HttpError(400, 'invalid_contact', 'Contato invalido.');

  const { contacts } = await fetchOpenAttendanceContacts(env, seller);
  const contact = contacts.find((item) => item.rd_contact_id === contactId);
  if (!contact) {
    throw new HttpError(
      404,
      'contact_not_open_for_seller',
      'Este contato nao esta mais entre os atendimentos abertos deste vendedor.',
    );
  }
  return contact;
}

async function fetchOpenAttendanceContacts(
  env: Env,
  seller: SellerRow,
): Promise<{ contacts: OpenContact[]; startDate: string; endDate: string; reportCount: number }> {
  const token = ensureRdToken(env);
  if (!seller.rd_employee_id) throw new HttpError(409, 'seller_not_synced', 'Vendedor sem ID da RD.');

  const end = new Date();
  const start = new Date(end.getTime() - REPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const startDate = formatDateOnly(start);
  const endDate = formatDateOnly(end);
  const contactsById = new Map<string, OpenContact>();
  let reportCount = 0;

  for (let page = 1; page <= MAX_REPORT_PAGES; page += 1) {
    const params = new URLSearchParams({
      start_date: startDate,
      end_date: endDate,
      page: String(page),
      limit: String(REPORT_PAGE_SIZE),
      channel: 'whatsapp',
      employee: seller.rd_employee_id,
      status: 'opened',
      type: 'customers',
    });

    const response = await rdFetch(`${RD_API_BASE}/v4/reports?${params.toString()}`, token, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const payload = await readJsonResponse(response);
    const reports = extractArray(payload, ['reports', 'data', 'items', 'results']);
    reportCount += reports.length;

    for (let index = 0; index < reports.length; index += 1) {
      const contact = normalizeReportContact(reports[index], index);
      if (contact) contactsById.set(contact.rd_contact_id, mergeOpenContact(contactsById.get(contact.rd_contact_id), contact));
    }

    if (reports.length > 0 && contactsById.size === 0 && page === 1) {
      console.warn('RD open attendance response could not be mapped to contacts', {
        topLevelKeys: isRecord(payload) ? Object.keys(payload).slice(0, 30) : [],
        firstReportShape: describeShape(reports[0]),
      });
    }

    if (reports.length < REPORT_PAGE_SIZE) break;
  }

  return {
    contacts: [...contactsById.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })),
    startDate,
    endDate,
    reportCount,
  };
}

function normalizeReportContact(value: unknown, index: number): OpenContact | null {
  if (!isRecord(value)) return null;

  const nested = findCustomerRecord(value);
  const rootId = firstString(value, ['customer_id', 'customerId', 'contact_id', 'contactId']);
  const nestedId = nested
    ? firstString(nested, ['_id', 'id', 'customer_id', 'customerId', 'contact_id', 'contactId'])
    : null;
  const entityId = firstPrimitiveString(value, ['customer', 'contact']);
  const id = nestedId ?? rootId ?? entityId;
  if (!id) return null;

  const source = nested ?? value;
  const phone = firstString(source, ['cel_phone', 'phone', 'cellphone', 'whatsapp', 'customer_phone', 'customerPhone'])
    ?? firstString(value, ['cel_phone', 'phone', 'customer_phone', 'customerPhone'])
    ?? '';
  const name = firstString(source, ['full_name', 'name', 'whatsapp_name', 'customer_name', 'customerName'])
    ?? firstString(value, ['customer_name', 'customerName', 'full_name'])
    ?? (phone || `Cliente ${index + 1}`);
  const email = firstString(source, ['email', 'customer_email', 'customerEmail'])
    ?? firstString(value, ['customer_email', 'customerEmail', 'email']);

  const lastMessage = firstDefined(
    source,
    ['last_message_data', 'lastMessage', 'last_message', 'message'],
  ) ?? firstDefined(value, ['last_message_data', 'lastMessage', 'last_message', 'message']);

  return {
    rd_contact_id: id,
    name,
    phone,
    email,
    lastMessage: lastMessage ?? null,
  };
}

function findCustomerRecord(value: Record<string, unknown>, depth = 0): Record<string, unknown> | null {
  if (depth > 5) return null;

  for (const key of ['customer', 'contact', 'client', 'cliente']) {
    const candidate = value[key];
    if (isRecord(candidate)) return candidate;
  }

  const hasCustomerFields = [
    'customer_id', 'customerId', 'contact_id', 'contactId', 'cel_phone', 'customer_phone', 'customerName', 'customer_name',
  ].some((key) => key in value);
  if (hasCustomerFields) return value;

  for (const key of ['data', 'attendance', 'attendant', 'conversation', 'chat', 'details', 'result', 'item']) {
    const candidate = value[key];
    if (!isRecord(candidate)) continue;
    const found = findCustomerRecord(candidate, depth + 1);
    if (found) return found;
  }

  return null;
}

function mergeOpenContact(previous: OpenContact | undefined, current: OpenContact): OpenContact {
  if (!previous) return current;
  return {
    rd_contact_id: current.rd_contact_id,
    name: current.name || previous.name,
    phone: current.phone || previous.phone,
    email: current.email ?? previous.email,
    lastMessage: current.lastMessage ?? previous.lastMessage,
  };
}

async function loadHistory(env: Env, contact: OpenContact, page: number) {
  const token = ensureRdToken(env);
  const params = new URLSearchParams({
    customer_id: contact.rd_contact_id,
    page: String(page),
    limit: String(HISTORY_PAGE_SIZE),
    channel: 'whatsapp',
  });
  params.append('sent_by', 'customer');
  params.append('sent_by', 'operator');
  params.append('sent_by', 'bot');

  const response = await rdFetch(`${RD_API_BASE}/v2/messages/history?${params.toString()}`, token, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });

  const raw = await response.text();
  const payload = await decodeRdHistory(env, raw);
  const messages = normalizeHistory(payload);

  return {
    contact: {
      id: contact.rd_contact_id,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
    },
    messages,
    page,
    hasMore: messages.length >= HISTORY_PAGE_SIZE,
    encrypted: true,
  };
}

async function sendMessage(env: Env, seller: SellerRow, contact: OpenContact, request: Request) {
  const token = ensureRdToken(env);
  const body = await readJson(request);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, 'message_required', 'Digite uma mensagem antes de enviar.');
  if (message.length > 4000) throw new HttpError(400, 'message_too_long', 'A mensagem excede o limite de 4000 caracteres do painel.');
  if (!seller.rd_employee_id) throw new HttpError(409, 'seller_not_synced', 'O vendedor ainda nao possui ID de funcionario da RD.');

  const form = new FormData();
  form.set('message', message);
  form.set('sent_by', 'operator');
  form.set('operator', seller.rd_employee_id);

  const response = await rdFetch(
    `${RD_API_BASE}/v2/messages/${encodeURIComponent(contact.rd_contact_id)}/send`,
    token,
    { method: 'POST', body: form },
  );

  const text = await response.text();
  let result: unknown = null;
  if (text) {
    try { result = JSON.parse(text) as unknown; } catch { result = { raw: text.slice(0, 500) }; }
  }

  return { ok: true, contactId: contact.rd_contact_id, result };
}

async function decodeRdHistory(env: Env, raw: string): Promise<unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed) as unknown; } catch { parsed = trimmed; }

  const compactJwe = findCompactJwe(parsed);
  if (!compactJwe) return parsed;

  const rawJwk = env.RD_CONVERSAS_PRIVATE_JWK?.trim();
  if (!rawJwk) {
    throw new HttpError(
      503,
      'rd_encryption_not_configured',
      'O historico da RD exige criptografia. Cadastre RD_CONVERSAS_PRIVATE_JWK como Secret no Worker.',
    );
  }

  let jwk: JWK;
  try { jwk = JSON.parse(rawJwk) as JWK; } catch {
    throw new HttpError(503, 'rd_encryption_invalid', 'RD_CONVERSAS_PRIVATE_JWK nao contem um JWK JSON valido.');
  }

  try {
    const key = await importJWK(jwk, 'RSA-OAEP-256');
    const decrypted = await compactDecrypt(compactJwe, key);
    const plaintext = new TextDecoder().decode(decrypted.plaintext);
    return JSON.parse(plaintext) as unknown;
  } catch (error) {
    console.error('RD history decrypt failed', error);
    throw new HttpError(502, 'rd_history_decrypt_failed', 'Nao foi possivel descriptografar o historico retornado pela RD.');
  }
}

function normalizeHistory(payload: unknown): ConversationMessage[] {
  const items = extractArray(payload, ['messages', 'data', 'items', 'results', 'history']);
  return items
    .map((item, index) => normalizeMessage(item, index))
    .filter((item): item is ConversationMessage => item !== null)
    .sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt));
}

function normalizeMessage(value: unknown, index: number): ConversationMessage | null {
  if (!isRecord(value)) return null;
  const content = firstString(value, ['message', 'content', 'text', 'body', 'caption']) ?? '';
  const rawSentBy = (firstString(value, ['sent_by', 'sentBy', 'sender_type', 'senderType']) ?? 'unknown').toLowerCase();
  const sentBy: ConversationMessage['sentBy'] = rawSentBy === 'customer' || rawSentBy === 'operator' || rawSentBy === 'bot'
    ? rawSentBy
    : 'unknown';

  return {
    id: firstString(value, ['_id', 'id', 'message_id', 'messageId']) ?? `msg-${index}`,
    content,
    sentBy,
    type: firstString(value, ['type', 'message_type', 'messageType']) ?? 'text',
    createdAt: firstString(value, ['created_at', 'createdAt', 'date', 'timestamp']),
    operatorName: firstString(value, ['operator_name', 'operatorName', 'employee_name', 'employeeName']),
  };
}

function findCompactJwe(value: unknown, depth = 0): string | null {
  if (depth > 5) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    return text.split('.').length === 5 ? text : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCompactJwe(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (isRecord(value)) {
    for (const key of ['messages', 'data', 'payload', 'encrypted', 'message', 'result']) {
      const found = findCompactJwe(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function rdFetch(url: string, token: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RD_TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    const response = await fetch(url, { ...init, headers, signal: controller.signal });
    if (response.ok) return response;

    const detail = (await response.text()).slice(0, 800);
    console.error('RD open attendances upstream error', { path: new URL(url).pathname, status: response.status, detail });
    if (response.status === 400) throw new HttpError(502, 'rd_bad_request', 'A RD rejeitou os filtros da consulta de atendimentos.');
    if (response.status === 401) throw new HttpError(502, 'rd_unauthorized', 'A RD rejeitou o token configurado.');
    if (response.status === 403) throw new HttpError(502, 'rd_forbidden', 'O token da RD nao possui permissao para este recurso.');
    if (response.status === 404) throw new HttpError(404, 'rd_not_found', 'A RD nao encontrou o contato ou atendimento.');
    if (response.status === 429) throw new HttpError(429, 'rd_rate_limited', 'A RD limitou temporariamente as requisicoes. Aguarde e tente novamente.');
    throw new HttpError(502, 'rd_upstream_error', `A RD retornou HTTP ${response.status}.`);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') throw new HttpError(504, 'rd_timeout', 'A RD demorou demais para responder.');
    throw new HttpError(502, 'rd_unavailable', 'Nao foi possivel comunicar com o RD Station Conversas.');
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new HttpError(502, 'rd_invalid_response', 'A RD retornou uma resposta invalida para os atendimentos.');
  }
}

async function requireUser(env: Env, request: Request): Promise<SessionUser> {
  const rawToken = getCookie(request, SESSION_COOKIE);
  if (!rawToken) throw new HttpError(401, 'unauthorized', 'Sessao nao encontrada.');
  const tokenHash = await sha256(rawToken);
  const user = await env.DB.prepare(
    `SELECT u.id, u.name, u.email, u.role
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.active = 1
      LIMIT 1`,
  ).bind(tokenHash).first<SessionUser>();
  if (!user) throw new HttpError(401, 'unauthorized', 'Sessao expirada ou invalida.');
  return user;
}

async function requireSellerAccess(env: Env, user: SessionUser, sellerId: number): Promise<SellerRow> {
  if (!Number.isInteger(sellerId) || sellerId <= 0) throw new HttpError(400, 'invalid_seller', 'Vendedor invalido.');
  const sql = user.role === 'admin'
    ? `SELECT id, name, rd_employee_id, wallet_name FROM sellers WHERE id = ? AND active = 1 LIMIT 1`
    : `SELECT s.id, s.name, s.rd_employee_id, s.wallet_name
         FROM user_sellers us JOIN sellers s ON s.id = us.seller_id
        WHERE us.user_id = ? AND us.seller_id = ? AND us.can_select = 1 AND s.active = 1 LIMIT 1`;
  const seller = user.role === 'admin'
    ? await env.DB.prepare(sql).bind(sellerId).first<SellerRow>()
    : await env.DB.prepare(sql).bind(user.id, sellerId).first<SellerRow>();
  if (!seller) throw new HttpError(403, 'seller_forbidden', 'Voce nao possui acesso a este vendedor.');
  return seller;
}

function ensureDatabase(env: Env): asserts env is Env & { DB: D1Database } {
  if (!env.DB) throw new HttpError(503, 'database_not_configured', 'Banco D1 ainda nao esta conectado ao Worker.');
}

function ensureRdToken(env: Env): string {
  const token = env.RD_CONVERSAS_TOKEN?.trim();
  if (!token) throw new HttpError(503, 'rd_conversas_not_configured', 'Token do RD Station Conversas nao configurado no Worker.');
  return token;
}

function extractArray(payload: unknown, keys: string[], depth = 0): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload) || depth > 4) return [];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    const nested = extractArray(value, keys, depth + 1);
    if (nested.length > 0) return nested;
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

function firstPrimitiveString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) return text;
    }
  }
  return null;
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return null;
}

function describeShape(value: unknown, depth = 0): unknown {
  if (depth > 2) return typeof value;
  if (Array.isArray(value)) return { type: 'array', length: value.length, first: value.length ? describeShape(value[0], depth + 1) : null };
  if (!isRecord(value)) return typeof value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).slice(0, 30)) {
    const child = value[key];
    output[key] = isRecord(child) || Array.isArray(child) ? describeShape(child, depth + 1) : typeof child;
  }
  return output;
}

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function timeValue(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  if (origin !== new URL(request.url).origin) throw new HttpError(403, 'invalid_origin', 'Origem da requisicao nao permitida.');
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return isRecord(value) ? value : {};
  } catch {
    throw new HttpError(400, 'invalid_json', 'Corpo da requisicao invalido.');
  }
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
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
