/**
 * The symbol catalog: every graphical symbol the drawing can make, after PN-EN 60617 (IEC 60617), with
 * its reference in the standard, its name in both languages, and what it is for. It is fixed in code —
 * a symbol is drawn by the renderer's own functions (`poleSymbol`, `contactSymbol`, `cableMarks`), so the
 * catalog's pictures are the drawing's pictures, never stored files. `symbolCatalog` adds which library
 * records draw with each symbol, so a reviewer sees the catalog the way a parts manager shows macros.
 */
import { SYMBOLS, PROTECTIVE_SYMBOLS, connectorSymbolOf } from './library.js';
import { poleSymbol, contactSymbol, cableMarks } from './schematic-render.js';

const STANDARD = 'PN-EN 60617 (IEC 60617)';

export const SYMBOL_CATALOG = [
  { id: 'box', kind: 'device', ref: '02-01-01', name: { en: 'Object, general symbol (device rectangle)', pl: 'Obiekt, symbol ogólny (prostokąt urządzenia)' }, params: [], aliases: SYMBOLS.filter((s) => !PROTECTIVE_SYMBOLS.includes(s) && s !== 'box') },
  { id: 'mcb', kind: 'device', ref: '07-13-05', name: { en: 'Circuit breaker', pl: 'Wyłącznik nadprądowy' }, params: ['poles', 'rating'], detail: { en: 'Make contact with the circuit-breaker cross at the fixed contact, worked by a thermal and an electromagnetic release.', pl: 'Zestyk zwierny z krzyżykiem wyłącznika na styku nieruchomym, uruchamiany wyzwalaczem termicznym i elektromagnetycznym.' } },
  { id: 'switch-disconnector', kind: 'device', ref: '07-13-08', name: { en: 'Switch disconnector', pl: 'Rozłącznik izolacyjny' }, params: ['poles', 'rating'], detail: { en: 'Disconnector (isolating bar at the fixed contact) with the load-switch mark at the pivot; poles mechanically coupled.', pl: 'Odłącznik (kreska izolacyjna na styku nieruchomym) ze znakiem łącznika obciążenia na osi; bieguny sprzężone mechanicznie.' } },
  { id: 'fuse', kind: 'device', ref: '07-21-01', name: { en: 'Fuse', pl: 'Bezpiecznik' }, params: ['poles', 'rating'] },
  { id: 'lamp', kind: 'device', ref: '08-10-01', name: { en: 'Indicator lamp', pl: 'Lampka sygnalizacyjna' }, params: ['poles'], detail: { en: 'One lamp per pole on a common return; the return leaves under the middle lamp.', pl: 'Jedna lampka na biegun na wspólnym przewodzie powrotnym, wyprowadzonym pod środkową lampką.' } },
  { id: 'socket', kind: 'contact', ref: '03-03-05', name: { en: 'Female contact (socket)', pl: 'Styk żeński (gniazdo)' }, params: [] },
  { id: 'plug', kind: 'contact', ref: '03-03-06', name: { en: 'Male contact (plug)', pl: 'Styk męski (wtyk)' }, params: [] },
  { id: 'mate', kind: 'contact', ref: '03-03-07', name: { en: 'Plug and socket, connected', pl: 'Wtyk i gniazdo, połączone' }, params: [] },
  { id: 'terminal', kind: 'contact', ref: '03-02-02', name: { en: 'Terminal', pl: 'Zacisk' }, params: [] },
  { id: 'pe', kind: 'contact', ref: '02-15-02', name: { en: 'Protective earth', pl: 'Uziemienie ochronne' }, params: [] },
  { id: 'cores', kind: 'cable', ref: '03-01-02', name: { en: 'Number of conductors', pl: 'Liczba żył' }, params: [] },
  { id: 'screen', kind: 'cable', ref: '02-06-01', name: { en: 'Screen (shield)', pl: 'Ekran' }, params: [] },
  { id: 'junction', kind: 'graphic', ref: '03-02-01', name: { en: 'Junction of conductors', pl: 'Połączenie przewodów' }, params: [] },
  { id: 'coupling', kind: 'graphic', ref: '02-12-01', name: { en: 'Mechanical coupling', pl: 'Sprzężenie mechaniczne' }, params: [] },
].map((s) => ({ ...s, standard: STANDARD, aliases: s.aliases || [], detail: s.detail || null }));

export const symbolOf = (id) => SYMBOL_CATALOG.find((s) => s.id === id) || null;

const L = (x1, y1, x2, y2, extra = '') => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="1.2"${extra}/>`;
// the marks sit on a cable's longest inner segment: a straight run with its two stubs
const RUN = [{ x: 4, y: 12 }, { x: 6, y: 12 }, { x: 42, y: 12 }, { x: 44, y: 12 }];
const wrap = (w, h, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" class="sch-symbol" font-family="Verdana, Geneva, sans-serif">${inner}</svg>`;

/** One symbol on its own, drawn by the renderer's functions, as a standalone svg (a catalog tile). */
export function symbolSvg(id) {
  const s = symbolOf(id);
  if (!s) throw new Error(`Unknown symbol "${id}" — one of ${SYMBOL_CATALOG.map((x) => x.id).join(', ')}`);
  switch (id) {
    case 'box': return wrap(64, 40, `<rect x="12" y="8" width="40" height="24" fill="#fff" stroke="#000" stroke-width="1"/>${L(2, 20, 12, 20)}${L(52, 20, 62, 20)}`);
    case 'mcb': case 'switch-disconnector': case 'fuse': return wrap(48, 64, `<g transform="translate(30,4)">${poleSymbol(id, 0, 56)}</g>`);
    case 'lamp': return wrap(48, 64, `<g transform="translate(24,4)">${poleSymbol('lamp', 0, 56)}</g>${L(24, 46, 24, 60)}`);
    case 'socket': case 'plug': case 'terminal': case 'pe': return wrap(48, 24, `${L(4, 12, 30, 12)}${contactSymbol(id, { x: 30, y: 12 }, 'right', '#000')}`);
    case 'mate': return wrap(48, 24, `${L(4, 12, 24, 12)}${contactSymbol('socket', { x: 24, y: 12 }, 'right', '#000', { mated: true })}${L(28, 12, 44, 12)}`);
    case 'cores': return wrap(48, 24, `${L(4, 12, 44, 12)}${cableMarks(RUN, { cores: 'n' }, '#000')}`);
    case 'screen': return wrap(48, 24, `${L(4, 12, 44, 12)}${cableMarks(RUN, { screened: true }, '#000')}`);
    case 'junction': return wrap(48, 24, `${L(4, 12, 44, 12)}${L(24, 12, 24, 22)}<circle class="sch-junction" cx="24" cy="12" r="2.2" fill="#000"/>`);
    case 'coupling': return wrap(48, 24, `${L(10, 2, 10, 22)}${L(38, 2, 38, 22)}${L(10, 12, 38, 12, ' class="sch-coupling" stroke-dasharray="3 2"')}`);
    default: throw new Error(`No drawing for symbol "${id}"`);
  }
}

/** The catalog for a reader: names in `lang`, each symbol's svg, and the library records that draw with it. */
export function symbolCatalog(library, lang = 'en') {
  const name = (s) => s.name[lang] || s.name.en;
  const devices = library?.devices || [];
  const connectors = library?.connectors || [];
  const cables = library?.cables || [];
  return SYMBOL_CATALOG.map((s) => {
    let usedBy = [];
    if (s.kind === 'device') usedBy = devices.filter((d) => (d.symbol || 'box') === s.id || s.aliases.includes(d.symbol)).map((d) => ({ kind: 'template', id: d.id, name: d.name }));
    else if (s.id === 'mate') usedBy = [];
    else if (s.kind === 'contact') usedBy = connectors.filter((c) => connectorSymbolOf(c) === s.id).map((c) => ({ kind: 'connector', id: c.id, name: c.label }));
    else if (s.id === 'cores') usedBy = cables.filter((c) => c.cores).map((c) => ({ kind: 'cable', id: c.id, name: c.label }));
    else if (s.id === 'screen') usedBy = cables.filter((c) => c.screened).map((c) => ({ kind: 'cable', id: c.id, name: c.label }));
    return { id: s.id, kind: s.kind, ref: s.ref, standard: s.standard, label: name(s), detail: s.detail ? s.detail[lang] || s.detail.en : '', params: s.params, aliases: s.aliases, svg: symbolSvg(s.id), usedBy };
  });
}

/** The HTTP handler body: `GET /api/library/symbols?lang=` — the catalog with names in that language. */
export async function symbolsRoute(req, getLibrary) {
  const lang = String(req.query?.lang || 'en') === 'pl' ? 'pl' : 'en';
  return { standard: STANDARD, symbols: symbolCatalog(await getLibrary(), lang) };
}
