/**
 * Column widths by dragging, for the tables in the editor body.
 *
 * Grab the border between two columns and drag: the two columns trade width and the table keeps
 * its own. The widths are stored in the body as <colgroup><col style="width: 31.2%">…</colgroup>,
 * so the manual view, the export and the PDF lay the table out the way the author left it — as
 * percentages, so it holds at the editor's page width and on A4 alike. A table nobody has resized
 * has no <colgroup> and keeps laying itself out as before.
 */

const EDGE = 5; // px either side of a column border that grabs it
const MIN = 5; // % — no column is dragged narrower than this

/** Columns in the widest row, counting merged cells. */
function columnCount(table) {
  let n = 0;
  for (const row of table.rows) n = Math.max(n, [...row.cells].reduce((s, c) => s + (c.colSpan || 1), 0));
  return n;
}

/** The first column a cell covers, counting the merged cells before it in its row. */
function firstColumn(cell) {
  let i = 0;
  for (const c of cell.parentElement.cells) {
    if (c === cell) return i;
    i += c.colSpan || 1;
  }
  return i;
}

/**
 * The <col>s of a table, one per column. A table that has none yet gets them from the widths the
 * browser laid it out with, so the first drag starts from what the author sees.
 */
function colsOf(table) {
  const n = columnCount(table);
  let group = table.querySelector(':scope > colgroup');
  if (group && group.children.length === n) return [...group.children];
  const total = table.getBoundingClientRect().width || 1;
  const widths = new Array(n).fill(100 / n);
  const row = [...table.rows].find((r) => r.cells.length === n);
  if (row) [...row.cells].forEach((c, i) => (widths[i] = (c.getBoundingClientRect().width / total) * 100));
  group?.remove();
  group = document.createElement('colgroup');
  for (const w of widths) {
    const col = document.createElement('col');
    col.style.width = `${w.toFixed(1)}%`;
    group.appendChild(col);
  }
  table.insertBefore(group, table.firstChild);
  return [...group.children];
}

/** The column border under the pointer — between column `index` and the next — or null. */
function borderAt(e, root) {
  const cell = e.target.closest?.('td, th');
  if (!cell || !root.contains(cell)) return null;
  const table = cell.closest('table');
  if (!table || !root.contains(table)) return null;
  const rect = cell.getBoundingClientRect();
  const first = firstColumn(cell);
  let index = null;
  if (e.clientX >= rect.right - EDGE) index = first + (cell.colSpan || 1) - 1;
  else if (e.clientX <= rect.left + EDGE) index = first - 1;
  // the table's own outer edges are not borders between two columns
  if (index === null || index < 0 || index >= columnCount(table) - 1) return null;
  return { table, index };
}

/**
 * Make the tables inside `root` resizable. `enabled()` is asked on every gesture (the editor turns
 * editing off in review and while an AI edit waits); `onChange()` runs once a drag has changed a
 * width, so the body is saved like any other edit. Returns the function that detaches it.
 */
export function attachTableResize(root, { enabled, onChange }) {
  let drag = null;

  const hover = (e) => {
    if (drag) return;
    root.classList.toggle('col-resize-hover', !!(enabled() && borderAt(e, root)));
  };

  const move = (e) => {
    if (!drag) return;
    e.preventDefault();
    const dx = ((e.clientX - drag.x) / drag.width) * 100;
    const pair = drag.left + drag.right;
    const left = Math.min(Math.max(drag.left + dx, MIN), pair - MIN);
    drag.cols[drag.index].style.width = `${left.toFixed(1)}%`;
    drag.cols[drag.index + 1].style.width = `${(pair - left).toFixed(1)}%`;
    drag.moved = true;
  };

  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('col-resizing');
    const done = drag;
    drag = null;
    if (done?.moved || done?.created) onChange();
  };

  const down = (e) => {
    if (e.button !== 0 || !enabled()) return;
    const hit = borderAt(e, root);
    if (!hit) return;
    e.preventDefault(); // no caret and no text selection while a border is dragged
    const had = !!hit.table.querySelector(':scope > colgroup');
    const cols = colsOf(hit.table);
    drag = {
      ...hit,
      cols,
      created: !had,
      moved: false,
      x: e.clientX,
      width: hit.table.getBoundingClientRect().width || 1,
      left: parseFloat(cols[hit.index].style.width) || 0,
      right: parseFloat(cols[hit.index + 1].style.width) || 0,
    };
    document.body.classList.add('col-resizing');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const leave = () => root.classList.remove('col-resize-hover');

  root.addEventListener('mousemove', hover);
  root.addEventListener('mousedown', down);
  root.addEventListener('mouseleave', leave);
  return () => {
    root.removeEventListener('mousemove', hover);
    root.removeEventListener('mousedown', down);
    root.removeEventListener('mouseleave', leave);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('col-resizing');
    root.classList.remove('col-resize-hover');
  };
}
