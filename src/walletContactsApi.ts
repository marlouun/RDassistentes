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

export type WalletContactsResponse = {
  seller: {
    id: number;
    name: string;
    rdEmployeeId: string | null;
    walletName: string | null;
  };
  contacts: WalletContact[];
  nextCursor: number | null;
  scannedPages: number;
  sourcePage: number;
  note: string;
};

type ApiError = { error?: string; message?: string };

export async function loadWalletContacts(
  sellerId: number,
  cursor = 1,
  search = '',
): Promise<WalletContactsResponse> {
  const params = new URLSearchParams({ cursor: String(cursor) });
  if (search.trim()) params.set('search', search.trim());

  const response = await fetch(`/api/sellers/${sellerId}/contacts?${params.toString()}`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    let body: ApiError = {};
    try {
      body = (await response.json()) as ApiError;
    } catch {
      // Mantem mensagem generica quando o upstream nao retorna JSON.
    }
    throw new Error(body.message ?? body.error ?? `Erro HTTP ${response.status}`);
  }

  return (await response.json()) as WalletContactsResponse;
}
