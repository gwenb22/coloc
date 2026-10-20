import type { Budget, Expense, ExpenseShare, UUID } from '../types';

/** Dépense commune = validée et partagée entre au moins deux personnes. */
export function isShared(e: Expense, shares: ExpenseShare[]): boolean {
  return shares.filter((s) => s.expense_id === e.id && s.share_cents > 0).length >= 2;
}

export function inPeriod(date: string, year: number, month: number): boolean {
  const [y, m] = date.split('-').map(Number);
  return y === year && (month === 0 || m === month);
}

export interface BudgetUsage {
  spent: number;
  byCategory: Record<UUID, number>;
  expenses: Expense[];
}

/** Dépenses communes validées retenues pour un budget (mois ou année). */
export function budgetUsage(year: number, month: number, expenses: Expense[], shares: ExpenseShare[]): BudgetUsage {
  const list = expenses.filter((e) => e.status === 'validated' && inPeriod(e.date, year, month) && isShared(e, shares));
  const byCategory: Record<UUID, number> = {};
  for (const e of list) byCategory[e.category_id ?? 'none'] = (byCategory[e.category_id ?? 'none'] ?? 0) + e.amount_cents;
  return { spent: list.reduce((a, e) => a + e.amount_cents, 0), byCategory, expenses: list };
}

export function findBudget(budgets: Budget[], period: 'month' | 'year', year: number, month: number) {
  return budgets.find((b) => b.period === period && b.year === year && b.month === (period === 'year' ? 0 : month));
}
