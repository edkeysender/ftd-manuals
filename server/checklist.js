/**
 * FAT (Factory Acceptance Test) checklist per module doc version.
 *
 * Stored as modules/<slug>/docs/<version>/checklist.json next to the manual
 * content, on the same draft branch, with the same revision counter and the
 * same release freeze — a FAT protocol always refers to one manual version.
 *
 * Shape:
 *   { enabled: true, phases: [ { title, items: [ { id, check, expected, type, unit, ref, mandatory } ] } ] }
 *   type: 'check' (Pass/Fail/N/A) | 'measure' (value with unit + limits in `expected`) | 'record' (write a value down)
 *
 * The console only produces the blank protocol. Filled-in FAT records belong
 * to a unit (serial number), not to the manual, and are out of scope here.
 */
import {
  CATEGORY_LABELS,
  GROUP_LABELS,
  FOOTER_TEXT,
  LOGO_SVG,
  hardwareLabel,
  hardwareItemsOf,
  hardwareItemLabel,
  hardwareDetail,
  softwareLabel,
  manualTypeOf,
} from './docgen.js';

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

const P = (title, items) => ({ title, items });
const I = (check, expected, extra = {}) => ({ check, expected, type: 'check', mandatory: true, ...extra });
const M = (check, expected, unit, extra = {}) => ({ check, expected, type: 'measure', unit, mandatory: true, ...extra });
const R = (check, extra = {}) => ({ check, expected: '', type: 'record', mandatory: true, ...extra });

const IDENTIFICATION = (module) =>
  P('Identification', [
    R('Unit serial number'),
    ...(hardwareItemsOf(module).length > 1
      ? [R(`Unit type under test (${hardwareItemsOf(module).map(hardwareItemLabel).join(' / ')})`)]
      : []),
    ...hardwareItemsOf(module).map((h) =>
      h.type === 'ftd'
        ? R(`${hardwareItemLabel(h)}: hardware version (manual covers ${h.version || 'v1'})`)
        : R(`${hardwareItemLabel(h)}: manufacturer part / model no. (${hardwareDetail(h)})`)
    ),
    ...(module.softwares || []).map((s) => R(`${s.name} installed version${s.fromVersion ? ` (min. ${s.fromVersion})` : ''}`)),
    I('Module identification label present and matches order', 'Label legible, code and serial match'),
  ]);

const VISUAL = () =>
  P('Visual inspection', [
    I('Housing, panel and finish free of damage', 'No scratches, dents or paint defects'),
    I('All legends, placards and markings legible', 'Complete and correct per drawing'),
    I('All fasteners present and torqued', 'None missing or loose'),
    I('Cables and connectors free of damage, strain-relieved', 'No exposed conductors, no kinks'),
  ]);

const MECHANICAL = () =>
  P('Mechanical', [
    I('Module fits its mounting frame / cut-out', 'Seats fully, no forcing required', { ref: 'Installation' }),
    I('Moving controls travel freely over full range', 'No binding, no play beyond spec', { ref: 'Installation' }),
    I('Detents / end stops engage as designed', 'Positive engagement at every position'),
    I('TODO(author): module-specific mechanical checks', 'TODO(author)', { mandatory: false }),
  ]);

const ELECTRICAL = () =>
  P('Wiring and power-up', [
    I('Wiring conforms to schematic, connectors keyed and locked', 'Pin-out verified against drawing', { ref: 'Installation' }),
    M('Insulation resistance to chassis', '> 1 MΩ at 500 V DC', 'MΩ'),
    M('Supply voltage at module input', 'TODO(author): nominal ± tolerance', 'V'),
    M('Current draw at idle', 'TODO(author): max', 'A'),
    I('Power-up sequence completes, no fault indication', 'Indicators as described in the manual', { ref: 'Operation' }),
  ]);

const FUNCTIONAL = () =>
  P('Functional test', [
    I('Every switch / control reports the correct state to the simulation', 'Position shown in IOS / diagnostics matches', { ref: 'Operation' }),
    I('Every indicator / display responds to its simulation signal', 'Lamp test and individual drive verified', { ref: 'Operation' }),
    I('Backlighting / dimming works over full range', 'Even illumination, no dead segments'),
    I('TODO(author): module-specific functional procedures from section Operation', 'Expected indication as per manual', { ref: 'Operation' }),
  ]);

const CALIBRATION = () =>
  P('Calibration', [
    I('Calibration procedure performed as per manual', 'Values stored, no error', { ref: 'Maintenance' }),
    M('End-point deviation after calibration', 'TODO(author): limit', '%'),
  ]);

const SOFTWARE = (module) =>
  P('Software', [
    I('Software installed on the target computer as per Installation', 'Installation completes without error', { ref: 'Installation' }),
    ...(module.softwares || []).map((s) => I(`${s.name} version matches the release note`, s.fromVersion ? `≥ ${s.fromVersion}` : 'As ordered')),
    I('Configuration files / parameters set for this device', 'Values match the configuration record', { ref: 'Installation' }),
    I('Application starts automatically with the system', 'Running within TODO(author) s of boot', { ref: 'Operation' }),
    I('Application recovers after power interruption', 'Restarts without operator action'),
    I('Log files free of errors after a 30 min run', 'No ERROR entries', { ref: 'Maintenance' }),
  ]);

const STRUCTURE = () =>
  P('Structure', [
    I('Assembly matches the drawing set', 'All parts fitted, orientation correct', { ref: 'Installation' }),
    I('Bolted joints torqued and marked', 'Torque marks present on every joint'),
    I('Structure level and square', 'Within TODO(author) mm over full length'),
    I('No sharp edges, all guards and covers fitted', 'Safe to touch on every accessible surface'),
    I('Load test / deflection check where applicable', 'TODO(author): limit', { mandatory: false }),
  ]);

const RACK = () =>
  P('Rack and cabling', [
    I('Equipment mounted in the rack positions per layout', 'Matches rack layout drawing', { ref: 'Installation' }),
    I('Protective earth bonded, continuity measured', '< 0.1 Ω to PE bar'),
    I('Cables labelled at both ends', 'Labels match the cable list'),
    I('Power distribution: breakers rated and labelled', 'Matches the distribution schedule'),
    I('Ventilation unobstructed, fans running', 'Airflow at every unit'),
  ]);

const INTEGRATION = (module) =>
  P('System integration', [
    I(`Module recognised by the ${GROUP_LABELS[module.group] || module.group} system`, 'Present in device list, no fault flag'),
    I('End-to-end check with the simulation running', 'Behaviour as described in Operation', { ref: 'Operation' }),
    I('Data / network link stable for 30 min', 'No disconnects, no error counters'),
  ]);

const SIGN_OFF = () =>
  P('Final', [
    I('All non-conformances closed or accepted with deviation record', 'Non-conformance table complete'),
    I('Module cleaned, protective covers fitted for shipping', 'Ready for packing'),
    I('Manual version verified against the tested configuration', 'Matches this protocol header'),
  ]);

/** Category-driven starting checklist. Every item is expected to be reviewed by the author. */
export function templateChecklist(module) {
  const hw = hardwareItemsOf(module).some((h) => h.type === 'ftd') ? 'ftd' : hardwareItemsOf(module).length ? 'cots' : 'none';
  const phases = [IDENTIFICATION(module)];
  switch (module.category) {
    case 'software':
      phases.push(SOFTWARE(module), INTEGRATION(module));
      break;
    case 'cockpit-hardware':
    case 'peripherals':
      phases.push(VISUAL(), MECHANICAL(), ELECTRICAL(), FUNCTIONAL());
      if (hw === 'ftd') phases.push(CALIBRATION());
      if (module.softwares?.length) phases.push(SOFTWARE(module));
      phases.push(INTEGRATION(module));
      break;
    case 'structure':
      phases.push(VISUAL(), STRUCTURE());
      break;
    case 'rack':
      phases.push(VISUAL(), RACK(), ELECTRICAL(), INTEGRATION(module));
      break;
    default:
      phases.push(VISUAL(), FUNCTIONAL());
  }
  phases.push(SIGN_OFF());
  return normalizeChecklist({ enabled: true, phases });
}

/* ------------------------------------------------------------------ */
/* Validation / normalisation                                          */
/* ------------------------------------------------------------------ */

const TYPES = new Set(['check', 'measure', 'record']);

function phasePrefix(title, i) {
  const letters = String(title || '')
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .slice(0, 2);
  return letters || `P${i + 1}`;
}

/** Coerce anything shaped like a checklist into the canonical form, assigning ids (VI-1, VI-2 …) where missing. */
export function normalizeChecklist(input) {
  if (!input || typeof input !== 'object') throw new Error('checklist must be an object');
  const phasesIn = Array.isArray(input.phases) ? input.phases : [];
  const seen = new Set();
  const phases = phasesIn
    .map((p, pi) => {
      const title = String(p?.title || '').trim();
      if (!title) throw new Error(`phase ${pi + 1}: title is required`);
      const prefix = phasePrefix(title, pi);
      let n = 0;
      const items = (Array.isArray(p.items) ? p.items : [])
        .map((it) => {
          const check = String(it?.check || '').trim();
          if (!check) return null;
          n += 1;
          let id = String(it.id || '').trim() || `${prefix}-${n}`;
          while (seen.has(id)) id = `${id}b`;
          seen.add(id);
          const type = TYPES.has(it.type) ? it.type : 'check';
          const out = { id, check, expected: String(it.expected || '').trim(), type, mandatory: it.mandatory !== false };
          if (type === 'measure' && it.unit) out.unit = String(it.unit).trim();
          if (it.ref) out.ref = String(it.ref).trim();
          return out;
        })
        .filter(Boolean);
      return { title, items };
    })
    .filter((p) => p.items.length);
  return { enabled: input.enabled !== false, phases };
}

export const countItems = (cl) => (cl?.phases || []).reduce((n, p) => n + p.items.length, 0);

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export const CHECKLIST_CSS = `
.fat-doc { font-family: Verdana, Tahoma, 'DejaVu Sans', Geneva, sans-serif; font-size: 12px; color: #1c2733; background: #fff; }
.fat-doc .fat { max-width: 980px; margin: 0 auto; padding: 36px 48px 60px; }
.fat-doc .head-box { width: 100%; border-collapse: collapse; border: 2px solid #1c2733; margin: 0 0 22px; }
.fat-doc .head-box td { border: 2px solid #1c2733; padding: 12px 16px; vertical-align: middle; }
.fat-doc .head-title { text-align: center; width: 62%; }
.fat-doc .head-code { font-size: 22px; font-weight: 700; line-height: 1.1; }
.fat-doc .head-name { font-size: 15px; font-weight: 700; margin-top: 4px; }
.fat-doc .head-sub { font-size: 11px; color: #64748b; margin-top: 6px; }
.fat-doc .head-logo { text-align: center; }
.fat-doc .head-logo img, .fat-doc .head-logo svg { height: 52px; max-width: 200px; display: inline-block; }
.fat-doc h1 { font-size: 18px; margin: 30px 0 10px; padding-bottom: 6px; border-bottom: 2px solid #16324f; page-break-before: always; }
.fat-doc h1:first-of-type { page-break-before: auto; }
.fat-doc h2 { font-size: 14px; margin: 22px 0 8px; color: #16324f; }
.fat-doc table { border-collapse: collapse; width: 100%; margin: 8px 0 14px; font-size: 11.5px; page-break-inside: auto; }
.fat-doc th, .fat-doc td { border: 1px solid #94a3b8; padding: 6px 8px; text-align: left; vertical-align: top; }
.fat-doc th { background: #f1f4f8; font-weight: 700; }
.fat-doc tr { page-break-inside: avoid; }
.fat-doc td.id { white-space: nowrap; font-family: Consolas, monospace; font-size: 10.5px; width: 52px; }
.fat-doc td.result { white-space: nowrap; width: 132px; }
.fat-doc td.remarks { width: 22%; }
.fat-doc td.ref { color: #64748b; white-space: nowrap; }
.fat-doc .box { display: inline-block; width: 11px; height: 11px; border: 1.5px solid #1c2733; vertical-align: -1px; margin: 0 4px 0 0; border-radius: 2px; }
.fat-doc .opt { color: #64748b; font-size: 10px; margin-left: 4px; }
.fat-doc .ident td.value { height: 22px; }
.fat-doc .ident th { width: 34%; }
.fat-doc .draft-flag { display: inline-block; margin-left: 10px; font-size: 11px; font-weight: 600; color: #b45309; background: #fef3c7; padding: 2px 8px; border-radius: 4px; vertical-align: middle; }
.fat-doc .sign td { height: 58px; }
.fat-doc .sign th { width: 25%; }
.fat-doc .nc td { height: 26px; }
.fat-doc .intro { color: #334155; line-height: 1.55; }
.fat-doc .doc-footer { margin-top: 36px; font-size: 9px; color: #64748b; text-align: center; border-top: 1px solid #c8d1db; padding-top: 6px; line-height: 1.4; }
.fat-doc .print-header, .fat-doc .print-footer { display: none; }
@media print {
  @page { margin: 12mm 12mm 16mm; }
  .fat-doc .fat { max-width: none; padding: 0; }
  .fat-doc .print-footer { display: block; position: fixed; bottom: 0; left: 0; right: 0; font-size: 8.5px; color: #64748b; text-align: center; border-top: 1px solid #c8d1db; padding-top: 4px; background: #fff; line-height: 1.4; }
  .fat-doc .doc-footer { display: none; }
}
`;

function headerBox({ code, name, sub }, logoHtml) {
  return `<table class="head-box"><tr>
<td class="head-title"><div class="head-code">${esc(code)}</div><div class="head-name">${esc(name)}</div>${
    sub ? `<div class="head-sub">${esc(sub)}</div>` : ''
  }</td>
<td class="head-logo">${logoHtml}</td>
</tr></table>`;
}

function resultCell(item) {
  const boxes = `<span class="box"></span>Pass <span class="box"></span>Fail <span class="box"></span>N/A`;
  return `<td class="result">${boxes}${item.mandatory ? '' : '<span class="opt">optional</span>'}</td>`;
}

function phaseTable(phase, docRef) {
  const rows = phase.items
    .map((it) => {
      const expected =
        it.type === 'measure'
          ? `${esc(it.expected)}${it.unit ? ` [${esc(it.unit)}]` : ''}`
          : it.type === 'record'
            ? '<em>record value</em>'
            : esc(it.expected);
      const remarks = it.type === 'measure' ? 'Measured:' : it.type === 'record' ? 'Value:' : '';
      return `<tr><td class="id">${esc(it.id)}</td><td>${esc(it.check)}</td><td>${expected}</td><td class="ref">${esc(
        it.ref ? `${docRef} ${it.ref}` : ''
      )}</td>${resultCell(it)}<td class="remarks">${remarks}</td></tr>`;
    })
    .join('\n');
  return `<h2>${esc(phase.title)}</h2>
<table>
<thead><tr><th>#</th><th>Check</th><th>Expected</th><th>Ref</th><th>Result</th><th>Measured / remarks</th></tr></thead>
<tbody>${rows}</tbody>
</table>`;
}

/** One module's checklist as a section: identification, phases, non-conformances. */
function moduleSection(module, doc, checklist, { chapter = null } = {}) {
  const isDraft = doc.status !== 'released';
  const docRef = `${module.code || module.slug} ${doc.version}`;
  const swRows = (module.softwares || [])
    .map((s) => `<tr><th>${esc(s.name)} version</th><td class="value"></td></tr>`)
    .join('');
  const hwItems = hardwareItemsOf(module);
  const hwRows =
    hwItems.length === 0
      ? '<tr><th>Hardware version</th><td class="value"></td></tr>'
      : (hwItems.length > 1 ? `<tr><th>Unit type under test</th><td class="value"></td></tr>` : '') +
        hwItems
          .map((h) =>
            h.type === 'ftd'
              ? `<tr><th>${esc(hardwareItemLabel(h))} — hardware version</th><td class="value">${esc(h.version || '')}</td></tr>`
              : `<tr><th>${esc(hardwareItemLabel(h))} — part / model no.</th><td class="value">${esc(
                  [h.manufacturer, h.model].filter(Boolean).join(' ')
                )}</td></tr>`
          )
          .join('');
  return `<section class="module" id="fat-${esc(module.slug)}">
<h1>${chapter ? `${chapter}. ` : ''}${esc(module.name)} <span style="font-weight:400;color:#64748b">(${esc(module.code || module.slug)})</span>${
    isDraft ? `<span class="draft-flag">draft ${esc(doc.version)} r${doc.revision} — not released</span>` : ''
  }</h1>
<p class="intro">Acceptance test of the <strong>${esc(module.name)}</strong> module (${esc(
    CATEGORY_LABELS[module.category] || module.category
  )}, ${esc(GROUP_LABELS[module.group] || module.group)}) against the ${esc(manualTypeOf(doc.manual).label.toLowerCase())} <strong>${esc(
    module.code || module.slug
  )} ${esc(doc.version)}</strong>${isDraft ? ` r${doc.revision}` : ''}, checklist revision r${doc.revision}. Hardware: ${esc(
    hardwareLabel(module)
  )}. Software: ${esc(softwareLabel(module.softwares))}.</p>
<table class="ident">
<tbody>
<tr><th>Unit serial number</th><td class="value"></td></tr>
${hwRows}
${swRows}
<tr><th>Test date</th><td class="value"></td></tr>
<tr><th>Tested by (FTD.aero)</th><td class="value"></td></tr>
<tr><th>Witnessed by (customer)</th><td class="value"></td></tr>
</tbody>
</table>
${checklist.phases.map((p) => phaseTable(p, docRef)).join('\n')}
<h2>Non-conformances</h2>
<table class="nc">
<thead><tr><th style="width:52px">#</th><th style="width:60px">Item</th><th>Description</th><th style="width:30%">Action / disposition</th><th style="width:70px">Closed</th></tr></thead>
<tbody>${[1, 2, 3, 4]
    .map((n) => `<tr><td>${n}</td><td></td><td></td><td></td><td></td></tr>`)
    .join('')}</tbody>
</table>
</section>`;
}

function signOff() {
  return `<h2>Acceptance</h2>
<table class="sign">
<thead><tr><th>FTD.aero tester</th><th>FTD.aero QA</th><th>Customer representative</th><th>Result</th></tr></thead>
<tbody><tr><td>Name:<br><br>Signature:</td><td>Name:<br><br>Signature:</td><td>Name:<br><br>Signature:</td><td><span class="box"></span>Accepted<br><span class="box"></span>Accepted with deviations<br><span class="box"></span>Rejected</td></tr></tbody>
</table>`;
}

function wrapDoc(inner, header, opts) {
  const { footerText = FOOTER_TEXT } = opts;
  return `<div class="fat-doc">
<div class="print-footer">${esc(footerText)}</div>
<div class="fat">
${header}
${inner}
${signOff()}
<footer class="doc-footer">${esc(footerText)}</footer>
</div>
</div>`;
}

const logoHtmlFor = (opts) => (opts.logoUrl ? `<img class="logo" src="${esc(opts.logoUrl)}" alt="FTD.aero">` : LOGO_SVG);

/** Standalone FAT checklist body for one module doc version. */
export function checklistBodyHtml(module, doc, checklist, opts = {}) {
  const header = headerBox(
    {
      code: `FAT — ${module.code || module.slug}`,
      name: `${module.name} · Factory Acceptance Test`,
      sub: `${manualTypeOf(doc.manual).label} ${doc.version}${doc.status !== 'released' ? ` draft r${doc.revision}` : ''} · ${countItems(checklist)} checks · generated ${fmtDate(
        new Date().toISOString()
      )}`,
    },
    logoHtmlFor(opts)
  );
  return wrapDoc(moduleSection(module, doc, checklist), header, opts);
}

/** FAT protocol for a whole simulator manual: one section per module that has a checklist. */
export function fatProtocolBodyHtml({ manual, chapters }, opts = {}) {
  const withCl = chapters.filter((c) => !c.missing && c.checklist && c.checklist.enabled && c.checklist.phases.length);
  const skipped = chapters.filter((c) => !withCl.includes(c));
  const header = headerBox(
    {
      code: `FAT — ${manual.code || manual.name}`,
      name: `${manual.name} · Factory Acceptance Test protocol`,
      sub: `${GROUP_LABELS[manual.group] || manual.group || 'Assembled manual'} · ${withCl.length} module${withCl.length === 1 ? '' : 's'} · ${withCl.reduce(
        (n, c) => n + countItems(c.checklist),
        0
      )} checks · generated ${fmtDate(new Date().toISOString())}`,
    },
    logoHtmlFor(opts)
  );
  const overview = `<h2>Modules under test</h2>
<table>
<thead><tr><th>#</th><th>Module</th><th>Code</th><th>Manual version</th><th>Checks</th><th>Result</th></tr></thead>
<tbody>${withCl
    .map(
      (c, i) =>
        `<tr><td>${i + 1}</td><td><a href="#fat-${esc(c.slug)}">${esc(c.module.name)}</a></td><td>${esc(c.module.code || '—')}</td><td>${esc(
          c.doc.version
        )}${c.isDraft ? ` draft r${c.doc.revision}` : ''}</td><td>${countItems(c.checklist)}</td>${resultCell({ mandatory: true })}</tr>`
    )
    .join('')}${skipped
    .map(
      (c) =>
        `<tr><td>—</td><td>${esc(c.module?.name || c.slug)}</td><td>${esc(c.module?.code || '—')}</td><td colspan="3" style="color:#64748b">no FAT checklist</td></tr>`
    )
    .join('')}</tbody>
</table>`;
  const body = withCl.map((c, i) => moduleSection(c.module, c.doc, c.checklist, { chapter: i + 1 })).join('\n');
  return wrapDoc(`${overview}\n${body}`, header, opts);
}

/** Standalone HTML document (export / print). */
export function checklistExportHtml(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)} — FTD.aero</title>
<style>
body { margin: 0; background: #fff; }
${CHECKLIST_CSS}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}
