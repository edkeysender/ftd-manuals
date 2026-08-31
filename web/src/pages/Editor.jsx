import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, readFileAsBase64, timeAgo } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import ChecklistEditor from '../components/ChecklistEditor.jsx';
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

function removePendingBlocks(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  doc.querySelectorAll('.ai-edit-pending').forEach((el) => el.remove());
  return doc.body.innerHTML;
}

const hasPendingMarkers = (html) => /class="[^"]*ai-edit-pending/.test(html || '');

const isImageFile = (f) => (f.type || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(f.name || '');
const escapeAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const figureHtml = (url, alt) =>
  `<figure><img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}"><figcaption>TODO(author): figure caption</figcaption></figure><p></p>`;

/* The pre-edit snapshot survives refreshes in localStorage so Accept/Discard
   still work after a reload. */
const snapshotKey = (slug, version) => `ftd-pending-ai:${slug}:${version}`;
const loadSnapshot = (slug, version) => {
  try {
    return JSON.parse(localStorage.getItem(snapshotKey(slug, version)) || 'null');
  } catch {
    return null;
  }
};
const saveSnapshot = (slug, version, data) => {
  try {
    localStorage.setItem(snapshotKey(slug, version), JSON.stringify(data));
  } catch {}
};
const clearSnapshot = (slug, version) => {
  try {
    localStorage.removeItem(snapshotKey(slug, version));
  } catch {}
};

export default function Editor() {
  const { slug, version } = useParams();
  const toast = useToast();
  const navigate = useNavigate();

  const [data, setData] = useState(null); // {module, doc, content, generated}
  const [docMeta, setDocMeta] = useState(null);
  const [html, setHtml] = useState('');
  const [mode, setMode] = useState('rich');
  const [tab, setTab] = useState('manual'); // 'manual' | 'fat'
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(null); // { original, instruction }
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [busyKind, setBusyKind] = useState('chat'); // 'chat' | 'illustrate'
  const [aiStart, setAiStart] = useState(null);
  const [dropOver, setDropOver] = useState(false);
  const [styleInfo, setStyleInfo] = useState(null); // {exemplars:[…]} — whether style examples exist
  const [attachments, setAttachments] = useState([]);
  const [, forceTick] = useState(0);

  const editorRef = useRef(null);
  const chatRef = useRef(null);
  const fileRef = useRef(null);
  const photoRef = useRef(null);
  const selRef = useRef(null); // last caret position inside the rich editor
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
        const greeting = {
          role: 'assistant',
          content: `Editing ${d.module.name} · ${d.doc.version} r${d.doc.revision}. Tell me what to change — e.g. "add a grounding check to Installation" — and I will apply it as a pending edit for you to accept.`,
        };
        // Recover a pending AI edit that was interrupted (e.g. page refresh).
        if (hasPendingMarkers(d.content)) {
          const snap = loadSnapshot(slug, version);
          setPending({
            original: snap?.original ?? null,
            instruction: snap?.instruction ?? 'recovered AI edit',
            recovered: true,
          });
          setMessages([
            greeting,
            {
              role: 'assistant',
              content:
                'This draft contains a pending AI edit (recovered after the page was reloaded). Review the highlighted blocks and Accept or Discard them above the document.',
            },
          ]);
        } else {
          setMessages([greeting]);
        }
      })
      .catch((e) => toast(e.message, 'err'));
  }, [slug, version]);

  useEffect(() => {
    api.illustrationStyle().then(setStyleInfo).catch(() => {});
  }, []);

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

  // Remember where the caret is so an illustration can be dropped in at that spot
  // even after the user has clicked around the AI pane.
  const rememberSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) {
      selRef.current = sel.getRangeAt(0).cloneRange();
    }
  };

  /** Insert a block at the remembered caret position (or at the end of the body). */
  const insertAtCaret = (snippet) => {
    if (mode !== 'rich' || !editorRef.current) {
      setHtml((h) => `${h.replace(/\s*$/, '')}\n${snippet}\n`);
      setDirty(true);
      return;
    }
    const el = editorRef.current;
    el.focus();
    const sel = window.getSelection();
    let range = selRef.current;
    if (!range || !el.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertHTML', false, snippet);
    onInput();
    rememberSelection();
    el.querySelector('figure:last-of-type')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

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
    if (pending) {
      toast('Accept or discard the pending AI edit first', 'err');
      return;
    }
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

  /* ---------- photo → FTD line-art ---------- */
  const pushMsg = (m) => setMessages((prev) => [...prev, m]);

  /**
   * Convert dropped/pasted photos into house-style line-art. Whatever is typed
   * in the chat box at that moment is used as extra instructions for the
   * drawing (e.g. "number the three latches"). Each result lands in the chat
   * with an Insert button and is also visible to the assistant as an asset.
   */
  async function illustrateFiles(fileList) {
    const files = [...fileList].filter(isImageFile);
    if (!files.length) return toast('Drop an image file (PNG, JPG, WEBP) to convert it to line-art', 'err');
    if (!editable) return toast('Read-only doc — illustrations can only be added to a draft', 'err');
    if (aiBusy) return;
    const instructions = chatInput.trim();
    setChatInput('');
    setAiBusy(true);
    setBusyKind('illustrate');
    setAiStart(Date.now());
    try {
      for (const f of files) {
        pushMsg({ role: 'user', content: `🖼 ${f.name} → FTD line-art${instructions ? `\n${instructions}` : ''}` });
        try {
          const payload = await readFileAsBase64(f);
          const r = await api.illustrate(slug, version, { name: payload.name, dataBase64: payload.dataBase64, instructions });
          pushMsg(illustrationMsg(r, instructions));
        } catch (e) {
          pushMsg({ role: 'assistant', content: `Line-art failed for ${f.name}: ${e.message}` });
        }
      }
    } finally {
      setAiBusy(false);
      setBusyKind('chat');
      setAiStart(null);
    }
  }

  function illustrationMsg(r, instructions) {
    return {
      role: 'assistant',
      content: `Line-art ready: ${r.illustration.url}${r.source ? ` (drawn from ${r.source.name})` : ''}. Insert it into the manual at the cursor, or tell me where it belongs — e.g. "put it in Installation step 2 with a caption".`,
      illustration: { ...r.illustration, v: Date.now() },
      source: r.source,
      instructions,
    };
  }

  /**
   * Iterate on a drawing the way ChatGPT does: the model edits the current
   * illustration (photo attached for geometry) instead of starting over.
   * The edited file keeps its name — the previous version stays in git history.
   */
  async function regenerate(m) {
    if (aiBusy) return;
    const instructions = window.prompt('What should change in this drawing? (e.g. "number the two latches, add an arrow showing the pull direction, remove the hand")', '');
    if (instructions === null) return;
    setAiBusy(true);
    setBusyKind('illustrate');
    setAiStart(Date.now());
    pushMsg({ role: 'user', content: `🖼 edit ${m.illustration.name}${instructions ? `\n${instructions}` : ''}` });
    try {
      const r = await api.illustrate(slug, version, { editOf: m.illustration.name, assetName: m.source?.name, instructions });
      pushMsg(illustrationMsg(r, instructions));
    } catch (e) {
      pushMsg({ role: 'assistant', content: `Line-art failed: ${e.message}` });
    } finally {
      setAiBusy(false);
      setBusyKind('chat');
      setAiStart(null);
    }
  }

  function insertIllustration(m) {
    if (!editable || pending) return toast('Accept or discard the pending AI edit first', 'err');
    if (tab !== 'manual') setTab('manual');
    const alt = m.illustration.name.replace(/\.[a-z0-9]+$/i, '').replace(/-lineart$/, '').replace(/-/g, ' ');
    insertAtCaret(figureHtml(m.illustration.url, alt));
    pushMsg({ role: 'assistant', content: `Inserted ${m.illustration.name} as a figure — edit the caption in the document.` });
  }

  const onPaneDrop = (e) => {
    e.preventDefault();
    setDropOver(false);
    if (e.dataTransfer?.files?.length) illustrateFiles(e.dataTransfer.files);
  };

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
    setBusyKind('chat');
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
        const instruction = text || `use ${sent.map((a) => a.name).join(', ')}`;
        saveSnapshot(slug, version, { original: htmlRef.current, instruction });
        setPending({ original: htmlRef.current, instruction });
        setEditorHtml(res.html);
        setDirty(true); // autosave the marked content so a refresh can recover it
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
    clearSnapshot(slug, version);
    await commitRevision(`AI edit: ${instruction}`);
  }

  function discardAI() {
    if (pending.original != null) {
      setEditorHtml(pending.original);
    } else {
      // Recovered edit with no snapshot: the only safe option is to drop the
      // highlighted blocks (they were inserted or modified by the AI).
      if (
        !confirm(
          'No pre-edit snapshot is available for this recovered edit. Discard will DELETE all highlighted blocks from the draft. Continue?'
        )
      )
        return;
      setEditorHtml(removePendingBlocks(htmlRef.current));
    }
    setPending(null);
    clearSnapshot(slug, version);
    setDirty(true);
    setMessages((m) => [...m, { role: 'assistant', content: 'Edit discarded.' }]);
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
          <div className="mode-toggle doc-tabs">
            <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>Manual</button>
            <button className={tab === 'fat' ? 'active' : ''} onClick={() => setTab('fat')}>
              FAT checklist{data.checklist ? '' : ' (none)'}
            </button>
          </div>
          {editable && tab === 'manual' && (
            <span className="save-indicator">
              {savedLabel}
              {docMeta.branch && <> · branch <code>{docMeta.branch}</code></>}
            </span>
          )}
          {editable && tab === 'manual' && (
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
          {tab === 'fat' && (
            <ChecklistEditor
              slug={slug}
              version={version}
              editable={editable}
              checklist={data.checklist || null}
              onSaved={(r) => {
                setData((d) => ({ ...d, checklist: r.checklist }));
                setDocMeta(r.doc);
              }}
            />
          )}
          {tab === 'manual' && editable && (
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

          {tab === 'manual' && pending && (
            <div className="ai-pending-bar">
              <span>
                <strong>AI EDIT · pending</strong> — “{pending.instruction}”
                {pending.recovered && <em> (recovered after reload)</em>}
              </span>
              <span className="btn-row">
                <button className="btn btn-sm btn-primary" onClick={acceptAI}>✓ Accept</button>
                <button className="btn btn-sm" onClick={discardAI}>Discard</button>
              </span>
            </div>
          )}

          <div className="doc-scroll" style={tab === 'fat' ? { display: 'none' } : undefined}>
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
                  onKeyUp={rememberSelection}
                  onMouseUp={rememberSelection}
                  onBlur={rememberSelection}
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
        <aside
          className={`pane ai-pane ${dropOver ? 'drop-over' : ''}`}
          onDragOver={(e) => {
            if (!editable) return;
            e.preventDefault();
            setDropOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setDropOver(false);
          }}
          onDrop={onPaneDrop}
        >
          <div className="pane-title">
            AI assistant <span className="ai-tag">API · MCP enabled</span>
          </div>
          {dropOver && (
            <div className="drop-veil">
              <strong>Drop photo → FTD line-art</strong>
              <span>Technical Aviation Manual Line-Art · result appears here, ready to insert</span>
            </div>
          )}
          <div className="chat" ref={chatRef}>
            {messages.map((m, i) =>
              m.illustration ? (
                <div key={i} className="msg msg-assistant msg-figure">
                  <a href={m.illustration.url} target="_blank" rel="noreferrer" title="Open full size">
                    <img src={`${m.illustration.url}?v=${m.illustration.v}`} alt={m.illustration.name} />
                  </a>
                  <div className="fig-meta">
                    <code>{m.illustration.name}</code>
                    {m.source && <span className="muted"> · from {m.source.name}</span>}
                  </div>
                  <div className="btn-row">
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!editable || !!pending || aiBusy}
                      title="Insert as a figure at the cursor position in the document"
                      onClick={() => insertIllustration(m)}
                    >
                      Insert into manual
                    </button>
                    <button className="btn btn-sm" disabled={aiBusy || !editable} onClick={() => regenerate(m)} title="Ask for changes — the model edits this drawing rather than starting over">
                      Edit drawing…
                    </button>
                  </div>
                </div>
              ) : (
                <div key={i} className={`msg msg-${m.role}`}>
                  {m.content}
                </div>
              )
            )}
            {aiBusy && (
              <div className="msg msg-assistant thinking">
                <span className="typing">
                  <span /><span /><span />
                </span>
                <span className="thinking-label">
                  {busyKind === 'illustrate' ? 'drawing…' : 'working…'} {aiStart ? Math.round((Date.now() - aiStart) / 1000) : 0}s
                  <span className="thinking-stage">
                    {busyKind === 'illustrate'
                      ? ' · redrawing the photo in Technical Aviation Manual Line-Art (30–90 s)'
                      : ' · fetching sources, drafting, marking pending edits'}
                  </span>
                </span>
              </div>
            )}
          </div>
          {editable ? (
            <div className="chat-composer">
              <button
                className="lineart-strip"
                type="button"
                disabled={aiBusy}
                title="Pick a photo — it is redrawn in the FTD house style and appears here ready to insert"
                onClick={() => photoRef.current?.click()}
              >
                <span className="lineart-icon">✎</span>
                <span>
                  <strong>Photo → FTD line-art</strong>
                  <span className="muted">
                    {' '}— drop, paste or click; type instructions below first to steer the drawing
                    {styleInfo && styleInfo.exemplars.length === 0 && (
                      <> · <Link to="/settings">add style examples in Settings</Link> to match your look</>
                    )}
                  </span>
                </span>
              </button>
              <input
                ref={photoRef}
                type="file"
                multiple
                hidden
                accept="image/png,image/jpeg,image/webp,image/gif"
                onChange={(e) => {
                  illustrateFiles(e.target.files);
                  e.target.value = '';
                }}
              />
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
                  onPaste={(e) => {
                    const imgs = [...(e.clipboardData?.files || [])].filter(isImageFile);
                    if (imgs.length) {
                      e.preventDefault();
                      illustrateFiles(imgs);
                    }
                  }}
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
