import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { backend } from '../backend';
import { useData } from '../store';
import type { ShoppingItem, Stock } from '../types';
import { Empty, Field, Icon, Modal, Tabs, useConfirm } from '../components/ui';
import { useModals } from '../components/Modals';
import { Beige, MRow, SectionTitle } from '../components/mobile';
import { fmtDateTime } from '../lib/dates';
import { formatMoney } from '../lib/money';
import { cx } from '../lib/util';

export default function ShoppingPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'stocks' ? 'stocks' : 'courses';
  return (
    <div className="mpage">
      <Tabs value={tab} onChange={(t) => setParams(t === 'courses' ? {} : { tab: t }, { replace: true })} tabs={[{ value: 'courses', label: 'Liste de courses' }, { value: 'stocks', label: 'Stocks' }]} />
      {tab === 'courses' ? <Shopping /> : <Stocks />}
    </div>
  );
}

const SHOP_TO_EXPENSE: Record<string, string> = {
  Alimentation: 'Courses alimentaires', 'Produits ménagers': 'Produits ménagers', 'Hygiène et salle de bain': 'Produits ménagers',
  Consommables: 'Produits ménagers', Équipement: 'Mobilier et équipement',
};

function Shopping() {
  const { data, run, meId, name } = useData();
  const { openShopping, openExpense } = useModals();
  const [quick, setQuick] = useState('');
  const [cat, setCat] = useState('all');
  const cats = data.categories.filter((c) => c.kind === 'shopping' && !c.archived).sort((a, b) => a.position - b.position);
  const toBuy = data.shopping_items.filter((s) => s.status === 'to_buy' && (cat === 'all' || s.category === cat))
    .sort((a, b) => Number(b.priority === 'high') - Number(a.priority === 'high') || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const bought = data.shopping_items.filter((s) => s.status === 'bought' && (cat === 'all' || s.category === cat)).sort((a, b) => (b.bought_at ?? '').localeCompare(a.bought_at ?? '')).slice(0, 8);
  const inList = (st: Stock) => data.shopping_items.some((i) => i.status === 'to_buy' && (i.stock_id === st.id || i.name.toLowerCase() === st.name.toLowerCase()));
  const low = data.stocks.filter((st) => Number(st.quantity) <= Number(st.min_threshold) && !inList(st));

  const buy = (s: ShoppingItem) => run(async () => {
    await backend.update('shopping_items', s.id, { status: 'bought', bought_at: new Date().toISOString(), bought_by: meId }, s.version);
    const st = s.stock_id && data.stocks.find((x) => x.id === s.stock_id);
    if (st) await backend.update('stocks', st.id, { quantity: Number(st.quantity) + Number(s.quantity) }, st.version);
  }, { success: `${s.name} acheté${s.stock_id ? ' · stock mis à jour' : ''}`, tables: ['shopping_items', 'stocks'], key: 'buy-' + s.id });
  const unbuy = (s: ShoppingItem) => run(() => backend.update('shopping_items', s.id, { status: 'to_buy', bought_at: null, bought_by: null }, s.version), { success: 'Article remis dans la liste', tables: ['shopping_items'] });

  const addQuick = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = quick.trim();
    if (!n) return;
    const r = await run(() => backend.insert('shopping_items', { household_id: data.household.id, name: n, category: cat !== 'all' ? cat : cats[0]?.name ?? 'Autres', created_by: meId }), { tables: ['shopping_items'], key: 'quick-shop' });
    if (r) setQuick('');
  };

  return (
    <>
      <div className="hscroll">
        <button className="pill" aria-pressed={cat === 'all'} onClick={() => setCat('all')}>Tout</button>
        {cats.map((c) => <button key={c.id} className="pill" aria-pressed={cat === c.name} onClick={() => setCat(c.name)}>{c.name}</button>)}
      </div>

      <div className="mgrid">
        <div className="mcol">
          {low.map((st) => (
            <div key={st.id} className="soft-card t-jaune">
              <span className="zone-ic" aria-hidden="true">📦</span>
              <div className="grow"><b>{st.name} bientôt épuisé</b><div className="small muted">Stock : {Number(st.quantity)} {st.unit} · seuil {Number(st.min_threshold)}</div></div>
              <button className="pill dark sm" onClick={() => openShopping(null, { name: st.name, stock_id: st.id, category: 'Consommables', quantity: Math.max(1, Number(st.min_threshold) * 2 - Number(st.quantity)), unit: st.unit })}>Ajouter</button>
            </div>
          ))}
          <form className="row" onSubmit={addQuick}>
            <input className="input" style={{ borderRadius: 999, background: 'var(--surface-2)', borderColor: 'transparent' }} value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="Ajouter un article… (Entrée)" aria-label="Nouvel article" maxLength={120} />
            <button className="round-btn" style={{ background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'transparent', flexShrink: 0 }} aria-label="Ajouter"><Icon name="plus" size={18} /></button>
          </form>
          <SectionTitle title="À acheter" right={<span className="muted">{toBuy.length} article{toBuy.length > 1 ? 's' : ''}</span>} />
          <Beige>
            {toBuy.length === 0 && <div className="empty-line">La liste est vide.</div>}
            {toBuy.map((s) => (
              <MRow key={s.id}
                over={<>{s.category}{s.quantity !== 1 || s.unit ? ` · ${s.quantity} ${s.unit}` : ''}{s.priority === 'high' ? ' · urgent' : ''}{s.assigned_to ? ` · ${name(s.assigned_to)}` : ''}{s.price_estimate_cents != null ? ` · ~${formatMoney(s.price_estimate_cents, data.household.currency)}` : ''}</>}
                title={s.name} late={s.priority === 'high'} onClick={() => openShopping(s)}
                check={{ done: false, onToggle: () => buy(s), label: `Marquer ${s.name} comme acheté` }} />
            ))}
          </Beige>
          <button className="btn btn-primary btn-big" onClick={() => openShopping(null, cat !== 'all' ? { category: cat } : undefined)}><Icon name="plus" />Ajouter un article</button>
        </div>
        <div className="mcol">
          <SectionTitle title="Achetés récemment" />
          <Beige>
            {bought.length === 0 && <div className="empty-line">Aucun achat récent.</div>}
            {bought.map((s) => (
              <MRow key={s.id} done over={<>par {name(s.bought_by)} · {fmtDateTime(s.bought_at)}</>} title={s.name}
                right={<button className="pill white sm" onClick={(e) => { e.stopPropagation(); openExpense(null, { title: s.name, amount_cents: s.price_estimate_cents ?? undefined, category_name: SHOP_TO_EXPENSE[s.category] ?? 'Autres dépenses' }); }}>€ Dépense</button>}
                check={{ done: true, onToggle: () => unbuy(s), label: `Remettre ${s.name} dans la liste` }} />
            ))}
          </Beige>
          <p className="xs muted">« € Dépense » préremplit le formulaire : rien n’est enregistré sans validation.</p>
        </div>
      </div>
    </>
  );
}

export function stockStatus(s: Stock): { label: string; cls: string } {
  if (Number(s.quantity) <= 0) return { label: 'Épuisé', cls: 'danger' };
  if (Number(s.quantity) <= Number(s.min_threshold)) return { label: 'Bientôt à renouveler', cls: 'warning' };
  return { label: 'Suffisant', cls: 'success' };
}

function Stocks() {
  const { data, run } = useData();
  const { openShopping } = useModals();
  const confirm = useConfirm();
  const [edit, setEdit] = useState<Stock | null | 'new'>(null);
  const list = [...data.stocks].sort((a, b) => a.name.localeCompare(b.name));
  const inList = (s: Stock) => data.shopping_items.some((i) => i.status === 'to_buy' && (i.stock_id === s.id || i.name.toLowerCase() === s.name.toLowerCase()));
  const suggestions = list.filter((s) => Number(s.quantity) <= Number(s.min_threshold) && !inList(s));
  const step = (s: Stock, d: number) => run(() => backend.update('stocks', s.id, { quantity: Math.max(0, Number(s.quantity) + d) }, s.version), { tables: ['stocks', 'notifications'], key: 'stock-' + s.id });

  return (
    <div className="stack">
      {suggestions.length > 0 && (
        <div className="card card-pad stack-sm" style={{ background: 'var(--warning-soft)', borderColor: 'transparent' }}>
          <div className="row"><Icon name="alert" /><b className="grow">Seuil atteint : ajouter à la liste de courses ?</b></div>
          <div className="row-wrap">
            {suggestions.map((s) => (
              <button key={s.id} className="btn btn-sm" onClick={() => openShopping(null, { name: s.name, stock_id: s.id, category: 'Consommables', quantity: Math.max(1, Number(s.min_threshold) * 2 - Number(s.quantity)), unit: s.unit })}>
                <Icon name="plus" size={14} />{s.name}
              </button>
            ))}
          </div>
          <span className="xs">La proposition ouvre le formulaire : quantité et catégorie restent modifiables.</span>
        </div>
      )}
      <div className="card">
        <div className="card-head"><h3>Consommables</h3><button className="btn btn-sm btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={14} />Ajouter</button></div>
        <div className="list">
          {list.length === 0 && <Empty icon="box">Aucun produit suivi.</Empty>}
          {list.map((s) => {
            const st = stockStatus(s);
            return (
              <div key={s.id} className="list-item">
                <div className="grow" style={{ cursor: 'pointer' }} onClick={() => setEdit(s)}>
                  <div className="title ellipsis">{s.name}</div>
                  <div className="meta"><span className={cx('badge', st.cls)}>{st.label}</span>{s.location && <span>{s.location}</span>}<span>seuil {Number(s.min_threshold)}</span><span className="hide-sm">maj {fmtDateTime(s.updated_at)}</span></div>
                </div>
                <div className="row" style={{ gap: 4 }}>
                  <button className="btn btn-sm btn-icon" onClick={() => step(s, -1)} aria-label={`Retirer un ${s.name}`} disabled={Number(s.quantity) <= 0}><Icon name="minus" size={15} /></button>
                  <span className="num strong" style={{ minWidth: 48, textAlign: 'center' }}>{Number(s.quantity)}<span className="xs muted"> {s.unit}</span></span>
                  <button className="btn btn-sm btn-icon" onClick={() => step(s, 1)} aria-label={`Ajouter un ${s.name}`}><Icon name="plus" size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {edit && <StockModal stock={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDelete={async (s) => {
        if (await confirm({ title: `Ne plus suivre « ${s.name} » ?`, danger: true, confirm: 'Supprimer' })) {
          const r = await run(() => backend.remove('stocks', s.id), { success: 'Produit retiré du suivi', tables: ['stocks'] });
          if (r !== undefined) setEdit(null);
        }
      }} />}
    </div>
  );
}

function StockModal({ stock, onClose, onDelete }: { stock: Stock | null; onClose: () => void; onDelete: (s: Stock) => void }) {
  const { data, run } = useData();
  const [f, setF] = useState({ name: stock?.name ?? '', quantity: String(stock?.quantity ?? 1), unit: stock?.unit ?? '', min_threshold: String(stock?.min_threshold ?? 1), location: stock?.location ?? '' });
  const [err, setErr] = useState('');
  const save = async () => {
    if (!f.name.trim()) return setErr('Indiquez un nom.');
    const q = Number(f.quantity.replace(',', '.')), m = Number(f.min_threshold.replace(',', '.'));
    if (!Number.isFinite(q) || q < 0 || !Number.isFinite(m) || m < 0) return setErr('Quantités invalides.');
    const payload = { name: f.name.trim(), quantity: q, unit: f.unit.trim(), min_threshold: m, location: f.location.trim() };
    const r = await run<unknown>(() => stock ? backend.update('stocks', stock.id, payload, stock.version) : backend.insert('stocks', { ...payload, household_id: data.household.id }), { success: 'Stock enregistré', tables: ['stocks'], key: 'stock-save' });
    if (r) onClose();
  };
  return (
    <Modal title={stock ? stock.name : 'Nouveau consommable'} onClose={onClose} footer={<>{stock && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => onDelete(stock)}>Supprimer</button>}<button className="btn" onClick={onClose}>Annuler</button><button className="btn btn-primary" onClick={save}>Enregistrer</button></>}>
      <div className="form-grid">
        <Field label="Produit" className="full"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex. : papier toilette" /></Field>
        <Field label="Quantité approximative"><input className="input" inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
        <Field label="Unité"><input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="rouleaux, flacons…" /></Field>
        <Field label="Seuil minimum" hint="Alerte et suggestion d’achat à ce niveau"><input className="input" inputMode="decimal" value={f.min_threshold} onChange={(e) => setF({ ...f, min_threshold: e.target.value })} /></Field>
        <Field label="Emplacement"><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Placard, sous l’évier…" /></Field>
      </div>
      {err && <div className="error-box">{err}</div>}
    </Modal>
  );
}
