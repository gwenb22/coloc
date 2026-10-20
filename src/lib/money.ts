import type { SplitMode, UUID } from '../types';

export interface ShareInput {
  user_id: UUID;
  /** pourcentage (mode percent) ou montant en centimes (mode fixed) */
  value?: number;
  included?: boolean;
}

export interface ComputedShare {
  user_id: UUID;
  share_cents: number;
  percent: number | null;
}

/** Convertit une saisie « 12,50 » ou « 12.5 » en centimes. Renvoie null si invalide. */
export function parseCents(input: string): number | null {
  const s = input.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{0,2})?$/.test(s)) return null;
  const [int, dec = ''] = s.split('.');
  return Number(int) * 100 + Number((dec + '00').slice(0, 2));
}

export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

export function formatMoney(cents: number, currency = 'EUR'): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(cents / 100);
}

/**
 * Répartit `total` centimes proportionnellement aux poids donnés, sans créer ni perdre de centime
 * (méthode du plus fort reste ; égalité départagée par l'ordre fourni).
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) throw new Error('Répartition impossible : aucun poids positif.');
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) out[order[k].i]++;
  return out;
}

export class SplitError extends Error {}

/**
 * Calcule les parts d'une dépense selon le mode choisi.
 * - equal : parts égales entre les personnes incluses
 * - percent : value = pourcentage, total 100
 * - fixed : value = centimes, total = montant
 * - single : une seule personne (la première incluse) supporte tout
 */
export function computeShares(amount: number, mode: SplitMode, inputs: ShareInput[]): ComputedShare[] {
  if (!Number.isInteger(amount) || amount <= 0) throw new SplitError('Le montant doit être positif.');
  const included = inputs.filter((i) => i.included !== false);
  if (included.length === 0) throw new SplitError('Choisissez au moins une personne concernée.');

  switch (mode) {
    case 'equal': {
      const parts = allocate(amount, included.map(() => 1));
      const pct = Math.round((100 / included.length) * 1000) / 1000;
      return included.map((s, i) => ({ user_id: s.user_id, share_cents: parts[i], percent: pct }));
    }
    case 'single': {
      return [{ user_id: included[0].user_id, share_cents: amount, percent: 100 }];
    }
    case 'percent': {
      const pcts = included.map((s) => Number(s.value ?? 0));
      if (pcts.some((p) => !Number.isFinite(p) || p < 0 || p > 100)) throw new SplitError('Chaque pourcentage doit être compris entre 0 et 100.');
      const total = pcts.reduce((a, b) => a + b, 0);
      if (Math.abs(total - 100) > 0.001) throw new SplitError(`Les pourcentages totalisent ${round3(total)} % au lieu de 100 %.`);
      const parts = allocate(amount, pcts);
      return included.map((s, i) => ({ user_id: s.user_id, share_cents: parts[i], percent: pcts[i] }));
    }
    case 'fixed': {
      const vals = included.map((s) => Number(s.value ?? 0));
      if (vals.some((v) => !Number.isInteger(v) || v < 0)) throw new SplitError('Montants invalides.');
      const total = vals.reduce((a, b) => a + b, 0);
      if (total !== amount) {
        throw new SplitError(`Les montants totalisent ${formatMoney(total)} au lieu de ${formatMoney(amount)}.`);
      }
      return included.map((s, i) => ({ user_id: s.user_id, share_cents: vals[i], percent: round3((vals[i] / amount) * 100) }));
    }
  }
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000;
}

export interface BalanceInputs {
  expenses: { id: UUID; paid_by: UUID; amount_cents: number; status: string }[];
  shares: { expense_id: UUID; user_id: UUID; share_cents: number }[];
  reimbursements: { from_user: UUID; to_user: UUID; amount_cents: number; status: string }[];
}

/**
 * Solde net de chaque personne : positif = on lui doit de l'argent, négatif = elle doit de l'argent.
 * Seules les dépenses validées et les remboursements effectués comptent.
 * Un remboursement n'est jamais compté comme une dépense.
 */
export function computeBalances(userIds: UUID[], data: BalanceInputs): Record<UUID, number> {
  const bal: Record<UUID, number> = Object.fromEntries(userIds.map((u) => [u, 0]));
  const valid = new Map(data.expenses.filter((e) => e.status === 'validated').map((e) => [e.id, e]));
  for (const e of valid.values()) bal[e.paid_by] = (bal[e.paid_by] ?? 0) + e.amount_cents;
  for (const s of data.shares) {
    if (valid.has(s.expense_id)) bal[s.user_id] = (bal[s.user_id] ?? 0) - s.share_cents;
  }
  for (const r of data.reimbursements) {
    if (r.status !== 'done') continue;
    bal[r.from_user] = (bal[r.from_user] ?? 0) + r.amount_cents;
    bal[r.to_user] = (bal[r.to_user] ?? 0) - r.amount_cents;
  }
  return bal;
}

/** Pour deux personnes : qui doit combien à qui. */
export function settlement(bal: Record<UUID, number>): { from: UUID; to: UUID; amount: number } | null {
  const entries = Object.entries(bal);
  const debtor = entries.find(([, v]) => v < 0);
  const creditor = entries.find(([, v]) => v > 0);
  if (!debtor || !creditor) return null;
  return { from: debtor[0], to: creditor[0], amount: Math.min(-debtor[1], creditor[1]) };
}
