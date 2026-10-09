/**
 * What changed between two versions of a chapter, for a reader comparing manuals. The body HTML is
 * read as the blocks a reader sees — headings, paragraphs, list items, table rows, pictures — and
 * the two lists are compared block by block (longest common subsequence); a block that was edited
 * rather than added or removed is shown word by word. No dependency: chapters are a few hundred
 * blocks, well within a plain LCS.
 */

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m]);

/** The blocks of a body as plain text lines: { kind: 'h'|'p'|'pic', text }. */
export function textBlocks(html) {
  const s = String(html || '')
    // a picture is its file name and caption, so a swapped picture shows as a change
    .replace(/<img\b[^>]*\bsrc="([^"]*)"[^>]*>/gi, (_, src) => `\n\u0001${decodeURIComponent(src.split('/').pop().split('?')[0])}\n`)
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\u0002')
    .replace(/<\/(h[1-6]|p|li|tr|figcaption|div|table|ul|ol|figure)>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return decode(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').replace(/^\s*\|\s*/, '').trim())
    .filter((l) => l && l !== '\u0002' && l !== '|')
    .map((l) =>
      l.startsWith('\u0001') ? { kind: 'pic', text: `🖼 ${l.slice(1)}` } : l.startsWith('\u0002') ? { kind: 'h', text: l.slice(1).trim() } : { kind: 'p', text: l }
    );
}

/** Longest common subsequence of two lists by `same(a, b)`: the edit script as [op, a, b]. */
function lcs(a, b, same) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = same(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(a[i], b[j])) out.push(['=', a[i++], b[j++]]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(['-', a[i++], null]);
    else out.push(['+', null, b[j++]]);
  }
  while (i < n) out.push(['-', a[i++], null]);
  while (j < m) out.push(['+', null, b[j++]]);
  return out;
}

/** One edited block, word by word: removed words struck through, added words marked. */
function wordDiff(from, to) {
  const tokens = (s) => s.match(/\s+|[^\s]+/g) || [];
  // runs of the same kind are joined, so a changed phrase is one mark, not one per word
  const runs = [];
  for (const [op, x, y] of lcs(tokens(from), tokens(to), (p, q) => p === q)) {
    const text = op === '+' ? y : x;
    if (runs.length && runs[runs.length - 1].op === op) runs[runs.length - 1].text += text;
    else runs.push({ op, text });
  }
  return runs.map(({ op, text }) => (op === '=' ? esc(text) : op === '-' ? `<del>${esc(text)}</del>` : `<ins>${esc(text)}</ins>`)).join('');
}

const similar = (a, b) => {
  // two blocks are the same block edited when they still share most of their words
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = b.toLowerCase().split(/\s+/);
  const common = wb.filter((w) => wa.has(w)).length;
  return common / Math.max(wa.size, wb.length, 1) >= 0.4;
};

/**
 * Compare two chapter bodies. Returns { html, added, removed, changed } — `html` lists the changes
 * with a line of context around each and the unchanged stretches folded, under the heading each
 * change sits in; empty when nothing a reader sees changed.
 */
export function diffBodies(fromHtml, toHtml, { context = 1, unchanged = (n) => `${n} unchanged` } = {}) {
  const a = textBlocks(fromHtml);
  const b = textBlocks(toHtml);
  const script = lcs(a, b, (x, y) => x.kind === y.kind && x.text === y.text);
  // a removal followed by an addition of a similar block is one block edited
  const rows = [];
  for (let k = 0; k < script.length; k++) {
    const [op, x] = script[k];
    if (op === '-') {
      let j = k + 1;
      while (j < script.length && script[j][0] === '-') j++;
      const adds = [];
      while (j < script.length && script[j][0] === '+') adds.push(script[j++][2]);
      const dels = script.slice(k, k + (j - k - adds.length)).map((r) => r[1]);
      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
        const d = dels[p];
        const n = adds[p];
        if (p < pairs && d.kind === n.kind && similar(d.text, n.text)) rows.push({ op: '~', from: d, to: n });
        else {
          if (d) rows.push({ op: '-', from: d });
          if (n) rows.push({ op: '+', to: n });
        }
      }
      k = j - 1;
    } else if (op === '+') rows.push({ op: '+', to: script[k][2] });
    else rows.push({ op: '=', to: x });
  }
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const r of rows) {
    if (r.op === '+') counts.added++;
    else if (r.op === '-') counts.removed++;
    else if (r.op === '~') counts.changed++;
  }
  if (!counts.added && !counts.removed && !counts.changed) return { html: '', ...counts };

  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.op === '=') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const line = (cls, block, inner) =>
    `<div class="d-row ${cls}${block.kind === 'h' ? ' d-head' : ''}${block.kind === 'pic' ? ' d-pic' : ''}">${inner}</div>`;
  const out = [];
  let heading = null;
  let shownHeading = null;
  let folded = 0;
  rows.forEach((r, i) => {
    const block = r.to || r.from;
    if (block.kind === 'h' && r.op === '=') heading = block.text;
    if (!keep[i]) {
      if (r.op === '=') folded++;
      return;
    }
    if (folded) out.push(`<div class="d-fold">⋯ ${esc(unchanged(folded))}</div>`);
    folded = 0;
    // say which section a change sits in, once
    if (heading && heading !== shownHeading && !(block.kind === 'h' && r.op === '=')) {
      out.push(`<div class="d-row d-same d-head">${esc(heading)}</div>`);
    }
    shownHeading = heading;
    if (r.op === '=') out.push(line('d-same', block, esc(block.text)));
    else if (r.op === '+') out.push(line('d-add', block, esc(block.text)));
    else if (r.op === '-') out.push(line('d-del', block, esc(block.text)));
    else out.push(line('d-mod', block, wordDiff(r.from.text, r.to.text)));
  });
  if (folded) out.push(`<div class="d-fold">⋯ ${esc(unchanged(folded))}</div>`);
  return { html: out.join('\n'), ...counts };
}
