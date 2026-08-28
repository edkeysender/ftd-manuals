#!/usr/bin/env node
/**
 * bump.js — decides which manuals need a new revision and stamps them.
 *
 *   node tools/bump.js                      # dry run: report what would change
 *   node tools/bump.js --write              # apply to sims/*.json
 *   node tools/bump.js --check              # exit 1 if any manual is unreleased
 *   node tools/bump.js --write --date 2026-08-27
 *
 * A manual is "unreleased" when the content hash the resolver computes for it differs
 * from the content_hash recorded in its sim config. That happens when a chunk it uses
 * was edited, or when the installed modules/versions changed. Issue and revision
 * numbers are therefore never chosen by hand:
 *
 *   - first release of a manual  → keep the declared revision, record the hash
 *   - content changed afterwards → revision += 1
 *
 * A manual with a gap or a broken link is never released; it is reported as held.
 * Bumping the revision does not change the content hash (the hash excludes issue,
 * revision and effective_date), so re-running this tool is idempotent.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const CHECK = argv.includes("--check");
const dateArg = argv[argv.indexOf("--date") + 1];
const TODAY = argv.includes("--date") && /^\d{4}-\d{2}-\d{2}$/.test(dateArg || "")
  ? dateArg
  : new Date().toISOString().slice(0, 10);

for (const a of argv) {
  if (a.startsWith("--") && !["--write", "--check", "--date"].includes(a)) {
    console.error(`✖ unknown flag "${a}" (expected --write, --check, --date)`);
    process.exit(2);
  }
}

// Always resolve first so the hashes reflect what is on disk right now.
execFileSync(process.execPath, [path.join(__dirname, "resolve.js"), "--all"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
const admin = JSON.parse(fs.readFileSync(path.join(ROOT, "docs", "admin.json"), "utf8"));

/**
 * Rewrites one key inside the "manual" object of a sim config, leaving the rest of the
 * file byte-for-byte intact. The module table in these files is hand-aligned and
 * re-serialising the whole document would destroy that alignment.
 */
function setManualField(text, key, value) {
  const start = text.indexOf('"manual"');
  if (start === -1) throw new Error('no "manual" object in config');
  const open = text.indexOf("{", start);
  let depth = 0, end = -1;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('unterminated "manual" object');

  const block = text.slice(open, end + 1);
  const literal = typeof value === "number" ? String(value) : JSON.stringify(value);
  const existing = new RegExp(`("${key}"\\s*:\\s*)(?:"[^"]*"|-?\\d+)`);

  let updated;
  if (existing.test(block)) {
    updated = block.replace(existing, `$1${literal}`);
  } else {
    // Insert as the last property, copying the indentation of the previous line.
    const lastProp = block.lastIndexOf("\n");
    const indent = (block.match(/\n(\s+)"/) || [null, "        "])[1];
    updated = block.slice(0, lastProp).replace(/,?\s*$/, "") + `,\n${indent}"${key}": ${literal}` + block.slice(lastProp);
  }
  return text.slice(0, open) + updated + text.slice(end + 1);
}

const released = [];
const held = [];
const unchanged = [];

for (const m of admin.manuals) {
  if (!m.releasable) {
    held.push(m);
    continue;
  }
  if (!m.unreleased) {
    unchanged.push(m);
    continue;
  }

  const first = m.storedHash === null;
  const revision = first ? m.revision : m.revision + 1;
  const tag = `manual/${m.slug}/${m.issue}.${revision}`;
  const entry = { serial: m.serial, slug: m.slug, issue: m.issue, revision, from: m.issueRev,
    to: `${m.issue}.${revision}`, effective_date: TODAY, contentHash: m.contentHash, tag, first, configPath: m.configPath };
  released.push(entry);

  if (WRITE) {
    const file = path.join(ROOT, m.configPath);
    let text = fs.readFileSync(file, "utf8");
    text = setManualField(text, "revision", revision);
    text = setManualField(text, "effective_date", TODAY);
    text = setManualField(text, "content_hash", m.contentHash);
    JSON.parse(text);   // refuse to write a config we just broke
    fs.writeFileSync(file, text);
  }
}

// ---------- report ----------
for (const m of unchanged) console.log(`· ${m.serial} — Issue ${m.issueRev}, no content change`);
for (const m of held) {
  const why = [m.gaps.length && `${m.gaps.length} gap(s)`, m.brokenLinks.length && `${m.brokenLinks.length} broken link(s)`].filter(Boolean).join(", ");
  console.log(`⛔ ${m.serial} — HELD, not releasable: ${why}`);
  for (const g of m.gaps) console.log(`     ${g.module}: ${g.detail}`);
  for (const b of m.brokenLinks) console.log(`     ${b.from}: ${b.detail}`);
}
for (const r of released) {
  console.log(`${WRITE ? "✔" : "→"} ${r.serial} — Issue ${r.from} → ${r.to}, effective ${r.effective_date}  ${r.first ? "(first release)" : ""}`);
  console.log(`     tag: ${r.tag}`);
}

if (released.length) {
  fs.mkdirSync(path.join(ROOT, "dist"), { recursive: true });
  fs.writeFileSync(path.join(ROOT, "dist", "release.json"), JSON.stringify({ date: TODAY, applied: WRITE, manuals: released }, null, 2));
}

if (!WRITE && released.length) console.log(`\n${released.length} manual(s) need a revision — re-run with --write to apply.`);
if (!released.length && !held.length) console.log("\nAll manuals up to date.");

// --check is for CI: fail the build if someone changed content without releasing it.
// Held manuals are not a --check failure — a known gap would otherwise keep every PR
// red forever. Use `resolve --all --strict` when gaps should block.
if (CHECK && released.length) {
  console.error(`\n✖ --check: ${released.length} manual(s) have unreleased content changes`);
  process.exit(1);
}
