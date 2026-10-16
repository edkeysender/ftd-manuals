/**
 * The schematic chat: the model reads the netlist as text and answers with operations, never with
 * a drawing. Its ops are dry-run through the applier here, so what the user is offered to accept is
 * exactly what will be written. The model call is injectable for tests.
 */
import * as ai from './ai.js';
import { applyOps, validateSchematic, OP_NAMES, SchematicError, endpointKey } from './schematic.js';
import { templateFor } from './library.js';

export function describeState(state, ctx) {
  const used = new Map();
  for (const c of state.cables) {
    used.set(endpointKey(c.from), c.label || c.id);
    used.set(endpointKey(c.to), c.label || c.id);
  }
  const portLine = (ownerKey, ports) =>
    ports.map((p) => {
      const u = used.get(`${ownerKey}:${p.id}`);
      return `${p.id}(${p.connector}, ${p.direction}${u ? `, used by ${u}` : ''})`;
    }).join(', ');
  const lines = [];
  if (state.kind === 'installation') {
    lines.push('LOCATIONS:');
    for (const l of state.locations) lines.push(`- ${l.id} "${l.label}" (${l.kind})`);
    if (!state.locations.length) lines.push('- none yet');
  }
  lines.push('DEVICES:');
  for (const d of state.devices) {
    const tpl = templateFor(ctx.library, d.template);
    lines.push(`- ${d.id} "${d.label}" [${d.template}]${d.location ? ` in ${d.location}` : ''}: ${portLine(`d:${d.id}`, tpl?.ports || [])}`);
  }
  if (!state.devices.length) lines.push('- none yet');
  if (state.kind === 'installation') {
    lines.push('MODULE BLOCKS (external ports only):');
    for (const b of state.blocks) {
      const rel = ctx.releasedSchematics.get(b.module);
      const face = (rel?.externalPorts || []).map((ep) => {
        const dev = rel.devices.find((x) => x.id === ep.device);
        const port = templateFor(ctx.library, dev?.template)?.ports.find((p) => p.id === ep.port);
        return { id: ep.id, connector: port?.connector || '?', direction: port?.direction || 'bidir' };
      });
      lines.push(`- ${b.id} module "${ctx.modules.find((m) => m.slug === b.module)?.name || b.module}" [${b.module}]${b.location ? ` in ${b.location}` : ''}: ${portLine(`b:${b.id}`, face)}`);
    }
    if (!state.blocks.length) lines.push('- none yet');
  } else {
    lines.push('EXTERNAL PORTS (leave the module):');
    for (const p of state.externalPorts) lines.push(`- ${p.id} "${p.label}" = ${p.device}.${p.port}`);
    if (!state.externalPorts.length) lines.push('- none yet');
  }
  lines.push('CABLES:');
  for (const c of state.cables) lines.push(`- ${c.id} "${c.label}" ${c.kind}: ${c.from.block ? `block ${c.from.block}` : c.from.device}.${c.from.port} -> ${c.to.block ? `block ${c.to.block}` : c.to.device}.${c.to.port}`);
  if (!state.cables.length) lines.push('- none yet');
  return lines.join('\n');
}

export function describeLibrary(ctx) {
  const dev = ctx.library.devices.map((d) => `- ${d.id} "${d.name}" (${d.category}): ${d.ports.map((p) => `${p.id}:${p.connector}/${p.direction}`).join(' ')}`).join('\n');
  const cables = ctx.library.cables.map((c) => `- ${c.id}: joins ${c.joins.map((j) => j.join('↔')).join(', ')}`).join('\n');
  const mods = [...ctx.releasedSchematics.keys()].map((slug) => `- ${slug} "${ctx.modules.find((m) => m.slug === slug)?.name || slug}"`).join('\n');
  return `DEVICE TEMPLATES (template id "name" (category): port:connector/direction …):\n${dev || '- none'}\nCABLE KINDS:\n${cables}\nMODULES WITH A RELEASED SCHEMATIC (placeable as blocks in an installation):\n${mods || '- none'}`;
}

const OP_SCHEMA = `OPERATIONS (JSON objects, "op" plus fields):
- {"op":"add_device","id"?,"template","hardwareId"?,"label"?,"location"?,"rack"?:{"u":n}}
- {"op":"update_device","id","label"?,"location"?,"rack"?,"notes"?}
- {"op":"remove_device","id","cascade"?:true}
- {"op":"connect","id"?,"kind"?,"from":{"device","port"}|{"block","port"},"to":…,"label"?,"length"?,"notes"?}  — kind is inferred when only one cable kind joins the two connectors
- {"op":"update_cable","id","label"?,"length"?,"notes"?}
- {"op":"disconnect","id"}
- module schematic only: {"op":"set_external_port","id"?,"label","device","port"} · {"op":"unset_external_port","id"}
- installation only: {"op":"add_location","id"?,"label","kind":"rack"|"area","unitsU"?} · {"op":"update_location",…} · {"op":"remove_location","id"} · {"op":"place_block","id"?,"module","location"?,"rack"?} · {"op":"refresh_block","id"} · {"op":"remove_block","id","cascade"?}`;

export function buildPrompt({ state, ctx, guidelines = '', lang = 'en' }) {
  const kind = state.kind === 'module' ? `the wiring schematic of module "${state.owner}"` : `the installation schematic "${state.owner}"`;
  return `You are the schematic assistant of the FTD.aero Documentation Console, editing ${kind} (version ${state.version} r${state.revision}, ${state.status}).
The schematic is DATA: devices with typed ports, cables between ports, locations (racks and areas), and — for a module — the external ports that leave it. You change it ONLY through operations; the console validates, applies and draws them. You never emit coordinates, sizes or drawing instructions.

${OP_SCHEMA}

RULES:
- Reuse what exists: match devices by label or id ("power strip 1" → pdu-1, "first socket" → out-1, "rack 1" → rack-1). Add a device only when the sentence names one that is not placed yet; take its template from DEVICE TEMPLATES by name or model.
- A device that is a module with a released schematic is placed as a block (place_block), and cables end on its external ports.
- Never invent a template, a port or a module. If the user names a device that is not in the library, say so in "reply" and return no ops for it — the user adds it with its ports first.
- A port takes one cable. Outputs feed inputs. Pick the cable kind that joins the two connectors; name it with "kind" when several fit.
- Give every cable a short label when the user does not ("PWR-03", "NET-12", "AUD-01"), numbered after the existing ones of that kind.
- When a sentence is ambiguous (which socket, which headset), ask in "reply" and return no ops. One clear question beats a guess.
- Answer questions about the schematic from CURRENT STATE; return no ops for a question.
- Reply in ${lang === 'pl' ? 'Polish' : 'English'}, one to three sentences.
${guidelines.trim() ? `\nHOUSE GUIDELINES:\n${guidelines.trim()}\n` : ''}
${describeLibrary(ctx)}

CURRENT STATE:
${describeState(state, ctx)}

Respond with a JSON object: {"reply": "<short answer>", "ops": [ …operations in order… ]} — "ops" empty when nothing changes.`;
}

export function parseOps(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { reply: String(raw || '').slice(0, 2000), ops: [], note: '' };
  }
  const dropped = [];
  const ops = (Array.isArray(parsed.ops) ? parsed.ops : []).filter((o) => {
    const ok = o && typeof o === 'object' && OP_NAMES.includes(o.op);
    if (!ok) dropped.push(o && typeof o === 'object' ? String(o.op) : typeof o);
    return ok;
  });
  return { reply: typeof parsed.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim() : 'Done.', ops, note: dropped.length ? `Ignored unknown operation(s): ${dropped.join(', ')}.` : '' };
}

export async function schematicChat({ state, ctx, messages, guidelines = '', lang = 'en', callModel = ai.callModel }) {
  const sys = buildPrompt({ state, ctx, guidelines, lang });
  const convo = (messages || []).slice(-12).map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') }));
  const raw = await callModel([{ role: 'system', content: sys }, ...convo], { json: true });
  const parsed = parseOps(raw);
  if (!parsed.ops.length) return { ...parsed, validation: null, preview: null };
  try {
    const { state: preview } = applyOps(state, parsed.ops, ctx);
    return { ...parsed, validation: validateSchematic(preview, ctx), preview };
  } catch (e) {
    if (!(e instanceof SchematicError)) throw e;
    return { reply: parsed.reply, ops: [], preview: null, validation: null, note: [parsed.note, `The proposed change was refused: ${e.message}`].filter(Boolean).join(' ') };
  }
}
