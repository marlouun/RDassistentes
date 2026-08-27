import { FormEvent, useEffect, useMemo, useState } from 'react';
import { api, CurrentUser, Seller } from './api';
import { ConversationsPanel } from './ConversationsPanel';
import { RdAdmin } from './RdAdmin';
import { WalletContacts } from './WalletContacts';

type View = 'fila' | 'carteira' | 'conversas' | 'negociacoes' | 'integracao';

const viewCopy: Record<View, { title: string; description: string }> = {
  fila: {
    title: 'Fila do vendedor',
    description: 'Aqui entraremos com os leads atualmente visiveis para o vendedor selecionado.',
  },
  carteira: {
    title: 'Carteira',
    description: 'Clientes reais da carteira mapeada no RD Station Conversas.',
  },
  conversas: {
    title: 'Conversas',
    description: 'Historico real e envio de mensagens pelo RD Station Conversas.',
  },
  negociacoes: {
    title: 'Negociacoes',
    description: 'Criacao de negociacoes usando os campos e o responsavel do RD Station CRM.',
  },
  integracao: {
    title: 'Integracao RD',
    description: 'Teste a conexao, sincronize vendedores e associe as carteiras do RD Conversas.',
  },
};

export default function App() {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('fila');
  const [selectedSellerId, setSelectedSellerId] = useState<number | null>(null);

  useEffect(() => {
    api.me()
      .then((current) => applyCurrentUser(current))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  function applyCurrentUser(current: CurrentUser) {
    setUser(current);
    setSelectedSellerId((currentSelected) => {
      if (currentSelected && current.sellers.some((seller) => seller.id === currentSelected)) return currentSelected;
      const defaultSeller = current.sellers.find((seller) => seller.isDefault) ?? current.sellers[0];
      return defaultSeller?.id ?? null;
    });
  }

  async function refreshCurrentUser() {
    applyCurrentUser(await api.me());
  }

  const selectedSeller = useMemo<Seller | undefined>(
    () => user?.sellers.find((seller) => seller.id === selectedSellerId),
    [selectedSellerId, user],
  );

  if (loading) return <div className="center-screen"><div className="loader" aria-label="Carregando" /></div>;
  if (!user) return <Login onSuccess={applyCurrentUser} />;

  async function logout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setSelectedSellerId(null);
      setView('fila');
    }
  }

  const isAdminIntegration = view === 'integracao' && user.role === 'admin';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">RD</div>
          <div><strong>Assistentes</strong><span>Brunx Comercial</span></div>
        </div>

        <nav className="nav-list" aria-label="Menu principal">
          <NavButton active={view === 'fila'} onClick={() => setView('fila')} label="Fila" />
          <NavButton active={view === 'carteira'} onClick={() => setView('carteira')} label="Carteira" />
          <NavButton active={view === 'conversas'} onClick={() => setView('conversas')} label="Conversas" />
          <NavButton active={view === 'negociacoes'} onClick={() => setView('negociacoes')} label="Negociacoes" />
          {user.role === 'admin' && <NavButton active={view === 'integracao'} onClick={() => setView('integracao')} label="Integracao RD" />}
        </nav>

        <div className="user-card">
          <div className="avatar">{user.name.slice(0, 1).toUpperCase()}</div>
          <div className="user-meta">
            <strong>{user.name}</strong>
            <span>{user.role === 'admin' ? 'Administrador' : 'Assistente'}</span>
          </div>
          <button className="link-button" onClick={logout}>Sair</button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div><p className="eyebrow">Painel comercial</p><h1>{viewCopy[view].title}</h1></div>
          {!isAdminIntegration && (
            <label className="seller-picker">
              <span>Vendedor atual</span>
              <select
                value={selectedSellerId ?? ''}
                onChange={(event) => setSelectedSellerId(Number(event.target.value))}
                disabled={user.sellers.length === 0}
              >
                {user.sellers.length === 0 && <option value="">Nenhum vendedor vinculado</option>}
                {user.sellers.map((seller) => <option key={seller.id} value={seller.id}>{seller.name}</option>)}
              </select>
            </label>
          )}
        </header>

        {isAdminIntegration ? (
          <RdAdmin sellers={user.sellers} onRefresh={refreshCurrentUser} />
        ) : (
          <>
            <section className="hero-card">
              <div>
                <span className="status-pill">Integracao em andamento</span>
                <h2>{selectedSeller ? `Operando com ${selectedSeller.name}` : 'Vincule um vendedor ao usuario'}</h2>
                <p>{viewCopy[view].description}</p>
              </div>
              <div className="integration-box">
                <span>Integracoes</span>
                <strong>RD Conversas + RD CRM</strong>
                <small>Tokens e chaves permanecem somente no backend.</small>
              </div>
            </section>

            <section className="grid-cards">
              <Metric title="Leads na fila" value="--" note="Fila sera validada em etapa especifica" />
              <Metric title="Clientes na carteira" value={selectedSeller?.walletName ? '✓' : '--'} note={selectedSeller?.walletName ?? 'Carteira ainda nao mapeada'} />
              <Metric title="Conversas" value={view === 'conversas' ? 'RD' : '--'} note={view === 'conversas' ? 'Historico e envio conectados' : 'Abra o menu Conversas'} />
            </section>

            {renderWorkspace(view, selectedSeller)}
          </>
        )}
      </main>
    </div>
  );
}

function renderWorkspace(view: View, seller: Seller | undefined) {
  if (view === 'carteira' && seller) return <WalletContacts seller={seller} />;
  if (view === 'conversas' && seller) return <ConversationsPanel seller={seller} />;

  return (
    <section className="empty-state">
      <div className="empty-icon">↗</div>
      <h3>{seller?.rdEmployeeId ? 'Vendedor sincronizado com a RD' : 'Sincronize os vendedores no menu Integracao RD'}</h3>
      <p>
        {seller?.rdEmployeeId
          ? `RD employee ID: ${seller.rdEmployeeId}`
          : 'O administrador pode testar o token, importar funcionarios e mapear carteiras sem expor credenciais no navegador.'}
      </p>
    </section>
  );
}

function Login({ onSuccess }: { onSuccess: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      onSuccess(await api.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Nao foi possivel entrar.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="brand login-brand"><div className="brand-mark">RD</div><div><strong>Assistentes</strong><span>Brunx Comercial</span></div></div>
        <div className="login-copy">
          <p className="eyebrow">Acesso interno</p>
          <h1>Entre para acompanhar seu vendedor.</h1>
          <p>Fila, carteira, conversas e negociacoes em uma interface unica.</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>E-mail<input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Senha<input type="password" autoComplete="current-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button type="submit" disabled={submitting}>{submitting ? 'Entrando...' : 'Entrar'}</button>
        </form>
      </div>
      <div className="login-visual">
        <div className="visual-card"><span>Seguranca</span><strong>Credenciais da RD nunca ficam no frontend.</strong></div>
        <div className="visual-card"><span>Permissoes</span><strong>Cada assistente enxerga apenas vendedores autorizados.</strong></div>
        <div className="visual-card"><span>Auditoria</span><strong>Acoes importantes ficam registradas.</strong></div>
      </div>
    </div>
  );
}

function NavButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return <button className={active ? 'nav-button active' : 'nav-button'} onClick={onClick}>{label}</button>;
}

function Metric({ title, value, note }: { title: string; value: string; note: string }) {
  return <article className="metric-card"><span>{title}</span><strong>{value}</strong><small>{note}</small></article>;
}
