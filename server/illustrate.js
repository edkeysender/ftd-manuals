/**
 * FTD.aero house illustration style — "Technical Aviation Manual Line-Art".
 * One definition shared by every entry point that turns a photo into a manual
 * illustration: the drop target in the editor's AI pane, the AI chat's
 * generate_images, the Assets tab and the MCP convert_to_line_art tool.
 * The text itself is editable in Settings (settings/illustration-style.md);
 * this file holds the default and the prompt assembly.
 */
import * as store from './store.js';
import * as ai from './ai.js';

export const STYLE_NAME = 'Technical Aviation Manual Line-Art';

export const DEFAULT_STYLE = `Style name: Technical Aviation Manual Line-Art (shorthand: OEM Aircraft Manual Style).

What defines it:
- Clean black-and-white technical line drawing
- Realistic representation of the actual simulator hardware
- Precise mechanical shapes, hinges, bolts, latches, handles, wheels, etc.
- Very limited gray shading/hatching
- White, uncluttered background
- Bold black section headers
- Large numbered step circles
- Clear directional/movement arrows
- Close-up detail callouts for mechanisms
- Multiple clearly separated instruction panels
- Short, professional aviation-manual wording
- Safety warnings and capacity information displayed prominently
- No unnecessary people, background equipment, or visual clutter
- Do not use the original real photographs in the final illustration; use them only as reference for creating the technical drawing.`;

/** Effective style text: the Settings override or the built-in default. */
export async function getStyle() {
  return (await store.getIllustrationStyle()) || DEFAULT_STYLE;
}

/**
 * The prompt sent to the image model. The input images are numbered in the
 * order they are sent: [subject photo | illustration being edited], (photo when
 * editing), then the style exemplars from Settings.
 */
export function lineArtPrompt(style, instructions = '', { hasReference = true, exemplars = 0, editing = false, editHasPhoto = false } = {}) {
  const lines = [];
  let next = 1;
  if (editing) {
    lines.push(
      `Image ${next} is our current illustration of simulator hardware, already in our house style "${STYLE_NAME}". EDIT this illustration: apply only the changes requested below and keep everything else identical — same composition, viewpoint, line style and existing callouts. Do not redraw from scratch.`
    );
    next += 1;
    if (editHasPhoto) {
      lines.push(`Image ${next} is the original photograph of the same hardware, for reference of the real geometry.`);
      next += 1;
    }
  } else if (hasReference) {
    lines.push(
      `Image ${next} is a reference photograph of flight simulator hardware. Redraw it as ONE technical illustration for an FTD.aero flight simulator operating manual in our house style "${STYLE_NAME}": keep the same viewpoint and framing as the photograph and reproduce the hardware faithfully — shapes, proportions, controls, markings — as clean black-and-white line art, not a photo.`
    );
    next += 1;
  } else {
    lines.push(`Draw ONE technical illustration for an FTD.aero flight simulator operating manual in our house style "${STYLE_NAME}".`);
  }
  if (exemplars > 0) {
    const range = exemplars === 1 ? `Image ${next}` : `Images ${next}–${next + exemplars - 1}`;
    lines.push(
      `${range} ${exemplars === 1 ? 'is a finished illustration' : 'are finished illustrations'} in our house style. Match ${exemplars === 1 ? 'its' : 'their'} look exactly — line weight, amount of shading, background, numbered callout circles, arrows, label typography, overall density. ${exemplars === 1 ? 'It defines' : 'They define'} the style; the written definition below is secondary. Do not copy ${exemplars === 1 ? 'its' : 'their'} subject — draw the subject of image 1.`
    );
  }
  const extra = instructions && instructions.trim() ? `\n\nREQUESTED CHANGES / INSTRUCTIONS:\n${instructions.trim()}` : '';
  return `${lines.join('\n')}\n\nSTYLE DEFINITION:\n${(style || DEFAULT_STYLE).trim()}\n\n${OUTPUT_RULES}${extra}`;
}

/* Guard rails that apply on top of the (editable) style: the image is one
   figure inside a manual page, and manuals must not contain invented facts. */
const OUTPUT_RULES = `OUTPUT RULES (always apply):
- Produce ONE illustration in ONE view — a single drawing of the subject, not a multi-panel sheet, storyboard or step sequence. Use several panels only when the instructions explicitly ask for steps or panels.
- This is a FIGURE placed inside a manual page, not a page or data sheet: draw only the illustration content — the hardware, numbered callout circles, movement arrows, a detail callout where a mechanism needs it, short labels. No document header, company logo or name, manual title, revision/date/page numbers, footer, specification tables or tool lists.
- Never invent facts: no part numbers, torque values, dimensions, weights, temperatures, standards, model or product names that are not clearly visible in the reference or given in the instructions. Prefer a plain arrow or numbered callout over a label when unsure.
- Text must be minimal, legible and correctly spelled; if a marking on the hardware cannot be reproduced legibly, omit it rather than garble it.`;

/** "panel photo.JPG" → "panel-photo-lineart.png" */
export function lineArtName(sourceName) {
  const base = store.sanitizeAssetName(sourceName || 'illustration');
  const stem = base.replace(/\.[a-z0-9]+$/, '').replace(/-lineart(-\d+)?$/, '');
  return `${stem}-lineart.png`;
}

/**
 * Convert a photo into a house-style line-art asset of the draft, or edit an
 * existing illustration.
 *   reference: { name, buffer } (a fresh upload — stored as an asset too, so
 *              the drawing can be redone later) or { assetName } (existing asset)
 *   editOf:    name of an existing illustration asset to modify in place — the
 *              model edits it (ChatGPT-style iteration) instead of redrawing
 *              the photo; the photo (if any) is passed as a second reference.
 * The style exemplars from Settings are always appended as extra input images.
 * Returns { source, illustration, prompt, exemplars }.
 */
export async function convertToLineArt({ slug, version, reference = null, instructions = '', name = null, keepSource = true, editOf = null }) {
  if (!ai.aiAvailable()) throw new Error('OPENAI_API_KEY is not set — image generation is unavailable');
  let ref = null;
  let source = null;
  if (reference?.assetName) {
    const buf = await store.getAsset(slug, reference.assetName);
    if (!buf) throw new Error(`Asset "${reference.assetName}" not found`);
    ref = { name: reference.assetName, buffer: buf };
    source = { name: reference.assetName, url: store.assetUrl(slug, reference.assetName) };
  } else if (reference?.buffer?.length) {
    ref = { name: reference.name || 'photo.png', buffer: reference.buffer };
    if (keepSource) [source] = await store.saveAssets(slug, version, [ref]);
  }
  let base = null;
  if (editOf) {
    const buf = await store.getAsset(slug, editOf);
    if (!buf) throw new Error(`Illustration "${editOf}" not found`);
    base = { name: editOf, buffer: buf };
  }
  if (!ref && !base) throw new Error('A reference image is required (upload data or an existing asset name)');

  const exemplars = await store.readStyleExemplars();
  const style = await getStyle();
  const prompt = lineArtPrompt(style, instructions, {
    hasReference: !!ref,
    exemplars: exemplars.length,
    editing: !!base,
    editHasPhoto: !!(base && ref),
  });
  const inputs = base ? [base, ...(ref ? [ref] : []), ...exemplars] : [ref, ...exemplars];
  const buffer = await ai.generateImage({ prompt, references: inputs });
  const outName = name || (base ? editOf : lineArtName(ref.name));
  const [illustration] = await store.saveAssets(slug, version, [{ name: outName, buffer }]);
  return { source, illustration, prompt, exemplars: exemplars.length, editedFrom: base ? editOf : null };
}
