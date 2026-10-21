/* Cabin Weather front end. Vanilla JS, no dependencies, no build step.

   Reads data/current.json, data/forecast/{slug}.json and data/history/{slug}.json from
   wherever this script was served, and renders one community into #cabin-weather. The
   formatter at the top mirrors pipeline/formatters.py and is tested by e2e/formatter.test.js;
   everything a reader sees goes through it. Spec: docs/implementation-plan.md sections 5 to 7. */
(function () {
'use strict';

const EN = '–';
const TZ_LABEL = 'MT';          // ARCHITECTURE.md, Time: the one label to revisit after the November 2026 clock change
const DEFAULT_OFFSET = -360;    // minutes east of UTC, used only when a timestamp carries no offset
const DEFAULT_SLUG = 'yellowknife';
const STALE_HOURS = 3;
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

function anomalyPhrase(a) {
  if (a == null) return null;
  if (Math.abs(a) < 0.5) return 'close to normal';
  const t = roundHalfUp(Math.abs(a), 1).toFixed(1).replace(/\.0$/, '');
  return 'about ' + t + 'C ' + (a > 0 ? 'above' : 'below') + ' normal';
}

// ---------------------------------------------------------------- style check (mirrors formatters.style_problems)

const STYLE_RULES = [
  ['em dash', /—/],
  ['degree sign', /[°℃]/],
  ['Unicode minus', /−/],
  ['today/yesterday/tomorrow', /\b(today|yesterday|tomorrow)\b/i],
  ['NT for the territory', /\bNT\b/],
  ['percent sign', /%/],
  ['exclamation mark', /!/],
  ["'over' before a number", /\bover\s+-?\d/i],
  ['abbreviation with periods', /\b(?:[A-Za-z]\.){2,}/],
  ['okay', /\bokay\b/i],
  ['underway as one word', /\bunderway\b/i],
  ["'minus' before a temperature", /\bminus\s+\d/i],
  ['hyphen used as a range or break', /\d\s-\s\d|\s-\s/],
];
function styleProblems(text) { return STYLE_RULES.filter(r => r[1].test(text)).map(r => r[0]); }

// ---------------------------------------------------------------- generated text (pure functions, tested)

const FLAG_TEXT = {
  record_high: 'A record high for the date.', high_top3: 'One of the three warmest highs for the date.',
  record_low: 'A record low for the date.', low_top3: 'One of the three coldest lows for the date.',
  record_warm_low: 'The warmest overnight low recorded for the date.', warm_low_top3: 'One of the three warmest overnight lows for the date.',
  record_cold_high: 'The coldest daytime high recorded for the date.', cold_high_top3: 'One of the three coldest daytime highs for the date.',
};

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
  periodLines(p) {
    const out = [];
    if (!p) return out;
    const label = p.label || p.name;
    if (p.mean != null) {
      let lead = cap(label);
      if (/so far$/.test(label) && p.from) lead += ', since ' + fmtDate(parseISO(p.from)) + ',';
      let s = lead + ' averaged ' + fmtTemp(p.mean, 1);
      const a = anomalyPhrase(p.anomaly);
      if (a) s += ', ' + a;
      s += '.';
      if (p.rank_text) s += ' That is the ' + p.rank_text + '.';
      out.push(s);
    }
    if (p.precip != null) {
      let s = 'Precipitation was ' + fmtMeasure(p.precip, 'mm', 1);
      if (p.precip_normal != null) s += ' against a normal of ' + fmtMeasure(p.precip_normal, 'mm', 1);
      if (p.wettest_rank && p.of) s += ', the ' + ordinal(p.wettest_rank) + ' wettest in ' + numWords(p.of) + ' years';
      out.push(s + '.');
    }
    const recs = [];
    if (p.record_warm && p.record_warm.value != null) recs.push('Warmest ' + label + ' on record: ' + fmtTemp(p.record_warm.value, 1) + ' in ' + p.record_warm.year);
    if (p.record_cold && p.record_cold.value != null) recs.push((recs.length ? 'Coldest: ' : 'Coldest ' + label + ' on record: ') + fmtTemp(p.record_cold.value, 1) + ' in ' + p.record_cold.year);
    if (p.record_wet && p.record_wet.value != null) recs.push((recs.length ? 'Wettest: ' : 'Wettest ' + label + ' on record: ') + fmtMeasure(p.record_wet.value, 'mm', 1) + ' in ' + p.record_wet.year);
    if (recs.length) out.push(recs.join('. ') + '.');
    return out;
  },
  plusLines(plus, nowP) {
    const out = [];
    if (!plus) return out;
    if (plus.days_since_minus30 != null) {
      const when = plus.last_minus30 ? dateText(plus.last_minus30, nowP) : null;
      const n = plus.days_since_minus30;
      if (n === 0) out.push('The overnight low reached -30C' + (when ? ' on ' + when : '') + '.');
      else out.push('It has been ' + numWords(n) + (n === 1 ? ' day' : ' days') + ' since the last -30C night' + (when ? ', on ' + when : '') + '.');
    }
    const nots = [];
    if (plus.first_frost) out.push('The first frost of the season came on ' + dateText(plus.first_frost, nowP) + '.'); else nots.push('frost');
    if (plus.first_minus10) out.push('The first -10C night came on ' + dateText(plus.first_minus10, nowP) + '.'); else nots.push('-10C night');
    if (plus.first_snow) out.push('The first snow came on ' + dateText(plus.first_snow, nowP) + '.'); else nots.push('snow');
    if (nots.length) out.push('No ' + (nots.length > 1 ? nots.slice(0, -1).join(', ') + ' or ' + nots[nots.length - 1] : nots[0]) + ' yet this season.');
    if (plus.snow_on_ground != null) {
      const on = plus.snow_on_ground_date ? ' on ' + dateText(plus.snow_on_ground_date, nowP) : '';
      out.push(plus.snow_on_ground > 0 ? 'Snow on the ground: ' + fmtMeasure(plus.snow_on_ground, 'cm') + on + '.' : 'No snow on the ground' + on + '.');
    }
    if (plus.season_snowfall != null && plus.season_snowfall > 0) out.push('Snowfall since August 1: ' + fmtMeasure(plus.season_snowfall, 'cm', 1) + '.');
    return out;
  },
  recordLines(h, cal, name) {
    const a = h.alltime || {};
    const out = [];
    const on = e => (e.date ? ', on ' + fmtDate(parseISO(e.date), {year: true}) : '');
    const hi = a.high, lo = a.low;
    if (hi && hi.value != null) {
      let s = name + "'s highest temperature since " + h.record_start + ' is ' + fmtTemp(hi.value, 1) + on(hi);
      if (lo && lo.value != null) s += ', and its lowest ' + fmtTemp(lo.value, 1) + on(lo);
      out.push(s + '.');
    } else if (lo && lo.value != null) {
      out.push(name + "'s lowest temperature since " + h.record_start + ' is ' + fmtTemp(lo.value, 1) + on(lo) + '.');
    }
    const parts = [];
    if (a.wettest_day && a.wettest_day.value != null) parts.push('The wettest day brought ' + fmtMeasure(a.wettest_day.value, 'mm', 1) + on(a.wettest_day) + '.');
    if (a.windiest_gust && a.windiest_gust.value != null) parts.push('The strongest gust on record is ' + fmtMeasure(a.windiest_gust.value, 'km/h') + on(a.windiest_gust) + '.');
    if (parts.length) out.push(parts.join(' '));
    if (cal) {
      const p = parseISO(cal.date);
      const bits = [];
      if (cal.record_high != null) bits.push('the record high is ' + fmtTemp(cal.record_high, 1) + (cal.record_high_year ? ', set in ' + cal.record_high_year : ''));
      if (cal.record_low != null) bits.push('the record low ' + (bits.length ? '' : 'is ') + fmtTemp(cal.record_low, 1) + (cal.record_low_year ? ', set in ' + cal.record_low_year : ''));
      let s = bits.length ? 'On ' + fmtDate(p) + ' ' + bits.join(', and ') + '.' : '';
      if (cal.record_precip != null) s += (s ? ' ' : '') + 'The wettest ' + fmtDate(p) + ' brought ' + fmtMeasure(cal.record_precip, 'mm', 1) + (cal.record_precip_year ? ' in ' + cal.record_precip_year : '') + '.';
      if (s) out.push(s);
    }
    return out;
  },
  dayDetail(d) {
    const p = parseISO(d.date);
    const hl = [];
    if (d.max != null) hl.push('high ' + fmtTemp(d.max, 1));
    if (d.min != null) hl.push('low ' + fmtTemp(d.min, 1));
    let s = fmtDate(p, {weekday: true}) + ': ' + (hl.length ? hl.join(', ') : 'no observation') + '.';
    if (d.normal_max != null && d.normal_min != null) s += ' Normal ' + fmtTemp(d.normal_max, 1) + ' and ' + fmtTemp(d.normal_min, 1) + '.';
    if (d.precip != null) s += ' Precipitation ' + fmtMeasure(d.precip, 'mm', 1) + '.';
    if (d.gust != null) s += ' Peak gust ' + fmtMeasure(d.gust, 'km/h') + '.';
    const recs = [];
    if (d.record_high != null) recs.push('record high ' + fmtTemp(d.record_high, 1) + (d.record_high_year ? ' in ' + d.record_high_year : ''));
    if (d.record_low != null) recs.push('record low ' + fmtTemp(d.record_low, 1) + (d.record_low_year ? ' in ' + d.record_low_year : ''));
    if (recs.length) s += ' ' + cap(recs.join(', ')) + '.';
    (d.flags || []).forEach(f => { if (FLAG_TEXT[f]) s += ' ' + FLAG_TEXT[f]; });
    return s;
  },
  footerLine(c, generatedAt, offset) {
    const parts = ['Based on Environment and Climate Change Canada data.'];
    if (c.station) parts.push('Observations from ' + c.station + '.');
    const g = parseISO(generatedAt);
    if (g) parts.push('Updated ' + fmtTime(shift(utcMillis(g), offset), {tz: true}) + '.');
    return parts.join(' ');
  },
  stationLabel(s) { return s ? s.replace(/\sA$/, ' Airport') : ''; },
};

// ---------------------------------------------------------------- DOM helpers

const SVG_NS = 'http://www.w3.org/2000/svg';
let uid = 0;
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

// ---------------------------------------------------------------- charts (hand-drawn SVG)

function niceTicks(lo, hi, count) {
  if (!(hi > lo)) hi = lo + 1;
  const span = hi - lo;
  const mag = Math.pow(10, Math.floor(Math.log(span / count) / Math.LN10));
  let step = mag * 10;
  [1, 2, 5, 10].some(m => { step = m * mag; return span / step <= count; });
  const min = Math.floor(lo / step) * step, max = Math.ceil(hi / step) * step;
  const values = [];
  for (let v = min; v <= max + step / 2; v += step) values.push(Math.round(v / step) * step);
  return {min: min, max: max, step: step, values: values};
}
function makeChart(width, H, title, subtitle, margin) {
  const M = Object.assign({t: 24, r: 50, b: 40, l: 44}, margin);
  const capId = 'cw-cap-' + (++uid);
  const s = svg('svg', {class: 'cw-chart', viewBox: '0 0 ' + width + ' ' + H, width: width, height: H, role: 'img', 'aria-label': title, 'aria-describedby': capId, focusable: 'false'});
  const fig = el('figure', null, [el('figcaption', null, [el('b', {text: title}), el('span', {id: capId, text: subtitle})]), s]);
  return {fig: fig, svg: s, M: M, width: width, H: H};
}
function scaleY(ch, t) { return v => ch.M.t + (t.max - v) / (t.max - t.min) * (ch.H - ch.M.t - ch.M.b); }
function drawGrid(ch, t, y, fmt) {
  t.values.forEach(v => {
    ch.svg.appendChild(svg('line', {class: 'cw-grid', x1: ch.M.l, x2: ch.width - ch.M.r, y1: fx(y(v)), y2: fx(y(v))}));
    ch.svg.appendChild(svg('text', {x: ch.M.l - 8, y: fx(y(v) + 4), 'text-anchor': 'end', text: fmt(v)}));
  });
}
function dayLabels(ch, dates, x, slot) {      // dates: parsed days in order; day numbers plus the month name where it changes
  const firstOfMonth = dates.findIndex(p => p.d === 1);
  dates.forEach((p, i) => {
    ch.svg.appendChild(svg('text', {x: fx(x(i)), y: ch.H - ch.M.b + 18, 'text-anchor': 'middle', text: String(p.d)}));
    if ((i === 0 && (firstOfMonth < 0 || firstOfMonth > 4)) || p.d === 1) {
      ch.svg.appendChild(svg('text', {x: fx(x(i) - slot / 2), y: ch.H - ch.M.b + 34, text: MONTHS[p.mo - 1]}));
    }
  });
}
function linePath(items, x, y, key) {
  let d = '', pen = false;
  items.forEach((it, i) => {
    if (it[key] == null) { pen = false; return; }
    d += (pen ? 'L' : 'M') + fx(x(i)) + ' ' + fx(y(it[key]));
    pen = true;
  });
  return d;
}
function bandPath(items, x, y, slot, topKey, botKey) {
  let d = '', run = [];
  const flush = () => {
    if (run.length) {
      const pts = run.map(i => [x(i), items[i][topKey], items[i][botKey]]);
      pts.unshift([x(run[0]) - slot / 2, items[run[0]][topKey], items[run[0]][botKey]]);
      pts.push([x(run[run.length - 1]) + slot / 2, items[run[run.length - 1]][topKey], items[run[run.length - 1]][botKey]]);
      d += 'M' + pts.map(p => fx(p[0]) + ' ' + fx(y(p[1]))).join('L') + 'L' + pts.slice().reverse().map(p => fx(p[0]) + ' ' + fx(y(p[2]))).join('L') + 'Z';
    }
    run = [];
  };
  items.forEach((it, i) => { if (it[topKey] != null && it[botKey] != null) run.push(i); else flush(); });
  flush();
  return d;
}
function extent(items, keys) {
  let lo = Infinity, hi = -Infinity;
  items.forEach(it => keys.forEach(k => { if (it[k] != null) { lo = Math.min(lo, it[k]); hi = Math.max(hi, it[k]); } }));
  return lo === Infinity ? null : [lo, hi];
}

const FLAG_MARK = {
  record_high: ['max', true, 'Record'], high_top3: ['max', false, 'Top 3'], record_cold_high: ['max', true, 'Record'], cold_high_top3: ['max', false, 'Top 3'],
  record_low: ['min', true, 'Record'], low_top3: ['min', false, 'Top 3'], record_warm_low: ['min', true, 'Record'], warm_low_top3: ['min', false, 'Top 3'],
};

function tempChart(h, width, mobile) {
  const days = h.days, n = days.length;
  const ext = extent(days, ['max', 'min', 'normal_max', 'normal_min', 'range_max_hi', 'range_min_lo']);
  if (!n || !ext) return null;
  const dates = days.map(d => parseISO(d.date));
  const title = 'Daily high and low, ' + fmtDateRange(dates[0], dates[n - 1]);
  const sub = 'Highs and lows in orange, the ' + h.normal_period + ' normal high to low in darker grey and the ' + h.range_period + ' range in lighter grey. Record days are marked.';
  const ch = makeChart(width, mobile ? 260 : 300, title, sub);
  const M = ch.M, s = ch.svg;
  const slot = (width - M.l - M.r) / n, x = i => M.l + (i + 0.5) * slot;
  const t = niceTicks(ext[0], ext[1], 7), y = scaleY(ch, t);
  s.appendChild(svg('path', {class: 'cw-range', d: bandPath(days, x, y, slot, 'range_max_hi', 'range_min_lo')}));
  s.appendChild(svg('path', {class: 'cw-normal', d: bandPath(days, x, y, slot, 'normal_max', 'normal_min')}));
  const marker = svg('rect', {class: 'cw-sel', x: 0, y: M.t, width: fx(slot), height: ch.H - M.t - M.b});
  marker.style.display = 'none';
  s.appendChild(marker);
  drawGrid(ch, t, y, v => fmtTemp(v));
  dayLabels(ch, dates, x, slot);
  ['max', 'min'].forEach(k => s.appendChild(svg('path', {class: 'cw-line', d: linePath(days, x, y, k)})));
  days.forEach((d, i) => ['max', 'min'].forEach(k => { if (d[k] != null) s.appendChild(svg('circle', {class: 'cw-dot', cx: fx(x(i)), cy: fx(y(d[k])), r: 3})); }));
  const lastLabel = {max: -Infinity, min: -Infinity};
  days.forEach((d, i) => {
    const marks = {};
    (d.flags || []).forEach(f => { const m = FLAG_MARK[f]; if (m && (!marks[m[0]] || m[1])) marks[m[0]] = m; });
    Object.keys(marks).forEach(k => {
      if (d[k] == null) return;
      const m = marks[k], cx = x(i), cy = y(d[k]);
      const bump = cx - lastLabel[k] < 44 ? 12 : 0;      // consecutive flagged days: stagger the labels
      lastLabel[k] = cx;
      s.appendChild(svg('circle', {class: m[1] ? 'cw-dot' : 'cw-ring', cx: fx(cx), cy: fx(cy), r: 5}));
      s.appendChild(svg('text', {class: 'cw-label', x: fx(Math.max(M.l + 20, Math.min(width - M.r - 20, cx))), y: fx(cy + (k === 'max' ? -10 - bump : 18 + bump)), 'text-anchor': 'middle', text: m[2]}));
    });
  });
  const ends = {};
  ['max', 'min'].forEach(k => { for (let i = n - 1; i >= 0; i--) if (days[i][k] != null) { ends[k] = {x: x(i), y: y(days[i][k])}; break; } });
  if (ends.max && ends.min && Math.abs(ends.max.y - ends.min.y) < 16) { ends.max.y -= 8 - (ends.min.y - ends.max.y) / 2; ends.min.y += 8 - (ends.min.y - ends.max.y) / 2; }
  if (ends.max) s.appendChild(svg('text', {class: 'cw-label', x: fx(ends.max.x + 10), y: fx(ends.max.y + 4), text: 'High'}));
  if (ends.min) s.appendChild(svg('text', {class: 'cw-label', x: fx(ends.min.x + 10), y: fx(ends.min.y + 4), text: 'Low'}));
  // Tap or click anywhere on the chart to read a day; arrow keys do the same from the keyboard.
  const detail = el('p', {class: 'cw-detail', 'aria-live': 'polite', text: 'Select a day to see its numbers.'});
  let selected = -1;
  const select = i => {
    selected = Math.max(0, Math.min(n - 1, i));
    marker.setAttribute('x', fx(M.l + selected * slot));
    marker.style.display = '';
    detail.textContent = T.dayDetail(days[selected]);
  };
  s.setAttribute('role', 'group');
  s.setAttribute('tabindex', '0');
  s.setAttribute('aria-label', title + '. Use the left and right arrow keys to read each day.');
  s.addEventListener('click', e => {
    const r = s.getBoundingClientRect();
    select(Math.floor(((e.clientX - r.left) * (width / r.width) - M.l) / slot));
  });
  s.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight') { e.preventDefault(); select(selected < 0 ? 0 : selected + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); select(selected < 0 ? n - 1 : selected - 1); }
    else if (e.key === 'Home') { e.preventDefault(); select(0); }
    else if (e.key === 'End') { e.preventDefault(); select(n - 1); }
  });
  ch.fig.appendChild(detail);
  ch.fig.appendChild(el('ul', {class: 'cw-sr'}, days.map(d => el('li', {text: T.dayDetail(d)}))));
  return ch;
}

function precipChart(h, width) {
  const days = h.days, n = days.length;
  if (!days.some(d => d.precip != null)) return null;
  const ext = extent(days, ['precip', 'normal_precip']);
  let total = 0, normal = 0, counted = 0;
  days.forEach(d => { if (d.precip != null) { total += d.precip; counted++; if (d.normal_precip != null) normal += d.normal_precip; } });
  const lead = counted === n ? 'The fortnight brought ' : 'The ' + numWords(counted) + ' days with observations brought ';
  const sub = 'Daily precipitation in blue-grey; the dashed line is the ' + h.normal_period + ' normal. ' + lead + fmtMeasure(total, 'mm', 1) + (normal > 0 ? ' against a normal of ' + fmtMeasure(normal, 'mm', 1) : '') + '.';
  const ch = makeChart(width, 150, 'Precipitation, mm', sub, {t: 16, b: 40});
  const M = ch.M, s = ch.svg;
  const slot = (width - M.l - M.r) / n, x = i => M.l + (i + 0.5) * slot;
  const t = niceTicks(0, Math.max(1, ext[1]) * 1.08, 3), y = scaleY(ch, t);
  drawGrid(ch, t, y, v => fmtMeasure(v, 'mm', v === 0 || t.step >= 1 ? 0 : 1));
  dayLabels(ch, days.map(d => parseISO(d.date)), x, slot);
  days.forEach((d, i) => {
    if (d.precip == null) return;
    const hgt = y(0) - y(d.precip);
    s.appendChild(svg('rect', {class: 'cw-bar', x: fx(x(i) - slot * 0.3), y: fx(y(d.precip)), width: fx(slot * 0.6), height: fx(Math.max(hgt, d.precip > 0 ? 1 : 0))}));
  });
  s.appendChild(svg('path', {class: 'cw-norm-line', d: linePath(days, x, y, 'normal_precip')}));
  return ch;
}

function gustChart(h, width) {
  const days = h.days, n = days.length;
  let maxI = -1, max = -Infinity;
  days.forEach((d, i) => { if (d.gust != null && d.gust > max) { max = d.gust; maxI = i; } });
  if (maxI < 0) return null;
  const sub = 'The strongest gust was ' + fmtMeasure(max, 'km/h') + ' on ' + fmtDate(parseISO(days[maxI].date)) + '. ECCC does not record gusts under 31 km/h, so calmer days are blank.';
  const ch = makeChart(width, 110, 'Peak gust each day, km/h', sub, {t: 26, b: 40});
  const M = ch.M, s = ch.svg;
  const slot = (width - M.l - M.r) / n, x = i => M.l + (i + 0.5) * slot;
  const t = {min: 0, max: Math.ceil(max * 1.15 / 10) * 10}, y = scaleY(ch, t);
  s.appendChild(svg('line', {class: 'cw-grid', x1: M.l, x2: width - M.r, y1: fx(y(0)), y2: fx(y(0))}));
  dayLabels(ch, days.map(d => parseISO(d.date)), x, slot);
  s.appendChild(svg('path', {class: 'cw-bar-line', d: linePath(days, x, y, 'gust')}));
  days.forEach((d, i) => { if (d.gust != null) s.appendChild(svg('circle', {class: 'cw-bar-dot', cx: fx(x(i)), cy: fx(y(d.gust)), r: 3})); });
  s.appendChild(svg('text', {x: fx(x(maxI)), y: fx(y(max) - 9), 'text-anchor': 'middle', text: fmtMeasure(max, 'km/h')}));
  return ch;
}

function windchillChart(h, width, mobile) {
  const hrs = (h.plus && h.plus.windchill_hourly) || [], n = hrs.length;
  let minI = -1, min = Infinity;
  hrs.forEach((p, i) => { if (p.wind_chill != null && p.wind_chill < min) { min = p.wind_chill; minI = i; } });
  if (minI < 0) return null;
  const ext = extent(hrs, ['temp', 'wind_chill']);
  const times = hrs.map(p => parseISO(p.time)), when = times[minI];
  const sub = 'Hourly temperature in grey and wind chill in orange at ' + T.stationLabel(h.station) + '. ECCC calculates wind chill only when it is cold and windy enough; the coldest in the fortnight was ' + fmtWindchill(min) + ' at ' + fmtTime(when) + ' on ' + fmtDate(when) + '.';
  const ch = makeChart(width, mobile ? 220 : 240, 'Hourly wind chill, ' + fmtDateRange(times[0], times[n - 1]), sub);
  const M = ch.M, s = ch.svg;
  const slot = (width - M.l - M.r) / n, x = i => M.l + (i + 0.5) * slot;
  const t = niceTicks(ext[0], ext[1], 7), y = scaleY(ch, t);
  drawGrid(ch, t, y, v => fmtTemp(v));
  const noons = [];
  times.forEach((p, i) => { if (p.h === 12 && p.mi === 0) noons.push({i: i, p: p}); });
  const dayWidth = noons.length > 1 ? x(noons[1].i) - x(noons[0].i) : slot * 24;
  dayLabels(ch, noons.map(q => q.p), j => x(noons[j].i), dayWidth);
  s.appendChild(svg('path', {class: 'cw-line-2', d: linePath(hrs, x, y, 'temp')}));
  s.appendChild(svg('path', {class: 'cw-line', d: linePath(hrs, x, y, 'wind_chill')}));
  return ch;
}

// ---------------------------------------------------------------- the app

const state = {root: null, standalone: false, current: null, slug: null, offset: DEFAULT_OFFSET, cache: {}, sec: {}, history: null, width: 0};
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
function isoDate(p) { return p.y + '-' + (p.mo < 10 ? '0' : '') + p.mo + '-' + (p.d < 10 ? '0' : '') + p.d; }
function chartWidth() { return Math.max(280, state.root.clientWidth || 710); }

function buildSkeleton() {
  const root = state.root;
  root.textContent = '';
  const H = state.standalone ? 'h1' : 'h2', HS = state.standalone ? 'h2' : 'h3';
  if (state.standalone) root.appendChild(el('p', {class: 'cw-brand'}, ['Weather from ', el('a', {href: 'https://cabinradio.ca', text: 'Cabin Radio'})]));
  state.name = el(H, {class: 'cw-name', text: 'Yellowknife'});
  state.select = el('select');
  state.pick = el('label', {class: 'cw-pick', hidden: true}, [el('span', {text: 'Change community'}), state.select]);
  root.appendChild(el('div', {class: 'cw-head'}, [state.name, state.pick]));
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

function buildSelect() {
  const comms = state.current.communities, byRegion = {};
  Object.keys(comms).forEach(slug => { const c = comms[slug]; (byRegion[c.region] = byRegion[c.region] || []).push({slug: slug, name: c.name}); });
  const sel = state.select;
  sel.textContent = '';
  Object.keys(byRegion).sort((a, b) => a.localeCompare(b)).forEach(region => {
    const group = el('optgroup', {label: region});
    byRegion[region].sort((a, b) => a.name.localeCompare(b.name)).forEach(c => group.appendChild(el('option', {value: c.slug, text: c.name})));
    sel.appendChild(group);
  });
  sel.addEventListener('change', () => { location.hash = sel.value; });
  state.pick.hidden = false;
}

function route() {
  const comms = state.current.communities;
  let slug = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  if (!comms[slug]) slug = comms[DEFAULT_SLUG] ? DEFAULT_SLUG : Object.keys(comms)[0];
  state.slug = slug;
  show(slug);
}

function show(slug) {
  const c = state.current.communities[slug];
  const obs = parseISO(c.observed_at);
  state.offset = obs && obs.off != null ? obs.off : DEFAULT_OFFSET;
  state.history = null;
  state.name.textContent = c.name;
  state.select.value = slug;
  if (state.standalone) document.title = c.name + ' weather ' + EN + ' Cabin Radio';
  renderWarning(c);
  renderNow(c);
  ['hours', 'week', 'fortnight', 'period', 'records'].forEach(hide);
  renderFooter(c, null);
  load('forecast', slug).then(f => { if (state.slug === slug) renderForecast(c, f); }, noop);
  if (c.tier !== 'forecast') load('history', slug).then(h => { if (state.slug === slug) renderHistory(c, h); }, noop);
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

function renderNow(c) {
  const nodes = [];
  const line = el('div', {class: 'cw-now'});
  if (c.temp != null) line.appendChild(el('span', {class: 'cw-big', text: fmtTemp(c.temp)}));
  if (c.condition) line.appendChild(el('span', {class: 'cw-cond', text: c.condition}));
  if (line.childNodes.length) nodes.push(line);
  const facts = T.nowFacts(c);
  if (facts.length) nodes.push(el('ul', {class: 'cw-facts'}, facts.map(f => el('li', {text: f}))));
  const g = parseISO(state.current.generated_at);
  const stale = !!c.stale || (g && (Date.now() - utcMillis(g)) / 36e5 > STALE_HOURS);
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
  const width = chartWidth(), mobile = width < 600;
  state.width = width;
  const nodes = [];
  const charts = [tempChart(h, width, mobile), h.summary ? el('p', {class: 'cw-summary', text: h.summary}) : null, precipChart(h, width), gustChart(h, width), windchillChart(h, width, mobile)];
  charts.forEach(ch => { if (ch) nodes.push(ch.fig || ch); });
  if (nodes.length) fill('fortnight', nodes); else hide('fortnight');
  const nowP = nowParts();
  const lines = [].concat(T.periodLines(h.month), T.periodLines(h.season), T.plusLines(h.plus, nowP));
  if (lines.length) fill('period', [el('ul', {class: 'cw-lines'}, lines.map(s => el('li', {text: s})))]); else hide('period');
  const today = isoDate(nowP);
  const cal = (h.calendar || []).find(r => r.date === today) || (h.calendar || [])[0] || null;
  const recs = T.recordLines(h, cal, c.name);
  if (recs.length) fill('records', [el('ul', {class: 'cw-lines'}, recs.map(s => el('li', {text: s})))]); else hide('records');
  renderFooter(c, h);
}

function renderFooter(c, h) {
  const f = state.foot;
  f.textContent = '';
  f.appendChild(el('p', {text: T.footerLine(c, state.current.generated_at, state.offset)}));
  if (h && h.station) f.appendChild(el('p', {text: 'Climate records from ECCC\'s ' + h.station + ' station, since ' + h.record_start + '.'}));
  if (c.eccc_url) f.appendChild(el('p', null, [el('a', {href: c.eccc_url, text: c.name + ' on weather.gc.ca'})]));
  f.hidden = false;
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

const api = {
  fmt: {roundHalfUp, fmtNumber, fmtTemp, fmtMeasure, fmtWindchill, numWords, fmtPercent, ordinal, fmtRange, cap, sentence,
    parseISO, utcMillis, shift, dayName, fmtDate, fmtTime, fmtDateRange, clock, dateText, anomalyPhrase, isoDate},
  text: T, styleProblems: styleProblems, EN: EN, DAYS: DAYS, MONTHS: MONTHS,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof document !== 'undefined') {
  const script = document.currentScript;
  try { BASE = new URL('.', script && script.src ? script.src : document.baseURI).href; } catch (e) { BASE = './'; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}
})();
