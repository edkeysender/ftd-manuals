import React, { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, GROUPS, MANUAL_TYPES, manualType } from '../api.js';
import { useToast } from '../App.jsx';
import HardwarePicker, { hwDetail } from './HardwarePicker.jsx';

const START_MODES = [
  {
    key: 'blank',
    title: 'Blank — FTD standard template',
    desc: 'Sections 1–3 (revision record, introduction, general info) pre-generated; each manual starts from its own section template.',
  },
  {
    key: 'copy',
    title: 'Draft from an existing module',
    desc: 'Pick a module with Released manuals; each selected manual copies the released doc of the same type (content and revision record).',
  },
  {
    key: 'ai',
    title: 'AI first draft',
    desc: 'AI drafts structure and content of every selected manual from the module metadata; you review them in the editor.',
  },
];

/** Which manual receives the FAT checklist: technician first, then customer, then the software manuals. */
const FAT_ORDER = ['technician', 'customer', 'software-technician', 'software-customer'];
const fatManualOf = (ids) => FAT_ORDER.find((t) => ids.includes(t)) || ids[0];

const STEPS = ['Module', 'Relations', 'Manuals', 'FAT checklist'];

export default function Wizard({ onClose, onCreated }) {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);

  // Step 1
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [category, setCategory] = useState('software');
  const [group, setGroup] = useState('SIM');

  // Step 2 — hardware: [{id}] from the catalog and/or new items created inline; software links
  const [hardware, setHardware] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [swLinked, setSwLinked] = useState(false);
  const [softwares, setSoftwares] = useState([{ name: '', fromVersion: '' }]);

  // Step 3 — which manuals, and how each starts
  const [manuals, setManuals] = useState(['customer', 'technician']);
  const [startMode, setStartMode] = useState('blank');
  const [modules, setModules] = useState([]);
  const [source, setSource] = useState('');

  // Step 4 — FAT checklist
  const [fatMode, setFatMode] = useState('template');

  useEffect(() => {
    api.hardware().then(setCatalog).catch(() => setCatalog([]));
    api.modules().then(setModules).catch(() => setModules([]));
  }, []);

  const cleanSoftwares = swLinked
    ? softwares.filter((s) => s.name.trim()).map((s) => ({ name: s.name.trim(), fromVersion: s.fromVersion.trim() }))
    : [];
  const hasSoftware = cleanSoftwares.length > 0;

  // Software manuals only make sense with a software relation — drop them when it goes away.
  const selectedManuals = manuals.filter((id) => manualType(id).kind !== 'software' || hasSoftware);
  const toggleManual = (id) =>
    setManuals(selectedManuals.includes(id) ? selectedManuals.filter((m) => m !== id) : [...selectedManuals, id]);

  const hwItems = hardware.map((h) => (h.id ? catalog.find((c) => c.id === h.id) || { name: h.id } : h));
  const hasFtdHw = hwItems.some((h) => h.type === 'ftd');

  // Copy sources: modules with a released manual of at least one selected type.
  const sources = modules.filter((m) => selectedManuals.some((id) => m.manuals?.[id]?.released));
  const sourceRow = sources.find((m) => m.slug === source) || null;

  const fatManual = fatManualOf(selectedManuals);

  const summary = useMemo(() => {
    const parts = [
      `${name || '—'}${code ? ` (${code})` : ''}`,
      `${(GROUPS.find(([k]) => k === group) || [])[1]} manual`,
      hwItems.length === 0
        ? 'no hardware'
        : hwItems.length === 1
          ? `${hwItems[0].name} (${hwDetail(hwItems[0])})`
          : `${hwItems.length} hardware units: ${hwItems.map((h) => h.name).join(', ')}`,
      cleanSoftwares.length
        ? `linked to ${cleanSoftwares.map((s) => `${s.name}${s.fromVersion ? ` from ${s.fromVersion}` : ''}`).join(', ')}`
        : 'not software-related',
      selectedManuals.length ? `manuals: ${selectedManuals.map((id) => manualType(id).short).join(', ')}` : 'no manual selected',
      startMode === 'copy'
        ? sourceRow
          ? `copied from ${sourceRow.name}`
          : 'copy of — (pick a source)'
        : START_MODES.find((m) => m.key === startMode)?.title,
      fatMode === 'none'
        ? 'no FAT checklist'
        : `FAT checklist ${fatMode === 'copy' ? 'copied' : 'from template'} on the ${manualType(fatManual).label.toLowerCase()}`,
    ];
    return parts.join(' · ');
  }, [name, code, group, startMode, sourceRow, hardware, catalog, cleanSoftwares, selectedManuals, fatMode, fatManual]);

  const canNext =
    step === 1
      ? name.trim().length > 0
      : step === 3
        ? selectedManuals.length > 0 && (startMode !== 'copy' || source)
        : true;

  async function create() {
    setBusy(true);
    try {
      const created = await api.createModule({
        name: name.trim(),
        code: code.trim() || null,
        category,
        group,
        hardware,
        softwares: cleanSoftwares,
        manuals: selectedManuals,
        checklist: { mode: fatMode },
        start: startMode === 'copy' ? { mode: 'copy', sourceSlug: source } : { mode: startMode },
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
            {STEPS.map((label, i) => (
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
                <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Instructor intercom panel" />
              </label>
              <label>
                Code
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="IOS-ICP" />
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
                <span className="field-label">Manual group — which assembled manual this module's mini-manuals join</span>
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
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Hardware — the unit types this module's manuals describe</span>
                <p className="muted small">
                  Assign existing units from the shared catalog or create new ones. One module can cover several unit
                  types (e.g. a central unit and two handsets): each gets its own subsection in the per-unit sections, its
                  own row in General information and in the FAT protocol.
                </p>
                <HardwarePicker catalog={catalog} value={hardware} onChange={setHardware} />
              </div>

              <div className="field">
                <span className="field-label">Software relation — enables the software manuals (customer / technician)</span>
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
                          placeholder="Software name (2N Access Unit)"
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

          {step === 3 && (
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Manuals — one mini-manual per audience, each with its own versions and draft branch</span>
                <div className="manual-choices">
                  {MANUAL_TYPES.map((t) => {
                    const disabled = t.kind === 'software' && !hasSoftware;
                    const on = selectedManuals.includes(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`manual-choice ${on ? 'selected' : ''}`}
                        disabled={disabled}
                        title={disabled ? 'Link the module to a software (step 2) to document it' : ''}
                        onClick={() => toggleManual(t.id)}
                      >
                        <strong>
                          <input type="checkbox" checked={on} readOnly tabIndex={-1} /> {t.label}{' '}
                          <span className={`manual-kind ${t.kind}`}>{t.kind}</span>
                        </strong>
                        <span>{t.desc}</span>
                        <span className="sections">{t.sections.join(' · ')}</span>
                      </button>
                    );
                  })}
                </div>
                {!hasSoftware && <span className="hint">Software manuals become available once the module is linked to a software (step 2).</span>}
              </div>

              <div className="field">
                <span className="field-label">Starting content</span>
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
                      Source module (Released manuals only)
                      <select value={source} onChange={(e) => setSource(e.target.value)}>
                        <option value="">— pick a module —</option>
                        {sources.map((m) => (
                          <option key={m.slug} value={m.slug}>
                            {m.name} ·{' '}
                            {selectedManuals
                              .filter((id) => m.manuals?.[id]?.released)
                              .map((id) => `${manualType(id).short} ${m.manuals[id].released}`)
                              .join(', ')}
                          </option>
                        ))}
                      </select>
                      {sources.length === 0 ? (
                        <span className="hint">No module has a released manual of the selected types yet — release one first, or pick another mode.</span>
                      ) : (
                        sourceRow && (
                          <span className="hint">
                            Manuals the source has not released start from the blank template:{' '}
                            {selectedManuals.filter((id) => !sourceRow.manuals?.[id]?.released).map((id) => manualType(id).short).join(', ') || 'none'}.
                          </span>
                        )
                      )}
                    </label>
                  )}
                </div>
              </div>

              <div className="summary-line">{summary}</div>
            </div>
          )}

          {step === 4 && (
            <div className="form-grid">
              <div className="field">
                <span className="field-label">Factory acceptance test checklist</span>
                <p className="muted small">
                  A separate document generated next to the <strong>{manualType(fatManual).label.toLowerCase()}</strong> for
                  its doc version: identification, checks per phase with expected results, non-conformances and sign-off.
                  Items are edited in the editor's FAT tab; the assistant can derive them from the manual's procedures.
                </p>
                <div className="choice-cards">
                  {[
                    ['template', 'Start from the category template', `Phases and checks typical for ${(CATEGORIES.find(([k]) => k === category) || [])[1] || category} modules${hasFtdHw ? ', incl. calibration' : ''}${cleanSoftwares.length ? ', incl. software version checks' : ''}. Review the TODO(author) items.`],
                    ...(startMode === 'copy' ? [['copy', 'Copy from the source module', 'Takes the checklist of the copied doc version (falls back to the template when it has none).']] : []),
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
          {step < STEPS.length ? (
            <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
              Next →
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || !selectedManuals.length} onClick={create}>
              {busy
                ? startMode === 'ai'
                  ? 'Drafting with AI…'
                  : 'Creating…'
                : `Create ${selectedManuals.length} draft${selectedManuals.length === 1 ? '' : 's'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
