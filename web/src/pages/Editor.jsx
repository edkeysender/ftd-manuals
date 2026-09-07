import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, readFileAsBase64, timeAgo, manualType, LANGUAGES, language } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import ChecklistEditor from '../components/ChecklistEditor.jsx';
import { useToast, useAuth } from '../App.jsx';
import { t, plural, locale } from '../i18n.jsx';

const AUTO_OUTLINE = {
  en: [
    { num: '1', title: 'Revision record', auto: true },
    { num: '1.1', title: 'Document revisions', auto: true, sub: true },
    { num: '2', title: 'Introduction', auto: true },
    { num: '3', title: 'General information', auto: true },
  ],
  pl: [
    { num: '1', title: 'Rejestr zmian', auto: true },
    { num: '1.1', title: 'Wersje dokumentu', auto: true, sub: true },
    { num: '2', title: 'Wprowadzenie', auto: true },
    { num: '3', title: 'Informacje ogólne', auto: true },
  ],
};

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
/** A file the reader downloads from the manual (config, firmware…) — a link chip on its own line. */
const attachmentHtml = (url, name) =>
  `<p><a class="attachment" href="${escapeAttr(url)}" download="${escapeAttr(name)}">${String(name).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</a></p><p></p>`;
/** Caret position under the mouse (drop point). */
const rangeAtPoint = (x, y) => {
  if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
  const p = document.caretPositionFromPoint?.(x, y);
  if (!p) return null;
  const r = document.createRange();
  r.setStart(p.offsetNode, p.offset);
  r.collapse(true);
  return r;
};

/* TODO(author) markers are highlighted with the CSS Custom Highlight API so the
   stored HTML stays untouched — nothing is wrapped, nothing leaks into exports. */
const TODO_RE = /\bTODO(?:\([^)]*\))?:?.*?(?:[.!?;](?=\s|$)|$)/g;
const highlightsSupported = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
function collectTodoRanges(root) {
  const ranges = [];
  if (!root) return ranges;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.nodeValue || '';
    if (!text.includes('TODO')) continue;
    TODO_RE.lastIndex = 0;
    let m;
    while ((m = TODO_RE.exec(text))) {
      if (!m[0]) { TODO_RE.lastIndex++; continue; }
      const r = document.createRange();
      r.setStart(node, m.index);
      r.setEnd(node, m.index + m[0].length);
      ranges.push(r);
    }
  }
  return ranges;
}

/** Clipboard images arrive as "image.png" — give them a unique, meaningful asset name. */
const pastedName = (file, i) => {
  const ext = (file.name.match(/\.[a-z0-9]+$/i) || [])[0] || (file.type === 'image/jpeg' ? '.jpg' : file.type === 'image/webp' ? '.webp' : '.png');
  if (file.name && !/^(image|clipboard|screenshot|pasted)?[-_ ]?\d*\.[a-z0-9]+$/i.test(file.name)) return file.name;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `pasted-${stamp}${i ? `-${i + 1}` : ''}${ext}`;
};

/** Pasted HTML sometimes carries the picture inline as a data: URL — turn those into files. */
async function imagesFromHtml(html) {
  const urls = [...(html || '').matchAll(/<img[^>]+src="(data:image\/[^"]+)"/gi)].map((m) => m[1]);
  const files = [];
  for (const [i, url] of urls.entries()) {
    try {
      const blob = await (await fetch(url)).blob();
      files.push(new File([blob], `image-${i + 1}.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, { type: blob.type }));
    } catch {
      /* ignore unreadable images */
    }
  }
  return files;
}

/* ---------- review comments: anchoring a quote in the rendered page ---------- */

/** Find `quote` in the text of `root` (optionally the occurrence preceded by `before`) and return a Range. */
function findQuoteRange(root, quote, before = '') {
  if (!root || !quote) return null;
  const nodes = [];
  let text = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    nodes.push({ node: n, start: text.length });
    text += n.nodeValue;
  }
  let idx = -1;
  if (before) {
    const ctx = text.indexOf(before + quote);
    if (ctx >= 0) idx = ctx + before.length;
  }
  if (idx < 0) idx = text.indexOf(quote);
  if (idx < 0) {
    // whitespace may have been normalised by the editor — retry with a loose pattern
    const loose = new RegExp(quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
    const m = loose.exec(text);
    if (!m) return null;
    idx = m.index;
    quote = m[0];
  }
  const end = idx + quote.length;
  const locate = (pos) => {
    let i = nodes.findIndex((x, k) => pos < x.start + x.node.nodeValue.length || k === nodes.length - 1);
    if (i < 0) i = nodes.length - 1;
    return [nodes[i].node, Math.max(0, Math.min(pos - nodes[i].start, nodes[i].node.nodeValue.length))];
  };
  const r = document.createRange();
  r.setStart(...locate(idx));
  r.setEnd(...locate(end));
  return r;
}

/** Describe the current selection inside `root`: quote, enclosing <h2> title, context before/after. */
function describeSelection(root) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root || !root.contains(range.commonAncestorContainer)) return null;
  const quote = sel.toString().replace(/\s+/g, ' ').trim();
  if (quote.length < 2) return null;
  let el = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  let section = '';
  // walk backwards through the page for the nearest preceding h2
  const heads = [...root.querySelectorAll('h2')];
  for (const h of heads) {
    if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) section = h.textContent.trim();
  }
  const pre = document.createRange();
  pre.setStart(root, 0);
  pre.setEnd(range.startContainer, range.startOffset);
  const before = pre.toString().replace(/\s+/g, ' ').slice(-40);
  const post = document.createRange();
  post.setStart(range.endContainer, range.endOffset);
  post.setEnd(root, root.childNodes.length);
  const after = post.toString().replace(/\s+/g, ' ').slice(0, 40);
  const rect = range.getBoundingClientRect();
  return { quote: quote.slice(0, 600), section, before, after, rect };
}

const REVIEWER_KEY = 'ftd-reviewer-name';
const reviewerName = () => {
  try {
    return localStorage.getItem(REVIEWER_KEY) || '';
  } catch {
    return '';
  }
};

/* The pre-edit snapshot survives refreshes in localStorage so Accept/Discard
   still work after a reload. */
/* AI chat history survives reloads and navigation — one conversation per doc. */
const chatKey = (slug, version) => `ftd-chat:${slug}:${version}`;
const loadChat = (slug, version) => {
  try {
    const m = JSON.parse(localStorage.getItem(chatKey(slug, version)) || 'null');
    return Array.isArray(m) && m.length ? m : null;
  } catch {
    return null;
  }
};
const saveChat = (slug, version, messages) => {
  try {
    let m = messages.slice(-60);
    while (m.length > 1 && JSON.stringify(m).length > 200000) m = m.slice(1);
    localStorage.setItem(chatKey(slug, version), JSON.stringify(m));
  } catch {}
};
const clearChat = (slug, version) => {
  try {
    localStorage.removeItem(chatKey(slug, version));
  } catch {}
};

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

/**
 * Manual editor. With `review` the same page is the read-only review view other
 * people get: they select text and comment; the author sees the threads in the
 * editor's Comments tab, resolves them, or asks the AI to propose the change.
 */
export default function Editor({ review: reviewProp = false }) {
  const { slug, version } = useParams();
  const toast = useToast();
  const { isAdmin, canEdit } = useAuth();
  const review = reviewProp || !canEdit; // viewers always get the read-only review view
  const navigate = useNavigate();

  // review comments
  const [comments, setComments] = useState([]);
  const [sidePane, setSidePane] = useState(review ? 'comments' : 'ai'); // 'ai' | 'comments'
  const [selInfo, setSelInfo] = useState(null); // current text selection in the page → "Comment" popover
  const [newComment, setNewComment] = useState(null); // anchor being commented on
  const [commentText, setCommentText] = useState('');
  const [activeComment, setActiveComment] = useState(null);
  const [replyTo, setReplyTo] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const [data, setData] = useState(null); // {module, doc, content, generated, lang, languages}
  const [docMeta, setDocMeta] = useState(null);
  const [lang, setLang] = useState(() => (LANGUAGES.some((L) => L.code === locale()) ? locale() : 'en')); // body language shown: follows the console language; en is the source
  const [languages, setLanguages] = useState(null); // {en: {...}, pl: {exists, stale, ...}}
  const [translating, setTranslating] = useState(false);
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
  const [queue, setQueue] = useState([]); // chat messages typed while the assistant was busy — sent in order
  const [busyKind, setBusyKind] = useState('chat'); // 'chat' | 'illustrate'
  const [aiStart, setAiStart] = useState(null);
  const [dropOver, setDropOver] = useState(false);
  const [styleInfo, setStyleInfo] = useState(null); // {exemplars:[…]} — whether style examples exist
  const [attachments, setAttachments] = useState([]);
  const [, forceTick] = useState(0);
  const [todoCount, setTodoCount] = useState(0);

  const editorRef = useRef(null);
  const pageRef = useRef(null); // the whole document page (generated + editable body)
  const todoRangesRef = useRef([]);
  const todoCursorRef = useRef(-1);
  const chatRef = useRef(null);
  const greetingRef = useRef(null); // rebuilt on doc load, used by "New chat"
  const chatDocRef = useRef(null); // which doc the current messages belong to (guards persistence on doc switch)
  const fileRef = useRef(null);
  const photoRef = useRef(null);
  const selRef = useRef(null); // last caret position inside the rich editor
  const htmlRef = useRef('');
  htmlRef.current = html;

  const docOpen = docMeta && (docMeta.status === 'draft' || docMeta.status === 'in-review');
  const editable = docOpen && !review;
  const canComment = !!docOpen; // anyone viewing an open draft may comment
  const openComments = comments.filter((c) => c.status === 'open');

  const loadComments = useCallback(() => api.comments(slug, version).then(setComments).catch(() => setComments([])), [slug, version]);
  useEffect(() => {
    loadComments();
  }, [loadComments]);

  /** Who is commenting — asked once per browser. */
  function whoAmI() {
    let name = reviewerName();
    if (!name) {
      name = (window.prompt(t('Your name (shown on your comments):'), '') || '').trim();
      if (!name) return null;
      try {
        localStorage.setItem(REVIEWER_KEY, name);
      } catch {}
    }
    return name;
  }

  async function submitComment() {
    const name = whoAmI();
    if (!name || !newComment || !commentText.trim()) return;
    try {
      const c = await api.addComment(slug, version, { author: name, text: commentText.trim(), anchor: { ...newComment, lang } });
      setNewComment(null);
      setCommentText('');
      setActiveComment(c.id);
      await loadComments();
      toast(t('Comment added'));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function submitReply(id) {
    const name = whoAmI();
    if (!name || !replyText.trim()) return;
    try {
      await api.replyComment(slug, version, id, { author: name, text: replyText.trim() });
      setReplyTo(null);
      setReplyText('');
      await loadComments();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function setStatus(c, status, note) {
    try {
      await api.setCommentStatus(slug, version, c.id, { status, author: reviewerName() || 'Author', note });
      await loadComments();
      toast(status === 'resolved' ? t('Comment resolved') : t('Comment reopened'));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function removeComment(c) {
    if (!confirm(t('Delete this comment thread?'))) return;
    try {
      await api.deleteComment(slug, version, c.id);
      await loadComments();
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  /** Scroll the page to the quoted text and select it. */
  function jumpToComment(c) {
    setActiveComment(c.id);
    const r = findQuoteRange(pageRef.current, c.anchor?.quote, c.anchor?.before);
    if (!r) return toast(t('The quoted text is no longer in the document'), 'err');
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /** Text selection in the page → floating "Comment" button. */
  function onPageMouseUp() {
    if (!canComment) return;
    setTimeout(() => setSelInfo(describeSelection(pageRef.current)), 0);
  }
  function startComment() {
    if (!selInfo) return;
    setNewComment({ quote: selInfo.quote, section: selInfo.section, before: selInfo.before, after: selInfo.after });
    setCommentText('');
    setSidePane('comments');
    setSelInfo(null);
  }
  useEffect(() => {
    const clear = (e) => {
      if (e.target.closest?.('.comment-fab')) return;
      setSelInfo(null);
    };
    document.addEventListener('mousedown', clear);
    return () => document.removeEventListener('mousedown', clear);
  }, []);
  // Pending-AI snapshots are per language; English keeps the old key so earlier snapshots still recover.
  const snapId = lang === 'en' ? version : `${version}@${lang}`;
  const langInfo = languages ? languages[lang] : null;
  const translationMissing = lang !== 'en' && langInfo && !langInfo.exists;

  /* ---------- load ---------- */
  useEffect(() => {
    api
      .doc(slug, version, lang)
      .then((d) => {
        setData(d);
        setDocMeta(d.doc);
        setLanguages(d.languages || null);
        setHtml(d.content);
        setSavedAt(d.doc.updatedAt);
        setPending(null);
        const L = language(lang);
        const mt = manualType(d.doc.manual);
        const greeting = {
          role: 'assistant',
          content: `${t(
            'Editing the {manual} of {module} · {version} r{rev}{translation} ({audience} audience; sections {sections}). Tell me what to change — e.g. "add a check to {section}" — and I will apply it as a pending edit for you to accept.',
            {
              manual: t(mt.label).toLowerCase(),
              module: d.module.name,
              version: d.doc.version,
              rev: d.doc.revision,
              translation: L.source ? '' : ` · ${t('{language} translation', { language: t(L.label) })}`,
              audience: t(mt.audience),
              sections: mt.sections.map((s) => t(s)).join(', '),
              section: t(mt.sections[1]),
            }
          )} ${
            L.source ? t('Paste a wiki/web page and I take only what belongs in this manual type.') : t('I answer and edit in {language}.', { language: t(L.label) })
          }`,
        };
        greetingRef.current = greeting;
        chatDocRef.current = `${slug}:${version}`;
        const savedChat = loadChat(slug, version);
        // Recover a pending AI edit that was interrupted (e.g. page refresh).
        if (hasPendingMarkers(d.content)) {
          const snap = loadSnapshot(slug, lang === 'en' ? version : `${version}@${lang}`);
          setPending({
            original: snap?.original ?? null,
            instruction: snap?.instruction ?? t('recovered AI edit'),
            commentId: snap?.commentId ?? null,
            recovered: true,
          });
          const note = {
            role: 'assistant',
            content: t(
              'This draft contains a pending AI edit (recovered after the page was reloaded). Review the highlighted blocks and Accept or Discard them above the document.'
            ),
          };
          const base = savedChat || [greeting];
          setMessages(base[base.length - 1]?.content === note.content ? base : [...base, note]);
        } else {
          setMessages(savedChat || [greeting]);
        }
      })
      .catch((e) => toast(e.message, 'err'));
  }, [slug, version, lang]);

  /* Keep the conversation across reloads and navigation — one history per doc. */
  useEffect(() => {
    if (messages.length && chatDocRef.current === `${slug}:${version}`) saveChat(slug, version, messages);
  }, [messages, slug, version]);

  /* ---------- language switch / translation ---------- */
  /** A save in a translation language creates that translation (typed by hand) — reflect it without a reload. */
  function noteLanguageSaved(meta) {
    if (lang === 'en' || !meta?.languages?.[lang]) return;
    setLanguages((l) => ({ ...(l || {}), [lang]: { ...(l?.[lang] || {}), ...meta.languages[lang], code: lang, exists: true, stale: l?.[lang]?.stale || false } }));
  }

  async function switchLang(next) {
    if (next === lang) return;
    if (pending) return toast(t('Accept or discard the pending AI edit first'), 'err');
    try {
      if (dirty && editable) {
        await api.saveContent(slug, version, htmlRef.current, false, '', lang);
        setDirty(false);
      }
      setLang(next);
    } catch (e) {
      toast(t('Could not save before switching: {error}', { error: e.message }), 'err');
    }
  }

  /** AI translation of the English body into the current language (replaces the existing one). */
  async function translate() {
    if (langInfo?.exists && !confirm(t('Replace the current {language} text with a fresh AI translation of the English body?', { language: t(language(lang).label) }))) return;
    setTranslating(true);
    try {
      const d = await api.translate(slug, version, lang);
      setData(d);
      setDocMeta(d.doc);
      setLanguages(d.languages || null);
      setHtml(d.content);
      setDirty(false);
      setSavedAt(d.doc.updatedAt);
      toast(t('{language} translation saved as r{rev} — review it, it is machine-made', { language: t(language(lang).label), rev: d.doc.revision }));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setTranslating(false);
    }
  }

  /** Start the translation by hand: copy the English body into this language. */
  async function copyEnglish() {
    setTranslating(true);
    try {
      const en = await api.doc(slug, version, 'en');
      const d = await api.translate(slug, version, lang, en.content);
      setData(d);
      setDocMeta(d.doc);
      setLanguages(d.languages || null);
      setHtml(d.content);
      setDirty(false);
      toast(t('English copied — translate it in place'));
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setTranslating(false);
    }
  }

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
        const meta = await api.saveContent(slug, version, htmlRef.current, false, "", lang);
        setDocMeta(meta);
        noteLanguageSaved(meta);
        setSavedAt(new Date().toISOString());
        setDirty(false);
      } catch (e) {
        toast(t('Autosave failed: {error}', { error: e.message }), 'err');
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

  /* ---------- TODO markers ---------- */
  useEffect(() => {
    if (!highlightsSupported()) return undefined;
    const ranges = tab === 'manual' && mode === 'rich' ? collectTodoRanges(pageRef.current) : [];
    todoRangesRef.current = ranges;
    if (ranges.length !== todoCount) setTodoCount(ranges.length);
    CSS.highlights.set('todo', new Highlight(...ranges));
    return () => CSS.highlights.delete('todo');
  }, [html, data, mode, tab, pending]);

  /* ---------- review comment highlights ---------- */
  useEffect(() => {
    if (!highlightsSupported()) return undefined;
    const open = tab === 'manual' && mode === 'rich' ? comments.filter((c) => c.status === 'open' && (c.anchor?.lang || 'en') === lang) : [];
    const ranges = [];
    const active = [];
    for (const c of open) {
      const r = findQuoteRange(pageRef.current, c.anchor?.quote, c.anchor?.before);
      if (!r) continue;
      (c.id === activeComment ? active : ranges).push(r);
    }
    CSS.highlights.set('comment', new Highlight(...ranges));
    CSS.highlights.set('comment-active', new Highlight(...active));
    return () => {
      CSS.highlights.delete('comment');
      CSS.highlights.delete('comment-active');
    };
  }, [comments, activeComment, html, data, mode, tab, lang]);

  /** Cycle through the open TODOs, scrolling each into view and selecting it. */
  const jumpToTodo = () => {
    const ranges = todoRangesRef.current;
    if (!ranges.length) return;
    todoCursorRef.current = (todoCursorRef.current + 1) % ranges.length;
    const r = ranges[todoCursorRef.current];
    r.startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r.cloneRange());
    if (editorRef.current?.contains(r.startContainer)) rememberSelection();
  };

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
    ['H2', () => exec('formatBlock', '<h2>'), t('Section heading')],
    ['H3', () => exec('formatBlock', '<h3>'), t('Subsection heading')],
    ['B', () => exec('bold'), t('Bold')],
    ['I', () => exec('italic'), t('Italic')],
    [
      t('Table'),
      () =>
        insertHtml(
          '<table><thead><tr><th>Item</th><th>Value</th></tr></thead><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p></p>'
        ),
      t('Insert table'),
    ],
    [
      t('Figure'),
      () =>
        insertHtml(
          '<figure><img src="assets/TODO.svg" alt="TODO"><figcaption>TODO(author): figure caption</figcaption></figure><p></p>'
        ),
      t('Insert figure'),
    ],
    [
      t('📎 File'),
      () => {
        if (!editable) return;
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.onchange = () => insertFiles(input.files);
        input.click();
      },
      t('Attach a file the reader downloads (ready-to-use configuration, firmware…) — or paste / drop it into the text'),
    ],
    [
      t('⚠ Warning'),
      () =>
        insertHtml(
          '<div class="admonition warning"><p class="admonition-title">Warning</p><p>TODO(author): warning text.</p></div><p></p>'
        ),
      t('Insert warning'),
    ],
    [
      t('ⓘ Note'),
      () =>
        insertHtml(
          '<div class="admonition note"><p class="admonition-title">Note</p><p>TODO(author): note text.</p></div><p></p>'
        ),
      t('Insert note'),
    ],
  ];

  /* ---------- revisions & workflow ---------- */
  async function commitRevision(summary) {
    try {
      setSaving(true);
      const meta = await api.saveContent(slug, version, htmlRef.current, true, summary, lang);
      setDocMeta(meta);
      noteLanguageSaved(meta);
      setSavedAt(new Date().toISOString());
      setDirty(false);
      toast(t('Committed r{rev}', { rev: meta.revision }));
      return meta;
    } catch (e) {
      toast(e.message, 'err');
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function submitReview() {
    if (pending) {
      toast(t('Accept or discard the pending AI edit first'), 'err');
      return;
    }
    try {
      if (dirty) await api.saveContent(slug, version, htmlRef.current, false, "", lang);
      const meta = await api.submitReview(slug, version);
      setDocMeta(meta);
      toast(t('{version} submitted for review — PR open on {branch}', { version, branch: meta.branch }));
    } catch (e) {
      toast(e.message, 'err');
    }
  }

  async function release() {
    try {
      const meta = await api.release(slug, version);
      setDocMeta(meta);
      toast(t('{version} released — merged to main', { version }));
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
    if (!files.length) return toast(t('Drop an image file (PNG, JPG, WEBP) to convert it to line-art'), 'err');
    if (!editable) return toast(t('Read-only doc — illustrations can only be added to a draft'), 'err');
    if (aiBusy) return;
    const instructions = chatInput.trim();
    setChatInput('');
    setAiBusy(true);
    setBusyKind('illustrate');
    setAiStart(Date.now());
    try {
      for (const f of files) {
        pushMsg({ role: 'user', content: `${t('🖼 {file} → FTD line-art', { file: f.name })}${instructions ? `\n${instructions}` : ''}` });
        try {
          const payload = await readFileAsBase64(f);
          const r = await api.illustrate(slug, version, { name: payload.name, dataBase64: payload.dataBase64, instructions });
          pushMsg(illustrationMsg(r, instructions));
        } catch (e) {
          pushMsg({ role: 'assistant', content: t('Line-art failed for {file}: {error}', { file: f.name, error: e.message }) });
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
      content: t('Line-art ready: {url}{source}. Insert it into the manual at the cursor, or tell me where it belongs — e.g. "put it in Installation step 2 with a caption".', {
        url: r.illustration.url,
        source: r.source ? ` (${t('drawn from {file}', { file: r.source.name })})` : '',
      }),
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
    const instructions = window.prompt(t('What should change in this drawing? (e.g. "number the two latches, add an arrow showing the pull direction, remove the hand")'), '');
    if (instructions === null) return;
    setAiBusy(true);
    setBusyKind('illustrate');
    setAiStart(Date.now());
    pushMsg({ role: 'user', content: `${t('🖼 edit {file}', { file: m.illustration.name })}${instructions ? `\n${instructions}` : ''}` });
    try {
      const r = await api.illustrate(slug, version, { editOf: m.illustration.name, assetName: m.source?.name, instructions });
      pushMsg(illustrationMsg(r, instructions));
    } catch (e) {
      pushMsg({ role: 'assistant', content: t('Line-art failed: {error}', { error: e.message }) });
    } finally {
      setAiBusy(false);
      setBusyKind('chat');
      setAiStart(null);
    }
  }

  function insertIllustration(m) {
    if (!editable || pending) return toast(t('Accept or discard the pending AI edit first'), 'err');
    if (tab !== 'manual') setTab('manual');
    const alt = m.illustration.name.replace(/\.[a-z0-9]+$/i, '').replace(/-lineart$/, '').replace(/-/g, ' ');
    insertAtCaret(figureHtml(m.illustration.url, alt));
    pushMsg({ role: 'assistant', content: t('Inserted {file} as a figure — edit the caption in the document.', { file: m.illustration.name }) });
  }

  const onPaneDrop = (e) => {
    e.preventDefault();
    setDropOver(false);
    if (e.dataTransfer?.files?.length) illustrateFiles(e.dataTransfer.files);
  };

  /* ---------- paste images into the document ---------- */
  /**
   * Images pasted into the manual body are stored as assets of this draft and
   * inserted as figures at the caret (photo as-is). Pasting into the AI pane
   * still redraws the photo as line-art — that path is unchanged.
   */
  async function insertImageFiles(fileList) {
    const files = [...fileList].filter(isImageFile);
    if (!files.length) return;
    if (!editable) return toast(t('Read-only doc — images can only be added to a draft'), 'err');
    if (pending) return toast(t('Accept or discard the pending AI edit first'), 'err');
    try {
      setSaving(true);
      const payload = await Promise.all(files.map(async (f, i) => ({ ...(await readFileAsBase64(f)), name: pastedName(f, i) })));
      const saved = await api.uploadAssets(slug, version, payload);
      for (const s of saved) insertAtCaret(figureHtml(s.url, s.name.replace(/\.[a-z0-9]+$/i, '').replace(/-/g, ' ')));
      toast(
        t('{what} added as a figure — edit the caption. To redraw it as FTD line-art, paste it into the AI pane instead.', {
          what: saved.length > 1 ? plural(saved.length, 'image') : t('Image'),
        })
      );
    } catch (e) {
      toast(t('Image paste failed: {error}', { error: e.message }), 'err');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Non-image files pasted or dropped into the body (a ready-to-use configuration,
   * firmware, a spreadsheet) become attachments: stored as they are in the module's
   * assets and linked at the caret as a download — like attaching a file in Confluence.
   */
  async function insertAttachmentFiles(fileList) {
    const files = [...fileList].filter((f) => !isImageFile(f));
    if (!files.length) return;
    if (!editable) return toast(t('Read-only doc — files can only be attached to a draft'), 'err');
    if (pending) return toast(t('Accept or discard the pending AI edit first'), 'err');
    try {
      setSaving(true);
      const payload = await Promise.all(files.map(readFileAsBase64));
      const saved = await api.uploadAssets(slug, version, payload, { attachments: true });
      for (const s of saved) insertAtCaret(attachmentHtml(s.url, s.name));
      toast(t('{what} attached — the reader downloads it from the manual', { what: saved.length > 1 ? plural(saved.length, 'file') : saved[0].name }));
    } catch (e) {
      toast(t('Attachment failed: {error}', { error: e.message }), 'err');
    } finally {
      setSaving(false);
    }
  }

  /** Files pasted / dropped into the body: pictures become figures, everything else an attachment. */
  async function insertFiles(fileList) {
    const files = [...fileList];
    await insertImageFiles(files);
    await insertAttachmentFiles(files);
  }

  const onEditorDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    const r = rangeAtPoint(e.clientX, e.clientY);
    if (r && editorRef.current?.contains(r.commonAncestorContainer)) selRef.current = r;
    insertFiles(e.dataTransfer.files);
  };

  // Links do not navigate inside a contentEditable — open the attachment (a download) explicitly.
  const onEditorClick = (e) => {
    const a = e.target.closest?.('a.attachment');
    if (!a) return;
    e.preventDefault();
    window.open(a.getAttribute('href'), '_blank');
  };

  const onEditorPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...(cd.files || [])];
    const htmlData = cd.getData('text/html');
    if (files.length) {
      e.preventDefault();
      rememberSelection();
      insertFiles(files);
    } else if (/<img[^>]+src="data:image\//i.test(htmlData)) {
      e.preventDefault();
      rememberSelection();
      imagesFromHtml(htmlData).then((imgs) => (imgs.length ? insertImageFiles(imgs) : toast(t('Could not read the pasted image'), 'err')));
    } else if (/<img/i.test(htmlData)) {
      // Remote <img> pasted from a web page: let the browser insert it, then drop the
      // intrinsic width/height/style it carries so the page CSS keeps it inside the column.
      setTimeout(() => {
        editorRef.current?.querySelectorAll('img[width], img[height], img[style]').forEach((img) => {
          ['width', 'height', 'style'].forEach((a) => img.removeAttribute(a));
        });
        onInput();
      }, 0);
    }
  };

  // Ctrl+V with nothing focused (e.g. after clicking the AI pane's "drop, paste or click"
  // strip) used to be swallowed by the browser — route it to the line-art flow.
  useEffect(() => {
    const onWindowPaste = (e) => {
      if (e.defaultPrevented) return;
      const a = document.activeElement;
      const inField = a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
      if (inField) return;
      const imgs = [...(e.clipboardData?.files || [])].filter(isImageFile);
      if (!imgs.length) return;
      e.preventDefault();
      illustrateFiles(imgs);
    };
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
  });

  /** Ask the AI to propose the change a reviewer asked for; the proposal goes through the normal Accept / Discard flow. */
  function askAiForComment(c) {
    if (pending) return toast(t('Accept or discard the pending AI edit first'), 'err');
    const instruction = t('Reviewer comment by {author} on “{quote}” (section {section}): {text} — apply the requested change to that passage.', {
      author: c.author,
      quote: c.anchor?.quote || '',
      section: c.anchor?.section || '—',
      text: c.text,
    });
    setSidePane('ai');
    setActiveComment(c.id);
    sendChat(instruction, c.id);
  }

  /** Send now — or, while the assistant works or an edit awaits accept/discard, queue it; the queue drains in order. */
  function sendChat(overrideText, commentId = null) {
    const text = typeof overrideText === 'string' ? overrideText.trim() : chatInput.trim();
    if (!text && attachments.length === 0) return;
    const item = { text, attachments, commentId };
    setChatInput('');
    setAttachments([]);
    if (aiBusy || pending) {
      setQueue((q) => [...q, item]);
      return;
    }
    runChat(item);
  }

  useEffect(() => {
    if (aiBusy || pending || !queue.length) return;
    const [next, ...rest] = queue;
    setQueue(rest);
    runChat(next);
  }, [aiBusy, pending, queue]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runChat({ text, attachments: sent, commentId }) {
    const label = sent.length ? `${text}${text ? '\n' : ''}📎 ${sent.map((a) => a.name).join(', ')}` : text;
    const next = [...messages, { role: 'user', content: label }];
    setMessages(next);
    setAiBusy(true);
    setBusyKind('chat');
    setAiStart(Date.now());
    try {
      const res = await api.aiChat({
        slug,
        version,
        lang,
        messages: [...messages, { role: 'user', content: text || 'See the attached files.' }],
        html: htmlRef.current,
        attachments: sent,
      });
      setMessages((m) => [...m, { role: 'assistant', content: res.reply }]);
      if (res.generated) {
        // The model changed module data (software relation) — sections 1–3 were re-rendered server-side.
        setData((d) => (d ? { ...d, generated: res.generated, module: res.module || d.module } : d));
        if (res.doc) setDocMeta(res.doc);
      }
      if (res.html) {
        const instruction = text || t('use {files}', { files: sent.map((a) => a.name).join(', ') });
        saveSnapshot(slug, snapId, { original: htmlRef.current, instruction, commentId });
        setPending({ original: htmlRef.current, instruction, commentId });
        setEditorHtml(res.html);
        setDirty(true); // autosave the marked content so a refresh can recover it
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: t('Error: {error}', { error: e.message }) }]);
    } finally {
      setAiBusy(false);
      setAiStart(null);
    }
  }

  async function acceptAI() {
    const clean = stripPending(htmlRef.current);
    setEditorHtml(clean);
    const { instruction, commentId } = pending;
    setPending(null);
    clearSnapshot(slug, snapId);
    const meta = await commitRevision(`AI edit: ${instruction}`);
    // An accepted proposal for a reviewer comment closes the thread with a note.
    if (commentId && meta) {
      try {
        await api.setCommentStatus(slug, version, commentId, {
          status: 'resolved',
          author: reviewerName() || 'Author',
          revision: meta.revision,
          note: t('Change proposed by the AI and accepted by the author in r{rev}.', { rev: meta.revision }),
        });
        await loadComments();
      } catch (e) {
        toast(e.message, 'err');
      }
    }
  }

  function discardAI() {
    if (pending.original != null) {
      setEditorHtml(pending.original);
    } else {
      // Recovered edit with no snapshot: the only safe option is to drop the
      // highlighted blocks (they were inserted or modified by the AI).
      if (
        !confirm(
          t('No pre-edit snapshot is available for this recovered edit. Discard will DELETE all highlighted blocks from the draft. Continue?')
        )
      )
        return;
      setEditorHtml(removePendingBlocks(htmlRef.current));
    }
    setPending(null);
    clearSnapshot(slug, snapId);
    setDirty(true);
    setMessages((m) => [...m, { role: 'assistant', content: t('Edit discarded.') }]);
  }

  /* ---------- outline ---------- */
  const outline = useMemo(() => {
    const items = [...(AUTO_OUTLINE[lang] || AUTO_OUTLINE.en)];
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

  if (!data || !docMeta) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;

  const savedLabel = saving ? t('saving…') : dirty ? t('unsaved changes') : t('saved {when}', { when: timeAgo(savedAt) });

  return (
    <div className="editor-layout">
      <header className="editor-head">
        <div className="editor-title">
          <Link to={`/modules/${slug}`} className="back">←</Link>
          <strong>{data.module.name}</strong>
          <span className={`manual-tag ${docMeta.manual || 'customer'}`} title={t(manualType(docMeta.manual).desc)}>
            {t(manualType(docMeta.manual).label)}
          </span>
          <span className="muted">
            {docMeta.version} r{docMeta.revision}
          </span>
          <StatusBadge status={docMeta.status} />
          {review && <span className="review-tag" title={t('Read-only review view — select text to comment')}>{t('Review')}</span>}
        </div>
        <div className="editor-actions">
          {editable && (
            <button
              className="btn btn-sm"
              title={t('Copy a link reviewers use to read this draft and comment on it')}
              onClick={() => {
                const url = `${window.location.origin}${window.location.pathname}#/modules/${slug}/docs/${version}/review`;
                navigator.clipboard?.writeText(url);
                toast(t('Review link copied'));
              }}
            >
              🔗 {t('Review link')}
            </button>
          )}
          <div className="mode-toggle doc-tabs">
            <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>{t('Manual')}</button>
            <button className={tab === 'fat' ? 'active' : ''} onClick={() => setTab('fat')}>
              {data.checklist ? t('FAT checklist') : t('FAT checklist (none)')}
            </button>
          </div>
          {tab === 'manual' && (
            <div className="mode-toggle doc-tabs lang-toggle" title={t('Body language — English is the source, other languages are translations')}>
              {LANGUAGES.map((L) => {
                const info = languages?.[L.code];
                const flag = L.source ? null : !info?.exists ? 'missing' : info.stale ? 'stale' : null;
                return (
                  <button
                    key={L.code}
                    className={lang === L.code ? 'active' : ''}
                    onClick={() => switchLang(L.code)}
                    title={L.source ? t('English — source text') : flag === 'missing' ? t('{language} — not translated yet', { language: t(L.label) }) : flag === 'stale' ? t('{language} — English changed since this translation', { language: t(L.label) }) : t('{language} translation', { language: t(L.label) })}
                  >
                    {L.short}
                    {flag && <span className={`lang-dot ${flag}`} />}
                  </button>
                );
              })}
            </div>
          )}
          {editable && tab === 'manual' && (
            <span className="save-indicator">
              {savedLabel}
              {docMeta.branch && <> · {t('branch')} <code>{docMeta.branch}</code></>}
            </span>
          )}
          {editable && tab === 'manual' && (
            <button
              className="btn btn-sm"
              onClick={() => {
                const s = window.prompt(t('Revision summary (goes into the revision record):'), '');
                if (s !== null) commitRevision(s || 'Content update');
              }}
            >
              {t('Commit revision')}
            </button>
          )}
          {!review && docMeta.status === 'draft' && (
            <button className="btn btn-primary btn-sm" onClick={submitReview}>
              {t('Submit for review')}
            </button>
          )}
          {!review && docMeta.status === 'in-review' && (
            <button className="btn btn-primary btn-sm" onClick={release}>
              {t('Approve & release')}
            </button>
          )}
        </div>
      </header>

      {selInfo && canComment && (
        <button
          className="comment-fab"
          style={{ top: Math.max(8, selInfo.rect.top - 38), left: Math.max(8, selInfo.rect.left + selInfo.rect.width / 2 - 50) }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={startComment}
        >
          💬 {t('Comment')}
        </button>
      )}

      <div className="editor-panes">
        {/* left: outline */}
        <aside className="pane outline">
          <div className="pane-title">{t('Document outline')}</div>
          <ul>
            {outline.map((item, i) => (
              <li
                key={i}
                className={`${item.sub ? 'sub' : ''} ${item.auto ? 'auto' : ''}`}
                onClick={() => scrollTo(item)}
              >
                <span className="num">{item.num}</span> {item.title}
                {item.auto && !item.sub && <span className="auto-tag">{t('auto')}</span>}
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
              {mode === 'rich' && todoCount > 0 && (
                <button className="todo-chip" title={t('Jump to the next open TODO(author) marker')} onMouseDown={(e) => { e.preventDefault(); jumpToTodo(); }}>
                  {plural(todoCount, 'TODO')} ↓
                </button>
              )}
              <div className="mode-toggle">
                <button className={mode === 'rich' ? 'active' : ''} onClick={() => setMode('rich')}>
                  {t('Rich text')}
                </button>
                <button
                  className={mode === 'source' ? 'active' : ''}
                  onClick={() => {
                    setHtml(editorRef.current ? editorRef.current.innerHTML : htmlRef.current);
                    setMode('source');
                  }}
                >
                  {t('HTML source')}
                </button>
              </div>
            </div>
          )}

          {tab === 'manual' && pending && (
            <div className="ai-pending-bar">
              <span>
                <strong>{t('AI EDIT · pending')}</strong> — “{pending.instruction}”
                {pending.recovered && <em> ({t('recovered after reload')})</em>}
              </span>
              <span className="btn-row">
                <button className="btn btn-sm btn-primary" onClick={acceptAI}>✓ {t('Accept')}</button>
                <button className="btn btn-sm" onClick={discardAI}>{t('Discard')}</button>
              </span>
            </div>
          )}

          {tab === 'manual' && translationMissing && (
            <div className="lang-banner">
              <span>
                <strong>{t(language(lang).label)}</strong>{' — '}
                {t('no translation yet. Translate the English body with the AI, copy it as a starting point, or simply start writing here — the text is saved as the {language} version.', {
                  language: t(language(lang).label),
                })}
              </span>
              {editable && (
                <span className="btn-row">
                  <button className="btn btn-primary btn-sm" disabled={translating} onClick={translate}>
                    {translating ? t('Translating…') : t('Translate with AI')}
                  </button>
                  <button className="btn btn-sm" disabled={translating} onClick={copyEnglish}>
                    {t('Copy English')}
                  </button>
                </span>
              )}
            </div>
          )}
          {tab === 'manual' && lang !== 'en' && langInfo?.exists && (
            <div className={`lang-banner ${langInfo.stale ? 'stale' : ''}`}>
              <span>
                <strong>{t(language(lang).label)}</strong>
                {langInfo.stale
                  ? ` — ${t('the English body changed since this translation (made from r{from}, now r{now}). Re-translate, or bring the changes over by hand.', {
                      from: langInfo.basedOnRevision,
                      now: docMeta.revision,
                    })}`
                  : ` — ${
                      langInfo.edited
                        ? t('translation {by}, edited, based on English r{rev}.', { by: langInfo.source === 'ai' ? t('by AI') : t('by hand'), rev: langInfo.basedOnRevision })
                        : t('translation {by}, based on English r{rev}.', { by: langInfo.source === 'ai' ? t('by AI') : t('by hand'), rev: langInfo.basedOnRevision })
                    }`}
              </span>
              {editable && (
                <button className="btn btn-sm" disabled={translating} onClick={translate} title={t('Translate the English body again with the AI (replaces this text)')}>
                  {translating ? t('Translating…') : langInfo.stale ? t('Re-translate with AI') : t('Translate again')}
                </button>
              )}
            </div>
          )}
          <div className="doc-scroll" style={tab === 'fat' ? { display: 'none' } : undefined} onMouseUp={onPageMouseUp}>
            <div className="doc-page" ref={pageRef}>
              <div
                className="generated"
                title={t('Sections 1–3 are generated from module data and the revision record')}
                dangerouslySetInnerHTML={{ __html: data.generated }}
              />
              {mode === 'rich' ? (
                <div
                  ref={editorRef}
                  className="content-edit"
                  contentEditable={editable && !pending}
                  suppressContentEditableWarning
                  onInput={onInput}
                  onPaste={onEditorPaste}
                  onDragOver={(e) => {
                    if (editable && e.dataTransfer?.types?.includes('Files')) e.preventDefault();
                  }}
                  onDrop={onEditorDrop}
                  onClick={onEditorClick}
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
          <div className="pane-title side-tabs">
            {!review && (
              <button className={sidePane === 'ai' ? 'active' : ''} onClick={() => setSidePane('ai')}>
                {t('AI assistant')}
              </button>
            )}
            <button className={sidePane === 'comments' ? 'active' : ''} onClick={() => setSidePane('comments')}>
              {t('Comments')}
              {openComments.length > 0 && <span className="count-pill">{openComments.length}</span>}
            </button>
            {sidePane === 'ai' && <span className="ai-tag">{t('API · MCP enabled')}</span>}
            {sidePane === 'ai' && !review && messages.length > 1 && (
              <button
                className="btn-icon"
                style={{ marginLeft: 'auto' }}
                title={t('New chat — clears this conversation (it is kept per doc across reloads)')}
                onClick={() => {
                  clearChat(slug, version);
                  setMessages(greetingRef.current ? [greetingRef.current] : []);
                }}
              >
                ↺
              </button>
            )}
          </div>
          {sidePane === 'comments' && (
            <div className="comments-pane">
              {newComment && (
                <div className="comment-card new">
                  <div className="comment-quote" title={newComment.section}>“{newComment.quote}”</div>
                  {newComment.section && <div className="muted small">{t('in section')} {newComment.section}</div>}
                  <textarea
                    autoFocus
                    rows={3}
                    placeholder={t('What should change here?')}
                    value={commentText}
                    onChange={(e) => setCommentText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitComment();
                      if (e.key === 'Escape') setNewComment(null);
                    }}
                  />
                  <div className="btn-row">
                    <button className="btn btn-primary btn-sm" disabled={!commentText.trim()} onClick={submitComment}>
                      {t('Add comment')}
                    </button>
                    <button className="btn btn-sm" onClick={() => setNewComment(null)}>{t('Cancel')}</button>
                  </div>
                </div>
              )}
              {!newComment && canComment && (
                <div className="hint comments-hint">{t('Select text in the document and click Comment to start a thread.')}</div>
              )}
              {comments.filter((c) => c.status === 'open' || showResolved).length === 0 && !newComment && (
                <div className="muted small comments-empty">{t('No open comments.')}</div>
              )}
              {comments
                .filter((c) => c.status === 'open' || showResolved)
                .map((c) => (
                  <div key={c.id} className={`comment-card ${c.status} ${activeComment === c.id ? 'active' : ''}`} onClick={() => setActiveComment(c.id)}>
                    <div className="comment-head">
                      <strong>{c.author}</strong>
                      <span className="muted small">{timeAgo(c.createdAt)}</span>
                      {(c.anchor?.lang || 'en') !== lang && <span className="chip">{(c.anchor?.lang || 'en').toUpperCase()}</span>}
                      {c.status === 'resolved' && <span className="badge badge-released">{t('Resolved')}{c.resolvedIn ? ` · ${c.resolvedIn}` : ''}</span>}
                    </div>
                    <button className="comment-quote" title={t('Show in document')} onClick={() => jumpToComment(c)}>
                      “{c.anchor?.quote}”
                    </button>
                    <div className="comment-text">{c.text}</div>
                    {c.replies?.map((r) => (
                      <div key={r.id} className="comment-reply">
                        <strong>{r.author}</strong> <span className="muted small">{timeAgo(r.createdAt)}</span>
                        <div>{r.text}</div>
                      </div>
                    ))}
                    {replyTo === c.id ? (
                      <div className="comment-replybox">
                        <textarea
                          autoFocus
                          rows={2}
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReply(c.id);
                            if (e.key === 'Escape') setReplyTo(null);
                          }}
                        />
                        <div className="btn-row">
                          <button className="btn btn-primary btn-sm" disabled={!replyText.trim()} onClick={() => submitReply(c.id)}>{t('Reply')}</button>
                          <button className="btn btn-sm" onClick={() => setReplyTo(null)}>{t('Cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      <div className="btn-row comment-actions">
                        {canComment && (
                          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setReplyTo(c.id); setReplyText(''); }}>{t('Reply')}</button>
                        )}
                        {editable && c.status === 'open' && (
                          <button className="btn btn-sm btn-primary" title={t('The AI proposes the change; you review it as a pending edit and accept or discard it')} onClick={(e) => { e.stopPropagation(); askAiForComment(c); }}>
                            ✨ {t('Ask AI to propose')}
                          </button>
                        )}
                        {editable && c.status === 'open' && (
                          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setStatus(c, 'resolved'); }}>{t('Resolve')}</button>
                        )}
                        {editable && c.status === 'resolved' && (
                          <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setStatus(c, 'open'); }}>{t('Reopen')}</button>
                        )}
                        {editable && isAdmin && (
                          <button className="btn-icon" title={t('Delete thread')} onClick={(e) => { e.stopPropagation(); removeComment(c); }}>✕</button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              {comments.some((c) => c.status === 'resolved') && (
                <button className="link comments-toggle" onClick={() => setShowResolved(!showResolved)}>
                  {showResolved ? t('Hide resolved') : t('Show {n} resolved', { n: comments.filter((c) => c.status === 'resolved').length })}
                </button>
              )}
            </div>
          )}
          {dropOver && sidePane === 'ai' && (
            <div className="drop-veil">
              <strong>{t('Drop photo → FTD line-art')}</strong>
              <span>{t('Technical Aviation Manual Line-Art · result appears here, ready to insert')}</span>
            </div>
          )}
          <div className="chat" ref={chatRef} style={sidePane === 'ai' ? undefined : { display: 'none' }}>
            {messages.map((m, i) =>
              m.illustration ? (
                <div key={i} className="msg msg-assistant msg-figure">
                  <a href={m.illustration.url} target="_blank" rel="noreferrer" title={t('Open full size')}>
                    <img src={`${m.illustration.url}?v=${m.illustration.v}`} alt={m.illustration.name} />
                  </a>
                  <div className="fig-meta">
                    <code>{m.illustration.name}</code>
                    {m.source && <span className="muted"> · {t('from {file}', { file: m.source.name })}</span>}
                  </div>
                  <div className="btn-row">
                    <button
                      className="btn btn-sm btn-primary"
                      disabled={!editable || !!pending || aiBusy}
                      title={t('Insert as a figure at the cursor position in the document')}
                      onClick={() => insertIllustration(m)}
                    >
                      {t('Insert into manual')}
                    </button>
                    <button className="btn btn-sm" disabled={aiBusy || !editable} onClick={() => regenerate(m)} title={t('Ask for changes — the model edits this drawing rather than starting over')}>
                      {t('Edit drawing…')}
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
                  {busyKind === 'illustrate' ? t('drawing…') : t('working…')} {aiStart ? Math.round((Date.now() - aiStart) / 1000) : 0}s
                  <span className="thinking-stage">
                    {busyKind === 'illustrate'
                      ? ` · ${t('redrawing the photo in Technical Aviation Manual Line-Art (30–90 s)')}`
                      : ` · ${t('fetching sources, drafting, marking pending edits')}`}
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
                title={t('Pick a photo — it is redrawn in the FTD house style and appears here ready to insert')}
                onClick={() => photoRef.current?.click()}
              >
                <span className="lineart-icon">✎</span>
                <span>
                  <strong>{t('Photo → FTD line-art')}</strong>
                  <span className="muted">
                    {' — '}{t('drop, paste or click; type instructions below first to steer the drawing')}
                    {styleInfo && styleInfo.exemplars.length === 0 && (
                      <> · <Link to="/settings">{t('add style examples in Settings')}</Link> {t('to match your look')}</>
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
              {queue.length > 0 && (
                <div className="attach-chips queue-chips">
                  {queue.map((q, i) => (
                    <span key={i} className="attach-chip queued" title={q.text}>
                      <span className="muted">{i + 1}.</span>{' '}
                      {(q.text || t('attachments only')).slice(0, 60)}
                      {q.attachments.length ? ` 📎${q.attachments.length}` : ''}
                      <button title={t('Remove from queue')} onClick={() => setQueue((qq) => qq.filter((_, j) => j !== i))}>✕</button>
                    </span>
                  ))}
                </div>
              )}
              <div className="chat-input">
                <Dictate onText={(text) => setChatInput((v) => (v ? v.replace(/\s*$/, ' ') : '') + text)} />
                <button
                  className="btn btn-sm attach-btn"
                  title={t("Attach images or text files — images are stored in the module's assets")}
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
                      ? t('Accept or discard the pending edit — the next instruction waits in the queue meanwhile')
                      : aiBusy
                        ? t('Type the next instruction — it is sent as soon as this one finishes')
                        : t('e.g. add a grounding check to 4.1 — paste a URL to source a website, paste or attach pictures to use them')
                  }
                  onChange={(e) => setChatInput(e.target.value)}
                  onPaste={(e) => {
                    // A pasted picture becomes an attachment of the next message (the assistant
                    // then describes / places / redraws it as asked) — not a line-art job by itself.
                    const imgs = [...(e.clipboardData?.files || [])].filter(isImageFile);
                    if (imgs.length) {
                      e.preventDefault();
                      const stamp = Date.now();
                      addFiles(
                        imgs.map((f, i) => {
                          const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
                          const generic = !f.name || /^image\.\w+$/i.test(f.name);
                          return generic ? new File([f], `pasted-${stamp}${i ? `-${i + 1}` : ''}.${ext}`, { type: f.type }) : f;
                        })
                      );
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
                  disabled={!chatInput.trim() && !attachments.length}
                  title={aiBusy || pending ? t('Queued — sent when the assistant is free') : ''}
                  onClick={() => sendChat()}
                >
                  {aiBusy || pending ? t('Queue') : t('Send')}
                </button>
              </div>
            </div>
          ) : sidePane === 'ai' ? (
            <div className="chat-input muted">{t('Read-only — {status} docs cannot be edited.', { status: t(docMeta.status) })}</div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}


/**
 * Dictation for the chat box: records a clip in the browser and has the server turn it
 * into text (OpenAI transcription). Works anywhere getUserMedia does, iOS Safari included,
 * which needs a secure context — the tunnel URL, not a plain http:// address.
 *
 * On iOS the system keyboard's own microphone also types straight into the box; this
 * button exists so the same gesture works on every device and in the Polish UI.
 */
function Dictate({ onText }) {
  const toast = useToast();
  const [state, setState] = useState('idle'); // idle | recording | working
  const rec = useRef(null);

  const supported =
    typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  if (!supported) return null;

  async function start() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Safari records audio/mp4; Chrome and Firefox webm. Send the extension that matches.
      const mime = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = mr.mimeType || mime || 'audio/webm';
        const blob = new Blob(chunks, { type });
        if (blob.size < 1200) return setState('idle'); // a tap, not speech
        setState('working');
        try {
          const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const { dataBase64, name } = await readFileAsBase64(new File([blob], `speech.${ext}`, { type }));
          const { text } = await api.transcribe({ dataBase64, name, lang: locale() });
          if (text) onText(text);
          else toast(t('Nothing was recognised — try again closer to the microphone'), 'err');
        } catch (e) {
          toast(e.message, 'err');
        }
        setState('idle');
      };
      rec.current = mr;
      mr.start();
      setState('recording');
    } catch (e) {
      toast(
        /denied|NotAllowed/i.test(e.name + e.message)
          ? t('Microphone access was refused — allow it for this site in the browser settings')
          : e.message,
        'err'
      );
      setState('idle');
    }
  }

  function stop() {
    try { rec.current?.stop(); } catch {}
  }

  return (
    <button
      className={`btn btn-sm mic-btn${state === 'recording' ? ' recording' : ''}`}
      disabled={state === 'working'}
      title={state === 'recording' ? t('Stop and insert the text') : t('Dictate — speak instead of typing')}
      onClick={() => (state === 'recording' ? stop() : start())}
    >
      {state === 'working' ? '…' : state === 'recording' ? '⏹' : '🎤'}
    </button>
  );
}

