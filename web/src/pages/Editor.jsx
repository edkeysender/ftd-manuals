import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, timeAgo } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../App.jsx';

const AUTO_OUTLINE = [
  { num: '1', title: 'Revision record', auto: true },
  { num: '1.1', title: 'Document revisions', auto: true, sub: true },
  { num: '2', title: 'Introduction', auto: true },
  { num: '3', title: 'General information', auto: true },
];

function stripPending(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('.ai-edit-pending').forEach((el) => el.replaceWith(...el.childNodes));
  return doc.body.innerHTML;
}

export default function Editor() {
  const { slug, version } = useParams();
  const toast = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState(null); // {module, doc, content, generated}
  const [docMeta, setDocMeta] = useState(null);
  const [html, setHtml] = useState('');
  const [mode, setMode] = useState('rich');
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(null); // { original, instruction }
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiStart, setAiStart] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [, forceTick] = useState(0);

  const editorRef = useRef(null);
  const chatRef = useRef(null);
  const fileRef = useRef(null);
  const htmlRef = useRef('');
  htmlRef.current = html;

  const editable = docMeta && (docMeta.status === 'draft' || docMeta.status === 'in-review');

  /* ---------- load ---------- */
  useEffect(() => {
    api
      .doc(slug, version)
      .then((d) => {
        setData(d);
        setDocMeta(d.doc);
        setHtml(d.content);
        setSavedAt(d.doc.updatedAt);
        setMessages([
          {
            role: 'assistant',
            content: `Editing ${d.module.name} · ${d.doc.version} r${d.doc.revision}. Tell me what to change — e.g. "add a grounding check to Installation" — and I will apply it as a pending edit for you to accept.`,
          },
        ]);
      })
      .catch((e) => toast(e.message, 'err'));
  }, [slug, version]);

  // Imperatively fill the contenteditable whenever content is replaced wholesale.
  const setEditorHtml = useCallback((value) => {
    setHtml(value);
    if (editorRef.current) editorRef.current.innerHTML = value;
  }, []);

  useEffect(() => {
    if (data && editorRef.current && mode === 'rich') {
      editorRef.current.innerHTML = htmlRef.current;
    }
  }, [data, mode]);

  /* ---------- autosave ---------- */
  useEffect(() => {
    if (!dirty || !editable) return;
    const t = setTimeout(async () => {
      try {
        setSaving(true);
        const meta = await api.saveContent(slug, version, htmlRef.current, false);
        setDocMeta(meta);
        setSavedAt(new Date().toISOString());
        setDirty(false);
      } catch (e) {
        toast(`Autosave failed: ${e.message}`, 'err');
      } finally {
        setSaving(false);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [dirty, html, editable]);

  useEffect(() => {
    const t = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Keep the chat pinned to the newest message.
  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, aiBusy, attachments]);

  /* ---------- editing ---------- */
  const onInput = () => {
    setHtml(editorRef.current.innerHTML);
    setDirty(true);
  };

  const exec = (cmd, arg = null) => {
    editorRef.current.focus();
    document.execCommand(cmd, false, arg);
    onInput();
  };

  const insertHtml = (snippet) => exec('insertHTML', snippet);

  const TOOLBAR = [
    ['H2', () => exec('formatBlock', '<h2>'), 'Section heading'],
    ['H3', () => exec('formatBlock', '<h3>'), 'Subsection heading'],
    ['B', () => exec('bold'), 'Bold'],
    ['I', () => exec('italic'), 'Italic'],
    [
      'Table',
      () =>
        insertHtml(
          '<table><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p></p>'
        ),
      'Insert table',
    ],
    [
      'Figure',
      () =>
        insertHtml(
          '<figure><img src="assets/TODO.svg" alt="TODO"><figcaption>TODO(author): figure caption</figcaption></figure><p></p>'
        ),
      'Insert figure',
    ],
    [
      '⚠ Warning',
      () =>
        insertHtml(
          '<div class="admonition warning"><p class="admonition-title">Warning</p><p>TODO(author): warning text.</p></div><p></p>'
        ),
      'Insert warning',
    ],
    [
      'ⓘ Note',
      () =>
        insertHtml(
          '<div class="admonition note"><p class="admonition-title">Note</p><p>TODO(author): note text.</p></div><p></p>'
        ),
      'Insert note',
    ],
  ];

  /* ---------- revisions & workflow ---------- */
  async function commitRevision(summary) {
    try {
      setSaving(true);
      const meta = await api.saveContent(slug, version, htmlRef.current, true, summary);
      setDocMeta(meta);
      setSavedAt(new Date().toISOString());
      setDirty(false);
      toast(`Committed r${meta.revision}`);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  async function submitReview() {
    try {
      if (dirty) await api.saveContent(slug, version, htmlRef.current, false);
      const meta = await api.submitReview(slug, version);
      setDocMeta(meta);
      toast(`${version} submitted for review — PR open on ${meta.branch}`);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function release() {
    try {
      const meta = await api.release(slug, version);
      setDocMeta(meta);
      toast(`${version} released — merged to main`);
      navigate(`/modules/${slug}`);
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /* ---------- AI loop ---------- */
  async function addFiles(fileList) {
    const files = [...fileList];
    const read = await Promise.all(
      files.map(
        (f) =>
          new Promise((resolve) => {
            const r = new FileReader();
            r.onload = () => resolve({ name: f.name, type: f.type, size: f.size, dataBase64: String(r.result).split(',')[1] || '' });
            r.onerror = () => resolve(null);
            r.readAsDataURL(f);
          })
      )
    );
    setAttachments((a) => [...a, ...read.filter(Boolean)]);
  }

  async function sendChat() {
    const text = chatInput.trim();
    if ((!text && attachments.length === 0) || aiBusy || pending) return;
    const sent = attachments;
    const label = sent.length ? `${text}${text ? '\n' : ''}📎 ${sent.map((a) => a.name).join(', ')}` : text;
    const next = [...messages, { role: 'user', content: label }];
    setMessages(next);
    setChatInput('');
    setAttachments([]);
    setAiBusy(true);
    setAiStart(Date.now());
    try {
      const res = await api.aiChat({
        slug,
        version,
        messages: [...messages, { role: 'user', content: text || 'See the attached files.' }],
        html: htmlRef.current,
        attachments: sent,
      });
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
      if (res.html) {
        setPending({ original: htmlRef.current, instruction: text || `use ${sent.map((a) => a.name).join(', ')}` });
        setEditorHtml(res.html);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setAiBusy(false);
      setAiStart(null);
    }
  }

  async function acceptAI() {
    const clean = stripPending(htmlRef.current);
    setEditorHtml(clean);
    const instruction = pending.instruction;
    setPending(null);
    await commitRevision(`AI edit: ${instruction}`);
  }

  function discardAI() {
    setEditorHtml(pending.original);
    setPending(null);
    setMessages((m) => [...m, { role: 'assistant', content: 'Edit discarded — the draft is unchanged.' }]);
  }

  /* ---------- outline ---------- */
  const outline = useMemo(() => {
    const items = [...AUTO_OUTLINE];
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    let h2 = 0;
    let h3 = 0;
    doc.body.querySelectorAll('h2, h3').forEach((el) => {
      if (el.tagName === 'H2') {
        h2 += 1;
        h3 = 0;
        items.push({ num: String(h2 + 3), title: el.textContent.trim(), h2Index: h2 - 1 });
      } else {
        h3 += 1;
        items.push({ num: `${h2 + 3}.${h3}`, title: el.textContent.trim(), sub: true });
      }
    });
    return items;
  }, [html]);

  const scrollTo = (item) => {
    if (item.auto) {
      document.querySelector(`.auto-section[data-auto="${item.num.split('.')[0]}"]`)?.scrollIntoView({ behavior: 'smooth' });
    } else if (item.h2Index !== undefined && editorRef.current) {
      editorRef.current.querySelectorAll('h2')[item.h2Index]?.scrollIntoView({ behavior: 'smooth' });
    }
  };

  if (!data || !docMeta) return <div className="page"><div className="empty">Loading…</div></div>;

  const savedLabel = saving ? 'saving…' : dirty ? 'unsaved changes' : `saved ${timeAgo(savedAt)}`;

  return (
    <div className="editor-layout">
      <header className="editor-head">
        <div className="editor-title">
          <Link to={`/modules/${slug}`} className="back">←</Link>
          <strong>{data.module.name}</strong>
          <span className="muted">
            {docMeta.version} r{docMeta.revision}
          </span>
          <StatusBadge status={docMeta.status} />
        </div>
        <div className="editor-actions">
          {editable && (
            <span className="save-indicator">
              {savedLabel}
              {docMeta.branch && <> · branch <code>{docMeta.branch}</code></>}
            </span>
          )}
          {editable && (
            <button
              className="btn btn-sm"
              onClick={() => {
                const s = window.prompt('Revision summary (goes into the revision record):', '');
                if (s !== null) commitRevision(s || 'Content update');
              }}
            >
              Commit revision
            </button>
          )}
          {docMeta.status === 'draft' && (
            <button className="btn btn-primary btn-sm" onClick={submitReview}>
              Submit for review
            </button>
          )}
          {docMeta.status === 'in-review' && (
            <button className="btn btn-primary btn-sm" onClick={release}>
              Approve &amp; release
            </button>
          )}
        </div>
      </header>

      <div className="editor-panes">
        {/* left: outline */}
        <aside className="pane outline">
          <div className="pane-title">Document outline</div>
          <ul>
            {outline.map((item, i) => (
              <li
                key={i}
                className={`${item.sub ? 'sub' : ''} ${item.auto ? 'auto' : ''}`}
                onClick={() => scrollTo(item)}
              >
                <span className="num">{item.num}</span> {item.title}
                {item.auto && !item.sub && <span className="auto-tag">auto</span>}
              </li>
            ))}
          </ul>
        </aside>

        {/* center: document */}
        <section className="pane doc-pane">
          {editable && (
            <div className="toolbar">
              {mode === 'rich' &&
                TOOLBAR.map(([label, fn, title]) => (
                  <button key={label} title={title} onMouseDown={(e) => { e.preventDefault(); fn(); }}>
                    {label}
                  </button>
                ))}
              <div className="toolbar-spacer" />
              <div className="mode-toggle">
                <button className={mode === 'rich' ? 'active' : ''} onClick={() => setMode('rich')}>
                  Rich text
                </button>
                <button
                  className={mode === 'source' ? 'active' : ''}
                  onClick={() => {
                    setHtml(editorRef.current ? editorRef.current.innerHTML : htmlRef.current);
                    setMode('source');
                  }}
                >
                  HTML source
                </button>
              </div>
            </div>
          )}

          {pending && (
            <div className="ai-pending-bar">
              <span>
                <strong>AI EDIT · pending</strong> — “{pending.instruction}”
              </span>
              <span className="btn-row">
                <button className="btn btn-sm btn-primary" onClick={acceptAI}>✓ Accept</button>
                <button className="btn btn-sm" onClick={discardAI}>Discard</button>
              </span>
            </div>
          )}

          <div className="doc-scroll">
            <div className="doc-page">
              <div
                className="generated"
                title="Sections 1–3 are generated from module data and the revision record"
                dangerouslySetInnerHTML={{ __html: data.generated }}
              />
              {mode === 'rich' ? (
                <div
                  ref={editorRef}
                  className="content-edit"
                  contentEditable={editable && !pending}
                  suppressContentEditableWarning
                  onInput={onInput}
                />
              ) : (
                <textarea
                  className="source-edit"
                  value={html}
                  onChange={(e) => {
                    setHtml(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                />
              )}
            </div>
          </div>
        </section>

        {/* right: AI assistant */}
        <aside className="pane ai-pane">
          <div className="pane-title">
            AI assistant <span className="ai-tag">API · MCP enabled</span>
          </div>
          <div className="chat" ref={chatRef}>
            {messages.map((m, i) => (
              <div key={i} className={`msg msg-${m.role}`}>
                {m.content}
              </div>
            ))}
            {aiBusy && (
              <div className="msg msg-assistant thinking">
                <span className="typing">
                  <span /><span /><span />
                </span>
                <span className="thinking-label">
                  working… {aiStart ? Math.round((Date.now() - aiStart) / 1000) : 0}s
                  <span className="thinking-stage"> · fetching sources, drafting, marking pending edits</span>
                </span>
              </div>
            )}
          </div>
          {editable ? (
            <div className="chat-composer">
              {attachments.length > 0 && (
                <div className="attach-chips">
                  {attachments.map((a, i) => (
                    <span className="attach-chip" key={i}>
                      {a.name}
                      <button onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}>✕</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-input">
                <button
                  className="btn btn-sm attach-btn"
                  title="Attach images or text files — images are stored in the module's assets"
                  disabled={aiBusy || !!pending}
                  onClick={() => fileRef.current?.click()}
                >
                  📎
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  hidden
                  accept="image/*,.txt,.md,.html,.csv"
                  onChange={(e) => {
                    addFiles(e.target.files);
                    e.target.value = '';
                  }}
                />
                <textarea
                  value={chatInput}
                  placeholder={
                    pending
                      ? 'Accept or discard the pending edit first'
                      : 'e.g. add a grounding check to 4.1 — paste a URL to source a website, attach photos to embed them'
                  }
                  disabled={aiBusy || !!pending}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendChat();
                    }
                  }}
                />
                <button
                  className="btn btn-primary btn-sm"
                  disabled={aiBusy || !!pending || (!chatInput.trim() && !attachments.length)}
                  onClick={sendChat}
                >
                  Send
                </button>
              </div>
            </div>
          ) : (
            <div className="chat-input muted">Read-only — {docMeta.status} docs cannot be edited.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
