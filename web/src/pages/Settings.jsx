import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../App.jsx';

export default function Settings() {
  const toast = useToast();
  const [aiSettings, setAiSettings] = useState(null);
  const [guidelines, setGuidelines] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mcp, setMcp] = useState(null);

  useEffect(() => {
    api.aiSettings().then((s) => {
      setAiSettings(s);
      setGuidelines(s.guidelines);
    }).catch((e) => toast(e.message, 'err'));
    api.mcpInfo().then(setMcp).catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.saveAiSettings(guidelines);
      setDirty(false);
      toast('AI agent guidelines saved — they now apply to every AI draft and chat edit');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Settings</h1>
      </div>

      <section className="settings-card">
        <h2>AI agent</h2>
        {aiSettings && (
          <p className="muted">
            Model <code>{aiSettings.model}</code> · reasoning effort <code>{aiSettings.reasoningEffort}</code> ·{' '}
            {aiSettings.available ? 'API key configured' : 'no API key — assistant disabled'} (set{' '}
            <code>OPENAI_MODEL</code> / <code>OPENAI_REASONING_EFFORT</code> in <code>.env</code> to change).
          </p>
        )}
        <p>
          Basic information and guidelines the AI agent follows in <strong>every</strong> AI first draft and chat
          edit — company facts, terminology, tone rules, things it must never invent. Stored in the document
          repository (<code>settings/ai-guidelines.md</code>), so changes are versioned.
        </p>
        <textarea
          className="guidelines-edit"
          value={guidelines}
          placeholder={`Examples:\n- We are FTD.aero, we build FNPT II flight simulation training devices.\n- Voltage in all sims is 230 V AC / 24 V DC; always warn before opening the rack.\n- Use "flight compartment", never "cockpit", in SIM manuals.\n- Part numbers always in the form FTD-XXXX-YY; never invent one.`}
          onChange={(e) => {
            setGuidelines(e.target.value);
            setDirty(true);
          }}
        />
        <div className="btn-row">
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save guidelines'}
          </button>
          {dirty && <span className="hint">unsaved changes</span>}
        </div>
      </section>

      <section className="settings-card">
        <h2>MCP connector</h2>
        <p>
          External agents (Claude Code, Claude.ai, any MCP client) can create and edit module docs exactly like
          the UI — search, read, edit, upload photos, create modules, submit and release.
        </p>
        {mcp ? (
          <>
            <p>
              Endpoint: <code>{mcp.endpoint}</code> · transport <code>{mcp.transport}</code>
            </p>
            <p className="muted">Add it to Claude Code with:</p>
            <pre className="code-block">claude mcp add --transport http ftd-docs {mcp.endpoint}</pre>
            <table className="table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {mcp.tools.map((t) => (
                  <tr key={t.name}>
                    <td><code>{t.name}</code></td>
                    <td>{t.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    </div>
  );
}
