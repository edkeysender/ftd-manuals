import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.FTD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ftd-mcp-'));
const { TOOLS } = await import('./mcp.js');
test.after(() => fs.rmSync(process.env.FTD_DATA_DIR, { recursive: true, force: true }));

test('schematic tools are defined with annotations and the op list in the description', () => {
  const names = ['list_installations', 'create_installation', 'list_device_templates', 'create_device_template', 'update_device_template', 'promote_device_to_module', 'get_schematic', 'create_schematic', 'apply_schematic_ops', 'submit_schematic_for_review', 'schematic_back_to_draft', 'release_schematic', 'set_schematic_release_note', 'start_schematic_hotfix', 'discard_schematic', 'render_schematic'];
  for (const n of names) {
    const t = TOOLS.find((x) => x.name === n);
    assert.ok(t, n);
    assert.ok(t.annotations && t.inputSchema, `${n} has annotations and a schema`);
  }
  const apply = TOOLS.find((x) => x.name === 'apply_schematic_ops');
  assert.match(apply.description, /add_device/);
  assert.deepEqual(apply.inputSchema.required, ['slug', 'ops']);
  assert.ok(!TOOLS.find((x) => x.name === 'apply_schematic_ops').inputSchema.properties.manual, 'schematic tools are not doc-scoped');
});
