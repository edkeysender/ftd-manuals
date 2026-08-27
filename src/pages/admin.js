/**
 * /admin — editorial dashboard over the generated documentation set.
 *
 * Everything on this page comes from docs/admin.json, written by tools/resolve.js on
 * every build. The page is static: it never calls an API, and every "edit" button is a
 * deep link into GitHub's web editor so a non-technical author can make a change,
 * commit it to a new branch and open a pull request without a local checkout.
 */
import React, { useState } from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import useBaseUrl from "@docusaurus/useBaseUrl";
import admin from "@site/docs/admin.json";
import styles from "./admin.module.css";

const REPO = admin.repo;
const BRANCH = admin.defaultBranch;
const GH = `https://github.com/${REPO}`;

const editUrl = file => `${GH}/edit/${BRANCH}/${file}`;
const viewUrl = file => `${GH}/blob/${BRANCH}/${file}`;
const newFileUrl = (file, content) =>
  `${GH}/new/${BRANCH}?filename=${encodeURIComponent(file)}&value=${encodeURIComponent(content)}`;

/** Skeleton for a new version chunk, pre-filled so the author only replaces the TODOs. */
function draftChunk(component, major) {
  return [
    "---",
    `applies_to: ">=${major}.0.0 <${major + 1}.0.0"`,
    `title: ${component.name}`,
    "summary: TODO(łukasz): one sentence describing what this component does.",
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

export default function Admin() {
  const [tab, setTab] = useState("manuals");
  const t = admin.totals;

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
      <main className={styles.page}>
        <div className={styles.head}>
          <h1>Documentation admin</h1>
          <div className={styles.headMeta}>
            <a href={GH} className={styles.mono}>{REPO}</a>
            <span>resolved {new Date(admin.generatedAt).toISOString().replace("T", " ").slice(0, 16)} UTC</span>
          </div>
        </div>

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
    </Layout>
  );
}

/* ------------------------------------------------------------------ Manuals */

function Manuals() {
  return (
    <div className={styles.section}>
      <div className={styles.hint}>
        Issue and revision numbers are owned by <code>tools/bump.js</code>. A manual shows as{" "}
        <strong>unreleased</strong> when its content changed since the last release; running the release
        workflow on <code>{BRANCH}</code> bumps the revision, stamps the effective date and tags it. A manual
        with a gap or a broken link is never released.
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
            {admin.manuals.map(m => (
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
                    <a className={styles.btn} href={editUrl(m.configPath)}>Edit config</a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {admin.manuals.filter(m => m.gaps.length || m.brokenLinks.length).map(m => (
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
                Fix: {b.fix} · <a href={editUrl(b.from)}>Adjust link</a>
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
  return (
    <div className={styles.section}>
      <div className={styles.hint}>
        “New draft v<em>N</em>” opens GitHub’s editor with a pre-filled chunk. In the commit dialog choose
        <strong> Create a new branch</strong> and name it <code className={styles.mono}>doc/&lt;component-id&gt;-&lt;topic&gt;</code>,
        then open the pull request. Component ids are never renamed, and a new id needs approval from the Support lead.
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
            {admin.components.map(c => (
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
                        <a className={styles.mono} href={editUrl(k.source)}>{k.file}</a>{" "}
                        <span className={styles.mono}>{k.range}</span>{" "}
                        <span className={styles.dim}>{k.hash} · {k.date}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className={styles.mono}>{c.usedBy.length ? c.usedBy.join(", ") : <span className={styles.dim}>none</span>}</td>
                <td>
                  <div className={styles.actions}>
                    <a className={`${styles.btn} ${styles.btnPrimary}`}
                       href={newFileUrl(`components/${c.id}/v${c.nextMajor}.md`, draftChunk(c, c.nextMajor))}>
                      New draft v{c.nextMajor}
                    </a>
                    <a className={styles.btn} href={editUrl(c.configPath)}>Edit identity</a>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {admin.links.undocumented.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Referenced but never authored</h2>
          <p className={styles.dim} style={{ fontSize: "0.85rem" }}>
            Ids that a manual template places on a page but which have no <code>components/&lt;id&gt;/</code> folder.
            They only become a gap once a device has them installed.
          </p>
          {admin.links.undocumented.map(id => (
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
  const { componentIds, sims, cells } = admin.coverage;
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

      {admin.gaps.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Gaps</h2>
          {admin.gaps.map((g, i) => (
            <div key={i} className={styles.finding}>
              <strong>{g.serial}</strong> · <span className={styles.mono}>{g.component}</span> — {g.detail}
              <div className={styles.findingFix}>Fix: {g.fix}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- Links */

function Links() {
  const { edges, orphans } = admin.links;
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
                  <td className={styles.mono}><a href={viewUrl(e.source)}>{e.source}</a></td>
                  <td className={styles.mono}>{e.to}</td>
                  <td>
                    {!e.known
                      ? <span className={`${styles.badge} ${styles.badgeGap}`}>unknown component</span>
                      : e.brokenIn.length
                        ? <span className={`${styles.badge} ${styles.badgeWarn}`}>plain text on {e.brokenIn.map(b => b.sim).join(", ")}</span>
                        : <span className={`${styles.badge} ${styles.badgeOk}`}>resolved</span>}
                  </td>
                  <td><a className={styles.btn} href={editUrl(e.source)}>Adjust link</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {admin.brokenLinks.length > 0 && (
        <div style={{ marginTop: "2rem" }}>
          <h2 style={{ fontSize: "1rem" }}>Unresolved in a manual</h2>
          {admin.brokenLinks.map((b, i) => (
            <div key={i} className={styles.finding}>
              <strong>{b.serial}</strong> · <span className={styles.mono}>{b.from}</span> — {b.detail}
              <div className={styles.findingFix}>Fix: {b.fix} · <a href={editUrl(b.from)}>Adjust link</a></div>
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
