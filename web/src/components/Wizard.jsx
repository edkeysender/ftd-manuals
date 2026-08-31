import React, { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, GROUPS } from '../api.js';
import { useToast } from '../App.jsx';
import HardwarePicker, { hwDetail } from './HardwarePicker.jsx';

const START_MODES = [
  {
    key: 'blank',
    title: 'Blank — FTD standard template',
    desc: 'Sections 1–3 (revision record, introduction, general info) pre-generated; you write the module content.',
  },
  {
    key: 'copy',
    title: 'Draft from an existing manual',
    desc: 'Pick any Released doc of any module; full content and revision record are copied, version bumps.',
  },
  {
    key: 'ai',
    title: 'AI first draft',
    desc: 'AI drafts structure and content from the module metadata; you review it in the editor.',
  },
];

export default function Wizard({ onClose, onCreated }) {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  // Step 1
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [category, setCategory] = useState('software');
  const [group, setGroup] = useState('SIM');

  // Step 2
  const [startMode, setStartMode] = useState('blank');
  const [releasedDocs, setReleasedDocs] = useState([]);
  const [source, setSource] = useState('');

  // Step 3 — hardware: [{id}] from the catalog and/or new items created inline
  const [hardware, setHardware] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [swLinked, setSwLinked] = useState(false);
  const [softwares, setSoftwares] = useState([{ name: '', fromVersion: '' }]);

  // Step 4 — FAT checklist
  const [fatMode, setFatMode] = useState('template');

  useEffect(() => {
    api.hardware().then(setCatalog).catch(() => setCatalog([]));
    api.modules().then((mods) => {
      const opts = [];
      for (const m of mods) {
        // only released doc versions can be copied
        if (m.status === 'released' || m.latestDoc) {
          opts.push(m);
        }
      }
      // fetch full docs lists lazily per module is overkill — ask detail for released ones
      Promise.all(opts.map((m) => api.module(m.slug).catch(() => null))).then((details) => {
        const docs = [];
        for (const d of details) {
          if (!d) continue;
          for (const doc of d.docs) {
            if (doc.status === 'released') docs.push({ slug: d.module.slug, name: d.module.name, version: doc.version });
          }
        }
        setReleasedDocs(docs);
      });
    });
  }, []);

  const cleanSoftwares = swLinked
    ? softwares.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), fromVersion: s.fromVersion.trim() }))
    : [];

  const hwItems = hardware.map((h) => (h.id ? catalog.find((c) => c.id === h.id) || { name: h.id } : h));
  const hasFtdHw = hwItems.some((h) => h.type === 'ftd');

  const summary = useMemo(() => {
    const parts = [
      `${name || '—'}${code ? ` (${code})` : ''}`,
      `${(GROUPS.find(([k]) => k === group) || [])[1]} manual`,
      START_MODES.find((m) => m.key === startMode)?.title,
      hwItems.length === 0
        ? 'no hardware'
        : hwItems.length === 1
          ? `${hwItems[0].name} (${hwDetail(hwItems[0])})`
          : `${hwItems.length} hardware units: ${hwItems.map((h) => h.name).join(', ')}`,
      cleanSoftwares.length
        ? `linked to ${cleanSoftwares.map((s) => `${s.name}${s.fromVersion ? ` from ${s.fromVersion}` : ''}`).join(', ')}`
        : 'not software-related',
      fatMode === 'none' ? 'no FAT checklist' : fatMode === 'copy' ? 'FAT checklist copied' : 'FAT checklist from template',
    ];
    if (startMode === 'copy') {
      const src = releasedDocs.find((d) => `${d.slug}|${d.version}` === source);
      parts[2] = src ? `copy of ${src.name} ${src.version}` : 'copy of — (pick a source)';
    }
    return parts.join(' · ');
  }, [name, code, group, startMode, source, releasedDocs, hardware, catalog, cleanSoftwares, fatMode]);

  const canNext =
    step === 1 ? name.trim().length > 0 : step === 2 ? (startMode !== 'copy' || source) : true;

  async function create() {
    setBusy(true);
    try {
      const [sourceSlug, sourceVersion] = source.split('|');
      const created = await api.createModule({
        name: name.trim(),
        code: code.trim() || null,
        category,
        group,
        hardware,
        softwares: cleanSoftwares,
        checklist: { mode: fatMode },
        start:
          startMode === 'copy'
            ? { mode: 'copy', sourceSlug, sourceVersion }
            : { mode: startMode },
      });
      onCreated(created);
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wizard">
        <div className="modal-head">
          <h2>New module doc</h2>
          <div className="steps">
            {['Module', 'Starting content', 'Relations', 'FAT checklist'].map((label, i) => (
              <span key={label} className={`step ${step === i + 1 ? 'active' : ''} ${step > i + 1 ? 'done' : ''}`}>
                {i + 1} · {label}
              </span>
            ))}
          </div>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          {step === 1 && (
            <div className="form-grid">
              <label>
                Module name <span className="req">*</span>
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Starting panel" />
              </label>
              <label>
                Code
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SW-STP" />
              </label>
              <label>
                Category
                <select value={category} onChange={(e) => setCategory(e.target.value)}>
                  {CATEGORIES.map(([k, l]) => (
                    <option key={k} value={k}>{l}</option>
                  ))}
                </select>
              </label>
              <div className="field">
                <span className="field-label">Manual group — which assembled manual this mini-manual joins</span>
                <div className="choice-row">
                  {GROUPS.map(([k, l]) => (
                    <button
                      key={k}
                      type="button"
                      className={`choice ${group === k ? 'selected' : ''}`}
                      onClick={() => setGroup(k)}
                    >
                      {l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="choice-cards">
              {START_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={`choice-card ${startMode === m.key ? 'selected' : ''}`}
                  onClick={() => setStartMode(m.key)}
                >
                  <strong>{m.title}</strong>
                  <span>{m.desc}</span>
                </button>
              ))}
              {startMode === 'copy' && (
                <label className="full">
                  Source doc (Released only)
                  <select value={source} onChange={(e) => setSource(e.target.value)}>
                    <option value="">— pick a released doc —</option>
                    {releasedDocs.map((d) => (
                      <option key={`${d.slug}|${d.version}`} value={`${d.slug}|${d.version}`}>
                        {d.name} · {d.version}
                      </option>
                    ))}
                  </select>
                  {releasedDocs.length === 0 && (
                    <span className="hint">No released docs exist yet — release one first, or pick another mode.</span>
                  )}
                </label>
              )}
            </div>
          )}

          {step === 3 && (
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Hardware — the unit types this manual describes</span>
                <p className="muted small">
                  Assign existing units from the shared catalog or create new ones. One manual can cover several unit
                  types (e.g. three camera models): each gets its own subsection in Installation and Operation and its own
                  row in General information and the FAT protocol.
                </p>
                <HardwarePicker catalog={catalog} value={hardware} onChange={setHardware} />
              </div>

              <div className="field">
                <span className="field-label">Software relation (optional)</span>
                <div className="choice-row">
                  <button type="button" className={`choice ${!swLinked ? 'selected' : ''}`} onClick={() => setSwLinked(false)}>
                    Not software-related
                  </button>
                  <button type="button" className={`choice ${swLinked ? 'selected' : ''}`} onClick={() => setSwLinked(true)}>
                    Linked to software
                  </button>
                </div>
                {swLinked && (
                  <div className="sw-rows">
                    {softwares.map((s, i) => (
                      <div className="pair" key={i}>
                        <input
                          value={s.name}
                          placeholder="Software name (STP Core)"
                          onChange={(e) => setSoftwares(softwares.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                        />
                        <input
                          value={s.fromVersion}
                          placeholder="From version (v2.0.0)"
                          onChange={(e) =>
                            setSoftwares(softwares.map((x, j) => (j === i ? { ...x, fromVersion: e.target.value } : x)))
                          }
                        />
                        {softwares.length > 1 && (
                          <button className="btn-icon" onClick={() => setSoftwares(softwares.filter((_, j) => j !== i))}>
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                    <button className="btn btn-ghost" onClick={() => setSoftwares([...softwares, { name: '', fromVersion: '' }])}>
                      + Add another software
                    </button>
                  </div>
                )}
              </div>

              <div className="summary-line">{summary}</div>
            </div>
          )}

          {step === 4 && (
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Factory acceptance test checklist</span>
                <p className="muted small">
                  A separate document generated next to the manual for this doc version: identification, checks per phase with
                  expected results, non-conformances and sign-off. Items are edited in the editor's FAT tab; the assistant can
                  derive them from the manual's procedures.
                </p>
                <div className="choice-cards">
                  {[
                    ['template', 'Start from the category template', `Phases and checks typical for ${(CATEGORIES.find(([k]) => k === category) || [])[1] || category} modules${hasFtdHw ? ', incl. calibration' : ''}${cleanSoftwares.length ? ', incl. software version checks' : ''}. Review the TODO(author) items.`],
                    ...(startMode === 'copy' ? [['copy', 'Copy from the source manual', 'Takes the checklist of the copied doc version (falls back to the template when it has none).']] : []),
                    ['none', 'No FAT checklist', 'This module is not acceptance-tested on its own. One can be added later in the editor.'],
                  ].map(([k, title, desc]) => (
                    <button key={k} type="button" className={`choice-card ${fatMode === k ? 'selected' : ''}`} onClick={() => setFatMode(k)}>
                      {title}
                      <span>{desc}</span>
                    </button>
                  ))}
                </div>
              </div>
              <div className="summary-line">{summary}</div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          {step > 1 ? (
            <button className="btn" onClick={() => setStep(step - 1)}>← Back</button>
          ) : (
            <span />
          )}
          {step < 4 ? (
            <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next →
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={create}>
              {busy ? (startMode === 'ai' ? 'Drafting with AI…' : 'Creating…') : 'Create draft'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
