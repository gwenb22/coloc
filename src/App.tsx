import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { StoreProvider, ToastProvider, useStore } from './store';
import { ConfirmProvider, Toasts } from './components/ui';
import { ModalsProvider } from './components/Modals';
import Layout from './components/Layout';
import AuthPage, { RecoveryPage } from './pages/Auth';
import Onboarding from './pages/Onboarding';
import Dashboard from './pages/Dashboard';
import Tasks from './pages/Tasks';
import CalendarPage from './pages/Calendar';
import BudgetPage from './pages/Budget';
import ShoppingPage from './pages/Shopping';
import MaintenancePage from './pages/Maintenance';
import NotificationsPage from './pages/Notifications';
import SettingsPage from './pages/Settings';

export default function App() {
  return (
    <ToastProvider>
      <StoreProvider>
        <ConfirmProvider>
          <HashRouter>
            <Gate />
          </HashRouter>
          <Toasts />
        </ConfirmProvider>
      </StoreProvider>
    </ToastProvider>
  );
}

function Loading({ text = 'Chargement…' }: { text?: string }) {
  return (
    <div className="loading-screen">
      <div className="stack" style={{ alignItems: 'center' }}>
        <div className="spinner" />
        <span>{text}</span>
      </div>
    </div>
  );
}

function Gate() {
  const { user, authReady, recovery, householdId, data, loading, loadError, reload } = useStore();
  const loc = useLocation();

  if (!authReady) return <Loading />;
  if (recovery && user) return <RecoveryPage />;
  if (!user) return <AuthPage />;
  if (loading && !data) return <Loading text="Chargement de la colocation…" />;
  if (loadError && !data) {
    return (
      <div className="loading-screen">
        <div className="card card-pad stack" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h2>Impossible de charger les données</h2>
          <p className="muted">{loadError}</p>
          <button className="btn btn-primary" onClick={() => (householdId ? reload() : window.location.reload())}>Réessayer</button>
        </div>
      </div>
    );
  }
  if (!householdId) return <Onboarding inviteFromUrl={loc.pathname.startsWith('/rejoindre/') ? loc.pathname.split('/')[2] : undefined} />;
  if (!data) return <Loading />;

  return (
    <ModalsProvider>
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/taches" element={<Tasks />} />
          <Route path="/calendrier" element={<CalendarPage />} />
          <Route path="/budget" element={<BudgetPage />} />
          <Route path="/courses" element={<ShoppingPage />} />
          <Route path="/entretien" element={<MaintenancePage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/parametres" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </ModalsProvider>
  );
}
