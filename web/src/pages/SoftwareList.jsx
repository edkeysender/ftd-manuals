import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, MANUAL_TYPES, manualType, timeAgo } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';

const SW_TYPES = MANUAL_TYPES.filter((mt) => mt.kind === 'software');
const isOpenDoc = (d) => d.status === 'draft' || d.status === 'in-review';

/**
 * Software page: purely the software manuals — one block per software known from module
 * links or the release feed, with the modules linked to it, their software customer /
 * technician manuals (create, edit, new version) and the releases with their coverage.
 */
export default function SoftwareList() {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const toast = useToast();

  const load = () => api.software().then(setRows).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, []);

  const q = query.trim().toLowerCase();
  const visible = rows === null ? null : q ? rows.filter((r) => `${r.name} ${r.modules.map((m) => m.name).join(' ')}`.toLowerCase().includes(q)) : rows;
  const totalManuals = (rows || []).reduce((n, r) => n + r.manualCount, 0);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Software')}</h1>
          {rows && (
            <div className="muted small">
              {t('{software} software · {manuals} — a software gets its own customer and technician manual per module it is linked to.', { software: rows.length, manuals: plural(totalManuals, 'software manual') })}
            </div>
          )}
        </div>
        <div className="btn-row">
          <input
            type="search"
            className="search-input"
            placeholder={t('Search software or module…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label={t('Search software')}
          />
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            {t('+ New software')}
          </button>
        </div>
      </div>

      {creating && (
        <NewSoftwareModal
          onClose={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            toast(
              r.modules.length
                ? t('{name} created and linked to {modules}', { name: r.name, modules: r.modules.map((m) => m.name).join(', ') })
                : t('{name} created', { name: r.name })
            );
            load();
          }}
        />
      )}

      {rows === null ? (
        <div className="empty">{t('Loading…')}</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>{t('No software linked yet.')}</p>
          <p>
            {t('Link a module to a software (wizard step')} <em>{t('Relations')}</em>{t(", or the module's")} <em>{t('Software versions')}</em>{' '}
            {t('tab) — its software customer / technician manuals then appear here.')}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty"><p>{t('No software matches “{query}”.', { query: query.trim() })}</p></div>
      ) : (
        visible.map((sw) => <SoftwareBlock key={sw.name} sw={sw} reload={load} />)
      )}
    </div>
  );
}

function SoftwareBlock({ sw, reload }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(null); // "<slug>:<manual>"
  const [form, setForm] = useState({ version: '', manualAffecting: false, note: '' });

  async function act(key, fn, okMsg) {
    setBusy(key);
    try {
      const r = await fn();
      if (okMsg) toast(okMsg);
      await reload();
      return r;
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  }

  async function createManual(mod, mt) {
    const r = await act(`${mod.slug}:${mt.id}`, () => api.nextDocVersion(mod.slug, { manual: mt.id, start: { mode: 'blank' }, checklist: { mode: 'none' } }));
    if (r) {
      toast(t('{type} {version} r1 created for {module}', { type: t(mt.label), version: r.version, module: mod.name }));
      navigate(`/modules/${mod.slug}/docs/${r.key}/edit`);
    }
  }

  async function register() {
    if (!form.version.trim()) return;
    await act(`release`, () => api.registerRelease({ name: sw.name, version: form.version.trim(), manualAffecting: form.manualAffecting, note: form.note }), t('{name} {version} registered', { name: sw.name, version: form.version.trim() }));
    setForm({ version: '', manualAffecting: false, note: '' });
  }

  async function remove() {
    // Open software manual drafts on modules that have no other software get released by the delete.
    const toRelease = sw.modules.flatMap((m) => (m.softwareCount === 1 ? m.docs.filter(isOpenDoc).map((d) => `${m.name} ${d.key}`) : []));
    let msg = sw.modules.length
      ? t('Delete software "{name}"? It is unlinked from {modules} and its {releases} are removed from the feed. Existing manuals are kept.', {
          name: sw.name,
          modules: sw.modules.map((m) => m.name).join(', '),
          releases: plural(sw.releases.length, 'release'),
        })
      : t('Delete software "{name}" and its {releases}?', { name: sw.name, releases: plural(sw.releases.length, 'release') });
    if (toRelease.length) msg += '\n\n' + t('Open drafts released first: {drafts}', { drafts: toRelease.join(', ') });
    if (!confirm(msg)) return;
    const r = await act('delete', () => api.deleteSoftware(sw.name));
    if (r) toast(r.released.length ? t('{name} deleted · released {drafts}', { name: sw.name, drafts: r.released.join(', ') }) : t('{name} deleted', { name: sw.name }));
  }

  return (
    <div className="sw-block software-block">
      <div className="software-head">
        <h2>
          {sw.name}
          {sw.uncoveredCount > 0 && (
            <span className="orange-dot" title={t('{releases} not yet covered by a doc version', { releases: plural(sw.uncoveredCount, 'manual-affecting release') })} />
          )}
        </h2>
        <span className="meta-chips">
          <span className="chip">{plural(sw.modules.length, 'module')}</span>
          <span className="chip">{plural(sw.manualCount, 'software manual')}</span>
          <span className="chip">{plural(sw.releases.length, 'release')}</span>
        </span>
        <button
          className="btn btn-sm btn-danger"
          style={{ marginLeft: 'auto' }}
          disabled={busy === 'delete'}
          title={t('Unlink from every module and remove the software with its releases from the feed')}
          onClick={remove}
        >
          {busy === 'delete' ? t('Deleting…') : t('Delete')}
        </button>
      </div>

      <LinkModuleRow sw={sw} reload={reload} />

      {sw.modules.length === 0 ? (
        <p className="muted small">{t('Not linked to any module yet — link one above to enable its software manuals.')}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t('Module')}</th>
              <th>{t('Linked from')}</th>
              {SW_TYPES.map((mt) => (
                <th key={mt.id}>{t(mt.label)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sw.modules.map((mod) => (
              <tr key={mod.slug}>
                <td>
                  <div className="module-cell">
                    <Link to={`/modules/${mod.slug}`} className="module-name">{mod.name}</Link>
                    <span className="module-sub">
                      {mod.code && <code>{mod.code}</code>} <span className="chip">{mod.group}</span>
                    </span>
                  </div>
                </td>
                <td className="muted">{mod.fromVersion || '—'}</td>
                {SW_TYPES.map((mt) => {
                  const typed = mod.docs.filter((d) => d.manual === mt.id);
                  const open = typed.find(isOpenDoc);
                  const latest = typed[0];
                  const unc = mod.uncovered.filter((u) => u.manual === mt.id);
                  const k = `${mod.slug}:${mt.id}`;
                  if (!latest) {
                    return (
                      <td key={mt.id}>
                        <button className="btn btn-sm" disabled={busy === k} onClick={() => createManual(mod, mt)} title={t('Start {type} A1.0 for {module}', { type: t(mt.label).toLowerCase(), module: mod.name })}>
                          {busy === k ? t('Creating…') : t('+ Create')}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={mt.id}>
                      <div className="sw-manual-cell">
                        <span className="manual-pills">
                          {typed.map((d) => (
                            <span
                              key={d.key}
                              className={`manual-pill mp-${d.status} row-link`}
                              title={`${d.key} · r${d.revision} · ${d.status} · ${d.branch || 'main'}`}
                              onClick={() => navigate(`/modules/${mod.slug}/docs/${d.key}/edit`)}
                            >
                              <span className="mp-type">{d.version}</span>
                              <span className="mp-ver">{isOpenDoc(d) ? t('draft r{n}', { n: d.revision }) : t(d.status)}</span>
                            </span>
                          ))}
                        </span>
                        <span className="btn-row">
                          {open ? (
                            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/modules/${mod.slug}/docs/${open.key}/edit`)}>
                              {t('Edit {version}', { version: open.version })}
                            </button>
                          ) : (
                            <button
                              className="btn btn-sm"
                              disabled={busy === k}
                              title={
                                unc.length
                                  ? t('Next version of the {type}, based on {version} — becomes the manual for {releases}', { type: t(mt.label).toLowerCase(), version: latest.version, releases: unc.map((u) => u.version).join(', ') })
                                  : t('Next version of the {type}, based on {version}', { type: t(mt.label).toLowerCase(), version: latest.version })
                              }
                              onClick={() => act(k, () => api.nextDocVersion(mod.slug, { manual: mt.id, bump: 'minor' }), t('New {type} draft created for {module}', { type: t(mt.label).toLowerCase(), module: mod.name }))}
                            >
                              {busy === k ? t('Creating…') : t('New version')}
                            </button>
                          )}
                          {unc.length > 0 && (
                            <span className="orange-dot" title={t('Not yet covered: {releases}', { releases: unc.map((u) => u.version).join(', ') })} />
                          )}
                        </span>
                        <span className="muted small">{t('updated {ago}', { ago: timeAgo(latest.updatedAt) })}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="software-releases">
        <h3>{t('Releases')}</h3>
        {sw.releases.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>{t('Release')}</th>
                <th>{t('Date')}</th>
                <th>{t('Manual-affecting')}</th>
                <th>{t('Covered by')}</th>
              </tr>
            </thead>
            <tbody>
              {sw.releases.map((rel) => (
                <tr key={rel.version}>
                  <td><strong>{rel.version}</strong> {rel.note && <span className="muted">— {rel.note}</span>}</td>
                  <td className="muted">{timeAgo(rel.date)}</td>
                  <td>{rel.manualAffecting ? <span className="badge badge-in-review">{t('Yes')}</span> : t('No')}</td>
                  <td>
                    {rel.coveredBy.length ? (
                      <span className="manual-pills">
                        {rel.coveredBy.map((c) => (
                          <span key={`${c.slug}:${c.key}`} className={`manual-pill mp-${c.status}`} title={`${c.slug} · ${c.key} · ${c.status}`}>
                            <span className="mp-type">{sw.modules.find((m) => m.slug === c.slug)?.code || c.slug}</span>
                            <span className="mp-ver">{t(manualType(c.manual).short)} {c.version}</span>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">{t("not linked — assign on the module's Software versions tab")}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="pair wrap" style={{ marginTop: 8 }}>
          <input placeholder={t('Version (v2.0.2)')} value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          <input placeholder={t('Note (optional)')} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={form.manualAffecting} onChange={(e) => setForm({ ...form, manualAffecting: e.target.checked })} />
            {t('manual-affecting')}
          </label>
          <button className="btn btn-primary btn-sm" disabled={!form.version.trim() || busy === 'release'} onClick={register}>
            {t('Register release')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Link to module" — attach this software to a module that does not have it yet (with a from-version). */
function LinkModuleRow({ sw, reload }) {
  const toast = useToast();
  const [modules, setModules] = useState(null);
  const [slug, setSlug] = useState('');
  const [fromVersion, setFromVersion] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.modules().then(setModules).catch(() => setModules([]));
  }, [sw.modules.length]);
  const linked = new Set(sw.modules.map((m) => m.slug));
  const candidates = (modules || []).filter((m) => !linked.has(m.slug));
  async function link() {
    setBusy(true);
    try {
      const r = await api.linkSoftware(slug, { name: sw.name, fromVersion: fromVersion.trim() });
      toast(t('{name} linked to {module}', { name: sw.name, module: r.name }));
      setSlug('');
      setFromVersion('');
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="pair wrap" style={{ marginBottom: 10 }}>
      <span className="hint">{t('Link to module')}</span>
      <select value={slug} onChange={(e) => setSlug(e.target.value)}>
        <option value="">{t('— pick a module —')}</option>
        {candidates.map((m) => (
          <option key={m.slug} value={m.slug}>{m.name}{m.code ? ` (${m.code})` : ''}</option>
        ))}
      </select>
      <input placeholder={t('From version (v1.0.0)')} value={fromVersion} onChange={(e) => setFromVersion(e.target.value)} style={{ width: 170 }} />
      <button className="btn btn-sm" disabled={!slug || busy} onClick={link}>
        {busy ? t('Linking…') : t('Link')}
      </button>
    </div>
  );
}

/** Create a software: name, optional first version, optional module links. */
function NewSoftwareModal({ onClose, onCreated }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [manualAffecting, setManualAffecting] = useState(false);
  const [note, setNote] = useState('');
  const [modules, setModules] = useState([]);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.modules().then(setModules).catch(() => setModules([]));
  }, []);
  async function create() {
    setBusy(true);
    try {
      onCreated(
        await api.createSoftware({
          name: name.trim(),
          version: version.trim() || undefined,
          manualAffecting,
          note,
          modules: selected.map((slug) => ({ slug })),
        })
      );
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <h2>{t('New software')}</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <label>
              {t('Software name')} <span className="req">*</span>
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="2N Access Unit" />
            </label>
            <div className="pair">
              <label style={{ flex: 1 }}>
                {t('First version (optional)')}
                <input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="v1.0.0" />
              </label>
              <label style={{ flex: 2 }}>
                {t('Note')}
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('optional')} />
              </label>
            </div>
            {version.trim() && (
              <label className="check">
                <input type="checkbox" checked={manualAffecting} onChange={(e) => setManualAffecting(e.target.checked)} />
                {t('first version is manual-affecting')}
              </label>
            )}
            <div className="field">
              <span className="field-label">{t('Link to modules (optional) — enables their software manuals; from-version = first version')}</span>
              <div className="picker-list" style={{ maxHeight: 220, overflow: 'auto' }}>
                {modules.map((m) => (
                  <label key={m.slug} className={`picker-item ${selected.includes(m.slug) ? 'on' : ''}`}>
                    <input
                      type="checkbox"
                      checked={selected.includes(m.slug)}
                      onChange={() => setSelected(selected.includes(m.slug) ? selected.filter((s) => s !== m.slug) : [...selected, m.slug])}
                    />
                    <span className="picker-name">{m.name} {m.code && <code>{m.code}</code>}</span>
                    <span className="chip">{m.group}</span>
                  </label>
                ))}
                {modules.length === 0 && <div className="muted">{t('No modules yet.')}</div>}
              </div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={create}>
            {busy ? t('Creating…') : t('Create software')}
          </button>
        </div>
      </div>
    </div>
  );
}
