import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, CATEGORIES, timeAgo, readFileAsBase64 } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../App.jsx';

const catLabel = (c) => (CATEGORIES.find(([k]) => k === c) || [null, c])[1];

export default function ModuleDetail() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [tab, setTab] = useState('docs');
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

  if (!data) return <div className="page"><div className="empty">Loading…</div></div>;

  const { module, docs, history } = data;
  const hasSoftware = (module.softwares || []).length > 0;
  const hasOpenDraft = docs.some((d) => d.status === 'draft' || d.status === 'in-review');

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
        <Link to="/">Modules</Link> / {module.name}
      </div>
      <div className="page-head">
        <div>
          <h1>
            {module.name}{' '}
            {data.needsDoc && (
              <span className="orange-dot" title="Manual-affecting software release with no doc linked yet" />
            )}
          </h1>
          <div className="meta-chips">
            {module.code && <code>{module.code}</code>}
            <span className="chip">{catLabel(module.category)}</span>
            <span className="chip">{module.group}</span>
            <StatusBadge status={data.status} />
          </div>
        </div>
        {!hasOpenDraft && docs.length > 0 && (
          <div className="btn-row">
            <button
              className="btn"
              onClick={() => act(() => api.nextDocVersion(slug, 'minor'), 'New minor doc draft created')}
            >
              New doc version (minor)
            </button>
            <button
              className="btn"
              onClick={() => act(() => api.nextDocVersion(slug, 'major'), 'New major doc draft created')}
            >
              New doc version (major)
            </button>
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>
          Documentation
        </button>
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
          Assets
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          History
        </button>
        {hasSoftware && (
          <button className={tab === 'software' ? 'active' : ''} onClick={() => setTab('software')}>
            Software versions
          </button>
        )}
      </div>

      {tab === 'docs' && (
        <table className="table">
          <thead>
            <tr>
              <th>Doc version</th>
              <th>Revision</th>
              <th>Status</th>
              <th>Branch</th>
              <th>Updated</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.version}>
                <td><strong>{d.version}</strong></td>
                <td>r{d.revision}</td>
                <td><StatusBadge status={d.status} /></td>
                <td className="muted">{d.branch || 'main'}</td>
                <td className="muted">{timeAgo(d.updatedAt)}</td>
                <td className="btn-row">
                  {(d.status === 'draft' || d.status === 'in-review') && (
                    <>
                      <button className="btn btn-primary btn-sm" onClick={() => navigate(`/modules/${slug}/docs/${d.version}/edit`)}>
                        Edit
                      </button>
                      {d.status === 'draft' && (
                        <button
                          className="btn btn-sm"
                          onClick={() => act(() => api.submitReview(slug, d.version), `${d.version} submitted for review`)}
                        >
                          Submit for review
                        </button>
                      )}
                      {d.status === 'in-review' && (
                        <>
                          <button
                            className="btn btn-sm"
                            onClick={() => act(() => api.release(slug, d.version), `${d.version} released — merged to main`)}
                          >
                            Approve &amp; release
                          </button>
                          <button
                            className="btn btn-sm"
                            onClick={() => act(() => api.backToDraft(slug, d.version), `${d.version} back to draft`)}
                          >
                            Back to draft
                          </button>
                        </>
                      )}
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => {
                          if (confirm(`Discard draft ${d.version}? The branch ${d.branch} will be deleted.`)) {
                            act(() => api.discard(slug, d.version), `${d.version} discarded`).then(() => {
                              // module may be gone entirely if it was never released
                              api.module(slug).catch(() => navigate('/'));
                            });
                          }
                        }}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {(d.status === 'released' || d.status === 'superseded') && (
                    <button className="btn btn-sm" onClick={() => navigate(`/modules/${slug}/docs/${d.version}/edit`)}>
                      View
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {docs.length === 0 && (
              <tr>
                <td colSpan="6" className="muted">No doc versions.</td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {tab === 'history' && (
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Change</th>
              <th>Ref</th>
              <th>Commit</th>
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

      {tab === 'assets' && <AssetsTab slug={slug} docs={docs} />}

      {tab === 'software' && (
        <SoftwareTab data={data} slug={slug} reload={load} />
      )}
    </div>
  );
}

function AssetsTab({ slug, docs }) {
  const toast = useToast();
  const [assets, setAssets] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const draft = docs.find((d) => d.status === 'draft' || d.status === 'in-review');

  const load = () => api.listAssets(slug).then(setAssets).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    load();
  }, [slug]);

  async function upload(fileList) {
    if (!draft) return toast('Assets are added to a draft — create a doc draft first', 'err');
    const files = [...fileList];
    if (!files.length) return;
    setBusy(true);
    try {
      const payload = await Promise.all(files.map(readFileAsBase64));
      const saved = await api.uploadAssets(slug, draft.version, payload);
      toast(`${saved.length} file${saved.length === 1 ? '' : 's'} added to ${draft.version}`);
      load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
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
        <strong>{busy ? 'Uploading…' : 'Drop images here'}</strong>
        <span className="muted">
          {draft ? ` — or ` : ' — no open draft; '}
          {draft && (
            <label className="link">
              choose files
              <input type="file" multiple accept="image/*,.pdf,.svg" hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
            </label>
          )}
          {draft ? `. Files are committed to ${draft.branch}.` : 'create a doc draft to add assets.'}
        </span>
      </div>

      {assets === null ? (
        <div className="muted">Loading…</div>
      ) : assets.length === 0 ? (
        <div className="empty">No assets yet.</div>
      ) : (
        <div className="asset-grid">
          {assets.map((a) => (
            <div className="asset-card" key={a.name}>
              {/\.(png|jpe?g|gif|webp|svg)$/i.test(a.name) ? (
                <img src={a.url} alt={a.name} loading="lazy" />
              ) : (
                <div className="asset-file">{a.name.split('.').pop().toUpperCase()}</div>
              )}
              <div className="asset-name" title={a.url}>
                {a.name}
              </div>
              <button
                className="btn btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(`<figure><img src="${a.url}" alt="${a.name}"><figcaption>TODO(author): caption</figcaption></figure>`);
                  toast('Figure HTML copied — paste it in the HTML source view');
                }}
              >
                Copy &lt;figure&gt;
              </button>
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
  const releasedDocs = docs.filter((d) => d.status === 'released' || d.status === 'superseded');

  const coveredBy = (swName, version) =>
    docs.find((d) => (d.covers || []).some((c) => c.name === swName && covered(version, c)));

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

  async function register() {
    try {
      await api.registerRelease(form);
      toast(`${form.name} ${form.version} registered`);
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
            {sw.name} <span className="muted">linked from {sw.fromVersion || '—'}</span>
          </h3>
          <table className="table">
            <thead>
              <tr>
                <th>Release</th>
                <th>Date</th>
                <th>Manual-affecting</th>
                <th>Covered by doc</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(softwareFeed[sw.name] || []).map((rel) => {
                const doc = coveredBy(sw.name, rel.version);
                return (
                  <tr key={rel.version}>
                    <td><strong>{rel.version}</strong> {rel.note && <span className="muted">— {rel.note}</span>}</td>
                    <td className="muted">{timeAgo(rel.date)}</td>
                    <td>{rel.manualAffecting ? <span className="badge badge-in-review">Yes</span> : 'No'}</td>
                    <td>{doc ? doc.version : <span className="muted">not linked</span>}</td>
                    <td>
                      {!doc && !rel.manualAffecting && releasedDocs[0] && (
                        <button
                          className="btn btn-sm"
                          title="Extend the latest released doc's covered range to this release"
                          onClick={() =>
                            api
                              .coverRelease(slug, releasedDocs[0].version, sw.name, rel.version)
                              .then(() => { toast(`${releasedDocs[0].version} now covers ${sw.name} ${rel.version}`); reload(); })
                              .catch((e) => toast(e.message, 'err'))
                          }
                        >
                          Link to {releasedDocs[0].version}
                        </button>
                      )}
                      {!doc && rel.manualAffecting && (
                        <span className="hint">needs a new doc version</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {(softwareFeed[sw.name] || []).length === 0 && (
                <tr><td colSpan="5" className="muted">No releases registered.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ))}

      <div className="sw-register">
        <h3>Register software release</h3>
        <div className="pair wrap">
          <select value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}>
            {module.softwares.map((s) => (
              <option key={s.name}>{s.name}</option>
            ))}
          </select>
          <input placeholder="Version (v2.0.2)" value={form.version} onChange={(e) => setForm({ ...form, version: e.target.value })} />
          <input placeholder="Note (optional)" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <label className="check">
            <input
              type="checkbox"
              checked={form.manualAffecting}
              onChange={(e) => setForm({ ...form, manualAffecting: e.target.checked })}
            />
            manual-affecting
          </label>
          <button className="btn btn-primary btn-sm" disabled={!form.version} onClick={register}>
            Register
          </button>
        </div>
      </div>
    </div>
  );
}
