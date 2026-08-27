export type Seller = {
  id: number;
  name: string;
  rdEmployeeId: string | null;
  walletName: string | null;
  isDefault: boolean;
};

export type CurrentUser = {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'assistant';
  sellers: Seller[];
};

export type RdEmployee = {
  id: string;
  name: string;
  active: boolean;
};

export type RdOverview = {
  configured: true;
  connected: true;
  employees: RdEmployee[];
  wallets: string[];
};

export type RdSyncResult = {
  ok: true;
  total: number;
  created: number;
  updated: number;
  skipped: number;
};

type ApiErrorBody = { error?: string; message?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    let body: ApiErrorBody = {};
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      // Mantem uma mensagem generica quando a resposta nao for JSON.
    }
    throw new Error(body.message ?? body.error ?? `Erro HTTP ${response.status}`);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  me: () => request<CurrentUser>('/api/me'),
  login: (email: string, password: string) =>
    request<CurrentUser>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  rdOverview: () => request<RdOverview>('/api/admin/rd/overview'),
  syncRdEmployees: () => request<RdSyncResult>('/api/admin/rd/sync-employees', { method: 'POST', body: '{}' }),
  updateSellerWallet: (sellerId: number, walletName: string | null) =>
    request<{ ok: true; sellerId: number; walletName: string | null }>(`/api/admin/sellers/${sellerId}/wallet`, {
      method: 'PUT',
      body: JSON.stringify({ walletName }),
    }),
};
