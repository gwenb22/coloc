import { useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useData } from '../store';
import { backend, leaveDemo } from '../backend';
import { Icon, Modal } from './ui';
import { isOpen } from '../lib/fairness';
import { today } from '../lib/dates';
import { DEMO_USERS } from '../backend/demo';
import { useRecurringGenerator } from './useRecurringGenerator';

const NAV = [
  { to: '/', label: 'Accueil', short: 'Accueil', icon: 'home' },
  { to: '/taches', label: 'Tâches', short: 'Tâches', icon: 'tasks' },
  { to: '/calendrier', label: 'Calendrier', short: 'Agenda', icon: 'calendar' },
  { to: '/budget', label: 'Budget', short: 'Budget', icon: 'wallet' },
  { to: '/courses', label: 'Courses et stocks', short: 'Courses', icon: 'cart' },
  { to: '/entretien', label: 'Entretien', short: 'Entretien', icon: 'tool' },
  { to: '/notifications', label: 'Notifications', short: 'Alertes', icon: 'bell' },
  { to: '/parametres', label: 'Paramètres', short: 'Réglages', icon: 'settings' },
];

export default function Layout({ children }: { children: ReactNode }) {
  const { data, online, realtime, meId, name, personClass } = useData();
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  useRecurringGenerator();
  const unread = data.notifications.filter((n) => !n.read_at).length;
  const pendingSwaps = data.swap_requests.filter((s) => s.status === 'pending' && s.to_user === meId).length;
  const myLate = data.task_occurrences.filter((o) => o.assigned_to === meId && !o.proposed && isOpen(o) && o.due_date < today()).length;
  const badge = (to: string) => (to === '/notifications' ? unread + pendingSwaps : to === '/taches' ? myLate : 0);
  const title = NAV.find((n) => (n.to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(n.to)))?.short ?? '';

  const switchDemo = async () => {
    const other = DEMO_USERS.find((u) => u.id !== meId)!;
    await backend.signOut();
    await backend.signIn(other.email, '');
  };

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Navigation principale">
        <div className="brand">
          <img className="brand-logo" src="./logo.jpg" alt="" />
          <div className="ellipsis">Coloc<small className="ellipsis">{data.household.name}</small></div>
        </div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => 'nav-link' + (isActive ? ' active' : '')}>
            <Icon name={n.icon} />
            {n.label}
            {badge(n.to) > 0 && <span className="count">{badge(n.to)}</span>}
          </NavLink>
        ))}
        <div className="sidebar-foot">
          <span className="small muted">Connecté·e : <b>{name(meId)}</b></span>
          <span className="xs muted">{realtime === 'live' ? '● Synchronisé en temps réel' : realtime === 'connecting' ? '○ Connexion…' : '○ Synchronisation interrompue'}</span>
        </div>
      </aside>

      <div className="main">
        {!online && (
          <div className="banner offline" role="alert">
            <Icon name="wifiOff" size={16} /> Hors ligne : consultation seule. Les modifications nécessitent une connexion.
          </div>
        )}
        {backend.mode === 'demo' && !new URLSearchParams(window.location.search).has('capture') && (
          <div className="banner demo">
            <span>Mode démo : données fictives stockées dans ce navigateur. Vous êtes <b>{name(meId)}</b>.</span>
            <button className="btn btn-sm" onClick={switchDemo}><Icon name="swap" size={14} />Passer à {DEMO_USERS.find((u) => u.id !== meId)?.name}</button>
            {import.meta.env.VITE_SUPABASE_URL && <button className="btn btn-sm btn-ghost" onClick={leaveDemo}>Quitter la démo</button>}
          </div>
        )}
        <header className="topbar mhead">
          <NavLink to="/notifications" className="round-btn" aria-label={`Notifications (${unread} non lues)`}>
            <Icon name="bell" size={18} />
            {unread + pendingSwaps > 0 && <span className="dot" />}
          </NavLink>
          <h1 className="ellipsis">{title}</h1>
          <NavLink to="/parametres" className={`avatar-btn ${personClass(meId)}`} aria-label="Profil et paramètres">{name(meId).slice(0, 1).toUpperCase()}</NavLink>
        </header>
        <main className="content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Navigation mobile">
        {NAV.slice(0, 5).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={n.icon} size={20} />
            <span className="lbl">{n.short}</span>
            {badge(n.to) > 0 && <span className="dot" />}
          </NavLink>
        ))}
        <button onClick={() => setMenu(true)} className={NAV.slice(5).some((n) => loc.pathname.startsWith(n.to)) ? 'active' : ''} aria-label="Plus de rubriques">
          <Icon name="more" size={20} />
          <span className="lbl">Plus</span>
          {unread + pendingSwaps > 0 && <span className="dot" />}
        </button>
      </nav>

      {menu && (
        <Modal title="Rubriques" onClose={() => setMenu(false)}>
          <div className="menu-sheet">
            {NAV.slice(5).map((n) => (
              <NavLink key={n.to} to={n.to} onClick={() => setMenu(false)}>
                <Icon name={n.icon} size={24} />
                {n.short}
                {badge(n.to) > 0 && <span className="count">{badge(n.to)}</span>}
              </NavLink>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
