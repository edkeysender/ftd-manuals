/**
 * AssistantPanel — the drafting assistant that sits to the right of the chunk editor.
 *
 * What it is: a conversation with an OpenAI model that has been given the chunk being edited,
 * the module's module.yaml and the authoring rules from CLAUDE.md, and is asked to return a
 * complete replacement for the chunk. What it is emphatically not: an agent that edits files.
 *
 * Two rules shape the whole component, because these are controlled aviation documents:
 *
 *   1. Nothing is applied silently. Every proposal arrives as a diff with Accept and Reject.
 *      Rejecting drops it; accepting only replaces the text in the editor above — the file on
 *      disk is untouched until the author presses Save, which goes through the same
 *      PUT /api/file path as a hand-typed edit, so the server still validates it.
 *   2. Nothing is invented. The model is instructed to write "TODO(łukasz): …" wherever a fact
 *      is missing rather than produce a plausible number, and the panel says so where the author
 *      is looking. A proposal is screened by assistantProposal.mjs before it can be accepted;
 *      one that would stop the chunk parsing is refused outright.
 *
 * The panel talks to tools/admin-server.js, which holds the API key. The key never reaches the
 * browser and no request is ever made from here to OpenAI directly.
 */
import React, { useState, useRef, useEffect, useCallback } from "react";
import { screenProposal } from "./assistantProposal.mjs";
import { diffLines, collapse, diffStat } from "./lineDiff.mjs";
import styles from "./AssistantPanel.module.css";

/** How many earlier turns are replayed to the model. Enough to follow a short exchange. */
const HISTORY_TURNS = 8;

const EXAMPLES = [
  "Add a grounding check as the first step of the shutdown procedure.",
  "Turn the second paragraph into a numbered procedure.",
  "Tighten the wording to operating-manual style; change no facts.",
];

let nextId = 1;

/* ------------------------------------------------------------------ diff view */

function Diff({ before, after }) {
  const [full, setFull] = useState(false);
  const rows = diffLines(before, after);
  const stat = diffStat(rows);
  const shown = full ? rows : collapse(rows, 3);
  const collapsed = shown.length !== rows.length;

  return (
    <div className={styles.diff}>
      <div className={styles.diffHead}>
        <span className={styles.diffStat}>
          <span className={styles.statAdd}>+{stat.added}</span>{" "}
          <span className={styles.statDel}>&minus;{stat.removed}</span>
        </span>
        {(collapsed || full) && (
          <button className={styles.linkBtn} onClick={() => setFull(!full)}>
            {full ? "collapse" : "show whole file"}
          </button>
        )}
      </div>
      <div className={styles.diffBody}>
        {shown.map((r, i) =>
          r.type === "gap"
            ? <div key={i} className={styles.diffGap}>⋯ {r.count} unchanged line{r.count === 1 ? "" : "s"}</div>
            : (
              <div key={i} className={`${styles.diffRow} ${styles["diff_" + r.type]}`}>
                <span className={styles.diffNo}>{r.type === "add" ? r.bNo : r.aNo}</span>
                <span className={styles.diffSign}>{r.type === "add" ? "+" : r.type === "del" ? "−" : " "}</span>
                <span className={styles.diffText}>{r.text === "" ? " " : r.text}</span>
              </div>
            )
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- proposal card */

function Proposal({ turn, content, path, onAccept, onReject }) {
  const p = turn.proposal;
  const screening = p.screening || { ok: true, blocking: [], warnings: [] };
  const blocking = screening.blocking || [];
  const warnings = screening.warnings || [];

  if (p.status === "accepted") {
    return (
      <div className={`${styles.verdict} ${styles.verdictOk}`}>
        Applied to the draft above. Nothing is written to disk until you press <strong>Save</strong>.
      </div>
    );
  }
  if (p.status === "rejected") {
    return <div className={styles.verdict}>Rejected. The draft is unchanged.</div>;
  }
  if (p.status === "blocked") {
    return (
      <div className={`${styles.verdict} ${styles.verdictBad}`}>
        Not applied — the draft is unchanged.
        <ul className={styles.reasons}>{p.blockedBy.map((r, i) => <li key={i}>{r}</li>)}</ul>
      </div>
    );
  }

  return (
    <div className={styles.proposal}>
      <Diff before={content} after={p.content} />

      {blocking.length > 0 && (
        <div className={`${styles.verdict} ${styles.verdictBad}`}>
          This proposal cannot be applied:
          <ul className={styles.reasons}>{blocking.map((r, i) => <li key={i}>{r}</li>)}</ul>
        </div>
      )}
      {warnings.map((w, i) => (
        <div key={i} className={`${styles.verdict} ${styles.verdictWarn}`}>{w}</div>
      ))}

      <div className={styles.proposalFoot}>
        <button className={styles.rejectBtn} onClick={() => onReject(turn.id)}>Reject</button>
        <button
          className={styles.acceptBtn}
          disabled={blocking.length > 0}
          onClick={() => onAccept(turn.id)}
          title={blocking.length > 0 ? blocking.join(" ") : "Replace the draft above with this text"}
        >
          Accept into draft
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- panel */

/**
 * api      — the panel's fetch wrapper, passed in so this component knows nothing about routing
 * path     — the chunk being edited, e.g. modules/starting-panel/v2.mdx
 * content  — the live text in the editor; proposals are diffed against exactly this
 * onApply  — hands accepted text back to the editor; it does not write anything to disk
 */
export default function AssistantPanel({ api, path, content, onApply }) {
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState(null);
  const threadRef = useRef(null);

  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  const push = useCallback(turn => setTurns(t => [...t, { id: nextId++, ...turn }]), []);

  const send = useCallback(async () => {
    const instruction = input.trim();
    if (!instruction || busy) return;
    setInput("");
    const history = turns
      .filter(t => t.role === "you" || t.role === "assistant")
      .slice(-HISTORY_TURNS)
      .map(t => ({ role: t.role === "you" ? "user" : "assistant", text: t.text }));
    push({ role: "you", text: instruction });
    setBusy(true);
    try {
      const r = await api("POST", "/api/assistant", { path, content, instruction, history });
      if (r.model) setModel(r.model);
      push({
        role: "assistant",
        text: r.reply || "(the model returned no message)",
        proposal: r.proposal
          ? { content: r.proposal, screening: r.screening, status: "pending" }
          : null,
      });
    } catch (e) {
      push({ role: "error", text: String((e && e.message) || e) });
    } finally {
      setBusy(false);
    }
  }, [api, busy, content, input, path, push, turns]);

  const setStatus = (id, patch) => setTurns(t => t.map(x =>
    x.id === id ? { ...x, proposal: { ...x.proposal, ...patch } } : x));

  const accept = id => {
    const turn = turns.find(t => t.id === id);
    if (!turn || !turn.proposal) return;
    // The gate. Two halves, and a proposal has to clear both:
    //   - what the server found when it produced the proposal, which includes the save-time
    //     validation (a semver applies_to, front matter that is a YAML mapping, a title);
    //   - the chunk parse, re-run here against the text actually in the editor, because the
    //     draft may have moved on since the proposal was made.
    const serverBlocking = (turn.proposal.screening && turn.proposal.screening.blocking) || [];
    const verdict = screenProposal(content, turn.proposal.content, path);
    const blocking = [...new Set([...serverBlocking, ...verdict.blocking])];
    if (blocking.length > 0) {
      setStatus(id, { status: "blocked", blockedBy: blocking });
      return;
    }
    onApply(turn.proposal.content);
    setStatus(id, { status: "accepted" });
  };

  const reject = id => setStatus(id, { status: "rejected" });

  const keyDown = e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <strong>Assistant</strong>
        <span className={styles.headModel}>{model || "OpenAI"}</span>
      </div>

      <div className={styles.charter}>
        Drafting aid only. It is instructed never to invent behaviour, timings, part numbers or
        version ranges, and to write <code>TODO(łukasz):</code> instead. Every proposal is shown as
        a diff and applied only when you accept it — and only to the draft above, never to disk.
      </div>

      <div className={styles.thread} ref={threadRef}>
        {turns.length === 0 && (
          <div className={styles.empty}>
            <p>Ask for a change to this chunk in plain language.</p>
            <ul>
              {EXAMPLES.map(x => (
                <li key={x}>
                  <button className={styles.linkBtn} onClick={() => setInput(x)}>{x}</button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {turns.map(t => (
          <div key={t.id} className={`${styles.turn} ${styles["turn_" + t.role]}`}>
            <div className={styles.bubble}>{t.text}</div>
            {t.proposal && (
              <Proposal turn={t} content={content} path={path} onAccept={accept} onReject={reject} />
            )}
          </div>
        ))}

        {busy && (
          <div className={`${styles.turn} ${styles.turn_assistant}`}>
            <div className={styles.bubble}>Thinking…</div>
          </div>
        )}
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          value={input}
          rows={2}
          placeholder="Ask or instruct…"
          disabled={busy}
          spellCheck={false}
          onChange={e => setInput(e.target.value)}
          onKeyDown={keyDown}
        />
        <button className={styles.send} disabled={busy || input.trim() === ""} onClick={send} title="Send (Enter)">
          {busy ? "…" : "Send"}
        </button>
      </div>
    </div>
  );
}
