import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, schematicSvgUrl, askReleaseNote } from '../api.js';
import ActionMenu from './ActionMenu.jsx';
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

  const load = useCallback(() => api.schematic(owner).then(setData).catch((e) => (e.code === 'no-schematic' || e.status === 404 ? setData(null) : toast(e.message, 'err'))), [owner]);
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

  const { state, released, isDraft, editable, validation, schedule, face } = data;
  const errors = validation.errors.length;
  const warnings = validation.warnings.length;

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

      <div className="tabs">
        <button className={tab === 'drawing' ? 'active' : ''} onClick={() => setTab('drawing')}>{t('Drawing')}</button>
        <button className={tab === 'cables' ? 'active' : ''} onClick={() => setTab('cables')}>{t('Cable schedule')}{schedule.length ? ` (${schedule.length})` : ''}</button>
        {face.length > 0 && <button className={tab === 'face' ? 'active' : ''} onClick={() => setTab('face')}>{t('External ports')} ({face.length})</button>}
        <button className={tab === 'checks' ? 'active' : ''} onClick={() => setTab('checks')}>{t('Checks')}{errors + warnings ? ` (${errors + warnings})` : ''}</button>
      </div>

      {tab === 'drawing' && (
        <div className="schematic-drawing">
          <img src={schematicSvgUrl(owner, { lang: locale(), v })} alt={t('Schematic')} />
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

/** The chat drawer: a sentence in, operations out, accepted as one commit or rejected. */
function SchematicChat({ owner, onApplied }) {
  const toast = useToast();
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null); // { ops, validation, reply }
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages, pending]);

  async function send() {
    const content = text.trim();
    if (!content || busy) return;
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setText('');
    setBusy(true);
    try {
      const r = await api.schematicChat(owner, next, locale());
      setMessages([...next, { role: 'assistant', content: [r.reply, r.note].filter(Boolean).join('\n') }]);
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
    <div className="schematic-chat">
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
      <div className="chat-input">
        <textarea rows={2} value={text} placeholder={t('What is connected to what?')} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>{busy ? t('Thinking…') : t('Send')}</button>
      </div>
    </div>
  );
}
