import type { HouseData } from '../types';

export const GROUP_COLORS = ['#FFC6EA', '#FFE58F', '#B5ECFF', '#C3F49B', '#DCD3FF', '#FFD9C2', '#FFB4B4', '#A8E6CF'];
const DEFAULTS: Record<string, string> = { sols: '#B5ECFF', linge: '#DCD3FF' };

export interface TaskGroup {
  name: string;
  color: string;
  count: number;
}

/** Groupes connus : ceux enregistrés dans les réglages + ceux utilisés par des tâches. */
export function listGroups(data: Pick<HouseData, 'household' | 'task_templates'>): TaskGroup[] {
  const saved = data.household.settings.groups ?? {};
  const names = new Map<string, string>(); // clé insensible à la casse → nom affiché
  for (const n of Object.keys(saved)) names.set(n.toLowerCase(), n);
  for (const t of data.task_templates) {
    const g = t.group_name?.trim();
    if (g && !t.archived && !names.has(g.toLowerCase())) names.set(g.toLowerCase(), g);
  }
  return [...names.values()]
    .map((name, i) => ({
      name,
      color: saved[name]?.color ?? DEFAULTS[name.toLowerCase()] ?? GROUP_COLORS[i % GROUP_COLORS.length],
      count: data.task_templates.filter((t) => !t.archived && t.group_name?.trim().toLowerCase() === name.toLowerCase()).length,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

export function groupColor(data: Pick<HouseData, 'household' | 'task_templates'>, name: string | null | undefined): string | null {
  if (!name?.trim()) return null;
  return listGroups(data).find((g) => g.name.toLowerCase() === name.trim().toLowerCase())?.color ?? null;
}

/** Texte noir ou blanc selon la clarté de la couleur de fond. */
export function inkFor(hex: string): string {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.35 ? '#111111' : '#ffffff';
}
