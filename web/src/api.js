import { t } from './i18n.jsx';

/** Called when any API request answers 401 (session expired / signed out elsewhere) — App shows the login page. */
let unauthorizedHandler = null;
export const onUnauthorized = (fn) => {
  unauthorizedHandler = fn;
};

async function request(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && data.code === 'unauthenticated' && unauthorizedHandler) unauthorizedHandler();
    const err = new Error(data.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

export const api = {
  /* login & users */
  me: () => request('/api/auth/me'),
  login: (email, password) => request('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  changePassword: (current, next) => request('/api/auth/password', { method: 'POST', body: { current, next } }),
  tokens: () => request('/api/tokens'),
  createToken: (label) => request('/api/tokens', { method: 'POST', body: { label } }),
  revokeToken: (id) => request(`/api/tokens/${id}`, { method: 'DELETE' }),
  users: () => request('/api/users'),
  createUser: (body) => request('/api/users', { method: 'POST', body }),
  updateUser: (id, body) => request(`/api/users/${id}`, { method: 'PUT', body }),
  deleteUser: (id) => request(`/api/users/${id}`, { method: 'DELETE' }),

  status: () => request('/api/status'),
  modules: () => request('/api/modules'),
  createModule: (input) => request('/api/modules', { method: 'POST', body: input }),
  module: (slug) => request(`/api/modules/${slug}`),
  /** Module metadata patch: name, code, category, group, softwares, hardware ([{id}] and/or new items). */
  updateModule: (slug, patch) => request(`/api/modules/${slug}`, { method: 'PATCH', body: patch }),
  hardware: () => request('/api/hardware'),
  createHardware: (item) => request('/api/hardware', { method: 'POST', body: item }),
  updateHardware: (id, patch) => request(`/api/hardware/${id}`, { method: 'PUT', body: patch }),
  deleteHardware: (id) => request(`/api/hardware/${id}`, { method: 'DELETE' }),
  /** New draft of one manual type: {manual, bump} for a next version, {manual, start, checklist} for a manual the module lacks. */
  nextDocVersion: (slug, body) => request(`/api/modules/${slug}/docs`, { method: 'POST', body: typeof body === 'string' ? { bump: body } : body }),
  manualTypes: () => request('/api/manual-types'),
  /** lang: 'en' (source) or a translation code — content is '' when that translation does not exist yet. */
  doc: (slug, version, lang = 'en') => request(`/api/modules/${slug}/docs/${version}${lang && lang !== 'en' ? `?lang=${lang}` : ''}`),
  saveContent: (slug, version, html, bump = false, summary = '', lang = 'en') =>
    request(`/api/modules/${slug}/docs/${version}/content`, {
      method: 'PUT',
      body: { html, bump, summary, lang },
    }),
  /** AI translation of the English body into lang (or store `html` as the translation). Returns the doc in that language. */
  translate: (slug, version, lang, html) => request(`/api/modules/${slug}/docs/${version}/translate`, { method: 'POST', body: { lang, html } }),
  submitReview: (slug, version) => request(`/api/modules/${slug}/docs/${version}/submit-review`, { method: 'POST' }),
  backToDraft: (slug, version) => request(`/api/modules/${slug}/docs/${version}/back-to-draft`, { method: 'POST' }),
  release: (slug, version) => request(`/api/modules/${slug}/docs/${version}/release`, { method: 'POST' }),
  discard: (slug, version) => request(`/api/modules/${slug}/docs/${version}/discard`, { method: 'POST' }),
  softwares: () => request('/api/softwares'),
  /** Software page rows: {name, modules:[{slug, name, manuals, docs, uncovered}], releases:[{version, coveredBy}]} */
  software: () => request('/api/software'),
  createSoftware: (body) => request('/api/software', { method: 'POST', body }),
  /** The software's own manual: an own-software module named after it with blank SW customer + technician drafts. */
  createSoftwareManual: (name, body) => request(`/api/software/${encodeURIComponent(name)}/own-manual`, { method: 'POST', body }),
  /** Deletes the module: draft branches, folder on main, chapter in every manual. */
  deleteModule: (slug) => request(`/api/modules/${slug}`, { method: 'DELETE' }),
  /** Unlinks the software from every module and drops it (with its releases) from the feed. */
  deleteSoftware: (name) => request(`/api/software/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** Repair: a name modules link that was never created as a software → merged into a registered one. */
  mergeSoftware: (name, into) => request(`/api/software/${encodeURIComponent(name)}/merge`, { method: 'POST', body: { into } }),
  linkSoftware: (slug, body) => request(`/api/modules/${slug}/software`, { method: 'POST', body }),
  registerRelease: (body) => request('/api/softwares', { method: 'POST', body }),
  coverRelease: (slug, version, name, swVersion) =>
    request(`/api/modules/${slug}/docs/${version}/cover`, { method: 'POST', body: { name, version: swVersion } }),
  aiChat: (body) => request('/api/ai/chat', { method: 'POST', body }),
  manuals: () => request('/api/manuals'),
  manual: (slug, lang = 'en') => request(`/api/manuals/${slug}${lang && lang !== 'en' ? `?lang=${lang}` : ''}`),
  transcribe: (body) => request('/api/transcribe', { method: 'POST', body }),
  createManual: (body) => request('/api/manuals', { method: 'POST', body }),
  importManuals: (config, replace) => request('/api/manuals/import', { method: 'POST', body: { config, replace } }),
  updateManual: (slug, body) => request(`/api/manuals/${slug}`, { method: 'PUT', body }),
  deleteManual: (slug) => request(`/api/manuals/${slug}`, { method: 'DELETE' }),
  uploadManualCover: (slug, file) => request(`/api/manuals/${slug}/cover`, { method: 'POST', body: file }),
  uploadLogo: (file) => request('/api/settings/logo', { method: 'POST', body: file }),
  aiSettings: () => request('/api/settings/ai'),
  saveAiSettings: (guidelines) => request('/api/settings/ai', { method: 'PUT', body: { guidelines } }),
  mcpInfo: () => request('/api/mcp-info'),
  // opts.attachments: keep every file as it is (a download), instead of expanding documents into pictures
  uploadAssets: (slug, version, files, opts = {}) =>
    request(`/api/modules/${slug}/docs/${version}/assets`, { method: 'POST', body: { files, ...opts } }),
  listAssets: (slug) => request(`/api/modules/${slug}/assets`),
  deleteAsset: (slug, version, name) =>
    request(`/api/modules/${slug}/docs/${version}/assets/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** body: {appliesTo: [hardware ids]} and/or {verify: true} */
  setAssetMeta: (slug, version, name, body) =>
    request(`/api/modules/${slug}/docs/${version}/assets/${encodeURIComponent(name)}/meta`, { method: 'PUT', body }),
  inbox: () => request('/api/inbox'),
  uploadInbox: (files) => request('/api/inbox', { method: 'POST', body: { files } }),
  deleteInbox: (name) => request(`/api/inbox/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  importInbox: (slug, version, names, keep = false) =>
    request(`/api/modules/${slug}/docs/${version}/assets/import`, { method: 'POST', body: { names, keep } }),
  /** Photo → FTD house-style line-art. body: {name, dataBase64} or {assetName}, plus optional instructions. */
  illustrate: (slug, version, body) => request(`/api/modules/${slug}/docs/${version}/illustrate`, { method: 'POST', body }),
  illustrationStyle: () => request('/api/settings/illustration-style'),
  saveIllustrationStyle: (style) => request('/api/settings/illustration-style', { method: 'PUT', body: { style } }),
  uploadStyleExemplars: (files) => request('/api/settings/illustration-style/exemplars', { method: 'POST', body: { files } }),
  deleteStyleExemplar: (name) => request(`/api/settings/illustration-style/exemplars/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  /** Review comments of a doc version (threads on selected text, kept on the draft branch). */
  comments: (slug, version) => request(`/api/modules/${slug}/docs/${version}/comments`),
  addComment: (slug, version, body) => request(`/api/modules/${slug}/docs/${version}/comments`, { method: 'POST', body }),
  replyComment: (slug, version, id, body) => request(`/api/modules/${slug}/docs/${version}/comments/${id}/replies`, { method: 'POST', body }),
  setCommentStatus: (slug, version, id, body) => request(`/api/modules/${slug}/docs/${version}/comments/${id}`, { method: 'PUT', body }),
  deleteComment: (slug, version, id) => request(`/api/modules/${slug}/docs/${version}/comments/${id}`, { method: 'DELETE' }),
  checklist: (slug, version) => request(`/api/modules/${slug}/docs/${version}/checklist`),
  saveChecklist: (slug, version, checklist, summary = '') =>
    request(`/api/modules/${slug}/docs/${version}/checklist`, { method: 'PUT', body: { checklist, summary } }),
};

export const CATEGORIES = [
  ['cockpit-hardware', 'Cockpit hardware'],
  ['peripherals', 'Peripherals'],
  ['structure', 'Structure'],
  ['instructor-station', 'Instructor station'],
  ['software', 'Software'],
];

export const GROUPS = [
  ['SIM', 'Simulator'],
  ['IOS', 'IOS'],
];

/** What a module IS — decides which manuals are drafted on creation (mirrors MODULE_TYPES in server/docgen.js). */
export const MODULE_TYPES = [
  { id: 'own-module', label: 'Own module', desc: 'off-the-shelf parts + own versioned plates', manuals: ['customer', 'technician'], needsSoftware: false },
  { id: 'third-party-kit', label: '3rd-party kit', desc: 'a bought device or set, e.g. an intercom or a smoke detector', manuals: ['customer', 'technician'], needsSoftware: false },
  { id: 'own-software', label: 'Own software', desc: 'an FTD application without hardware', manuals: ['software-customer', 'software-technician'], needsSoftware: true },
  { id: 'module-software', label: 'Module + software', desc: 'e.g. the IOS starting panel', manuals: ['customer', 'technician', 'software-customer', 'software-technician'], needsSoftware: true },
];
export const moduleType = (id) => MODULE_TYPES.find((t) => t.id === id) || null;

/** Manual types — one doc stream per audience (mirrors server/docgen.js MANUAL_TYPES). */
export const MANUAL_TYPES = [
  { id: 'customer', label: 'Customer manual', short: 'Customer', kind: 'hardware', audience: 'customer', sections: ['Description', 'Operation', 'Maintenance', 'Appendixes'], desc: 'For the operator of the simulator: what the module is, how it is used day to day, what to check and when to call service.' },
  { id: 'technician', label: 'Technician manual', short: 'Technician', kind: 'hardware', audience: 'technician', sections: ['Installation', 'Configuration', 'Maintenance', 'Appendixes'], desc: 'For the installer / service technician: components and wiring, network and device configuration, servicing and troubleshooting.' },
  { id: 'software-customer', label: 'Software customer manual', short: 'SW · Customer', kind: 'software', audience: 'customer', sections: ['Overview', 'Operation', 'Troubleshooting', 'Appendixes'], desc: 'For the operator: everyday use of the linked software — the tasks they perform, screen by screen.' },
  { id: 'software-technician', label: 'Software technician manual', short: 'SW · Technician', kind: 'software', audience: 'technician', sections: ['Installation', 'Configuration', 'Administration', 'Appendixes'], desc: 'For the technician: installing, configuring, updating and administering the linked software.' },
];
export const manualType = (id) => MANUAL_TYPES.find((t) => t.id === id) || { id, label: id, short: id, kind: 'hardware', sections: [] };

/** Doc languages: English is the source of every doc, the others are optional translations (mirrors server/docgen.js LANGUAGES). */
export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN', source: true },
  { code: 'pl', label: 'Polski', short: 'PL', source: false },
];
export const language = (code) => LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];

export const STATUS_LABELS = {
  released: 'Released',
  'in-review': 'In review',
  draft: 'Draft',
  superseded: 'Superseded',
  missing: 'Missing doc',
};

/** Read a File into {name, type, size, dataBase64} for JSON upload endpoints. */
export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, type: file.type, size: file.size, dataBase64: String(r.result).split(',')[1] || '' });
    r.onerror = () => reject(new Error(`Could not read ${file.name}`));
    r.readAsDataURL(file);
  });
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return t('{n} s ago', { n: Math.max(1, Math.round(s)) });
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  return new Date(iso).toISOString().slice(0, 10);
}
