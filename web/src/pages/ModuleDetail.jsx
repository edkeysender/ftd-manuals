import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, CATEGORIES, MANUAL_TYPES, manualType, timeAgo, readFileAsBase64 } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast, useAuth } from '../App.jsx';
import HardwarePicker, { HardwareForm, hwDetail } from '../components/HardwarePicker.jsx';
import { ManualPills } from './ModulesList.jsx';
import { t, plural } from '../i18n.jsx';

const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || [null, c])[1];
const isOpenDoc = (d) => d.status === 'draft' || d.status === 'in-review';
/** "Technician A1.0" — how a doc of one manual type is named in buttons and hints. */
const docLabel = (d) => `${t(manualType(d.manual).short)} ${d.version}`;

export default function ModuleDetail() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [params] = useSearchParams(); // ?tab=assets — the drop link MCP agents hand to users
  const [tab, setTab] = useState(['docs', 'hardware', 'assets', 'history', 'software'].includes(params.get('tab')) ? params.get('tab') : 'docs');
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(
    () =>
      api
        .module(slug)
        .then(setData)
        .catch((e) => toast(e.message, 'err')),
    [slug]
  );
  useEffect(() => {
    load();
  }, [load]);

  if (!data) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;

  const { module, docs, history } = data;
  const hasSoftware = (module.softwares || []).length > 0;

  async function act(fn, okMsg) {
    try {
      await fn();
      if (okMsg) toast(okMsg);
      await load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/">{t('Modules')}</Link> / {module.name}
      </div>
      <div className="page-head">
        <div>
          <h1>
            {module.name}{' '}
            {data.needsDoc && (
              <span className="orange-dot" title={t('Manual-affecting software release with no doc linked yet')} />
            )}
          </h1>
          <div className="meta-chips">
            {module.code && <code>{module.code}</code>}
            <span className="chip">{t(catLabel(module.category))}</span>
            <span className="chip">{t(module.group)}</span>
            {(module.hardwareItems || []).map((h) => (
              <span key={h.id || h.name} className="chip chip-hw" title={hwDetail(h)}>
                {h.name}
              </span>
            ))}
            <StatusBadge status={data.status} />
          </div>
          <div className="meta-chips" style={{ marginTop: 8 }}>
            <ManualPills manuals={data.manuals} />
          </div>
        </div>
        <div className="btn-row">
          <button
            className="btn btn-sm btn-danger"
            title={t('Delete the module with all its doc versions, drafts and assets')}
            onClick={async () => {
              const open = data.docs.filter((d) => d.status === 'draft' || d.status === 'in-review');
              const msg =
                t('Delete module "{name}"? Its {docs} doc versions ({open} open drafts) and assets are deleted and it is removed from every assembled manual. This cannot be undone.', {
                  name: module.name,
                  docs: data.docs.length,
                  open: open.length,
                });
              if (!confirm(msg)) return;
              try {
                await api.deleteModule(slug);
                toast(t('Module {name} deleted', { name: module.name }));
                navigate('/');
              } catch (e) {
                toast(e.message, 'err');
              }
            }}
          >
            {t('Delete module')}
          </button>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>
          {t('Manuals')}{docs.length ? ` (${Object.keys(data.manuals || {}).length})` : ''}
        </button>
        <button className={tab === 'hardware' ? 'active' : ''} onClick={() => setTab('hardware')}>
          {t('Parts')}{module.hardwareItems?.length ? ` (${module.hardwareItems.length})` : ''}
        </button>
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
          {t('Assets')}
          {data.staleAssets > 0 && (
            <>
              {' '}
              <span className="orange-dot" title={t('{images} may show an older software/hardware version', { images: plural(data.staleAssets, 'image') })} />
            </>
          )}
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          {t('History')}
        </button>
        {hasSoftware && (
          <button className={tab === 'software' ? 'active' : ''} onClick={() => setTab('software')}>
            {t('Software versions')}
          </button>
        )}
      </div>

      {tab === 'docs' && <ManualsTab data={data} slug={slug} act={act} reload={load} />}

      {tab === 'history' && (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Date')}</th>
              <th>{t('Change')}</th>
              <th>{t('Ref')}</th>
              <th>{t('Commit')}</th>
            </tr>
          </thead>
          <tbody>
            {history.map((c) => (
              <tr key={c.hash}>
                <td className="muted">{timeAgo(c.date)}</td>
                <td>{c.subject}</td>
                <td className="muted">{c.ref}</td>
                <td><code>{c.hash.slice(0, 8)}</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'assets' && <AssetsTab slug={slug} docs={docs} module={module} onChanged={load} />}

      {tab === 'hardware' && <HardwareTab module={module} slug={slug} reload={load} />}

      {tab === 'software' && (
        <SoftwareTab data={data} slug={slug} reload={load} />
      )}
    </div>
  );
}

const MANUAL_FILTER_KEY = 'ftd-manuals-filter';
/** Filters over the manual cards: by what the manual documents (hardware / software) or for whom (customer / technician). */
const MANUAL_FILTERS = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'hardware', label: 'Hardware', match: (mt) => mt.kind === 'hardware' },
  { id: 'software', label: 'Software', match: (mt) => mt.kind === 'software' },
  { id: 'customer', label: 'Customer', match: (mt) => mt.audience === 'customer' },
  { id: 'technician', label: 'Technician', match: (mt) => mt.audience === 'technician' },
];

/** The row's "···" overflow: secondary actions (review, back to draft, FAT, discard). */
function ActionMenu({ items }) {
  // The menu is fixed-positioned from the button's rect (the table clips overflow for its rounded
  // corners, so an absolute menu on the last row would be cut off); it flips upward near the bottom.
  const [pos, setPos] = useState(null);
  const open = !!pos;
  const ref = useRef(null);
  const btnRef = useRef(null);
  const place = () => {
    const r = btnRef.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom;
    const up = below < 220 && r.top > below;
    setPos(up ? { right: window.innerWidth - r.right, top: 'auto', bottom: window.innerHeight - r.top + 6 } : { right: window.innerWidth - r.right, top: r.bottom + 6 });
  };
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setPos(null); };
    const esc = (e) => { if (e.key === 'Escape') setPos(null); };
    const away = () => setPos(null);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);
  return (
    <div className="create-manual action-menu-wrap" ref={ref}>
      <button ref={btnRef} className="btn btn-sm" title={t('More actions')} aria-haspopup="menu" aria-expanded={open} onClick={() => (open ? setPos(null) : place())}>···</button>
      {open && (
        <div className="create-manual-menu action-menu" role="menu" style={{ position: 'fixed', ...pos }}>
          {items.map((it) => it.href ? (
            <a key={it.label} className="cm-item" role="menuitem" href={it.href} target="_blank" rel="noreferrer" title={it.hint || ''} onClick={() => setOpen(false)}>
              <span className="cm-text"><strong>{it.label}</strong>{it.hint && <span className="muted small">{it.hint}</span>}</span>
            </a>
          ) : (
            <button key={it.label} className={`cm-item ${it.danger ? 'danger' : ''}`} role="menuitem" title={it.hint || ''} onClick={() => { setOpen(false); it.onClick(); }}>
              <span className="cm-text">
                <strong>{it.label}{it.count > 0 && <span className="count-pill" style={{ marginLeft: 6 }}>{it.count}</span>}</strong>
                {it.hint && <span className="muted small">{it.hint}</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one "+ Create manual" button: a menu over the four manual types. Types the module already
 * has (or software types while no software is linked) are listed but disabled, with the reason.
 */
function CreateManualMenu({ docs, hasSoftware, onPick }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const allTaken = MANUAL_TYPES.every((mt) => docs.some((d) => d.manual === mt.id));
  return (
    <div className="create-manual" ref={ref}>
      <button className="btn btn-primary" disabled={allTaken} title={allTaken ? t('Every manual type already exists — use New version on its card') : ''} onClick={() => setOpen((o) => !o)}>
        {t('+ Create manual')} <span className="caret">▾</span>
      </button>
      {open && (
        <div className="create-manual-menu" role="menu">
          <div className="cm-title">{t('Choose manual type')}</div>
          {MANUAL_TYPES.map((mt) => {
            const existing = docs.find((d) => d.manual === mt.id);
            const noSoftware = mt.kind === 'software' && !hasSoftware;
            const disabled = !!existing || noSoftware;
            const why = existing
              ? t('Already created — {version} r{rev}', { version: existing.version, rev: existing.revision || 1 })
              : noSoftware
                ? t('Link the module to a software first (Software versions tab)')
                : mt.sections.map((s) => t(s)).join(' · ');
            return (
              <button key={mt.id} className="cm-item" role="menuitem" disabled={disabled} onClick={() => { setOpen(false); onPick(mt.id); }}>
                <span className={`manual-kind ${mt.kind}`}>{mt.kind === 'software' ? 'SW' : 'HW'}</span>
                <span className="cm-text">
                  <strong>{t(mt.label)}</strong>
                  <span className="muted small">{why}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * One flat table: a group row per manual type the module has (customer / technician /
 * software-customer / software-technician), under it the working draft and the last release with
 * the draft → review → release actions (secondary ones behind "···"), older versions folded away.
 * "New version" sits on the group row when no draft of that type is open; the types the module
 * does not have yet come from the single "+ Create manual" menu above the table.
 */
function ManualsTab({ data, slug, act, reload }) {
  const { module, docs, uncovered } = data;
  const [adding, setAdding] = useState(null); // manual type id being created
  const navigate = useNavigate();
  const toast = useToast();
  const { isAdmin } = useAuth();
  const hasSoftware = (module.softwares || []).length > 0;
  // Which manual cards to show — remembered in this browser (the strip scrolls sideways, so narrowing it helps).
  const [filter, setFilter] = useState(() => {
    try { return localStorage.getItem(MANUAL_FILTER_KEY) || 'all'; } catch { return 'all'; }
  });
  const pickFilter = (id) => {
    setFilter(id);
    try { localStorage.setItem(MANUAL_FILTER_KEY, id); } catch { /* private mode */ }
  };
  const shownTypes = MANUAL_TYPES.filter((mt) => {
    const f = MANUAL_FILTERS.find((x) => x.id === filter) || MANUAL_FILTERS[0];
    return f.match(mt);
  });

  const [collapsed, setCollapsed] = useState({}); // manual type id → group folded
  const [older, setOlder] = useState({}); // manual type id → older versions shown
  const toggle = (setter, id) => setter((m) => ({ ...m, [id]: !m[id] }));

  const rowActions = (d, mt) => {
    const go = (view) => navigate(`/modules/${slug}/docs/${d.key}/${view}`);
    const primary = [];
    const more = [];
    if (isOpenDoc(d)) {
      if (d.status === 'draft') {
        primary.push(<button key="edit" className="btn btn-primary btn-sm" onClick={() => go('edit')}>{t('Edit')}</button>);
        primary.push(
          <button key="submit" className="btn btn-sm" onClick={() => act(() => api.submitReview(slug, d.key), t('{doc} submitted for review', { doc: docLabel(d) }))}>
            {t('Submit')}
          </button>
        );
        more.push({ label: t('Review'), hint: t('Read-only view where reviewers select text and comment'), count: d.openComments, onClick: () => go('review') });
      } else {
        primary.push(
          <button key="review" className="btn btn-primary btn-sm" title={t('Read-only view where reviewers select text and comment')} onClick={() => go('review')}>
            {t('Review')}
            {d.openComments > 0 && <span className="count-pill" style={{ marginLeft: 6 }}>{d.openComments}</span>}
          </button>
        );
        primary.push(
          <button key="release" className="btn btn-sm" onClick={() => act(() => api.release(slug, d.key), t('{doc} released — merged to main', { doc: docLabel(d) }))}>
            {t('Approve & release')}
          </button>
        );
        more.push({ label: t('Edit'), onClick: () => go('edit') });
        more.push({ label: t('Back to draft'), onClick: () => act(() => api.backToDraft(slug, d.key), t('{doc} back to draft', { doc: docLabel(d) })) });
      }
      if (d.fat) more.push({ label: t('FAT'), hint: t('Blank FAT protocol for this doc version'), href: `/api/modules/${slug}/docs/${d.key}/checklist.html` });
      if (isAdmin) {
        more.push({
          label: t('Discard'),
          danger: true,
          onClick: () => {
            if (confirm(t('Discard {manual} draft {version}? The branch {branch} will be deleted.', { manual: t(mt.label).toLowerCase(), version: d.version, branch: d.branch }))) {
              act(() => api.discard(slug, d.key), t('{doc} discarded', { doc: docLabel(d) })).then(() => {
                // module may be gone entirely if nothing of it was ever released
                api.module(slug).catch(() => navigate('/'));
              });
            }
          },
        });
      }
    } else {
      primary.push(<button key="view" className="btn btn-primary btn-sm" onClick={() => go('edit')}>{t('View')}</button>);
      if (d.fat) {
        primary.push(
          <a key="fat" className="btn btn-sm" href={`/api/modules/${slug}/docs/${d.key}/checklist.html`} target="_blank" rel="noreferrer" title={t('Blank FAT protocol for this doc version')}>
            {t('FAT')}
          </a>
        );
      }
    }
    return (
      <div className="btn-row row-actions">
        {primary}
        {more.length > 0 && <ActionMenu items={more} />}
      </div>
    );
  };

  const versionRow = (d, mt, label) => (
    <tr key={d.key} className="version-row">
      <td className="muted row-label" title={d.branch || 'main'}>{label}</td>
      <td><strong>{d.version}</strong></td>
      <td className="muted">r{d.revision}</td>
      <td><StatusBadge status={d.status} /></td>
      <td className="muted">{timeAgo(d.updatedAt)}</td>
      <td className="actions-cell">{rowActions(d, mt)}</td>
    </tr>
  );

  const created = MANUAL_TYPES.filter((mt) => docs.some((d) => d.manual === mt.id));
  const shownGroups = shownTypes.filter((mt) => docs.some((d) => d.manual === mt.id));

  return (
    <>
      <div className="manuals-head">
        <h2>
          {t('Manuals')} <span className="muted small">{t('{n} of {total} types created', { n: created.length, total: MANUAL_TYPES.length })}</span>
        </h2>
        <CreateManualMenu docs={docs} hasSoftware={hasSoftware} onPick={setAdding} />
      </div>
      <div className="manual-filter">
        <div className="mode-toggle" role="tablist" title={t('Which manuals to show — remembered in this browser')}>
          {MANUAL_FILTERS.map((f) => {
            const n = created.filter(f.match).length;
            return (
              <button key={f.id} className={f.id === filter ? 'active' : ''} onClick={() => pickFilter(f.id)}>
                {t(f.label)}{n > 0 && <span className="mf-count">{n}</span>}
              </button>
            );
          })}
        </div>
        <span className="muted small mf-hint">{t('{shown} of {have} manuals shown', { shown: shownGroups.length, have: created.length })}</span>
      </div>
      <table className="table manuals-table">
        <thead>
          <tr>
            <th className="col-manual">{t('Manual')}</th>
            <th>{t('Version')}</th>
            <th>{t('Rev')}</th>
            <th>{t('Status')}</th>
            <th>{t('Updated')}</th>
            <th className="actions-cell">{t('Actions')}</th>
          </tr>
        </thead>
        <tbody>
          {shownGroups.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                {created.length === 0 ? t('No manual yet — use "+ Create manual" above.') : t('No manuals of this kind yet.')}
              </td>
            </tr>
          )}
          {shownGroups.map((mt) => {
            const typed = docs.filter((d) => d.manual === mt.id);
            const open = typed.find(isOpenDoc);
            const release = typed.find((d) => d.status === 'released');
            const rest = typed.filter((d) => d !== open && d !== release);
            const unc = (uncovered || []).filter((u) => u.manual === mt.id);
            const folded = !!collapsed[mt.id];
            const showOlder = !!older[mt.id];
            return (
              <React.Fragment key={mt.id}>
                <tr className="group-row">
                  <td colSpan={5}>
                    <div className="group-cell">
                      <button className={`chev ${folded ? '' : 'open'}`} onClick={() => toggle(setCollapsed, mt.id)} title={folded ? t('Expand') : t('Collapse')} aria-expanded={!folded}>▸</button>
                      <span className={`manual-kind ${mt.kind}`}>{mt.kind === 'software' ? 'SW' : 'HW'}</span>
                      <strong>{t(mt.label)}</strong>
                      <span className="muted small">{typed.length === 1 ? t('1 version') : t('{n} versions', { n: typed.length })}</span>
                      {!open && unc.length > 0 && (
                        <span className="hint">{t('The new version becomes the manual for {releases}', { releases: unc.map((u) => `${u.name} ${u.version}`).join(', ') })}</span>
                      )}
                    </div>
                  </td>
                  <td className="actions-cell">
                    {!open && (
                      <div className="btn-row row-actions">
                        <button
                          className="btn btn-sm"
                          title={t('Next minor version of the {manual}, based on {version}', { manual: t(mt.label).toLowerCase(), version: typed[0].version })}
                          onClick={() => act(() => api.nextDocVersion(slug, { manual: mt.id, bump: 'minor' }), t('New {manual} draft (minor) created', { manual: t(mt.label).toLowerCase() }))}
                        >
                          {t('New version (minor)')}
                        </button>
                        <button
                          className="btn btn-sm"
                          title={t('Next major version of the {manual}', { manual: t(mt.label).toLowerCase() })}
                          onClick={() => act(() => api.nextDocVersion(slug, { manual: mt.id, bump: 'major' }), t('New {manual} draft (major) created', { manual: t(mt.label).toLowerCase() }))}
                        >
                          {t('major')}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                {!folded && open && versionRow(open, mt, t('Working draft'))}
                {!folded && release && versionRow(release, mt, t('Last release'))}
                {!folded && showOlder && rest.map((d) => versionRow(d, mt, t('Older')))}
                {!folded && rest.length > 0 && (
                  <tr className="older-row">
                    <td colSpan={6}>
                      <button className="link-btn" onClick={() => toggle(setOlder, mt.id)}>
                        {showOlder
                          ? t('Hide older versions')
                          : rest.length === 1 ? t('Show 1 older version') : t('Show {n} older versions', { n: rest.length })}
                      </button>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      {adding && (
        <AddManualModal
          slug={slug}
          module={module}
          manual={adding}
          onClose={() => setAdding(null)}
          onCreated={(r) => {
            setAdding(null);
            toast(t('{manual} {version} r1 created on {branch}', { manual: t(manualType(r.manual).label), version: r.version, branch: r.branch }));
            if (r.aiNote) toast(r.aiNote, 'err');
            reload();
            navigate(`/modules/${slug}/docs/${r.key}/edit`);
          }}
        />
      )}
    </>
  );
}

/** Start a manual type the module does not have yet: blank template, copy of another module's
 *  released manual of the same type, or an AI first draft — plus the FAT checklist choice. */
function AddManualModal({ slug, module, manual, onClose, onCreated }) {
  const toast = useToast();
  const mt = manualType(manual);
  const [mode, setMode] = useState('blank');
  const [sources, setSources] = useState([]);
  const [source, setSource] = useState('');
  const [fat, setFat] = useState(mt.kind === 'software' ? 'none' : 'template');
  const [busy, setBusy] = useState(false);
  const manualName = t(mt.label).toLowerCase();

  useEffect(() => {
    api
      .modules()
      .then((rows) => setSources(rows.filter((m) => m.slug !== slug && m.manuals?.[manual]?.released)))
      .catch(() => setSources([]));
  }, [slug, manual]);

  async function create() {
    setBusy(true);
    try {
      const r = await api.nextDocVersion(slug, {
        manual,
        start: mode === 'copy' ? { mode: 'copy', sourceSlug: source } : { mode },
        checklist: { mode: fat },
      });
      onCreated(r);
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>
            {t(mt.label)} — {module.name}
          </h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <p className="muted small">
            {t(mt.desc)} {t('Sections 4–7: {sections}. Starts as A1.0 r1 on its own draft branch; sections 1–3 are generated.', { sections: mt.sections.map((s) => t(s)).join(', ') })}
          </p>
          <div className="choice-cards">
            {[
              ['blank', t('Blank — FTD standard template'), (module.hardwareItems || []).length > 1 && mt.kind !== 'software' ? t('The {manual} template with TODO(author) markers, one subsection per hardware unit.', { manual: manualName }) : t('The {manual} template with TODO(author) markers.', { manual: manualName })],
              ['copy', t('Copy another module’s released manual'), t('Content and revision record of a released {manual} of another module.', { manual: manualName })],
              ['ai', t('AI first draft'), t('The assistant drafts the structure from the module metadata; you review it in the editor.')],
            ].map(([k, title, desc]) => (
              <button key={k} type="button" className={`choice-card ${mode === k ? 'selected' : ''}`} onClick={() => setMode(k)}>
                <strong>{title}</strong>
                <span>{desc}</span>
              </button>
            ))}
            {mode === 'copy' && (
              <label className="full">
                {t('Source module (released {manual} only)', { manual: manualName })}
                <select value={source} onChange={(e) => setSource(e.target.value)}>
                  <option value="">{t('— pick a module —')}</option>
                  {sources.map((m) => (
                    <option key={m.slug} value={m.slug}>
                      {m.name} · {m.manuals[manual].released}
                    </option>
                  ))}
                </select>
                {sources.length === 0 && <span className="hint">{t('No module has a released {manual} yet.', { manual: manualName })}</span>}
              </label>
            )}
          </div>
          <div className="field" style={{ marginTop: 14 }}>
            <span className="field-label">{t('FAT checklist')}</span>
            <div className="choice-row">
              <button type="button" className={`choice ${fat === 'template' ? 'selected' : ''}`} onClick={() => setFat('template')}>
                {t('From the category template')}
              </button>
              <button type="button" className={`choice ${fat === 'none' ? 'selected' : ''}`} onClick={() => setFat('none')}>
                {t('None')}
              </button>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={busy || (mode === 'copy' && !source)} onClick={create}>
            {busy ? (mode === 'ai' ? t('Drafting with AI…') : t('Creating…')) : t('Create {manual} A1.0', { manual: manualName })}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inbox: files dropped here land in a folder on the console machine (data/inbox)
 * and can be attached to the draft by name — from here or by the assistant
 * over MCP (list_inbox + import_local_files), without any bytes passing
 * through the model.
 */
function InboxPanel({ slug, draft, onImported }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [open, setOpen] = useState(true);
  const load = () => api.inbox().then(setInfo).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  async function drop(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    try {
      const saved = await api.uploadInbox(await Promise.all(files.map(readFileAsBase64)));
      toast(t('{files} in the inbox', { files: plural(saved.length, 'file') }));
      load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function importFiles(names) {
    if (!draft) return toast(t('Create a doc draft first'), 'err');
    setBusy(true);
    try {
      const saved = await api.importInbox(slug, draft.key, names);
      toast(t('{files} attached to {draft}', { files: plural(saved.length, 'file'), draft: draft.key }));
      load();
      onImported();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  const files = info?.files || [];
  const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  return (
    <div className="inbox">
      <div className="inbox-head">
        <button className="inbox-toggle" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} {t('Inbox')} <span className="muted">— {t('{files} waiting', { files: plural(files.length, 'file') })}</span>
        </button>
        <span className="muted small" title={info?.dir}>
          {t('Drop artwork — or Word, PowerPoint, PDF and zip files: the pictures inside are extracted (a Word file also leaves its text). Then attach them yourself or tell the assistant which figure goes where (it imports by name — no image bytes through the chat).')}
        </span>
      </div>
      {open && (
        <>
          <div
            className={`dropzone inbox-drop ${drag ? 'over' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDrag(true);
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDrag(false);
              drop(e.dataTransfer.files);
            }}
          >
            <strong>{busy ? t('Working…') : t('Drop files for the inbox')}</strong>
            <span className="muted">
              {t(' — or ')}
              <label className="link">
                {t('choose files')}
                <input type="file" multiple accept="image/*,.pdf,.svg,.docx,.pptx,.xlsx,.zip" hidden onChange={(e) => { drop(e.target.files); e.target.value = ''; }} />
              </label>
              {t('. Stored in')} <code>{info?.dir || '…'}</code> {t('on the console machine; not committed until attached.')}
            </span>
          </div>
          {files.length > 0 && (
            <div className="asset-grid inbox-grid">
              {files.map((f) => (
                <div className={`asset-card ${f.complete === false ? 'broken' : ''}`} key={f.name}>
                  {/\.(png|jpe?g|gif|webp|svg)$/i.test(f.name) ? (
                    <img src={`/api/inbox/${encodeURIComponent(f.name)}`} alt={f.name} loading="lazy" />
                  ) : (
                    <div className="asset-file">{f.name.split('.').pop().toUpperCase()}</div>
                  )}
                  <div className="asset-name" title={f.name}>{f.name}</div>
                  <div className="muted small">
                    {fmt(f.size)}{f.width ? ` · ${f.width}×${f.height}` : ''}{f.complete === false ? ` · ${t('truncated!')}` : ''}
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-sm btn-primary" disabled={!draft || busy || f.complete === false} onClick={() => importFiles([f.name])}>
                      {t('Attach to {draft}', { draft: draft ? draft.key : t('draft') })}
                    </button>
                    {isAdmin && <button
                      className="btn-icon"
                      title={t('Delete from inbox')}
                      onClick={async () => {
                        try {
                          await api.deleteInbox(f.name);
                          load();
                        } catch (e) {
                          toast(e.message, 'err');
                        }
                      }}
                    >
                      ✕
                    </button>}
                  </div>
                </div>
              ))}
              {draft && files.filter((f) => f.complete !== false).length > 1 && (
                <button className="btn attach-all" disabled={busy} onClick={() => importFiles(files.filter((f) => f.complete !== false).map((f) => f.name))}>
                  {t('Attach all to {draft}', { draft: draft.key })}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Which hardware units this module's manual describes: assign from the shared
 *  catalog, create new units, edit a unit's catalog record, unassign. Saved as a
 *  module-metadata commit (on the open draft branch when there is one). */
function HardwareTab({ module, slug, reload }) {
  const toast = useToast();
  const [catalog, setCatalog] = useState(null);
  const [value, setValue] = useState(() => (module.hardwareItems || []).map((h) => (h.id && !h.missing ? { id: h.id } : { ...h })));
  const [editing, setEditing] = useState(null); // catalog id being edited
  const [busy, setBusy] = useState(false);

  const loadCatalog = () => api.hardware().then(setCatalog).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    loadCatalog();
  }, []);

  const savedIds = (module.hardwareItems || []).map((h) => h.id).filter(Boolean);
  const dirty =
    value.some((v) => !v.id) ||
    value.length !== savedIds.length ||
    value.some((v, i) => v.id !== savedIds[i]);

  async function save() {
    setBusy(true);
    try {
      const updated = await api.updateModule(slug, { hardware: value });
      toast(t('Hardware saved — {units}', { units: updated.hardwareItems.length ? updated.hardwareItems.map((h) => h.name).join(', ') : t('none') }));
      await reload();
      await loadCatalog();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function saveItem(id, patch) {
    try {
      await api.updateHardware(id, patch);
      toast(t('Catalog item updated'));
      setEditing(null);
      await loadCatalog();
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  if (catalog === null) return <div className="muted">{t('Loading…')}</div>;
  const assigned = (module.hardwareItems || []).filter((h) => h.id && !h.missing);

  return (
    <div className="hw-tab">
      <div className="sw-register">
        <h3>{t('Units described by this manual')}</h3>
        <p className="muted small">
          {t('Each unit gets its own row in')} <em>{t('3 General information')}</em> {t('and in the FAT protocol header. When a manual covers several unit types (e.g. three camera models), describe each one in its own subsection of Installation and Operation.')}
        </p>
        <HardwarePicker catalog={catalog} value={value} onChange={setValue} />
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>
            {busy ? t('Saving…') : t('Save hardware assignment')}
          </button>
          {dirty && (
            <button
              className="btn btn-sm"
              onClick={() => setValue((module.hardwareItems || []).map((h) => (h.id && !h.missing ? { id: h.id } : { ...h })))}
            >
              {t('Reset')}
            </button>
          )}
        </div>
      </div>

      {assigned.length > 0 && (
        <div className="sw-block" style={{ marginTop: 20 }}>
          <h3>{t('Catalog records')}</h3>
          <p className="muted small">{t('Editing a record changes it for every module that uses it.')}</p>
          <table className="table">
            <thead>
              <tr>
                <th>{t('Unit')}</th>
                <th>{t('Relation')}</th>
                <th>{t('Notes')}</th>
                <th>{t('Also used by')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {assigned.map((h) => {
                const rec = catalog.find((c) => c.id === h.id) || h;
                const others = (rec.usedBy || []).filter((m) => m.slug !== slug);
                return editing === h.id ? (
                  <tr key={h.id}>
                    <td colSpan="5">
                      <HardwareForm initial={rec} submitLabel={t('Save record')} onSubmit={(p) => saveItem(h.id, p)} onCancel={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={h.id}>
                    <td><strong>{rec.name}</strong> <code className="muted">{rec.id}</code></td>
                    <td>{hwDetail(rec)}</td>
                    <td className="muted">{rec.notes || '—'}</td>
                    <td className="muted">{others.length ? others.map((m) => <Link key={m.slug} to={`/modules/${m.slug}`}>{m.name}</Link>).reduce((acc, x) => (acc.length ? [...acc, ', ', x] : [x]), []) : '—'}</td>
                    <td className="btn-row">
                      <button className="btn btn-sm" onClick={() => setEditing(h.id)}>{t('Edit record')}</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** "A1.0 · Starting Panel 2.0.1 · Camera v2" — what the picture showed when it was added. */
function stampLabel(meta, hwItems) {
  if (!meta) return null;
  const parts = [meta.verifiedIn || meta.addedIn];
  for (const s of meta.software || []) if (s.version) parts.push(`${s.name} ${s.version}`);
  const applies = meta.appliesTo?.length ? new Set(meta.appliesTo) : null;
  for (const h of meta.hardware || []) {
    if (applies && !applies.has(h.id)) continue;
    if (hwItems.length > 1 && !applies) continue; // "all units" — the versions are on the Hardware tab
    parts.push(`${h.name}${h.version ? ' ' + h.version : ''}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function AssetsTab({ slug, docs, module, onChanged }) {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [assets, setAssets] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [drawing, setDrawing] = useState(null); // asset name being converted
  const [stamping, setStamping] = useState(null); // asset name whose stamp is being saved
  // The assets folder is shared by every manual of the module; uploads are committed on one
  // open draft branch — the first one, or the one picked here when several manuals are open.
  const openDrafts = docs.filter(isOpenDoc);
  const [draftKey, setDraftKey] = useState(openDrafts[0]?.key || '');
  const draft = openDrafts.find((d) => d.key === draftKey) || openDrafts[0] || null;
  const hwItems = (module.hardwareItems || []).filter((h) => h.id && !h.missing);

  /** Save "applies to" / "verified" on the draft branch. */
  async function stamp(asset, body, okMsg) {
    if (!draft) return toast(t('Version stamps are edited on a draft — create a doc draft first'), 'err');
    setStamping(asset.name);
    try {
      await api.setAssetMeta(slug, draft.key, asset.name, body);
      toast(okMsg);
      load();
      onChanged?.();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setStamping(null);
    }
  }

  /** Redraw an existing photo in the FTD house style (same engine as the editor's drop target). */
  async function toLineArt(asset) {
    if (!draft) return toast(t('Create a doc draft first'), 'err');
    const instructions = window.prompt(t('Redraw {name} as Technical Aviation Manual Line-Art.\nOptional instructions (what to number, arrows, emphasis):', { name: asset.name }), '');
    if (instructions === null) return;
    setDrawing(asset.name);
    try {
      const r = await api.illustrate(slug, draft.key, { assetName: asset.name, instructions });
      toast(t("{name} added to {draft} — insert it from the editor's AI pane or with Copy <figure>", { name: r.illustration.name, draft: draft.key }));
      load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setDrawing(null);
    }
  }

  const load = () => api.listAssets(slug).then(setAssets).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, [slug]);

  async function upload(fileList) {
    if (!draft) return toast(t('Assets are added to a draft — create a doc draft first'), 'err');
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    try {
      const payload = await Promise.all(files.map(readFileAsBase64));
      const saved = await api.uploadAssets(slug, draft.key, payload);
      toast(t('{files} added to {draft}', { files: plural(saved.length, 'file'), draft: draft.key }));
      load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {openDrafts.length > 1 && (
        <div className="pair" style={{ marginBottom: 10, alignItems: 'center' }}>
          <span className="hint">{t('Commit uploads to draft')}</span>
          <select value={draft?.key || ''} onChange={(e) => setDraftKey(e.target.value)}>
            {openDrafts.map((d) => (
              <option key={d.key} value={d.key}>
                {docLabel(d)} ({t(d.status)})
              </option>
            ))}
          </select>
          <span className="hint">{t('— the assets folder itself is shared by all manuals of the module.')}</span>
        </div>
      )}
      <InboxPanel slug={slug} draft={draft} onImported={load} />
      <div
        className={`dropzone ${drag ? 'over' : ''} ${draft ? '' : 'disabled'}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          upload(e.dataTransfer.files);
        }}
      >
        <strong>{busy ? t('Uploading…') : t('Drop images, documents or files to attach here')}</strong>
        <span className="muted">
          {draft ? t(' — or ') : t(' — no open draft; ')}
          {draft && (
            <label className="link">
              {t('choose files')}
              <input type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
            </label>
          )}
          {draft ? t('. Files are committed to {branch}.', { branch: draft.branch }) : t('create a doc draft to add assets.')}
        </span>
      </div>

      {assets === null ? (
        <div className="muted">{t('Loading…')}</div>
      ) : assets.length === 0 ? (
        <div className="empty">{t('No assets yet.')}</div>
      ) : (
        <div className="asset-grid">
          {assets.map((a) => (
            <div className={`asset-card ${a.stale?.length ? 'stale' : ''}`} key={a.name}>
              {/\.(png|jpe?g|gif|webp|svg)$/i.test(a.name) ? (
                <img src={`${a.url}?w=360`} alt={a.name} loading="lazy" />
              ) : (
                <div className="asset-file">{a.name.split('.').pop().toUpperCase()}</div>
              )}
              <div className="asset-name" title={a.url}>
                {a.name}
              </div>
              <div className="asset-meta">
                {a.stale?.length > 0 && (
                  <span className="orange-dot" title={t('Newer than this picture: {list}', { list: a.stale.join(', ') })} />
                )}
                {a.meta ? (
                  <span
                    className="chip"
                    title={t('{stamp} — software/hardware versions current at that time', { stamp: a.meta.verifiedIn ? t('Verified in {version}', { version: a.meta.verifiedIn }) : t('Added in {version}', { version: a.meta.addedIn }) })}
                  >
                    {stampLabel(a.meta, hwItems)}
                  </span>
                ) : (
                  <span className="hint" title={t('Added before version stamps existed — Verify to stamp it with the current versions')}>
                    {t('no version stamp')}
                  </span>
                )}
              </div>
              {hwItems.length > 1 && (
                <label className="asset-applies">
                  <span className="hint">{t('Shows')}</span>
                  <select
                    value={a.meta?.appliesTo?.length === 1 ? a.meta.appliesTo[0] : ''}
                    disabled={!draft || stamping === a.name}
                    title={t("Which of the module's units this picture shows")}
                    onChange={(e) =>
                      stamp(
                        a,
                        { appliesTo: e.target.value ? [e.target.value] : [] },
                        e.target.value ? t('{name} applies to {unit}', { name: a.name, unit: hwItems.find((h) => h.id === e.target.value)?.name }) : t('{name} applies to all units', { name: a.name })
                      )
                    }
                  >
                    <option value="">{t('All units')}</option>
                    {hwItems.map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {draft && (a.stale?.length > 0 || !a.meta) && (
                <button
                  className="btn btn-sm btn-verify"
                  disabled={stamping === a.name}
                  title={
                    a.stale?.length
                      ? t('Confirm this picture is still correct for {list} (or upload a replacement) — re-stamps it as current', { list: a.stale.join(', ') })
                      : t('Stamp this file with the current software/hardware versions')
                  }
                  onClick={() => stamp(a, { verify: true }, t('{name} verified for current versions', { name: a.name }))}
                >
                  {stamping === a.name ? t('Saving…') : a.stale?.length ? t('Verified for {version}', { version: a.stale[0] }) : t('Stamp version')}
                </button>
              )}
              <div className="btn-row">
                {a.kind === 'attachment' ? (
                  <button
                    className="btn btn-sm"
                    title={t('A file the reader downloads from the manual — the link HTML goes into the HTML source view')}
                    onClick={() => {
                      navigator.clipboard?.writeText(`<p><a class="attachment" href="${a.url}" download="${a.name}">${a.name}</a></p>`);
                      toast(t('Attachment link copied — paste it in the HTML source view'));
                    }}
                  >
                    {t('Copy link')}
                  </button>
                ) : (
                  <button
                    className="btn btn-sm"
                    onClick={() => {
                      navigator.clipboard?.writeText(`<figure><img src="${a.url}" alt="${a.name}"><figcaption>TODO(author): caption</figcaption></figure>`);
                      toast(t('Figure HTML copied — paste it in the HTML source view'));
                    }}
                  >
                    {t('Copy <figure>')}
                  </button>
                )}
                {/.(png|jpe?g|webp|gif)$/i.test(a.name) && !/-lineart.png$/i.test(a.name) && (
                  <button
                    className="btn btn-sm"
                    disabled={!draft || drawing === a.name}
                    title={t('Redraw this photo in the FTD Technical Aviation Manual Line-Art style')}
                    onClick={() => toLineArt(a)}
                  >
                    {drawing === a.name ? t('Drawing…') : t('✎ Line-art')}
                  </button>
                )}
                {draft && isAdmin && (
                  <button
                    className="btn-icon"
                    title={t('Remove from {draft} (git rm on {branch})', { draft: draft.key, branch: draft.branch })}
                    onClick={async () => {
                      if (!confirm(t('Remove {name} from {draft}? Figures referencing it will break.', { name: a.name, draft: draft.key }))) return;
                      try {
                        await api.deleteAsset(slug, draft.key, a.name);
                        toast(t('{name} removed', { name: a.name }));
                        load();
                      } catch (e) {
                        toast(e.message, 'err');
                      }
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SoftwareTab({ data, slug, reload }) {
  const toast = useToast();
  const { module, docs, softwareFeed } = data;
  const [form, setForm] = useState({ name: module.softwares[0]?.name || '', version: '', manualAffecting: false, note: '' });
  // Every manual type the module maintains must cover a release on its own.
  const types = MANUAL_TYPES.filter((mt) => docs.some((d) => d.manual === mt.id));
  const releasedOf = (mt) => docs.find((d) => d.manual === mt.id && d.status === 'released');
  const openOf = (mt) => docs.find((d) => d.manual === mt.id && isOpenDoc(d));

  const coveredBy = (swName, version) =>
    docs.filter((d) => (d.covers || []).some((c) => c.name === swName && covered(version, c)));

  function covered(v, cov) {
    const nums = (x) => String(x || '').split(/[^\d]+/).filter(Boolean).map(Number);
    const cmp = (a, b) => {
      const na = nums(a), nb = nums(b);
      for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        const d = (na[i] || 0) - (nb[i] || 0);
        if (d !== 0) return d;
      }
      return 0;
    };
    return cmp(v, cov.from) >= 0 && cmp(v, cov.to || cov.from) <= 0;
  }

  function link(doc, swName, swVersion) {
    api
      .coverRelease(slug, doc.key, swName, swVersion)
      .then(() => { toast(t('{doc} now covers {software} {version}', { doc: docLabel(doc), software: swName, version: swVersion })); reload(); })
      .catch((e) => toast(e.message, 'err'));
  }

  async function register() {
    try {
      await api.registerRelease(form);
      toast(t('{name} {version} registered', { name: form.name, version: form.version }));
      setForm({ ...form, version: '', note: '', manualAffecting: false });
      reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  return (
    <div>
      {module.softwares.map((sw) => (
        <div className="sw-block" key={sw.name}>
          <h3>
            {sw.name} <span className="muted">{t('linked from {version}', { version: sw.fromVersion || '—' })}</span>
          </h3>
          {!softwareFeed[sw.name] && (
            <p className="hint warn">
              {t('"{name}" was never created on the Software page, so its manuals cannot relate to a software version.', { name: sw.name })}{' '}
              <Link to="/software">{t('Repair it on the Software page')}</Link>
            </p>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>{t('Release')}</th>
                <th>{t('Date')}</th>
                <th>{t('Manual-affecting')}</th>
                <th>{t('Covered by doc')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(softwareFeed[sw.name] || []).map((rel) => {
                const covering = coveredBy(sw.name, rel.version);
                const missingTypes = types.filter((mt) => !covering.some((d) => d.manual === mt.id));
                return (
                  <tr key={rel.version}>
                    <td><strong>{rel.version}</strong> {rel.note && <span className="muted">— {rel.note}</span>}</td>
                    <td className="muted">{timeAgo(rel.date)}</td>
                    <td>{rel.manualAffecting ? <span className="badge badge-in-review">{t('Yes')}</span> : t('No')}</td>
                    <td>
                      {covering.length ? (
                        <span className="manual-pills">
                          {covering.map((d) => (
                            <span key={d.key} className={`manual-pill mp-${d.status}`}>
                              <span className="mp-type">{t(manualType(d.manual).short)}</span>
                              <span className="mp-ver">{d.version}</span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="muted">{t('not linked')}</span>
                      )}
                    </td>
                    <td>
                      <div className="btn-col" style={{ alignItems: 'flex-start' }}>
                        {missingTypes.map((mt) => {
                          const rel0 = releasedOf(mt);
                          const open = openOf(mt);
                          return (
                            <span key={mt.id} className="btn-row">
                              {!rel.manualAffecting && rel0 && (
                                <button
                                  className="btn btn-sm"
                                  title={t("Extend the released {manual}'s covered range to this release", { manual: t(mt.label).toLowerCase() })}
                                  onClick={() => link(rel0, sw.name, rel.version)}
                                >
                                  {t('Link to {doc}', { doc: docLabel(rel0) })}
                                </button>
                              )}
                              {open && (
                                <button
                                  className="btn btn-sm"
                                  title={t('Make {doc} the {manual} for {software} {version}', { doc: docLabel(open), manual: t(mt.label).toLowerCase(), software: sw.name, version: rel.version })}
                                  onClick={() => link(open, sw.name, rel.version)}
                                >
                                  {t('Assign to {doc} ({status})', { doc: docLabel(open), status: t(open.status) })}
                                </button>
                              )}
                              {rel.manualAffecting && !open && <span className="hint">{t('needs a new {manual} version', { manual: t(mt.short) })}</span>}
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(softwareFeed[sw.name] || []).length === 0 && (
                <tr><td colSpan="5" className="muted">{t('No releases registered.')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}

      <div className="sw-register">
        <h3>{t('Register software release')}</h3>
        <div className="pair wrap">
          <select value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}>
            {module.softwares.filter((s) => softwareFeed[s.name]).map((s) => (
              <option key={s.name}>{s.name}</option>
            ))}
          </select>
          <input placeholder={t('Version (v2.0.2)')} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          <input placeholder={t('Note (optional)')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <label className="check">
            <input
              type="checkbox"
              checked={form.manualAffecting}
              onChange={(e) => setForm({ ...form, manualAffecting: e.target.checked })}
            />
            {t('manual-affecting')}
          </label>
          <button className="btn btn-primary btn-sm" disabled={!form.version} onClick={register}>
            {t('Register')}
          </button>
        </div>
      </div>
    </div>
  );
}
