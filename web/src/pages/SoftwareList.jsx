import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, MANUAL_TYPES, manualType, timeAgo } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../App.jsx';

const SW_TYPES = MANUAL_TYPES.filter((t) => t.kind === 'software');
const isOpenDoc = (d) => d.status === 'draft' || d.status === 'in-review';

/**
 * Software page: purely the software manuals — one block per software known from module
 * links or the release feed, with the modules linked to it, their software customer /
 * technician manuals (create, edit, new version) and the releases with their coverage.
 */
export default function SoftwareList() {
  const [rows, setRows] = useState(null);
  const [query, setQuery] = useState('');
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
          <h1>Software</h1>
          {rows && (
            <div className="muted small">
              {rows.length} software · {totalManuals} software manual{totalManuals === 1 ? '' : 's'} — a software gets its own customer and technician manual per module it is linked to.
            </div>
          )}
        </div>
        <div className="btn-row">
          <input
            type="search"
            className="search-input"
            placeholder="Search software or module…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            aria-label="Search software"
          />
        </div>
      </div>

      {rows === null ? (
        <div className="empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="empty">
          <p>No software linked yet.</p>
          <p>
            Link a module to a software (wizard step <em>Relations</em>, or the module's <em>Software versions</em> tab) — its
            software customer / technician manuals then appear here.
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty"><p>No software matches “{query.trim()}”.</p></div>
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

  async function createManual(mod, t) {
    const r = await act(`${mod.slug}:${t.id}`, () => api.nextDocVersion(mod.slug, { manual: t.id, start: { mode: 'blank' }, checklist: { mode: 'none' } }));
    if (r) {
      toast(`${t.label} ${r.version} r1 created for ${mod.name}`);
      navigate(`/modules/${mod.slug}/docs/${r.key}/edit`);
    }
  }

  async function register() {
    if (!form.version.trim()) return;
    await act(`release`, () => api.registerRelease({ name: sw.name, version: form.version.trim(), manualAffecting: form.manualAffecting, note: form.note }), `${sw.name} ${form.version.trim()} registered`);
    setForm({ version: '', manualAffecting: false, note: '' });
  }

  return (
    <div className="sw-block software-block">
      <div className="software-head">
        <h2>
          {sw.name}
          {sw.uncoveredCount > 0 && (
            <span className="orange-dot" title={`${sw.uncoveredCount} manual-affecting release${sw.uncoveredCount === 1 ? '' : 's'} not yet covered by a doc version`} />
          )}
        </h2>
        <span className="meta-chips">
          <span className="chip">{sw.modules.length} module{sw.modules.length === 1 ? '' : 's'}</span>
          <span className="chip">{sw.manualCount} software manual{sw.manualCount === 1 ? '' : 's'}</span>
          <span className="chip">{sw.releases.length} release{sw.releases.length === 1 ? '' : 's'}</span>
        </span>
      </div>

      {sw.modules.length === 0 ? (
        <p className="muted small">Registered in the release feed but not linked to any module — link it from a module's <em>Software versions</em> tab.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Module</th>
              <th>Linked from</th>
              {SW_TYPES.map((t) => (
                <th key={t.id}>{t.label}</th>
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
                {SW_TYPES.map((t) => {
                  const typed = mod.docs.filter((d) => d.manual === t.id);
                  const open = typed.find(isOpenDoc);
                  const latest = typed[0];
                  const unc = mod.uncovered.filter((u) => u.manual === t.id);
                  const k = `${mod.slug}:${t.id}`;
                  if (!latest) {
                    return (
                      <td key={t.id}>
                        <button className="btn btn-sm" disabled={busy === k} onClick={() => createManual(mod, t)} title={`Start ${t.label.toLowerCase()} A1.0 for ${mod.name}`}>
                          {busy === k ? 'Creating…' : '+ Create'}
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={t.id}>
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
                              <span className="mp-ver">{isOpenDoc(d) ? `draft r${d.revision}` : d.status}</span>
                            </span>
                          ))}
                        </span>
                        <span className="btn-row">
                          {open ? (
                            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/modules/${mod.slug}/docs/${open.key}/edit`)}>
                              Edit {open.version}
                            </button>
                          ) : (
                            <button
                              className="btn btn-sm"
                              disabled={busy === k}
                              title={`Next version of the ${t.label.toLowerCase()}, based on ${latest.version}${unc.length ? ` — becomes the manual for ${unc.map((u) => u.version).join(', ')}` : ''}`}
                              onClick={() => act(k, () => api.nextDocVersion(mod.slug, { manual: t.id, bump: 'minor' }), `New ${t.label.toLowerCase()} draft created for ${mod.name}`)}
                            >
                              {busy === k ? 'Creating…' : 'New version'}
                            </button>
                          )}
                          {unc.length > 0 && (
                            <span className="orange-dot" title={`Not yet covered: ${unc.map((u) => u.version).join(', ')}`} />
                          )}
                        </span>
                        <span className="muted small">updated {timeAgo(latest.updatedAt)}</span>
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
        <h3>Releases</h3>
        {sw.releases.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Release</th>
                <th>Date</th>
                <th>Manual-affecting</th>
                <th>Covered by</th>
              </tr>
            </thead>
            <tbody>
              {sw.releases.map((rel) => (
                <tr key={rel.version}>
                  <td><strong>{rel.version}</strong> {rel.note && <span className="muted">— {rel.note}</span>}</td>
                  <td className="muted">{timeAgo(rel.date)}</td>
                  <td>{rel.manualAffecting ? <span className="badge badge-in-review">Yes</span> : 'No'}</td>
                  <td>
                    {rel.coveredBy.length ? (
                      <span className="manual-pills">
                        {rel.coveredBy.map((c) => (
                          <span key={`${c.slug}:${c.key}`} className={`manual-pill mp-${c.status}`} title={`${c.slug} · ${c.key} · ${c.status}`}>
                            <span className="mp-type">{sw.modules.find((m) => m.slug === c.slug)?.code || c.slug}</span>
                            <span className="mp-ver">{manualType(c.manual).short} {c.version}</span>
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="muted">not linked — assign on the module's Software versions tab</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="pair wrap" style={{ marginTop: 8 }}>
          <input placeholder="Version (v2.0.2)" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          <input placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <label className="check">
            <input type="checkbox" checked={form.manualAffecting} onChange={(e) => setForm({ ...form, manualAffecting: e.target.checked })} />
            manual-affecting
          </label>
          <button className="btn btn-primary btn-sm" disabled={!form.version.trim() || busy === 'release'} onClick={register}>
            Register release
          </button>
        </div>
      </div>
    </div>
  );
}
