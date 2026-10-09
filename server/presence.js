/**
 * Who has an item open right now — so two people do not edit the same doc without knowing it.
 *
 * Every open editor or manual page sends a heartbeat every 15 s (`POST /api/presence {item, mode,
 * tab}`) and gets back the others on the same item. An entry is forgotten 45 s after its last beat,
 * so a closed tab drops off by itself; leaving the page says so at once. Kept in memory only: a
 * restart forgets everyone, and they are back with their next beat.
 *
 * `item` names what is open: `doc:<owner>:<key>` (a doc version in the editor or the review view)
 * or `manual:<slug>`. `tab` is one browser tab, so the same person in two tabs is two entries;
 * `mode` is edit, review or view.
 */
const TTL_MS = 45_000;
const MODES = ['view', 'review', 'edit'];
const items = new Map(); // item -> Map(tab -> { user, mode, since, seen })

const ITEM_RE = /^(doc|manual):[^\s]{1,200}$/;
const TAB_RE = /^[A-Za-z0-9-]{8,64}$/;

function sweep(now = Date.now()) {
  for (const [item, tabs] of items) {
    for (const [tab, e] of tabs) if (now - e.seen > TTL_MS) tabs.delete(tab);
    if (!tabs.size) items.delete(item);
  }
}

export function validPresence(item, tab) {
  return ITEM_RE.test(String(item || '')) && TAB_RE.test(String(tab || ''));
}

/** Record a heartbeat and return who else has the item open (every tab but this one). */
export function beat(item, tab, user, mode = 'view') {
  const now = Date.now();
  sweep(now);
  const tabs = items.get(item) || new Map();
  items.set(item, tabs);
  const prev = tabs.get(tab);
  tabs.set(tab, {
    user: { id: user.id, name: user.name || user.email, email: user.email },
    mode: MODES.includes(mode) ? mode : 'view',
    since: prev?.since || now,
    seen: now,
  });
  return others(item, tab, user.id);
}

/** This tab closed the item. */
export function leave(item, tab) {
  items.get(item)?.delete(tab);
  sweep();
}

/**
 * The others on an item, one row per person and mode — the same person in another tab shows too
 * (`self: true`), since two tabs of one author can overwrite each other just the same.
 */
export function others(item, tab, selfId) {
  const rows = new Map();
  for (const [t, e] of items.get(item) || []) {
    if (t === tab) continue;
    const key = `${e.user.id}:${e.mode}`;
    const row = rows.get(key);
    if (!row || e.since < row.since) rows.set(key, { ...e.user, mode: e.mode, since: new Date(e.since).toISOString(), self: e.user.id === selfId });
  }
  return [...rows.values()].sort((a, b) => MODES.indexOf(b.mode) - MODES.indexOf(a.mode) || a.since.localeCompare(b.since));
}
