import { useEffect, useState, type FormEvent } from 'react';
import { backend } from '../backend';
import { useStore } from '../store';
import { Field, Icon, Tabs } from '../components/ui';
import { errorMessage } from '../lib/util';

export default function Onboarding({ inviteFromUrl }: { inviteFromUrl?: string }) {
  const { setHouseholdId, user } = useStore();
  const stored = (() => {
    try {
      return localStorage.getItem('coloc-invite') ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const initialCode = inviteFromUrl ?? stored ?? '';
  const [tab, setTab] = useState<'create' | 'join'>(initialCode ? 'join' : 'create');
  const [name, setName] = useState('Notre appart');
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<{ name: string; from: string; full: boolean } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const clearInvite = () => {
    try {
      localStorage.removeItem('coloc-invite');
    } catch {
      /* ignore */
    }
  };

  const peek = async (c = code) => {
    setErr('');
    setPreview(null);
    if (!c.trim()) return;
    try {
      setPreview(await backend.rpc('peek_invite', { p_code: c.trim() }));
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  useEffect(() => {
    if (initialCode) peek(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const id = await backend.rpc<string>('create_household', { p_name: name.trim() });
      clearInvite();
      setHouseholdId(id);
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setBusy(true);
    setErr('');
    try {
      const id = await backend.rpc<string>('join_household', { p_code: code.trim() });
      clearInvite();
      window.location.hash = '#/';
      setHouseholdId(id);
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  const refuse = () => {
    clearInvite();
    setPreview(null);
    setCode('');
    window.location.hash = '#/';
    setTab('create');
  };

  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card-pad">
          <div className="auth-logo"><Icon name="home" size={26} /></div>
          <div>
            <h1>Bienvenue</h1>
            <p className="muted">Connecté·e en tant que {user?.email}. Créez votre colocation ou rejoignez celle de votre colocataire.</p>
          </div>
          <Tabs value={tab} onChange={(t) => { setTab(t); setErr(''); }} tabs={[{ value: 'create', label: 'Créer' }, { value: 'join', label: 'Rejoindre' }]} />
          {tab === 'create' ? (
            <form className="stack" onSubmit={create}>
              <Field label="Nom de la colocation">
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
              </Field>
              <p className="small muted">Les six espaces communs (cuisine, salle de bain, WC, salon, entrée, balcon) et des tâches d’exemple modifiables seront créés. Vous pourrez ensuite inviter votre colocataire.</p>
              {err && <div className="error-box">{err}</div>}
              <button className="btn btn-primary btn-block" disabled={busy}>Créer la colocation</button>
            </form>
          ) : (
            <div className="stack">
              <Field label="Code d’invitation" hint="Code à 8 caractères fourni par votre colocataire (Paramètres > Membres).">
                <div className="row">
                  <input className="input" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={12} style={{ letterSpacing: '.1em', fontWeight: 600 }} />
                  <button className="btn" onClick={() => peek()} type="button">Vérifier</button>
                </div>
              </Field>
              {preview && (
                <div className="card card-pad stack-sm" style={{ background: 'var(--surface-2)' }}>
                  <div><b>{preview.name}</b></div>
                  <div className="small muted">Invitation de {preview.from}</div>
                  {preview.full ? (
                    <div className="error-box">Cette colocation a déjà deux membres.</div>
                  ) : (
                    <div className="row" style={{ marginTop: 6 }}>
                      <button className="btn btn-primary grow" onClick={join} disabled={busy}>Accepter</button>
                      <button className="btn" onClick={refuse}>Refuser</button>
                    </div>
                  )}
                </div>
              )}
              {err && <div className="error-box">{err}</div>}
            </div>
          )}
          <button className="btn btn-ghost btn-sm" onClick={() => backend.signOut()}><Icon name="logout" size={14} />Se déconnecter</button>
        </div>
      </div>
    </div>
  );
}
