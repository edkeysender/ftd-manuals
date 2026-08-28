/**
 * Document templates and the auto-generated sections (1 Revision record,
 * 2 Introduction, 3 General information). Sections 1–3 are always derived
 * from module data and the revision record — never hand-edited.
 * Also: assembly of module docs into one manual (cover, TOC, chapters).
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

export const FOOTER_TEXT =
  'The information contained in this document is proprietary material protected by international law. You must not, directly or indirectly, use, disclose, distribute, print, or copy this document or any part of it without prior consent of FTD.aero Sp. z o.o.';

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

/* ------------------------------------------------------------------ */
/* Assembled manual                                                    */
/* ------------------------------------------------------------------ */

/** Fallback brand mark used when no logo has been uploaded in Settings. */
export const LOGO_SVG = `<svg class="logo" viewBox="0 0 330 92" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="FTD.aero">
<g fill="none" stroke="#0d6db4" stroke-width="7.5" stroke-linecap="round" stroke-linejoin="round">
<ellipse cx="56" cy="40" rx="40" ry="19" transform="rotate(-24 56 40)"/>
<path d="M32 62 l-6 16 M56 66 v14 M80 60 l7 16"/>
</g>
<circle cx="24" cy="30" r="7" fill="#0d6db4"/>
<line x1="122" y1="16" x2="122" y2="76" stroke="#0d6db4" stroke-width="3"/>
<text x="138" y="57" font-family="Verdana, Tahoma, 'DejaVu Sans', Arial, sans-serif" font-weight="700" font-size="34" letter-spacing="-0.5" fill="#0d6db4">FTD.aero</text>
</svg>`;

/** Shared stylesheet for the assembled manual (web view and export).
 *  Everything is scoped under .manual-doc so it can be injected into the app. */
export const MANUAL_CSS = `
/* Verdana matches the FTD Word template; the same stylesheet drives the web view and the export */
.manual-doc { font-family: Verdana, Tahoma, 'DejaVu Sans', Geneva, sans-serif; font-size: 13px; color: #1c2733; background: #fff; }
.manual-doc .manual { max-width: 900px; margin: 0 auto; padding: 40px 56px 60px; counter-reset: chap; }
.manual-doc .head-box { width: 100%; border-collapse: collapse; border: 2px solid #1c2733; margin: 0 0 28px; }
.manual-doc .head-box td { border: 2px solid #1c2733; padding: 14px 18px; vertical-align: middle; }
.manual-doc .head-title { text-align: center; width: 62%; }
.manual-doc .head-code { font-size: 28px; font-weight: 700; line-height: 1.1; }
.manual-doc .head-name { font-size: 19px; font-weight: 700; margin-top: 4px; }
.manual-doc .head-logo { text-align: center; }
.manual-doc .head-logo img, .manual-doc .head-logo svg { height: 60px; max-width: 230px; display: inline-block; }
.manual-doc .cover { text-align: center; padding: 10px 0 40px; }
.manual-doc .cover-image img { max-width: 92%; max-height: 560px; margin: 26px auto 10px; display: block; }
.manual-doc .cover-placeholder { margin: 40px auto; width: 70%; height: 240px; border: 1px dashed #c8d1db; border-radius: 8px; color: #94a3b8; display: flex; align-items: center; justify-content: center; font-size: 14px; }
.manual-doc .cover .sub { color: #64748b; margin-top: 24px; font-size: 14px; }
.manual-doc .front h2 { font-size: 19px; border-bottom: 2px solid #16324f; padding-bottom: 6px; margin: 34px 0 12px; }
.manual-doc .toc ol { margin: 0; padding-left: 22px; line-height: 1.9; }
.manual-doc .toc > ol > li { font-weight: 600; margin: 6px 0; }
.manual-doc .toc ol ol { list-style: none; padding-left: 22px; font-weight: 400; color: #475569; font-size: 14px; }
.manual-doc .toc .l3 { padding-left: 18px; }
.manual-doc .toc a { color: inherit; text-decoration: none; }
.manual-doc .toc a:hover { color: #0b5fff; text-decoration: underline; }
.manual-doc .toc .num { display: inline-block; min-width: 46px; color: #64748b; font-variant-numeric: tabular-nums; }
.manual-doc table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 12.5px; }
.manual-doc th, .manual-doc td { border: 1px solid #c8d1db; padding: 7px 10px; text-align: left; vertical-align: top; }
.manual-doc th { background: #f1f4f8; }
.manual-doc h1, .manual-doc h2, .manual-doc h3 { scroll-margin-top: 70px; }
.manual-doc .chapter { counter-increment: chap; counter-reset: sec; margin-top: 60px; padding-top: 24px; border-top: 1px dashed #dde3ea; }
.manual-doc .chapter > h1 { font-size: 24px; border-bottom: 3px solid #16324f; padding-bottom: 8px; margin: 0 0 16px; }
.manual-doc .chapter > h1::before { content: counter(chap) '  '; color: #16324f; }
.manual-doc .draft-flag { display: inline-block; font-size: 12px; background: #fef3c7; color: #b45309; border-radius: 5px; padding: 2px 8px; margin-left: 10px; vertical-align: middle; }
.manual-doc .chapter h2 { counter-increment: sec; counter-reset: subsec; font-size: 18px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #16324f; }
.manual-doc .chapter h2::before { content: counter(chap) '.' counter(sec) '  '; color: #16324f; }
.manual-doc .chapter h3 { counter-increment: subsec; font-size: 14.5px; margin: 20px 0 8px; }
.manual-doc .chapter h3::before { content: counter(chap) '.' counter(sec) '.' counter(subsec) '  '; color: #16324f; }
.manual-doc .chapter p, .manual-doc .chapter li { line-height: 1.6; }
.manual-doc figure { margin: 16px 0; text-align: center; }
.manual-doc figure img { max-width: 100%; border: 1px solid #dde3ea; border-radius: 4px; }
.manual-doc figcaption { color: #64748b; font-size: 12.5px; margin-top: 6px; }
.manual-doc .admonition { border-left: 4px solid; border-radius: 6px; padding: 10px 14px; margin: 14px 0; }
.manual-doc .admonition-title { font-weight: 700; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em; margin: 0 0 4px; }
.manual-doc .admonition.warning { background: #fff7ed; border-color: #f97316; }
.manual-doc .admonition.warning .admonition-title { color: #c2410c; }
.manual-doc .admonition.note { background: #eff6ff; border-color: #0b5fff; }
.manual-doc .admonition.note .admonition-title { color: #0b5fff; }
.manual-doc .auto-section { background: #fafbfc; padding: 0 12px 6px; border-radius: 6px; }
.manual-doc .ai-edit-pending { outline: 2px dashed #f97316; outline-offset: 3px; }
.manual-doc .missing { color: #dc2626; }
.manual-doc .doc-footer { margin-top: 70px; padding-top: 12px; border-top: 1px solid #c8d1db; font-size: 11px; color: #64748b; text-align: center; line-height: 1.5; }
.manual-doc .print-header, .manual-doc .print-footer { display: none; }
@media print {
  @page { margin: 14mm 14mm 18mm; }
  .manual-doc .manual { max-width: none; padding: 150px 0 60px; }
  .manual-doc .print-header { display: block; position: fixed; top: 0; left: 0; right: 0; background: #fff; }
  .manual-doc .print-header .head-box { margin: 0; }
  .manual-doc .print-footer { display: block; position: fixed; bottom: 0; left: 0; right: 0; font-size: 8.5px; color: #64748b; text-align: center; border-top: 1px solid #c8d1db; padding-top: 4px; background: #fff; line-height: 1.4; }
  .manual-doc .cover .head-box, .manual-doc .doc-footer { display: none; }
  .manual-doc .front, .manual-doc .chapter { page-break-before: always; border-top: none; margin-top: 0; }
  .manual-doc .cover { page-break-after: always; }
}
`;

/**
 * Number and anchor every h2/h3 of one chapter: assigns ids c<ch>-s<n>[-<m>]
 * (matching the CSS counters) and returns the outline for the TOC.
 */
function numberHeadings(html, ch) {
  let s2 = 0;
  let s3 = 0;
  const items = [];
  const out = String(html || '').replace(/<(h2|h3)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (m, tag, attrs, inner) => {
    const title = inner.replace(/<[^>]+>/g, '').trim();
    const isH2 = tag.toLowerCase() === 'h2';
    let id;
    let num;
    if (isH2) {
      s2 += 1;
      s3 = 0;
      num = `${ch}.${s2}`;
      id = `c${ch}-s${s2}`;
    } else {
      s3 += 1;
      num = `${ch}.${s2}.${s3}`;
      id = `c${ch}-s${s2}-${s3}`;
    }
    items.push({ level: isH2 ? 2 : 3, title, num, id });
    const cleanAttrs = (attrs || '').replace(/\sid="[^"]*"/i, '');
    return `<${tag}${cleanAttrs} id="${id}">${inner}</${tag}>`;
  });
  return { html: out, items };
}

/** Header box (title cell + logo cell) as in the FTD manual layout. */
function headerBox(manual, logoHtml) {
  const code = manual.code ? esc(manual.code) : esc(manual.name);
  const name = manual.code ? esc(manual.name) : esc(GROUP_LABELS[manual.group] || manual.group || 'Assembled manual');
  return `<table class="head-box"><tr>
<td class="head-title"><div class="head-code">${code}</div><div class="head-name">${name}</div></td>
<td class="head-logo">${logoHtml}</td>
</tr></table>`;
}

/**
 * Body HTML of an assembled manual: cover, revision record, clickable TOC,
 * chapters with anchored headings, proprietary footer.
 * opts: { logoUrl, coverUrl, footerText }
 */
export function manualBodyHtml({ manual, chapters }, opts = {}) {
  const { logoUrl = null, coverUrl = null, footerText = FOOTER_TEXT } = opts;
  const date = new Date().toISOString().slice(0, 10);
  const logoHtml = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="FTD.aero">` : LOGO_SVG;

  const processed = chapters.map((c, i) =>
    c.missing ? { ...c, html: '', items: [] } : { ...c, ...numberHeadings(`${c.generated}\n${c.content}`, i + 1) }
  );

  const recordRows = processed
    .map((c, i) =>
      c.missing
        ? `<tr><td>${i + 1}</td><td class="missing">${esc(c.module?.name || c.slug)}</td><td colspan="4" class="missing">no documentation</td></tr>`
        : `<tr><td>${i + 1}</td><td><a href="#ch-${esc(c.slug)}">${esc(c.module.name)}</a></td><td>${esc(
            c.module.code || '—'
          )}</td><td>${esc(c.doc.version)}${c.isDraft ? ` draft r${c.doc.revision}` : ''}</td><td>${esc(
            c.doc.status
          )}</td><td>${fmtDate(c.doc.releasedAt || c.doc.updatedAt)}</td></tr>`
    )
    .join('\n');

  const toc = processed
    .map((c, i) => {
      const title = esc(c.module?.name || c.slug);
      if (c.missing) return `<li class="missing"><span class="num">${i + 1}</span>${title} — no documentation</li>`;
      const subs = c.items
        .map(
          (it) =>
            `<li class="${it.level === 3 ? 'l3' : 'l2'}"><a href="#${it.id}"><span class="num">${it.num}</span>${esc(it.title)}</a></li>`
        )
        .join('');
      return `<li><a href="#ch-${esc(c.slug)}"><span class="num">${i + 1}</span>${title}</a><ol>${subs}</ol></li>`;
    })
    .join('\n');

  const body = processed
    .map((c) => {
      if (c.missing) {
        return `<section class="chapter" id="ch-${esc(c.slug)}"><h1>${esc(c.module?.name || c.slug)}</h1><p class="missing">This module has no documentation yet.</p></section>`;
      }
      return `<section class="chapter" id="ch-${esc(c.slug)}">
<h1>${esc(c.module.name)}${c.isDraft ? `<span class="draft-flag">draft ${esc(c.doc.version)} r${c.doc.revision} — not released</span>` : ''}</h1>
${c.html}
</section>`;
    })
    .join('\n');

  const cover = coverUrl
    ? `<div class="cover-image"><img src="${esc(coverUrl)}" alt="${esc(manual.name)}"></div>`
    : `<div class="cover-placeholder">Cover illustration — set one via Edit manual</div>`;

  return `<div class="manual-doc">
<div class="print-header">${headerBox(manual, logoHtml)}</div>
<div class="print-footer">${esc(footerText)}</div>
<div class="manual">
<section class="cover" id="cover">
  ${headerBox(manual, logoHtml)}
  ${cover}
  <div class="sub">${esc(GROUP_LABELS[manual.group] || (manual.group ? manual.group : 'Assembled manual'))} · compiled ${date} · ${
    chapters.length
  } module${chapters.length === 1 ? '' : 's'}</div>
</section>
<section class="front" id="front">
  <h2 id="revision-record">Revision record</h2>
  <table>
    <thead><tr><th>Ch.</th><th>Module</th><th>Code</th><th>Doc version</th><th>Status</th><th>Date</th></tr></thead>
    <tbody>${recordRows}</tbody>
  </table>
  <h2 id="toc">Table of contents</h2>
  <div class="toc"><ol>${toc}</ol></div>
</section>
${body}
<footer class="doc-footer">${esc(footerText)}</footer>
</div>
</div>`;
}

/** Standalone HTML document for export / print. */
export function manualExportHtml(compiled, opts = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(compiled.manual.name)} — FTD.aero</title>
<style>
body { margin: 0; background: #fff; }
${MANUAL_CSS}
</style>
</head>
<body>
${manualBodyHtml(compiled, opts)}
</body>
</html>
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
