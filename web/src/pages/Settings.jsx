import React, { useEffect, useRef, useState } from 'react';
import { api, readFileAsBase64 } from '../api.js';
import { useToast } from '../App.jsx';

function BrandingCard() {
  const toast = useToast();
  const [version, setVersion] = useState(Date.now());
  const [hasLogo, setHasLogo] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    fetch(`/api/settings/logo?v=${version}`).then((r) => setHasLogo(r.ok)).catch(() => setHasLogo(false));
  }, [version]);

  async function upload(file) {
    try {
      await api.uploadLogo(await readFileAsBase64(file));
      setVersion(Date.now());
      toast('Logo saved — it appears in the header box of every manual');
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  return (
    <section className="settings-card">
      <h2>Branding</h2>
      <p>
        Company logo shown in the header box of assembled manuals (cover and every printed page). Without one, a
        built-in FTD.aero mark is used.
      </p>
      <div className="pair">
        {hasLogo && <img className="logo-thumb" alt="logo" src={`/api/settings/logo?v=${version}`} />}
        <button className="btn" onClick={() => fileRef.current?.click()}>
          {hasLogo ? 'Replace logo…' : 'Upload logo…'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          hidden
          onChange={(e) => {
            if (e.target.files[0]) upload(e.target.files[0]);
            e.target.value = '';
          }}
        />
        <span className="hint">PNG or SVG with transparent background works best.</span>
      </div>
    </section>
  );
}

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

      <BrandingCard />

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
            <p className="muted">
              To test from outside this machine, run <code>npm run tunnel</code> — it prints a public{' '}
              <code>https://….trycloudflare.com</code> URL forwarding to this console (use{' '}
              <code>&lt;that URL&gt;/mcp</code> as the endpoint). While a tunnel is up, anyone with the URL can
              read <em>and edit</em> your docs{mcp.authRequired ? ' (bearer token required — MCP_TOKEN is set)' : ''};
              set <code>MCP_TOKEN=&lt;secret&gt;</code> in <code>.env</code> to require{' '}
              <code>Authorization: Bearer &lt;secret&gt;</code> on MCP calls, and stop the tunnel when done.
            </p>
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
