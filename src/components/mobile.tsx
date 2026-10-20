import type { ReactNode } from 'react';
import { Icon } from './ui';
import { cx } from '../lib/util';
import { inkFor } from '../lib/groups';

// Briques d'interface reprises de la maquette Figma (cartes beiges, lignes simples, colonnes, puces de jours).

export function SectionTitle({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div className="sec-title">
      <h2>{title}</h2>
      {right && <div className="sec-right">{right}</div>}
    </div>
  );
}

export function Beige({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cx('beige', className)}>
      {(title || action) && (
        <div className="beige-head">
          {title && <h3>{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function MRow({ over, title, right, check, onClick, done, late }: {
  over?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
  check?: { done: boolean; onToggle: () => void; label: string };
  onClick?: () => void;
  done?: boolean;
  late?: boolean;
}) {
  return (
    <div className={cx('mrow', done && 'done', late && 'late', onClick && 'clickable')} onClick={onClick}
      role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined} onKeyDown={(e) => onClick && e.key === 'Enter' && onClick()}>
      <div className="grow">
        {over && <div className="over ellipsis">{over}</div>}
        <div className="ttl ellipsis">{title}</div>
      </div>
      {right}
      {check && (
        <button className={cx('check', check.done && 'done')} aria-label={check.label} onClick={(e) => { e.stopPropagation(); check.onToggle(); }}>
          <Icon name="check" size={15} />
        </button>
      )}
    </div>
  );
}

export function StatPill({ label, value, alert }: { label: string; value: ReactNode; alert?: boolean }) {
  return (
    <div className={cx('stat-pill', alert && 'alert')}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

export type Tone = 'rose' | 'jaune' | 'bleu' | 'vert' | 'lilas' | 'none';

/** Colonnes « macronutriments » : remplissage pastel depuis le bas. */
export function Columns({ items, height = 150 }: { items: { label: string; value: string; tone: Tone; ratio: number }[]; height?: number }) {
  return (
    <div className="cols" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
      {items.map((it) => (
        <div key={it.label} className="col-track" style={{ height }}>
          <div className={cx('col-fill', `t-${it.tone}`)} style={{ height: `${Math.max(36, Math.min(1, it.ratio) * 100)}%` }}>
            <span className="ellipsis">{it.label}</span>
            <b>{it.value}</b>
          </div>
        </div>
      ))}
    </div>
  );
}

export function DayChip({ label, tone = 'none', selected, today, late, onClick, title, marker }: {
  label: ReactNode; tone?: Tone; selected?: boolean; today?: boolean; late?: boolean; onClick?: () => void; title?: string;
  /** petit point lilas : une tâche de « Ma chambre » ce jour-là */
  marker?: boolean;
}) {
  return (
    <button type="button" className={cx('daychip', `t-${tone}`, selected && 'sel', today && 'today', late && 'late')} onClick={onClick} aria-pressed={selected} title={title}>
      {label}
      {marker && <span className="room-mark" aria-label="tâche de ma chambre" />}
    </button>
  );
}

/** Étiquette de groupe de tâches, à la couleur choisie. */
export function GroupBadge({ name, color }: { name: string; color: string | null }) {
  const bg = color ?? '#DCD3FF';
  const fg = inkFor(bg);
  return <span className="badge group-badge" style={{ background: bg, color: fg }}>{name}</span>;
}
