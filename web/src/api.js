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
  nextDocVersion: (slug, bump) => request(`/api/modules/${slug}/docs`, { method: 'POST', body: { bump } }),
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
  aiSettings: () => request('/api/settings/ai'),
  saveAiSettings: (guidelines) => request('/api/settings/ai', { method: 'PUT', body: { guidelines } }),
  mcpInfo: () => request('/api/mcp-info'),
  uploadAssets: (slug, version, files) =>
    request(`/api/modules/${slug}/docs/${version}/assets`, { method: 'POST', body: { files } }),
  listAssets: (slug) => request(`/api/modules/${slug}/assets`),
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

export const STATUS_LABELS = {
  released: 'Released',
  'in-review': 'In review',
  draft: 'Draft',
  superseded: 'Superseded',
  missing: 'Missing doc',
};

export function timeAgo(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toISOString().slice(0, 10);
}
