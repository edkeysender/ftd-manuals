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
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
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

export async function generateFirstDraft(module) {
  const sys = `You draft module manuals for FTD.aero flight simulation training devices. Produce the body HTML of a mini-manual (sections 4–7 only, starting at <h2>Installation</h2>). ${HTML_RULES}
Return ONLY the raw HTML, no markdown fences, no commentary.`;
  const user = `Module metadata:\n${JSON.stringify(module, null, 2)}\n\nDraft the manual body. Keep it a plausible skeleton with concrete structure, and use TODO(author) markers for every fact you cannot know.`;
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
 */
export async function chatEdit({ module, doc, content, messages }) {
  const sys = `You are the AI assistant of the FTD.aero Documentation Console, working inside the manual editor for module "${module.name}" (doc ${doc.version} r${doc.revision}, status ${doc.status}).
You receive the CURRENT DOCUMENT BODY (sections 4–7 HTML) and the user's instruction.
${HTML_RULES}

If the instruction asks for a document change: apply it and return the FULL updated body HTML. Wrap every element you inserted or modified (and only those) in <div class="ai-edit-pending" data-ai-source="SOURCE">…</div>, where SOURCE is a short citation of what the edit is based on (the user's instruction, module metadata, or general FTD manual conventions). Never wrap unchanged elements. Never delete content the user did not ask to change.
If the instruction is only a question, answer it and return no HTML.

Respond with a JSON object: {"reply": "<short answer for the chat, 1-3 sentences>", "html": "<full updated body HTML>" } — set "html" to null when no change is made.`;

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
  };
}
