/**
 * Document templates and the auto-generated sections (1 Revision record,
 * 2 Introduction, 3 General information). Sections 1–3 are always derived
 * from module data and the revision record — never hand-edited.
 * Also: assembly of module docs into one manual (cover, chapter 1 General with
 * revision record / TOC / List of Effective Pages, module chapters) and its
 * self-paginating HTML export (paged.js).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** dd.mm.yyyy — the date format of the FTD manual template (List of Effective Pages). */
function fmtDots(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : fmtDate(iso);
}

/** Issue / revision / effective date of one doc for the List of Effective Pages: A1.0 → issue 1, rev 0. */
export function docEffectivity(doc) {
  const v = parseDocVersion(doc?.version);
  return { issue: v ? String(v.major) : '—', rev: v ? String(v.minor) : '—', date: fmtDots(doc?.releasedAt || doc?.updatedAt) };
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
    // chapter 1 — General (FTD manual template)
    general: 'General', generalIntro: 'In this section the overall information about the document itself is provided.', generalInfoHeading: 'General Info',
    generalText1: (title) => `This document contains ${title} for Flight and Navigation Procedures Trainer (FNPT).`,
    generalText2: 'Any changes or modification in this document are not allowed if not introduced by FNPT Manufacturer and approved by CAA.',
    generalText3: 'If this document is found in unauthorized place, please contact FNPT Manufacturer:',
    manufacturer: ['FTD.AERO Sp. z o.o.', 'Wąska 33', '62-052 Komorniki', 'Poland', 'www.FTD.aero', 'office@ftd.aero', 'tel. +48 519 737 800'],
    lep: 'List of Effective Pages', page: 'Page', issue: 'Issue', rev: 'Rev.', effectiveDate: 'Effective date',
    lepNote: 'Page numbers are assigned when the manual is opened for print or exported; the table below lists the effectivity of every chapter.',
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
    general: 'Ogólne', generalIntro: 'W tej sekcji podano ogólne informacje o samym dokumencie.', generalInfoHeading: 'Informacje ogólne',
    generalText1: (title) => `Niniejszy dokument zawiera ${title} dla urządzenia FNPT (Flight and Navigation Procedures Trainer).`,
    generalText2: 'Wszelkie zmiany lub modyfikacje niniejszego dokumentu są niedozwolone, jeżeli nie zostały wprowadzone przez producenta FNPT i zatwierdzone przez CAA.',
    generalText3: 'W przypadku znalezienia tego dokumentu w nieuprawnionym miejscu prosimy o kontakt z producentem FNPT:',
    manufacturer: ['FTD.AERO Sp. z o.o.', 'Wąska 33', '62-052 Komorniki', 'Polska', 'www.FTD.aero', 'office@ftd.aero', 'tel. +48 519 737 800'],
    lep: 'Wykaz obowiązujących stron', page: 'Strona', issue: 'Wydanie', rev: 'Rew.', effectiveDate: 'Data obowiązywania',
    lepNote: 'Numery stron są nadawane przy otwarciu instrukcji do druku lub eksporcie; poniższa tabela podaje obowiązującą wersję każdego rozdziału.',
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
.manual-doc .manufacturer { line-height: 1.7; margin: 8px 0 0 24px; }
.manual-doc .lep-note { color: #64748b; font-size: 12px; }
.manual-doc .lep-pages { display: none; }
.manual-doc .lep-pages th, .manual-doc .lep-pages td { text-align: center; }
.manual-doc .lep-pages td.pg { background: #f1f4f8; font-weight: 600; }
.manual-doc .toc ol { margin: 0; padding-left: 22px; line-height: 1.9; }
.manual-doc .toc > ol { list-style: none; padding-left: 0; }
.manual-doc .toc > ol > li { font-weight: 600; margin: 6px 0; }
.manual-doc .toc ol ol { list-style: none; padding-left: 22px; font-weight: 400; color: #475569; font-size: 14px; }
.manual-doc .toc .l3 { padding-left: 18px; }
.manual-doc .toc a { color: inherit; text-decoration: none; }
.manual-doc .toc a:hover { color: #0b5fff; text-decoration: underline; }
.manual-doc .toc .num { display: inline-block; min-width: 46px; color: #64748b; font-variant-numeric: tabular-nums; }
.manual-doc table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 12.5px; }
.manual-doc th, .manual-doc td { border: 1px solid #c8d1db; padding: 7px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
.manual-doc th { background: #f1f4f8; }
/* wide tables (9+ columns) go compact so cells rarely have to break words to fit the page */
.manual-doc table:has(tr > :nth-child(9)) { font-size: 10.5px; }
.manual-doc table:has(tr > :nth-child(9)) th, .manual-doc table:has(tr > :nth-child(9)) td { padding: 4px 5px; }
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
  .manual-doc .chapter { page-break-before: always; border-top: none; margin-top: 0; }
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
 * Body HTML of an assembled manual: cover, chapter 1 "General" (1.1 General Info
 * with the manufacturer's address, 1.2 revision record, 1.3 clickable TOC,
 * 1.4 List of Effective Pages), module chapters numbered from 2 with anchored
 * headings, proprietary footer. Every section carries data-lep-* (issue / rev /
 * effective date of the doc it comes from) so the export can fill the List of
 * Effective Pages per printed page; the web view shows the per-chapter table.
 * opts: { logoUrl, coverUrl, footerText }
 */
export function manualBodyHtml({ manual, chapters, lang = DEFAULT_LANG }, opts = {}) {
  const { logoUrl = null, coverUrl = null, footerText = FOOTER_TEXT } = opts;
  const T = strings(lang);
  const date = new Date().toISOString().slice(0, 10);
  const logoHtml = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="FTD.aero">` : LOGO_SVG;
  const frontLep = { issue: '—', rev: '—', date: fmtDots(date) };
  const lepAttrs = (l) => ` data-lep-issue="${esc(l.issue)}" data-lep-rev="${esc(l.rev)}" data-lep-date="${esc(l.date)}"`;

  // chapter 1 is General — module chapters are numbered from 2
  const processed = chapters.map((c, i) => {
    const num = i + 2;
    const lep = c.missing ? frontLep : docEffectivity(c.doc);
    return c.missing ? { ...c, num, lep, html: '', items: [] } : { ...c, num, lep, ...numberHeadings(`${c.generated}\n${c.content}`, num) };
  });

  const recordRows = processed
    .map((c) =>
      c.missing
        ? `<tr><td>${c.num}</td><td class="missing">${esc(c.module?.name || c.slug)}</td><td colspan="4" class="missing">${T.noDocumentation}</td></tr>`
        : `<tr><td>${c.num}</td><td><a href="#ch-${esc(c.slug)}">${esc(c.title || c.module.name)}</a></td><td>${esc(
            c.module.code || '—'
          )}</td><td>${esc(c.doc.version)}${c.isDraft ? ` ${T.draft} r${c.doc.revision}` : ''}</td><td>${esc(
            c.doc.status
          )}</td><td>${fmtDate(c.doc.releasedAt || c.doc.updatedAt)}</td></tr>`
    )
    .join('\n');

  const generalItems = [
    ['general-info', T.generalInfoHeading],
    ['revision-record', T.revisionRecord],
    ['toc', T.tableOfContents],
    ['lep', T.lep],
  ];
  const generalToc = `<li><a href="#ch-general"><span class="num">1</span>${esc(T.general)}</a><ol>${generalItems
    .map(([id, title], i) => `<li class="l2"><a href="#${id}"><span class="num">1.${i + 1}</span>${esc(title)}</a></li>`)
    .join('')}</ol></li>`;
  const toc = [generalToc]
    .concat(
      processed.map((c) => {
        const title = esc(c.title || c.module?.name || c.slug);
        if (c.missing) return `<li class="missing"><span class="num">${c.num}</span>${title} — ${T.noDocumentation}</li>`;
        const subs = c.items
          .map(
            (it) =>
              `<li class="${it.level === 3 ? 'l3' : 'l2'}"><a href="#${it.id}"><span class="num">${it.num}</span>${esc(it.title)}</a></li>`
          )
          .join('');
        return `<li><a href="#ch-${esc(c.slug)}"><span class="num">${c.num}</span>${title}</a><ol>${subs}</ol></li>`;
      })
    )
    .join('\n');

  const lepChapterRows = [`<tr><td>1</td><td>${esc(T.general)}</td><td>—</td><td>—</td><td>${esc(frontLep.date)}</td></tr>`]
    .concat(
      processed.map(
        (c) =>
          `<tr><td>${c.num}</td><td>${esc(c.title || c.module?.name || c.slug)}</td><td>${esc(c.lep.issue)}</td><td>${esc(c.lep.rev)}</td><td>${esc(c.lep.date)}</td></tr>`
      )
    )
    .join('\n');

  const general = `<section class="chapter general" id="ch-general"${lepAttrs(frontLep)}>
<h1>${esc(T.general)}</h1>
<p>${T.generalIntro}</p>
<h2 id="general-info">${esc(T.generalInfoHeading)}</h2>
<p>${T.generalText1(`<strong>${esc(manual.name)}</strong>`)}</p>
<p>${T.generalText2}</p>
<p>${T.generalText3}</p>
<p class="manufacturer">${T.manufacturer.map(esc).join('<br>')}</p>
<h2 id="revision-record">${T.revisionRecord}</h2>
<table>
  <thead><tr><th>${T.chapter}</th><th>${T.module}</th><th>${T.code}</th><th>${T.docVersion}</th><th>${T.status}</th><th>${T.date}</th></tr></thead>
  <tbody>${recordRows}</tbody>
</table>
<h2 id="toc">${T.tableOfContents}</h2>
<div class="toc"><ol>${toc}</ol></div>
<h2 id="lep">${esc(T.lep)}</h2>
<p class="lep-note">${T.lepNote}</p>
<table class="lep-chapters">
<thead><tr><th>${T.chapter}</th><th>${T.module}</th><th>${T.issue}</th><th>${T.rev}</th><th>${T.effectiveDate}</th></tr></thead>
<tbody>
${lepChapterRows}
</tbody>
</table>
<table class="lep-pages">
<thead><tr><th>${T.page}</th><th>${T.issue}</th><th>${T.rev}</th><th>${T.effectiveDate}</th><th>${T.page}</th><th>${T.issue}</th><th>${T.rev}</th><th>${T.effectiveDate}</th></tr></thead>
<tbody></tbody>
</table>
</section>`;

  const body = processed
    .map((c) => {
      if (c.missing) {
        return `<section class="chapter" id="ch-${esc(c.slug)}"${lepAttrs(c.lep)}><h1>${esc(c.module?.name || c.slug)}</h1><p class="missing">${T.noDocumentationYet}</p></section>`;
      }
      const flags = [
        c.isDraft ? `<span class="draft-flag">${esc(T.draftFlag(c.doc.version, c.doc.revision))}</span>` : '',
        c.langFallback ? `<span class="draft-flag lang-flag">${esc(T.langFallback)}</span>` : '',
      ].join('');
      return `<section class="chapter" id="ch-${esc(c.slug)}"${lepAttrs(c.lep)}>
<h1>${esc(c.title || c.module.name)}${flags}</h1>
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
<section class="cover" id="cover"${lepAttrs(frontLep)}>
  ${headerBox(manual, logoHtml)}
  ${cover}
  <div class="sub">${esc(T.groups[manual.group] || (manual.group ? manual.group : T.assembled))} · ${esc(
    T.manualTypes[manualTypeOf(manual.manual).id]
  )} · ${T.compiled} ${date} · ${T.modules(chapters.length)}</div>
</section>
${general}
${body}
<footer class="doc-footer">${esc(footerText)}</footer>
</div>
</div>`;
}

/* ------------------------------------------------------------------ */
/* Standalone export — paginated with paged.js                         */
/* The export is the printed manual: A4 pages, the header box and the  */
/* proprietary text as running header/footer, "page / pages", and the  */
/* List of Effective Pages filled from the pages that actually came    */
/* out (the page count converges in a second pass because the list     */
/* itself takes pages). paged.js is inlined so the file stays          */
/* self-contained and offline.                                         */
/* ------------------------------------------------------------------ */

const FONT = "Verdana, Tahoma, 'DejaVu Sans', Geneva, sans-serif";

export const PAGED_CSS = `
@page {
  size: A4;
  margin: 34mm 14mm 22mm;
  @top-center { content: element(pageHeader); width: 100%; vertical-align: bottom; }
  @bottom-center { content: element(pageFooter); width: 100%; vertical-align: top; }
  @bottom-right { content: counter(page) " / " counter(pages); font-family: ${FONT}; font-size: 9px; color: #64748b; vertical-align: top; white-space: nowrap; border-top: 1px solid #c8d1db; padding-top: 4px; text-align: right; }
}
body { font-family: ${FONT}; }
.pagedjs_pages, .pagedjs_margin-content { font-family: ${FONT}; }
.manual-doc .print-header { position: running(pageHeader); display: block; }
.manual-doc .print-footer { position: running(pageFooter); display: block; }
.pagedjs_margin-content .print-footer { font-size: 8.5px; color: #64748b; text-align: center; border-top: 1px solid #c8d1db; padding-top: 4px; line-height: 1.4; }
.pagedjs_margin-content .head-box { width: 100%; border-collapse: collapse; border: 2px solid #1c2733; margin: 0 0 3mm; }
.pagedjs_margin-content .head-box td { border: 2px solid #1c2733; padding: 5px 10px; vertical-align: middle; }
.pagedjs_margin-content .head-title { text-align: center; width: 62%; }
.pagedjs_margin-content .head-code { font-size: 15px; font-weight: 700; line-height: 1.1; }
.pagedjs_margin-content .head-name { font-size: 11px; font-weight: 700; margin-top: 2px; }
.pagedjs_margin-content .head-logo { text-align: center; }
.pagedjs_margin-content .head-logo img, .pagedjs_margin-content .head-logo svg { height: 28px; max-width: 120px; display: inline-block; }
.manual-doc .manual { max-width: none; padding: 0; margin: 0; }
.manual-doc .cover { break-after: page; padding-top: 30mm; }
.manual-doc .cover .head-box { display: none; }
.manual-doc .chapter { break-before: page; border-top: none; margin-top: 0; padding-top: 0; }
.manual-doc .doc-footer { display: none; }
.manual-doc .lep-chapters, .manual-doc .lep-note { display: none; }
.manual-doc .lep-pages { display: table; }
.manual-doc h1, .manual-doc h2, .manual-doc h3 { break-after: avoid; }
.manual-doc tr, .manual-doc figure, .manual-doc .admonition { break-inside: avoid; }
.manual-doc .auto-section { background: none; padding: 0; }
@media screen {
  body { background: #e5e7eb; }
  .pagedjs_page { background: #fff; margin: 12px auto; box-shadow: 0 1px 6px rgb(0 0 0 / 0.25); }
}
`;

/** Runs in the exported file: paginates #source and fills the List of Effective Pages. */
const LEP_SCRIPT = `
(function () {
  var source = document.getElementById('source');
  var style = document.getElementById('manual-css');
  var html = source.innerHTML;
  var css = style.textContent;
  var mount = document.createElement('div');
  mount.id = 'pages';
  var FIELDS = ['issue', 'rev', 'date'];
  function cell(n, field, info) {
    var v = info[n];
    if (field === 'page') return '<td class="pg" data-p="' + n + '" data-f="page">' + n + '</td>';
    return '<td data-p="' + n + '" data-f="' + field + '">' + (v ? v[field] : '') + '</td>';
  }
  function entry(n, info) { return cell(n, 'page', info) + FIELDS.map(function (f) { return cell(n, f, info); }).join(''); }
  function rows(total, info) {
    var half = Math.ceil(total / 2), out = '';
    for (var i = 1; i <= half; i++) {
      var j = i + half;
      out += '<tr>' + entry(i, info) + (j <= total ? entry(j, info) : '<td></td><td></td><td></td><td></td>') + '</tr>';
    }
    return out;
  }
  function withLep(total, info) {
    return html.replace(/(<table class="lep-pages">[\\s\\S]*?<tbody>)[\\s\\S]*?(<\\/tbody>)/, function (m, a, b) { return a + rows(total, info) + b; });
  }
  function effectivity() {
    var info = {};
    var pages = mount.querySelectorAll('.pagedjs_page');
    for (var i = 0; i < pages.length; i++) {
      var el = pages[i].querySelector('[data-lep-issue]');
      info[i + 1] = el
        ? { issue: el.getAttribute('data-lep-issue'), rev: el.getAttribute('data-lep-rev'), date: el.getAttribute('data-lep-date') }
        : { issue: '', rev: '', date: '' };
    }
    return info;
  }
  async function run() {
    source.parentNode.removeChild(source);
    style.parentNode.removeChild(style);
    document.body.appendChild(mount);
    var total = 0, info = {}, previewer = null, flow = null;
    for (var pass = 0; pass < 4; pass++) {
      if (previewer) previewer.polisher.destroy();
      mount.innerHTML = '';
      previewer = new PagedModule.Previewer();
      flow = await previewer.preview(withLep(total, info), [{ 'manual.css': css }], mount);
      info = effectivity();
      if (flow.total === total) break;
      total = flow.total;
    }
    var cells = mount.querySelectorAll('.lep-pages td[data-f]');
    for (var k = 0; k < cells.length; k++) {
      var f = cells[k].getAttribute('data-f');
      var v = info[cells[k].getAttribute('data-p')];
      if (f !== 'page') cells[k].textContent = v ? v[f] : '';
    }
    document.documentElement.setAttribute('data-pages', String(flow.total));
  }
  run().catch(function (e) {
    console.error('pagination failed — showing the continuous document', e);
    if (mount.parentNode) mount.parentNode.removeChild(mount);
    document.head.appendChild(style);
    document.body.appendChild(source);
  });
})();
`;

let pagedJsSource = null;
function pagedJs() {
  if (pagedJsSource === null) {
    // the package's exports map hides dist/, so the file is read from the repo's node_modules
    const file = fileURLToPath(new URL('../node_modules/pagedjs/dist/paged.min.js', import.meta.url));
    pagedJsSource = readFileSync(file, 'utf8').replace(/<\/script/gi, '<\\/script');
  }
  return pagedJsSource;
}

/** The screen stylesheet without its browser-print block — the export paginates itself instead. */
const SCREEN_CSS = MANUAL_CSS.replace(/\n@media print \{[\s\S]*$/, '\n');

/** Standalone HTML document for export / print. */
export function manualExportHtml(compiled, opts = {}) {
  return `<!doctype html>
<html lang="${esc(compiled.lang || DEFAULT_LANG)}">
<head>
<meta charset="utf-8">
<title>${esc(compiled.manual.name)} — FTD.aero</title>
<style id="manual-css">
body { margin: 0; background: #fff; }
${SCREEN_CSS}
${PAGED_CSS}
</style>
</head>
<body>
<div id="source">
${manualBodyHtml(compiled, opts)}
</div>
<script>${pagedJs()}</script>
<script>${LEP_SCRIPT}</script>
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
