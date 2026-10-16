/**
 * View maths of the schematic viewport: the drawing is translated by (x, y) and scaled by z inside
 * a box of CSS pixels. Pure, so the wheel / drag / fit behaviour is testable without a browser.
 */
export const MIN_Z = 0.05;
export const MAX_Z = 8;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Scale so the whole content fits the box with `pad` pixels around it, centred. */
export function fitView(content, box, pad = 20) {
  const z = clamp(Math.min((box.w - 2 * pad) / content.w, (box.h - 2 * pad) / content.h), MIN_Z, MAX_Z);
  return { x: (box.w - content.w * z) / 2, y: (box.h - content.h * z) / 2, z };
}

/** Zoom by `factor` about the box point (px, py): what was under the cursor stays under it. */
export function zoomAt(view, factor, px, py) {
  const z = clamp(view.z * factor, MIN_Z, MAX_Z);
  const k = z / view.z;
  return { x: px - (px - view.x) * k, y: py - (py - view.y) * k, z };
}

/** Put content point (cx, cy) in the middle of the box, at the current scale unless `z` is given. */
export function centerOn(view, box, point, z = view.z) {
  z = clamp(z, MIN_Z, MAX_Z);
  return { x: box.w / 2 - point.x * z, y: box.h / 2 - point.y * z, z };
}
