import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';
import { t, plural } from '../i18n.jsx';

const TYPES = [
  ['check', 'Check'],
  ['measure', 'Measure'],
  ['record', 'Record'],
];

const blankItem = () => ({ check: '', expected: '', type: 'check', unit: '', ref: '', mandatory: true });
const blankPhase = () => ({ title: t('New phase'), items: [blankItem()] });

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
    const summary = window.prompt(t('Revision summary (goes into the revision record):'), remove ? 'FAT checklist removed' : 'FAT checklist update');
    if (summary === null) return;
    setBusy(true);
    try {
      const r = await api.saveChecklist(slug, version, remove ? null : draft, summary);
      toast(remove ? t('FAT checklist removed') : t('FAT checklist saved — r{revision}', { revision: r.doc.revision }));
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
        <h3>{t('No FAT checklist for {version}', { version })}</h3>
        <p className="muted">
          {t('A factory acceptance test checklist is a separate document generated next to the manual: identification, checks per phase with expected results, non-conformances and sign-off.')}
        </p>
        {editable && (
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!template} onClick={() => { setDraft(template); setDirty(true); }}>
              {t('Start from category template')}
            </button>
            <button className="btn" onClick={() => { setDraft({ enabled: true, phases: [blankPhase()] }); setDirty(true); }}>
              {t('Start blank')}
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
          {plural(draft.phases.length, 'phase')} · {plural(count, 'check')}
          {dirty && <strong> · {t('unsaved')}</strong>}
        </span>
        <div className="toolbar-spacer" />
        {checklist && (
          <a className="btn btn-sm" href={`/api/modules/${slug}/docs/${version}/checklist.html`} target="_blank" rel="noreferrer" title={t("Opens the blank FAT protocol — use the browser's Print for PDF")}>
            {t('Open / print')}
          </a>
        )}
        {editable && (
          <>
            <button className="btn btn-sm" disabled={!template} onClick={() => { if (confirm(t('Replace the checklist with the category template?'))) { setDraft(template); setDirty(true); } }}>
              {t('Reset to template')}
            </button>
            <button className="btn btn-sm btn-primary" disabled={busy || !dirty} onClick={() => save(false)}>
              {t('Save checklist (commit revision)')}
            </button>
            {checklist && (
              <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => confirm(t('Remove the FAT checklist from this doc version?')) && save(true)}>
                {t('Remove')}
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
                    <button className="btn-icon" title={t('Move up')} disabled={pi === 0} onClick={() => update((d) => { const [p] = d.phases.splice(pi, 1); d.phases.splice(pi - 1, 0, p); })}>↑</button>
                    <button className="btn-icon" title={t('Move down')} disabled={pi === draft.phases.length - 1} onClick={() => update((d) => { const [p] = d.phases.splice(pi, 1); d.phases.splice(pi + 1, 0, p); })}>↓</button>
                    <button className="btn-icon" title={t('Remove phase')} onClick={() => confirm(t('Remove phase “{title}”?', { title: phase.title })) && update((d) => { d.phases.splice(pi, 1); })}>✕</button>
                  </span>
                )}
              </div>
              <table className="fat-table">
                <thead>
                  <tr>
                    <th style={{ width: 56 }}>#</th>
                    <th>{t('Check')}</th>
                    <th style={{ width: '24%' }}>{t('Expected')}</th>
                    <th style={{ width: 96 }}>{t('Type')}</th>
                    <th style={{ width: 90 }}>{t('Ref')}</th>
                    <th style={{ width: 40 }} title={t('Mandatory')}>{t('Mand.')}</th>
                    {editable && <th style={{ width: 34 }} />}
                  </tr>
                </thead>
                <tbody>
                  {phase.items.map((it, ii) => (
                    <tr key={ii} className={it.mandatory ? '' : 'optional'}>
                      <td className="muted mono">{it.id || '—'}</td>
                      <td>
                        {editable ? (
                          <textarea rows={1} value={it.check} placeholder={t('What is checked')} onChange={(e) => update((d) => { d.phases[pi].items[ii].check = e.target.value; })} />
                        ) : it.check}
                      </td>
                      <td>
                        {editable ? (
                          <div className="fat-expected">
                            <textarea rows={1} value={it.expected} placeholder={it.type === 'record' ? t('(value recorded)') : it.type === 'measure' ? t('limits') : t('expected result')} onChange={(e) => update((d) => { d.phases[pi].items[ii].expected = e.target.value; })} />
                            {it.type === 'measure' && (
                              <input className="fat-unit" value={it.unit || ''} placeholder={t('unit')} onChange={(e) => update((d) => { d.phases[pi].items[ii].unit = e.target.value; })} />
                            )}
                          </div>
                        ) : (
                          <>{it.expected}{it.unit ? ` [${it.unit}]` : ''}</>
                        )}
                      </td>
                      <td>
                        {editable ? (
                          <select value={it.type} onChange={(e) => update((d) => { d.phases[pi].items[ii].type = e.target.value; })}>
                            {TYPES.map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}
                          </select>
                        ) : t(TYPES.find(([k]) => k === it.type)?.[1] || '')}
                      </td>
                      <td>
                        {editable ? (
                          <input value={it.ref || ''} placeholder={t('Operation')} onChange={(e) => update((d) => { d.phases[pi].items[ii].ref = e.target.value; })} />
                        ) : it.ref}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <input type="checkbox" checked={it.mandatory !== false} disabled={!editable} onChange={(e) => update((d) => { d.phases[pi].items[ii].mandatory = e.target.checked; })} />
                      </td>
                      {editable && (
                        <td>
                          <button className="btn-icon" title={t('Remove item')} onClick={() => update((d) => { d.phases[pi].items.splice(ii, 1); })}>✕</button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
              {editable && (
                <button className="btn btn-ghost btn-sm" onClick={() => update((d) => { d.phases[pi].items.push(blankItem()); })}>{t('+ Add check')}</button>
              )}
            </section>
          ))}
          {editable && (
            <button className="btn btn-ghost" onClick={() => update((d) => { d.phases.push(blankPhase()); })}>{t('+ Add phase')}</button>
          )}
        </div>
      </div>
    </div>
  );
}
