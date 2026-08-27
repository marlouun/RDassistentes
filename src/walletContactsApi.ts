export type WalletContact = {
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

export type WalletSyncStatus = {
  nextSourcePage: number;
  nextSourceIndex: number;
  reachedEnd: boolean;
  lastSyncAt: string | null;
};

export type WalletContactsResponse = {
  seller: {
    id: number;
    name: string;
    rdEmployeeId: string | null;
    walletName: string | null;
  };
  contacts: WalletContact[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  sync: WalletSyncStatus;
  note: string;
};

export type WalletSyncResponse = {
  ok: boolean;
  synced: number;
  matchedWallet: number;
  cachedForWallet?: number;
  detailRequests: number;
  pagesScanned: number;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
  reachedEnd: boolean;
  nextSourcePage: number;
  nextSourceIndex: number;
  message: string;
};

type ApiError = { error?: string; message?: string };

export async function loadWalletContacts(
  sellerId: number,
  page = 1,
  search = '',
): Promise<WalletContactsResponse> {
  const params = new URLSearchParams({ page: String(page) });
  if (search.trim()) params.set('search', search.trim());

  const response = await fetch(`/api/sellers/${sellerId}/contacts?${params.toString()}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  return readResponse<WalletContactsResponse>(response);
}

export async function syncWalletContacts(sellerId: number): Promise<WalletSyncResponse> {
  const response = await fetch(`/api/sellers/${sellerId}/contacts/sync`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  return readResponse<WalletSyncResponse>(response);
}

async function readResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: ApiError = {};
    try {
      body = (await response.json()) as ApiError;
    } catch {
      // Mantem mensagem generica quando o upstream nao retorna JSON.
    }
    throw new Error(body.message ?? body.error ?? `Erro HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}
