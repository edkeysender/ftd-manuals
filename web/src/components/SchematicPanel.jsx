import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, schematicSvgUrl, askReleaseNote, readFileAsBase64, cableLabelsUrl } from '../api.js';
import ActionMenu from './ActionMenu.jsx';
import SchematicViewer from './SchematicViewer.jsx';
import { useToast } from '../App.jsx';
import { t, plural, locale } from '../i18n.jsx';

/** One line of an operation, for the pending list and the history. */
export function describeOp(op) {
  const end = (e) => (e?.block ? `${e.block}.${e.port}` : `${e?.device}.${e?.port}`);
  switch (op.op) {
    case 'add_device': return t('Add device {label}', { label: op.label || op.template });
    case 'update_device': return t('Update device {id}', { id: op.id });
    case 'remove_device': return t('Remove device {id}', { id: op.id });
    case 'connect': return t('Connect {from} → {to}{kind}', { from: end(op.from), to: end(op.to), kind: op.kind ? ` (${op.kind})` : '' });
    case 'update_cable': return t('Update cable {id}', { id: op.id });
    case 'disconnect': return t('Remove cable {id}', { id: op.id });
    case 'set_external_port': return t('External port {label} = {dev}.{port}', { label: op.label || op.id, dev: op.device, port: op.port });
    case 'unset_external_port': return t('Remove external port {id}', { id: op.id });
    case 'add_location': return t('Add location {label}', { label: op.label });
    case 'update_location': return t('Update location {id}', { id: op.id });
    case 'remove_location': return t('Remove location {id}', { id: op.id });
    case 'place_block': return t('Place module {module}', { module: op.module });
    case 'refresh_block': return t('Refresh block {id}', { id: op.id });
    case 'remove_block': return t('Remove block {id}', { id: op.id });
    case 'move': return t('Move {id}', { id: op.id });
    case 'tidy': return t('Tidy the layout');
    default: return op.op;
  }
}

/**
 * The schematic of one owner, read-only in this phase: status and actions, the drawing rendered by the
 * server, validation, the cable schedule, and the chat drawer whose operations are accepted or rejected.
 */
export default function SchematicPanel({ owner, canEdit = false, isAdmin = false, onChanged }) {
  const toast = useToast();
  const [data, setData] = useState(undefined); // undefined loading, null none
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('drawing');
  const [v, setV] = useState(0);
  const [location, setLocation] = useState(''); // '' = the whole installation; else one rack's or area's view
  const [addingLoc, setAddingLoc] = useState(false);
  const [addingDev, setAddingDev] = useState(false);

  const load = useCallback(() => api.schematic(owner, location).then(setData).catch((e) => (e.code === 'no-schematic' || e.status === 404 ? setData(null) : toast(e.message, 'err'))), [owner, location]);
  useEffect(() => { load(); }, [load]);
  const changed = () => { setV((x) => x + 1); load(); onChanged?.(); };

  const run = async (fn, okMsg) => {
    setBusy(true);
    try {
      await fn();
      if (okMsg) toast(okMsg);
      changed();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  };

  if (data === undefined) return <div className="empty">{t('Loading…')}</div>;
  if (data === null) {
    return (
      <div className="empty">
        <p>{t('No schematic yet.')}</p>
        <p className="small">{t('A schematic is the wiring as data: devices with typed ports, cables, locations. Build it by telling the chat what is connected to what, or over MCP.')}</p>
        {canEdit && <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.createSchematic(owner), t('Schematic draft created'))}>{t('+ Create schematic')}</button>}
      </div>
    );
  }

  const { state, released, isDraft, editable, validation, face } = data;
  const errors = validation.errors.length;
  const warnings = validation.warnings.length;
  // one location selected: the schedule shows only the cables that touch it
  const schedule = data.view ? data.schedule.filter((r) => data.view.cableIds.includes(r.id)) : data.schedule;
  const locations = [...state.locations].sort((a, b) => (a.kind === 'rack' ? 0 : 1) - (b.kind === 'rack' ? 0 : 1));
  const current = locations.find((l) => l.id === location) || null;
  const locOps = (ops, msg) => run(() => api.schematicOps(owner, ops, { summary: msg }), msg);
  const renameLoc = () => {
    const label = window.prompt(t('New name of the location'), current.label);
    if (label && label.trim() && label.trim() !== current.label) locOps([{ op: 'update_location', id: current.id, label: label.trim() }], t('Location renamed'));
  };
  const removeLoc = () => {
    if (!window.confirm(t('Remove the empty location {name}?', { name: current.label }))) return;
    setLocation('');
    locOps([{ op: 'remove_location', id: current.id }], t('Location removed'));
  };

  // askReleaseNote prompts and throws when the author cancels or leaves the line empty
  const release = () => {
    let note;
    try { note = askReleaseNote({ hotfix: !!state.hotfix, first: !released }); } catch (e) { return toast(e.message, 'err'); }
    run(() => api.releaseSchematic(owner, note), t('Schematic released'));
  };
  const releaseNote = () => {
    let note;
    try { note = askReleaseNote({ current: (released?.releaseRecord || []).at(-1)?.summary || '' }); } catch (e) { return toast(e.message, 'err'); }
    run(() => api.schematicReleaseNote(owner, note), t('Revision record line saved'));
  };

  return (
    <div className="schematic-panel">
      <div className="schematic-head">
        <div>
          <span className={`badge badge-${state.hotfix ? 'in-review' : state.status}`}>{state.hotfix ? t('Hotfix') : t(state.status)}</span>{' '}
          <strong>{state.version}</strong> <span className="muted">r{state.revision}</span>
          {released && released.version !== state.version && <span className="muted"> · {t('released {v}', { v: released.version })}</span>}
          {errors > 0 && <span className="chip chip-err" title={validation.errors.map((e) => e.message).join('\n')}> {plural(errors, 'error')}</span>}
          {warnings > 0 && <span className="chip chip-warn" title={validation.warnings.map((w) => w.message).join('\n')}> {plural(warnings, 'warning')}</span>}
        </div>
        {canEdit && (
          <div className="btn-row">
            {editable && !state.hotfix && state.status === 'draft' && <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.schematicAction(owner, 'submit-review'), t('Submitted for review'))}>{t('Submit for review')}</button>}
            {editable && state.status === 'in-review' && <button className="btn btn-sm" disabled={busy} onClick={() => run(() => api.schematicAction(owner, 'back-to-draft'))}>{t('Back to draft')}</button>}
            {editable && <button className="btn btn-sm btn-primary" disabled={busy || errors > 0} title={errors ? t('Fix the errors first') : ''} onClick={release}>{state.hotfix ? t('Publish hotfix') : t('Release…')}</button>}
            {!editable && <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => run(() => api.createSchematic(owner), t('Next version started'))}>{t('New version')}</button>}
            <ActionMenu
              items={[
                !editable && { label: t('Hotfix'), onClick: () => run(() => api.schematicAction(owner, 'hotfix'), t('Hotfix started')) },
                !editable && released && { label: t('Revision record line…'), onClick: releaseNote },
                { label: t('Download cable schedule (CSV)'), onClick: () => window.open(`${schematicSvgUrl(owner).replace('/render.svg', '/cables.csv').split('?')[0]}`, '_blank') },
                editable && isAdmin && { label: t('Discard draft'), danger: true, onClick: () => window.confirm(t('Discard this draft? The released version stays.')) && run(() => api.schematicAction(owner, 'discard'), t('Draft discarded')) },
              ].filter(Boolean)}
            />
          </div>
        )}
      </div>

      {state.kind === 'installation' && (
        <div className="loc-bar">
          <span className="field-label">{t('Show')}</span>
          <button className={`loc-chip ${location === '' ? 'active' : ''}`} onClick={() => setLocation('')}>{t('Whole installation')}</button>
          {locations.map((l) => (
            <button key={l.id} className={`loc-chip loc-${l.kind} ${location === l.id ? 'active' : ''}`} onClick={() => setLocation(l.id)} title={l.kind === 'rack' ? t('Rack') : t('Area')}>
              {l.kind === 'rack' ? '▮ ' : '▭ '}{l.label}
            </button>
          ))}
          {canEdit && editable && (
            <span className="btn-row">
              <button className="btn btn-sm btn-primary" onClick={() => setAddingDev(true)}>{t('+ Device')}</button>
              <button className="btn btn-sm" onClick={() => setAddingLoc(true)}>{t('+ Rack / area')}</button>
              {current && <button className="btn btn-sm" onClick={renameLoc}>{t('Rename')}</button>}
              {current && <button className="btn btn-sm btn-danger" onClick={removeLoc} title={t('Only an empty location can be removed')}>{t('Remove')}</button>}
            </span>
          )}
          {current && <span className="hint">{t('{n} devices in {name}; cables that leave it are drawn to where they go.', { n: (data.view?.deviceIds.length || 0) + (data.view?.blockIds.length || 0), name: current.label })}</span>}
        </div>
      )}
      {addingLoc && <NewLocation locations={state.locations} onClose={() => setAddingLoc(false)} onCreate={(op) => { setAddingLoc(false); locOps([op], t('Location added')); }} />}
      {state.kind === 'module' && canEdit && editable && <div className="loc-bar"><button className="btn btn-sm btn-primary" onClick={() => setAddingDev(true)}>{t('+ Device')}</button></div>}
      {addingDev && <NewDevice state={state} defaultLocation={location} onClose={() => setAddingDev(false)} onCreate={(op) => { setAddingDev(false); locOps([op], t('Device added')); }} />}

      <div className="tabs">
        <button className={tab === 'drawing' ? 'active' : ''} onClick={() => setTab('drawing')}>{t('Drawing')}</button>
        <button className={tab === 'cables' ? 'active' : ''} onClick={() => setTab('cables')}>{t('Cable schedule')}{schedule.length ? ` (${schedule.length})` : ''}</button>
        {face.length > 0 && <button className={tab === 'face' ? 'active' : ''} onClick={() => setTab('face')}>{t('External ports')} ({face.length})</button>}
        <button className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}>{t('Checks')}{errors + warnings ? ` (${errors + warnings})` : ''}</button>
      </div>

      {tab === 'drawing' && <SchematicViewer owner={owner} data={data} v={v} location={location} canEdit={canEdit} onChanged={changed} />}
      {tab === 'cables' && schedule.length > 0 && (
        <div className="btn-row" style={{ marginBottom: 10 }}>
          <a className="btn btn-sm" href={cableLabelsUrl(owner, { location, lang: locale() })} target="_blank" rel="noreferrer">{t('Print cable labels')}{current ? ` (${current.label})` : ''}</a>
          <span className="hint">{t('Two labels per cable, name and code, 60 × 32 mm.')}</span>
        </div>
      )}
      {tab === 'cables' && (
        schedule.length === 0 ? <div className="empty">{t('No cables yet.')}</div> : (
          <table className="table">
            <thead><tr><th>{t('Cable')}</th><th>{t('Kind')}</th><th>{t('From')}</th><th>{t('Port')}</th><th>{t('To')}</th><th>{t('Port')}</th><th>{t('Length')}</th></tr></thead>
            <tbody>{schedule.map((r) => <tr key={r.id}><td>{r.label || r.id}</td><td>{r.kindLabel}</td><td>{r.from}</td><td>{r.fromPort}</td><td>{r.to}</td><td>{r.toPort}</td><td>{r.length != null ? `${r.length} m` : ''}</td></tr>)}</tbody>
          </table>
        )
      )}
      {tab === 'face' && (
        <table className="table">
          <thead><tr><th>{t('Port')}</th><th>{t('Connector')}</th><th>{t('Inside')}</th></tr></thead>
          <tbody>{face.map((p) => <tr key={p.id}><td>{p.label}</td><td>{p.connector || '—'}</td><td>{p.device} · {p.port}</td></tr>)}</tbody>
        </table>
      )}
      {tab === 'checks' && (
        errors + warnings === 0 ? <div className="empty">{t('No problems found.')}</div> : (
          <ul className="check-list">
            {validation.errors.map((e, i) => <li key={`e${i}`} className="check-err"><strong>{t('Error')}</strong> {e.message}</li>)}
            {validation.warnings.map((w, i) => <li key={`w${i}`} className="check-warn"><strong>{t('Warning')}</strong> {w.message}</li>)}
          </ul>
        )
      )}

      {canEdit && editable && <SchematicChat owner={owner} onApplied={changed} />}
      {canEdit && !editable && <p className="hint">{t('This version is released — start a new version or a hotfix to change it.')}</p>}
    </div>
  );
}

/** Place a library device: pick the template, name it, choose where it sits. */
function NewDevice({ state, defaultLocation, onClose, onCreate }) {
  const [lib, setLib] = useState(null);
  const [q, setQ] = useState('');
  const [template, setTemplate] = useState('');
  const [label, setLabel] = useState('');
  const [loc, setLoc] = useState(defaultLocation || state.locations[0]?.id || '');
  const [u, setU] = useState('');
  const [face, setFace] = useState('front');
  useEffect(() => { api.library().then(setLib).catch(() => setLib({ devices: [] })); }, []);
  const devices = (lib?.devices || []).filter((d) => !q.trim() || `${d.name} ${d.manufacturer} ${d.model} ${d.category} ${d.id}`.toLowerCase().includes(q.trim().toLowerCase()));
  const tpl = (lib?.devices || []).find((d) => d.id === template) || null;
  const rack = state.locations.find((l) => l.id === loc)?.kind === 'rack';
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('Add device')}</h2></div>
        <div className="modal-body">
          <label>{t('Library device')}
            <input autoFocus value={q} placeholder={t('Filter by name, maker, model, category…')} onChange={(e) => setQ(e.target.value)} />
            <select size={7} value={template} onChange={(e) => setTemplate(e.target.value)}>
              {devices.map((d) => <option key={d.id} value={d.id} onClick={() => setTemplate(d.id)}>{d.name}{d.manufacturer || d.model ? ` — ${[d.manufacturer, d.model].filter(Boolean).join(' ')}` : ''}</option>)}
            </select>
          </label>
          {tpl && <p className="small muted">{t('{n} ports', { n: tpl.ports.length })}: {tpl.ports.map((p) => p.label).join(', ')}</p>}
          <div className="pair">
            <label style={{ flex: 2 }}>{t('Label')}<input value={label} placeholder={tpl ? tpl.name : ''} onChange={(e) => setLabel(e.target.value)} /></label>
            {state.kind === 'installation' && (
              <label style={{ flex: 1.5 }}>{t('Location')}
                <select value={loc} onChange={(e) => setLoc(e.target.value)}>{state.locations.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
              </label>
            )}
            {rack && <label style={{ flex: 0.6 }}>{t('U position')}<input type="number" min="1" value={u} onChange={(e) => setU(e.target.value)} /></label>}
            {rack && <label style={{ flex: 0.8 }}>{t('Face')}<select value={face} onChange={(e) => setFace(e.target.value)}><option value="front">{t('Front')}</option><option value="rear">{t('Rear')}</option></select></label>}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={!tpl} onClick={() => onCreate({ op: 'add_device', template: tpl.id, label: label.trim() || tpl.name, ...(state.kind === 'installation' && loc ? { location: loc } : {}), ...(rack && u ? { rack: { u: Number(u), face } } : {}) })}>{t('Add')}</button>
        </div>
      </div>
    </div>
  );
}

/** A new rack or area for an installation — up to four racks per simulator, IOS and the shell beside them. */
function NewLocation({ locations, onClose, onCreate }) {
  const racks = locations.filter((l) => l.kind === 'rack').length;
  const [kind, setKind] = useState(racks < 4 ? 'rack' : 'area');
  const [label, setLabel] = useState(racks < 4 ? `Rack ${racks + 1}` : '');
  const [unitsU, setUnitsU] = useState(42);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><h2>{t('New rack or area')}</h2></div>
        <div className="modal-body">
          <div className="pair">
            <label>{t('Kind')}
              <select value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="rack">{t('Rack')}</option>
                <option value="area">{t('Area (IOS, simulator shell, cockpit…)')}</option>
              </select>
            </label>
            <label style={{ flex: 2 }}>{t('Name')}<input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'rack' ? t('e.g. S03 Rack AV') : t('e.g. Simulator Shell')} /></label>
            {kind === 'rack' && <label style={{ flex: 0.6 }}>{t('Height (U)')}<input type="number" min="1" max="60" value={unitsU} onChange={(e) => setUnitsU(e.target.value)} /></label>}
          </div>
          {kind === 'rack' && racks >= 4 && <p className="hint warn">{t('This installation already has {n} racks — a simulator holds up to four.', { n: racks })}</p>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={!label.trim()} onClick={() => onCreate({ op: 'add_location', label: label.trim(), kind, unitsU: kind === 'rack' ? Number(unitsU) || 42 : undefined })}>{t('Add')}</button>
        </div>
      </div>
    </div>
  );
}

/** The chat drawer: a sentence in, operations out, accepted as one commit or rejected. */
function SchematicChat({ owner, onApplied }) {
  const toast = useToast();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // { ops, validation, reply }
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState([]); // attachments waiting for the next message: {name, type, size, dataBase64}
  const fileRef = useRef(null);
  const endRef = useRef(null);
  const MAX_FILE = 8 * 1024 * 1024;
  async function addFiles(list) {
    const picked = [...(list || [])];
    const small = picked.filter((f) => f.size <= MAX_FILE);
    if (small.length < picked.length) toast(t('Files over 8 MB were left out'), 'err');
    const read = await Promise.all(small.map(readFileAsBase64));
    setFiles((cur) => [...cur, ...read.filter((r) => !cur.some((c) => c.name === r.name && c.size === r.size))]);
  }
  const onDrop = (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); };
  const onPaste = (e) => {
    const items = [...(e.clipboardData?.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (items.length) { e.preventDefault(); addFiles(items); }
  };
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending]);

  async function send() {
    const content = text.trim();
    if ((!content && files.length === 0) || busy) return;
    const sent = files;
    // the log shows what went along; the model gets the files' contents through the route
    const shown = sent.length ? `${content}${content ? '\n' : ''}📎 ${sent.map((f) => f.name).join(', ')}` : content;
    const next = [...messages, { role: 'user', content: content || t('See the attached files.') }];
    setMessages([...messages, { role: 'user', content: shown }]);
    setText('');
    setFiles([]);
    setBusy(true);
    try {
      const r = await api.schematicChat(owner, next, locale(), sent);
      setMessages((m) => [...m, { role: 'assistant', content: [r.reply, r.note].filter(Boolean).join('\n') }]);
      setPending(r.ops.length ? { ops: r.ops, validation: r.validation, reply: r.reply } : null);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    setBusy(true);
    try {
      await api.schematicOps(owner, pending.ops, { summary: `AI edit: ${pending.reply}`.slice(0, 120) });
      setPending(null);
      toast(t('Change applied'));
      onApplied();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  const dropOp = (i) => setPending((p) => {
    const ops = p.ops.filter((_, k) => k !== i);
    return ops.length ? { ...p, ops } : null;
  });

  return (
    <div className="schematic-chat" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <h3>{t('Build with chat')}</h3>
      <div className="chat-log">
        {messages.length === 0 && <p className="hint">{t('Example: “Behringer UMC404HD in rack 1, powered from power strip 1 socket 1, Phones 1 to the captain headset in the cockpit.”')}</p>}
        {messages.map((m, i) => <div key={i} className={`chat-msg ${m.role}`}>{m.content}</div>)}
        {pending && (
          <div className="pending-ops">
            <div className="pending-title">{t('Proposed change')} · {plural(pending.ops.length, 'operation')}
              {pending.validation?.errors?.length ? <span className="chip chip-err"> {plural(pending.validation.errors.length, 'error')}</span> : null}
              {pending.validation?.warnings?.length ? <span className="chip chip-warn"> {plural(pending.validation.warnings.length, 'warning')}</span> : null}
            </div>
            <ol>{pending.ops.map((op, i) => <li key={i}>{describeOp(op)} <button className="btn-icon" title={t('Leave this one out')} onClick={() => dropOp(i)}>×</button></li>)}</ol>
            <div className="btn-row">
              <button className="btn btn-sm btn-primary" disabled={busy} onClick={accept}>{t('Accept')}</button>
              <button className="btn btn-sm" disabled={busy} onClick={() => setPending(null)}>{t('Reject')}</button>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
      {files.length > 0 && (
        <div className="chat-files">
          {files.map((f) => (
            <span key={`${f.name}:${f.size}`} className="chip chat-file" title={`${Math.round(f.size / 1024)} kB`}>
              📎 {f.name} <button className="btn-icon" title={t('Remove attachment')} onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-input">
        <input ref={fileRef} type="file" multiple hidden accept="image/*,.txt,.csv,.tsv,.json,.md,.html,.htm,.xml,.yaml,.yml,.ini,.cfg,.log,.docx,.pdf,.pptx,.xlsx" onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
        <button className="btn" title={t('Attach files: pictures, cable lists, notes, Word or PDF')} onClick={() => fileRef.current?.click()}>📎</button>
        <textarea rows={2} value={text} placeholder={t('What is connected to what? Drop or paste files here too.')} onChange={(e) => setText(e.target.value)} onPaste={onPaste} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={busy || (!text.trim() && files.length === 0)} onClick={send}>{busy ? t('Thinking…') : t('Send')}</button>
      </div>
    </div>
  );
}
