import { FormEvent, useEffect, useState } from 'react';
import type { Seller } from './api';
import { loadWalletContacts, WalletContact } from './walletContactsApi';
import './walletContacts.css';

export function WalletContacts({ seller }: { seller: Seller }) {
  const [contacts, setContacts] = useState<WalletContact[]>([]);
  const [selected, setSelected] = useState<WalletContact | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [nextCursor, setNextCursor] = useState<number | null>(1);
  const [note, setNote] = useState('');

  useEffect(() => {
    setContacts([]);
    setSelected(null);
    setSearch('');
    setSearchDraft('');
    setNextCursor(1);
    setError('');
    setNote('');

    if (seller.walletName) void fetchPage(1, '', false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seller.id, seller.walletName]);

  async function fetchPage(cursor: number, term: string, append: boolean) {
    setLoading(true);
    setError('');
    try {
      const response = await loadWalletContacts(seller.id, cursor, term);
      setContacts((current) => append ? mergeContacts(current, response.contacts) : response.contacts);
      setNextCursor(response.nextCursor);
      setNote(response.note);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nao foi possivel carregar os contatos da carteira.');
    } finally {
      setLoading(false);
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
          <span>{contacts.length} contato(s) encontrado(s) nesta consulta</span>
        </div>

        <form className="wallet-search" onSubmit={submitSearch}>
          <input
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder="Buscar por nome, telefone ou e-mail"
            aria-label="Buscar contatos"
          />
          <button type="submit" disabled={loading}>{loading ? 'Buscando...' : 'Buscar'}</button>
        </form>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}

      <div className="wallet-layout">
        <div className="wallet-list-wrap">
          {loading && contacts.length === 0 ? (
            <div className="wallet-loading"><div className="loader" /><span>Consultando a RD...</span></div>
          ) : contacts.length === 0 ? (
            <div className="wallet-empty compact">
              <h3>Nenhum contato encontrado neste lote</h3>
              <p>
                {search
                  ? `Nenhum resultado para “${search}”. Tente continuar a varredura ou alterar a busca.`
                  : 'A API da RD e percorrida em lotes. Continue carregando para localizar mais contatos desta carteira.'}
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
            {nextCursor !== null ? (
              <button
                type="button"
                className="secondary-button"
                disabled={loading}
                onClick={() => void fetchPage(nextCursor, search, true)}
              >
                {loading ? 'Carregando...' : 'Carregar proximo lote'}
              </button>
            ) : (
              <span className="wallet-end">Fim da listagem da RD para esta consulta.</span>
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
