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

/** What a module is, for the modules list and section 3. The first three are what a new module
 *  picks from; the rest are older values existing modules keep — they are never migrated. */
export const CATEGORY_LABELS = {
  ios: 'IOS',
  cockpit: 'Cockpit',
  misc: 'MISC',
  'cockpit-hardware': 'Cockpit hardware',
  peripherals: 'Peripherals',
  structure: 'Structure',
  'instructor-station': 'Instructor station',
  software: 'Software',
  rack: 'Rack',
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
    revisionRecord: 'Revision record', documentRevisions: 'Document revisions', versionInEffect: (v, d) => `Document version ${v}, released ${d}.`, revision: 'Revision', date: 'Date', change: 'Description of change', inherited: 'inherited', noRevisions: 'No revisions recorded', releasedLine: 'Released.', lineAtRelease: 'Draft — the description is written at release.',
    introduction: 'Introduction', generalInfo: 'General information', module: 'Module', code: 'Code', category: 'Category', manualType: 'Manual type', docCode: 'Document code',
    hardware: 'Parts', unit: 'Part', relation: 'Relation', notes: 'Notes',
    relatedHardware: 'Related hardware', runsIn: 'Runs in',
    softwareRelation: 'Software relation', software: 'Software', coveredReleases: 'Covered releases', andLater: 'and later',
    audienceRow: (label, audience) => `${label} — ${audience} audience`,
    introAudience: { technician: 'It is intended for the installer and service technician and is not part of the documentation handed to the simulator operator.', customer: 'It is intended for the operator of the simulator.' },
    introSubject: (kind, name, detail, standalone) =>
      kind === 'software'
        ? standalone
          ? `the <strong>${name}</strong> software`
          : `the software of the <strong>${name}</strong> module (${detail})`
        : `the <strong>${name}</strong> module (${detail})`,
    intro1: (typeLabel, subject, audience) => `This document is the <strong>${typeLabel}</strong> for ${subject} of the FTD.aero flight simulation training device. ${audience}`,
    // assembled manual
    tableOfContents: 'Table of contents', notes: 'Notes', listOfFigures: 'List of figures', fig: 'Fig.', caption: 'Caption', pageAbbr: 'p.', chapterRef: (n) => `chapter ${n}`, chapter: 'Ch.', docVersion: 'Doc version', status: 'Status', noDocumentation: 'no documentation', noDocumentationYet: 'This module has no documentation yet.',
    draftFlag: (version, rev) => `draft ${version} r${rev} — not released`, langFallback: 'English — not translated', draft: 'draft',
    // chapter 1 — General (FTD manual template)
    frontMatter: 'Front matter', manualRevisions: 'Manual revisions', chapterRevisions: 'Chapters',
    lep: 'List of Effective Pages', page: 'Page', issue: 'Issue', rev: 'Rev.', serialNumber: 'Serial number', operatorName: 'Operator', issueRev: 'Issue / revision', issuedBy: 'Issued by', hardwareKind: 'Hardware', softwareKind: 'Software', effectiveDate: 'Effective date',
    headPage: 'Page', headVersion: 'Version', headRevision: 'Revision', headDate: 'Date',
    lepNote: 'Page numbers are assigned when the manual is opened for print or exported; the table below lists the effectivity of every chapter.',
  },
  pl: {
    manualTypes: { customer: 'Instrukcja użytkownika', technician: 'Instrukcja techniczna', 'software-customer': 'Instrukcja użytkownika oprogramowania', 'software-technician': 'Instrukcja techniczna oprogramowania' },
    groups: { SIM: 'Instrukcja symulatora', IOS: 'Instrukcja IOS', RACK: 'Instrukcja szaf RACK' },
    categories: { ios: 'IOS', cockpit: 'Kokpit', misc: 'Różne', software: 'Oprogramowanie', 'cockpit-hardware': 'Sprzęt kokpitu', structure: 'Konstrukcja', peripherals: 'Urządzenia peryferyjne', 'instructor-station': 'Stanowisko instruktora', rack: 'Rack' },
    audiences: { customer: 'klient', technician: 'technik' },
    revisionRecord: 'Rejestr zmian', documentRevisions: 'Wersje dokumentu', versionInEffect: (v, d) => `Wersja dokumentu ${v}, wydana ${d}.`, revision: 'Wersja', date: 'Data', change: 'Opis zmiany', inherited: 'odziedziczona', noRevisions: 'Brak zarejestrowanych wersji', releasedLine: 'Wydanie.', lineAtRelease: 'Wersja robocza — opis zmiany powstaje przy wydaniu.',
    introduction: 'Wprowadzenie', generalInfo: 'Informacje ogólne', module: 'Moduł', code: 'Kod', category: 'Kategoria', manualType: 'Rodzaj instrukcji', docCode: 'Kod dokumentu',
    hardware: 'Części', unit: 'Część', relation: 'Relacja', notes: 'Uwagi',
    relatedHardware: 'Powiązany sprzęt', runsIn: 'Pracuje w',
    softwareRelation: 'Powiązane oprogramowanie', software: 'Oprogramowanie', coveredReleases: 'Objęte wydania', andLater: 'i nowsze',
    audienceRow: (label, audience) => `${label} — odbiorca: ${audience}`,
    introAudience: { technician: 'Jest przeznaczony dla instalatora i technika serwisu i nie stanowi części dokumentacji przekazywanej operatorowi symulatora.', customer: 'Jest przeznaczony dla operatora symulatora.' },
    introSubject: (kind, name, detail, standalone) =>
      kind === 'software'
        ? standalone
          ? `oprogramowania <strong>${name}</strong>`
          : `oprogramowania modułu <strong>${name}</strong> (${detail})`
        : `modułu <strong>${name}</strong> (${detail})`,
    intro1: (typeLabel, subject, audience) => `Niniejszy dokument to <strong>${typeLabel}</strong> ${subject} urządzenia do szkolenia lotniczego FTD.aero. ${audience}`,
    tableOfContents: 'Spis treści', notes: 'Notatki', listOfFigures: 'Spis rysunków', fig: 'Rys.', caption: 'Podpis', pageAbbr: 's.', chapterRef: (n) => `rozdział ${n}`, chapter: 'Rozdz.', docVersion: 'Wersja dok.', status: 'Status', noDocumentation: 'brak dokumentacji', noDocumentationYet: 'Ten moduł nie ma jeszcze dokumentacji.',
    draftFlag: (version, rev) => `wersja robocza ${version} r${rev} — niewydana`, langFallback: 'wersja angielska — brak tłumaczenia', draft: 'robocza',
    frontMatter: 'Strony wstępne', manualRevisions: 'Rewizje instrukcji', chapterRevisions: 'Rozdziały',
    lep: 'Wykaz obowiązujących stron', page: 'Strona', issue: 'Wydanie', rev: 'Rew.', serialNumber: 'Numer seryjny', operatorName: 'Operator', issueRev: 'Wydanie / rewizja', issuedBy: 'Wydawca', hardwareKind: 'Sprzęt', softwareKind: 'Oprogramowanie', effectiveDate: 'Data obowiązywania',
    headPage: 'Strona', headVersion: 'Wersja', headRevision: 'Rewizja', headDate: 'Data',
    lepNote: 'Numery stron są nadawane przy otwarciu instrukcji do druku lub eksporcie; poniższa tabela podaje obowiązującą wersję każdego rozdziału.',
  },
};

/** UI strings of one language (English strings fill any gap). */
export const strings = (lang) => ({ ...STRINGS.en, ...(STRINGS[langOf(lang)] || {}) });
export const manualTypeLabel = (id, lang = DEFAULT_LANG) => strings(lang).manualTypes[manualTypeOf(id).id];
export const groupLabel = (g, lang = DEFAULT_LANG) => strings(lang).groups[g] || GROUP_LABELS[g] || g;

/** Sections 1–3 as read-only HTML, generated from module + doc metadata, in `lang`. */
export function generatedSections(
  module,
  doc,
  lang = DEFAULT_LANG,
  { revisionHistory = true, relatedHardware = [], assembled = false } = {}
) {
  const T = strings(lang);
  // The revision column carries the date under the revision: short lines in one narrow column
  // instead of a third column, so the description keeps the width it needs. Each line is a block
  // element, so the cell stacks even where the stylesheet has not arrived yet, and the
  // "(inherited)" note sits on its own line where it is free to wrap.
  // Only the release lines print — what the author wrote for the reader when the version went out.
  // The working entries ("Created via MCP", "AI edit: …") stay in the doc's history, never here.
  const released = doc.status === 'released' || doc.status === 'superseded';
  const lines = (doc.revisionRecord || []).filter((r) => r.public);
  const own = lines.some((r) => !r.inherited && (r.version || doc.version) === doc.version);
  // A version released before the line was asked for still says it was released, and when.
  if (released && !doc.hotfix && !own && doc.releasedAt)
    lines.push({ rev: `r${doc.revision}`, version: doc.version, date: doc.releasedAt, summary: T.releasedLine });
  // A draft shows where its line will go.
  if (!released || doc.hotfix) lines.push({ rev: `r${doc.revision}`, version: doc.version, date: doc.updatedAt, summary: T.lineAtRelease, pending: true });
  const record = lines
    .map(
      (r) =>
        `<tr><td class="rev-cell"><div class="rev-id">${esc(r.version || doc.version)} ${esc(r.rev)}</div><div class="rev-date">${fmtDate(
          r.date
        )}</div>${r.inherited ? `<div class="rev-note"><em>(${T.inherited})</em></div>` : ''}</td><td>${
          r.pending ? `<em>${esc(r.summary)}</em>` : esc(r.summary)
        }</td></tr>`
    )
    .join('\n');

  const swRows =
    (module.softwares || [])
      .map((s) => {
        const cov = (doc.covers || []).find((c) => c.name === s.name);
        const range = cov ? (cov.to ? (cov.to === cov.from ? cov.from : `${cov.from} – ${cov.to}`) : `${cov.from} ${T.andLater}`) : s.fromVersion;
        return `<tr><td>${esc(s.name)}</td><td>${esc(range || '—')}</td></tr>`;
      })
      .join('\n');

  const hwRows =
    hardwareItemsOf(module)
      .map(
        (h) =>
          `<tr><td>${esc(hardwareItemLabel(h))}</td><td>${esc(hardwareDetail(h))}</td><td>${esc(h.notes || '')}</td></tr>`
      )
      .join('\n');

  const type = manualTypeOf(doc.manual);
  // A software documented on its own: it is its own subject and has no hardware to list.
  const ownedBySoftware = module.kind === 'software';
  // A table of "none" says nothing: a manual lists hardware or software only when there is some.
  // Parts belong to the technician: the operator is told what the module does, not what it is made of.
  const hasHardware = !ownedBySoftware && type.audience !== 'customer' && hardwareItemsOf(module).length > 0;
  // A software has no parts of its own, but the technician still has to know which units run it:
  // the parts of the modules that link this software, named with the module they sit in.
  const hasRelated = ownedBySoftware && type.audience !== 'customer' && relatedHardware.length > 0;
  const relRows = relatedHardware
    .map(
      (h) =>
        `<tr><td>${esc(hardwareItemLabel(h))}</td><td>${esc(hardwareDetail(h))}</td><td>${esc(
          (h.modules || []).map((m) => m.name).join(', ') || '—'
        )}</td></tr>`
    )
    .join('\n');
  const hasSoftware = (module.softwares || []).length > 0;
  const typeLabel = esc(T.manualTypes[type.id]);
  const typeLower = lang === 'en' ? typeLabel.toLowerCase() : typeLabel.charAt(0).toLowerCase() + typeLabel.slice(1);
  const audience = T.introAudience[type.audience];
  const subject = T.introSubject(
    type.kind,
    esc(module.name),
    type.kind === 'software' ? esc(softwareLabel(module.softwares)) : esc(module.code || module.slug),
    ownedBySoftware
  );

  // In an assembled manual a chapter opens with its own text. What sections 1–3 would repeat in
  // every chapter — the version in effect, the stock introduction, the module / code / category /
  // manual type / document code table — is said once, in the front matter's chapter table. Only
  // the tables that carry something about this chapter stay: its parts and the hardware that runs
  // it. The software releases it documents are in the chapter heading's badge.
  if (assembled) {
    const tables = [
      !hasHardware ? '' : `<h3>${T.hardware}</h3>
<table>
<thead><tr><th>${T.unit}</th><th>${T.relation}</th><th>${T.notes}</th></tr></thead>
<tbody>
${hwRows}
</tbody>
</table>`,
      !hasRelated ? '' : `<h3>${T.relatedHardware}</h3>
<table>
<thead><tr><th>${T.unit}</th><th>${T.relation}</th><th>${T.runsIn}</th></tr></thead>
<tbody>
${relRows}
</tbody>
</table>`,
      // The software and the releases it covers are said by the chapter's badge (kindBadge).
    ].filter(Boolean);
    return tables.length ? `<section class="auto-section" data-auto="3">\n<h2>${T.generalInfo}</h2>\n${tables.join('\n')}\n</section>\n` : '';
  }

  return `<section class="auto-section" data-auto="1">
<h2>${T.revisionRecord}</h2>
${revisionHistory
  ? `<h3>${T.documentRevisions}</h3>
<table class="revisions">
<thead><tr><th class="rev-cell">${T.revision}</th><th>${T.change}</th></tr></thead>
<tbody>
${record || `<tr><td colspan="2">${T.noRevisions}</td></tr>`}
</tbody>
</table>`
  : `<p>${T.versionInEffect(esc(doc.version), fmtDate(doc.releasedAt || doc.updatedAt))}</p>`}
</section>
<section class="auto-section" data-auto="2">
<h2>${T.introduction}</h2>
<p>${T.intro1(typeLower, subject, audience)}</p>
</section>
<section class="auto-section" data-auto="3">
<h2>${T.generalInfo}</h2>
<table>
<tbody>
<tr><th>${ownedBySoftware ? T.software : T.module}</th><td>${esc(module.name)}</td></tr>
<tr><th>${T.code}</th><td>${esc(module.code || '—')}</td></tr>
<tr><th>${T.manualType}</th><td>${T.audienceRow(typeLabel, esc(T.audiences[type.audience]))}</td></tr>
<tr><th>${T.docCode}</th><td>${esc(manualDocCode(module, type.id))}</td></tr>
</tbody>
</table>
${!hasHardware ? '' : `<h3>${T.hardware}</h3>
<table>
<thead><tr><th>${T.unit}</th><th>${T.relation}</th><th>${T.notes}</th></tr></thead>
<tbody>
${hwRows}
</tbody>
</table>`}
${!hasRelated ? '' : `<h3>${T.relatedHardware}</h3>
<table>
<thead><tr><th>${T.unit}</th><th>${T.relation}</th><th>${T.runsIn}</th></tr></thead>
<tbody>
${relRows}
</tbody>
</table>`}
${!hasSoftware ? '' : `<h3>${T.softwareRelation}</h3>
<table>
<thead><tr><th>${T.software}</th><th>${T.coveredReleases}</th></tr></thead>
<tbody>
${swRows}
</tbody>
</table>`}
</section>
`;
}

/* ------------------------------------------------------------------ */
/* Assembled manual                                                    */
/* ------------------------------------------------------------------ */

/**
 * A body section that says nothing. Every doc carries its manual type's four sections, and an author
 * with nothing to put under one writes "—" or "Refer to Description." In an assembled manual such a
 * section is only a heading the reader pages past, and a line in the contents, so it is left out.
 * Only bodies with no information at all go — empty, dashes, N/A / Not applicable / None, a bare
 * "Refer to <section>." or TODO(author) markers. A sentence that tells the reader something ("No
 * routine maintenance is required") stays, and so does any section with a picture, table, list,
 * admonition or subsection. The doc itself is untouched: the editor still shows every section.
 */
/**
 * Build variables. A module is a chapter of several simulator manuals, so its text never names the
 * manual it is printed in — it writes {{manual.title}} or {{manual.code}}, and the build fills in the
 * manual being assembled (the same manual the page header names). Outside a manual the token stays.
 */
const MANUAL_VARS = { title: (m) => m.name, code: (m) => m.code || m.name };
export function fillManualVars(html, manual) {
  if (!manual) return String(html || '');
  return String(html || '').replace(/\{\{\s*manual\.(title|code)\s*\}\}/g, (_, k) => esc(MANUAL_VARS[k](manual) || ''));
}

const PLACEHOLDER_TEXT = /^(?:[\s—–\-.…]*|n\/?a\.?|not applicable\.?|none\.?|refer to [^.]{1,40}\.?)$/i;
const TODO_SENTENCE = /\bTODO(?:\([^)]*\))?\s*:.*?(?:[.!?](?=\s|$)|$)/gi;
export function dropPlaceholderSections(html) {
  return String(html || '')
    .split(/(?=<h2[\s>])/i)
    .filter((part) => {
      const head = /^<h2[^>]*>[\s\S]*?<\/h2>/i.exec(part);
      if (!head) return true; // whatever stands before the first section
      const body = part.slice(head[0].length);
      if (/<(?:img|figure|table|ol|ul|h3|h4|iframe|video)\b|class="[^"]*admonition|class="[^"]*attachment/i.test(body)) return true;
      const text = body
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&mdash;|&#8212;|&ndash;|&#8211;/g, '—')
        .replace(/&hellip;|&#8230;/g, '…')
        .replace(TODO_SENTENCE, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return !PLACEHOLDER_TEXT.test(text);
    })
    .join('');
}

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
/* The header of the company template, to the millimetre — see headerBox(). */
.manual-doc .head-box { width: 190mm; max-width: 100%; table-layout: fixed; border-collapse: collapse; margin: 0 auto 6mm; color: #000; }
.manual-doc .head-box td { border: 0.5pt solid #000; padding: 0.4mm 1.2mm; vertical-align: middle; }
.manual-doc .head-box .c-logo { width: 26.6mm; }
.manual-doc .head-box .c-lbl { width: 19mm; }
.manual-doc .head-box .c-val { width: 19mm; }
.manual-doc .head-box .c-date { width: 67.5mm; }
.manual-doc .hb-logo { text-align: center; overflow: hidden; }
/* 21 mm as in the template, but never wider than its cell (the box narrows with a narrow window) */
/* and never taller than the three rows it spans — a logo of any proportions stays inside its lines. */
.manual-doc .hb-logo img, .manual-doc .hb-logo svg { width: 21mm; max-width: 100%; height: auto; max-height: 11mm; object-fit: contain; display: inline-block; vertical-align: middle; }
.manual-doc .hb-title, .manual-doc .hb-sub { font-size: 6pt; font-weight: 700; text-align: justify; line-height: 1.3; }
.manual-doc .hb-page { font-family: Arial, 'Liberation Sans', Helvetica, 'DejaVu Sans', sans-serif; font-size: 10pt; text-align: center; }
.manual-doc .hb-lbl, .manual-doc .hb-val { font-size: 6pt; text-align: center; line-height: 1.3; }
.manual-doc .cover { text-align: center; padding: 10px 0 40px; }
/* the notes page exists on paper only (the export shows it) */
.manual-doc .notes-page { display: none; }
.manual-doc .cover-image img { max-width: 92%; max-height: 420px; margin: 18px auto 10px; display: block; }
.manual-doc .cover-title { margin: 28px 0 8px; }
.manual-doc .cover-code { font-size: 14px; font-weight: 700; letter-spacing: 0.12em; color: #475569; }
.manual-doc .cover-name { font-size: 30px; font-weight: 700; line-height: 1.2; color: #0f172a; margin: 6px 0; }
.manual-doc .cover-device { font-size: 16px; color: #334155; }
.manual-doc .cover-facts { margin: 18px auto 0; width: auto; min-width: 55%; border-collapse: collapse; font-size: 13px; text-align: left; }
.manual-doc .cover-facts th, .manual-doc .cover-facts td { border: 0; border-bottom: 1px solid #d5dce4; padding: 5px 12px; background: none; }
.manual-doc .cover-facts th { color: #64748b; font-weight: 400; width: 40%; }
.manual-doc .cover-company { display: flex; align-items: center; justify-content: center; gap: 14px; margin-top: 28px; font-size: 12px; color: #334155; text-align: left; }
.manual-doc .cover-logo img, .manual-doc .cover-logo svg { height: 34px; width: auto; display: block; }
/* What kind of chapter this is: hardware, or software with the releases it covers. */
.manual-doc .kind-badge { display: inline-block; vertical-align: middle; margin-left: 10px; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; border: 1px solid; }
.manual-doc .kind-badge.hw { color: #334155; border-color: #94a3b8; background: #f1f5f9; }
.manual-doc .kind-badge.sw { color: #1e40af; border-color: #93c5fd; background: #eff6ff; }
.manual-doc .cover-placeholder { margin: 40px auto; width: 70%; height: 240px; border: 1px dashed #c8d1db; border-radius: 8px; color: #94a3b8; display: flex; align-items: center; justify-content: center; font-size: 14px; }
.manual-doc .lep-note { color: #64748b; font-size: 12px; }
.manual-doc .lep-pages { display: none; }
.manual-doc .lep-pages th, .manual-doc .lep-pages td { text-align: center; }
.manual-doc .lep-pages td.pg { background: #f1f4f8; font-weight: 600; }
.manual-doc .lep-pages { font-size: 9px; }
.manual-doc .lep-pages th, .manual-doc .lep-pages td { padding: 1px 3px; line-height: 1.25; }
.manual-doc .toc ol { margin: 0; padding-left: 22px; line-height: 1.9; }
.manual-doc .toc > ol { list-style: none; padding-left: 0; }
.manual-doc .toc > ol > li { font-weight: 600; margin: 6px 0; }
.manual-doc .toc ol ol { list-style: none; padding-left: 22px; font-weight: 400; color: #475569; font-size: 14px; }
.manual-doc .toc .l3 { padding-left: 18px; }
/* Cross-references (contents, revision record, in-text links) read as part of the text: the
   document’s own colour, no underline — on screen it appears on hover. */
.manual-doc a[href^="#"] { color: inherit; text-decoration: none; }
.manual-doc a[href^="#"]:hover { text-decoration: underline; text-decoration-color: #94a3b8; }
.manual-doc .toc a { color: inherit; text-decoration: none; }
.manual-doc .toc a:hover { color: #0b5fff; text-decoration: underline; }
.manual-doc .toc .num { display: inline-block; min-width: 46px; color: #64748b; font-variant-numeric: tabular-nums; }
.manual-doc table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 12.5px; }
.manual-doc th, .manual-doc td { border: 1px solid #c8d1db; padding: 7px 10px; text-align: left; vertical-align: top; overflow-wrap: break-word; }
/* A checklist table (markChecklists): the number stays whole, and each task gets tick boxes. */
.manual-doc table.checklist td.num { width: 1%; white-space: nowrap; text-align: center; font-weight: 700; }
.manual-doc table.checklist td.check { width: 1%; white-space: nowrap; vertical-align: top; }
.manual-doc table.checklist .box { display: inline-block; width: 3.2mm; height: 3.2mm; border: 1px solid #1c2733; border-radius: 1px; vertical-align: -0.5mm; margin: 0 4px 0 0; }
.manual-doc table.checklist .box + .box-label { margin-right: 12px; }
.manual-doc table.checklist tbody tr:nth-child(even) td { background: #f7f9fb; }
.manual-doc table.checklist td > :first-child { margin-top: 0; }
.manual-doc table.checklist td > :last-child { margin-bottom: 0; }
.manual-doc table.checklist th { white-space: nowrap; }
.manual-doc table.checklist th:nth-child(2) { white-space: normal; }
.manual-doc th { background: #f1f4f8; }
/* wide tables (9+ columns) go compact so cells rarely have to break words to fit the page */
.manual-doc table:has(tr > :nth-child(9)) { font-size: 10.5px; }
.manual-doc table:has(tr > :nth-child(9)) th, .manual-doc table:has(tr > :nth-child(9)) td { padding: 4px 5px; }
.manual-doc h1, .manual-doc h2, .manual-doc h3 { scroll-margin-top: 70px; }
.manual-doc .chapter { counter-increment: chap; counter-reset: sec; margin-top: 60px; padding-top: 24px; border-top: 1px dashed #dde3ea; }
/* Front matter: the same page furniture as a chapter, but it is not one — no number, and the */
/* headings inside it are not numbered either.                                                */
/* A table the author sized in the editor keeps those widths (a <colgroup> of percentages). */
.manual-doc .chapter table:has(> colgroup) { table-layout: fixed; }
.manual-doc .front > h2 { font-size: 18px; margin: 30px 0 12px; padding-bottom: 6px; border-bottom: 2px solid #16324f; }
.manual-doc .front > h2:first-child { margin-top: 0; }
.manual-doc .front > h3 { font-size: 14.5px; margin: 20px 0 8px; }
/* The front matter's tables keep their words whole: a long document code wraps at its hyphens, */
/* a date or a status never wraps — the columns size themselves to that.                          */
.manual-doc .front th, .manual-doc .front td { overflow-wrap: normal; word-break: normal; }
.manual-doc .front td.doc-code { font-size: 11px; }
.manual-doc .chapter-record td:first-child, .manual-doc .chapter-record td:nth-last-child(-n+3) { white-space: nowrap; }
.manual-doc .lep-chapters td:first-child, .manual-doc .lep-chapters td:nth-last-child(-n+3) { white-space: nowrap; }
.manual-doc .toc li.front { font-weight: 600; }
.manual-doc .toc li.front::before { content: none; }
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
/* No picture prints postage-stamp size. Outside a table a figure takes at least 60 % of the text     */
/* width (a small screenshot is scaled up), and a tall one is held to a page. In a table a picture     */
/* fills its column but never below 35 mm. data-size="small|medium|large|full" on a <figure> sets it. */
.manual-doc figure img { min-width: 60%; max-height: 190mm; object-fit: contain; }
.manual-doc .chapter td img, .manual-doc .chapter th img, .manual-doc .chapter td figure img { width: 100%; min-width: 35mm; max-height: none; }
.manual-doc figure[data-size="small"] img { min-width: 0; width: 40%; }
.manual-doc figure[data-size="medium"] img { min-width: 0; width: 60%; }
.manual-doc figure[data-size="large"] img { min-width: 0; width: 80%; }
.manual-doc figure[data-size="full"] img { min-width: 0; width: 100%; }
.manual-doc figcaption { color: #64748b; font-size: 12.5px; margin-top: 6px; }
.manual-doc .fig-num { font-weight: 700; color: #334155; margin-right: 4px; }
/* A page number exists only once the manual is paginated (export / PDF). */
.manual-doc .paged-only { display: none; }
.manual-doc .xref-at { white-space: nowrap; }
/* A reference to a module this manual does not carry: flagged on screen, plain words in print. */
.manual-doc .xref-missing { background: #fff4e5; border-bottom: 1px dashed #d97706; }
.manual-doc .lof td:first-child, .manual-doc .lof td:last-child { white-space: nowrap; }
.manual-doc .lof { width: 100%; table-layout: auto; }
.manual-doc a.attachment { display: inline-block; padding: 4px 10px 4px 8px; border: 1px solid #c8d1db; border-radius: 6px; background: #f6f8fb; color: #16324f; text-decoration: none; font-family: ui-monospace, Consolas, monospace; font-size: 13px; }
.manual-doc a.attachment::before { content: '📎 '; }
.manual-doc .admonition { border-left: 4px solid; border-radius: 6px; padding: 10px 14px; margin: 14px 0; }
.manual-doc .admonition-title { font-weight: 700; text-transform: uppercase; font-size: 12px; letter-spacing: 0.05em; margin: 0 0 4px; }
.manual-doc .admonition.warning { background: #fff7ed; border-color: #f97316; }
.manual-doc .admonition.warning .admonition-title { color: #c2410c; }
.manual-doc .admonition.note { background: #eff6ff; border-color: #0b5fff; }
.manual-doc .admonition.note .admonition-title { color: #0b5fff; }
.manual-doc .auto-section { background: #fafbfc; padding: 0 12px 6px; border-radius: 6px; }
/* Table cells break words anywhere; the revision column must not, or "Revision" reads "Revi sion". */
.manual-doc table.revisions .rev-cell { width: 27mm; }
.manual-doc table.revisions th.rev-cell, .manual-doc table.revisions .rev-id, .manual-doc table.revisions .rev-date { white-space: nowrap; overflow-wrap: normal; word-break: keep-all; hyphens: none; }
.manual-doc table.revisions .rev-id { font-variant-numeric: tabular-nums; }
.manual-doc table.revisions .rev-date, .manual-doc table.revisions .rev-note { color: #64748b; font-size: 11.5px; }
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
  .manual-doc .cover .head-box, .manual-doc .doc-footer, .manual-doc .cover-placeholder { display: none; }
  .manual-doc .chapter { page-break-before: always; border-top: none; margin-top: 0; }
  .manual-doc .front { page-break-after: always; }
  .manual-doc .cover { page-break-after: always; }
}
`;

/**
 * Number and anchor every h2/h3 of one chapter: assigns ids c<ch>-s<n>[-<m>]
 * (matching the CSS counters) and returns the outline for the TOC.
 */
/**
 * Says what kind of chapter this is, next to its title: Hardware, or Software with the software it
 * documents and the releases this version covers ("Software · startPanelUI 2.0.1 and later"). It
 * replaces the Software relation table an assembled chapter used to carry.
 */
function kindBadge(c, T) {
  const software = c.software || c.module?.kind === 'software' || manualTypeOf(c.doc?.manual).kind === 'software';
  if (!software) return `<span class="kind-badge hw">${esc(T.hardwareKind)}</span>`;
  const covered = (c.doc?.covers || [])
    .map((cov) => {
      const range = cov.to ? (cov.to === cov.from ? cov.from : `${cov.from} – ${cov.to}`) : cov.from ? `${cov.from} ${T.andLater}` : '';
      return [cov.name, range].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  return `<span class="kind-badge sw">${esc([T.softwareKind, ...covered].join(' · '))}</span>`;
}

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
      num = ch ? `${ch}.${s2}` : `${s2}`;
      id = `c${ch}-s${s2}`;
    } else {
      s3 += 1;
      num = ch ? `${ch}.${s2}.${s3}` : `${s2}.${s3}`;
      id = `c${ch}-s${s2}-${s3}`;
    }
    items.push({ level: isH2 ? 2 : 3, title, num, id });
    const cleanAttrs = (attrs || '').replace(/\sid="[^"]*"/i, '');
    return `<${tag}${cleanAttrs} id="${id}">${inner}</${tag}>`;
  });
  return { html: out, items };
}

/**
 * A checklist written as a table — every row ends in "Yes / No" (or "Tak / Nie") — prints as one:
 * a tick box before each answer, the task number kept whole in a narrow column, alternate rows
 * shaded. The author writes a plain table; nothing to learn.
 */
const YES_NO = /^\s*(yes|tak)\s*\/\s*(no|nie)\s*$/i;
const cellText = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;| /g, ' ').trim();
function markChecklists(html) {
  return String(html || '').replace(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi, (whole, attrs, inner) => {
    // the header row stays as written; the rows after it are the tasks
    const headEnd = inner.search(/<\/thead>/i);
    const head = headEnd >= 0 ? inner.slice(0, headEnd + '</thead>'.length) : '';
    const body = inner.slice(head.length);
    // Task rows have two cells or more; a row of one cell spanning the table is a caution or a
    // note between the tasks and stays as written.
    const cells = [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((r) => [...r[1].matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)])
      .filter((c) => c.length >= 2);
    if (cells.length < 2 || !cells.every((c) => YES_NO.test(cellText(c[c.length - 1][2])))) return whole;
    const numbered = cells.every((c) => /^\d+[.)]?$/.test(cellText(c[0][2])));
    const newBody = body.replace(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi, (row, trAttrs, rowInner) => {
      const tds = [...rowInner.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
      if (tds.length < 2) return row;
      const [, yes, no] = YES_NO.exec(cellText(tds[tds.length - 1][2]));
      const out = tds.map((m, i) => {
        if (i === tds.length - 1)
          return `<td class="check"><span class="box"></span><span class="box-label">${esc(yes)}</span><span class="box"></span><span class="box-label">${esc(no)}</span></td>`;
        if (i === 0 && numbered) return `<td class="num">${cellText(m[2])}</td>`;
        return m[0];
      });
      return `<tr${trAttrs}>${out.join('')}</tr>`;
    });
    const cls = /\bclass="/i.test(attrs) ? attrs.replace(/\bclass="/i, 'class="checklist ') : `${attrs} class="checklist"`;
    return `<table${cls}>${head}${newBody}</table>`;
  });
}

/**
 * Figures are numbered by the build, per chapter, in the order they stand (Fig. 11.3) — authors
 * write the caption only. A number typed by hand ("Fig. 2.10 …", "Rys. 2.1 …", "3. …") is dropped
 * from the caption, so a printed number can never drift from the real order. Each figure gets an
 * id the List of figures links to.
 */
const HAND_NUMBER = /^((?:\s*<[^>/][^>]*>)*)\s*(?:(?:fig(?:ure)?|rys(?:unek)?)\.?\s*\d+(?:\.\d+)*[.:)]?|\d+(?:\.\d+)*[.)](?=\s))\s*[-–—:]?\s*/i;
function numberFigures(html, ch, T) {
  let k = 0;
  const figures = [];
  const out = String(html || '').replace(/<figure\b([^>]*)>([\s\S]*?)<\/figure>/gi, (m, attrs, inner) => {
    k += 1;
    const num = ch ? `${ch}.${k}` : `${k}`;
    const id = `fig-${ch}-${k}`;
    let caption = '';
    const body = inner.replace(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i, (_, c) => {
      caption = c.replace(HAND_NUMBER, '$1').trim();
      return '';
    });
    const title = caption.replace(/<[^>]+>/g, '').trim();
    figures.push({ id, num, title });
    return `<figure${attrs.replace(/\sid="[^"]*"/i, '')} id="${id}">${body}<figcaption><span class="fig-num">${esc(T.fig)} ${num}</span>${
      title ? ` ${caption}` : ''
    }</figcaption></figure>`;
  });
  return { html: out, figures };
}

/**
 * Cross-references. A module is named as <a data-module="loose-knob-repair">Loose knob repair</a>;
 * the build resolves it against the manual being assembled: a chapter of this manual becomes a link
 * with where it is — "(chapter 19, p. 76)", the page written in once the manual is paginated. A
 * module this manual does not carry keeps its words as plain text, and `missingCrossRefs` reports it.
 * A software that documents itself is named by its slug the same way.
 */
const XREF_RE = /<a\b([^>]*?)\sdata-module="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;
function xrefTargets(chapters) {
  const targets = new Map();
  chapters.forEach((c, i) => {
    if (c.missing) return;
    const t = { slug: c.slug, num: i + 1 };
    if (!targets.has(c.slug)) targets.set(c.slug, t);
    if (c.module?.slug && !targets.has(c.module.slug)) targets.set(c.module.slug, t);
  });
  return targets;
}
function resolveXrefs(html, targets, T) {
  return String(html || '').replace(XREF_RE, (m, a1, slug, a2, inner) => {
    const t = targets.get(slug);
    if (!t) return `<span class="xref-missing" data-module="${esc(slug)}">${inner}</span>`;
    const href = `#ch-${esc(t.slug)}`;
    return `<a class="xref" href="${href}">${inner}</a> <span class="xref-at">(${esc(T.chapterRef(t.num))}<span class="paged-only">, ${esc(
      T.pageAbbr
    )} <a class="pg-ref" href="${href}">—</a></span>)</span>`;
  });
}
/** References in the chapters to modules this manual does not carry: [{chapter, title, target, text}]. */
export function missingCrossRefs(chapters) {
  const targets = xrefTargets(chapters);
  const out = [];
  for (const c of chapters) {
    for (const [, , slug, , inner] of String(c.content || '').matchAll(XREF_RE)) {
      if (!targets.has(slug))
        out.push({ chapter: c.slug, title: c.title || c.module?.name || c.slug, target: slug, text: inner.replace(/<[^>]+>/g, '').trim() });
    }
  }
  return out;
}

/**
 * Header box, copied from the company template `Dok firmowy wzór.docx`: one 190 mm table,
 * centred, 0.5 pt black rules, in three rows — the logo spanning them on the left (21 mm wide),
 * the document title and its subtitle in Verdana 6 pt bold, the page counter on the right in
 * Arial 10 pt (label regular, number bold), and the version / revision / date row in Verdana 6 pt.
 * Column widths are the template’s, in millimetres: 26.6 · 19 · 19 · 19 · 19 · 20 · 67.5.
 */
function headerBox(manual, logoHtml, T, head = {}) {
  const title = esc(head.title || manual.name || "");
  const sub = esc(head.subtitle || manual.code || GROUP_LABELS[manual.group] || manual.group || '');
  const version = esc(head.version || '');
  const revision = esc(head.revision || '');
  const date = esc(head.date || '');
  return `<table class="head-box">
<colgroup><col class="c-logo"><col class="c-lbl"><col class="c-val"><col class="c-lbl"><col class="c-val"><col class="c-lbl"><col class="c-date"></colgroup>
<tr>
<td class="hb-logo" rowspan="3">${logoHtml}</td>
<td class="hb-title" colspan="4">${title}</td>
<td class="hb-page" colspan="2" rowspan="2">${T.headPage}: <b class="pg"></b></td>
</tr>
<tr><td class="hb-sub" colspan="4">${sub}</td></tr>
<tr>
<td class="hb-lbl">${T.headVersion}:</td><td class="hb-val">${version}</td>
<td class="hb-lbl">${T.headRevision}:</td><td class="hb-val">${revision}</td>
<td class="hb-lbl">${T.headDate}:</td><td class="hb-val">${date}</td>
</tr>
</table>`;
}

/**
 * Body HTML of an assembled manual: cover, chapter 1 "General" (1.1 revision
 * record, 1.2 clickable TOC, 1.3 List of Effective Pages — what the manual says
 * about itself; the company and safety text is written as a module chapter),
 * module chapters numbered from 2 with anchored
 * headings, proprietary footer. Every section carries data-lep-* (issue / rev /
 * effective date of the doc it comes from) so the export can fill the List of
 * Effective Pages per printed page; the web view shows the per-chapter table.
 * opts: { logoUrl, coverUrl, footerText }
 */
export function manualBodyHtml({ manual, chapters, lang = DEFAULT_LANG, state = null, single = false }, opts = {}) {
  const { logoUrl = null, coverUrl = null, footerText = FOOTER_TEXT } = opts;
  const T = strings(lang);
  const date = new Date().toISOString().slice(0, 10);
  const logoHtml = logoUrl ? `<img class="logo" src="${esc(logoUrl)}" alt="FTD.aero">` : LOGO_SVG;
  // The manual's own issue and revision, as its last release stamped them. When the chapters have
  // moved since — or it was never released — the pages say so: the next revision, marked as a
  // draft and dated today. A printed page never claims a released revision for text nobody released.
  const rel = state?.released;
  // A doc printed on its own (a draft checked on paper) carries its own version and revision.
  const one = single ? chapters[0] : null;
  const frontLep = one
    ? { issue: one.doc.version, rev: `r${one.doc.revision}${one.isDraft ? ` (${T.draft})` : ''}`, date: fmtDots(one.doc.releasedAt || one.doc.updatedAt) }
    : rel && !state.changed
      ? { issue: String(rel.issue), rev: String(rel.revision), date: fmtDots(String(rel.date).slice(0, 10)) }
      : state
        ? { issue: String(state.next.issue), rev: `${state.next.revision} (${T.draft})`, date: fmtDots(date) }
        : { issue: '—', rev: '—', date: fmtDots(date) };
  const lepAttrs = (l) => ` data-lep-issue="${esc(l.issue)}" data-lep-rev="${esc(l.rev)}" data-lep-date="${esc(l.date)}"`;

  // What the template’s header fields say about this document: the manual’s issue and revision,
  // the same stamp its front matter carries in the List of Effective Pages.
  const head = {
    title: manual.name,
    subtitle: manual.code || GROUP_LABELS[manual.group] || manual.group || '',
    version: frontLep.issue,
    revision: frontLep.rev,
    date: frontLep.date,
  };

  // The front matter (revision record, contents, List of Effective Pages) carries no chapter
  // number of its own — what a simulator manual says about itself is not a chapter of it, and
  // the company and safety text is written as a module. Module chapters are the chapters.
  const targets = xrefTargets(chapters);
  const processed = chapters.map((c, i) => {
    const num = single ? null : i + 1;
    const lep = c.missing ? frontLep : docEffectivity(c.doc);
    if (c.missing) return { ...c, num, lep, html: '', items: [], figures: [] };
    const body = markChecklists(resolveXrefs(fillManualVars(dropPlaceholderSections(c.content), manual), targets, T));
    // A doc printed on its own lists its effective pages right after its revision record.
    const generated = single
      ? String(c.generated || '').replace(
          /(<section class="auto-section" data-auto="1">[\s\S]*?<\/section>)/,
          `$1\n<section class="auto-section lep-section"><h2>${esc(T.lep)}</h2>\n<table class="lep-pages">\n<thead><tr>${[1, 2, 3]
            .map(() => `<th>${T.page}</th><th>${T.issue}</th><th>${T.rev}</th><th>${T.effectiveDate}</th>`)
            .join('')}</tr></thead>\n<tbody></tbody>\n</table>\n</section>`
        )
      : c.generated;
    const { html, items } = numberHeadings(`${generated}\n${body}`, num);
    return { ...c, num, lep, items, ...numberFigures(html, num, T) };
  });
  const allFigures = processed.flatMap((c) => c.figures);

  const recordRows = processed
    .map((c) =>
      c.missing
        ? `<tr><td>${c.num}</td><td class="missing">${esc(c.module?.name || c.slug)}</td><td colspan="4" class="missing">${T.noDocumentation}</td></tr>`
        : `<tr><td>${c.num}</td><td><a href="#ch-${esc(c.slug)}">${esc(c.title || c.module.name)}</a></td><td class="doc-code">${esc(manualDocCode(c.module, c.doc.manual) || c.module.code || '—')}</td><td>${esc(c.doc.version)}${c.isDraft ? ` ${T.draft} r${c.doc.revision}` : ''}</td><td>${esc(
            c.doc.status
          )}</td><td>${fmtDate(c.doc.releasedAt || c.doc.updatedAt)}</td></tr>`
    )
    .join('\n');

  const generalItems = [
    ['toc', T.tableOfContents],
    ...(allFigures.length ? [['lof', T.listOfFigures]] : []),
    ['revision-record', T.revisionRecord],
    ['lep', T.lep],
  ];
  // Every figure of the manual, by the number the build gave it; the page is written in once the
  // manual is paginated (export / PDF).
  const lof = allFigures.length
    ? `<h2 id="lof">${esc(T.listOfFigures)}</h2>
<table class="lof">
<thead><tr><th>${esc(T.fig)}</th><th>${esc(T.caption)}</th><th class="paged-only">${esc(T.page)}</th></tr></thead>
<tbody>${allFigures
        .map(
          (f) =>
            `<tr><td>${f.num}</td><td><a href="#${f.id}">${esc(f.title || '—')}</a></td><td class="paged-only"><a class="pg-ref" href="#${f.id}">—</a></td></tr>`
        )
        .join('\n')}</tbody>
</table>
`
    : '';
  const frontToc = generalItems
    .map(([id, title]) => `<li class="front"><a href="#${id}">${esc(title)}</a></li>`)
    .join('');
  const toc = [frontToc]
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

  const lepChapterRows = [`<tr><td>—</td><td>${esc(T.frontMatter)}</td><td>—</td><td>—</td><td>${esc(frontLep.date)}</td></tr>`]
    .concat(
      processed.map(
        (c) =>
          `<tr><td>${c.num}</td><td>${esc(c.title || c.module?.name || c.slug)}</td><td>${esc(c.lep.issue)}</td><td>${esc(c.lep.rev)}</td><td>${esc(c.lep.date)}</td></tr>`
      )
    )
    .join('\n');

  // The manual's own releases head its revision record; the chapters follow, as before.
  const manualRevisions = (state?.releases || []).length
    ? `<h3>${esc(T.manualRevisions)}</h3>
<table class="manual-revisions">
<thead><tr><th>${T.issue}</th><th>${T.rev}</th><th>${T.date}</th><th>${T.change}</th></tr></thead>
<tbody>${state.releases
        .map((r) => `<tr><td>${esc(r.issue)}</td><td>${esc(r.revision)}</td><td>${fmtDots(String(r.date).slice(0, 10))}</td><td>${esc(r.note || '—')}</td></tr>`)
        .join('\n')}</tbody>
</table>
<h3>${esc(T.chapterRevisions)}</h3>
`
    : '';

  // The order of a manual's opening pages: the contents right after the title page (with the list
  // of figures), then the revision record, and the List of Effective Pages right after it.
  const front = `<section class="front" id="ch-general"${lepAttrs(frontLep)}>
<h2 id="toc">${T.tableOfContents}</h2>
<div class="toc"><ol>${toc}</ol></div>
${lof}<h2 id="revision-record">${T.revisionRecord}</h2>
${manualRevisions}<table class="chapter-record">
  <thead><tr><th>${T.chapter}</th><th>${T.module}</th><th>${T.docCode}</th><th>${T.docVersion}</th><th>${T.status}</th><th>${T.date}</th></tr></thead>
  <tbody>${recordRows}</tbody>
</table>
<h2 id="lep">${esc(T.lep)}</h2>
<p class="lep-note">${T.lepNote}</p>
<table class="lep-chapters">
<thead><tr><th>${T.chapter}</th><th>${T.module}</th><th>${T.issue}</th><th>${T.rev}</th><th>${T.effectiveDate}</th></tr></thead>
<tbody>
${lepChapterRows}
</tbody>
</table>
<table class="lep-pages">
<thead><tr>${[1, 2, 3].map(() => `<th>${T.page}</th><th>${T.issue}</th><th>${T.rev}</th><th>${T.effectiveDate}</th>`).join('')}</tr></thead>
<tbody></tbody>
</table>
</section>`;

  const body = processed
    .map((c) => {
      if (c.missing) {
        return `<section class="chapter" id="ch-${esc(c.slug)}" data-ch="${c.num}"${lepAttrs(c.lep)}><h1>${esc(c.module?.name || c.slug)}</h1><p class="missing">${T.noDocumentationYet}</p></section>`;
      }
      const flags = [
        c.isDraft ? `<span class="draft-flag">${esc(T.draftFlag(c.doc.version, c.doc.revision))}</span>` : '',
        c.langFallback ? `<span class="draft-flag lang-flag">${esc(T.langFallback)}</span>` : '',
      ].join('');
      return `<section class="chapter" id="ch-${esc(c.slug)}" data-ch="${c.num}"${lepAttrs(c.lep)}>
<h1>${esc(c.title || c.module.name)}${kindBadge(c, T)}${flags}</h1>
${c.html}
</section>`;
    })
    .join('\n');

  const cover = coverUrl
    ? `<div class="cover-image"><img src="${esc(coverUrl)}" alt="${esc(manual.name)}"></div>`
    : `<div class="cover-placeholder">Cover illustration — set one via Edit manual</div>`;
  // The cover says what the document is and whose device it is: the title large, the device, its
  // serial number and operator, the issue in effect and its date, and who issued it.
  // The device is named under the title; the table carries what identifies this one.
  const facts = [
    [T.serialNumber, manual.serialNumber],
    [T.operatorName, manual.operator],
    [T.issueRev, `${T.issue} ${frontLep.issue} · ${T.rev} ${frontLep.rev}`],
    [T.date, frontLep.date],
  ].filter(([, v]) => v && String(v).trim());
  const coverTitle = `<div class="cover-title">
    ${manual.code ? `<div class="cover-code">${esc(manual.code)}</div>` : ''}
    <div class="cover-name">${esc(manual.name)}</div>
    ${manual.device ? `<div class="cover-device">${esc(manual.device)}</div>` : ''}
  </div>`;
  const coverFacts = `<table class="cover-facts"><tbody>${facts
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join('')}</tbody></table>`;
  const coverCompany = `<div class="cover-company"><span class="cover-logo">${logoHtml}</span><span>${esc(T.issuedBy)}<br><strong>FTD.aero Sp. z o.o.</strong></span></div>`;

  if (single) {
    // The doc as its own mini-manual: a title page, its table of contents, then the doc itself —
    // 1.1 Revision record followed by its List of Effective Pages, and every section of the body on a
    // page of its own. The chapter title carries no badge or draft flag: the header says both.
    const c = processed[0];
    const tocItems = c.items
      .map(
        (it) =>
          `<li class="${it.level === 3 ? 'l3' : 'l2'}"><a href="#${it.id}"><span class="num">1.${it.num}</span>${esc(it.title)}</a></li>`
      )
      .join('');
    const docFacts = [
      [T.docVersion, c.doc.version],
      [T.revision, frontLep.rev],
      [T.date, frontLep.date],
    ];
    return `<div class="manual-doc single" lang="${esc(lang)}">
<div class="print-header">${headerBox(manual, logoHtml, T, head)}</div>
<div class="print-footer">${esc(footerText)}</div>
<div class="manual">
<section class="cover" id="cover"${lepAttrs(frontLep)}>
  ${headerBox(manual, logoHtml, T, head)}
  <div class="cover-title">
    ${manual.code ? `<div class="cover-code">${esc(manual.code)}</div>` : ''}
    <div class="cover-name">${esc(c.title || c.module.name)}</div>
    <div class="cover-device">${esc(T.manualTypes[manualTypeOf(c.doc.manual).id])}</div>
  </div>
  <table class="cover-facts"><tbody>${docFacts.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>
  ${coverCompany}
</section>
<section class="front" id="ch-general"${lepAttrs(frontLep)}>
<h2 id="toc">${T.tableOfContents}</h2>
<div class="toc"><ol><li><a href="#ch-${esc(c.slug)}"><span class="num">1</span>${esc(c.title || c.module.name)}</a><ol>${tocItems}</ol></li></ol></div>
</section>
<section class="chapter" id="ch-${esc(c.slug)}"${lepAttrs(frontLep)}>
<h1>${esc(c.title || c.module.name)}</h1>
${c.html}
</section>
<section class="notes-page"${lepAttrs(frontLep)}><div class="notes-title">${esc(T.notes)}</div><div class="note-lines">${'<div class="note-line"></div>'.repeat(27)}</div></section>
<footer class="doc-footer">${esc(footerText)}</footer>
</div>
</div>`;
  }

  return `<div class="manual-doc" lang="${esc(lang)}">
<div class="print-header">${headerBox(manual, logoHtml, T, head)}</div>
<div class="print-footer">${esc(footerText)}</div>
<div class="manual">
<section class="cover" id="cover"${lepAttrs(frontLep)}>
  ${headerBox(manual, logoHtml, T, head)}
  ${coverTitle}
  ${cover}
  ${coverFacts}
  ${coverCompany}
</section>
${front}
${body}
<section class="notes-page"${lepAttrs(frontLep)}><div class="notes-title">${esc(T.notes)}</div><div class="note-lines">${'<div class="note-line"></div>'.repeat(27)}</div></section>
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
/* The page of the company template (Dok firmowy wzór.docx): margins 10 mm top, 10 mm right, 15 mm   */
/* bottom, 15 mm left, the header 5 mm from the top edge. The top margin here is the header’s 5 mm, */
/* its ~12 mm box and a gap before the text — Word grows the top margin around the header the same. */
@page {
  size: A4;
  margin: 24mm 10mm 15mm 15mm;
  @top-center { content: element(pageHeader); width: 100%; vertical-align: top; }
  @bottom-center { content: element(pageFooter); width: 100%; vertical-align: top; }
  /* The page number is printed once, in the header's page field — never again in the footer. */
}
body { font-family: ${FONT}; }
.pagedjs_pages, .pagedjs_margin-content { font-family: ${FONT}; }
.manual-doc .print-header { position: running(pageHeader); display: block; }
.manual-doc .print-footer { position: running(pageFooter); display: block; }
.pagedjs_margin-content .print-footer { font-size: 8.5px; color: #64748b; text-align: center; border-top: 1px solid #c8d1db; padding-top: 4px; line-height: 1.4; }
.pagedjs_margin-content .head-box { width: 190mm; table-layout: fixed; border-collapse: collapse; margin: 5mm 0 0 -5mm; color: #000; }
.pagedjs_margin-top-center, .pagedjs_margin-top-center > .pagedjs_margin-content { overflow: visible; }
.pagedjs_margin-content .head-box td { border: 0.5pt solid #000; padding: 0.4mm 1.2mm; vertical-align: middle; }
.pagedjs_margin-content .head-box .c-logo { width: 26.6mm; }
.pagedjs_margin-content .head-box .c-lbl { width: 19mm; }
.pagedjs_margin-content .head-box .c-val { width: 19mm; }
.pagedjs_margin-content .head-box .c-date { width: 67.5mm; }
.pagedjs_margin-content .hb-logo { text-align: center; overflow: hidden; }
.pagedjs_margin-content .hb-logo img, .pagedjs_margin-content .hb-logo svg { width: 21mm; max-width: 100%; height: auto; max-height: 11mm; object-fit: contain; display: inline-block; vertical-align: middle; }
.pagedjs_margin-content .hb-title, .pagedjs_margin-content .hb-sub { font-size: 6pt; font-weight: 700; text-align: justify; line-height: 1.3; }
.pagedjs_margin-content .hb-page { font-family: Arial, 'Liberation Sans', Helvetica, 'DejaVu Sans', sans-serif; font-size: 10pt; text-align: center; }
.pagedjs_margin-content .hb-lbl, .pagedjs_margin-content .hb-val { font-size: 6pt; text-align: center; line-height: 1.3; }
/* the PAGE field of the template: printed pages know their number, the web view does not */
.pagedjs_margin-content .hb-page .pg::after { content: counter(page) "/" counter(pages); }
.pagedjs_margin-content .hb-page .pg.filled::after, .pagedjs_margin-content.filled::after { content: none; }
.manual-doc .manual { max-width: none; padding: 0; margin: 0; }
.manual-doc .cover { break-after: page; padding-top: 12mm; }
.manual-doc .cover-placeholder { display: none; }
.manual-doc .cover-image img { max-height: 105mm; }
.manual-doc .cover .head-box { display: none; }
.manual-doc .chapter { break-before: page; border-top: none; margin-top: 0; padding-top: 0; }
/* The contents open the page after the title page; the revision record and the List of Effective */
/* Pages each start a page of their own.                                                            */
.manual-doc .front > h2#revision-record, .manual-doc .front > h2#lep { break-before: page; }
/* A doc printed on its own: every section of its body (Overview, Operation, …) opens a new page. */
.manual-doc.single .chapter > h2 { break-before: page; }
/* The last page is left for the reader's own notes: a title and ruled lines down to the footer. */
.manual-doc .notes-page { display: block; break-before: page; }
.manual-doc .notes-title { font-size: 16px; font-weight: 700; color: #16324f; border-bottom: 2px solid #16324f; padding-bottom: 4px; margin-bottom: 6mm; }
.manual-doc .note-line { height: 8mm; border-bottom: 0.4pt solid #9aa6b2; }
.manual-doc .doc-footer { display: none; }
.manual-doc .lep-chapters, .manual-doc .lep-note { display: none; }
.manual-doc .lep-pages { display: table; }
/* Thumb index tabs on the outer edge (LEP_SCRIPT places them): right on a recto, left on a verso. */
.pagedjs_page { position: relative; }
.thumb-tab { position: absolute; width: 7mm; display: flex; align-items: center; justify-content: center; color: #fff; font: 700 9pt ${FONT}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pagedjs_right_page .thumb-tab { right: 0; border-radius: 2mm 0 0 2mm; }
.pagedjs_left_page .thumb-tab { left: 0; border-radius: 0 2mm 2mm 0; }
.thumb-tab.tab-c0 { background: #1e3a5f; } .thumb-tab.tab-c1 { background: #2f6f4f; } .thumb-tab.tab-c2 { background: #8a4b12; }
.thumb-tab.tab-c3 { background: #5b3a7a; } .thumb-tab.tab-c4 { background: #8b1e2d; } .thumb-tab.tab-c5 { background: #1f6b7a; }
.manual-doc span.paged-only { display: inline; }
.manual-doc td.paged-only, .manual-doc th.paged-only { display: table-cell; }
.manual-doc .xref-missing { background: none; border: 0; }
.manual-doc a.pg-ref { color: inherit; text-decoration: none; }
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
  // A table that runs onto the next page repeats its header row there. paged.js marks the part
  // that continues with data-split-from; the header is put in as the part is laid out, so the
  // page is measured with it.
  function repeatHeader(table) {
    if (!table || table.tagName !== 'TABLE' || !table.hasAttribute('data-split-from') || table.querySelector(':scope > thead')) return;
    var first = document.querySelector('table[data-ref="' + table.getAttribute('data-split-from') + '"]:not([data-split-from]) > thead');
    if (first) table.insertBefore(first.cloneNode(true), table.firstChild);
  }
  class RepeatTableHeaders extends PagedModule.Handler {
    renderNode(node) {
      if (node && node.nodeType === 1) repeatHeader(node.tagName === 'TABLE' ? node : node.closest && node.closest('table'));
    }
    afterPageLayout(page) {
      var parts = page.querySelectorAll('table[data-split-from]');
      for (var i = 0; i < parts.length; i++) repeatHeader(parts[i]);
    }
  }
  PagedModule.registerHandlers(RepeatTableHeaders);
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
    // three columns of pages, read down each column: a hundred pages fit on one page
    var third = Math.ceil(total / 3), out = '', blank = '<td></td><td></td><td></td><td></td>';
    for (var i = 1; i <= third; i++) {
      out += '<tr>' + [i, i + third, i + 2 * third].map(function (n) { return n <= total ? entry(n, info) : blank; }).join('') + '</tr>';
    }
    return out;
  }
  function withLep(total, info, refs) {
    return html
      .replace(/(<table class="lep-pages">[\\s\\S]*?<tbody>)[\\s\\S]*?(<\\/tbody>)/, function (m, a, b) { return a + rows(total, info) + b; })
      .replace(/(<a class="pg-ref" href="#([^"]+)">)[^<]*(<\\/a>)/g, function (m, a, id, b) { return a + (refs[id] || '—') + b; });
  }
  // The page each cross-reference and List of figures entry points at, read off the pages that came out.
  function pagesOfRefs() {
    var refs = {}, links = mount.querySelectorAll('a.pg-ref'), pages = mount.querySelectorAll('.pagedjs_page');
    for (var i = 0; i < links.length; i++) {
      var id = links[i].getAttribute('href').slice(1);
      if (refs[id]) continue;
      var target = mount.querySelector('[id="' + id + '"]');
      var page = target && target.closest('.pagedjs_page');
      if (page) refs[id] = String(Array.prototype.indexOf.call(pages, page) + 1);
    }
    return refs;
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
    var total = 0, info = {}, refs = {}, previewer = null, flow = null;
    for (var pass = 0; pass < 5; pass++) {
      if (previewer) previewer.polisher.destroy();
      mount.innerHTML = '';
      previewer = new PagedModule.Previewer();
      flow = await previewer.preview(withLep(total, info, refs), [{ 'manual.css': css }], mount);
      info = effectivity();
      var found = pagesOfRefs();
      var settled = flow.total === total && JSON.stringify(found) === JSON.stringify(refs);
      total = flow.total;
      refs = found;
      if (settled) break;
    }
    var cells = mount.querySelectorAll('.lep-pages td[data-f]');
    for (var k = 0; k < cells.length; k++) {
      var f = cells[k].getAttribute('data-f');
      var v = info[cells[k].getAttribute('data-p')];
      if (f !== 'page') cells[k].textContent = v ? v[f] : '';
    }
    // counter(pages) stays 0 in a print, so the number of pages is written in: the PAGE field of
    // the header box, on every page that came out (the footer carries no page number).
    var out = mount.querySelectorAll('.pagedjs_page');
    // Thumb index: every page of a chapter carries a tab on its outer edge with the chapter number,
    // one step lower per chapter, so a closed binder opens at the chapter wanted.
    var chapters = 0;
    var marked = mount.querySelectorAll('[data-ch]');
    for (var c = 0; c < marked.length; c++) chapters = Math.max(chapters, +marked[c].getAttribute('data-ch'));
    var step = chapters ? Math.min(22, 235 / chapters) : 0;
    for (var p = 0; p < out.length; p++) {
      var pg = out[p].querySelector('.hb-page .pg');
      if (pg) { pg.textContent = (p + 1) + '/' + flow.total; pg.className += ' filled'; }
      var ch = out[p].querySelector('.pagedjs_page_content [data-ch]');
      if (ch) {
        var n = +ch.getAttribute('data-ch');
        var tab = document.createElement('div');
        tab.className = 'thumb-tab tab-c' + ((n - 1) % 6);
        tab.style.top = (32 + (n - 1) * step) + 'mm';
        tab.style.height = (step - 1.5) + 'mm';
        tab.textContent = String(n);
        out[p].appendChild(tab);
      }
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

/** Does this body still carry the AI's pending-edit wrappers? */
/**
 * Characters a manual body must not keep. Text copied out of a PDF arrives with its typographic
 * quotes and dashes truncated to control codes (U+201C becomes U+001C), which the reader sees as
 * a box; the rest of the C0 range is damage nobody can see at all. Everything else is left alone.
 */
const CONTROL_FIXES = { '\u0013': '\u2013', '\u0014': '\u2014', '\u0018': '\u2018', '\u0019': '\u2019', '\u001a': '\u201a', '\u001b': '\u201b', '\u001c': '\u201c', '\u001d': '\u201d', '\u001e': '\u201e' };
export const cleanBodyHtml = (html) =>
  String(html ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, (c) => CONTROL_FIXES[c] || '');

/** A marker the author left for themselves: TODO(author): … */
export const TODO_MARKER_RE = /\bTODO(?:\([^)]*\))?\s*:/i;

export const hasPendingEdits = (html) => /class="[^"]*ai-edit-pending/.test(html || '');

/**
 * Accept every pending AI edit in a body: the `<div class="ai-edit-pending">` wrappers go, what
 * they wrap stays. Releasing a document accepts what is in it, so a released manual never shows
 * a reader an edit still waiting to be reviewed. Nested wrappers are counted, not guessed at.
 */
export function acceptPendingEdits(html) {
  let out = String(html || '');
  const open = /<div\b[^>]*class="[^"]*\bai-edit-pending\b[^"]*"[^>]*>/i;
  for (let guard = 0; guard < 1000; guard++) {
    const m = open.exec(out);
    if (!m) break;
    const start = m.index;
    const inner = start + m[0].length;
    // walk forward to this div's own closing tag
    let depth = 1;
    let i = inner;
    const tag = /<\/?div\b[^>]*>/gi;
    tag.lastIndex = inner;
    let t;
    while ((t = tag.exec(out))) {
      depth += t[0][1] === '/' ? -1 : 1;
      if (depth === 0) {
        i = t.index;
        break;
      }
    }
    if (depth !== 0) {
      // unbalanced: drop the opening tag alone rather than eat the rest of the document
      out = out.slice(0, start) + out.slice(inner);
      continue;
    }
    out = out.slice(0, start) + out.slice(inner, i) + out.slice(i + t[0].length);
  }
  return out;
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

/** Is software version v inside a doc's covered range? A range runs from `from` onwards and stays
 *  open ("→ latest") until a later doc version of the same manual type takes over — `to` is then
 *  stamped as the last release this version documents. */
export function versionCovered(v, cov) {
  if (!cov || !cov.from) return false;
  if (compareSwVersions(v, cov.from) < 0) return false;
  return !cov.to || compareSwVersions(v, cov.to) <= 0;
}
