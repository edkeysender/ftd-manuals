import React, { useEffect, useMemo, useState } from 'react';
import { api, CATEGORIES, GROUPS } from '../api.js';
import { useToast } from '../App.jsx';

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

  // Step 3
  const [hwType, setHwType] = useState('none');
  const [hwVersion, setHwVersion] = useState('v1');
  const [hwMaker, setHwMaker] = useState('');
  const [hwModel, setHwModel] = useState('');
  const [swLinked, setSwLinked] = useState(false);
  const [softwares, setSoftwares] = useState([{ name: '', fromVersion: '' }]);

  useEffect(() => {
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

  const hardware = useMemo(() => {
    if (hwType === 'ftd') return { type: 'ftd', version: hwVersion.trim() || 'v1' };
    if (hwType === 'cots') return { type: 'cots', manufacturer: hwMaker.trim(), model: hwModel.trim() };
    return { type: 'none' };
  }, [hwType, hwVersion, hwMaker, hwModel]);

  const summary = useMemo(() => {
    const parts = [
      `${name || '—'}${code ? ` (${code})` : ''}`,
      `${(GROUPS.find(([k]) => k === group) || [])[1]} manual`,
      START_MODES.find((m) => m.key === startMode)?.title,
      hwType === 'none'
        ? 'no hardware'
        : hwType === 'ftd'
          ? `FTD.aero build ${hwVersion}`
          : `COTS ${hwMaker} ${hwModel}`.trim(),
      cleanSoftwares.length
        ? `linked to ${cleanSoftwares.map((s) => `${s.name}${s.fromVersion ? ` from ${s.fromVersion}` : ''}`).join(', ')}`
        : 'not software-related',
    ];
    if (startMode === 'copy') {
      const src = releasedDocs.find((d) => `${d.slug}|${d.version}` === source);
      parts[2] = src ? `copy of ${src.name} ${src.version}` : 'copy of — (pick a source)';
    }
    return parts.join(' · ');
  }, [name, code, group, startMode, source, releasedDocs, hwType, hwVersion, hwMaker, hwModel, cleanSoftwares]);

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
            {['Module', 'Starting content', 'Relations'].map((label, i) => (
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
                <span className="field-label">Hardware</span>
                <div className="choice-row">
                  {[
                    ['ftd', 'FTD.aero build'],
                    ['cots', 'Bought (COTS)'],
                    ['none', 'No hardware'],
                  ].map(([k, l]) => (
                    <button key={k} type="button" className={`choice ${hwType === k ? 'selected' : ''}`} onClick={() => setHwType(k)}>
                      {l}
                    </button>
                  ))}
                </div>
                {hwType === 'ftd' && (
                  <label className="inline">
                    Hardware version
                    <input value={hwVersion} onChange={(e) => setHwVersion(e.target.value)} placeholder="v2" />
                  </label>
                )}
                {hwType === 'cots' && (
                  <div className="pair">
                    <label className="inline">
                      Manufacturer
                      <input value={hwMaker} onChange={(e) => setHwMaker(e.target.value)} placeholder="Brunner" />
                    </label>
                    <label className="inline">
                      Model / part no
                      <input value={hwModel} onChange={(e) => setHwModel(e.target.value)} placeholder="CLS-E MK II" />
                    </label>
                  </div>
                )}
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
        </div>

        <div className="modal-foot">
          {step > 1 ? (
            <button className="btn" onClick={() => setStep(step - 1)}>← Back</button>
          ) : (
            <span />
          )}
          {step < 3 ? (
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
