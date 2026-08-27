import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { Seller } from './api';
import {
  ConversationContact,
  ConversationMessage,
  loadConversationContacts,
  loadConversationHistory,
  sendConversationMessage,
} from './conversationsApi';
import './conversations.css';

export function ConversationsPanel({ seller }: { seller: Seller }) {
  const [contacts, setContacts] = useState<ConversationContact[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [searchDraft, setSearchDraft] = useState('');
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);
  const [contactsError, setContactsError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [messageDraft, setMessageDraft] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const selected = useMemo(
    () => contacts.find((contact) => contact.id === selectedId) ?? null,
    [contacts, selectedId],
  );

  useEffect(() => {
    setContacts([]);
    setSelectedId(null);
    setMessages([]);
    setSearchDraft('');
    setContactsError('');
    setHistoryError('');
    setMessageDraft('');
    setPage(1);
    setHasMore(false);
    if (seller.walletName) void fetchContacts('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller.id, seller.walletName]);

  async function fetchContacts(term: string) {
    setLoadingContacts(true);
    setContactsError('');
    try {
      const response = await loadConversationContacts(seller.id, term);
      setContacts(response.contacts);
      if (selectedId && !response.contacts.some((contact) => contact.id === selectedId)) {
        setSelectedId(null);
        setMessages([]);
      }
    } catch (error) {
      setContactsError(error instanceof Error ? error.message : 'Nao foi possivel carregar os contatos.');
    } finally {
      setLoadingContacts(false);
    }
  }

  async function openContact(contact: ConversationContact) {
    setSelectedId(contact.id);
    setMessages([]);
    setPage(1);
    setHasMore(false);
    await fetchHistory(contact.id, 1, false);
  }

  async function fetchHistory(contactId: string, targetPage = 1, prepend = false) {
    setLoadingHistory(true);
    setHistoryError('');
    try {
      const response = await loadConversationHistory(seller.id, contactId, targetPage);
      setMessages((current) => prepend ? mergeMessages(response.messages, current) : response.messages);
      setPage(response.page);
      setHasMore(response.hasMore);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Nao foi possivel carregar o historico.');
    } finally {
      setLoadingHistory(false);
    }
  }

  async function submitMessage(event: FormEvent) {
    event.preventDefault();
    if (!selected || !messageDraft.trim() || sending) return;

    const message = messageDraft.trim();
    setSending(true);
    setHistoryError('');
    try {
      await sendConversationMessage(seller.id, selected.id, message);
      setMessageDraft('');
      await fetchHistory(selected.id, 1, false);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Nao foi possivel enviar a mensagem.');
    } finally {
      setSending(false);
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    void fetchContacts(searchDraft.trim());
  }

  if (!seller.walletName) {
    return (
      <section className="conversation-empty-card">
        <h3>Carteira ainda nao mapeada</h3>
        <p>Mapeie uma carteira para {seller.name} antes de abrir as conversas.</p>
      </section>
    );
  }

  return (
    <section className="conversation-shell">
      <aside className="conversation-sidebar">
        <div className="conversation-sidebar-header">
          <div>
            <p className="eyebrow">Conversas RD</p>
            <h3>{seller.name}</h3>
            <span>{seller.walletName}</span>
          </div>
          <button
            type="button"
            className="conversation-refresh"
            disabled={loadingContacts}
            onClick={() => void fetchContacts(searchDraft.trim())}
            title="Atualizar contatos"
          >
            ↻
          </button>
        </div>

        <form className="conversation-search" onSubmit={submitSearch}>
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Buscar cliente"
            aria-label="Buscar cliente nas conversas"
          />
        </form>

        {contactsError && <div className="conversation-inline-error">{contactsError}</div>}

        <div className="conversation-contact-list">
          {loadingContacts && contacts.length === 0 ? (
            <div className="conversation-list-state">Carregando clientes...</div>
          ) : contacts.length === 0 ? (
            <div className="conversation-list-state">
              <strong>Nenhum contato em cache</strong>
              <span>Quando a carteira for sincronizada, os clientes aparecerao aqui automaticamente.</span>
            </div>
          ) : contacts.map((contact) => (
            <button
              type="button"
              key={contact.id}
              className={selectedId === contact.id ? 'conversation-contact active' : 'conversation-contact'}
              onClick={() => void openContact(contact)}
            >
              <div className="conversation-avatar">{contact.name.slice(0, 1).toUpperCase()}</div>
              <div className="conversation-contact-copy">
                <strong>{contact.name}</strong>
                <span>{contact.phone}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="conversation-chat">
        {!selected ? (
          <div className="conversation-placeholder">
            <div className="conversation-placeholder-icon">↗</div>
            <h3>Selecione um cliente</h3>
            <p>O historico real do WhatsApp sera carregado pela API do RD Station Conversas.</p>
          </div>
        ) : (
          <>
            <header className="conversation-chat-header">
              <div className="conversation-avatar large">{selected.name.slice(0, 1).toUpperCase()}</div>
              <div>
                <strong>{selected.name}</strong>
                <span>{selected.phone}{selected.email ? ` · ${selected.email}` : ''}</span>
              </div>
              <button
                type="button"
                className="conversation-refresh labeled"
                disabled={loadingHistory}
                onClick={() => void fetchHistory(selected.id, 1, false)}
              >
                {loadingHistory ? 'Atualizando...' : 'Atualizar'}
              </button>
            </header>

            {historyError && <div className="conversation-history-error">{historyError}</div>}

            <div className="conversation-messages">
              {hasMore && (
                <button
                  type="button"
                  className="conversation-load-older"
                  disabled={loadingHistory}
                  onClick={() => void fetchHistory(selected.id, page + 1, true)}
                >
                  {loadingHistory ? 'Carregando...' : 'Carregar mensagens anteriores'}
                </button>
              )}

              {loadingHistory && messages.length === 0 ? (
                <div className="conversation-list-state">Carregando historico da RD...</div>
              ) : messages.length === 0 && !historyError ? (
                <div className="conversation-list-state">
                  <strong>Nenhuma mensagem retornada</strong>
                  <span>Este contato pode ainda nao ter historico disponivel no periodo retornado pela API.</span>
                </div>
              ) : messages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}
            </div>

            <form className="conversation-composer" onSubmit={submitMessage}>
              <textarea
                value={messageDraft}
                onChange={(event) => setMessageDraft(event.target.value)}
                placeholder="Digite uma mensagem para o cliente..."
                maxLength={4000}
                rows={2}
              />
              <button type="submit" disabled={sending || !messageDraft.trim()}>
                {sending ? 'Enviando...' : 'Enviar'}
              </button>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

function MessageBubble({ message }: { message: ConversationMessage }) {
  const own = message.sentBy === 'operator' || message.sentBy === 'bot';
  const label = message.sentBy === 'customer'
    ? 'Cliente'
    : message.sentBy === 'operator'
      ? message.operatorName ?? 'Operador'
      : message.sentBy === 'bot'
        ? 'Bot'
        : 'Mensagem';

  return (
    <div className={own ? 'conversation-message-row own' : 'conversation-message-row'}>
      <div className={own ? 'conversation-bubble own' : 'conversation-bubble'}>
        <span className="conversation-message-author">{label}</span>
        <p>{message.content || `[${message.type}]`}</p>
        <small>{formatDate(message.createdAt)}</small>
      </div>
    </div>
  );
}

function mergeMessages(older: ConversationMessage[], newer: ConversationMessage[]) {
  const byId = new Map<string, ConversationMessage>();
  for (const message of [...older, ...newer]) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => timeValue(a.createdAt) - timeValue(b.createdAt));
}

function formatDate(value: string | null) {
  if (!value) return 'Horario nao informado';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function timeValue(value: string | null) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
