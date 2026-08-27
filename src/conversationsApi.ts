export type ConversationContact = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  lastMessage: unknown;
};

export type ConversationMessage = {
  id: string;
  content: string;
  sentBy: 'customer' | 'operator' | 'bot' | 'unknown';
  type: string;
  createdAt: string | null;
  operatorName: string | null;
};

export type ConversationContactsResponse = {
  seller: {
    id: number;
    name: string;
    walletName: string;
  };
  contacts: ConversationContact[];
};

export type ConversationHistoryResponse = {
  contact: {
    id: string;
    name: string;
    phone: string;
    email: string | null;
  };
  messages: ConversationMessage[];
  page: number;
  hasMore: boolean;
  encrypted: boolean;
};

type ApiError = { error?: string; message?: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  headers.set('Accept', 'application/json');

  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (!response.ok) {
    let body: ApiError = {};
    try { body = (await response.json()) as ApiError; } catch { /* resposta sem JSON */ }
    throw new Error(body.message ?? body.error ?? `Erro HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

export function loadConversationContacts(sellerId: number, search = '') {
  const params = new URLSearchParams();
  if (search.trim()) params.set('search', search.trim());
  const suffix = params.size ? `?${params.toString()}` : '';
  return request<ConversationContactsResponse>(`/api/sellers/${sellerId}/conversation-contacts${suffix}`);
}

export function loadConversationHistory(sellerId: number, contactId: string, page = 1) {
  const params = new URLSearchParams({ page: String(page) });
  return request<ConversationHistoryResponse>(
    `/api/sellers/${sellerId}/contacts/${encodeURIComponent(contactId)}/messages?${params.toString()}`,
  );
}

export function sendConversationMessage(sellerId: number, contactId: string, message: string) {
  return request<{ ok: true; contactId: string }>(
    `/api/sellers/${sellerId}/contacts/${encodeURIComponent(contactId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ message }),
    },
  );
}
