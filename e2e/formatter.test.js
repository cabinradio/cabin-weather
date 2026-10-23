// One test per house-style rule in docs/implementation-plan.md section 7, for the front-end
// formatter in site/app.js, plus a sweep of every generated sentence over frozen live fixtures.
// Runs with Node's own test runner: `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CW = require('../site/app.js');
global.CabinWeather = CW;                      // history.js registers itself here, as it does in the browser
const H = require('../site/history.js').text;
const fmt = CW, text = CW.text, EN = CW.EN, DAYS = CW.DAYS;

// The style check mirrors pipeline/formatters.py style_problems(). It is a test tool, not shipped.
const STYLE_RULES = [
  ['em dash', /\u2014/],
  ['degree sign', /[\u00b0\u2103]/],
  ['Unicode minus', /\u2212/],
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
const styleProblems = t => STYLE_RULES.filter(r => r[1].test(t)).map(r => r[0]);
const fixture = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8'));
const current = fixture('current.json');
const forecast = fixture('forecast-yellowknife.json');
const history = fixture('history-yellowknife.json');
const yk = current.communities.yellowknife;
const d = s => fmt.parseISO(s);

test('temperatures: figure then C, no degree sign, hyphen-minus, half rounds up', () => {
  assert.equal(fmt.fmtTemp(20), '20C');
  assert.equal(fmt.fmtTemp(-20), '-20C');
  assert.equal(fmt.fmtTemp(-20.4), '-20C');
  assert.equal(fmt.fmtTemp(-0.4), '0C');
  assert.equal(fmt.fmtTemp(2.5), '3C');
  assert.equal(fmt.fmtTemp(3.25, 1), '3.3C');
  assert.equal(fmt.fmtTemp(null), null);
  assert.doesNotMatch(fmt.fmtTemp(-31.2), /[°−]/);
});

test('measurements: number, space, unit', () => {
  assert.equal(fmt.fmtMeasure(25, 'km/h'), '25 km/h');
  assert.equal(fmt.fmtMeasure(0.4, 'mm', 1), '0.4 mm');
  assert.equal(fmt.fmtMeasure(12, 'cm'), '12 cm');
  assert.equal(fmt.fmtMeasure(null, 'mm'), null);
});

test('wind chill is a bare number', () => {
  assert.equal(fmt.fmtWindchill(-31), '-31');
  assert.equal(fmt.fmtWindchill(-30.6), '-31');
});

test('dates: October 5; Monday, October 5; October 5, 2025; ranges with an en dash', () => {
  assert.equal(fmt.fmtDate(d('2025-10-05')), 'October 5');
  assert.equal(fmt.fmtDate(d('2025-10-05'), { weekday: true }), 'Sunday, October 5');
  assert.equal(fmt.fmtDate(d('2025-10-05'), { year: true }), 'October 5, 2025');
  assert.doesNotMatch(fmt.fmtDate(d('2025-10-04')), /th/);
  assert.equal(fmt.fmtDateRange(d('2026-10-01'), d('2026-10-18')), `October 1${EN}18`);
  assert.equal(fmt.fmtDateRange(d('2026-09-28'), d('2026-10-11')), `September 28 ${EN} October 11`);
});

test('times: 4pm, 8:30am, noon, midnight, MT; compact 12pm and 12am; never 24-hour', () => {
  assert.equal(fmt.fmtTime({ h: 16, mi: 0 }), '4pm');
  assert.equal(fmt.fmtTime({ h: 8, mi: 30 }), '8:30am');
  assert.equal(fmt.fmtTime({ h: 12, mi: 0 }), 'noon');
  assert.equal(fmt.fmtTime({ h: 0, mi: 0 }), 'midnight');
  assert.equal(fmt.fmtTime({ h: 12, mi: 0 }, { compact: true }), '12pm');
  assert.equal(fmt.fmtTime({ h: 0, mi: 0 }, { compact: true }), '12am');
  assert.equal(fmt.fmtTime({ h: 12, mi: 5 }), '12:05pm');
  assert.equal(fmt.fmtTime({ h: 0, mi: 30 }), '12:30am');
  assert.equal(fmt.fmtTime({ h: 21, mi: 40 }, { tz: true }), '9:40pm MT');
  assert.equal(fmt.fmtTime(d('2026-10-19T16:00-06:00')), '4pm');
});

test('timestamps are shown as the wall clock the pipeline wrote, never the browser zone', () => {
  assert.equal(fmt.fmtTime(d('2026-10-21T08:00-06:00')), '8am');
  const g = d('2026-10-21T14:32:11Z');
  assert.equal(fmt.fmtTime(fmt.shift(fmt.utcMillis(g), -360), { tz: true }), '8:32am MT');
  assert.equal(text.footerLine(yk, current.generated_at, -360), 'Based on Environment and Climate Change Canada data. Observations from Yellowknife Airport. Updated 8:32am MT.');
});

test('never today, yesterday or tomorrow: always the day name', () => {
  assert.ok(DAYS.includes(fmt.dayName(d('2026-10-21'))));
  assert.equal(fmt.dayName(d('2026-10-21')), 'Wednesday');
  assert.deepEqual(styleProblems('Today will be sunny'), ['today/yesterday/tomorrow']);
  assert.deepEqual(styleProblems('Monday will be sunny'), []);
  assert.equal(text.observedLine(yk, d('2026-10-21T10:00-06:00')), 'Observed at Yellowknife Airport, 8am.');
  assert.equal(text.observedLine(yk, d('2026-10-22T01:00-06:00')), 'Observed at Yellowknife Airport, 8am on Wednesday.');
});

test('dashes: en dash without spaces for ranges, never an em dash', () => {
  assert.equal(fmt.fmtRange(1991, 2020), `1991${EN}2020`);
  assert.ok(styleProblems('The high — a record — came at 4pm').includes('em dash'));
  assert.ok(styleProblems('1991 - 2020').includes('hyphen used as a range or break'));
  assert.deepEqual(styleProblems(`1991${EN}2020`), []);
});

test('numbers: one to nine in words, 10 and up in digits, thousands comma, percent not %', () => {
  assert.equal(fmt.numWords(1), 'one');
  assert.equal(fmt.numWords(9), 'nine');
  assert.equal(fmt.numWords(10), '10');
  assert.equal(fmt.numWords(1000), '1,000');
  assert.equal(fmt.fmtPercent(30), '30 percent');
  assert.ok(styleProblems('30% chance').includes('percent sign'));
  assert.ok(styleProblems('over 20 records').includes("'over' before a number"));
  assert.deepEqual(styleProblems('more than 20 records'), []);
});

test('ordinals', () => {
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111, 112].map(fmt.ordinal),
    ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '111th', '112th']);
});

test('NWT never NT; abbreviations without periods; OK not okay; under way two words', () => {
  assert.ok(styleProblems('Snow across NT').includes('NT for the territory'));
  assert.deepEqual(styleProblems('Snow across the NWT'), []);
  assert.ok(styleProblems('at 4pm M.T.').includes('abbreviation with periods'));
  assert.ok(styleProblems('That is okay').includes('okay'));
  assert.ok(styleProblems('Winter is underway').includes('underway as one word'));
  assert.deepEqual(styleProblems('Winter is under way'), []);
  assert.ok(styleProblems('Low minus 6').includes("'minus' before a temperature"));
  assert.ok(styleProblems('5°C').includes('degree sign'));
  assert.ok(styleProblems('A record!').includes('exclamation mark'));
});

test('anomaly phrase', () => {
  assert.equal(fmt.anomalyPhrase(1.5), 'about 1.5C above normal');
  assert.equal(fmt.anomalyPhrase(-2.0), 'about 2C below normal');
  assert.equal(fmt.anomalyPhrase(0.3), 'close to normal');
  assert.equal(fmt.anomalyPhrase(-0.49), 'close to normal');
  assert.equal(fmt.anomalyPhrase(null), null);
});

test('Now: wind in words, gusts, wind chill as a bare number, humidity in percent', () => {
  assert.deepEqual(text.nowFacts(yk), ['Wind 16 km/h from the south-southwest', 'Humidity 70 percent']);
  const cold = Object.assign({}, yk, { wind_kmh: 25, wind_gust_kmh: 40, wind_dir: 'N', wind_chill: -31.4, humidity: null });
  assert.deepEqual(text.nowFacts(cold), ['Wind 25 km/h from the north, gusting to 40 km/h', 'Wind chill -31']);
  assert.deepEqual(text.nowFacts(Object.assign({}, yk, { wind_kmh: 0, humidity: null })), ['Calm']);
  assert.deepEqual(text.nowFacts(Object.assign({}, yk, { wind_kmh: null, humidity: null, humidex: 32 })), ['Humidex 32']);
});

test('overview wind: compact, direction as given, gusts', () => {
  assert.equal(text.windShort(yk), '16 km/h SSW');
  assert.equal(text.windShort(Object.assign({}, yk, { wind_gust_kmh: 40 })), '16 km/h SSW, gusts 40');
  assert.equal(text.windShort(Object.assign({}, yk, { wind_kmh: 0 })), 'Calm');
  assert.equal(text.windShort(Object.assign({}, yk, { wind_dir: 'VR' })), '16 km/h variable');
  assert.equal(text.windShort(Object.assign({}, yk, { wind_kmh: null })), null);
  assert.equal(text.footerLine(null, current.generated_at, -360), 'Based on Environment and Climate Change Canada data. Updated 8:32am MT.');
});

test('warnings: one quiet line, titles linked', () => {
  assert.equal(text.warningLine(yk), null);
  const w = text.warningLine(Object.assign({}, yk, { warnings: [{ type: 'warning', title: 'Wind warning', url: 'https://weather.gc.ca/x' }] }));
  assert.deepEqual(w, { items: [{ title: 'Wind warning', url: 'https://weather.gc.ca/x' }], tail: ' in effect for Yellowknife.' });
  const ended = text.warningLine(Object.assign({}, yk, { warnings: [{ type: 'ended', title: 'Wind warning', url: 'https://weather.gc.ca/x' }] }));
  assert.equal(ended.tail, ' has ended.');
});

test('This week: day name never Today, one-line text, high/low handling', () => {
  const first = forecast.daily[0];
  assert.ok(DAYS.includes(first.day));
  assert.equal(text.weekText(first), 'Clearing. Clear overnight.');
  assert.deepEqual(text.weekTemps(first), { high: '10C', low: '-4C' });
  assert.deepEqual(text.weekTemps({ high: -2, low: null }), { high: 'High -2C', low: null });
  assert.deepEqual(text.weekTemps({ high: null, low: -7 }), { high: 'Low -7C', low: null });
  assert.equal(text.weekText({ day_summary: null, night_summary: 'Cloudy periods' }), 'Cloudy periods overnight.');
  assert.equal(text.sunLine(yk), 'Sunrise 8:39am, sunset 6:03pm.');
});

test('month and season lines', () => {
  const m = H.periodLines(history.month);
  assert.equal(m[0], `October 1${EN}20 averaged 2.5C, about 1.9C above normal. That is the 22nd warmest October 1${EN}20 in 84 years.`);
  assert.equal(m[1], 'Precipitation was 6.5 mm against a normal of 18.4 mm, the 74th wettest in 84 years.');
  assert.equal(m[2], `Warmest October 1${EN}20 on record: 5.8C in 2023. Coldest: -5.3C in 1974. Wettest: 80.5 mm in 1967.`);
  const s = H.periodLines(history.season);
  assert.equal(s[0], 'Autumn so far, since September 1, averaged 6.3C, about 1.4C above normal. That is the 14th warmest autumn so far in 85 years.');
  assert.deepEqual(H.periodLines(null), []);
});

test('plus lines: days since -30C, first frost, first snow, snow on the ground', () => {
  const now = d('2026-10-21T10:00-06:00');
  assert.deepEqual(H.plusLines(history.plus, now), [
    'It has been 209 days since the last -30C night, on March 25.',
    'The first frost of the season came on September 16.',
    'No -10C night or snow yet this season.',
  ]);
  const winter = Object.assign({}, history.plus, { days_since_minus30: 1, last_minus30: '2026-10-20', first_minus10: '2026-10-25', first_snow: '2026-10-26', snow_on_ground: 12, snow_on_ground_date: '2026-10-28', season_snowfall: 14.2 });
  assert.deepEqual(H.plusLines(winter, now), [
    'It has been one day since the last -30C night, on October 20.',
    'The first frost of the season came on September 16.',
    'The first -10C night came on October 25.',
    'The first snow came on October 26.',
    'Snow on the ground: 12 cm on October 28.',
    'Snowfall since August 1: 14.2 cm.',
  ]);
  assert.equal(H.plusLines(Object.assign({}, history.plus, { last_minus30: '2025-03-25' }), now)[0], 'It has been 209 days since the last -30C night, on March 25, 2025.');
  assert.deepEqual(H.plusLines(null, now), []);
});

test('record lines: all-time with dates, and the record for the calendar day', () => {
  const r = H.recordLines(history, history.calendar[0], 'Yellowknife');
  assert.equal(r[0], "Yellowknife's highest temperature since 1942 is 32.6C, on August 2, 2021, and its lowest -51.2C, on January 31, 1947.");
  assert.equal(r[1], 'The wettest day brought 82.8 mm, on August 15, 1973. The strongest gust on record is 113 km/h, on November 23, 1956.');
  assert.equal(r[2], 'On October 21 the record high is 10.7C, set in 1998, and the record low -17.8C, set in 1956. The wettest October 21 brought 13.2 mm in 1989.');
});

test('chart day detail', () => {
  const day = history.days.find(x => x.date === '2026-10-16');
  assert.equal(H.dayDetail(day), 'Friday, October 16: high 8.3C, low 3.4C. Normal 1.3C and -3.4C. Precipitation 0.4 mm. Peak gust 45 km/h. Record high 14.4C in 1963, record low -16.9C in 2002. One of the three warmest highs for the date. One of the three warmest overnight lows for the date.');
});

test('every generated sentence over the live fixtures passes the style check', () => {
  const now = d('2026-10-21T10:00-06:00');
  const sentences = [].concat(
    text.nowFacts(yk), [text.observedLine(yk, now), text.sunLine(yk), text.footerLine(yk, current.generated_at, -360), history.summary],
    forecast.daily.map(text.weekText),
    H.periodLines(history.month), H.periodLines(history.season), H.plusLines(history.plus, now),
    H.recordLines(history, history.calendar[0], 'Yellowknife'),
    history.days.map(H.dayDetail),
  );
  for (const s of sentences) {
    assert.ok(s && s.length, 'empty sentence');
    assert.deepEqual(styleProblems(s), [], s);
  }
  for (const slug of Object.keys(current.communities)) {
    const c = current.communities[slug];
    for (const s of text.nowFacts(c).concat([text.observedLine(c, now), text.footerLine(c, current.generated_at, -360)])) {
      if (s) assert.deepEqual(styleProblems(s), [], `${slug}: ${s}`);
    }
  }
});
