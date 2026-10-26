import React, { useEffect, useMemo, useState } from 'react';
import { api, devicePanelUrl } from '../api.js';
import { useToast } from '../App.jsx';
import { t, locale } from '../i18n.jsx';
import { panelName } from './SchematicViewer.jsx';

/** How the product groups read in the tree (server/library.js CATEGORIES). */
export const CATEGORY_LABELS = {
  switch: 'Network switches', router: 'Routers', pc: 'Computers', 'audio-interface': 'Audio interfaces', 'power-strip': 'Power strips', headset: 'Headsets', display: 'Displays', panel: 'Panels',
  protective: 'Protective devices', relay: 'Relays and contactors', terminal: 'Terminals', 'power-supply': 'Power supplies', indicator: 'Indicators', distribution: 'Distribution', cable: 'Cables', other: 'General',
};
export const CATEGORIES = Object.keys(CATEGORY_LABELS);
export const PROTECTIVE = ['mcb', 'switch-disconnector', 'fuse', 'lamp'];
const KIND_LABELS = { device: 'Device symbols', contact: 'Contacts', cable: 'Cable marks', graphic: 'Graphic marks' };

/**
 * The parts manager's view of the library: a tree on the left (product group › manufacturer › part, then
 * the symbol catalog, connectors and cable kinds), the selected record's properties on the right — the
 * schematic symbol drawn live by the renderer, never a stored picture, and swappable from the catalog.
 */
export default function LibraryBrowser({ lib, hardware, onEdit, onPromote, onRemove, onChanged }) {
  const toast = useToast();
  const [symbols, setSymbols] = useState([]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null); // {kind: 'template'|'symbol'|'connector'|'cable', id}
  const [open, setOpen] = useState(() => new Set(['parts', 'symbols']));
  useEffect(() => { api.symbols(locale()).then((r) => setSymbols(r.symbols || [])).catch((e) => toast(e.message, 'err')); }, [lib]);
  const toggle = (id) => setOpen((o) => { const n = new Set(o); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const match = (s) => !q || String(s || '').toLowerCase().includes(q.toLowerCase());
  const devices = useMemo(() => lib.devices.filter((d) => [d.name, d.manufacturer, d.model, d.id, d.category].some(match)), [lib, q]);
  // product group › manufacturer › part
  const groups = useMemo(() => {
    const g = new Map();
    for (const d of devices) {
      const cat = d.category || 'other';
      if (!g.has(cat)) g.set(cat, new Map());
      const mk = d.manufacturer || t('— no manufacturer —');
      if (!g.get(cat).has(mk)) g.get(cat).set(mk, []);
      g.get(cat).get(mk).push(d);
    }
    return [...g.entries()].sort((a, b) => CATEGORIES.indexOf(a[0]) - CATEGORIES.indexOf(b[0]));
  }, [devices]);
  const symKinds = useMemo(() => Object.keys(KIND_LABELS).map((k) => [k, symbols.filter((s) => s.kind === k && (match(s.label) || match(s.ref) || match(s.id)))]).filter(([, l]) => l.length), [symbols, q]);
  const node = (id, depth, label, { leaf = false, count = null, active = false, onClick, icon = '' } = {}) => (
    <div key={id} className={`lib-node${active ? ' active' : ''}${leaf ? ' leaf' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={onClick}>
      {!leaf && <span className="lib-twisty">{open.has(id) ? '▾' : '▸'}</span>}
      {icon && <span className="lib-icon" dangerouslySetInnerHTML={{ __html: icon }} />}
      <span className="lib-label">{label}</span>
      {count !== null && <span className="lib-count">{count}</span>}
    </div>
  );
  const isSel = (kind, id) => sel?.kind === kind && sel?.id === id;
  const symbolOf = (id) => symbols.find((s) => s.id === id) || symbols.find((s) => s.aliases?.includes(id)) || null;
  return (
    <div className="lib-browser">
      <div className="lib-tree">
        <input className="lib-search" value={q} placeholder={t('Search parts, symbols, connectors…')} onChange={(e) => setQ(e.target.value)} />
        <div className="lib-tree-body">
          {node('parts', 0, t('Parts'), { count: devices.length, onClick: () => toggle('parts') })}
          {(open.has('parts') || q) && groups.map(([cat, makers]) => (
            <React.Fragment key={cat}>
              {node(`cat:${cat}`, 1, t(CATEGORY_LABELS[cat] || cat), { count: [...makers.values()].reduce((n, l) => n + l.length, 0), onClick: () => toggle(`cat:${cat}`) })}
              {(open.has(`cat:${cat}`) || q) && [...makers.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([mk, list]) => (
                <React.Fragment key={mk}>
                  {node(`mk:${cat}:${mk}`, 2, mk, { count: list.length, onClick: () => toggle(`mk:${cat}:${mk}`) })}
                  {(open.has(`mk:${cat}:${mk}`) || q) && list.sort((a, b) => (a.model || a.name).localeCompare(b.model || b.name)).map((d) =>
                    node(`tpl:${d.id}`, 3, `${d.model ? `${d.model} ` : ''}(${d.name})`, { leaf: true, active: isSel('template', d.id), onClick: () => setSel({ kind: 'template', id: d.id }), icon: symbolOf(d.symbol || 'box')?.svg || '' })
                  )}
                </React.Fragment>
              ))}
            </React.Fragment>
          ))}
          {node('symbols', 0, t('Symbols PN-EN 60617 (IEC 60617)'), { count: symbols.length, onClick: () => toggle('symbols') })}
          {(open.has('symbols') || q) && symKinds.map(([kind, list]) => (
            <React.Fragment key={kind}>
              {node(`sk:${kind}`, 1, t(KIND_LABELS[kind]), { count: list.length, onClick: () => toggle(`sk:${kind}`) })}
              {(open.has(`sk:${kind}`) || q) && list.map((s) => node(`sym:${s.id}`, 2, `${s.ref} ${s.label}`, { leaf: true, active: isSel('symbol', s.id), onClick: () => setSel({ kind: 'symbol', id: s.id }), icon: s.svg }))}
            </React.Fragment>
          ))}
          {node('connectors', 0, t('Connectors'), { count: lib.connectors.length, onClick: () => toggle('connectors') })}
          {(open.has('connectors') || q) && lib.connectors.filter((c) => match(c.label) || match(c.id)).map((c) => node(`con:${c.id}`, 1, c.label, { leaf: true, active: isSel('connector', c.id), onClick: () => setSel({ kind: 'connector', id: c.id }), icon: symbolOf(c.symbol || 'socket')?.svg || '' }))}
          {node('cables', 0, t('Cable kinds'), { count: lib.cables.length, onClick: () => toggle('cables') })}
          {(open.has('cables') || q) && lib.cables.filter((c) => match(c.label) || match(c.id)).map((c) => node(`cab:${c.id}`, 1, c.label, { leaf: true, active: isSel('cable', c.id), onClick: () => setSel({ kind: 'cable', id: c.id }) }))}
        </div>
      </div>
      <div className="lib-props">
        {!sel && <p className="muted">{t('Pick a part, a symbol, a connector or a cable kind on the left to review it.')}</p>}
        {sel?.kind === 'template' && <TemplateProps d={lib.devices.find((x) => x.id === sel.id)} lib={lib} hardware={hardware} symbols={symbols} onEdit={onEdit} onPromote={onPromote} onRemove={onRemove} onChanged={onChanged} onPick={setSel} />}
        {sel?.kind === 'symbol' && <SymbolProps s={symbols.find((x) => x.id === sel.id)} onPick={setSel} />}
        {sel?.kind === 'connector' && <ConnectorProps c={lib.connectors.find((x) => x.id === sel.id)} lib={lib} symbols={symbols} onPick={setSel} />}
        {sel?.kind === 'cable' && <CableProps c={lib.cables.find((x) => x.id === sel.id)} lib={lib} symbols={symbols} onPick={setSel} />}
      </div>
    </div>
  );
}

function Props({ rows }) {
  return (
    <table className="table lib-prop-table">
      <thead><tr><th>{t('Property')}</th><th>{t('Value')}</th></tr></thead>
      <tbody>{rows.filter(Boolean).map(([k, v], i) => <tr key={i}><td className="lib-prop-k">{k}</td><td>{v === '' || v === null || v === undefined ? <span className="muted">—</span> : v}</td></tr>)}</tbody>
    </table>
  );
}

const Svg = ({ svg, big = false }) => <span className={`sym-live${big ? ' big' : ''}`} dangerouslySetInnerHTML={{ __html: svg || '' }} />;

function TemplateProps({ d, lib, hardware, symbols, onEdit, onPromote, onRemove, onChanged, onPick }) {
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const [form, setForm] = useState({ symbol: d?.symbol || 'box', poles: d?.poles ?? 1, rating: d?.rating || '' });
  useEffect(() => { setForm({ symbol: d?.symbol || 'box', poles: d?.poles ?? 1, rating: d?.rating || '' }); setPicking(false); }, [d?.id]);
  if (!d) return null;
  const sym = symbols.find((s) => s.id === (d.symbol || 'box')) || symbols.find((s) => s.aliases?.includes(d.symbol));
  const deviceSymbols = symbols.filter((s) => s.kind === 'device');
  async function applySymbol() {
    try {
      await api.updateDeviceTemplate(d.id, { symbol: form.symbol, poles: PROTECTIVE.includes(form.symbol) ? Number(form.poles) : undefined, rating: PROTECTIVE.includes(form.symbol) ? form.rating : undefined });
      toast(t('Symbol of {name} changed', { name: d.name }));
      setPicking(false);
      onChanged?.();
    } catch (e) { toast(e.message, 'err'); }
  }
  const pics = Object.entries(d.panels || {});
  return (
    <div>
      <div className="lib-props-head">
        <h3>{d.name}</h3>
        <div className="btn-row">
          <button className="btn btn-sm" onClick={() => onEdit(d)}>{t('Edit')}</button>
          <button className="btn btn-sm" onClick={() => onPromote(d)} title={t('Create a module of its own from this device')}>{t('Promote to module')}</button>
          <button className="btn btn-sm btn-danger" onClick={() => onRemove(d)}>{t('Remove')}</button>
        </div>
      </div>
      <Props rows={[
        [t('Product grouping'), `${t('Parts')} › ${t(CATEGORY_LABELS[d.category] || d.category)}${d.manufacturer ? ` › ${d.manufacturer}` : ''}`],
        [t('Part number'), d.model],
        [t('Type'), d.name],
        [t('Manufacturer'), d.manufacturer],
        [t('Template id'), <code>{d.id}</code>],
        [t('Schematic symbol'), (
          <div className="sym-row">
            <Svg svg={sym?.svg} />
            <span>{sym ? `${sym.ref} · ${sym.label}` : d.symbol}</span>
            <button className="btn btn-sm" onClick={() => setPicking((p) => !p)}>{picking ? t('Cancel') : t('Change…')}</button>
            {sym && <button className="btn-link" onClick={() => onPick({ kind: 'symbol', id: sym.id })}>{t('Open in catalog')}</button>}
          </div>
        )],
        picking && [t('Pick a symbol'), (
          <div className="sym-picker">
            <div className="sym-tiles">
              {deviceSymbols.map((s) => (
                <button key={s.id} type="button" className={`sym-tile${form.symbol === s.id ? ' active' : ''}`} title={`${s.ref} ${s.label}`} onClick={() => setForm((f) => ({ ...f, symbol: s.id }))}>
                  <Svg svg={s.svg} /><span className="small">{s.ref}</span><span className="small">{s.label}</span>
                </button>
              ))}
            </div>
            {PROTECTIVE.includes(form.symbol) && (
              <div className="pair">
                <label style={{ flex: 0.4 }}>{t('Poles')}<input type="number" min="1" max="4" step="1" value={form.poles} onChange={(e) => setForm((f) => ({ ...f, poles: e.target.value }))} /></label>
                <label>{t('Rating')}<input value={form.rating} onChange={(e) => setForm((f) => ({ ...f, rating: e.target.value }))} placeholder={t('e.g. B10, 40 A')} /></label>
              </div>
            )}
            <button className="btn btn-primary btn-sm" onClick={applySymbol}>{t('Apply symbol')}</button>
          </div>
        )],
        PROTECTIVE.includes(d.symbol) && [t('Poles'), String(d.poles ?? 1)],
        PROTECTIVE.includes(d.symbol) && [t('Rating'), d.rating],
        [t('Height (U)'), String(d.heightU ?? '')],
        [t('Size (mm)'), d.sizeMm ? ['w', 'h', 'd'].filter((k) => d.sizeMm[k]).map((k) => `${k} ${d.sizeMm[k]}`).join(' × ') : ''],
        [t('Hardware catalog item'), d.hardwareId ? hardware.find((h) => h.id === d.hardwareId)?.name || d.hardwareId : ''],
        [t('Ports'), d.ports.length ? <ul className="lib-ports">{d.ports.map((p) => <li key={p.id}><strong>{p.label}</strong> <span className="muted">· {lib.connectors.find((c) => c.id === p.connector)?.label || p.connector} · {p.direction} · {p.side}</span></li>)}</ul> : ''],
        [t('Notes'), d.notes],
        [t('Pictures'), pics.length ? <div className="lib-pics">{pics.map(([side, ext]) => <figure key={side}><img src={devicePanelUrl(d.id, side, ext)} alt={side} /><figcaption className="small muted">{panelName(side)}</figcaption></figure>)}</div> : ''],
      ]} />
    </div>
  );
}

function SymbolProps({ s, onPick }) {
  if (!s) return null;
  return (
    <div>
      <div className="lib-props-head"><h3>{s.label}</h3></div>
      <div className="sym-stage"><Svg svg={s.svg} big /></div>
      <Props rows={[
        [t('Reference'), s.ref],
        [t('Standard'), s.standard],
        [t('Kind'), t(KIND_LABELS[s.kind] || s.kind)],
        [t('Symbol id'), <code>{s.id}</code>],
        [t('Description'), s.detail],
        [t('Parameters'), s.params.length ? s.params.map((p) => t(p === 'poles' ? 'Poles' : 'Rating')).join(', ') : ''],
        s.aliases?.length ? [t('Also drawn for'), s.aliases.join(', ')] : null,
        [t('Used by'), s.usedBy.length ? <ul className="lib-ports">{s.usedBy.map((u) => <li key={`${u.kind}:${u.id}`}><button className="btn-link" onClick={() => onPick({ kind: u.kind, id: u.id })}>{u.name}</button> <span className="muted small">· {u.kind}</span></li>)}</ul> : <span className="muted">{t('Nothing in the library yet')}</span>],
      ]} />
      <p className="hint">{t('A symbol is drawn by the console itself, the same code that draws it on a schematic — there is no picture to replace. To use it, pick it on a part under Schematic symbol.')}</p>
    </div>
  );
}

function ConnectorProps({ c, lib, symbols, onPick }) {
  if (!c) return null;
  const sym = symbols.find((s) => s.id === (c.symbol || 'socket'));
  const joins = lib.cables.filter((k) => k.joins.some((j) => j.includes(c.id)));
  return (
    <div>
      <div className="lib-props-head"><h3>{c.label}</h3></div>
      <Props rows={[
        [t('Connector id'), <code>{c.id}</code>],
        [t('Colour on the drawing'), <span><span className="swatch" style={{ background: c.color }} /> {c.color}</span>],
        [t('Contact symbol'), sym ? <span className="sym-row"><Svg svg={sym.svg} /><button className="btn-link" onClick={() => onPick({ kind: 'symbol', id: sym.id })}>{sym.ref} · {sym.label}</button></span> : c.symbol],
        [t('Cable kinds that join it'), joins.length ? joins.map((k) => <button key={k.id} className="btn-link" onClick={() => onPick({ kind: 'cable', id: k.id })}>{k.label}</button>).reduce((a, b) => [a, ', ', b]) : ''],
        [t('Ports using it'), String(lib.devices.reduce((n, d) => n + d.ports.filter((p) => p.connector === c.id).length, 0))],
      ]} />
      <p className="hint">{t('Connectors and cable kinds are edited under Connector rules… below.')}</p>
    </div>
  );
}

function CableProps({ c, lib, symbols, onPick }) {
  if (!c) return null;
  const cores = symbols.find((s) => s.id === 'cores');
  const screen = symbols.find((s) => s.id === 'screen');
  return (
    <div>
      <div className="lib-props-head"><h3>{c.label}</h3></div>
      <Props rows={[
        [t('Cable kind id'), <code>{c.id}</code>],
        [t('Joins'), c.joins.map((j) => j.map((id) => lib.connectors.find((x) => x.id === id)?.label || id).join(' ↔ ')).join(', ')],
        [t('Line style'), <span><span className="swatch" style={{ background: c.style?.color }} /> {c.style?.color} · {c.style?.width} px{c.style?.dash ? ` · ${t('dash')} ${c.style.dash}` : ''}</span>],
        [t('Conductors'), c.cores ? <span className="sym-row"><Svg svg={cores?.svg} />{c.cores}</span> : ''],
        [t('Screened'), c.screened ? <span className="sym-row"><Svg svg={screen?.svg} />{t('yes')}</span> : t('no')],
      ]} />
    </div>
  );
}
