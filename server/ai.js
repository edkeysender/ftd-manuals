/**
 * AI assistant backed by the OpenAI API (OPENAI_API_KEY from .env).
 * Two jobs: generate a first draft of sections 4–7, and apply chat-instructed
 * edits to the draft, marking every touched block as a pending AI edit.
 */

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
Style: operating-manual English, present tense, no marketing language. Procedures are numbered lists (<ol>), one action per step, with the expected indication after the action. Do not invent behaviour, timings, part numbers or limits — write TODO(author): … where facts are missing.
The document's top-level <h2> sections are Installation, Operation, Maintenance, Appendixes (sections 4–7 of the FTD standard; sections 1–3 are auto-generated elsewhere — never produce them).`;

const guidelinesBlock = (guidelines) =>
  guidelines && guidelines.trim()
    ? `\nOPERATOR GUIDELINES — set by the documentation owner in Settings; always follow them:\n${guidelines.trim()}\n`
    : '';

export async function generateFirstDraft(module, guidelines = '') {
  const sys = `You draft module manuals for FTD.aero flight simulation training devices. Produce the body HTML of a mini-manual (sections 4–7 only, starting at <h2>Installation</h2>). ${HTML_RULES}
${guidelinesBlock(guidelines)}
Return ONLY the raw HTML, no markdown fences, no commentary.`;
  const hwHint =
    (module.hardwareItems || []).length > 1
      ? ` The module covers ${module.hardwareItems.length} hardware unit types (${module.hardwareItems.map((h) => h.name).join(', ')}): describe each one in its own <h3> subsection under Installation and Operation, and keep what is common to all of them in the shared paragraphs.`
      : '';
  const user = `Module metadata:\n${JSON.stringify(module, null, 2)}\n\nDraft the manual body. Keep it a plausible skeleton with concrete structure, and use TODO(author) markers for every fact you cannot know.${hwHint}`;
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
export async function chatEdit({ module, doc, content, messages, context = {}, guidelines = '', illustrationStyle = '' }) {
  const { pages = [], assets = [], attachmentsText = [] } = context;

  const assetBlock = assets.length
    ? `IMAGES available in the module's asset store — these files exist and are served by the console. Embed images ONLY from this list, using the src exactly as given, as <figure><img src="URL" alt="…"><figcaption>…</figcaption></figure>:
${assets.map((a) => `- ${a.url}${a.alt ? ` — alt: ${a.alt}` : ''}${a.from ? ` — origin: ${a.from}` : ''}`).join('\n')}
Never invent an image path. If no listed asset fits, write TODO(author): figure needed — no <img> tag.`
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
  const sys = `You are the AI assistant of the FTD.aero Documentation Console, working inside the manual editor for module "${module.name}" (doc ${doc.version} r${doc.revision}, status ${doc.status}).${hwLine}
You receive the CURRENT DOCUMENT BODY (sections 4–7 HTML) and the user's instruction.
${HTML_RULES}
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

/** Download one image; returns {name, buffer} or null (non-image, icon-sized, or oversized). */
export async function downloadImage(url, { minBytes = 4096 } = {}) {
  const res = await fetch(url, { headers: FETCH_HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20000) });
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
