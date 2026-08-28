/**
 * lineDiff — a small line-level diff, used to show an assistant proposal before it is accepted.
 *
 * The admin panel never applies a drafted edit silently: the author sees exactly which lines
 * would change and decides. That makes the diff part of the safety story, so it is deliberately
 * dumb and exact — a longest-common-subsequence over whole lines, with no heuristics, no word
 * splitting and no similarity scoring. A line is either identical or it is shown as removed and
 * added. Nothing is ever hidden except runs of unchanged lines, and those are replaced by a
 * visible "N unchanged lines" marker.
 *
 * Plain ESM, no dependencies.
 */

const splitLines = s => String(s ?? "").split("\n");

/** Rows are { type: "ctx" | "del" | "add", text, aNo, bNo } — 1-based line numbers, or null. */
export function diffLines(before, after) {
  const a = splitLines(before);
  const b = splitLines(after);

  // Identical head and tail are matched directly: it keeps the LCS matrix small on the usual
  // case (a couple of edited lines in a long chunk) and costs nothing on the unusual one.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const rows = [];
  for (let i = 0; i < head; i++) rows.push({ type: "ctx", text: a[i], aNo: i + 1, bNo: i + 1 });
  for (const r of diffMiddle(midA, midB, head)) rows.push(r);
  for (let i = 0; i < tail; i++) {
    const ai = a.length - tail + i;
    const bi = b.length - tail + i;
    rows.push({ type: "ctx", text: a[ai], aNo: ai + 1, bNo: bi + 1 });
  }
  return rows;
}

/** Above this many cells the LCS matrix stops being worth it; the middle is shown wholesale. */
const MAX_CELLS = 4_000_000;

function diffMiddle(a, b, offset) {
  const rows = [];
  if (a.length === 0 && b.length === 0) return rows;
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_CELLS) {
    a.forEach((t, i) => rows.push({ type: "del", text: t, aNo: offset + i + 1, bNo: null }));
    b.forEach((t, i) => rows.push({ type: "add", text: t, aNo: null, bNo: offset + i + 1 }));
    return rows;
  }

  // lcs[i][j] = length of the longest common subsequence of a[i..] and b[j..].
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ type: "ctx", text: a[i], aNo: offset + i + 1, bNo: offset + j + 1 });
      i++; j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      rows.push({ type: "del", text: a[i], aNo: offset + i + 1, bNo: null });
      i++;
    } else {
      rows.push({ type: "add", text: b[j], aNo: null, bNo: offset + j + 1 });
      j++;
    }
  }
  while (i < a.length) { rows.push({ type: "del", text: a[i], aNo: offset + i + 1, bNo: null }); i++; }
  while (j < b.length) { rows.push({ type: "add", text: b[j], aNo: null, bNo: offset + j + 1 }); j++; }
  return rows;
}

/** { added, removed } — the counts shown on the proposal card. */
export function diffStat(rows) {
  let added = 0;
  let removed = 0;
  for (const r of rows) {
    if (r.type === "add") added++;
    else if (r.type === "del") removed++;
  }
  return { added, removed };
}

/**
 * Replace long runs of unchanged lines with { type: "gap", count }, keeping `context` unchanged
 * lines on each side of every change. A run is only collapsed when that actually saves lines.
 */
export function collapse(rows, context = 3) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === "ctx") return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });

  const out = [];
  let run = 0;
  for (let i = 0; i < rows.length; i++) {
    if (keep[i]) {
      if (run > 0) { out.push({ type: "gap", count: run }); run = 0; }
      out.push(rows[i]);
    } else {
      run++;
    }
  }
  if (run > 0) out.push({ type: "gap", count: run });
  return out;
}
