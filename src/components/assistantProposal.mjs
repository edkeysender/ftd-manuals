/**
 * assistantProposal — the gate every AI-drafted edit has to pass before it may touch a chunk.
 *
 * The assistant in the admin panel proposes a *complete replacement* of the chunk it was asked
 * to edit. That proposal is never applied silently: the panel shows it as a diff, and the author
 * accepts or rejects it. This module is the mechanical half of that decision — the part that does
 * not depend on the author reading carefully.
 *
 * It answers two questions:
 *
 *   1. Would the proposal still parse as a chunk? A chunk that chunkMarkdown.mjs refuses cannot
 *      be opened in rich-text mode, and is usually a chunk that will break the build. A proposal
 *      that a *currently parseable* file would turn into an unparseable one is refused outright.
 *      (A file that already does not parse is not held to a higher standard than itself: the
 *      verdict is then a warning, not a refusal — otherwise the assistant could never help with
 *      exactly the files that need the most help.)
 *   2. Did the proposal change the front matter? applies_to, title and summary are the fields the
 *      resolver keys off. They are only ever changed on purpose, so a change here is surfaced
 *      loudly rather than slipped past in the middle of a long diff.
 *
 * Plain ESM with no dependencies beyond chunkMarkdown.mjs, so the browser bundle
 * (src/components/AssistantPanel.jsx) and node (tools/admin-server.js) run the identical checks.
 * The server screens the proposal when it produces it; the panel screens it again at the moment
 * the author presses Accept. The second check is the load-bearing one.
 */
import { parseChunk } from "./chunkMarkdown.mjs";

const RE_FENCE = /^---[ \t]*\r?$/;

/** The verbatim front matter block of a chunk (fences included), or null if there is none. */
export function frontMatterBlock(text) {
  if (typeof text !== "string") return null;
  const lines = text.split("\n");
  if (lines.length === 0 || !RE_FENCE.test(lines[0])) return null;
  for (let i = 1; i < lines.length; i++) {
    if (RE_FENCE.test(lines[i])) return lines.slice(0, i + 1).join("\n");
  }
  return null;
}

function tryParse(text) {
  try {
    parseChunk(text);
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) };
  }
}

/**
 * Screen one proposal.
 *
 *   screenProposal(currentText, proposedText, "modules/starting-panel/v2.mdx")
 *     → { ok, blocking: [...], warnings: [...], frontMatterChanged, unchanged, originalRefused }
 *
 * `ok === false` means the proposal must not be applied; `blocking` says why, in words meant to
 * be shown to the author. `warnings` are things worth reading before accepting, not reasons to
 * refuse.
 */
export function screenProposal(original, proposal, filePath = "") {
  const blocking = [];
  const warnings = [];
  const verdict = (extra = {}) => ({
    ok: blocking.length === 0, blocking, warnings,
    frontMatterChanged: false, unchanged: false, originalRefused: false, ...extra,
  });

  if (typeof proposal !== "string" || proposal.trim() === "") {
    blocking.push("the proposal is empty, so there is nothing to apply");
    return verdict();
  }
  if (typeof original === "string" && proposal === original) {
    return verdict({ unchanged: true });
  }

  // Only chunks have front matter and a rich-text model; module.yaml and sim configs do not.
  if (!/\.mdx?$/.test(filePath)) return verdict();

  const before = frontMatterBlock(original);
  const after = frontMatterBlock(proposal);
  let frontMatterChanged = false;
  if (after === null) {
    blocking.push("the proposal has no YAML front matter — the --- block at the top of every chunk");
  } else if (before !== null && after !== before) {
    frontMatterChanged = true;
    warnings.push("this proposal also rewrites the front matter (applies_to / title / summary). "
      + "Read those lines of the diff before accepting.");
  }

  const originalRefused = !tryParse(original).ok;
  const afterVerdict = tryParse(proposal);
  if (!afterVerdict.ok) {
    if (originalRefused) {
      warnings.push(`the proposal still cannot be opened in rich text (${afterVerdict.reason}) — `
        + "neither can the file as it stands, so this is not a regression");
    } else {
      blocking.push(`the proposal would no longer parse as a chunk: ${afterVerdict.reason}. `
        + "It is not applied and the file is unchanged.");
    }
  }

  return verdict({ frontMatterChanged, originalRefused });
}
