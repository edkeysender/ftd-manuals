import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, MANUAL_TYPES, manualType, timeAgo, hardwareModules } from '../api.js';
import { useToast, useAuth } from '../App.jsx';
import { t, plural } from '../i18n.jsx';
import SoftwareTimeline from '../components/SoftwareTimeline.jsx';

const SW_TYPES = MANUAL_TYPES.filter((mt) => mt.kind === 'software');
const isOpenDoc = (d) => d.status === 'draft' || d.status === 'in-review';

/**
 * One software in full: the modules linked to it, their software customer / technician
 * manuals (create, edit, new version) and its releases with their coverage. The list page
 * is deliberately just names and latest versions — everything else lives here.
 */
export default function SoftwareDetail() {
  const { name: raw } = useParams();
  const name = decodeURIComponent(raw || '');
  const [rows, setRows] = useState(null);
  const toast = useToast();
  const navigate = useNavigate();

  // The overview endpoint carries every software; the sibling list is what the repair row
  // offers as merge targets, so it is wanted here anyway.
  const load = () =>
    api
      .software()
      .then((all) => {
        setRows(all);
        // Deleting or merging this software takes it out of the feed — go back to the list.
        if (!all.some((s) => s.name === name)) navigate('/software');
      })
      .catch((e) => toast(e.message, 'err'));

  useEffect(() => {
    load();
  }, [name]);

  if (rows === null) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;
  const sw = rows.find((s) => s.name === name);
  if (!sw) return <div className="page"><div className="empty">{t('Software "{name}" not found.', { name })}</div></div>;

  return (
    <div className="page">
      <div className="crumbs">
        <Link to="/software">{t('Software')}</Link> / {sw.name}
      </div>
      <SoftwareBlock sw={sw} all={rows} reload={load} />
    </div>
  );
}

function SoftwareBlock({ sw, all = [], reload }) {
  const toast = useToast();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
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

  /** Unlink the module from this software. Refused for a module whose only software this is while a
   *  software manual draft is open on it — that draft would have nothing to document. */
  function detach(mod) {
    if (
      !confirm(
        t('Detach {module} from {software}? Manuals already written keep their content and their covered releases.', {
          module: mod.name,
          software: sw.name,
        })
      )
    )
      return;
    act(
      `${mod.slug}:unlink`,
      () => api.linkSoftware(mod.slug, { name: sw.name, unlink: true }),
      t('{module} detached from {software}', { module: mod.name, software: sw.name })
    );
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

      {!sw.registered && <RepairRow sw={sw} all={all} reload={reload} />}
      {sw.registered && !sw.modules.some((m) => m.type === 'own-software') && <OwnManualRow sw={sw} />}
      {sw.registered && <LinkModuleRow sw={sw} reload={reload} />}

      {sw.modules.length === 0 ? (
        <p className="muted small">{t('No manual yet — write its own manual above (an application without hardware), or link a module whose manual covers it.')}</p>
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
                      {mod.code && <code>{mod.code}</code>}
                      {mod.type === 'own-software' && <span className="chip" title={t('The software documented on its own — no hardware module')}>{t('own manual')}</span>}
                      <button
                        className="btn btn-sm btn-danger row-detach"
                        disabled={busy === `${mod.slug}:unlink`}
                        title={t('Stop relating {module} to {software} — its manuals keep what they documented', { module: mod.name, software: sw.name })}
                        onClick={() => detach(mod)}
                      >
                        {t('Detach')}
                      </button>
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
        {sw.coverage && (sw.coverage.manuals.length > 0 || sw.coverage.releases.length > 0) && (
          <SoftwareTimeline
            sw={sw.coverage}
            head={false}
            busy={!!busy}
            onConfirm={(row, release) =>
              act(
                `${row.slug}:${row.manual}`,
                () => api.coverRelease(row.slug, row.key, sw.name, release),
                t('{doc} now covers {software} {version}', { doc: `${t(manualType(row.manual).short)} ${row.version}`, software: sw.name, version: release })
              )
            }
            onNewVersion={(row, release) =>
              act(
                `${row.slug}:${row.manual}`,
                () => api.nextDocVersion(row.slug, { manual: row.manual, bump: 'major', fromRelease: { name: sw.name, version: release } }),
                t('New {type} version started from {software} {version}', { type: t(manualType(row.manual).label).toLowerCase(), software: sw.name, version: release })
              ).then((r) => r && navigate(`/modules/${row.slug}/docs/${r.key}/edit`))
            }
            onDeleteRelease={
              isAdmin
                ? (rel) => {
                    if (!confirm(t('Delete release {version} of {software}? It disappears from every coverage view.', { version: rel.version, software: sw.name })))
                      return;
                    act('release', () => api.deleteRelease(sw.name, rel.version), t('{software} {version} deleted', { software: sw.name, version: rel.version }));
                  }
                : undefined
            }
          />
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

/** "Write its own manual" — the software documented on its own: an own-software module named
 *  after it with blank software customer + technician drafts, opened straight in the editor. */
/**
 * A name modules link that was never created as a software (data from before a manual had to relate
 * to a software version): create it with the version the links use, or merge it into a registered one.
 */
function RepairRow({ sw, all, reload }) {
  const toast = useToast();
  const registered = all.filter((r) => r.registered && r.name !== sw.name);
  const [into, setInto] = useState(registered[0]?.name || '');
  const [busy, setBusy] = useState(null);
  const version = sw.modules.map((m) => m.fromVersion).find(Boolean) || '';
  const modules = sw.modules.map((m) => m.name).join(', ');

  async function create() {
    setBusy('create');
    try {
      await api.createSoftware({ name: sw.name, version: version || undefined, ownManual: null });
      toast(version ? t('{name} created with first version {version}', { name: sw.name, version }) : t('{name} created', { name: sw.name }));
      reload();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  }

  async function merge() {
    if (!into) return;
    if (!confirm(t('Merge "{name}" into "{into}"?\n\nThe links of {modules} and the covered ranges of their docs are renamed. A from-version that is not a release of {into} is cleared.', { name: sw.name, into, modules }))) return;
    setBusy('merge');
    try {
      const r = await api.mergeSoftware(sw.name, into);
      toast(t('{name} merged into {into} — {modules} relinked', { name: sw.name, into, modules: plural(r.modules.length, 'module') }));
      reload();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="sw-row sw-repair">
      <p className="hint warn">
        {t('"{name}" was never created as a software — {modules} link it by name only, so their manuals cannot relate to a software version. Repair it:', { name: sw.name, modules })}
      </p>
      <div className="pair wrap">
        <button className="btn btn-sm btn-primary" disabled={busy !== null} onClick={create} title={t('Creates the software on this page; the version the modules link becomes its first release')}>
          {busy === 'create' ? t('Creating…') : version ? t('Create "{name}" with version {version}', { name: sw.name, version }) : t('Create "{name}"', { name: sw.name })}
        </button>
        {registered.length > 0 && (
          <>
            <span className="hint">{t('— or merge it into')}</span>
            <select value={into} onChange={(e) => setInto(e.target.value)}>
              {registered.map((r) => (
                <option key={r.name} value={r.name}>{r.name}</option>
              ))}
            </select>
            <button className="btn btn-sm" disabled={busy !== null || !into} onClick={merge} title={t('Renames every module link and doc coverage of this name to the chosen software')}>
              {busy === 'merge' ? t('Merging…') : t('Merge')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The software documented on its own. The module it creates is an ordinary module afterwards —
 *  its group, code and the rest are edited on the module page, so this asks for nothing. */
function OwnManualRow({ sw }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      const r = await api.createSoftwareManual(sw.name, { fromVersion: sw.releases[sw.releases.length - 1]?.version || '' });
      // A module written as this software’s own manual was already there, only unlinked: it is adopted, not rewritten.
      toast(
        r.adopted
          ? t('{name} linked to its existing manual', { name: sw.name })
          : t('Own manual of {name} created — opening the editor', { name: sw.name })
      );
      if (r.adopted) navigate(`/modules/${r.slug}`);
      else navigate(`/modules/${r.slug}/docs/${r.key}/edit`);
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }
  return (
    <div className="pair wrap" style={{ marginBottom: 6 }}>
      <span className="hint">{t('Own manual')}</span>
      <button
        className="btn btn-primary btn-sm"
        disabled={busy}
        title={t('Document {name} on its own, without a hardware module: software customer + technician manuals A1.0 in the same editor. A module already written as its own manual is linked back instead.', { name: sw.name })}
        onClick={create}
      >
        {busy ? t('Creating…') : t('Write its own manual')}
      </button>
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
    api.modules().then((all) => setModules(hardwareModules(all))).catch(() => setModules([]));
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
