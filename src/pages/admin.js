/**
 * /admin — editorial dashboard over the generated documentation set.
 *
 * The page reads docs/admin.json, written by tools/resolve.js on every build, so it works
 * as a plain static page. It then looks for the local editing backend
 * (tools/admin-server.js, http://127.0.0.1:3001 by default):
 *
 *   - backend reachable  → "local mode": files are read and written straight to the
 *     working tree, the resolver re-runs after every save, and drafts, commits and
 *     releases are real git operations. This is the mode to use while the repository
 *     has no remote.
 *   - backend absent     → every action falls back to a deep link into GitHub's web
 *     editor, which is what the published site will use once a remote exists.
 *
 * Start the backend with:  node tools/admin-server.js
 */
import React, { useState, useEffect, useCallback, createContext, useContext } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import baked from "@site/docs/admin.json";
import styles from "./admin.module.css";

/* ------------------------------------------------------------------ backend */

const DEFAULT_API = "http://127.0.0.1:3001";

function apiBase() {
  if (typeof window === "undefined") return DEFAULT_API;
  const override = new URLSearchParams(window.location.search).get("api");
  return override || DEFAULT_API;
}

async function api(method, route, body) {
  const res = await fetch(apiBase() + route, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

const Ctx = createContext(null);
const useAdmin = () => useContext(Ctx);

/* -------------------------------------------------------------- GitHub URLs */

const ghUrls = repo => ({
  edit: f => `https://github.com/${repo}/edit/${baked.defaultBranch}/${f}`,
  view: f => `https://github.com/${repo}/blob/${baked.defaultBranch}/${f}`,
  create: (f, c) =>
    `https://github.com/${repo}/new/${baked.defaultBranch}?filename=${encodeURIComponent(f)}&value=${encodeURIComponent(c)}`,
});

/** Skeleton for a new version chunk, pre-filled so the author only replaces the TODOs. */
function draftChunk(component, major) {
  return [
    "---",
    `applies_to: ">=${major}.0.0 <${major + 1}.0.0"`,
    `title: ${JSON.stringify(component.name)}`,
    // Quoted: the value contains ":" and would otherwise be invalid YAML.
    'summary: "TODO(łukasz): one sentence describing what this component does."',
    "---",
    "",
    `TODO(łukasz): describe the behaviour of ${component.name} for software version ${major}.x.`,
    "Keep to what has actually changed since the previous version; do not restate the old chunk.",
    "",
    "## Related",
    "",
    "- TODO(łukasz): link related components as [[component-id]].",
    "",
  ].join("\n");
}

const TABS = [
  { id: "manuals", label: "Manuals" },
  { id: "components", label: "Components" },
  { id: "coverage", label: "Coverage matrix" },
  { id: "links", label: "Links" },
];

/* -------------------------------------------------------------------- shell */

export default function Admin() {
  const [tab, setTab] = useState("manuals");
  const [data, setData] = useState(baked);
  const [git, setGit] = useState(null);
  const [local, setLocal] = useState(false);
  const [probed, setProbed] = useState(false);
  const [editor, setEditor] = useState(null);
  const [flash, setFlash] = useState(null);

  const refresh = useCallback(async () => {
    const st = await api("GET", "/api/state");
    setData(st.admin);
    setGit(st.git);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const h = await api("GET", "/api/health");
        if (cancelled) return;
        setLocal(true);
        setGit(h);
        await refresh();
      } catch {
        if (!cancelled) setLocal(false);
      } finally {
        if (!cancelled) setProbed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  const ctx = {
    data, git, local, refresh, setFlash,
    gh: ghUrls(data.repo),
    openEditor: spec => setEditor(spec),
  };

  const t = data.totals;
  const tiles = [
    { label: "Manuals", value: t.manuals, tab: "manuals" },
    { label: "Components", value: t.components, tab: "components" },
    { label: "Chunks", value: t.chunks, tab: "components" },
    { label: "Gaps", value: t.gaps, tab: "coverage", tone: t.gaps ? "alert" : null },
    { label: "Broken links", value: t.brokenLinks, tab: "links", tone: t.brokenLinks ? "alert" : null },
    { label: "Unreleased changes", value: t.unreleased, tab: "manuals", tone: t.unreleased ? "warn" : null },
  ];

  return (
    <Layout title="Admin" description="Editorial dashboard for the FTD.aero manual set">
      <Ctx.Provider value={ctx}>
        <main className={styles.page}>
          <div className={styles.head}>
            <h1>Documentation admin</h1>
            <div className={styles.headMeta}>
              {probed && (
                <span className={`${styles.badge} ${local ? styles.badgeOk : styles.badgeIdle}`}>
                  {local ? "local mode" : "read only"}
                </span>
              )}
              <span>resolved {new Date(data.generatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC</span>
            </div>
          </div>

          {probed && !local && <OfflineNotice />}
          {local && <GitBar />}
          {flash && <div className={flash.error ? styles.flashError : styles.flashOk}>{flash.text}</div>}

          <div className={styles.tiles}>
            {tiles.map(x => (
              <button
                key={x.label}
                className={[styles.tile, x.tone === "alert" && styles.tileAlert, x.tone === "warn" && styles.tileWarn].filter(Boolean).join(" ")}
                onClick={() => setTab(x.tab)}
              >
                <div className={styles.tileValue}>{x.value}</div>
                <div className={styles.tileLabel}>{x.label}</div>
              </button>
            ))}
          </div>

          <div className={styles.tabs}>
            {TABS.map(x => (
              <button key={x.id} onClick={() => setTab(x.id)} className={[styles.tab, tab === x.id && styles.tabActive].filter(Boolean).join(" ")}>
                {x.label}
              </button>
            ))}
          </div>

          {tab === "manuals" && <Manuals />}
          {tab === "components" && <Components />}
          {tab === "coverage" && <Coverage />}
          {tab === "links" && <Links />}
        </main>

        {editor && <Editor spec={editor} close={() => setEditor(null)} />}
      </Ctx.Provider>
    </Layout>
  );
}

function OfflineNotice() {
  return (
    <div className={styles.hint}>
      The local editing backend is not running, so this page is read only and the buttons below link to
      GitHub instead. To edit files here, run <code>node tools/admin-server.js</code> in the repository and
      reload. (Listening elsewhere? Append <code>?api=http://127.0.0.1:PORT</code> to this URL.)
    </div>
  );
}

/* ------------------------------------------------------------------ git bar */

function GitBar() {
  const { git, refresh, setFlash } = useAdmin();
  const [busy, setBusy] = useState(null);
  if (!git) return null;

  const run = async (name, fn) => {
    setBusy(name);
    setFlash(null);
    try {
      const out = await fn();
      await refresh();
      setFlash({ text: out });
    } catch (e) {
      setFlash({ error: true, text: String(e.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const commit = () => {
    const message = window.prompt("Commit message", "Update documentation");
    if (!message) return;
    run("commit", async () => {
      const r = await api("POST", "/api/git/commit", { message });
      return r.committed ? `Committed on ${r.git.branch}.` : `Nothing to commit (${r.reason}).`;
    });
  };

  const branch = () => {
    const name = window.prompt("New branch name", "doc/");
    if (!name) return;
    run("branch", async () => {
      const r = await api("POST", "/api/git/branch", { name });
      return `Now on ${r.git.branch}.`;
    });
  };

  const release = () => {
    if (!window.confirm("Stamp revisions, commit and tag every releasable manual?")) return;
    run("release", async () => {
      const r = await api("POST", "/api/release");
      return r.released.length
        ? `Released: ${r.released.map(m => `${m.serial} → ${m.to} (${m.tag})`).join("; ")}`
        : "No manual needed a new revision.";
    });
  };

  return (
    <div className={styles.gitBar}>
      <span className={styles.gitBranch}>
        <strong className={styles.mono}>{git.branch}</strong>
        {git.onMain && <span className={`${styles.badge} ${styles.badgeWarn}`}>main</span>}
      </span>

      <span className={styles.dim}>
        {git.dirty.length === 0
          ? "working tree clean"
          : `${git.dirty.length} changed: ${git.dirty.slice(0, 4).map(f => f.path).join(", ")}${git.dirty.length > 4 ? "…" : ""}`}
      </span>

      <select
        className={styles.select}
        value={git.branch}
        onChange={e => run("checkout", async () => {
          const r = await api("POST", "/api/git/checkout", { name: e.target.value });
          return `Switched to ${r.git.branch}.`;
        })}
      >
        {git.branches.map(b => <option key={b} value={b}>{b}</option>)}
      </select>

      <div className={styles.actions}>
        <button className={styles.btn} disabled={!!busy} onClick={branch}>New branch</button>
        <button className={styles.btn} disabled={!!busy || git.dirty.length === 0} onClick={commit}>
          {busy === "commit" ? "Committing…" : "Commit"}
        </button>
        <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={!!busy} onClick={release}>
          {busy === "release" ? "Releasing…" : "Release"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- editor */

/**
 * spec = { path, title, mode: "edit" | "draft", content?, branch?, message? }
 * "edit" saves in place; "draft" creates the branch, writes the file and commits it.
 */
function Editor({ spec, close }) {
  const { refresh, setFlash } = useAdmin();
  const [content, setContent] = useState(spec.content ?? null);
  const [branch, setBranch] = useState(spec.branch || "");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(spec.mode === "edit");

  useEffect(() => {
    if (spec.mode !== "edit") return;
    let cancelled = false;
    api("GET", `/api/file?path=${encodeURIComponent(spec.path)}`)
      .then(r => { if (!cancelled) { setContent(r.content); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e.message || e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [spec.path, spec.mode]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (spec.mode === "draft") {
        const r = await api("POST", "/api/draft", { path: spec.path, content, branch, message: spec.message });
        setFlash({ text: `Draft committed on ${r.branch}: ${r.path}` });
      } else {
        await api("PUT", "/api/file", { path: spec.path, content });
        setFlash({ text: `Saved ${spec.path} and re-resolved.` });
      }
      await refresh();
      close();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop} onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className={styles.drawer}>
        <div className={styles.drawerHead}>
          <div>
            <strong>{spec.title}</strong>
            <div className={`${styles.mono} ${styles.dim}`}>{spec.path}</div>
          </div>
          <button className={styles.btn} onClick={close}>Close</button>
        </div>

        {spec.mode === "draft" && (
          <label className={styles.field}>
            <span>Branch</span>
            <input
              className={`${styles.input} ${styles.mono}`}
              value={branch}
              onChange={e => setBranch(e.target.value)}
              placeholder="doc/component-id-topic"
            />
          </label>
        )}

        {loading
          ? <p className={styles.empty}>Loading…</p>
          : <textarea className={styles.editor} value={content ?? ""} spellCheck={false} onChange={e => setContent(e.target.value)} />}

        {error && <div className={styles.flashError}>{error}</div>}

        <div className={styles.drawerFoot}>
          <span className={styles.dim}>
            {spec.mode === "draft"
              ? "Creates the branch, writes the file and commits it."
              : "Saves to the working tree and re-runs the resolver."}
          </span>
          <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy || loading} onClick={save}>
            {busy ? "Working…" : spec.mode === "draft" ? "Create draft" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One action: opens the local editor when the backend is up, else links to GitHub. */
function Action({ path, title, mode, content, branch, message, label, primary, children }) {
  const { local, openEditor, gh } = useAdmin();
  const cls = `${styles.btn} ${primary ? styles.btnPrimary : ""}`;
  if (local) {
    return (
      <button className={cls} onClick={() => openEditor({ path, title, mode, content, branch, message })}>
        {label || children}
      </button>
    );
  }
  const href = mode === "draft" ? gh.create(path, content) : gh.edit(path);
  return <a className={cls} href={href}>{label || children}</a>;
}

/* ------------------------------------------------------------------ Manuals */

function Manuals() {
  const { data, local } = useAdmin();
  return (
    <div className={styles.section}>
      <div className={styles.hint}>
        Issue and revision numbers are owned by <code>tools/bump.js</code>. A manual shows as{" "}
        <strong>unreleased</strong> when its content changed since the last release.{" "}
        {local
          ? <>Use <strong>Release</strong> above to stamp revisions, commit and tag every releasable manual.</>
          : <>Running the release workflow on <code>{data.defaultBranch}</code> bumps the revision, stamps the effective date and tags it.</>}{" "}
        A manual with a gap or a broken link is never released.
      </div>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Serial</th><th>Client</th><th>Issue.Rev</th><th>Effective</th>
              <th>Pages</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.manuals.map(m => (
              <tr key={m.slug}>
                <td className={styles.nowrap}><strong>{m.serial}</strong><div className={styles.dim}>{m.device_type} · {m.qualification}</div></td>
                <td>{m.client}</td>
                <td className={styles.mono}>{m.issueRev}</td>
                <td className={styles.mono}>{m.effective_date || <span className={styles.dim}>—</span>}</td>
                <td className={styles.mono}>{m.pages}</td>
                <td className={styles.nowrap}>
                  {m.gaps.length > 0 && <span className={`${styles.badge} ${styles.badgeGap}`}>{m.gaps.length} gap</span>}{" "}
                  {m.brokenLinks.length > 0 && <span className={`${styles.badge} ${styles.badgeGap}`}>{m.brokenLinks.length} link</span>}{" "}
                  {m.gaps.length === 0 && m.brokenLinks.length === 0 && (
                    m.unreleased
                      ? <span className={`${styles.badge} ${styles.badgeWarn}`}>unreleased</span>
                      : <span className={`${styles.badge} ${styles.badgeOk}`}>released</span>
                  )}
                </td>
                <td>
                  <div className={styles.actions}>
                    <ManualLink slug={m.slug} />
                    <Action path={m.configPath} title={`${m.serial} — configuration`} mode="edit" label="Edit config" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.manuals.filter(m => m.gaps.length || m.brokenLinks.length).map(m => (
        <div key={m.slug} style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem" }}>{m.serial} — blocking findings</h2>
          {m.gaps.map((g, i) => (
            <div key={`g${i}`} className={styles.finding}>
              <strong className={styles.mono}>{g.component}</strong> — {g.detail}
              <div className={styles.findingFix}>Fix: {g.fix}</div>
            </div>
          ))}
          {m.brokenLinks.map((b, i) => (
            <div key={`b${i}`} className={styles.finding}>
              <strong className={styles.mono}>{b.from}</strong> — {b.detail}
              <div className={styles.findingFix}>
                Fix: {b.fix}{" "}
                <Action path={b.from} title={`Adjust link in ${b.from}`} mode="edit" label="Adjust link" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function ManualLink({ slug }) {
  const to = useBaseUrl(`/manuals/${slug}/`);
  return <Link className={`${styles.btn} ${styles.btnPrimary}`} to={to}>Open manual</Link>;
}

/* --------------------------------------------------------------- Components */

function Components() {
  const { data, local } = useAdmin();
  return (
    <div className={styles.section}>
      <div className={styles.hint}>
        {local
          ? <>“New draft v<em>N</em>” opens a pre-filled chunk. Saving it creates the branch, writes the file
             and commits it in one step. Component ids are never renamed, and a new id needs approval from the Support lead.</>
          : <>“New draft v<em>N</em>” opens GitHub’s editor with a pre-filled chunk. In the commit dialog choose
             <strong> Create a new branch</strong> named <code className={styles.mono}>doc/&lt;component-id&gt;-&lt;topic&gt;</code>,
             then open the pull request.</>}
      </div>

      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Component</th><th>Category</th><th>Location</th>
              <th>Software component</th><th>Chunks</th><th>On devices</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {data.components.map(c => (
              <tr key={c.id}>
                <td className={styles.nowrap}>
                  <strong>{c.name}</strong>
                  {c.optional && <> <span className={`${styles.badge} ${styles.badgeIdle}`}>optional</span></>}
                  <div className={`${styles.mono} ${styles.dim}`}>{c.id}</div>
                </td>
                <td className={styles.dim}>{c.category || "—"}</td>
                <td className={styles.dim}>{c.location || "—"}</td>
                <td className={styles.mono}>{c.software_component || <span className={styles.dim}>—</span>}</td>
                <td>
                  <ul className={styles.chunkList}>
                    {c.chunks.map(k => (
                      <li key={k.file}>
                        <Action path={k.source} title={`${c.name} — ${k.file}`} mode="edit" label={k.file} />{" "}
                        <span className={styles.mono}>{k.range}</span>{" "}
                        <span className={styles.dim}>{k.hash} · {k.date}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={styles.mono}>{c.usedBy.length ? c.usedBy.join(", ") : <span className={styles.dim}>none</span>}</td>
                <td>
                  <div className={styles.actions}>
                    <Action
                      primary
                      mode="draft"
                      path={`components/${c.id}/v${c.nextMajor}.md`}
                      title={`New chunk — ${c.name} v${c.nextMajor}`}
                      content={draftChunk(c, c.nextMajor)}
                      branch={`doc/${c.id}-v${c.nextMajor}`}
                      message={`Draft: ${c.id} v${c.nextMajor}`}
                      label={`New draft v${c.nextMajor}`}
                    />
                    <Action path={c.configPath} title={`${c.name} — identity`} mode="edit" label="Edit identity" />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.links.undocumented.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Referenced but never authored</h2>
          <p className={styles.dim} style={{ fontSize: "0.85rem" }}>
            Ids that a manual template places on a page but which have no <code>components/&lt;id&gt;/</code> folder.
            They only become a gap once a device has them installed.
          </p>
          {data.links.undocumented.map(id => (
            <div key={id} className={styles.finding}>
              <strong className={styles.mono}>{id}</strong> — no component folder
              <div className={styles.findingFix}>
                Fix: create <code>components/{id}/component.yaml</code> and a first chunk (Support lead approves new ids).
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- Coverage */

const CELL = {
  ok: { cls: "cellOk", text: c => `${c.version} → ${c.chunk}` },
  gap: { cls: "cellGap", text: c => `${c.version || "?"} — GAP` },
  "not-installed": { cls: "cellIdle", text: () => "not fitted" },
  "not-in-template": { cls: "cellWarn", text: c => `${c.version || "?"} — not in template` },
  absent: { cls: "cellIdle", text: () => "—" },
};

function Coverage() {
  const { data } = useAdmin();
  const { componentIds, sims, cells } = data.coverage;
  return (
    <div className={styles.section}>
      <h2>Coverage matrix</h2>
      <p>Which chunk covers each component on each device. A red cell means the manual cannot be issued.</p>

      <div className={styles.scroll}>
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th>Component</th>
              {sims.map(s => <th key={s.slug}>{s.serial}</th>)}
            </tr>
          </thead>
          <tbody>
            {componentIds.map(id => (
              <tr key={id}>
                <td className={`${styles.rowHead} ${styles.mono}`}>{id}</td>
                {sims.map(s => {
                  const cell = cells[`${id}|${s.slug}`] || { status: "absent" };
                  const spec = CELL[cell.status] || CELL.absent;
                  return <td key={s.slug} className={styles[spec.cls]}>{spec.text(cell)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.legend}>
        <span><i className={`${styles.swatch} ${styles.cellOk}`} /> documented</span>
        <span><i className={`${styles.swatch} ${styles.cellGap}`} /> gap — no chunk for the installed version</span>
        <span><i className={`${styles.swatch} ${styles.cellWarn}`} /> installed but not placed in the template</span>
        <span><i className={styles.swatch} /> not fitted on this device</span>
      </div>

      {data.gaps.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Gaps</h2>
          {data.gaps.map((g, i) => (
            <GapRow key={i} gap={g} />
          ))}
        </div>
      )}
    </div>
  );
}

/** A gap for a missing chunk can be fixed straight from here. */
function GapRow({ gap }) {
  const { data } = useAdmin();
  const component = data.components.find(c => c.id === gap.component);
  return (
    <div className={styles.finding}>
      <strong>{gap.serial}</strong> · <span className={styles.mono}>{gap.component}</span> — {gap.detail}
      <div className={styles.findingFix}>
        Fix: {gap.fix}{" "}
        {component && gap.kind === "missing-chunk" && (
          <Action
            mode="draft"
            path={`components/${component.id}/v${component.nextMajor}.md`}
            title={`New chunk — ${component.name} v${component.nextMajor}`}
            content={draftChunk(component, component.nextMajor)}
            branch={`doc/${component.id}-v${component.nextMajor}`}
            message={`Draft: ${component.id} v${component.nextMajor}`}
            label={`Write v${component.nextMajor}`}
          />
        )}
        {gap.kind === "missing-version" && (
          <Action path={gap.configPath} title={`${gap.serial} — configuration`} mode="edit" label="Edit config" />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- Links */

function Links() {
  const { data, local, gh } = useAdmin();
  const { edges, orphans } = data.links;
  return (
    <div className={styles.section}>
      <h2>Link graph</h2>
      <p>
        Every <code>[[component-id]]</code> reference found in an authored chunk. A link is only rendered in a
        manual where the target is installed and placed in the template; elsewhere it degrades to plain text.
      </p>

      {edges.length === 0 ? <p className={styles.empty}>No links between chunks yet.</p> : (
        <div className={styles.scroll}>
          <table className={styles.table}>
            <thead>
              <tr><th>From chunk</th><th>Links to</th><th>Status</th><th></th></tr>
            </thead>
            <tbody>
              {edges.map((e, i) => (
                <tr key={i}>
                  <td className={styles.mono}>
                    {local ? e.source : <a href={gh.view(e.source)}>{e.source}</a>}
                  </td>
                  <td className={styles.mono}>{e.to}</td>
                  <td>
                    {!e.known
                      ? <span className={`${styles.badge} ${styles.badgeGap}`}>unknown component</span>
                      : e.brokenIn.length
                        ? <span className={`${styles.badge} ${styles.badgeWarn}`}>plain text on {e.brokenIn.map(b => b.sim).join(", ")}</span>
                        : <span className={`${styles.badge} ${styles.badgeOk}`}>resolved</span>}
                  </td>
                  <td><Action path={e.source} title={`Adjust links in ${e.source}`} mode="edit" label="Adjust link" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.brokenLinks.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Unresolved in a manual</h2>
          {data.brokenLinks.map((b, i) => (
            <div key={i} className={styles.finding}>
              <strong>{b.serial}</strong> · <span className={styles.mono}>{b.from}</span> — {b.detail}
              <div className={styles.findingFix}>
                Fix: {b.fix} <Action path={b.from} title={`Adjust link in ${b.from}`} mode="edit" label="Adjust link" />
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: "2rem" }}>
        <h2 style={{ fontSize: "1rem" }}>Not referenced by any chunk</h2>
        {orphans.length === 0
          ? <p className={styles.empty}>Every component is referenced at least once.</p>
          : <p className={styles.mono}>{orphans.join(", ")}</p>}
      </div>
    </div>
  );
}
