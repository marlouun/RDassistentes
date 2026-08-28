import { useEffect, useState } from 'react';
import { api, RdOverview, Seller } from './api';
import './rd-admin.css';

type Props = {
  sellers: Seller[];
  onRefresh: () => Promise<void>;
};

export function RdAdmin({ sellers, onRefresh }: Props) {
  const [overview, setOverview] = useState<RdOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [savingSellerId, setSavingSellerId] = useState<number | null>(null);
  const [sectorDrafts, setSectorDrafts] = useState<Record<number, string>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function loadOverview() {
    setLoading(true);
    setError('');
    try {
      const result = await api.rdOverview();
      setOverview(result);
    } catch (err) {
      setOverview(null);
      setError(err instanceof Error ? err.message : 'Nao foi possivel consultar a RD.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOverview();
  }, []);

  useEffect(() => {
    const next: Record<number, string> = {};
    for (const seller of sellers) next[seller.id] = seller.walletName ?? '';
    setSectorDrafts(next);
  }, [sellers]);

  async function syncEmployees() {
    setSyncing(true);
    setError('');
    setMessage('');
    try {
      const result = await api.syncRdEmployees();
      setMessage(`${result.created} vendedor(es) criado(s), ${result.updated} atualizado(s).`);
      await onRefresh();
      await loadOverview();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao sincronizar funcionarios da RD.');
    } finally {
      setSyncing(false);
    }
  }

  async function saveSector(seller: Seller) {
    setSavingSellerId(seller.id);
    setError('');
    setMessage('');
    try {
      const value = sectorDrafts[seller.id]?.trim() || null;
      await api.updateSellerWallet(seller.id, value);
      setMessage(`Setor RD de ${seller.name} atualizado.`);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao salvar o Setor RD.');
    } finally {
      setSavingSellerId(null);
    }
  }

  return (
    <div className="rd-admin-stack">
      <section className="rd-status-card">
        <div>
          <p className="eyebrow">RD Station Conversas</p>
          <h2>Integracao administrativa</h2>
          <p>O token permanece no Worker. O navegador recebe apenas dados normalizados.</p>
        </div>
        <div className={overview?.connected ? 'rd-connection ok' : 'rd-connection'}>
          <span className="rd-dot" />
          <strong>{loading ? 'Testando...' : overview?.connected ? 'Conectado' : 'Nao conectado'}</strong>
        </div>
      </section>

      {error && <div className="error-box" role="alert">{error}</div>}
      {message && <div className="rd-success" role="status">{message}</div>}

      <section className="rd-summary-grid">
        <article className="rd-summary-card"><span>Funcionarios na RD</span><strong>{overview?.employees.length ?? '--'}</strong></article>
        <article className="rd-summary-card"><span>Filtro das conversas</span><strong>Setor RD</strong></article>
        <article className="rd-summary-card"><span>Vendedores sincronizados</span><strong>{sellers.length}</strong></article>
      </section>

      <section className="rd-panel">
        <div className="rd-panel-header">
          <div>
            <h3>Funcionarios e vendedores</h3>
            <p>Sincroniza os funcionarios retornados pela RD para a tabela de vendedores do painel.</p>
          </div>
          <button type="button" onClick={syncEmployees} disabled={syncing || loading || !overview?.connected}>
            {syncing ? 'Sincronizando...' : 'Sincronizar RD'}
          </button>
        </div>

        {overview?.employees.length ? (
          <div className="rd-chip-list">
            {overview.employees.map((employee) => (
              <span className={employee.active ? 'rd-chip' : 'rd-chip muted'} key={employee.id}>
                {employee.name}<small>{employee.active ? 'ativo' : 'inativo'}</small>
              </span>
            ))}
          </div>
        ) : !loading && <p className="rd-muted">Nenhum funcionario reconhecido na resposta da RD.</p>}
      </section>

      <section className="rd-panel">
        <div className="rd-panel-header">
          <div>
            <h3>Mapeamento de setores</h3>
            <p>Informe exatamente o nome do setor criado no RD Conversas para cada vendedor, por exemplo: Equipe Vendedor X.</p>
          </div>
        </div>

        {sellers.length === 0 ? (
          <p className="rd-muted">Sincronize os funcionarios da RD para comecar.</p>
        ) : (
          <div className="rd-seller-list">
            {sellers.map((seller) => (
              <div className="rd-seller-row" key={seller.id}>
                <div className="rd-seller-info">
                  <strong>{seller.name}</strong>
                  <span>RD ID: {seller.rdEmployeeId ?? 'nao informado'}</span>
                </div>
                <label>
                  <span>Setor RD</span>
                  <input
                    value={sectorDrafts[seller.id] ?? ''}
                    onChange={(event) => setSectorDrafts((current) => ({ ...current, [seller.id]: event.target.value }))}
                    placeholder="Ex.: Equipe Vendedor X"
                    maxLength={160}
                  />
                </label>
                <button type="button" className="secondary-button" onClick={() => saveSector(seller)} disabled={savingSellerId === seller.id}>
                  {savingSellerId === seller.id ? 'Salvando...' : 'Salvar'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
