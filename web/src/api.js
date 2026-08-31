async function request(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export const api = {
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
  doc: (slug, version) => request(`/api/modules/${slug}/docs/${version}`),
  saveContent: (slug, version, html, bump = false, summary = '') =>
    request(`/api/modules/${slug}/docs/${version}/content`, {
      method: 'PUT',
      body: { html, bump, summary },
    }),
  submitReview: (slug, version) => request(`/api/modules/${slug}/docs/${version}/submit-review`, { method: 'POST' }),
  backToDraft: (slug, version) => request(`/api/modules/${slug}/docs/${version}/back-to-draft`, { method: 'POST' }),
  release: (slug, version) => request(`/api/modules/${slug}/docs/${version}/release`, { method: 'POST' }),
  discard: (slug, version) => request(`/api/modules/${slug}/docs/${version}/discard`, { method: 'POST' }),
  softwares: () => request('/api/softwares'),
  registerRelease: (body) => request('/api/softwares', { method: 'POST', body }),
  coverRelease: (slug, version, name, swVersion) =>
    request(`/api/modules/${slug}/docs/${version}/cover`, { method: 'POST', body: { name, version: swVersion } }),
  aiChat: (body) => request('/api/ai/chat', { method: 'POST', body }),
  manuals: () => request('/api/manuals'),
  manual: (slug) => request(`/api/manuals/${slug}`),
  createManual: (body) => request('/api/manuals', { method: 'POST', body }),
  updateManual: (slug, body) => request(`/api/manuals/${slug}`, { method: 'PUT', body }),
  deleteManual: (slug) => request(`/api/manuals/${slug}`, { method: 'DELETE' }),
  uploadManualCover: (slug, file) => request(`/api/manuals/${slug}/cover`, { method: 'POST', body: file }),
  uploadLogo: (file) => request('/api/settings/logo', { method: 'POST', body: file }),
  aiSettings: () => request('/api/settings/ai'),
  saveAiSettings: (guidelines) => request('/api/settings/ai', { method: 'PUT', body: { guidelines } }),
  mcpInfo: () => request('/api/mcp-info'),
  uploadAssets: (slug, version, files) =>
    request(`/api/modules/${slug}/docs/${version}/assets`, { method: 'POST', body: { files } }),
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
  checklist: (slug, version) => request(`/api/modules/${slug}/docs/${version}/checklist`),
  saveChecklist: (slug, version, checklist, summary = '') =>
    request(`/api/modules/${slug}/docs/${version}/checklist`, { method: 'PUT', body: { checklist, summary } }),
};

export const CATEGORIES = [
  ['software', 'Software'],
  ['cockpit-hardware', 'Cockpit hardware'],
  ['structure', 'Structure'],
  ['peripherals', 'Peripherals'],
  ['rack', 'Rack'],
];

export const GROUPS = [
  ['SIM', 'Simulator'],
  ['IOS', 'IOS'],
  ['RACK', 'RACK cabinets'],
];

/** Manual types — one doc stream per audience (mirrors server/docgen.js MANUAL_TYPES). */
export const MANUAL_TYPES = [
  { id: 'customer', label: 'Customer manual', short: 'Customer', kind: 'hardware', audience: 'customer', sections: ['Description', 'Operation', 'Maintenance', 'Appendixes'], desc: 'For the operator of the simulator: what the module is, how it is used day to day, what to check and when to call service.' },
  { id: 'technician', label: 'Technician manual', short: 'Technician', kind: 'hardware', audience: 'technician', sections: ['Installation', 'Configuration', 'Maintenance', 'Appendixes'], desc: 'For the installer / service technician: components and wiring, network and device configuration, servicing and troubleshooting.' },
  { id: 'software-customer', label: 'Software customer manual', short: 'SW · Customer', kind: 'software', audience: 'customer', sections: ['Overview', 'Operation', 'Troubleshooting', 'Appendixes'], desc: 'For the operator: everyday use of the linked software — the tasks they perform, screen by screen.' },
  { id: 'software-technician', label: 'Software technician manual', short: 'SW · Technician', kind: 'software', audience: 'technician', sections: ['Installation', 'Configuration', 'Administration', 'Appendixes'], desc: 'For the technician: installing, configuring, updating and administering the linked software.' },
];
export const manualType = (id) => MANUAL_TYPES.find((t) => t.id === id) || { id, label: id, short: id, kind: 'hardware', sections: [] };

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
  if (s < 60) return `${Math.max(1, Math.round(s))} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
