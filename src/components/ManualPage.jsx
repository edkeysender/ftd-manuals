/**
 * Running header and footer for a generated manual page.
 *
 * Every page of a controlled manual has to identify itself on its own: which device it
 * belongs to, which issue and revision, and which section. On paper that lives in the
 * page header and footer; these components put the same information on the web page and
 * repeat it when the page is printed.
 *
 * resolve.js emits these into every generated page — nothing here is authored by hand.
 * Purely presentational, so it server-renders without touching the DOM.
 */
import React from "react";
import styles from "./ManualPage.module.css";

export function ManualHeader({ manual, serial, issue, revision, chapter, section, effective }) {
  return (
    <header className={styles.header} role="doc-pageheader">
      <div className={styles.headerRow}>
        <span className={styles.docTitle}>{manual}</span>
        <span className={styles.serial}>{serial}</span>
        <span className={styles.issue}>
          Issue {issue} Rev {revision}
        </span>
      </div>
      <div className={styles.headerRow}>
        <span className={styles.chapter}>{chapter}</span>
        <span className={styles.section}>{section}</span>
        <span className={styles.effective}>{effective ? `Effective ${effective}` : "Not yet effective"}</span>
      </div>
    </header>
  );
}

export function ManualFooter({ serial, issue, revision, sectionId, client, uncontrolled }) {
  return (
    <footer className={styles.footer} role="doc-pagefooter">
      <div className={styles.rule} />
      <div className={styles.footerRow}>
        <span>
          <strong>{serial}</strong> · Issue {issue} Rev {revision}
          {sectionId ? <> · section <code>{sectionId}</code></> : null}
        </span>
        <span className={styles.owner}>{client}</span>
      </div>
      {/* Verbatim from the source FCOM, where it is the footer of every page. */}
      <p className={styles.notice}>
        The information contained in this document is proprietary material protected by international law.
        You must not, directly or indirectly, use, disclose, distribute, print, or copy this document or any
        part of it without prior consent of FTD.aero Sp. z o.o.
      </p>
    </footer>
  );
}
