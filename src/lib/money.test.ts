import { describe, expect, it } from 'vitest';
import { allocate, computeBalances, computeShares, parseCents, settlement } from './money';

const A = 'a', B = 'b';

describe('parseCents', () => {
  it('accepte virgule et point', () => {
    expect(parseCents('12,5')).toBe(1250);
    expect(parseCents('12.05')).toBe(1205);
    expect(parseCents('0,01')).toBe(1);
    expect(parseCents('1 234,56')).toBe(123456);
  });
  it('refuse les saisies invalides', () => {
    expect(parseCents('12,555')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('-3')).toBeNull();
  });
});

describe('computeShares', () => {
  it('50/50 au centime près sans perte', () => {
    const s = computeShares(6001, 'equal', [{ user_id: A }, { user_id: B }]);
    expect(s.map((x) => x.share_cents)).toEqual([3001, 3000]);
  });
  it('pourcentage 70/30', () => {
    const s = computeShares(999, 'percent', [{ user_id: A, value: 70 }, { user_id: B, value: 30 }]);
    expect(s[0].share_cents + s[1].share_cents).toBe(999);
    expect(s[0].share_cents).toBe(699);
  });
  it('refuse des pourcentages incohérents', () => {
    expect(() => computeShares(100, 'percent', [{ user_id: A, value: 70 }, { user_id: B, value: 20 }])).toThrow();
  });
  it('montants fixes exacts', () => {
    expect(() => computeShares(1000, 'fixed', [{ user_id: A, value: 600 }, { user_id: B, value: 300 }])).toThrow();
    expect(computeShares(1000, 'fixed', [{ user_id: A, value: 700 }, { user_id: B, value: 300 }]).map((x) => x.share_cents)).toEqual([700, 300]);
  });
  it('une seule personne', () => {
    expect(computeShares(1000, 'single', [{ user_id: B }])).toEqual([{ user_id: B, share_cents: 1000, percent: 100 }]);
  });
  it('allocate conserve toujours le total', () => {
    for (let t = 1; t < 500; t += 7) {
      const parts = allocate(t, [33.3, 33.3, 33.4]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(t);
    }
  });
});

describe('soldes', () => {
  it("exemple du cahier des charges : 60 € de courses payés par A, B doit 30 €", () => {
    const bal = computeBalances([A, B], {
      expenses: [{ id: 'e1', paid_by: A, amount_cents: 6000, status: 'validated' }],
      shares: [{ expense_id: 'e1', user_id: A, share_cents: 3000 }, { expense_id: 'e1', user_id: B, share_cents: 3000 }],
      reimbursements: [],
    });
    expect(bal).toEqual({ a: 3000, b: -3000 });
    expect(settlement(bal)).toEqual({ from: B, to: A, amount: 3000 });
  });
  it('un remboursement solde la dette sans compter comme dépense ; annulées et prévues ignorées', () => {
    const bal = computeBalances([A, B], {
      expenses: [
        { id: 'e1', paid_by: A, amount_cents: 6000, status: 'validated' },
        { id: 'e2', paid_by: B, amount_cents: 9999, status: 'cancelled' },
      ],
      shares: [
        { expense_id: 'e1', user_id: A, share_cents: 3000 }, { expense_id: 'e1', user_id: B, share_cents: 3000 },
        { expense_id: 'e2', user_id: A, share_cents: 9999 },
      ],
      reimbursements: [
        { from_user: B, to_user: A, amount_cents: 3000, status: 'done' },
        { from_user: B, to_user: A, amount_cents: 500, status: 'planned' },
      ],
    });
    expect(bal).toEqual({ a: 0, b: 0 });
    expect(settlement(bal)).toBeNull();
  });
});
