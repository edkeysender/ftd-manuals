import React, { useEffect, useRef, useState } from 'react';
import { api, readFileAsBase64 } from '../api.js';
import { useToast } from '../App.jsx';
import { PasswordCard, UsersCard } from '../components/AccountCards.jsx';
import { t, plural } from '../i18n.jsx';

/** t() for sentences with inline markup: each `{name}` placeholder is replaced by the given React node. */
function tx(text, nodes) {
  return t(text)
    .split(/(\{\w+\})/)
    .map((part, i) => {
      const m = /^\{(\w+)\}$/.exec(part);
      return m && nodes[m[1]] !== undefined ? <React.Fragment key={i}>{nodes[m[1]]}</React.Fragment> : part;
    });
}

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
      toast(t('Logo saved — it appears in the header box of every manual'));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  return (
    <section className="settings-card">
      <h2>{t('Branding')}</h2>
      <p>
        {t('Company logo shown in the header box of assembled manuals (cover and every printed page). Without one, a built-in FTD.aero mark is used.')}
      </p>
      <div className="pair">
        {hasLogo && <img className="logo-thumb" alt={t('logo')} src={`/api/settings/logo?v=${version}`} />}
        <button className="btn" onClick={() => fileRef.current?.click()}>
          {hasLogo ? t('Replace logo…') : t('Upload logo…')}
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
        <span className="hint">{t('PNG or SVG with transparent background works best.')}</span>
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
      toast(t('{count} saved — sent to the image model with every photo from now on', { count: plural(files.length, 'style example') }));
      await reload();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }

  async function removeExemplar(name) {
    if (!confirm(t('Remove style example {name}?', { name }))) return;
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
      toast(t('Illustration style saved — every photo → line-art conversion now uses it'));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="settings-card">
      <h2>{t('Illustration style')}{info && <span className="fat-chip">{info.name}</span>}</h2>
      <p>
        {t('The house style every manual illustration is drawn in.')}{' '}
        {tx("It is applied automatically when a photo is dropped on the editor's AI pane, when the AI chat or an MCP agent generates a {lineArt} illustration, and by the {lineArtButton} button on the Assets tab.", {
          lineArt: <em>{t('line-art')}</em>,
          lineArtButton: <em>{t('Line-art')}</em>,
        })}
        {info?.imageModel && <> {tx('Image model {model}.', { model: <code>{info.imageModel}</code> })}</>}
      </p>

      <h3 className="settings-sub">{t('Style examples')}</h3>
      <p className="muted">
        {tx('The most reliable way to get {exactly} your look: drop 2–4 finished illustrations you already made (e.g. in ChatGPT).', { exactly: <em>{t('exactly')}</em> })}{' '}
        {t('They are sent to the image model together with every photo as "match this style" references — the written definition below only fills the gaps.')}{' '}
        {t('Best examples: single-view drawings of one device with numbered callouts, on a white background.')}
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
        <strong>{busy ? t('Saving…') : t('Drop finished house-style illustrations here')}</strong>
        <span className="muted">
          {' '}
          {tx('— or {chooseFiles}. Up to 6, PNG/JPG/WEBP.', {
            chooseFiles: (
              <label className="link">
                {t('choose files')}
                <input ref={exRef} type="file" multiple accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { addExemplars(e.target.files); e.target.value = ''; }} />
              </label>
            ),
          })}
        </span>
      </div>
      {info && info.exemplars.length > 0 && (
        <div className="asset-grid exemplar-grid">
          {info.exemplars.map((e) => (
            <div className="asset-card" key={e.name}>
              <img src={`${e.url}?v=${encodeURIComponent(e.name)}`} alt={e.name} loading="lazy" />
              <div className="asset-name">{e.name}</div>
              <button className="btn btn-sm btn-danger" onClick={() => removeExemplar(e.name)}>{t('Remove')}</button>
            </div>
          ))}
        </div>
      )}
      {info && info.exemplars.length === 0 && (
        <p className="hint">{t('No style examples yet — conversions rely on the written definition alone, which tends to produce multi-panel sheets.')}</p>
      )}

      <h3 className="settings-sub">{t('Written definition')}</h3>
      <p className="muted">
        {tx('Stored in {file}{suffix}.', {
          file: <code>settings/illustration-style.md</code>,
          suffix: info?.isDefault ? ` ${t('(built-in default in use)')}` : '',
        })}
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
          {saving ? t('Saving…') : t('Save style')}
        </button>
        {info && !info.isDefault && (
          <button className="btn" disabled={saving} onClick={() => save('')}>
            {t('Reset to built-in default')}
          </button>
        )}
        {dirty && <span className="hint">{t('unsaved changes')}</span>}
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
      toast(t('AI agent guidelines saved — they now apply to every AI draft and chat edit'));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Settings')}</h1>
      </div>

      <section className="settings-card">
        <h2>{t('AI agent')}</h2>
        {aiSettings && (
          <p className="muted">
            {tx('Model {model} · reasoning effort {effort} · {status} (set {modelVar} / {effortVar} in {envFile} to change).', {
              model: <code>{aiSettings.model}</code>,
              effort: <code>{aiSettings.reasoningEffort}</code>,
              status: aiSettings.available ? t('API key configured') : t('no API key — assistant disabled'),
              modelVar: <code>OPENAI_MODEL</code>,
              effortVar: <code>OPENAI_REASONING_EFFORT</code>,
              envFile: <code>.env</code>,
            })}
          </p>
        )}
        <p>
          {tx('Basic information and guidelines the AI agent follows in {every} AI first draft and chat edit — company facts, terminology, tone rules, things it must never invent.', { every: <strong>{t('every')}</strong> })}{' '}
          {tx('Stored in the document repository ({file}), so changes are versioned.', { file: <code>settings/ai-guidelines.md</code> })}
        </p>
        <textarea
          className="guidelines-edit"
          value={guidelines}
          placeholder={t('Examples:\n- We are FTD.aero, we build FNPT II flight simulation training devices.\n- Voltage in all sims is 230 V AC / 24 V DC; always warn before opening the rack.\n- Use "flight compartment", never "cockpit", in SIM manuals.\n- Part numbers always in the form FTD-XXXX-YY; never invent one.')}
          onChange={(e) => {
            setGuidelines(e.target.value);
            setDirty(true);
          }}
        />
        <div className="btn-row">
          <button className="btn btn-primary" disabled={!dirty || saving} onClick={save}>
            {saving ? t('Saving…') : t('Save guidelines')}
          </button>
          {dirty && <span className="hint">{t('unsaved changes')}</span>}
        </div>
      </section>

      <IllustrationStyleCard />

      <BrandingCard />

      <UsersCard />

      <PasswordCard />

      <section className="settings-card">
        <h2>{t('MCP connector')}</h2>
        <p>
          {t('External agents (Claude Code, Claude.ai, any MCP client) can create and edit module docs exactly like the UI. Access is authorized with your console account: when the client connects it opens a sign-in page — approve it as an administrator or moderator (viewers cannot connect agents).')}
        </p>
        {mcp ? (
          <>
            <p>
              {tx('Endpoint: {endpoint} · transport {transport}', { endpoint: <code>{mcp.endpoint}</code>, transport: <code>{mcp.transport}</code> })}
            </p>
            <p className="muted">{t('Add it to Claude Code with:')}</p>
            <pre className="code-block">claude mcp add --transport http ftd-docs {mcp.endpoint}</pre>
            <p className="muted">
              {tx('To test from outside this machine, run {cmd} — it prints a public {url} URL forwarding to this console (use {mcpUrl} as the endpoint).', {
                cmd: <code>npm run tunnel</code>,
                url: <code>https://….trycloudflare.com</code>,
                mcpUrl: <code>&lt;that URL&gt;/mcp</code>,
              })}{' '}
              {tx('While a tunnel is up, anyone with the URL can read {andEdit} your docs{auth}; set {tokenVar} in {envFile} to require {header} on MCP calls, and stop the tunnel when done.', {
                andEdit: <em>{t('and edit')}</em>,
                auth: mcp.authRequired ? ` ${t('(bearer token required — MCP_TOKEN is set)')}` : '',
                tokenVar: <code>MCP_TOKEN=&lt;secret&gt;</code>,
                envFile: <code>.env</code>,
                header: <code>Authorization: Bearer &lt;secret&gt;</code>,
              })}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Tool')}</th>
                  <th>{t('Description')}</th>
                </tr>
              </thead>
              <tbody>
                {mcp.tools.map((tool) => (
                  <tr key={tool.name}>
                    <td><code>{tool.name}</code></td>
                    <td>{tool.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : (
          <p className="muted">{t('Loading…')}</p>
        )}
      </section>
    </div>
  );
}
