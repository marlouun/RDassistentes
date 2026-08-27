interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  BOOTSTRAP_SECRET?: string;
  RD_CONVERSAS_TOKEN?: string;
  RD_CRM_TOKEN?: string;
}

type Role = 'admin' | 'assistant';

type UserRow = {
  id: number;
  name: string;
  email: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
  role: Role;
  active: number;
  failed_login_attempts: number;
  locked_until: string | null;
};

type SessionUser = Pick<UserRow, 'id' | 'name' | 'email' | 'role'>;

type SellerRow = {
  id: number;
  name: string;
  rd_employee_id: string | null;
  wallet_name: string | null;
  is_default: number;
};

type RdEmployee = {
  id: string;
  name: string;
  active: boolean;
};

type RdOverview = {
  configured: true;
  connected: true;
  employees: RdEmployee[];
  wallets: string[];
};

const SESSION_COOKIE = 'rdassist_session';
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;
const MAX_LOGIN_ATTEMPTS = 5;
const PASSWORD_MIN_LENGTH = 12;
const PASSWORD_ITERATIONS = 100_000;
const RD_API_BASE = 'https://api.tallos.com.br';
const RD_TIMEOUT_MS = 12_000;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith('/api/')) {
      return serveAsset(request, env);
    }

    try {
      if (url.pathname === '/api/health' && request.method === 'GET') {
        return json({ ok: true, service: 'rd-assistentes', runtime: 'cloudflare-worker' });
      }

      if (url.pathname === '/api/bootstrap' && request.method === 'POST') {
        enforceSameOrigin(request);
        return bootstrap(env, request);
      }

      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        enforceSameOrigin(request);
        return login(env, request);
      }

      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        enforceSameOrigin(request);
        return logout(env, request);
      }

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const user = await requireUser(env, request);
        return json(await userPayload(env, user));
      }

      if (url.pathname === '/api/sellers' && request.method === 'GET') {
        const user = await requireUser(env, request);
        return json({ sellers: await sellersForUser(env, user) });
      }

      if (url.pathname === '/api/admin/rd/overview' && request.method === 'GET') {
        await requireAdmin(env, request);
        return json(await rdOverview(env));
      }

      if (url.pathname === '/api/admin/rd/sync-employees' && request.method === 'POST') {
        enforceSameOrigin(request);
        const user = await requireAdmin(env, request);
        return syncRdEmployees(env, user);
      }

      const walletRoute = url.pathname.match(/^\/api\/admin\/sellers\/(\d+)\/wallet$/);
      if (walletRoute && request.method === 'PUT') {
        enforceSameOrigin(request);
        const user = await requireAdmin(env, request);
        return updateSellerWallet(env, user, Number(walletRoute[1]), request);
      }

      return json({ error: 'not_found', message: 'Rota nao encontrada.' }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return json({ error: error.code, message: error.message }, error.status);
      }

      console.error('Unhandled API error', error);
      return json({ error: 'internal_error', message: 'Erro interno. Tente novamente.' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function serveAsset(request: Request, env: Env): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  if (new URL(request.url).pathname.endsWith('.html') || response.headers.get('content-type')?.includes('text/html')) {
    headers.set(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function bootstrap(env: Env, request: Request): Promise<Response> {
  ensureDatabase(env);
  if (!env.BOOTSTRAP_SECRET) {
    throw new HttpError(503, 'bootstrap_disabled', 'Bootstrap nao configurado no ambiente.');
  }

  const body = await readJson<{ name?: string; email?: string; password?: string; bootstrapSecret?: string }>(request);
  if (!body.bootstrapSecret || !constantTimeEqual(body.bootstrapSecret, env.BOOTSTRAP_SECRET)) {
    throw new HttpError(403, 'forbidden', 'Segredo de bootstrap invalido.');
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM users').first<{ total: number }>();
  if ((count?.total ?? 0) > 0) {
    throw new HttpError(409, 'already_initialized', 'O sistema ja possui usuarios.');
  }

  const name = cleanName(body.name);
  const email = normalizeEmail(body.email);
  const password = validatePassword(body.password);
  const passwordData = await hashPassword(password);

  const result = await env.DB.prepare(
    `INSERT INTO users (name, email, password_hash, password_salt, password_iterations, role)
     VALUES (?, ?, ?, ?, ?, 'admin')`,
  )
    .bind(name, email, passwordData.hash, passwordData.salt, passwordData.iterations)
    .run();

  await audit(env, Number(result.meta.last_row_id), null, 'bootstrap_admin_created', 'user', String(result.meta.last_row_id));

  return json({ ok: true, message: 'Administrador inicial criado. O endpoint de bootstrap agora fica bloqueado.' }, 201);
}

async function login(env: Env, request: Request): Promise<Response> {
  ensureDatabase(env);
  const body = await readJson<{ email?: string; password?: string }>(request);
  const email = normalizeEmail(body.email);
  const password = body.password ?? '';

  const user = await env.DB.prepare(
    `SELECT id, name, email, password_hash, password_salt, password_iterations, role, active,
            failed_login_attempts, locked_until
       FROM users
      WHERE email = ? COLLATE NOCASE
      LIMIT 1`,
  )
    .bind(email)
    .first<UserRow>();

  if (!user || user.active !== 1) {
    await delayForFailedLogin();
    throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha invalidos.');
  }

  if (user.locked_until) {
    const locked = await env.DB.prepare('SELECT ? > CURRENT_TIMESTAMP AS locked').bind(user.locked_until).first<{ locked: number }>();
    if (locked?.locked === 1) {
      throw new HttpError(429, 'temporarily_locked', 'Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    }
  }

  const valid = await verifyPassword(password, user.password_salt, user.password_hash, user.password_iterations);
  if (!valid) {
    const attempts = user.failed_login_attempts + 1;
    if (attempts >= MAX_LOGIN_ATTEMPTS) {
      await env.DB.prepare(
        `UPDATE users
            SET failed_login_attempts = ?, locked_until = datetime('now', '+15 minutes'), updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).bind(attempts, user.id).run();
    } else {
      await env.DB.prepare(
        `UPDATE users
            SET failed_login_attempts = ?, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).bind(attempts, user.id).run();
    }
    await audit(env, user.id, null, 'login_failed', 'user', String(user.id));
    await delayForFailedLogin();
    throw new HttpError(401, 'invalid_credentials', 'E-mail ou senha invalidos.');
  }

  await env.DB.prepare(
    `UPDATE users
        SET failed_login_attempts = 0, locked_until = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
  ).bind(user.id).run();

  await env.DB.prepare('DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP').run();

  const rawToken = randomToken();
  const tokenHash = await sha256(rawToken);
  await env.DB.prepare(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES (?, ?, datetime('now', '+8 hours'))`,
  ).bind(user.id, tokenHash).run();

  await audit(env, user.id, null, 'login_success', 'user', String(user.id));

  const payload = await userPayload(env, user);
  return json(payload, 200, {
    'Set-Cookie': sessionCookie(rawToken, SESSION_MAX_AGE_SECONDS),
  });
}

async function logout(env: Env, request: Request): Promise<Response> {
  ensureDatabase(env);
  const rawToken = getCookie(request, SESSION_COOKIE);
  if (rawToken) {
    const tokenHash = await sha256(rawToken);
    const session = await env.DB.prepare('SELECT user_id FROM sessions WHERE token_hash = ? LIMIT 1')
      .bind(tokenHash)
      .first<{ user_id: number }>();
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    if (session?.user_id) await audit(env, session.user_id, null, 'logout', 'user', String(session.user_id));
  }

  return new Response(null, {
    status: 204,
    headers: baseHeaders({ 'Set-Cookie': sessionCookie('', 0) }),
  });
}

async function requireUser(env: Env, request: Request): Promise<SessionUser> {
  ensureDatabase(env);
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

async function requireAdmin(env: Env, request: Request): Promise<SessionUser> {
  const user = await requireUser(env, request);
  if (user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'Apenas administradores podem acessar esta funcionalidade.');
  }
  return user;
}

async function userPayload(env: Env, user: SessionUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    sellers: await sellersForUser(env, user),
  };
}

async function sellersForUser(env: Env, user: SessionUser) {
  ensureDatabase(env);
  let result: D1Result<SellerRow>;

  if (user.role === 'admin') {
    result = await env.DB.prepare(
      `SELECT s.id, s.name, s.rd_employee_id, s.wallet_name, COALESCE(us.is_default, 0) AS is_default
         FROM sellers s
         LEFT JOIN user_sellers us ON us.seller_id = s.id AND us.user_id = ?
        WHERE s.active = 1
        ORDER BY us.is_default DESC, s.name ASC`,
    ).bind(user.id).all<SellerRow>();
  } else {
    result = await env.DB.prepare(
      `SELECT s.id, s.name, s.rd_employee_id, s.wallet_name, us.is_default
         FROM user_sellers us
         JOIN sellers s ON s.id = us.seller_id
        WHERE us.user_id = ? AND us.can_select = 1 AND s.active = 1
        ORDER BY us.is_default DESC, s.name ASC`,
    ).bind(user.id).all<SellerRow>();
  }

  return result.results.map((seller) => ({
    id: seller.id,
    name: seller.name,
    rdEmployeeId: seller.rd_employee_id,
    walletName: seller.wallet_name,
    isDefault: seller.is_default === 1,
  }));
}

async function rdOverview(env: Env): Promise<RdOverview> {
  ensureRdToken(env);
  const [employeesPayload, walletsPayload] = await Promise.all([
    rdRequest(env, '/v2/employees'),
    rdRequest(env, '/v2/wallets'),
  ]);

  return {
    configured: true,
    connected: true,
    employees: normalizeEmployees(employeesPayload),
    wallets: normalizeWallets(walletsPayload),
  };
}

async function syncRdEmployees(env: Env, user: SessionUser): Promise<Response> {
  ensureDatabase(env);
  ensureRdToken(env);
  const employees = normalizeEmployees(await rdRequest(env, '/v2/employees'));
  if (employees.length === 0) {
    throw new HttpError(502, 'rd_empty_employees', 'A RD respondeu, mas nenhum funcionario reconhecivel foi encontrado.');
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const employee of employees) {
    if (!employee.id || !employee.name) {
      skipped += 1;
      continue;
    }

    const existing = await env.DB.prepare('SELECT id FROM sellers WHERE rd_employee_id = ? LIMIT 1')
      .bind(employee.id)
      .first<{ id: number }>();

    if (existing) {
      await env.DB.prepare(
        `UPDATE sellers
            SET name = ?, active = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
      ).bind(employee.name, employee.active ? 1 : 0, existing.id).run();
      updated += 1;
    } else {
      await env.DB.prepare(
        `INSERT INTO sellers (name, rd_employee_id, active)
         VALUES (?, ?, ?)`,
      ).bind(employee.name, employee.id, employee.active ? 1 : 0).run();
      created += 1;
    }
  }

  await audit(env, user.id, null, 'rd_employees_synced', 'rd_employee', null);
  return json({ ok: true, total: employees.length, created, updated, skipped });
}

async function updateSellerWallet(env: Env, user: SessionUser, sellerId: number, request: Request): Promise<Response> {
  ensureDatabase(env);
  if (!Number.isInteger(sellerId) || sellerId <= 0) {
    throw new HttpError(400, 'invalid_seller', 'Vendedor invalido.');
  }

  const body = await readJson<{ walletName?: string | null }>(request);
  const walletName = body.walletName?.trim() || null;
  if (walletName && walletName.length > 160) {
    throw new HttpError(400, 'invalid_wallet', 'Nome da carteira muito longo.');
  }

  const seller = await env.DB.prepare('SELECT id FROM sellers WHERE id = ? LIMIT 1')
    .bind(sellerId)
    .first<{ id: number }>();
  if (!seller) throw new HttpError(404, 'seller_not_found', 'Vendedor nao encontrado.');

  await env.DB.prepare(
    `UPDATE sellers SET wallet_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(walletName, sellerId).run();
  await audit(env, user.id, sellerId, 'seller_wallet_updated', 'seller', String(sellerId));

  return json({ ok: true, sellerId, walletName });
}

async function rdRequest(env: Env, path: string): Promise<unknown> {
  const token = ensureRdToken(env);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RD_TIMEOUT_MS);

  try {
    const response = await fetch(`${RD_API_BASE}${path}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 401) {
        throw new HttpError(502, 'rd_unauthorized', 'A RD rejeitou o token configurado (401).');
      }
      if (response.status === 403) {
        throw new HttpError(502, 'rd_forbidden', 'O token da RD nao possui permissao para este recurso (403).');
      }
      console.error('RD Conversas upstream error', { path, status: response.status });
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
      throw new HttpError(504, 'rd_timeout', 'A RD demorou demais para responder.');
    }
    console.error('RD Conversas request failed', error);
    throw new HttpError(502, 'rd_unavailable', 'Nao foi possivel conectar ao RD Station Conversas.');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeEmployees(payload: unknown): RdEmployee[] {
  const items = extractCollection(payload, ['employees', 'data', 'items', 'results']);
  const byId = new Map<string, RdEmployee>();

  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = firstString(item, ['id', '_id', 'employee_id', 'employeeId', 'uuid']);
    const name = firstString(item, ['name', 'full_name', 'fullName', 'fullname', 'display_name', 'displayName', 'email']);
    if (!id || !name) continue;

    const activeValue = item.active ?? item.enabled ?? item.is_active ?? item.status;
    byId.set(id, { id, name, active: normalizeActive(activeValue) });
  }

  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
}

function normalizeWallets(payload: unknown): string[] {
  const items = extractCollection(payload, ['wallets', 'data', 'items', 'results']);
  const names = new Set<string>();

  for (const item of items) {
    if (typeof item === 'string') {
      const value = item.trim();
      if (value) names.add(value);
      continue;
    }
    if (!isRecord(item)) continue;
    const name = firstString(item, ['name', 'wallet_name', 'walletName', 'title', 'wallet']);
    if (name) names.add(name);
  }

  return [...names].sort((left, right) => left.localeCompare(right, 'pt-BR'));
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

function normalizeActive(value: unknown): boolean {
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    return !['inactive', 'disabled', 'false', '0', 'inativo', 'desativado'].includes(value.trim().toLowerCase());
  }
  return true;
}

function ensureDatabase(env: Env): asserts env is Env & { DB: D1Database } {
  if (!env.DB) {
    throw new HttpError(503, 'database_not_configured', 'Banco D1 ainda nao esta conectado ao Worker.');
  }
}

function ensureRdToken(env: Env): string {
  const token = env.RD_CONVERSAS_TOKEN?.trim();
  if (!token) {
    throw new HttpError(503, 'rd_conversas_not_configured', 'Token do RD Station Conversas nao configurado no Worker.');
  }
  return token;
}

async function audit(
  env: Env,
  userId: number | null,
  sellerId: number | null,
  action: string,
  targetType: string | null,
  targetId: string | null,
): Promise<void> {
  if (!env.DB) return;
  await env.DB.prepare(
    `INSERT INTO audit_logs (user_id, seller_id, action, target_type, target_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(userId, sellerId, action, targetType, targetId).run();
}

async function hashPassword(password: string) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToHex(saltBytes);
  const hash = await derivePasswordHash(password, saltBytes, PASSWORD_ITERATIONS);
  return { hash: bytesToHex(hash), salt, iterations: PASSWORD_ITERATIONS };
}

async function verifyPassword(password: string, saltHex: string, expectedHashHex: string, iterations: number) {
  const salt = hexToBytes(saltHex);
  const actualHash = await derivePasswordHash(password, salt, iterations);
  return constantTimeEqual(bytesToHex(actualHash), expectedHashHex);
}

async function derivePasswordHash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const passwordBytes = new TextEncoder().encode(password);
  const passwordBuffer = copyToArrayBuffer(passwordBytes);
  const saltBuffer = copyToArrayBuffer(salt);

  const key = await crypto.subtle.importKey('raw', passwordBuffer, { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations },
    key,
    256,
  );

  return new Uint8Array(bits);
}

async function sha256(value: string): Promise<string> {
  const data = copyToArrayBuffer(new TextEncoder().encode(value));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(digest));
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function sessionCookie(token: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
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

async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get('Content-Type')?.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'invalid_content_type', 'Envie os dados como application/json.');
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'JSON invalido.');
  }
}

function normalizeEmail(value?: string): string {
  const email = (value ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new HttpError(400, 'invalid_email', 'Informe um e-mail valido.');
  }
  return email;
}

function cleanName(value?: string): string {
  const name = (value ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 120) {
    throw new HttpError(400, 'invalid_name', 'Informe um nome valido.');
  }
  return name;
}

function validatePassword(value?: string): string {
  const password = value ?? '';
  if (password.length < PASSWORD_MIN_LENGTH || password.length > 200) {
    throw new HttpError(400, 'weak_password', `A senha deve ter pelo menos ${PASSWORD_MIN_LENGTH} caracteres.`);
  }
  return password;
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new HttpError(500, 'invalid_password_state', 'Hash de senha armazenado em formato invalido.');
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

async function delayForFailedLogin(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
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

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers = baseHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders });
  return new Response(JSON.stringify(body), { status, headers });
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}
