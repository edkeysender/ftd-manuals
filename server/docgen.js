/**
 * Document templates and the auto-generated sections (1 Revision record,
 * 2 Introduction, 3 General information). Sections 1–3 are always derived
 * from module data and the revision record — never hand-edited.
 * Also: assembly of module docs into one manual (cover, TOC, chapters).
 */

export const CATEGORY_LABELS = {
  'cockpit-hardware': 'Cockpit hardware',
  peripherals: 'Peripherals',
  structure: 'Structure',
  'instructor-station': 'Instructor station',
  software: 'Software',
  rack: 'Rack', // legacy — existing modules keep it; no longer offered for new ones
};

/* ------------------------------------------------------------------ */
/* Module types                                                        */
/* What a module IS decides which manuals it needs — creating a module */
/* drafts them all at once, with predictable document codes.           */
/* ------------------------------------------------------------------ */

export const MODULE_TYPES = {
  'own-module': {
    id: 'own-module',
    label: 'Own module',
    desc: 'off-the-shelf parts + own versioned plates',
    manuals: ['customer', 'technician'],
    needsSoftware: false,
  },
  'third-party-kit': {
    id: 'third-party-kit',
    label: '3rd-party kit',
    desc: 'a bought device or set, e.g. an intercom or a smoke detector',
    manuals: ['customer', 'technician'],
    needsSoftware: false,
  },
  'own-software': {
    id: 'own-software',
    label: 'Own software',
    desc: 'an FTD application without hardware',
    manuals: ['software-customer', 'software-technician'],
    needsSoftware: true,
  },
  'module-software': {
    id: 'module-software',
    label: 'Module + software',
    desc: 'e.g. the IOS starting panel',
    manuals: ['customer', 'technician', 'software-customer', 'software-technician'],
    needsSoftware: true,
  },
};

export function moduleTypeOf(id) {
  const t = MODULE_TYPES[id];
  if (!t) throw new Error(`Unknown module type "${id}" — one of ${Object.keys(MODULE_TYPES).join(', ')}`);
  return t;
}

/** Document code of one manual of a module: <CODE>-TECH-HW / <CODE>-USER-SW … */
export function manualDocCode(module, manualId) {
  const t = manualTypeOf(manualId);
  const base = String(module.code || module.slug || '').toUpperCase();
  return `${base}-${t.audience === 'technician' ? 'TECH' : 'USER'}-${t.kind === 'software' ? 'SW' : 'HW'}`;
}

/**
 * Parts the module is built from — either made in-house ("Płyta czołowa v1",
 * trailing version → an FTD catalog item) or bought ("Encoder" → a COTS item).
 * Accepts the textarea text (one part per line) or an array of lines.
 */
export function parseParts(parts) {
  const lines = (Array.isArray(parts) ? parts : String(parts || '').split(/\r?\n/)).map((l) => String(l).trim()).filter(Boolean);
  return lines.map((line) => {
    const m = /^(.*\S)\s+[vV](\d[\w.-]*)$/.exec(line);
    if (m) return { name: m[1], type: 'ftd', version: `v${m[2]}` };
    return { name: line, type: 'cots' };
  });
}

export const GROUP_LABELS = {
  SIM: 'Simulator manual',
  IOS: 'IOS manual',
  RACK: 'RACK cabinets manual',
};

export const FOOTER_TEXT =
  'The information contained in this document is proprietary material protected by international law. You must not, directly or indirectly, use, disclose, distribute, print, or copy this document or any part of it without prior consent of FTD.aero Sp. z o.o.';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ------------------------------------------------------------------ */
/* Manual types                                                        */
/* One module is documented for two audiences — the customer who       */
/* operates the simulator and the technician who installs, wires and  */
/* configures it — and, when the module is software-related, the      */
/* software gets the same split. Each type is its own doc stream      */
/* (A1.0…, own draft branch, own revision record, own template).      */
/* ------------------------------------------------------------------ */

export const MANUAL_TYPES = {
  customer: {
    id: 'customer',
    label: 'Customer manual',
    short: 'Customer',
    kind: 'hardware',
    audience: 'customer',
    desc: 'For the operator of the simulator: what the module is, how it is used day to day, what to check and when to call service.',
    sections: ['Description', 'Operation', 'Maintenance', 'Appendixes'],
    sectionHints: {
      Description: 'what the module is, its controls and indications, where it is located',
      Operation: 'normal use, step by step, with the expected indication after each action',
      Maintenance: 'operator-level care: cleaning, periodic checks, what to report to service — no servicing procedures',
      Appendixes: 'reference drawings and third-party user documents',
    },
  },
  technician: {
    id: 'technician',
    label: 'Technician manual',
    short: 'Technician',
    kind: 'hardware',
    audience: 'technician',
    desc: 'For the installer / service technician: components and wiring, network and device configuration, servicing and troubleshooting.',
    sections: ['Installation', 'Configuration', 'Maintenance', 'Appendixes'],
    sectionHints: {
      Installation: 'system components, mounting, wiring and pin-out, power-up',
      Configuration: 'device and network set-up per unit: finding it on the network, credentials policy, firmware, addressing, function keys, integration with the simulator',
      Maintenance: 'servicing, troubleshooting, spare parts, restoring a unit to service',
      Appendixes: 'wiring diagrams, configuration files, vendor documents',
    },
  },
  'software-customer': {
    id: 'software-customer',
    label: 'Software customer manual',
    short: 'SW · Customer',
    kind: 'software',
    audience: 'customer',
    desc: 'For the operator: everyday use of the linked software — the tasks they perform, screen by screen.',
    sections: ['Overview', 'Operation', 'Troubleshooting', 'Appendixes'],
    sectionHints: {
      Overview: 'what the software does for the operator, how to reach it (which computer / page), the roles that use it',
      Operation: 'one numbered procedure per task (e.g. add a user, enrol a card, pair a phone), with the expected result',
      Troubleshooting: 'symptoms the operator may see and what to do — no configuration changes',
      Appendixes: 'quick-reference tables, third-party user guides',
    },
  },
  'software-technician': {
    id: 'software-technician',
    label: 'Software technician manual',
    short: 'SW · Technician',
    kind: 'software',
    audience: 'technician',
    desc: 'For the technician: installing, configuring, updating and administering the linked software.',
    sections: ['Installation', 'Configuration', 'Administration', 'Appendixes'],
    sectionHints: {
      Installation: 'deployment on the simulator computers, firmware / software update procedure, licences',
      Configuration: 'network addressing, integration settings (APIs, switches, function keys), backup and restore of the configuration',
      Administration: 'administrator accounts and credentials policy, logs, diagnostics, recovery',
      Appendixes: 'configuration files, API references, vendor documents',
    },
  },
};

/** The order manuals are listed in everywhere (modules list, module page, wizard). */
export const MANUAL_ORDER = ['customer', 'technician', 'software-customer', 'software-technician'];

/** The manual type docs created before the split belong to. */
export const DEFAULT_MANUAL = 'customer';

export const isManualType = (t) => Object.prototype.hasOwnProperty.call(MANUAL_TYPES, t);

export function manualTypeOf(id) {
  const t = MANUAL_TYPES[id || DEFAULT_MANUAL];
  if (!t) throw new Error(`Unknown manual type "${id}" — one of ${MANUAL_ORDER.join(', ')}`);
  return t;
}

/** Canonical doc key "<manual>:<version>", e.g. technician:A1.0. */
export const docKey = (manual, version) => `${manual || DEFAULT_MANUAL}:${version}`;

/** Parse a doc key. A bare version ("A1.0") is the customer manual — docs created before
 *  the split, and every old link, keep resolving. Returns { manual, version }. */
export function parseDocKey(key) {
  const s = String(key || '').trim();
  const i = s.indexOf(':');
  if (i < 0) return { manual: DEFAULT_MANUAL, version: s };
  const manual = s.slice(0, i);
  if (!isManualType(manual)) throw new Error(`Unknown manual type "${manual}" in "${s}" — one of ${MANUAL_ORDER.join(', ')}`);
  return { manual, version: s.slice(i + 1) };
}

/* ------------------------------------------------------------------ */
/* Hardware                                                            */
/* A module links to N items of the shared hardware catalog            */
/* (hardware.json on main). Each item is one physical unit type:       */
/* {id, name, type: 'ftd'|'cots', version | manufacturer+model, notes}.*/
/* ------------------------------------------------------------------ */

/** Relation detail of one catalog item (or a legacy inline relation object). */
export function hardwareDetail(hw) {
  if (!hw || hw.type === 'none') return '—';
  if (hw.type === 'ftd') return `FTD.aero · ${hw.version || 'v1'}`;
  return `COTS · ${[hw.manufacturer, hw.model].filter(Boolean).join(' ')}`.trim();
}

/** Display name of one hardware item: its catalog name, else the relation detail. */
export function hardwareItemLabel(hw) {
  if (!hw || hw.type === 'none') return '—';
  return hw.name || hardwareDetail(hw);
}

/** Items of a module. Accepts a module (hardwareItems), an array of items, or a legacy relation object. */
export function hardwareItemsOf(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.filter((h) => h && h.type !== 'none');
  if (Array.isArray(x.hardwareItems)) return x.hardwareItems.filter((h) => h && h.type !== 'none');
  if (Array.isArray(x.hardware)) return x.hardware.filter((h) => h && h.type !== 'none');
  const hw = x.hardware && typeof x.hardware === 'object' ? x.hardware : x.type ? x : null;
  return hw && hw.type !== 'none' ? [hw] : [];
}

/** One-line label for lists: item names joined, or the single item's detail. */
export function hardwareLabel(x) {
  const items = hardwareItemsOf(x);
  if (items.length === 0) return '—';
  if (items.length === 1 && !items[0].name) return hardwareDetail(items[0]);
  return items.map(hardwareItemLabel).join(' · ');
}

export function softwareLabel(softwares) {
  if (!softwares || softwares.length === 0) return 'not software-related';
  return softwares.map((s) => s.name).join(' · ');
}

/** Blank content for sections 4–7 of one manual type (FTD standard template).
 *  When the module covers several hardware items (e.g. three camera types, or a
 *  central unit plus two handsets) the per-unit sections get one sub-section per
 *  item so each unit type is described on its own. Software manuals list the
 *  linked softwares instead. */
export function blankContent(moduleName, hardwareItems = [], manual = DEFAULT_MANUAL, softwares = []) {
  const type = manualTypeOf(manual);
  const items = hardwareItemsOf(hardwareItems);
  const sw = (softwares || []).filter((s) => s && s.name);
  const name = esc(moduleName);
  const perUnit = (verb) =>
    items.length > 1
      ? items
          .map(
            (h) =>
              `<h3>${esc(hardwareItemLabel(h))}</h3>
<p>TODO(author): describe ${verb} of the ${esc(hardwareItemLabel(h))} (${esc(hardwareDetail(h))}).</p>`
          )
          .join('\n') + '\n'
      : '';
  const perSw = (verb) =>
    sw.length > 1
      ? sw
          .map((s) => `<h3>${esc(s.name)}</h3>\n<p>TODO(author): describe ${verb} of ${esc(s.name)}${s.fromVersion ? ` (from ${esc(s.fromVersion)})` : ''}.</p>`)
          .join('\n') + '\n'
      : '';
  const swName = sw.length ? sw.map((s) => esc(s.name)).join(' / ') : `the ${name} software`;

  const bodies = {
    customer: {
      Description: `<p>TODO(author): describe what the ${name} module is, where it is located and which controls and indications the operator sees.</p>\n${perUnit('the controls and indications')}`,
      Operation: `<p>TODO(author): describe normal operation of the ${name} module — one numbered procedure per task, with the expected indication after each step.</p>\n${perUnit('normal operation')}`,
      Maintenance: `<p>TODO(author): operator-level care — cleaning, periodic checks and what to report to service. Servicing procedures belong in the technician manual.</p>\n`,
      Appendixes: `<p>TODO(author): reference drawings and third-party user documents.</p>\n`,
    },
    technician: {
      Installation: `<p>TODO(author): list the system components of the ${name} module, then describe mounting, wiring (pin-out and polarity) and power-up.</p>\n${perUnit('mounting and wiring')}`,
      Configuration: `<p>TODO(author): configuration of each unit — finding it on the simulator network, first login and credentials policy, firmware update, addressing, function keys, integration with the simulator. Never write passwords into the manual: refer to the credentials sheet.</p>\n${perUnit('configuration')}`,
      Maintenance: `<p>TODO(author): servicing, troubleshooting table (symptom → cause → action), spare parts, restoring a unit to service.</p>\n`,
      Appendixes: `<p>TODO(author): wiring diagrams, configuration files and vendor documents.</p>\n`,
    },
    'software-customer': {
      Overview: `<p>TODO(author): what ${swName} does for the operator, on which computer / page it is reached and who uses it.</p>\n${perSw('the purpose and access')}`,
      Operation: `<p>TODO(author): one numbered procedure per operator task in ${swName}, with the expected result after each step.</p>\n${perSw('the operator tasks')}`,
      Troubleshooting: `<p>TODO(author): symptoms the operator may see and what to do — no configuration changes.</p>\n`,
      Appendixes: `<p>TODO(author): quick-reference tables and third-party user guides.</p>\n`,
    },
    'software-technician': {
      Installation: `<p>TODO(author): deployment of ${swName} on the simulator computers, update procedure and licences.</p>\n${perSw('installation and update')}`,
      Configuration: `<p>TODO(author): network addressing, integration settings (APIs, switches, function keys), backup and restore of the configuration of ${swName}.</p>\n${perSw('configuration')}`,
      Administration: `<p>TODO(author): administrator accounts and credentials policy, logs, diagnostics and recovery. Never write passwords into the manual: refer to the credentials sheet.</p>\n`,
      Appendixes: `<p>TODO(author): configuration files, API references and vendor documents.</p>\n`,
    },
  };
  const body = bodies[type.id];
  return type.sections.map((s) => `<h2>${esc(s)}</h2>\n${body[s] || `<p>TODO(author): ${esc(type.sectionHints[s] || s)}.</p>\n`}`).join('');
}

function fmtDate(iso) {
  if (!iso) return '—';
  return String(iso).slice(0, 10);
}

/** Sections 1–3 as read-only HTML, generated from module + doc metadata. */
/* ------------------------------------------------------------------ */
/* Languages                                                           */
/* English is the source language of every doc; other languages are   */
/* translations stored next to it (content.<lang>.html) and marked    */
/* stale when the English body changes. Generated sections 1–3 and    */
/* the assembled-manual frame are produced in the requested language. */
/* ------------------------------------------------------------------ */

export const LANGUAGES = {
  en: { code: 'en', label: 'English', short: 'EN', source: true },
  pl: { code: 'pl', label: 'Polski', short: 'PL', source: false },
};
export const DEFAULT_LANG = 'en';
export const isLanguage = (l) => Object.prototype.hasOwnProperty.call(LANGUAGES, l);
export function langOf(l) {
  const code = String(l || DEFAULT_LANG).toLowerCase();
  if (!isLanguage(code)) throw new Error(`Unknown language "${l}" — one of ${Object.keys(LANGUAGES).join(', ')}`);
  return code;
}

const STRINGS = {
  en: {
    manualTypes: { customer: 'Customer manual', technician: 'Technician manual', 'software-customer': 'Software customer manual', 'software-technician': 'Software technician manual' },
    groups: GROUP_LABELS,
    categories: CATEGORY_LABELS,
    audiences: { customer: 'customer', technician: 'technician' },
    revisionRecord: 'Revision record', documentRevisions: 'Document revisions', revision: 'Revision', date: 'Date', change: 'Description of change', inherited: 'inherited', noRevisions: 'No revisions recorded',
    introduction: 'Introduction', generalInfo: 'General information', module: 'Module', code: 'Code', category: 'Category', manualGroup: 'Manual group', manualType: 'Manual type', docCode: 'Document code',
    hardware: 'Parts', unit: 'Part', relation: 'Relation', notes: 'Notes', notHardware: 'No parts — not a hardware module',
    softwareRelation: 'Software relation', software: 'Software', coveredReleases: 'Covered releases', notSoftware: 'Not software-related',
    audienceRow: (label, audience) => `${label} — ${audience} audience`,
    introAudience: { technician: 'It is intended for the installer and service technician and is not part of the documentation handed to the simulator operator.', customer: 'It is intended for the operator of the simulator.' },
    introSubject: (kind, name, detail) => (kind === 'software' ? `the software of the <strong>${name}</strong> module (${detail})` : `the <strong>${name}</strong> module (${detail})`),
    intro1: (typeLabel, subject, audience, group) => `This document is the <strong>${typeLabel}</strong> for ${subject} of the FTD.aero flight simulation training device. ${audience} It is a standalone mini-manual and is compiled into the ${group} (${typeLabel}) when this document version is released.`,
    intro2: (version, draftRev) => `Document version ${version}${draftRev ? ` (draft, revision ${draftRev})` : ''}. Only released document versions are compiled into simulator manuals.`,
    // assembled manual
    tableOfContents: 'Table of contents', chapter: 'Ch.', docVersion: 'Doc version', status: 'Status', noDocumentation: 'no documentation', noDocumentationYet: 'This module has no documentation yet.',
    draftFlag: (version, rev) => `draft ${version} r${rev} — not released`, langFallback: 'English — not translated', compiled: 'compiled', modules: (n) => `${n} module${n === 1 ? '' : 's'}`, assembled: 'Assembled manual', draft: 'draft',
  },
  pl: {
    manualTypes: { customer: 'Instrukcja użytkownika', technician: 'Instrukcja techniczna', 'software-customer': 'Instrukcja użytkownika oprogramowania', 'software-technician': 'Instrukcja techniczna oprogramowania' },
    groups: { SIM: 'Instrukcja symulatora', IOS: 'Instrukcja IOS', RACK: 'Instrukcja szaf RACK' },
    categories: { software: 'Oprogramowanie', 'cockpit-hardware': 'Sprzęt kokpitu', structure: 'Konstrukcja', peripherals: 'Urządzenia peryferyjne', rack: 'Rack' },
    audiences: { customer: 'klient', technician: 'technik' },
    revisionRecord: 'Rejestr zmian', documentRevisions: 'Wersje dokumentu', revision: 'Wersja', date: 'Data', change: 'Opis zmiany', inherited: 'odziedziczona', noRevisions: 'Brak zarejestrowanych wersji',
    introduction: 'Wprowadzenie', generalInfo: 'Informacje ogólne', module: 'Moduł', code: 'Kod', category: 'Kategoria', manualGroup: 'Grupa instrukcji', manualType: 'Rodzaj instrukcji', docCode: 'Kod dokumentu',
    hardware: 'Części', unit: 'Część', relation: 'Relacja', notes: 'Uwagi', notHardware: 'Brak części — moduł bez sprzętu',
    softwareRelation: 'Powiązane oprogramowanie', software: 'Oprogramowanie', coveredReleases: 'Objęte wydania', notSoftware: 'Nie dotyczy oprogramowania',
    audienceRow: (label, audience) => `${label} — odbiorca: ${audience}`,
    introAudience: { technician: 'Jest przeznaczony dla instalatora i technika serwisu i nie stanowi części dokumentacji przekazywanej operatorowi symulatora.', customer: 'Jest przeznaczony dla operatora symulatora.' },
    introSubject: (kind, name, detail) => (kind === 'software' ? `oprogramowania modułu <strong>${name}</strong> (${detail})` : `modułu <strong>${name}</strong> (${detail})`),
    intro1: (typeLabel, subject, audience, group) => `Niniejszy dokument to <strong>${typeLabel}</strong> ${subject} urządzenia do szkolenia lotniczego FTD.aero. ${audience} Jest samodzielną mini-instrukcją i po wydaniu tej wersji dokumentu wchodzi w skład dokumentu ${group} (${typeLabel}).`,
    intro2: (version, draftRev) => `Wersja dokumentu ${version}${draftRev ? ` (robocza, rewizja ${draftRev})` : ''}. Do instrukcji symulatora kompilowane są wyłącznie wydane wersje dokumentów.`,
    tableOfContents: 'Spis treści', chapter: 'Rozdz.', docVersion: 'Wersja dok.', status: 'Status', noDocumentation: 'brak dokumentacji', noDocumentationYet: 'Ten moduł nie ma jeszcze dokumentacji.',
    draftFlag: (version, rev) => `wersja robocza ${version} r${rev} — niewydana`, langFallback: 'wersja angielska — brak tłumaczenia', compiled: 'skompilowano', modules: (n) => `${n} ${n === 1 ? 'moduł' : n < 5 ? 'moduły' : 'modułów'}`, assembled: 'Instrukcja złożona', draft: 'robocza',
  },
};

/** UI strings of one language (English strings fill any gap). */
export const strings = (lang) => ({ ...STRINGS.en, ...(STRINGS[langOf(lang)] || {}) });
export const manualTypeLabel = (id, lang = DEFAULT_LANG) => strings(lang).manualTypes[manualTypeOf(id).id];
export const groupLabel = (g, lang = DEFAULT_LANG) => strings(lang).groups[g] || GROUP_LABELS[g] || g;

/** Sections 1–3 as read-only HTML, generated from module + doc metadata, in `lang`. */
export function generatedSections(module, doc, lang = DEFAULT_LANG) {
  const T = strings(lang);
  const record = (doc.revisionRecord || [])
    .map(
      (r) =>
        `<tr><td>${esc(doc.version)} ${esc(r.rev)}${r.inherited ? ` <em>(${T.inherited})</em>` : ''}</td><td>${fmtDate(
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
      .join('\n') || `<tr><td colspan="2">${T.notSoftware}</td></tr>`;

  const hwRows =
    hardwareItemsOf(module)
      .map(
        (h) =>
          `<tr><td>${esc(hardwareItemLabel(h))}</td><td>${esc(hardwareDetail(h))}</td><td>${esc(h.notes || '')}</td></tr>`
      )
      .join('\n') || `<tr><td colspan="3">${T.notHardware}</td></tr>`;

  const type = manualTypeOf(doc.manual);
  const typeLabel = esc(T.manualTypes[type.id]);
  const typeLower = lang === 'en' ? typeLabel.toLowerCase() : typeLabel.charAt(0).toLowerCase() + typeLabel.slice(1);
  const audience = T.introAudience[type.audience];
  const subject = T.introSubject(
    type.kind,
    esc(module.name),
    type.kind === 'software' ? esc(softwareLabel(module.softwares)) : esc(module.code || module.slug)
  );
  const group = esc(T.groups[module.group] || module.group);

  return `<section class="auto-section" data-auto="1">
<h2>${T.revisionRecord}</h2>
<h3>${T.documentRevisions}</h3>
<table>
<thead><tr><th>${T.revision}</th><th>${T.date}</th><th>${T.change}</th></tr></thead>
<tbody>
${record || `<tr><td colspan="3">${T.noRevisions}</td></tr>`}
</tbody>
</table>
</section>
<section class="auto-section" data-auto="2">
<h2>${T.introduction}</h2>
<p>${T.intro1(typeLower, subject, audience, group)}</p>
<p>${T.intro2(esc(doc.version), doc.status === 'released' ? '' : esc('r' + doc.revision))}</p>
</section>
<section class="auto-section" data-auto="3">
<h2>${T.generalInfo}</h2>
<table>
<tbody>
<tr><th>${T.module}</th><td>${esc(module.name)}</td></tr>
<tr><th>${T.code}</th><td>${esc(module.code || '—')}</td></tr>
<tr><th>${T.category}</th><td>${esc(T.categories[module.category] || module.category || '—')}</td></tr>
<tr><th>${T.manualGroup}</th><td>${esc(module.group)}</td></tr>
<tr><th>${T.manualType}</th><td>${T.audienceRow(typeLabel, esc(T.audiences[type.audience]))}</td></tr>
<tr><th>${T.docCode}</th><td>${esc(manualDocCode(module, type.id))}</td></tr>
</tbody>
</table>
<h3>${T.hardware}</h3>
<table>
<thead><tr><th>${T.unit}</th><th>${T.relation}</th><th>${T.notes}</th></tr></thead>
<tbody>
${hwRows}
</tbody>
</table>
<h3>${T.softwareRelation}</h3>
<table>
<thead><tr><th>${T.software}</th><th>${T.coveredReleases}</th></tr></thead>
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
.manual-doc .lang-flag { background: #e5edff; color: #1d4ed8; }
.manual-doc .chapter h2 { counter-increment: sec; counter-reset: subsec; font-size: 18px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #16324f; }
.manual-doc .chapter h2::before { content: counter(chap) '.' counter(sec) '  '; color: #16324f; }
.manual-doc .chapter h3 { counter-increment: subsec; font-size: 14.5px; margin: 20px 0 8px; }
.manual-doc .chapter h3::before { content: counter(chap) '.' counter(sec) '.' counter(subsec) '  '; color: #16324f; }
.manual-doc .chapter p, .manual-doc .chapter li { line-height: 1.6; }
.manual-doc figure { margin: 16px 0; text-align: center; }
.manual-doc img { max-width: 100%; height: auto; }
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
export function manualBodyHtml({ manual, chapters, lang = DEFAULT_LANG }, opts = {}) {
  const { logoUrl = null, coverUrl = null, footerText = FOOTER_TEXT } = opts;
  const T = strings(lang);
  const date = new Date().toISOString().slice(0, 10);
  const logoHtml = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="FTD.aero">` : LOGO_SVG;

  const processed = chapters.map((c, i) =>
    c.missing ? { ...c, html: '', items: [] } : { ...c, ...numberHeadings(`${c.generated}\n${c.content}`, i + 1) }
  );

  const recordRows = processed
    .map((c, i) =>
      c.missing
        ? `<tr><td>${i + 1}</td><td class="missing">${esc(c.module?.name || c.slug)}</td><td colspan="4" class="missing">${T.noDocumentation}</td></tr>`
        : `<tr><td>${i + 1}</td><td><a href="#ch-${esc(c.slug)}">${esc(c.module.name)}</a></td><td>${esc(
            c.module.code || '—'
          )}</td><td>${esc(c.doc.version)}${c.isDraft ? ` ${T.draft} r${c.doc.revision}` : ''}</td><td>${esc(
            c.doc.status
          )}</td><td>${fmtDate(c.doc.releasedAt || c.doc.updatedAt)}</td></tr>`
    )
    .join('\n');

  const toc = processed
    .map((c, i) => {
      const title = esc(c.module?.name || c.slug);
      if (c.missing) return `<li class="missing"><span class="num">${i + 1}</span>${title} — ${T.noDocumentation}</li>`;
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
        return `<section class="chapter" id="ch-${esc(c.slug)}"><h1>${esc(c.module?.name || c.slug)}</h1><p class="missing">${T.noDocumentationYet}</p></section>`;
      }
      const flags = [
        c.isDraft ? `<span class="draft-flag">${esc(T.draftFlag(c.doc.version, c.doc.revision))}</span>` : '',
        c.langFallback ? `<span class="draft-flag lang-flag">${esc(T.langFallback)}</span>` : '',
      ].join('');
      return `<section class="chapter" id="ch-${esc(c.slug)}">
<h1>${esc(c.module.name)}${flags}</h1>
${c.html}
</section>`;
    })
    .join('\n');

  const cover = coverUrl
    ? `<div class="cover-image"><img src="${esc(coverUrl)}" alt="${esc(manual.name)}"></div>`
    : `<div class="cover-placeholder">Cover illustration — set one via Edit manual</div>`;

  return `<div class="manual-doc" lang="${esc(lang)}">
<div class="print-header">${headerBox(manual, logoHtml)}</div>
<div class="print-footer">${esc(footerText)}</div>
<div class="manual">
<section class="cover" id="cover">
  ${headerBox(manual, logoHtml)}
  ${cover}
  <div class="sub">${esc(T.groups[manual.group] || (manual.group ? manual.group : T.assembled))} · ${esc(
    T.manualTypes[manualTypeOf(manual.manual).id]
  )} · ${T.compiled} ${date} · ${T.modules(chapters.length)}</div>
</section>
<section class="front" id="front">
  <h2 id="revision-record">${T.revisionRecord}</h2>
  <table>
    <thead><tr><th>${T.chapter}</th><th>${T.module}</th><th>${T.code}</th><th>${T.docVersion}</th><th>${T.status}</th><th>${T.date}</th></tr></thead>
    <tbody>${recordRows}</tbody>
  </table>
  <h2 id="toc">${T.tableOfContents}</h2>
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
<html lang="${esc(compiled.lang || DEFAULT_LANG)}">
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

/** Draft branch of one doc: draft/<slug>-<manual>-a1.0. Docs created before the
 *  split live on draft/<slug>-a1.0 — their branch name is read from doc.json,
 *  never recomputed. */
export function docBranchName(slug, manual, version) {
  return `draft/${slug}-${manual || DEFAULT_MANUAL}-${version.toLowerCase()}`;
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
