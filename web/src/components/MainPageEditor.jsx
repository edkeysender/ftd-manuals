import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { t } from '../i18n.jsx';
import { useToast } from '../App.jsx';

const normalize = (html) => String(html || '').replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim();

/**
 * The doc's main page — its title page when the doc is exported on its own — edited in place above
 * the revision record. Saved a second after typing stops (and on leaving the block); a page left at
 * its default is not stored, so the default keeps following the template. {{doc.version}},
 * {{doc.revision}} and {{doc.date}} are filled in when the page is printed.
 */
export default function MainPageEditor({ slug, version, lang, mainPage, mainPageDefault, editable }) {
  const toast = useToast();
  const ref = useRef(null);
  const timer = useRef(null);
  const [custom, setCustom] = useState(!!mainPage);
  const [state, setState] = useState('');

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = mainPage || mainPageDefault || '';
    setCustom(!!mainPage);
    setState('');
  }, [slug, version, lang, mainPage, mainPageDefault]);

  const save = async () => {
    clearTimeout(timer.current);
    timer.current = null;
    const html = ref.current?.innerHTML || '';
    const value = normalize(html) === normalize(mainPageDefault) ? '' : html;
    try {
      const res = await api.saveMainPage(slug, version, value, lang);
      setCustom(!!res.mainPage);
      setState(t('Saved'));
    } catch (e) {
      setState('');
      toast(e.message, 'err');
    }
  };
  const onInput = () => {
    setState(t('Saving…'));
    clearTimeout(timer.current);
    timer.current = setTimeout(save, 1000);
  };
  const onBlur = () => {
    if (timer.current) save();
  };
  const reset = () => {
    if (ref.current) ref.current.innerHTML = mainPageDefault || '';
    save();
  };

  return (
    <div className="main-page-block">
      <div className="main-page-head">
        <span className="main-page-label">{t('Main page')}</span>
        <span className="hint">{t('The title page when the doc is exported on its own. Version, revision and date fields are filled in when it is printed.')}</span>
        {state && <span className="hint main-page-state">{state}</span>}
        {editable && custom && (
          <button className="btn btn-sm" onMouseDown={(e) => e.preventDefault()} onClick={reset}>
            {t('Reset to default')}
          </button>
        )}
      </div>
      <div
        ref={ref}
        className="main-page-edit"
        contentEditable={editable}
        suppressContentEditableWarning
        onInput={onInput}
        onBlur={onBlur}
      />
    </div>
  );
}
