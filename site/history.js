/* Cabin Weather: the past-two-weeks charts and the month, season and record sentences for the six
   history communities. app.js loads this file only when one of them is shown, so forecast-tier
   communities never pay for it. It uses the formatter and DOM helpers app.js publishes as
   window.CabinWeather, and registers itself there as CabinWeather.history. */
(function () {
'use strict';

const CW = (typeof window !== 'undefined' ? window : global).CabinWeather;
const fmtTemp = CW.fmtTemp, fmtMeasure = CW.fmtMeasure, fmtWindchill = CW.fmtWindchill, numWords = CW.numWords, ordinal = CW.ordinal,
  cap = CW.cap, parseISO = CW.parseISO, fmtDate = CW.fmtDate, fmtTime = CW.fmtTime, fmtDateRange = CW.fmtDateRange, dateText = CW.dateText,
  anomalyPhrase = CW.anomalyPhrase, MONTHS = CW.MONTHS, el = CW.el, svg = CW.svg, fx = CW.fx;

// ---------------------------------------------------------------- generated text (pure functions, tested)

// flag -> [which point, is a record, chart label, sentence]
const FLAGS = {
  record_high: ['max', true, 'Record', 'A record high for the date.'],
  high_top3: ['max', false, 'Top 3', 'One of the three warmest highs for the date.'],
  record_low: ['min', true, 'Record', 'A record low for the date.'],
  low_top3: ['min', false, 'Top 3', 'One of the three coldest lows for the date.'],
  record_warm_low: ['min', true, 'Record', 'The warmest overnight low recorded for the date.'],
  warm_low_top3: ['min', false, 'Top 3', 'One of the three warmest overnight lows for the date.'],
  record_cold_high: ['max', true, 'Record', 'The coldest daytime high recorded for the date.'],
  cold_high_top3: ['max', false, 'Top 3', 'One of the three coldest daytime highs for the date.'],
};

const H = {
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
    (d.flags || []).forEach(f => { if (FLAGS[f]) s += ' ' + FLAGS[f][3]; });
    return s;
  },
  stationLabel(s) { return s ? s.replace(/\sA$/, ' Airport') : ''; },
};

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
let uid = 0;
function makeChart(width, H, title, subtitle, margin) {
  const M = Object.assign({t: 24, r: 50, b: 40, l: 44}, margin);
  const capId = 'cw-cap-' + (++uid);
  const s = svg('svg', {class: 'cw-chart', viewBox: '0 0 ' + width + ' ' + H, width: width, height: H, role: 'img', 'aria-label': title, 'aria-describedby': capId, focusable: 'false'});
  const fig = el('figure', null, [el('figcaption', null, [el('b', {text: title}), el('span', {id: capId, text: subtitle})]), s]);
  return {fig: fig, svg: s, M: M, width: width, H: H};
}
function scaleY(ch, t) { return v => ch.M.t + (t.max - v) / (t.max - t.min) * (ch.H - ch.M.t - ch.M.b); }
function drawGrid(ch, t, y, fmt, zero) {   // zero: draw the 0C line darker
  t.values.forEach(v => {
    ch.svg.appendChild(svg('line', {class: 'cw-grid' + (zero && v === 0 ? ' cw-zero' : ''), x1: ch.M.l, x2: ch.width - ch.M.r, y1: fx(y(v)), y2: fx(y(v))}));
    ch.svg.appendChild(svg('text', {x: ch.M.l - 8, y: fx(y(v) + 4), 'text-anchor': 'end', text: fmt(v)}));
  });
}
function dayLabels(ch, dates, x, slot) {      // day numbers, plus the month name where it changes
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

function tempChart(h, width, mobile) {
  const days = h.days, n = days.length;
  const ext = extent(days, ['max', 'min', 'normal_max', 'normal_min', 'range_max_hi', 'range_min_lo']);
  if (!n || !ext) return null;
  const dates = days.map(d => parseISO(d.date));
  const title = 'Daily high and low, ' + fmtDateRange(dates[0], dates[n - 1]);
  const sub = 'Highs in orange and lows in blue, with the ' + h.normal_period + ' normal high to low in darker grey and the ' + h.range_period + ' range in lighter grey. Record days are marked.';
  const ch = makeChart(width, mobile ? 260 : 300, title, sub);
  const M = ch.M, s = ch.svg;
  const slot = (width - M.l - M.r) / n, x = i => M.l + (i + 0.5) * slot;
  const t = niceTicks(ext[0], ext[1], 7), y = scaleY(ch, t);
  s.appendChild(svg('path', {class: 'cw-range', d: bandPath(days, x, y, slot, 'range_max_hi', 'range_min_lo')}));
  s.appendChild(svg('path', {class: 'cw-normal', d: bandPath(days, x, y, slot, 'normal_max', 'normal_min')}));
  const marker = svg('rect', {class: 'cw-sel', x: 0, y: M.t, width: fx(slot), height: ch.H - M.t - M.b});
  marker.style.display = 'none';
  s.appendChild(marker);
  drawGrid(ch, t, y, v => fmtTemp(v), true);
  dayLabels(ch, dates, x, slot);
  const low = k => (k === 'min' ? ' cw-low' : '');
  ['max', 'min'].forEach(k => s.appendChild(svg('path', {class: 'cw-line' + low(k), d: linePath(days, x, y, k)})));
  days.forEach((d, i) => ['max', 'min'].forEach(k => { if (d[k] != null) s.appendChild(svg('circle', {class: 'cw-dot' + low(k), cx: fx(x(i)), cy: fx(y(d[k])), r: 3})); }));
  const lastLabel = {max: -Infinity, min: -Infinity};
  days.forEach((d, i) => {
    const marks = {};
    (d.flags || []).forEach(f => { const m = FLAGS[f]; if (m && (!marks[m[0]] || m[1])) marks[m[0]] = m; });
    Object.keys(marks).forEach(k => {
      if (d[k] == null) return;
      const m = marks[k], cx = x(i), cy = y(d[k]);
      const bump = cx - lastLabel[k] < 44 ? 12 : 0;      // consecutive flagged days: stagger the labels
      lastLabel[k] = cx;
      s.appendChild(svg('circle', {class: 'cw-halo', cx: fx(cx), cy: fx(cy), r: 9}));
      s.appendChild(svg('circle', {class: (m[1] ? 'cw-dot' : 'cw-ring') + low(k), cx: fx(cx), cy: fx(cy), r: 6}));
      s.appendChild(svg('text', {class: 'cw-label' + low(k), x: fx(Math.max(M.l + 20, Math.min(width - M.r - 20, cx))), y: fx(cy + (k === 'max' ? -10 - bump : 18 + bump)), 'text-anchor': 'middle', text: m[2]}));
    });
  });
  const ends = {};
  ['max', 'min'].forEach(k => { for (let i = n - 1; i >= 0; i--) if (days[i][k] != null) { ends[k] = {x: x(i), y: y(days[i][k])}; break; } });
  if (ends.max && ends.min && Math.abs(ends.max.y - ends.min.y) < 16) { ends.max.y -= 8 - (ends.min.y - ends.max.y) / 2; ends.min.y += 8 - (ends.min.y - ends.max.y) / 2; }
  if (ends.max) s.appendChild(svg('text', {class: 'cw-label', x: fx(ends.max.x + 10), y: fx(ends.max.y + 4), text: 'High'}));
  if (ends.min) s.appendChild(svg('text', {class: 'cw-label cw-low', x: fx(ends.min.x + 10), y: fx(ends.min.y + 4), text: 'Low'}));
  // Tap or click anywhere on the chart to read a day; arrow keys do the same from the keyboard.
  const detail = el('p', {class: 'cw-detail', 'aria-live': 'polite', text: 'Select a day to see its numbers.'});
  let selected = -1;
  const select = i => {
    selected = Math.max(0, Math.min(n - 1, i));
    marker.setAttribute('x', fx(M.l + selected * slot));
    marker.style.display = '';
    detail.textContent = H.dayDetail(days[selected]);
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
  ch.fig.appendChild(el('ul', {class: 'cw-sr'}, days.map(d => el('li', {text: H.dayDetail(d)}))));
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
  s.appendChild(svg('path', {class: 'cw-line-cold', d: linePath(days, x, y, 'gust')}));
  days.forEach((d, i) => { if (d.gust != null) s.appendChild(svg('circle', {class: 'cw-bar', cx: fx(x(i)), cy: fx(y(d.gust)), r: 3})); });
  s.appendChild(svg('text', {x: fx(x(maxI)), y: fx(y(max) - 9), 'text-anchor': 'middle', text: fmtMeasure(max, 'km/h')}));
  return ch;
}

function windchillChart(h, width, mobile, c) {
  const hrs = (h.plus && h.plus.windchill_hourly) || [], n = hrs.length;
  let minI = -1, min = Infinity;
  hrs.forEach((p, i) => { if (p.wind_chill != null && p.wind_chill < min) { min = p.wind_chill; minI = i; } });
  if (minI < 0) return null;
  const ext = extent(hrs, ['temp', 'wind_chill']);
  const times = hrs.map(p => parseISO(p.time)), when = times[minI];
  const sub = 'Hourly temperature in orange above freezing and light blue below it, with wind chill in dark blue, at ' + H.stationLabel(h.station) + '. Nights are shaded. ECCC calculates wind chill only when it is cold and windy enough; the coldest in the fortnight was ' + fmtWindchill(min) + ' at ' + fmtTime(when) + ' on ' + fmtDate(when) + '.';
  const ch = makeChart(width, mobile ? 220 : 240, 'Hourly wind chill, ' + fmtDateRange(times[0], times[n - 1]), sub);
  const M = ch.M, s = ch.svg;
  const slot = (width - M.l - M.r) / n, x = i => M.l + (i + 0.5) * slot;
  const t = niceTicks(ext[0], ext[1], 7), y = scaleY(ch, t);
  let start = -1;                                    // shade each run of night hours
  times.forEach((p, i) => {
    const night = c ? CW.isNight(p, c) : false;
    if (night && start < 0) start = i;
    if (start >= 0 && (!night || i === n - 1)) {
      const end = night ? i : i - 1;
      s.appendChild(svg('rect', {class: 'cw-nightband', x: fx(x(start) - slot / 2), y: M.t, width: fx(x(end) - x(start) + slot), height: ch.H - M.t - M.b}));
      start = -1;
    }
  });
  drawGrid(ch, t, y, v => fmtTemp(v), true);
  const noons = [];
  times.forEach((p, i) => { if (p.h === 12 && p.mi === 0) noons.push({i: i, p: p}); });
  const dayWidth = noons.length > 1 ? x(noons[1].i) - x(noons[0].i) : slot * 24;
  dayLabels(ch, noons.map(q => q.p), j => x(noons[j].i), dayWidth);
  const clipId = 'cw-clip-' + (++uid);                 // orange above freezing, light blue below
  s.appendChild(svg('clipPath', {id: clipId}, [svg('rect', {x: 0, y: 0, width: width, height: fx(Math.max(0, y(0)))})]));
  s.appendChild(svg('path', {class: 'cw-line-cold', d: linePath(hrs, x, y, 'temp')}));
  s.appendChild(svg('path', {class: 'cw-line', 'clip-path': 'url(#' + clipId + ')', d: linePath(hrs, x, y, 'temp')}));
  s.appendChild(svg('path', {class: 'cw-line cw-wc', d: linePath(hrs, x, y, 'wind_chill')}));
  return ch;
}

// ---------------------------------------------------------------- render the three history sections

function render(c, h) {
  const width = CW.chartWidth(), mobile = width < 600;
  const nodes = [];
  [tempChart(h, width, mobile), h.summary ? el('p', {class: 'cw-summary', text: h.summary}) : null, precipChart(h, width), gustChart(h, width), windchillChart(h, width, mobile, c)]
    .forEach(x => { if (x) nodes.push(x.fig || x); });
  if (nodes.length) CW.fill('fortnight', nodes); else CW.hide('fortnight');
  const nowP = CW.nowParts();
  const lines = [].concat(H.periodLines(h.month), H.periodLines(h.season), H.plusLines(h.plus, nowP));
  if (lines.length) CW.fill('period', [el('ul', {class: 'cw-lines'}, lines.map(s => el('li', {text: s})))]); else CW.hide('period');
  const today = CW.isoDate(nowP);
  const cal = (h.calendar || []).find(r => r.date === today) || (h.calendar || [])[0] || null;
  const recs = H.recordLines(h, cal, c.name);
  if (recs.length) CW.fill('records', [el('ul', {class: 'cw-lines'}, recs.map(s => el('li', {text: s})))]); else CW.hide('records');
  CW.renderFooter(c, h);
}

CW.history = {render: render, text: H};
if (typeof module !== 'undefined' && module.exports) module.exports = CW.history;
})();
