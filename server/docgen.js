/**
 * Document templates and the auto-generated sections (1 Revision record,
 * 2 Introduction, 3 General information). Sections 1–3 are always derived
 * from module data and the revision record — never hand-edited.
 */

export const CATEGORY_LABELS = {
  software: 'Software',
  'cockpit-hardware': 'Cockpit hardware',
  structure: 'Structure',
  peripherals: 'Peripherals',
  rack: 'Rack',
};

export const GROUP_LABELS = {
  SIM: 'Simulator manual',
  IOS: 'IOS manual',
  RACK: 'RACK cabinets manual',
};

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function hardwareLabel(hw) {
  if (!hw || hw.type === 'none') return '—';
  if (hw.type === 'ftd') return `FTD.aero · ${hw.version || 'v1'}`;
  return `COTS · ${[hw.manufacturer, hw.model].filter(Boolean).join(' ')}`;
}

export function softwareLabel(softwares) {
  if (!softwares || softwares.length === 0) return 'not software-related';
  return softwares.map((s) => s.name).join(' · ');
}

/** Blank content for sections 4–7 (FTD standard template). */
export function blankContent(moduleName) {
  return `<h2>Installation</h2>
<p>TODO: describe how the ${esc(moduleName)} module is installed and connected.</p>
<h2>Operation</h2>
<p>TODO: describe normal operation of the ${esc(moduleName)} module.</p>
<h2>Maintenance</h2>
<p>TODO: describe inspection intervals and maintenance actions.</p>
<h2>Appendixes</h2>
<p>TODO: reference drawings, wiring diagrams and third-party documents.</p>
`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

/** Sections 1–3 as read-only HTML, generated from module + doc metadata. */
export function generatedSections(module, doc) {
  const record = (doc.revisionRecord || [])
    .map(
      (r) =>
        `<tr><td>${esc(doc.version)} ${esc(r.rev)}${r.inherited ? ' <em>(inherited)</em>' : ''}</td><td>${fmtDate(
          r.date
        )}</td><td>${esc(r.summary)}</td></tr>`
    )
    .join('\n');

  const swRows =
    (module.softwares || [])
      .map((s) => {
        const cov = (doc.covers || []).find((c) => c.name === s.name);
        const range = cov ? (cov.to && cov.to !== cov.from ? `${cov.from} – ${cov.to}` : cov.from) : s.fromVersion;
        return `<tr><td>${esc(s.name)}</td><td>${esc(range || '—')}</td></tr>`;
      })
      .join('\n') || '<tr><td colspan="2">Not software-related</td></tr>';

  return `<section class="auto-section" data-auto="1">
<h2>Revision record</h2>
<h3>Document revisions</h3>
<table>
<thead><tr><th>Revision</th><th>Date</th><th>Description of change</th></tr></thead>
<tbody>
${record || '<tr><td colspan="3">No revisions recorded</td></tr>'}
</tbody>
</table>
</section>
<section class="auto-section" data-auto="2">
<h2>Introduction</h2>
<p>This document is the module manual for the <strong>${esc(module.name)}</strong> module (${esc(
    module.code || module.slug
  )}) of the FTD.aero flight simulation training device. It is a standalone mini-manual and is compiled into the ${esc(
    GROUP_LABELS[module.group] || module.group
  )} when this document version is released.</p>
<p>Document version ${esc(doc.version)}${doc.status === 'released' ? '' : ` (draft, revision ${esc('r' + doc.revision)})`}. Only released document versions are compiled into simulator manuals.</p>
</section>
<section class="auto-section" data-auto="3">
<h2>General information</h2>
<table>
<tbody>
<tr><th>Module</th><td>${esc(module.name)}</td></tr>
<tr><th>Code</th><td>${esc(module.code || '—')}</td></tr>
<tr><th>Category</th><td>${esc(CATEGORY_LABELS[module.category] || module.category || '—')}</td></tr>
<tr><th>Manual group</th><td>${esc(module.group)}</td></tr>
<tr><th>Hardware</th><td>${esc(hardwareLabel(module.hardware))}</td></tr>
</tbody>
</table>
<h3>Software relation</h3>
<table>
<thead><tr><th>Software</th><th>Covered releases</th></tr></thead>
<tbody>
${swRows}
</tbody>
</table>
</section>
`;
}

/* ---------- version helpers ---------- */

/** 'A1.3' -> {major:1, minor:3} */
export function parseDocVersion(v) {
  const m = /^A(\d+)\.(\d+)$/.exec(v || '');
  return m ? { major: +m[1], minor: +m[2] } : null;
}

export function compareDocVersions(a, b) {
  const pa = parseDocVersion(a);
  const pb = parseDocVersion(b);
  if (!pa || !pb) return String(a).localeCompare(String(b));
  return pa.major - pb.major || pa.minor - pb.minor;
}

export function docBranchName(slug, version) {
  return `draft/${slug}-${version.toLowerCase()}`;
}

/** Loose numeric comparison for software versions like 'v2.0.1' or '2.10'. */
export function compareSwVersions(a, b) {
  const nums = (v) => String(v || '').split(/[^\d]+/).filter(Boolean).map(Number);
  const na = nums(a);
  const nb = nums(b);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Is software version v inside a doc's covered range {from, to}? */
export function versionCovered(v, cov) {
  if (!cov || !cov.from) return false;
  const from = cov.from;
  const to = cov.to || cov.from;
  return compareSwVersions(v, from) >= 0 && compareSwVersions(v, to) <= 0;
}
