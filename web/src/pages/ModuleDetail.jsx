import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, CATEGORIES, timeAgo, readFileAsBase64 } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../App.jsx';
import HardwarePicker, { HardwareForm, hwDetail } from '../components/HardwarePicker.jsx';

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
            {(module.hardwareItems || []).map((h) => (
              <span key={h.id || h.name} className="chip chip-hw" title={hwDetail(h)}>
                {h.name}
              </span>
            ))}
            <StatusBadge status={data.status} />
          </div>
        </div>
        {!hasOpenDraft && docs.length > 0 && (
          <div className="btn-col">
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
            {(data.uncovered || []).length > 0 && (
              <span className="hint">
                The new version becomes the manual for {data.uncovered.map((u) => `${u.name} ${u.version}`).join(', ')}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={tab === 'docs' ? 'active' : ''} onClick={() => setTab('docs')}>
          Documentation
        </button>
        <button className={tab === 'hardware' ? 'active' : ''} onClick={() => setTab('hardware')}>
          Hardware{module.hardwareItems?.length ? ` (${module.hardwareItems.length})` : ''}
        </button>
        <button className={tab === 'assets' ? 'active' : ''} onClick={() => setTab('assets')}>
          Assets
          {data.staleAssets > 0 && (
            <>
              {' '}
              <span className="orange-dot" title={`${data.staleAssets} image${data.staleAssets === 1 ? '' : 's'} may show an older software/hardware version`} />
            </>
          )}
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
                  {d.fat && (
                    <a className="btn btn-sm" href={`/api/modules/${slug}/docs/${d.version}/checklist.html`} target="_blank" rel="noreferrer" title="Blank FAT protocol for this doc version">
                      FAT
                    </a>
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

      {tab === 'assets' && <AssetsTab slug={slug} docs={docs} module={module} onChanged={load} />}

      {tab === 'hardware' && <HardwareTab module={module} slug={slug} reload={load} />}

      {tab === 'software' && (
        <SoftwareTab data={data} slug={slug} reload={load} />
      )}
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
      toast(`${saved.length} file${saved.length === 1 ? '' : 's'} in the inbox`);
      load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function importFiles(names) {
    if (!draft) return toast('Create a doc draft first', 'err');
    setBusy(true);
    try {
      const saved = await api.importInbox(slug, draft.version, names);
      toast(`${saved.length} file${saved.length === 1 ? '' : 's'} attached to ${draft.version}`);
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
          {open ? '▾' : '▸'} Inbox <span className="muted">— {files.length} file{files.length === 1 ? '' : 's'} waiting</span>
        </button>
        <span className="muted small" title={info?.dir}>
          Drop artwork here, then attach it yourself or tell the assistant which figure goes where (it imports by name — no image bytes through the chat).
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
            <strong>{busy ? 'Working…' : 'Drop files for the inbox'}</strong>
            <span className="muted">
              {' — or '}
              <label className="link">
                choose files
                <input type="file" multiple accept="image/*,.pdf,.svg" hidden onChange={(e) => { drop(e.target.files); e.target.value = ''; }} />
              </label>
              . Stored in <code>{info?.dir || '…'}</code> on the console machine; not committed until attached.
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
                    {fmt(f.size)}{f.width ? ` · ${f.width}×${f.height}` : ''}{f.complete === false ? ' · truncated!' : ''}
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-sm btn-primary" disabled={!draft || busy || f.complete === false} onClick={() => importFiles([f.name])}>
                      Attach to {draft ? draft.version : 'draft'}
                    </button>
                    <button
                      className="btn-icon"
                      title="Delete from inbox"
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
                    </button>
                  </div>
                </div>
              ))}
              {draft && files.filter((f) => f.complete !== false).length > 1 && (
                <button className="btn attach-all" disabled={busy} onClick={() => importFiles(files.filter((f) => f.complete !== false).map((f) => f.name))}>
                  Attach all to {draft.version}
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
      toast(`Hardware saved — ${updated.hardwareItems.length ? updated.hardwareItems.map((h) => h.name).join(', ') : 'none'}`);
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
      toast('Catalog item updated');
      setEditing(null);
      await loadCatalog();
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  if (catalog === null) return <div className="muted">Loading…</div>;
  const assigned = (module.hardwareItems || []).filter((h) => h.id && !h.missing);

  return (
    <div className="hw-tab">
      <div className="sw-register">
        <h3>Units described by this manual</h3>
        <p className="muted small">
          Each unit gets its own row in <em>3 General information</em> and in the FAT protocol header. When a manual
          covers several unit types (e.g. three camera models), describe each one in its own subsection of
          Installation and Operation.
        </p>
        <HardwarePicker catalog={catalog} value={value} onChange={setValue} />
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary btn-sm" disabled={!dirty || busy} onClick={save}>
            {busy ? 'Saving…' : 'Save hardware assignment'}
          </button>
          {dirty && (
            <button
              className="btn btn-sm"
              onClick={() => setValue((module.hardwareItems || []).map((h) => (h.id && !h.missing ? { id: h.id } : { ...h })))}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {assigned.length > 0 && (
        <div className="sw-block" style={{ marginTop: 20 }}>
          <h3>Catalog records</h3>
          <p className="muted small">Editing a record changes it for every module that uses it.</p>
          <table className="table">
            <thead>
              <tr>
                <th>Unit</th>
                <th>Relation</th>
                <th>Notes</th>
                <th>Also used by</th>
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
                      <HardwareForm initial={rec} submitLabel="Save record" onSubmit={(p) => saveItem(h.id, p)} onCancel={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={h.id}>
                    <td><strong>{rec.name}</strong> <code className="muted">{rec.id}</code></td>
                    <td>{hwDetail(rec)}</td>
                    <td className="muted">{rec.notes || '—'}</td>
                    <td className="muted">{others.length ? others.map((m) => <Link key={m.slug} to={`/modules/${m.slug}`}>{m.name}</Link>).reduce((acc, x) => (acc.length ? [...acc, ', ', x] : [x]), []) : '—'}</td>
                    <td className="btn-row">
                      <button className="btn btn-sm" onClick={() => setEditing(h.id)}>Edit record</button>
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
  const [assets, setAssets] = useState(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [drawing, setDrawing] = useState(null); // asset name being converted
  const [stamping, setStamping] = useState(null); // asset name whose stamp is being saved
  const draft = docs.find((d) => d.status === 'draft' || d.status === 'in-review');
  const hwItems = (module.hardwareItems || []).filter((h) => h.id && !h.missing);

  /** Save "applies to" / "verified" on the draft branch. */
  async function stamp(asset, body, okMsg) {
    if (!draft) return toast('Version stamps are edited on a draft — create a doc draft first', 'err');
    setStamping(asset.name);
    try {
      await api.setAssetMeta(slug, draft.version, asset.name, body);
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
    if (!draft) return toast('Create a doc draft first', 'err');
    const instructions = window.prompt(`Redraw ${asset.name} as Technical Aviation Manual Line-Art.
Optional instructions (what to number, arrows, emphasis):`, '');
    if (instructions === null) return;
    setDrawing(asset.name);
    try {
      const r = await api.illustrate(slug, draft.version, { assetName: asset.name, instructions });
      toast(`${r.illustration.name} added to ${draft.version} — insert it from the editor's AI pane or with Copy <figure>`);
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
            <div className={`asset-card ${a.stale?.length ? 'stale' : ''}`} key={a.name}>
              {/\.(png|jpe?g|gif|webp|svg)$/i.test(a.name) ? (
                <img src={a.url} alt={a.name} loading="lazy" />
              ) : (
                <div className="asset-file">{a.name.split('.').pop().toUpperCase()}</div>
              )}
              <div className="asset-name" title={a.url}>
                {a.name}
              </div>
              <div className="asset-meta">
                {a.stale?.length > 0 && (
                  <span className="orange-dot" title={`Newer than this picture: ${a.stale.join(', ')}`} />
                )}
                {a.meta ? (
                  <span
                    className="chip"
                    title={`${a.meta.verifiedIn ? `Verified in ${a.meta.verifiedIn}` : `Added in ${a.meta.addedIn}`} — software/hardware versions current at that time`}
                  >
                    {stampLabel(a.meta, hwItems)}
                  </span>
                ) : (
                  <span className="hint" title="Added before version stamps existed — Verify to stamp it with the current versions">
                    no version stamp
                  </span>
                )}
              </div>
              {hwItems.length > 1 && (
                <label className="asset-applies">
                  <span className="hint">Shows</span>
                  <select
                    value={a.meta?.appliesTo?.length === 1 ? a.meta.appliesTo[0] : ''}
                    disabled={!draft || stamping === a.name}
                    title="Which of the module's units this picture shows"
                    onChange={(e) =>
                      stamp(
                        a,
                        { appliesTo: e.target.value ? [e.target.value] : [] },
                        e.target.value ? `${a.name} applies to ${hwItems.find((h) => h.id === e.target.value)?.name}` : `${a.name} applies to all units`
                      )
                    }
                  >
                    <option value="">All units</option>
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
                      ? `Confirm this picture is still correct for ${a.stale.join(', ')} (or upload a replacement) — re-stamps it as current`
                      : 'Stamp this file with the current software/hardware versions'
                  }
                  onClick={() => stamp(a, { verify: true }, `${a.name} verified for current versions`)}
                >
                  {stamping === a.name ? 'Saving…' : a.stale?.length ? `Verified for ${a.stale[0]}` : 'Stamp version'}
                </button>
              )}
              <div className="btn-row">
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    navigator.clipboard?.writeText(`<figure><img src="${a.url}" alt="${a.name}"><figcaption>TODO(author): caption</figcaption></figure>`);
                    toast('Figure HTML copied — paste it in the HTML source view');
                  }}
                >
                  Copy &lt;figure&gt;
                </button>
                {/.(png|jpe?g|webp|gif)$/i.test(a.name) && !/-lineart.png$/i.test(a.name) && (
                  <button
                    className="btn btn-sm"
                    disabled={!draft || drawing === a.name}
                    title="Redraw this photo in the FTD Technical Aviation Manual Line-Art style"
                    onClick={() => toLineArt(a)}
                  >
                    {drawing === a.name ? 'Drawing…' : '✎ Line-art'}
                  </button>
                )}
                {draft && (
                  <button
                    className="btn-icon"
                    title={`Remove from ${draft.version} (git rm on ${draft.branch})`}
                    onClick={async () => {
                      if (!confirm(`Remove ${a.name} from ${draft.version}? Figures referencing it will break.`)) return;
                      try {
                        await api.deleteAsset(slug, draft.version, a.name);
                        toast(`${a.name} removed`);
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
  const releasedDoc = docs.find((d) => d.status === 'released');
  const openDraft = docs.find((d) => d.status === 'draft' || d.status === 'in-review');

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

  function link(doc, swName, swVersion) {
    api
      .coverRelease(slug, doc.version, swName, swVersion)
      .then(() => { toast(`${doc.version} now covers ${swName} ${swVersion}`); reload(); })
      .catch((e) => toast(e.message, 'err'));
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
                      {!doc && !rel.manualAffecting && releasedDoc && (
                        <button
                          className="btn btn-sm"
                          title="Extend the released doc's covered range to this release"
                          onClick={() => link(releasedDoc, sw.name, rel.version)}
                        >
                          Link to {releasedDoc.version}
                        </button>
                      )}
                      {!doc && openDraft && (
                        <button
                          className="btn btn-sm"
                          title={`Make ${openDraft.version} the manual for ${sw.name} ${rel.version}`}
                          onClick={() => link(openDraft, sw.name, rel.version)}
                        >
                          Assign to {openDraft.version} ({openDraft.status})
                        </button>
                      )}
                      {!doc && rel.manualAffecting && !openDraft && (
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
