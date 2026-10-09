import React, { useEffect, useRef, useState } from 'react';
import { api, readFileAsBase64 } from '../api.js';
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

  // A picture pasted or dropped onto the page is uploaded to the doc's assets first and then placed
  // at the caret by its asset URL — what the clipboard hands over (blob:, file:, a remote page's
  // image) would show nowhere else and never print.
  const insertPictures = async (files) => {
    const pics = files.filter((f) => /^image\//.test(f.type));
    if (!pics.length) return false;
    if (!editable) {
      toast(t('Read-only doc — images can only be added to a draft'), 'err');
      return true;
    }
    const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0).cloneRange() : null;
    try {
      setState(t('Saving…'));
      const stamp = Date.now();
      const payload = await Promise.all(
        pics.map(async (f, i) => ({ ...(await readFileAsBase64(f)), name: `main-page-${stamp}${pics.length > 1 ? `-${i + 1}` : ''}.${(f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')}` }))
      );
      const saved = await api.uploadAssets(slug, version, payload);
      const html = saved.map((s) => `<p class="mp-picture"><img src="${s.url}" alt=""></p>`).join('');
      const el = ref.current;
      el.focus();
      const sel = window.getSelection();
      if (range && el.contains(range.commonAncestorContainer)) {
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertHTML', false, html);
      } else el.insertAdjacentHTML('beforeend', html);
      await save();
    } catch (e) {
      setState('');
      toast(t('Image paste failed: {error}', { error: e.message }), 'err');
    }
    return true;
  };
  const dataImages = async (html) => {
    const urls = [...String(html || '').matchAll(/<img[^>]+src="(data:image\/[^"]+)"/gi)].map((m) => m[1]);
    const files = [];
    for (const [i, url] of urls.entries()) {
      try {
        const blob = await (await fetch(url)).blob();
        files.push(new File([blob], `image-${i + 1}`, { type: blob.type }));
      } catch {
        /* unreadable image */
      }
    }
    return files;
  };
  const onPaste = (e) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...(cd.files || [])].filter((f) => /^image\//.test(f.type));
    const htmlData = cd.getData('text/html');
    if (files.length) {
      e.preventDefault();
      insertPictures(files);
    } else if (/<img[^>]+src="data:image\//i.test(htmlData)) {
      e.preventDefault();
      dataImages(htmlData).then((imgs) => (imgs.length ? insertPictures(imgs) : toast(t('Could not read the pasted image'), 'err')));
    } else if (/<img/i.test(htmlData)) {
      // a picture linked from another page would not print: paste its text only
      e.preventDefault();
      document.execCommand('insertText', false, cd.getData('text/plain'));
      toast(t('Pictures from a web page are not pasted — save the picture and paste or drop the file'), 'err');
    }
  };
  const onDrop = (e) => {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.some((f) => /^image\//.test(f.type))) return;
    e.preventDefault();
    const r = document.caretRangeFromPoint?.(e.clientX, e.clientY);
    if (r) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    }
    insertPictures(files);
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
        onPaste={onPaste}
        onDragOver={(e) => {
          if (editable && e.dataTransfer?.types?.includes('Files')) e.preventDefault();
        }}
        onDrop={onDrop}
      />
    </div>
  );
}
