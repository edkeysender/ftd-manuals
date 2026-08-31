import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';

const TYPES = [
  ['check', 'Check'],
  ['measure', 'Measure'],
  ['record', 'Record'],
];

const blankItem = () => ({ check: '', expected: '', type: 'check', unit: '', ref: '', mandatory: true });
const blankPhase = () => ({ title: 'New phase', items: [blankItem()] });

/**
 * FAT checklist tab of the editor. Edits the whole checklist locally and
 * commits it as one revision (same rule as manual content).
 */
export default function ChecklistEditor({ slug, version, editable, checklist, onSaved }) {
  const toast = useToast();
  const [draft, setDraft] = useState(checklist);
  const [template, setTemplate] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(checklist);
    setDirty(false);
  }, [checklist]);

  useEffect(() => {
    api.checklist(slug, version).then((r) => setTemplate(r.template)).catch(() => {});
  }, [slug, version]);

  const count = useMemo(() => (draft?.phases || []).reduce((n, p) => n + p.items.filter((i) => i.check.trim()).length, 0), [draft]);

  function update(fn) {
    setDraft((d) => {
      const next = JSON.parse(JSON.stringify(d || { enabled: true, phases: [] }));
      fn(next);
      return next;
    });
    setDirty(true);
  }

  async function save(remove = false) {
    const summary = window.prompt('Revision summary (goes into the revision record):', remove ? 'FAT checklist removed' : 'FAT checklist update');
    if (summary === null) return;
    setBusy(true);
    try {
      const r = await api.saveChecklist(slug, version, remove ? null : draft, summary);
      toast(remove ? 'FAT checklist removed' : `FAT checklist saved — r${r.doc.revision}`);
      setDirty(false);
      onSaved(r);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  if (!draft) {
    return (
      <div className="fat-empty">
        <h3>No FAT checklist for {version}</h3>
        <p className="muted">
          A factory acceptance test checklist is a separate document generated next to the manual: identification, checks per phase
          with expected results, non-conformances and sign-off.
        </p>
        {editable && (
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!template} onClick={() => { setDraft(template); setDirty(true); }}>
              Start from category template
            </button>
            <button className="btn" onClick={() => { setDraft({ enabled: true, phases: [blankPhase()] }); setDirty(true); }}>
              Start blank
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="fat-editor">
      <div className="toolbar">
        <span className="muted">
          {draft.phases.length} phase{draft.phases.length === 1 ? '' : 's'} · {count} checks
          {dirty && <strong> · unsaved</strong>}
        </span>
        <div className="toolbar-spacer" />
        {checklist && (
          <a className="btn btn-sm" href={`/api/modules/${slug}/docs/${version}/checklist.html`} target="_blank" rel="noreferrer" title="Opens the blank FAT protocol — use the browser's Print for PDF">
            Open / print
          </a>
        )}
        {editable && (
          <>
            <button className="btn btn-sm" disabled={!template} onClick={() => { if (confirm('Replace the checklist with the category template?')) { setDraft(template); setDirty(true); } }}>
              Reset to template
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => save(false)}>
              Save checklist (commit revision)
            </button>
            {checklist && (
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm('Remove the FAT checklist from this doc version?') && save(true)}>
                Remove
              </button>
            )}
          </>
        )}
      </div>

      <div className="doc-scroll">
        <div className="doc-page fat-page">
          {draft.phases.map((phase, pi) => (
            <section key={pi} className="fat-phase">
              <div className="fat-phase-head">
                {editable ? (
                  <input className="fat-phase-title" value={phase.title} onChange={(e) => update((d) => { d.phases[pi].title = e.target.value; })} />
                ) : (
                  <h3>{phase.title}</h3>
                )}
                {editable && (
                  <span className="btn-row">
                    <button className="btn-icon" title="Move up" disabled={pi === 0} onClick={() => update((d) => { const [p] = d.phases.splice(pi, 1); d.phases.splice(pi - 1, 0, p); })}>↑</button>
                    <button className="btn-icon" title="Move down" disabled={pi === draft.phases.length - 1} onClick={() => update((d) => { const [p] = d.phases.splice(pi, 1); d.phases.splice(pi + 1, 0, p); })}>↓</button>
                    <button className="btn-icon" title="Remove phase" onClick={() => confirm(`Remove phase “${phase.title}”?`) && update((d) => { d.phases.splice(pi, 1); })}>✕</button>
                  </span>
                )}
              </div>
              <table className="fat-table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>#</th>
                    <th>Check</th>
                    <th style={{ width: '24%' }}>Expected</th>
                    <th style={{ width: 96 }}>Type</th>
                    <th style={{ width: 90 }}>Ref</th>
                    <th style={{ width: 40 }} title="Mandatory">Mand.</th>
                    {editable && <th style={{ width: 34 }} />}
                  </tr>
                </thead>
                <tbody>
                  {phase.items.map((it, ii) => (
                    <tr key={ii} className={it.mandatory ? '' : 'optional'}>
                      <td className="muted mono">{it.id || '—'}</td>
                      <td>
                        {editable ? (
                          <textarea rows={1} value={it.check} placeholder="What is checked" onChange={(e) => update((d) => { d.phases[pi].items[ii].check = e.target.value; })} />
                        ) : it.check}
                      </td>
                      <td>
                        {editable ? (
                          <div className="fat-expected">
                            <textarea rows={1} value={it.expected} placeholder={it.type === 'record' ? '(value recorded)' : it.type === 'measure' ? 'limits' : 'expected result'} onChange={(e) => update((d) => { d.phases[pi].items[ii].expected = e.target.value; })} />
                            {it.type === 'measure' && (
                              <input className="fat-unit" value={it.unit || ''} placeholder="unit" onChange={(e) => update((d) => { d.phases[pi].items[ii].unit = e.target.value; })} />
                            )}
                          </div>
                        ) : (
                          <>{it.expected}{it.unit ? ` [${it.unit}]` : ''}</>
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <select value={it.type} onChange={(e) => update((d) => { d.phases[pi].items[ii].type = e.target.value; })}>
                            {TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                          </select>
                        ) : TYPES.find(([k]) => k === it.type)?.[1]}
                      </td>
                      <td>
                        {editable ? (
                          <input value={it.ref || ''} placeholder="Operation" onChange={(e) => update((d) => { d.phases[pi].items[ii].ref = e.target.value; })} />
                        ) : it.ref}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={it.mandatory !== false} disabled={!editable} onChange={(e) => update((d) => { d.phases[pi].items[ii].mandatory = e.target.checked; })} />
                      </td>
                      {editable && (
                        <td>
                          <button className="btn-icon" title="Remove item" onClick={() => update((d) => { d.phases[pi].items.splice(ii, 1); })}>✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {editable && (
                <button className="btn btn-ghost btn-sm" onClick={() => update((d) => { d.phases[pi].items.push(blankItem()); })}>+ Add check</button>
              )}
            </section>
          ))}
          {editable && (
            <button className="btn btn-ghost" onClick={() => update((d) => { d.phases.push(blankPhase()); })}>+ Add phase</button>
          )}
        </div>
      </div>
    </div>
  );
}
