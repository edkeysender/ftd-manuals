import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, GROUPS, MANUAL_TYPES, manualType, readFileAsBase64, LANGUAGES, language } from '../api.js';
import ModulePicker from '../components/ModulePicker.jsx';
import { useToast } from '../App.jsx';
import { t, plural, locale } from '../i18n.jsx';

export default function ManualView() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(false);
  const [lang, setLang] = useState(() => (LANGUAGES.some((L) => L.code === locale()) ? locale() : 'en')); // follows the console language
  const toast = useToast();
  const navigate = useNavigate();

  const load = useCallback(() => api.manual(slug, lang).then(setData).catch((e) => toast(e.message, 'err')), [slug, lang]);
  const q = lang !== 'en' ? `?lang=${lang}` : '';
  useEffect(() => {
    load();
  }, [load]);

  // In-document anchors (TOC, revision record) must not fight the hash router:
  // intercept them and scroll to the target instead.
  const onDocClick = (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const el = document.getElementById(a.getAttribute('href').slice(1));
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  if (!data) return <div className="page"><div className="empty">{t('Loading…')}</div></div>;
  const { manual, chapters } = data;
  const drafts = chapters.filter((c) => c.isDraft).length;
  const missing = chapters.filter((c) => c.missing).length;
  const untranslated = chapters.filter((c) => c.langFallback).length;

  return (
    <div className="page page-wide">
      <div className="crumbs">
        <Link to="/manuals">{t('Manuals')}</Link> / {manual.name}
      </div>
      <div className="page-head">
        <div>
          <h1>
            {manual.code && <span className="manual-code">{manual.code}</span>} {manual.name}
          </h1>
          <div className="meta-chips">
            {manual.group && <span className="chip">{t((GROUPS.find(([k]) => k === manual.group) || [])[1])}</span>}
            <span className="chip" title={t(manualType(manual.manual).desc)}>
              <span className={`manual-kind ${manualType(manual.manual).kind}`}>{t(manualType(manual.manual).kind)}</span>{' '}
              {t(manualType(manual.manual).label)}
            </span>
            <span className="chip">{plural(chapters.length, 'chapter')}</span>
            {drafts > 0 && <span className="badge badge-in-review">{t('{n} from draft', { n: drafts })}</span>}
            {missing > 0 && <span className="badge badge-missing">{t('{n} without doc', { n: missing })}</span>}
            {untranslated > 0 && (
              <span className="badge badge-draft" title={t('{chapters} shown in English — no {language} translation', { chapters: plural(untranslated, 'chapter'), language: t(language(lang).label) })}>
                {t('{n} in English', { n: untranslated })}
              </span>
            )}
            {drafts === 0 && missing === 0 && chapters.length > 0 && <span className="badge badge-released">{t('All released')}</span>}
          </div>
        </div>
        <div className="btn-row">
          <div className="mode-toggle" title={t('Language of the compiled manual — chapters without a translation fall back to English (flagged)')}>
            {LANGUAGES.map((L) => (
              <button key={L.code} className={lang === L.code ? 'active' : ''} onClick={() => setLang(L.code)}>
                {t(L.short)}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => setEditing(true)}>{t('Edit manual')}</button>
          <a className="btn" href={`/api/manuals/${slug}/export.html${q}`} target="_blank" rel="noreferrer" title={t("Opens the standalone document — use the browser's Print for PDF")}>
            {t('Open / print')}
          </a>
          <a className="btn btn-primary" href={`/api/manuals/${slug}/export.html?download${lang !== 'en' ? `&lang=${lang}` : ''}`}>
            {lang !== 'en' ? t('Export HTML ({lang})', { lang: t(language(lang).short) }) : t('Export HTML')}
          </a>
          <a className="btn" href={`/api/manuals/${slug}/fat.html`} target="_blank" rel="noreferrer" title={t('FAT protocol: the checklists of all modules in this manual as one document')}>
            {t('FAT protocol')}
          </a>
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirm(t('Delete manual "{name}"? Module docs are not affected.', { name: manual.name }))) {
                api.deleteManual(slug).then(() => navigate('/manuals')).catch((e) => toast(e.message, 'err'));
              }
            }}
          >
            {t('Delete')}
          </button>
        </div>
      </div>

      {chapters.length === 0 ? (
        <div className="empty">{t('This manual has no modules yet — click')} <strong>{t('Edit manual')}</strong> {t('to add chapters.')}</div>
      ) : (
        <div className="manual-shell" onClick={onDocClick}>
          <style>{data.css}</style>
          <div className="manual-render" dangerouslySetInnerHTML={{ __html: data.html }} />
        </div>
      )}

      {editing && (
        <EditManual
          manual={manual}
          hasCover={data.hasCover}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            toast(t('Manual updated'));
            load();
          }}
        />
      )}
    </div>
  );
}

function EditManual({ manual, hasCover, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(manual.name);
  const [code, setCode] = useState(manual.code || '');
  const [group, setGroup] = useState(manual.group || '');
  const [type, setType] = useState(manual.manual || 'customer');
  const [modules, setModules] = useState([]);
  const [selected, setSelected] = useState(manual.modules);
  const [cover, setCover] = useState(null); // pending upload
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    api.modules().then(setModules).catch((e) => toast(e.message, 'err'));
  }, []);

  async function save() {
    setBusy(true);
    try {
      await api.updateManual(manual.slug, { name: name.trim(), code: code.trim() || null, group: group || null, manual: type, modules: selected });
      if (cover) await api.uploadManualCover(manual.slug, cover);
      onSaved();
    } catch (e) {
      toast(e.message, 'err');
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-wide">
        <div className="modal-head">
          <h2>{t('Edit manual')}</h2>
          <span className="steps" />
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="form-grid">
            <div className="pair">
              <label style={{ width: 130 }}>
                {t('Short code')}
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="FCOM" />
              </label>
              <label style={{ flex: 1 }}>
                {t('Manual name')}
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('Flight Crew Operating Manual')} />
              </label>
              <label>
                {t('Group')}
                <select value={group} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">{t('— none —')}</option>
                  {GROUPS.map(([k, l]) => (
                    <option key={k} value={k}>{t(l)}</option>
                  ))}
                </select>
              </label>
              <label>
                {t('Type')}
                <select value={type} onChange={(e) => setType(e.target.value)} title={t('Which manual of each module is compiled into this document')}>
                  {MANUAL_TYPES.map((mt) => (
                    <option key={mt.id} value={mt.id}>{t(mt.label)}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="field">
              <span className="field-label">{t('Cover illustration')}</span>
              <div className="pair">
                {(cover || hasCover) && (
                  <img
                    className="cover-thumb"
                    alt={t('cover')}
                    src={cover ? `data:${cover.type};base64,${cover.dataBase64}` : `/api/manuals/${manual.slug}/cover?v=${manual.updatedAt}`}
                  />
                )}
                <button className="btn" onClick={() => fileRef.current?.click()}>
                  {cover ? t('Selected: {name}', { name: cover.name }) : hasCover ? t('Replace image…') : t('Choose image…')}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={async (e) => {
                    if (e.target.files[0]) setCover(await readFileAsBase64(e.target.files[0]));
                    e.target.value = '';
                  }}
                />
                <span className="hint">{t('Shown on the cover page under the header box (e.g. the simulator line-art).')}</span>
              </div>
            </div>
            <div className="field">
              <span className="field-label">{t('Modules — pick and order the chapters ({type} of each)', { type: t(manualType(type).label).toLowerCase() })}</span>
              <ModulePicker modules={modules} selected={selected} onChange={setSelected} manual={type} />
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn btn-primary" disabled={!name.trim() || busy} onClick={save}>
            {busy ? t('Saving…') : t('Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
