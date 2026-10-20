export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

export function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n > 1 ? many : one}`;
}

export function fmtMinutes(min: number): string {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}

/** Message d'erreur compréhensible, sans détail technique sensible. */
export function errorMessage(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e);
  const code = (e as { code?: string })?.code;
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Connexion impossible. Vérifiez votre réseau puis réessayez.';
  if (/Invalid login credentials/i.test(msg)) return 'E-mail ou mot de passe incorrect.';
  if (/Email not confirmed/i.test(msg)) return 'Confirmez d’abord votre adresse e-mail (lien reçu par e-mail).';
  if (/User already registered/i.test(msg)) return 'Un compte existe déjà avec cette adresse.';
  if (/Password should be at least/i.test(msg)) return 'Le mot de passe doit contenir au moins 6 caractères.';
  if (/rate limit/i.test(msg)) return 'Trop de tentatives. Patientez quelques minutes.';
  if (/row-level security|permission denied/i.test(msg)) return 'Action non autorisée.';
  if (/duplicate key/i.test(msg)) return 'Cet élément existe déjà (envoi en double évité).';
  if (code === 'P0001' || code === 'P0002' || /^[A-ZÀ-Ü]/.test(msg)) return msg;
  return code ? `Une erreur est survenue (code ${code}). Réessayez ou signalez ce code.` : 'Une erreur est survenue. Réessayez.';
}
