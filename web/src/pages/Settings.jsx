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

function IllustrationStyleCard() {
  const toast = useToast();
  const [info, setInfo] = useState(null);
  const [style, setStyle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const exRef = useRef(null);

  const reload = () =>
    api.illustrationStyle().then((s) => {
      setInfo(s);
      setStyle(s.style);
    }).catch((e) => toast(e.message, 'err'));
  useEffect(() => {
    reload();
  }, []);

  async function addExemplars(fileList) {
    const files = [...fileList].filter((f) => /^image\//.test(f.type));
    if (!files.length) return;
    setBusy(true);
    try {
      await api.uploadStyleExemplars(await Promise.all(files.map(readFileAsBase64)));
      toast(`${files.length} style example${files.length === 1 ? '' : 's'} saved — sent to the image model with every photo from now on`);
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function removeExemplar(name) {
    if (!confirm(`Remove style example ${name}?`)) return;
    try {
      await api.deleteStyleExemplar(name);
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function save(text) {
    setSaving(true);
    try {
      await api.saveIllustrationStyle(text);
      const s = await api.illustrationStyle();
      setInfo(s);
      setStyle(s.style);
      setDirty(false);
      toast('Illustration style saved — every photo → line-art conversion now uses it');
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-card">
      <h2>Illustration style{info && <span className="fat-chip">{info.name}</span>}</h2>
      <p>
        The house style every manual illustration is drawn in. It is applied automatically when a photo is dropped
        on the editor's AI pane, when the AI chat or an MCP agent generates a <em>line-art</em> illustration, and by
        the <em>Line-art</em> button on the Assets tab.
        {info?.imageModel && <> Image model <code>{info.imageModel}</code>.</>}
      </p>

      <h3 className="settings-sub">Style examples</h3>
      <p className="muted">
        The most reliable way to get <em>exactly</em> your look: drop 2–4 finished illustrations you already made (e.g.
        in ChatGPT). They are sent to the image model together with every photo as "match this style" references —
        the written definition below only fills the gaps. Best examples: single-view drawings of one device with
        numbered callouts, on a white background.
      </p>
      <div
        className={`dropzone ${drag ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          addExemplars(e.dataTransfer.files);
        }}
      >
        <strong>{busy ? 'Saving…' : 'Drop finished house-style illustrations here'}</strong>
        <span className="muted">
          {' '}— or{' '}
          <label className="link">
            choose files
            <input ref={exRef} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { addExemplars(e.target.files); e.target.value = ''; }} />
          </label>
          . Up to 6, PNG/JPG/WEBP.
        </span>
      </div>
      {info && info.exemplars.length > 0 && (
        <div className="asset-grid exemplar-grid">
          {info.exemplars.map((e) => (
            <div className="asset-card" key={e.name}>
              <img src={`${e.url}?v=${encodeURIComponent(e.name)}`} alt={e.name} loading="lazy" />
              <div className="asset-name">{e.name}</div>
              <button className="btn btn-sm btn-danger" onClick={() => removeExemplar(e.name)}>Remove</button>
            </div>
          ))}
        </div>
      )}
      {info && info.exemplars.length === 0 && (
        <p className="hint">No style examples yet — conversions rely on the written definition alone, which tends to produce multi-panel sheets.</p>
      )}

      <h3 className="settings-sub">Written definition</h3>
      <p className="muted">
        Stored in <code>settings/illustration-style.md</code>{info?.isDefault ? ' (built-in default in use)' : ''}.
      </p>
      <textarea
        className="guidelines-edit"
        value={style}
        spellCheck={false}
        onChange={(e) => {
          setStyle(e.target.value);
          setDirty(true);
        }}
      />
      <div className="btn-row">
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => save(style)}>
          {saving ? 'Saving…' : 'Save style'}
        </button>
        {info && !info.isDefault && (
          <button className="btn" disabled={saving} onClick={() => save('')}>
            Reset to built-in default
          </button>
        )}
        {dirty && <span className="hint">unsaved changes</span>}
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

      <IllustrationStyleCard />

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
