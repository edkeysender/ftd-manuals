/**
 * AI assistant backed by the OpenAI API (OPENAI_API_KEY from .env).
 * Two jobs: generate a first draft of sections 4–7, and apply chat-instructed
 * edits to the draft, marking every touched block as a pending AI edit.
 */

import { manualTypeOf, DEFAULT_MANUAL, LANGUAGES, DEFAULT_LANG, langOf } from './docgen.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_MODEL || 'gpt-5';

export function aiAvailable() {
  return !!process.env.OPENAI_API_KEY;
}

async function callOpenAI(messages, { json = false } = {}) {
  if (!aiAvailable()) throw new Error('OPENAI_API_KEY is not set — AI assistant is unavailable');
  const supportsReasoning = /^(gpt-5|o\d)/.test(MODEL);
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    signal: AbortSignal.timeout(240000),
    body: JSON.stringify({
      model: MODEL,
      messages,
      ...(supportsReasoning ? { reasoning_effort: process.env.OPENAI_REASONING_EFFORT || 'low' } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).error?.message || body;
    } catch {}
    throw new Error(`OpenAI API error (${res.status}): ${detail}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const HTML_RULES = `Allowed HTML only: <h2> (top-level sections), <h3> (subsections), <p>, <ol>, <ul>, <li>, <strong>, <em>, <table>/<thead>/<tbody>/<tr>/<th>/<td>, <figure>/<img>/<figcaption>, and admonitions as <div class="admonition warning"><p class="admonition-title">Warning</p><p>…</p></div> (or class "note" with title "Note").
Style: operating-manual English, present tense, no marketing language. Procedures are numbered lists (<ol>), one action per step, with the expected indication after the action. Do not invent behaviour, timings, part numbers or limits — write TODO(author): … where facts are missing. Never write passwords or other credentials into a manual — refer to the credentials sheet instead.`;

/** Which manual is being written, for whom, and what its sections 4–7 are. */
function manualBlock(manualId) {
  const t = manualTypeOf(manualId);
  const sections = t.sections.map((s) => `${s} — ${t.sectionHints[s] || ''}`).join('; ');
  const audience =
    t.audience === 'technician'
      ? 'The reader is the installer / service technician: wiring, configuration, servicing and troubleshooting belong here; everyday operation only as far as needed to verify the set-up.'
      : 'The reader is the operator of the simulator (instructor, technician on duty, school staff): describe use, indications and operator-level checks; NO wiring, configuration, servicing or credentials — those belong in the technician manual.';
  const subject = t.kind === 'software' ? 'This manual documents the SOFTWARE linked to the module (its screens, tasks and settings), not the hardware unit itself.' : 'This manual documents the hardware module.';
  return `THIS DOCUMENT is the ${t.label.toUpperCase()} of the module. ${audience} ${subject}
Its top-level <h2> sections are exactly: ${t.sections.join(', ')} (sections 4–7 of the FTD standard; sections 1–3 are auto-generated elsewhere — never produce them). Section contents: ${sections}.`;
}

const guidelinesBlock = (guidelines) =>
  guidelines && guidelines.trim()
    ? `\nOPERATOR GUIDELINES — set by the documentation owner in Settings; always follow them:\n${guidelines.trim()}\n`
    : '';

export async function generateFirstDraft(module, guidelines = '', manual = DEFAULT_MANUAL) {
  const t = manualTypeOf(manual);
  const sys = `You draft module manuals for FTD.aero flight simulation training devices. Produce the body HTML of a mini-manual (sections 4–7 only, starting at <h2>${t.sections[0]}</h2>). ${HTML_RULES}
${manualBlock(t.id)}
${guidelinesBlock(guidelines)}
Return ONLY the raw HTML, no markdown fences, no commentary.`;
  const perUnitSections = t.sections.slice(0, 2); // the two sections that get one <h3> per unit / software
  const hwHint =
    t.kind !== 'software' && (module.hardwareItems || []).length > 1
      ? ` The module covers ${module.hardwareItems.length} hardware unit types (${module.hardwareItems.map((h) => h.name).join(', ')}): describe each one in its own <h3> subsection under ${perUnitSections.join(' and ')}, and keep what is common to all of them in the shared paragraphs.`
      : '';
  const swHint =
    t.kind === 'software' && (module.softwares || []).length > 1
      ? ` The module links ${module.softwares.length} softwares (${module.softwares.map((s) => s.name).join(', ')}): give each its own <h3> subsection where they differ.`
      : '';
  const user = `Module metadata:\n${JSON.stringify(module, null, 2)}\n\nDraft the ${t.label.toLowerCase()} body. Keep it a plausible skeleton with concrete structure, and use TODO(author) markers for every fact you cannot know.${hwHint}${swHint}`;
  const html = await callOpenAI([
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ]);
  return html.replace(/^```html?\s*/i, '').replace(/```\s*$/, '').trim() + '\n';
}

/**
 * Chat-driven edit. Returns { reply, html } where html is the full updated
 * sections 4–7 HTML with every inserted or modified element wrapped in
 * <div class="ai-edit-pending" data-ai-source="…">…</div>, or html=null when
 * the assistant only answers without editing.
 *
 * `context` is gathered server-side before the call: pages fetched from URLs
 * the user pasted, images already downloaded into the module's asset store,
 * and text attachments from the chat.
 */
/**
 * Translate a manual body (sections 4–7 HTML) into `lang`, keeping the HTML structure,
 * attributes, image paths and TODO(author) markers untouched. Returns the translated HTML.
 */
export async function translateHtml({ html, lang, module, doc, guidelines = '' }) {
  const target = LANGUAGES[langOf(lang)];
  if (!target || target.source) throw new Error(`Cannot translate into "${lang}"`);
  const sys = `You translate FTD.aero flight simulator manuals from English into ${target.label} (${target.code}).
You receive the body HTML (sections 4–7) of the ${manualTypeOf(doc.manual).label.toLowerCase()} of module "${module.name}" and return the SAME HTML with all human-readable text translated.
Rules:
- Keep every tag, attribute, class, id, <img src>, href and the document structure exactly as they are; translate only text nodes, alt texts and figcaptions.
- Keep the "TODO(author):" prefix of author markers as is and translate the note after it.
- Do not translate software/product names, part numbers, menu paths shown in <strong> when they are UI labels of an English interface, code, URLs, IP addresses, units or version numbers.
- Aviation / simulator operating-manual register: imperative procedures, present tense, consistent terminology (${target.code === 'pl' ? 'e.g. "symulator", "moduł", "instruktor", "stanowisko instruktora (IOS)", "zasilanie", "okablowanie", "konfiguracja"' : 'standard technical terms'}).
- Admonition titles: ${target.code === 'pl' ? '"Warning" → "Ostrzeżenie", "Note" → "Uwaga"' : 'translate the title words'}.
- Section headings (<h2>) must be translated consistently: ${target.code === 'pl' ? 'Description → Opis, Installation → Instalacja, Configuration → Konfiguracja, Operation → Obsługa, Maintenance → Konserwacja, Administration → Administracja, Troubleshooting → Rozwiązywanie problemów, Overview → Przegląd, Appendixes → Załączniki' : 'use the standard manual section names'}.
${guidelinesBlock(guidelines)}
Return ONLY the raw translated HTML — no markdown fences, no commentary.`;
  const out = await callOpenAI([
    { role: 'system', content: sys },
    { role: 'user', content: html },
  ]);
  const clean = out.replace(/^```html?\s*/i, '').replace(/```\s*$/, '').trim();
  if (!clean || !/<h2/i.test(clean)) throw new Error('Translation returned no document body');
  return clean + '\n';
}

export async function chatEdit({ module, doc, content, messages, context = {}, guidelines = '', illustrationStyle = '', lang = DEFAULT_LANG }) {
  const { pages = [], assets = [], attachmentsText = [] } = context;
  const language = LANGUAGES[langOf(lang)];
  const langBlock = language.source
    ? ''
    : `\nLANGUAGE: this is the ${language.label} (${language.code}) translation of the document. Write every reply and every edit in ${language.label}; keep the section headings in ${language.label} as they are in the body. The English source is a separate document — do not switch to English.`;

  const assetBlock = assets.length
    ? `IMAGES available in the module's asset store — these files exist and are served by the console. Embed images ONLY from this list, using the src exactly as given, as <figure><img src="URL" alt="…"><figcaption>…</figcaption></figure>:
${assets.map((a) => `- ${a.url}${a.alt ? ` — alt: ${a.alt}` : ''}${a.from ? ` — origin: ${a.from}` : ''}${a.version ? ` — version: ${a.version}` : ''}`).join('\n')}
Never invent an image path. If no listed asset fits, write TODO(author): figure needed — no <img> tag.
Each asset's "version" is what the picture showed when it was added (doc version, software release, hardware version). An asset marked OUT OF DATE shows an older release than the one this doc must describe: do not embed it for new content unless the user explicitly asks; instead write TODO(author): figure <name> shows <old version>, retake for <new version>. When you must keep such a figure, say so in its <figcaption>.`
    : 'No images are available in the asset store — never insert <img> tags; write TODO(author): figure needed instead.';

  const pageBlock = pages.length
    ? `SOURCE PAGES — the console has fetched these URLs for you (you do have this content; do not claim you cannot open websites). Use them as the factual source and cite the URL in data-ai-source:
${pages.map((p) => `=== ${p.url}${p.title ? ` — ${p.title}` : ''} ===\n${p.text}`).join('\n\n')}`
    : '';

  const attachBlock = attachmentsText.length
    ? `ATTACHED FILES from the chat:\n${attachmentsText.map((a) => `=== ${a.name} ===\n${a.text}`).join('\n\n')}`
    : '';

  const hwLine = (module.hardwareItems || []).length
    ? `\nHardware units this manual describes: ${module.hardwareItems.map((h) => `${h.name} (${h.type === 'ftd' ? `FTD.aero ${h.version || 'v1'}` : `COTS ${[h.manufacturer, h.model].filter(Boolean).join(' ')}`})${h.notes ? ` — ${h.notes}` : ''}`).join('; ')}. When several units are listed, keep each one described in its own subsection.`
    : '';
  const sys = `You are the AI assistant of the FTD.aero Documentation Console, working inside the manual editor for module "${module.name}" (${manualTypeOf(doc.manual).label.toLowerCase()}, doc ${doc.version} r${doc.revision}, status ${doc.status}).${hwLine}
You receive the CURRENT DOCUMENT BODY (sections 4–7 HTML) and the user's instruction.
${HTML_RULES}
${manualBlock(doc.manual)}${langBlock}
When source material mixes audiences (e.g. a wiki page with both wiring/configuration and everyday use), take only what belongs in THIS manual type and tell the user in the reply what belongs in the other manual instead.
${guidelinesBlock(guidelines)}
${assetBlock}

If the instruction asks for a document change: apply it and return the FULL updated body HTML. Wrap every element you inserted or modified (and only those) in <div class="ai-edit-pending" data-ai-source="SOURCE">…</div>, where SOURCE is a short citation of what the edit is based on (a source page URL, an attached file, the user's instruction, module metadata, or general FTD manual conventions). Never wrap unchanged elements. Never delete content the user did not ask to change.
If the instruction is only a question, answer it and return no HTML.

${pageBlock}

${attachBlock}

IMAGE GENERATION — you can create new illustrations (diagrams, line-art conversions of photos, style renderings). Add to your JSON:
"generate_images": [{"name": "kebab-case-name.png", "style": "line-art" | null, "prompt": "<what to draw / what to emphasise>", "reference_asset": "<file name of an existing asset to use as visual reference, or null>"}]
HOUSE STYLE: FTD.aero manual illustrations use the "Technical Aviation Manual Line-Art" style (a.k.a. "our style", "FTD style", "OEM aircraft manual style"). Whenever the user asks for that style, for a photo converted to a technical drawing, or for a manual illustration without naming another style, set "style": "line-art" — the console then prepends the full house-style definition to your prompt itself, so your prompt only needs to describe the subject, the steps/callouts to show and any emphasis. For reference, the definition is:
${(illustrationStyle || '').trim()}
The console generates each image with an image model (the reference asset is supplied to it as the visual base) and saves it into the asset store BEFORE your edit is displayed — so you may embed it in the html immediately as <img src="/api/modules/${module.slug}/assets/<name>">. Assets named *-lineart.png are already in the house style — embed them directly instead of regenerating. Use at most 3 per turn. Use this whenever the user asks for an illustration, a technical drawing, or a photo converted to a drawing style — never refuse such requests and never claim you cannot transform images.

Respond with a JSON object: {"reply": "<short answer for the chat, 1-3 sentences>", "html": "<full updated body HTML>", "generate_images": [...] } — set "html" to null when no change is made, omit "generate_images" when none are needed.`;

  const convo = messages.slice(-12).map((m) => ({ role: m.role, content: m.content }));
  const user = {
    role: 'user',
    content: `CURRENT DOCUMENT BODY:\n${content}\n\n(Answer or edit per the conversation above — the last user message is the active instruction.)`,
  };
  const raw = await callOpenAI([{ role: 'system', content: sys }, ...convo, user], { json: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply: raw.slice(0, 2000), html: null };
  }
  return {
    reply: parsed.reply || 'Done.',
    html: typeof parsed.html === 'string' && parsed.html.trim() ? parsed.html : null,
    generateImages: Array.isArray(parsed.generate_images)
      ? parsed.generate_images.filter((g) => g && g.name && (g.prompt || g.style)).slice(0, 3)
      : [],
  };
}

/* ------------------------------------------------------------------ */
/* Image generation (OpenAI images API, OPENAI_IMAGE_MODEL)             */
/* ------------------------------------------------------------------ */

const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2'; // gpt-image-1 is scheduled for shutdown 2026-10-23
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

/**
 * Generate one image. When reference images are given, the images/edits
 * endpoint is used so the output is based on them — the prompt refers to them
 * as "image 1", "image 2"… in the order given (e.g. a photo to redraw followed
 * by style exemplars); otherwise plain generation. Returns a PNG Buffer.
 */
export async function generateImage({ prompt, reference = null, references = [] }) {
  if (!aiAvailable()) throw new Error('OPENAI_API_KEY is not set');
  const headers = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
  const inputs = [reference, ...references].filter((r) => r && r.buffer && r.buffer.length);
  let res;
  if (inputs.length) {
    const form = new FormData();
    form.append('model', IMAGE_MODEL);
    form.append('quality', IMAGE_QUALITY);
    form.append('prompt', prompt);
    for (const r of inputs) {
      const type = /\.png$/i.test(r.name) ? 'image/png' : /\.webp$/i.test(r.name) ? 'image/webp' : 'image/jpeg';
      form.append('image[]', new Blob([r.buffer], { type }), r.name);
    }
    res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers,
      body: form,
      signal: AbortSignal.timeout(180000),
    });
  } else {
    res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1024x1024', quality: IMAGE_QUALITY }),
      signal: AbortSignal.timeout(180000),
    });
  }
  if (!res.ok) {
    const body = await res.text();
    let detail = body;
    try {
      detail = JSON.parse(body).error?.message || body;
    } catch {}
    throw new Error(`Image API error (${res.status}): ${detail}`);
  }
  const data = await res.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('Image API returned no image data');
  return Buffer.from(b64, 'base64');
}

/* ------------------------------------------------------------------ */
/* Web sourcing — the console fetches URLs on the model's behalf       */
/* ------------------------------------------------------------------ */

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FTD-Documentation-Console/0.1)',
  'Accept-Language': 'en,pl;q=0.8',
};

export function extractUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  return [...new Set(found.map((u) => u.replace(/[.,;:]+$/, '')))].slice(0, 3);
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h\d|tr|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#8217;|&rsquo;/gi, "'")
    .replace(/&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function extractImages(html, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    const alt = (tag.match(/\balt\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    if (!src || src.startsWith('data:')) continue;
    let abs;
    try {
      abs = new URL(src, baseUrl).href;
    } catch {
      continue;
    }
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, alt });
    if (out.length >= 12) break;
  }
  return out;
}

export async function fetchPage(url) {
  const res = await fetch(url, {
    headers: FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim() || '';
  return {
    url: res.url || url,
    title,
    text: htmlToText(html).slice(0, 18000),
    images: extractImages(html, res.url || url),
  };
}

const EXT_BY_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/svg+xml': '.svg',
};

/**
 * Describe a picture with the vision model so the agent (and the Assets tab) get a
 * caption, alt text and which hardware unit it shows — without the picture ever
 * passing through the MCP client. Returns {kind, caption, alt, description, shows, suggestedName}.
 */
export async function describeImage({ buffer, mimeType = 'image/jpeg', module, name = '' }) {
  const units = (module?.hardwareItems || []).map((h) => `${h.id}: ${h.name}${h.model ? ` (${[h.manufacturer, h.model].filter(Boolean).join(' ')})` : ''}`);
  const prompt = `You describe pictures for an FTD.aero flight-simulator maintenance/operation manual. Module: "${module?.name || '?'}"${
    units.length ? `. Hardware units of this module (id: name): ${units.join('; ')}` : ''
  }. File name: ${name || '—'}.
Return JSON: {"kind": "photo"|"screenshot"|"drawing"|"diagram"|"other", "caption": "<figure caption in operating-manual English, one sentence, no marketing>", "alt": "<short alt text>", "description": "<what is visible: components, labels, connectors, on-screen text — 2-4 sentences, facts only>", "shows": [<ids of the hardware units visible, from the list, or empty>], "suggestedName": "<kebab-case file name with extension>", "text": "<any readable on-screen or label text, verbatim, or empty>"}.`;
  const raw = await callOpenAI(
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${buffer.toString('base64')}`, detail: 'high' } },
        ],
      },
    ],
    { json: true }
  );
  try {
    return JSON.parse(raw);
  } catch {
    return { kind: 'other', caption: '', alt: '', description: raw, shows: [], suggestedName: name, text: '' };
  }
}

/** Download one image; returns {name, buffer} or null (non-image, icon-sized, or oversized). `headers` adds credentials for protected hosts. */
export async function downloadImage(url, { minBytes = 4096, headers = {} } = {}) {
  const res = await fetch(url, { headers: { ...FETCH_HEADERS, ...headers }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!res.ok) return null;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < minBytes || buffer.length > 6 * 1024 * 1024) return null;
  let name = 'image';
  try {
    name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'image');
  } catch {}
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += EXT_BY_TYPE[type] || '.img';
  return { name, buffer };
}
