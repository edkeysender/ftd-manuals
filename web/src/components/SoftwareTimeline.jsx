import React from 'react';
import { Link } from 'react-router-dom';
import { manualType, compareSwVersions, ownerHref } from '../api.js';
import { t, plural } from '../i18n.jsx';

/** Releases are stamped with a full timestamp; both views want the day. */
const day = (d) => String(d || '').slice(0, 10);
/** "2026-09-14" → "09-14": the release columns are narrow and the year is the same for all of them. */
const shortDate = (d) => day(d).slice(5);
const docLabel = (row) => `${t(manualType(row.manual).short)} ${row.version}`;
/** With rows from several modules (the software page) a doc is only identified with its module. */
const rowLabel = (row) => (row.moduleName ? `${row.moduleName} · ${docLabel(row)}` : docLabel(row));
/** Unique per row: two modules can both have technician:A1.0 on the same timeline. */
const rowKey = (row) => `${row.slug || ''}:${row.key}`;

/**
 * One software's release history against the module's manuals — the picture the Software versions
 * tab is built around: releases left to right, one row per doc version, a bar from the release the
 * version starts at to the release it documents up to (or the open end, "→ latest").
 *
 * `sw` is one entry of the module's `coverage` (see softwareCoverage in server/store.js). On the
 * software page the same shape arrives with rows from several modules — each carries its own `slug`
 * and `moduleName`, which the row label then names — and `head` is off because the page has its own.
 */
export default function SoftwareTimeline({ sw, slug, onConfirm, onNewVersion, onDeleteRelease, busy, head = true }) {
  const releases = sw.releases; // oldest first — the columns of the grid
  const cols = releases.length;
  const colOf = (version) => {
    const i = releases.findIndex((r) => r.version === version);
    return i < 0 ? 0 : i; // unregistered start (an old link) sits in the first column
  };
  // grid: [manual] [one per release] [open end] [status]
  const gridColumns = `minmax(150px, max-content) repeat(${cols || 1}, minmax(64px, 1fr)) minmax(70px, 0.8fr) max-content`;
  const openCol = 2 + cols; // 1-based: column 1 is the manual label
  const statusCol = openCol + 1;

  const rows = sw.manuals;
  const pending = rows.filter((r) => r.needsReviewAgainst);

  const barFor = (row) => {
    const start = 2 + colOf(row.from);
    const end = row.open ? statusCol : 3 + colOf(row.to || row.from);
    const tone = row.needsReviewAgainst ? 'unreviewed' : row.status === 'released' ? 'released' : row.status === 'superseded' ? 'old' : 'draft';
    const label = row.needsReviewAgainst
      ? t('{from} → ? not reviewed against {release}', { from: row.from, release: row.needsReviewAgainst })
      : row.open
        ? t('{from} → latest', { from: row.from })
        : row.from === row.to
          ? row.from
          : `${row.from} → ${row.to}`;
    return { start, end, tone, label };
  };

  return (
    <div className="sw-tl">
      <div className="sw-tl-head">
        {head ? (
          <h3>
            {sw.name} <span className="muted">{t('linked from {version}', { version: sw.fromVersion || '—' })}</span>
          </h3>
        ) : (
          <h3>{t('Coverage')}</h3>
        )}
        <div className="sw-tl-legend">
          <span><i className="lg lg-affecting" />{t('manual-affecting')}</span>
          <span><i className="lg lg-released" />{t('released')}</span>
          <span><i className="lg lg-draft" />{t('draft')}</span>
        </div>
      </div>

      {head && !sw.registered && (
        <p className="hint warn">
          {t('"{name}" was never created on the Software page, so its manuals cannot relate to a software version.', { name: sw.name })}{' '}
          <Link to="/software">{t('Repair it on the Software page')}</Link>
        </p>
      )}

      <div className="sw-grid" style={{ gridTemplateColumns: gridColumns }}>
        <div className="sw-gh sw-gh-manual">{t('MANUAL')}</div>
        {releases.map((r) => (
          <div key={r.version} className={`sw-gh sw-col${r.manualAffecting ? ' affecting' : ''}`} title={r.note || ''}>
            <span className="sw-col-ver">{r.version}{r.manualAffecting && <i className="lg lg-affecting" />}</span>
            <span className="sw-col-date">{shortDate(r.date)}</span>
          </div>
        ))}
        <div className="sw-gh sw-col open">
          <span className="sw-col-ver">{t('latest →')}</span>
          <span className="sw-col-date">{t('open')}</span>
        </div>
        <div className="sw-gh sw-gh-status">{t('STATUS')}</div>

        {rows.map((row) => {
          const bar = barFor(row);
          return (
            <React.Fragment key={`${rowKey(row)}-${row.from}`}>
              <div className="sw-row-label">
                <Link
                  to={`${ownerHref(row.own ? { software: sw.name } : row.slug || slug)}/docs/${row.key}/edit`}
                  title={t('Open {doc}', { doc: rowLabel(row) })}
                >
                  {row.moduleName && <span className="sw-row-mod">{row.moduleName}</span>}
                  <strong>{t(manualType(row.manual).short)}</strong> {row.version}
                </Link>
              </div>
              <div className={`sw-bar sw-bar-${bar.tone}`} style={{ gridColumn: `${bar.start} / ${bar.end}` }}>
                {bar.label}
              </div>
              {!row.open && bar.end < statusCol && (
                <div className="sw-closed" style={{ gridColumn: `${bar.end} / ${statusCol}` }}>
                  {t('closed by {version}', { version: row.closedBy })}
                  {sw.releases.find((r) => r.version === row.closedBy)?.note && (
                    <span className="muted"> ({sw.releases.find((r) => r.version === row.closedBy).note})</span>
                  )}
                </div>
              )}
              <div className={`sw-row-status st-${row.needsReviewAgainst ? 'unreviewed' : row.status}`}>
                {row.hotfix
                  ? t('hotfix r{rev}', { rev: row.revision })
                  : row.needsReviewAgainst
                    ? t('needs review')
                    : row.status === 'draft' || row.status === 'in-review'
                      ? `${t(row.status)} r${row.revision}`
                      : t(row.status)}
              </div>
            </React.Fragment>
          );
        })}
        {!rows.length && <div className="sw-empty muted" style={{ gridColumn: `1 / ${statusCol + 1}` }}>{t('No manuals yet.')}</div>}
      </div>

      {pending.map((row) => (
        <div className="sw-todo" key={`${rowKey(row)}-todo`}>
          <span>
            {t('{release} is manual-affecting and {doc} has not been reviewed against it.', {
              release: row.needsReviewAgainst,
              doc: rowLabel(row),
            })}
          </span>
          <span className="btn-row">
            <button
              className="btn btn-sm"
              disabled={busy}
              title={t('The manual still describes the software correctly — record that it covers {release} too', { release: row.needsReviewAgainst })}
              onClick={() => onConfirm(row, row.needsReviewAgainst)}
            >
              {t('It still applies')}
            </button>
            <button
              className="btn btn-sm btn-primary"
              disabled={busy || row.status !== 'released' || row.hotfix}
              title={
                row.hotfix
                  ? t('Publish or discard the hotfix first')
                  : row.status === 'released'
                    ? t('Start the next version of this manual, documenting {release} onwards', { release: row.needsReviewAgainst })
                    : t('Release the open version first')
              }
              onClick={() => onNewVersion(row, row.needsReviewAgainst)}
            >
              {t('Start next version')}
            </button>
          </span>
        </div>
      ))}

      <div className="sw-rel-title">{t('RELEASES')}</div>
      <div className="sw-rel-list">
        {[...releases].reverse().map((rel) => {
          const opens = rows.filter((r) => r.from === rel.version);
          const closes = rows.filter((r) => r.closedBy === rel.version);
          // a version documents this release when the release is inside its range and an author has
          // seen the manual against it — everything past its review point is still an open question
          const covering = rows.filter(
            (r) =>
              compareSwVersions(r.from, rel.version) <= 0 &&
              (r.open || !r.to || compareSwVersions(r.to, rel.version) >= 0) &&
              (!r.needsReviewAgainst || compareSwVersions(rel.version, r.reviewedTo) <= 0)
          );
          return (
            <div className={`sw-rel${rel.manualAffecting ? ' affecting' : ''}`} key={rel.version}>
              <div className="sw-rel-main">
                <strong>{rel.version}</strong>
                {rel.note && <span className="muted"> — {rel.note}</span>}
              </div>
              <div className="muted sw-rel-date">{day(rel.date)}</div>
              <div>
                {rel.manualAffecting ? <span className="badge badge-missing">{t('Manual-affecting')}</span> : <span className="muted">{t('No')}</span>}
              </div>
              <div className="sw-rel-what muted">
                {rel.version === sw.fromVersion && <div>{t('link start')}</div>}
                {closes.map((r) => (
                  <div key={`c${rowKey(r)}`}>{t('closes {doc}', { doc: rowLabel(r) })}</div>
                ))}
                {opens.map((r) => (
                  <div key={`o${rowKey(r)}`}>{t('opens {doc}', { doc: rowLabel(r) })}</div>
                ))}
                {!closes.length && !opens.length && (
                  <div>{covering.length ? t('covered by {manuals}', { manuals: plural(covering.length, 'manual') }) : t('not covered')}</div>
                )}
              </div>
              {onDeleteRelease && (
                <button
                  className="btn btn-sm btn-danger sw-rel-del"
                  disabled={busy}
                  title={t('Delete release {version} from the feed', { version: rel.version })}
                  aria-label={t('Delete release {version} from the feed', { version: rel.version })}
                  onClick={() => onDeleteRelease(rel)}
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {!releases.length && <div className="muted">{t('No releases registered.')}</div>}
      </div>
    </div>
  );
}
