import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { backend, enterDemo, isConfigured } from '../backend';
import { DEMO_USERS } from '../backend/demo';
import { resetDemo } from '../backend/demo';
import { useStore } from '../store';
import { Field, Icon, Tabs } from '../components/ui';
import { errorMessage } from '../lib/util';

type Mode = 'login' | 'signup' | 'forgot';

export default function AuthPage() {
  const loc = useLocation();
  useEffect(() => {
    if (loc.pathname.startsWith('/rejoindre/')) {
      try {
        localStorage.setItem('coloc-invite', loc.pathname.split('/')[2]);
      } catch {
        /* ignore */
      }
    }
  }, [loc.pathname]);

  if (backend.mode === 'demo') return <DemoLogin />;
  return <RealAuth />;
}

function Shell({ children, subtitle }: { children: React.ReactNode; subtitle: string }) {
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="card-pad">
          <div className="auth-logo"><Icon name="home" size={26} /></div>
          <div>
            <h1>Coloc</h1>
            <p className="muted">{subtitle}</p>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
}

function DemoLogin() {
  const [err, setErr] = useState('');
  return (
    <Shell subtitle="Tâches, calendrier et budget partagés, pour deux.">
      {!isConfigured && (
        <div className="info-box">
          Supabase n’est pas encore configuré : l’application fonctionne en <b>mode démo</b>, avec des données fictives enregistrées dans ce navigateur.
          Suivez le guide <code>GUIDE.md</code> pour activer les vrais comptes.
        </div>
      )}
      <p className="small muted">Choisissez une personne. Astuce : ouvrez un second onglet avec l’autre personne pour voir la synchronisation.</p>
      <div className="stack-sm">
        {DEMO_USERS.map((u, i) => (
          <button key={u.id} className={i === 0 ? 'btn btn-primary btn-block' : 'btn btn-block'} onClick={() => backend.signIn(u.email, '').catch((e) => setErr(errorMessage(e)))}>
            Entrer en tant que {u.name}
          </button>
        ))}
      </div>
      {err && <div className="error-box">{err}</div>}
      <button className="btn btn-ghost btn-sm" onClick={() => { resetDemo(); setErr(''); }}>Réinitialiser les données de démo</button>
    </Shell>
  );
}

function RealAuth() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setInfo('');
    setBusy(true);
    try {
      if (mode === 'login') await backend.signIn(email.trim(), password);
      else if (mode === 'signup') {
        if (password.length < 8) throw new Error('Choisissez un mot de passe d’au moins 8 caractères.');
        const r = await backend.signUp(email.trim(), password, name.trim());
        if (r.needsConfirmation) setInfo('Compte créé. Ouvrez le lien de confirmation reçu par e-mail, puis connectez-vous.');
      } else {
        await backend.resetPassword(email.trim());
        setInfo('Si un compte existe pour cette adresse, un e-mail de réinitialisation vient d’être envoyé.');
      }
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell subtitle="Espace privé de votre colocation.">
      {mode !== 'forgot' && (
        <Tabs value={mode} onChange={(m) => { setMode(m); setErr(''); setInfo(''); }} tabs={[{ value: 'login', label: 'Connexion' }, { value: 'signup', label: 'Créer un compte' }]} />
      )}
      <form className="stack" onSubmit={submit}>
        {mode === 'forgot' && <p className="small muted">Indiquez votre adresse : vous recevrez un lien pour choisir un nouveau mot de passe.</p>}
        {mode === 'signup' && (
          <Field label="Prénom ou pseudo">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoComplete="nickname" />
          </Field>
        )}
        <Field label="Adresse e-mail">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </Field>
        {mode !== 'forgot' && (
          <Field label="Mot de passe" hint={mode === 'signup' ? '8 caractères minimum' : undefined}>
            <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
          </Field>
        )}
        {err && <div className="error-box" role="alert">{err}</div>}
        {info && <div className="info-box">{info}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Patientez…' : mode === 'login' ? 'Se connecter' : mode === 'signup' ? 'Créer mon compte' : 'Envoyer le lien'}
        </button>
      </form>
      <div className="row between small">
        {mode === 'forgot' ? (
          <button className="btn btn-ghost btn-sm" onClick={() => setMode('login')}>← Retour à la connexion</button>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => setMode('forgot')}>Mot de passe oublié ?</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={enterDemo}>Essayer la démo</button>
      </div>
    </Shell>
  );
}

export function RecoveryPage() {
  const { setRecovery, toast } = useStore();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pw.length < 8) return setErr('Au moins 8 caractères.');
    if (pw !== pw2) return setErr('Les deux mots de passe ne correspondent pas.');
    setBusy(true);
    try {
      await backend.updatePassword(pw);
      window.history.replaceState(null, '', window.location.pathname + window.location.hash);
      setRecovery(false);
      toast('Mot de passe modifié.');
    } catch (e2) {
      setErr(errorMessage(e2));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell subtitle="Choisissez un nouveau mot de passe.">
      <form className="stack" onSubmit={submit}>
        <Field label="Nouveau mot de passe"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" required /></Field>
        <Field label="Confirmation"><input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" required /></Field>
        {err && <div className="error-box">{err}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>Enregistrer</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRecovery(false)}>Plus tard</button>
      </form>
    </Shell>
  );
}
