import { FormEvent, useEffect, useState } from 'react';
import type { Seller } from './api';
import {
  loadWalletContacts,
  syncWalletContacts,
  WalletContact,
  WalletSyncStatus,
} from './walletContactsApi';
import './walletContacts.css';

export function WalletContacts({ seller }: { seller: Seller }) {
  const [contacts, setContacts] = useState<WalletContact[]>([]);
  const [selected, setSelected] = useState<WalletContact | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  const [syncMessage, setSyncMessage] = useState('');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [syncStatus, setSyncStatus] = useState<WalletSyncStatus | null>(null);
  const [note, setNote] = useState('');

  useEffect(() => {
    setContacts([]);
    setSelected(null);
    setSearch('');
    setSearchDraft('');
    setPage(1);
    setHasMore(false);
    setTotal(0);
    setSyncStatus(null);
    setError('');
    setSyncMessage('');
    setNote('');

    if (seller.walletName) void fetchPage(1, '', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller.id, seller.walletName]);

  async function fetchPage(targetPage: number, term: string, append: boolean) {
    setLoading(true);
    setError('');
    try {
      const response = await loadWalletContacts(seller.id, targetPage, term);
      setContacts((current) => append ? mergeContacts(current, response.contacts) : response.contacts);
      setPage(response.page);
      setHasMore(response.hasMore);
      setTotal(response.total);
      setSyncStatus(response.sync);
      setNote(response.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nao foi possivel carregar os contatos da carteira.');
    } finally {
      setLoading(false);
    }
  }

  async function syncNextBatch() {
    setSyncing(true);
    setError('');
    setSyncMessage('');
    try {
      const response = await syncWalletContacts(seller.id);
      setSyncMessage(response.message);
      await fetchPage(1, search, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nao foi possivel sincronizar a carteira com a RD.');
    } finally {
      setSyncing(false);
    }
  }

  function submitSearch(event: FormEvent) {
    event.preventDefault();
    const term = searchDraft.trim();
    setSearch(term);
    setSelected(null);
    void fetchPage(1, term, false);
  }

  if (!seller.walletName) {
    return (
      <section className="wallet-empty">
        <div className="empty-icon">↗</div>
        <h3>Carteira ainda nao mapeada</h3>
        <p>O administrador precisa associar uma carteira do RD Conversas a {seller.name} no menu Integracao RD.</p>
      </section>
    );
  }

  return (
    <section className="wallet-panel">
      <div className="wallet-toolbar">
        <div>
          <p className="eyebrow">Carteira RD</p>
          <h3>{seller.walletName}</h3>
          <span>{total} contato(s) em cache nesta carteira</span>
        </div>

        <form className="wallet-search" onSubmit={submitSearch}>
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Buscar por nome, telefone ou e-mail"
            aria-label="Buscar contatos"
          />
          <button type="submit" disabled={loading || syncing}>{loading ? 'Buscando...' : 'Buscar'}</button>
        </form>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
      {syncMessage && <div className="success-box" role="status">{syncMessage}</div>}

      <div className="wallet-layout">
        <div className="wallet-list-wrap">
          <div className="wallet-actions wallet-sync-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={syncing || loading || syncStatus?.reachedEnd === true}
              onClick={() => void syncNextBatch()}
            >
              {syncing ? 'Sincronizando com a RD...' : syncStatus?.reachedEnd ? 'Sincronizacao concluida' : 'Sincronizar proximo lote da RD'}
            </button>
            {syncStatus?.lastSyncAt && (
              <span className="wallet-end">Ultima sincronizacao: {formatDate(syncStatus.lastSyncAt)}</span>
            )}
          </div>

          {loading && contacts.length === 0 ? (
            <div className="wallet-loading"><div className="loader" /><span>Lendo o cache...</span></div>
          ) : contacts.length === 0 ? (
            <div className="wallet-empty compact">
              <h3>Nenhum contato desta carteira no cache ainda</h3>
              <p>
                {search
                  ? `Nenhum resultado em cache para “${search}”.`
                  : 'Clique em Sincronizar proximo lote da RD. O sistema consulta a RD em ritmo controlado e salva os contatos localmente para evitar o erro 429.'}
              </p>
            </div>
          ) : (
            <div className="wallet-list">
              {contacts.map((contact) => (
                <button
                  type="button"
                  className={selected?.id === contact.id ? 'wallet-contact selected' : 'wallet-contact'}
                  key={contact.id}
                  onClick={() => setSelected(contact)}
                >
                  <div className="contact-avatar">{contact.name.slice(0, 1).toUpperCase()}</div>
                  <div className="contact-main">
                    <strong>{contact.name}</strong>
                    <span>{contact.phone}</span>
                    {contact.email && <small>{contact.email}</small>}
                  </div>
                  <span className="contact-arrow">›</span>
                </button>
              ))}
            </div>
          )}

          <div className="wallet-actions">
            {hasMore && (
              <button
                type="button"
                className="secondary-button"
                disabled={loading || syncing}
                onClick={() => void fetchPage(page + 1, search, true)}
              >
                {loading ? 'Carregando...' : 'Mostrar mais contatos do cache'}
              </button>
            )}
          </div>

          {note && <p className="wallet-note">{note}</p>}
        </div>

        <aside className="contact-detail">
          {selected ? (
            <>
              <div className="detail-header">
                <div className="contact-avatar large">{selected.name.slice(0, 1).toUpperCase()}</div>
                <div>
                  <span>Contato</span>
                  <h3>{selected.name}</h3>
                </div>
              </div>

              <dl className="detail-grid">
                <div><dt>Telefone</dt><dd>{selected.phone}</dd></div>
                <div><dt>E-mail</dt><dd>{selected.email ?? 'Nao informado'}</dd></div>
                <div><dt>Carteira</dt><dd>{selected.currentWallet ?? seller.walletName}</dd></div>
                <div><dt>ID RD</dt><dd className="mono">{selected.id}</dd></div>
              </dl>

              <div className="detail-section">
                <span>Tags</span>
                <div className="tag-row">
                  {selected.tags.length > 0
                    ? selected.tags.map((tag) => <span className="contact-tag" key={tag}>{tag}</span>)
                    : <small>Nenhuma tag retornada.</small>}
                </div>
              </div>

              <div className="detail-section">
                <span>Ultima mensagem</span>
                {selected.lastMessage ? (
                  <div className="last-message">
                    <p>{selected.lastMessage.content ?? 'Conteudo nao retornado.'}</p>
                    <small>{formatDate(selected.lastMessage.createdAt)}{selected.lastMessage.channel ? ` · ${selected.lastMessage.channel}` : ''}</small>
                  </div>
                ) : (
                  <small>A RD nao retornou resumo de mensagem para este contato.</small>
                )}
              </div>

              <div className="coming-next">
                <strong>Proxima etapa</strong>
                <span>Abrir o historico completo e enviar mensagens para este contato.</span>
              </div>
            </>
          ) : (
            <div className="detail-placeholder">
              <div className="empty-icon">↗</div>
              <h3>Selecione um contato</h3>
              <p>Os detalhes do cliente aparecem aqui sem sair da carteira.</p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}

function mergeContacts(current: WalletContact[], incoming: WalletContact[]) {
  const byId = new Map(current.map((contact) => [contact.id, contact]));
  for (const contact of incoming) byId.set(contact.id, contact);
  return [...byId.values()];
}

function formatDate(value: string | null) {
  if (!value) return 'Data nao informada';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}
