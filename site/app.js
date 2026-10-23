/* Cabin Weather front end. Vanilla JS, no dependencies, no build step.

   Reads data/current.json, data/forecast/{slug}.json and data/history/{slug}.json from wherever
   this script was served, and renders the community or overview named in the URL hash into
   #cabin-weather. The two-week charts and the history sentences live in history.js, which this
   file loads only for the six history communities. The formatter here mirrors
   pipeline/formatters.py and is tested by e2e/formatter.test.js; everything a reader sees goes
   through it. Spec: docs/implementation-plan.md sections 5 to 7. */
(function () {
'use strict';

const EN = '–';
const TZ_LABEL = 'MT';          // ARCHITECTURE.md, Time: the one label to revisit after the November 2026 clock change
const DEFAULT_OFFSET = -360;    // minutes east of UTC, used only when a timestamp carries no offset
const DEFAULT_SLUG = 'yellowknife';
const STALE_HOURS = 3;
const REGIONS = ['North Slave', 'Tłı̨chǫ', 'South Slave', 'Dehcho', 'Sahtu', 'Beaufort Delta'];   // regions_order in pipeline/config/communities.json
const VIEWS = {'all-now': 'All communities now', 'all-24h': 'Next 24 hours, all communities'};
const NWT_URL = 'https://weather.gc.ca/forecast/canada/index_e.html?id=NT';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const DIRS = {N: 'north', NNE: 'north-northeast', NE: 'northeast', ENE: 'east-northeast', E: 'east', ESE: 'east-southeast',
  SE: 'southeast', SSE: 'south-southeast', S: 'south', SSW: 'south-southwest', SW: 'southwest', WSW: 'west-southwest',
  W: 'west', WNW: 'west-northwest', NW: 'northwest', NNW: 'north-northwest'};

// ---------------------------------------------------------------- numbers (house style)

function roundHalfUp(v, d) {            // 2.5 -> 3, -2.5 -> -3, never banker's rounding
  const f = Math.pow(10, d || 0);
  const r = Math.round(Math.abs(v) * f + 1e-9) / f;
  return v < 0 ? -r : r;
}
function fmtNumber(v, d) {
  if (typeof v !== 'number' || isNaN(v)) return null;
  d = d || 0;
  let r = roundHalfUp(v, d);
  if (r === 0) r = 0;                   // no negative zero
  const parts = r.toFixed(d).split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.join('.');
}
function fmtTemp(v, d) { const s = fmtNumber(v, d); return s == null ? null : s + 'C'; }
function fmtMeasure(v, unit, d) { const s = fmtNumber(v, d); return s == null ? null : s + ' ' + unit; }
function fmtWindchill(v) { return fmtNumber(v, 0); }
function numWords(n) { return (n >= 0 && n <= 9 && n === Math.floor(n)) ? SMALL[n] : fmtNumber(n, 0); }
function fmtPercent(n) { const s = fmtNumber(n, 0); return s == null ? null : s + ' percent'; }
function ordinal(n) {
  const m = n % 100;
  const suffix = (m >= 10 && m <= 20) ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'}[n % 10] || 'th');
  return n + suffix;
}
function fmtRange(a, b) { return a + EN + b; }
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function sentence(s) { s = String(s == null ? '' : s).trim().replace(/\.+$/, ''); return s ? cap(s) + '.' : ''; }

// ---------------------------------------------------------------- dates and times
// Every timestamp in the data is ISO 8601 with the offset the pipeline chose (Mountain Time), so the
// wall-clock part is shown as written. The browser's own time zone is never used.

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?)?/.exec(s || '');
  if (!m) return null;
  let off = null;
  if (m[7] === 'Z') off = 0;
  else if (m[7]) off = (parseInt(m[7].slice(1, 3), 10) * 60 + parseInt(m[7].slice(4, 6), 10)) * (m[7].charAt(0) === '-' ? -1 : 1);
  return {y: +m[1], mo: +m[2], d: +m[3], h: m[4] ? +m[4] : 0, mi: m[5] ? +m[5] : 0, off: off};
}
function utcMillis(p) { return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - (p.off == null ? 0 : p.off) * 60000; }
function shift(ms, off) {               // a UTC instant as wall-clock parts at the given offset
  const t = new Date(ms + off * 60000);
  return {y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), off: off};
}
function dayName(p) { return DAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()]; }
function sameDay(a, b) { return a.y === b.y && a.mo === b.mo && a.d === b.d; }
function fmtDate(p, o) {                 // October 5; Monday, October 5; October 5, 2025
  let t = MONTHS[p.mo - 1] + ' ' + p.d;
  if (o && o.year) t += ', ' + p.y;
  if (o && o.weekday) t = dayName(p) + ', ' + t;
  return t;
}
function fmtTime(p, o) {                 // 4pm, 8:30am, noon, midnight; compact: 12pm, 12am; tz: 4pm MT
  const compact = o && o.compact;
  let t;
  if (p.mi === 0 && p.h === 12 && !compact) t = 'noon';
  else if (p.mi === 0 && p.h === 0 && !compact) t = 'midnight';
  else {
    const h12 = p.h % 12 || 12;
    const suffix = p.h < 12 ? 'am' : 'pm';
    t = p.mi === 0 ? h12 + suffix : h12 + ':' + (p.mi < 10 ? '0' : '') + p.mi + suffix;
  }
  return (o && o.tz) ? t + ' ' + TZ_LABEL : t;
}
function fmtDateRange(a, b) {            // October 1–18, or September 28 – October 11
  if (a.mo === b.mo && a.y === b.y) return MONTHS[a.mo - 1] + ' ' + a.d + EN + b.d;
  return fmtDate(a) + ' ' + EN + ' ' + fmtDate(b);
}
function clock(s) { const m = /^(\d{2}):(\d{2})$/.exec(s || ''); return m ? {h: +m[1], mi: +m[2]} : null; }
function dateText(iso, nowP) { const p = parseISO(iso); return p ? fmtDate(p, {year: !nowP || p.y !== nowP.y}) : null; }
function isoDate(p) { return p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d; }

function anomalyPhrase(a) {
  if (a == null) return null;
  if (Math.abs(a) < 0.5) return 'close to normal';
  const t = roundHalfUp(Math.abs(a), 1).toFixed(1).replace(/\.0$/, '');
  return 'about ' + t + 'C ' + (a > 0 ? 'above' : 'below') + ' normal';
}

// ---------------------------------------------------------------- generated text (pure functions, tested)

const T = {
  windLine(c) {
    if (c.wind_kmh == null) return null;
    if (c.wind_kmh === 0) return 'Calm';
    let s = 'Wind ' + fmtMeasure(c.wind_kmh, 'km/h');
    if (DIRS[c.wind_dir]) s += ' from the ' + DIRS[c.wind_dir];
    else if (c.wind_dir === 'VR') s += ' from variable directions';
    if (c.wind_gust_kmh != null) s += ', gusting to ' + fmtMeasure(c.wind_gust_kmh, 'km/h');
    return s;
  },
  windShort(c) {                         // for the overview table: 16 km/h SSW, gusts 40
    if (c.wind_kmh == null) return null;
    if (c.wind_kmh === 0) return 'Calm';
    let s = fmtMeasure(c.wind_kmh, 'km/h');
    if (DIRS[c.wind_dir]) s += ' ' + c.wind_dir; else if (c.wind_dir === 'VR') s += ' variable';
    if (c.wind_gust_kmh != null) s += ', gusts ' + fmtNumber(c.wind_gust_kmh);
    return s;
  },
  nowFacts(c) {
    const out = [];
    const w = T.windLine(c);
    if (w) out.push(w);
    if (c.wind_chill != null) out.push('Wind chill ' + fmtWindchill(c.wind_chill));
    if (c.humidex != null) out.push('Humidex ' + fmtNumber(c.humidex));
    if (c.humidity != null) out.push('Humidity ' + fmtPercent(c.humidity));
    return out;
  },
  observedLine(c, nowP) {
    const p = parseISO(c.observed_at);
    if (!p) return null;
    let s = 'Observed' + (c.station ? ' at ' + c.station : '') + ', ' + fmtTime(p);
    if (nowP && !sameDay(p, nowP)) s += ' on ' + dayName(p);
    return s + '.';
  },
  warningLine(c) {
    const all = c.warnings || [];
    if (!all.length) return null;
    const active = all.filter(w => w.type !== 'ended');
    const list = active.length ? active : all;
    return {items: list.map(w => ({title: w.title, url: w.url})), tail: active.length ? ' in effect for ' + c.name + '.' : ' has ended.'};
  },
  weekText(d) {
    const parts = [];
    if (d.day_summary) parts.push(sentence(d.day_summary));
    if (d.night_summary) parts.push(sentence(d.night_summary.replace(/\.+$/, '') + ' overnight'));
    return parts.join(' ');
  },
  weekTemps(d) {
    if (d.high != null && d.low != null) return {high: fmtTemp(d.high), low: fmtTemp(d.low)};
    if (d.high != null) return {high: 'High ' + fmtTemp(d.high), low: null};
    if (d.low != null) return {high: 'Low ' + fmtTemp(d.low), low: null};
    return null;
  },
  sunLine(c) {
    const r = clock(c.sunrise), s = clock(c.sunset);
    if (!r || !s) return null;
    return 'Sunrise ' + fmtTime(r) + ', sunset ' + fmtTime(s) + '.';
  },
  footerLine(c, generatedAt, offset) {
    const parts = ['Based on Environment and Climate Change Canada data.'];
    if (c && c.station) parts.push('Observations from ' + c.station + '.');
    const g = parseISO(generatedAt);
    if (g) parts.push('Updated ' + fmtTime(shift(utcMillis(g), offset), {tz: true}) + '.');
    return parts.join(' ');
  },
};

// ---------------------------------------------------------------- DOM helpers

const SVG_NS = 'http://www.w3.org/2000/svg';
function setAttrs(node, attrs) {
  if (!attrs) return;
  Object.keys(attrs).forEach(k => {
    const v = attrs[k];
    if (v == null || v === false) return;
    if (k === 'text') node.textContent = v; else node.setAttribute(k, v === true ? '' : v);
  });
}
function append(node, children) {
  if (children == null) return;
  (Array.isArray(children) ? children : [children]).forEach(c => {
    if (c == null || c === false) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
}
function el(tag, attrs, children) { const n = document.createElement(tag); setAttrs(n, attrs); append(n, children); return n; }
function svg(tag, attrs, children) { const n = document.createElementNS(SVG_NS, tag); setAttrs(n, attrs); append(n, children); return n; }
function glyph(name, label) {
  const s = svg('svg', {class: 'cw-glyph', focusable: 'false', role: label ? 'img' : null, 'aria-label': label || null, 'aria-hidden': label ? null : 'true'});
  s.appendChild(svg('use', {href: '#cw-' + (name || 'na')}));
  return s;
}
function fx(n) { return Math.round(n * 10) / 10; }
function sparkline(values) {             // a tiny line of the 24 hourly temperatures, scaled to its own row
  const known = values.filter(v => v != null);
  if (known.length < 2) return null;
  const W = 72, H = 20, lo = Math.min.apply(null, known), span = (Math.max.apply(null, known) - lo) || 1, n = values.length;
  let d = '', pen = false;
  values.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    d += (pen ? 'L' : 'M') + fx(1 + i / (n - 1) * (W - 2)) + ' ' + fx(H - 2 - (v - lo) / span * (H - 4));
    pen = true;
  });
  return svg('svg', {class: 'cw-spark', viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true', focusable: 'false'}, [svg('path', {d: d})]);
}

// ---------------------------------------------------------------- the app

const state = {root: null, standalone: false, current: null, slug: null, offset: DEFAULT_OFFSET, cache: {}, sec: {}, history: null, width: 0, histLoad: null};
let BASE = './';

function getJSON(url) {
  return fetch(url, {cache: 'default', mode: 'cors', credentials: 'same-origin'}).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}
function load(kind, slug) {
  const key = kind + '/' + slug;
  if (!state.cache[key]) {
    state.cache[key] = getJSON(BASE + 'data/' + kind + '/' + slug + '.json').catch(e => { delete state.cache[key]; throw e; });
  }
  return state.cache[key];
}
function noop() {}
function nowParts() { return shift(Date.now(), state.offset); }
function chartWidth() { return Math.max(280, state.root.clientWidth || 710); }
function offsetOf(c) { const p = c && parseISO(c.observed_at); return p && p.off != null ? p.off : DEFAULT_OFFSET; }

function buildSkeleton() {
  const root = state.root;
  root.textContent = '';
  const H = state.standalone ? 'h1' : 'h2', HS = state.standalone ? 'h2' : 'h3';
  if (state.standalone) root.appendChild(el('p', {class: 'cw-brand'}, ['Weather from ', el('a', {href: 'https://cabinradio.ca', text: 'Cabin Radio'})]));
  state.name = el(H, {class: 'cw-name', text: 'Yellowknife'});
  state.select = el('select');
  state.pick = el('label', {class: 'cw-pick', hidden: true}, [el('span', {text: 'Change community'}), state.select]);
  root.appendChild(el('div', {class: 'cw-head'}, [state.name, state.pick]));
  state.links = el('p', {class: 'cw-links', hidden: true}, Object.keys(VIEWS).map(k => el('a', {href: '#' + k, text: VIEWS[k]})));
  root.appendChild(state.links);
  state.warning = el('p', {class: 'cw-warning', hidden: true});
  state.notice = el('p', {class: 'cw-notice', hidden: true});
  root.appendChild(state.warning);
  root.appendChild(state.notice);
  const main = el('div', {class: 'cw-main', 'aria-live': 'polite'});
  [['now', 'Now'], ['hours', 'Next 24 hours'], ['week', 'This week'], ['fortnight', 'The past two weeks'], ['period', 'This month and this season'], ['records', 'Records']].forEach(pair => {
    const body = el('div', {class: 'cw-body'});
    const sec = el('section', {class: 'cw-sec', hidden: true}, [el(HS, {text: pair[1]}), body]);
    state.sec[pair[0]] = {sec: sec, body: body};
    main.appendChild(sec);
  });
  state.over = el('div', {class: 'cw-sec cw-over', hidden: true});
  main.appendChild(state.over);
  state.foot = el('footer', {class: 'cw-foot', hidden: true});
  main.appendChild(state.foot);
  root.appendChild(main);
}
function fill(key, nodes) { const s = state.sec[key]; s.body.textContent = ''; append(s.body, nodes); s.sec.hidden = false; }
function hide(key) { const s = state.sec[key]; s.sec.hidden = true; s.body.textContent = ''; }

function fetchIcons() {
  return fetch(BASE + 'icons.svg', {cache: 'default', mode: 'cors'}).then(r => r.ok ? r.text() : '').then(text => {
    if (!text || !state.root || state.root.querySelector('.cw-sprite')) return;
    const holder = el('div', {class: 'cw-sprite', hidden: true});
    holder.innerHTML = text;
    state.root.insertBefore(holder, state.root.firstChild);
  }).catch(noop);
}
function historyCode() {                 // history.js, loaded once, on demand
  if (CW.history) return Promise.resolve(CW.history);
  if (!state.histLoad) {
    state.histLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = BASE + 'history.js';
      s.async = true;
      s.onload = () => (CW.history ? resolve(CW.history) : reject(new Error('history.js')));
      s.onerror = () => { state.histLoad = null; reject(new Error('history.js')); };
      document.head.appendChild(s);
    });
  }
  return state.histLoad;
}

function byRegion() {                    // {region: [slug, ...]} with regions in REGIONS order and names alphabetical
  const comms = state.current.communities, groups = {};
  Object.keys(comms).forEach(slug => (groups[comms[slug].region] = groups[comms[slug].region] || []).push(slug));
  const order = REGIONS.filter(r => groups[r]).concat(Object.keys(groups).filter(r => REGIONS.indexOf(r) < 0).sort());
  return order.map(region => ({region: region, slugs: groups[region].sort((a, b) => comms[a].name.localeCompare(comms[b].name))}));
}
function buildSelect() {
  const comms = state.current.communities, sel = state.select;
  sel.textContent = '';
  sel.appendChild(el('option', {value: '', text: 'Pick a community'}));
  byRegion().forEach(g => {
    const group = el('optgroup', {label: g.region});
    g.slugs.forEach(slug => group.appendChild(el('option', {value: slug, text: comms[slug].name})));
    sel.appendChild(group);
  });
  sel.addEventListener('change', () => { if (sel.value) location.hash = sel.value; });
  state.pick.hidden = false;
  state.links.hidden = false;
}

function route() {
  const comms = state.current.communities;
  const hash = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (VIEWS[hash]) { state.slug = hash; showOverview(hash); return; }
  const slug = comms[hash] ? hash : (comms[DEFAULT_SLUG] ? DEFAULT_SLUG : Object.keys(comms)[0]);
  state.slug = slug;
  show(slug);
}
function setTitle(text) { if (state.standalone) document.title = text + ' ' + EN + ' Cabin Radio'; }

function show(slug) {
  const c = state.current.communities[slug];
  state.offset = offsetOf(c);
  state.history = null;
  state.name.textContent = c.name;
  state.select.value = slug;
  setTitle(c.name + ' weather');
  state.over.hidden = true;
  state.over.textContent = '';
  renderWarning(c);
  renderNow(c);
  ['hours', 'week', 'fortnight', 'period', 'records'].forEach(hide);
  renderFooter(c, null);
  load('forecast', slug).then(f => { if (state.slug === slug) renderForecast(c, f); }, noop);
  if (c.tier !== 'forecast') Promise.all([load('history', slug), historyCode()]).then(r => { if (state.slug === slug) renderHistory(c, r[0]); }, noop);
  const yk = state.current.communities[DEFAULT_SLUG];
  if (slug !== DEFAULT_SLUG && yk) { load('forecast', DEFAULT_SLUG).catch(noop); if (yk.tier !== 'forecast') load('history', DEFAULT_SLUG).catch(noop); }
}

function renderWarning(c) {
  const w = T.warningLine(c);
  state.warning.textContent = '';
  state.warning.hidden = !w;
  if (!w) return;
  w.items.forEach((item, i) => {
    if (i) state.warning.appendChild(document.createTextNode(i === w.items.length - 1 ? ' and ' : ', '));
    state.warning.appendChild(item.url ? el('a', {href: item.url, text: item.title}) : document.createTextNode(item.title));
  });
  state.warning.appendChild(document.createTextNode(w.tail));
}

function isStale(c) {
  const g = parseISO(state.current.generated_at);
  return !!c.stale || !!(g && (Date.now() - utcMillis(g)) / 36e5 > STALE_HOURS);
}

function renderNow(c) {
  const nodes = [];
  const line = el('div', {class: 'cw-now'});
  if (c.temp != null) line.appendChild(el('span', {class: 'cw-big', text: fmtTemp(c.temp)}));
  if (c.condition) line.appendChild(el('span', {class: 'cw-cond', text: c.condition}));
  if (line.childNodes.length) nodes.push(line);
  const facts = T.nowFacts(c);
  if (facts.length) nodes.push(el('ul', {class: 'cw-facts'}, facts.map(f => el('li', {text: f}))));
  const stale = isStale(c);
  const obs = T.observedLine(c, nowParts());
  if (obs || stale) nodes.push(el('p', {class: 'cw-obs'}, [obs ? obs + ' ' : null, stale ? el('span', {class: 'cw-muted', text: 'Observations are delayed.'}) : null]));
  if (nodes.length) fill('now', nodes); else hide('now');
}

function renderForecast(c, f) {
  const hours = f.hourly || [];
  if (hours.length) {
    const strip = el('div', {class: 'cw-hours', role: 'list'});
    hours.forEach(p => {
      const t = parseISO(p.time), label = t ? fmtTime(t, {compact: true}) : '', temp = fmtTemp(p.temp);
      const item = el('div', {class: 'cw-hour', role: 'listitem', 'aria-label': [label, temp, p.condition].filter(Boolean).join(', ')});
      item.appendChild(el('div', {class: 'cw-hour-t', 'aria-hidden': 'true', text: label}));
      item.appendChild(glyph(p.icon, null));
      item.appendChild(el('div', {class: 'cw-hour-v', 'aria-hidden': 'true', text: temp || ''}));
      strip.appendChild(item);
    });
    fill('hours', [strip]);
  }
  const daily = f.daily || [];
  if (daily.length) {
    const list = el('ol', {class: 'cw-week'});
    daily.forEach(d => {
      const p = parseISO(d.date), temps = T.weekTemps(d);
      list.appendChild(el('li', null, [
        el('span', {class: 'cw-day'}, [d.day || (p ? dayName(p) : ''), p ? el('span', {text: fmtDate(p)}) : null]),
        glyph(d.icon, null),
        temps ? el('span', {class: 'cw-temps'}, [temps.high, temps.low ? el('span', {text: ' / ' + temps.low}) : null]) : null,
        el('span', {class: 'cw-text', text: T.weekText(d)}),
      ]));
    });
    const nodes = [list];
    const sun = T.sunLine(c);
    if (sun) nodes.push(el('p', {class: 'cw-sun', text: sun}));
    fill('week', nodes);
  }
}

function renderHistory(c, h) {
  state.history = {c: c, h: h};
  state.width = chartWidth();
  CW.history.render(c, h);
}

function renderFooter(c, h) {
  const f = state.foot;
  f.textContent = '';
  f.appendChild(el('p', {text: T.footerLine(c, state.current.generated_at, state.offset)}));
  if (h && h.station) f.appendChild(el('p', {text: 'Climate records from ECCC\'s ' + h.station + ' station, since ' + h.record_start + '.'}));
  f.appendChild(el('p', null, [c ? el('a', {href: c.eccc_url, text: c.name + ' on weather.gc.ca'}) : el('a', {href: NWT_URL, text: 'The NWT on weather.gc.ca'})]));
  f.hidden = false;
}

// ---------------------------------------------------------------- the two all-communities views

function nameCell(slug, c) { return el('th', {class: 'cw-cname', role: 'rowheader', scope: 'row'}, [el('a', {href: '#' + slug, text: c.name})]); }
function regionRow(region, span) { return el('tr', {class: 'cw-region', role: 'row'}, [el('th', {role: 'rowheader', scope: 'rowgroup', colspan: String(span), text: region})]); }
function table(cls, caption, head, rowFn, span) {
  const comms = state.current.communities;
  const bodies = byRegion().map(g => {
    const body = el('tbody', {role: 'rowgroup'}, [regionRow(g.region, span)]);
    g.slugs.forEach(slug => body.appendChild(rowFn(slug, comms[slug])));
    return body;
  });
  return el('table', {class: 'cw-all ' + cls, role: 'table'}, [el('caption', {class: 'cw-sr', text: caption}), head].concat(bodies));
}
function nowTable() {
  const head = el('thead', {class: 'cw-sr', role: 'rowgroup'}, [el('tr', {role: 'row'}, ['Community', 'Sky', 'Temperature', 'Wind', 'Conditions'].map(t => el('th', {role: 'columnheader', scope: 'col', text: t})))]);
  return table('cw-all-now', 'Current conditions in every community, by region', head, (slug, c) => el('tr', {role: 'row'}, [
    nameCell(slug, c),
    el('td', {class: 'cw-cglyph', role: 'cell'}, [glyph(c.icon, null)]),
    el('td', {class: 'cw-ctemp', role: 'cell'}, [fmtTemp(c.temp) || '', isStale(c) ? el('span', {class: 'cw-small', text: ' delayed'}) : null]),
    el('td', {class: 'cw-cwind', role: 'cell', text: T.windShort(c) || ''}),
    el('td', {class: 'cw-ccond', role: 'cell', text: c.condition || ''}),
  ]), 5);
}
function hoursTable() {
  const STEP = 3, COUNT = 8;
  const timeHead = [];
  for (let i = 0; i < COUNT; i++) timeHead.push(el('th', {class: 'cw-t8', role: 'columnheader', scope: 'col'}));
  const head = el('thead', {role: 'rowgroup'}, [el('tr', {role: 'row'}, [
    el('th', {class: 'cw-cname', role: 'columnheader', scope: 'col', text: 'Community'}),
    el('th', {class: 'cw-cspark', role: 'columnheader', scope: 'col'}, [el('span', {class: 'cw-sr', text: 'Trend'})]),
  ].concat(timeHead))]);
  return table('cw-all-24', 'Temperature every three hours for the next 24 hours in every community, by region', head, (slug, c) => {
    const cells = [];
    for (let i = 0; i < COUNT; i++) cells.push(el('td', {class: 'cw-t8', role: 'cell'}));
    const spark = el('td', {class: 'cw-cspark', role: 'cell'});
    const tr = el('tr', {role: 'row'}, [nameCell(slug, c), spark].concat(cells));
    load('forecast', slug).then(f => {
      const hours = f.hourly || [];
      for (let i = 0; i < COUNT && i * STEP < hours.length; i++) {
        const p = hours[i * STEP], t = parseISO(p.time);
        cells[i].textContent = fmtTemp(p.temp) || '';
        if (t && !timeHead[i].textContent) timeHead[i].textContent = fmtTime(t, {compact: true});
      }
      const sp = sparkline(hours.map(p => p.temp));
      if (sp) spark.appendChild(sp);
    }, noop);
    return tr;
  }, COUNT + 2);
}
function showOverview(kind) {
  state.history = null;
  state.offset = offsetOf(state.current.communities[DEFAULT_SLUG]);
  state.name.textContent = VIEWS[kind];
  state.select.value = '';
  setTitle(VIEWS[kind]);
  state.warning.hidden = true;
  Object.keys(state.sec).forEach(hide);
  state.over.textContent = '';
  state.over.appendChild(kind === 'all-now' ? nowTable() : hoursTable());
  state.over.hidden = false;
  renderFooter(null, null);
}

function showUnavailable() {
  const n = state.notice;
  n.textContent = '';
  append(n, ['Live weather is temporarily unavailable. Try ', el('a', {href: 'https://weather.gc.ca/', text: 'weather.gc.ca'}), '.']);
  n.hidden = false;
}

let resizeTimer = null;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.history && Math.abs(chartWidth() - state.width) > 2) renderHistory(state.history.c, state.history.h);
  }, 150);
}

function boot() {
  const root = document.getElementById('cabin-weather');
  if (!root) return;
  state.root = root;
  state.standalone = root.hasAttribute('data-standalone');
  buildSkeleton();
  fetchIcons();
  getJSON(BASE + 'data/current.json').then(data => {
    state.current = data;
    buildSelect();
    route();
    window.addEventListener('hashchange', route);
  }).catch(showUnavailable);
  window.addEventListener('resize', onResize);
}

// What history.js and the tests can use.
const CW = {
  EN: EN, DAYS: DAYS, MONTHS: MONTHS, REGIONS: REGIONS,
  roundHalfUp, fmtNumber, fmtTemp, fmtMeasure, fmtWindchill, numWords, fmtPercent, ordinal, fmtRange, cap, sentence,
  parseISO, utcMillis, shift, dayName, fmtDate, fmtTime, fmtDateRange, clock, dateText, anomalyPhrase, isoDate,
  text: T, el, svg, fx, sparkline, fill, hide, chartWidth, nowParts, renderFooter, history: null,
};
if (typeof module !== 'undefined' && module.exports) module.exports = CW;
if (typeof document !== 'undefined') {
  window.CabinWeather = CW;
  const script = document.currentScript;
  try { BASE = new URL('.', script && script.src ? script.src : document.baseURI).href; } catch (e) { BASE = './'; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
})();
