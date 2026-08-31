import React, { useMemo, useState } from 'react';

/**
 * Pick the hardware units a module manual describes: any number of items from the
 * shared catalog, plus new items created inline (they join the catalog on save).
 *
 * value: array of { id } (existing) or { name, type, version | manufacturer, model, notes } (new)
 * catalog: [{ id, name, type, version, manufacturer, model, notes, usedBy }]
 */
export const HW_TYPES = [
  ['ftd', 'FTD.aero build'],
  ['cots', 'Bought (COTS)'],
];

export const hwDetail = (h) =>
  !h ? '' : h.type === 'ftd' ? `FTD.aero · ${h.version || 'v1'}` : `COTS · ${[h.manufacturer, h.model].filter(Boolean).join(' ')}`.trim();

const emptyForm = { name: '', type: 'ftd', version: 'v1', manufacturer: '', model: '', notes: '' };

/** Inline create/edit form for one catalog item. */
export function HardwareForm({ initial, onSubmit, onCancel, submitLabel = 'Add' }) {
  const [f, setF] = useState({ ...emptyForm, ...(initial || {}) });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const valid = f.name.trim().length > 0;
  return (
    <div className="hw-form">
      <label className="inline">
        Unit name <span className="req">*</span>
        <input autoFocus value={f.name} onChange={set('name')} placeholder="Cockpit camera — PTZ dome" />
      </label>
      <div className="choice-row">
        {HW_TYPES.map(([k, l]) => (
          <button key={k} type="button" className={`choice ${f.type === k ? 'selected' : ''}`} onClick={() => setF({ ...f, type: k })}>
            {l}
          </button>
        ))}
      </div>
      {f.type === 'ftd' ? (
        <label className="inline">
          Hardware version
          <input value={f.version} onChange={set('version')} placeholder="v2" />
        </label>
      ) : (
        <div className="pair">
          <label className="inline">
            Manufacturer
            <input value={f.manufacturer} onChange={set('manufacturer')} placeholder="Axis" />
          </label>
          <label className="inline">
            Model / part no
            <input value={f.model} onChange={set('model')} placeholder="M5075-G" />
          </label>
        </div>
      )}
      <label className="inline">
        Notes (shown in the manual's General information)
        <input value={f.notes} onChange={set('notes')} placeholder="Mounted above the instructor station; PoE" />
      </label>
      <div className="btn-row">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!valid}
          onClick={() => {
            const out = { name: f.name.trim(), type: f.type, notes: f.notes.trim() };
            if (f.type === 'ftd') out.version = f.version.trim() || 'v1';
            else {
              out.manufacturer = f.manufacturer.trim();
              out.model = f.model.trim();
            }
            onSubmit(out);
          }}
        >
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-sm" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

export default function HardwarePicker({ catalog, value, onChange, disabled = false }) {
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);

  const byId = useMemo(() => new Map((catalog || []).map((i) => [i.id, i])), [catalog]);
  const selectedIds = new Set(value.filter((v) => v.id).map((v) => v.id));
  const resolved = value.map((v) => (v.id ? byId.get(v.id) || { ...v, name: v.id, missing: true } : v));

  const available = (catalog || []).filter((i) => {
    if (selectedIds.has(i.id)) return false;
    const s = q.trim().toLowerCase();
    return !s || [i.name, i.manufacturer, i.model, i.version].filter(Boolean).some((x) => x.toLowerCase().includes(s));
  });

  const remove = (idx) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div className="hw-picker">
      {resolved.length === 0 ? (
        <div className="muted small">No hardware assigned — this manual is not tied to a physical unit.</div>
      ) : (
        <ul className="hw-list">
          {resolved.map((h, i) => (
            <li key={h.id || `new-${i}`} className="hw-item">
              <div>
                <strong>{h.name}</strong>
                {!h.id && <span className="chip chip-new">new</span>}
                {h.missing && <span className="chip chip-warn">not in catalog</span>}
                <div className="muted small">
                  {hwDetail(h)}
                  {h.notes ? ` — ${h.notes}` : ''}
                </div>
              </div>
              {!disabled && (
                <button type="button" className="btn-icon" title="Unassign" onClick={() => remove(i)}>
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {!disabled && (
        <div className="hw-add">
          <div className="pair">
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Assign from catalog — search by name, maker, model…" />
            <button type="button" className="btn btn-sm" onClick={() => setCreating(!creating)}>
              {creating ? 'Close' : '+ New hardware'}
            </button>
          </div>
          {creating && (
            <HardwareForm
              onSubmit={(item) => {
                onChange([...value, item]);
                setCreating(false);
              }}
              onCancel={() => setCreating(false)}
              submitLabel="Add to this module"
            />
          )}
          {!creating && (
            <div className="hw-catalog">
              {available.length === 0 ? (
                <span className="muted small">
                  {(catalog || []).length === 0 ? 'Catalog is empty — create the first unit with + New hardware.' : q ? 'No match.' : 'All catalog items assigned.'}
                </span>
              ) : (
                available.slice(0, 12).map((i) => (
                  <button key={i.id} type="button" className="hw-option" onClick={() => onChange([...value, { id: i.id }])}>
                    <span>
                      <strong>{i.name}</strong> <span className="muted small">{hwDetail(i)}</span>
                    </span>
                    {i.usedBy?.length > 0 && (
                      <span className="muted small" title={i.usedBy.map((m) => m.name).join(', ')}>
                        used by {i.usedBy.length}
                      </span>
                    )}
                  </button>
                ))
              )}
              {available.length > 12 && <span className="muted small">{available.length - 12} more — narrow the search.</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
