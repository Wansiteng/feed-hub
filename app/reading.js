/* 阅读记录：在阅读器和简报上实际读了多久，按天、按篇记下，存在 config/reading.json（改它不触发运行），换设备也在。
 * 只算页面在前台、两分钟内有过操作（滚动、点按、按键）的时间；一次不到 5 秒的不记（点开马上返回）。
 * 本机先记（localStorage），离开文章、切到后台时写进仓库，写不成就留着下次再写。
 * 写的是「这台设备这一天这一篇一共读了多少秒」，和仓库里的取较大值：重写几次结果都一样，不会重复累加；
 * 代价是两台设备同一天读同一篇时只算读得久的那台。 */
import { readConfig, writeConfig, explain } from './api.js';
import { S, changed, storage } from './store.js';

const FILE = 'reading.json';
const LOCAL_KEY = 'feedhub.reading.local.v1';
const CACHE_KEY = 'feedhub.cache.reading.v1';
const TICK_MS = 5000;
const IDLE_MS = 120e3; // 这么久没有操作就当人走开了
const MIN_SESSION = 5; // 秒：一次读不到这么久的不记
export const READ_MIN = 15; // 秒：一篇读够这么久才算「读过」
const KEEP_DAYS = 400; // 仓库里留多少天
const LOCAL_DAYS = 3; // 本机留多少天（接着往上加，和仓库取较大值）
const MAX_BYTES = 600e3; // 文件太大时去掉最早那些文章的标题（GitHub 的接口读 1 MB 以上的文件要另外处理）
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 本机日期（YYYY-MM-DD）。 */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 简报的记录键：和文章 id 区分开。 */
export const editionKey = (id) => `b:${id}`;
export const isEditionKey = (key) => key.startsWith('b:');

function empty() {
  return { days: {}, items: {} };
}

function normalize(d) {
  const out = empty();
  for (const [day, m] of Object.entries(d?.days && typeof d.days === 'object' ? d.days : {})) {
    if (!DAY_RE.test(day) || !m || typeof m !== 'object') continue;
    const clean = {};
    for (const [k, v] of Object.entries(m)) if (Number.isFinite(v) && v > 0) clean[k] = v;
    out.days[day] = clean;
  }
  for (const [k, v] of Object.entries(d?.items && typeof d.items === 'object' ? d.items : {})) {
    if (v && typeof v === 'object') out.items[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 本机

function readJson(key) {
  try { return JSON.parse(storage.get(key) || 'null'); } catch { return null; }
}

let local = null;
function localData() {
  if (!local || local.repo !== S.repo) {
    const saved = readJson(LOCAL_KEY);
    local = saved && saved.repo === S.repo
      ? { ...normalize(saved), repo: S.repo, rev: saved.rev || 0, dirty: Boolean(saved.dirty) }
      : { ...empty(), repo: S.repo, rev: 0, dirty: false };
  }
  return local;
}

function saveLocal() {
  storage.set(LOCAL_KEY, JSON.stringify(local));
}

/** 仓库里的记录（本机缓存先用上）。 */
function remote() {
  if (S.readingRepo !== S.repo) {
    const c = readJson(CACHE_KEY);
    S.reading = c && c.repo === S.repo ? normalize(c.data) : null;
    S.readingRepo = S.repo;
  }
  return S.reading;
}

function setRemote(data) {
  S.reading = data;
  S.readingRepo = S.repo;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ repo: S.repo, data }));
  } catch {
    storage.del(CACHE_KEY);
  }
  changed('reading');
}

/** 合起来的记录：仓库里的加上本机还没写进去的。页面都用这个。 */
export function readingData() {
  return merge(remote() || empty(), localData());
}

function merge(base, extra) {
  const out = { days: {}, items: { ...base.items } };
  for (const [day, m] of Object.entries(base.days)) out.days[day] = { ...m };
  for (const [day, m] of Object.entries(extra.days)) {
    const d = out.days[day] || (out.days[day] = {});
    for (const [k, sec] of Object.entries(m)) d[k] = Math.max(d[k] || 0, Math.round(sec));
  }
  for (const [k, meta] of Object.entries(extra.items)) out.items[k] = { ...out.items[k], ...meta };
  return out;
}

/** 只留最近 KEEP_DAYS 天；用不到的文章信息去掉；太大时去掉最早那些文章的标题。 */
function prune(data) {
  const cutoff = dayKey(new Date(Date.now() - KEEP_DAYS * 86400e3));
  const lastDay = {};
  for (const day of Object.keys(data.days).sort()) {
    if (day < cutoff) { delete data.days[day]; continue; }
    for (const k of Object.keys(data.days[day])) lastDay[k] = day;
  }
  for (const k of Object.keys(data.items)) if (!lastDay[k]) delete data.items[k];
  const size = () => new TextEncoder().encode(JSON.stringify(data)).length;
  if (size() <= MAX_BYTES) return data;
  const oldest = Object.keys(lastDay).sort((a, b) => (lastDay[a] < lastDay[b] ? -1 : 1));
  for (let i = 0; i < oldest.length; i += 100) {
    for (const k of oldest.slice(i, i + 100)) delete data.items[k]?.t;
    if (size() <= MAX_BYTES) break;
  }
  return data;
}

function add(key, meta, sec) {
  const L = localData();
  const day = dayKey();
  const d = L.days[day] || (L.days[day] = {});
  d[key] = (d[key] || 0) + sec;
  L.items[key] = { ...meta, t: String(meta.t || '').slice(0, 80) };
  L.rev += 1;
  L.dirty = true;
  saveLocal();
  changed('reading');
}

// ---------------------------------------------------------------- 计时

let activeAt = Date.now();
const sessions = new Set();
const poke = () => { activeAt = Date.now(); };
for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) {
  window.addEventListener(type, poke, { passive: true, capture: true });
}
function onHide() {
  sessions.forEach((s) => s.tick());
  flushReading(); // 尽量写进去；没写成的本机留着
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    onHide();
  } else {
    poke();
    sessions.forEach((s) => s.resume()); // 在后台的时间不算
  }
});
window.addEventListener('pagehide', onHide);

/**
 * 开始记一篇文章（或一期简报）的阅读时间，返回停止的函数。
 * meta：{ t: 标题, f: 来源, g: 分组, k: 'edition' }，统计页面用来显示和归类。
 */
export function trackReading(key, meta) {
  let last = performance.now();
  let total = 0;
  let pending = 0; // 不到 MIN_SESSION 时先攒着
  const s = {
    tick() {
      const now = performance.now();
      const dt = Math.min((now - last) / 1000, TICK_MS / 1000 + 1); // 设备睡眠醒来时不会一下多出很多
      last = now;
      if (document.visibilityState !== 'visible' || Date.now() - activeAt > IDLE_MS) return;
      total += dt;
      pending += dt;
      if (total >= MIN_SESSION) {
        add(key, meta, pending);
        pending = 0;
      }
    },
    resume() { last = performance.now(); },
  };
  sessions.add(s);
  poke();
  const timer = setInterval(() => s.tick(), TICK_MS);
  return function stop() {
    if (!sessions.has(s)) return;
    s.tick();
    clearInterval(timer);
    sessions.delete(s);
    if (total >= MIN_SESSION) flushSoon(2000);
  };
}

// ---------------------------------------------------------------- 写进仓库

let base = null; // 最近一次读到 / 写进去的：{ data, sha, repo }
let flushing = null;
let flushTimer = 0;

async function fetchRemote() {
  try {
    const f = await readConfig(FILE);
    return { data: normalize(f.data), sha: f.sha, repo: S.repo };
  } catch (e) {
    if (e.status === 404) return { data: empty(), sha: undefined, repo: S.repo }; // 还没有，第一次写时新建
    throw e;
  }
}

/** 读仓库里的记录（「我的」和阅读记录页面打开时）。 */
export async function loadReading() {
  if (flushing) return flushing;
  try {
    const fetched = await fetchRemote();
    if (flushing) return flushing; // 读的时候开始写了：写完的更新
    base = fetched;
    S.readingError = '';
    setRemote(base.data);
  } catch (e) {
    S.readingError = explain(e);
    changed('reading');
  }
}

function flushSoon(delay) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushReading(); }, delay);
}

/** 把本机记下的写进仓库。别的设备同时写过（sha 对不上）就读最新的再合一次。 */
export function flushReading() {
  clearTimeout(flushTimer);
  const L = localData();
  if (!L.dirty || !S.token || !S.repo) return Promise.resolve();
  if (flushing) return flushing.then(() => flushReading());
  const rev = L.rev;
  flushing = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      if (!base || base.repo !== S.repo || attempt) base = await fetchRemote();
      const data = prune(merge(base.data, L));
      try {
        const sha = await writeConfig(FILE, data, base.sha, `阅读记录：${dayKey()}`, { compact: true });
        base = { data, sha, repo: S.repo };
        break;
      } catch (e) {
        if (attempt >= 2 || (e.status !== 409 && e.status !== 422)) throw e;
      }
    }
    if (L.rev === rev) L.dirty = false; // 写的时候又记了新的：留到下次
    const keep = dayKey(new Date(Date.now() - (LOCAL_DAYS - 1) * 86400e3));
    for (const day of Object.keys(L.days)) if (day < keep) delete L.days[day];
    const used = new Set(Object.values(L.days).flatMap((m) => Object.keys(m)));
    for (const k of Object.keys(L.items)) if (!used.has(k)) delete L.items[k];
    saveLocal();
    setRemote(base.data);
  })().catch(() => { /* 连不上：本机记着，下次再写 */ }).finally(() => { flushing = null; });
  return flushing;
}

/** 打开管理页面时：上次没写进去的接着写。 */
export function resumeReading() {
  if (localData().dirty) flushSoon(5000);
}

// ---------------------------------------------------------------- 统计

/** 某一天读了多少秒。 */
export function daySeconds(data, day) {
  return Object.values(data.days[day] || {}).reduce((s, v) => s + v, 0);
}

/** 颜色深浅：0 没读，1 不到 5 分钟，2 不到 15 分钟，3 不到半小时，4 半小时以上。 */
export function heatLevel(sec) {
  if (sec < 1) return 0;
  if (sec < 300) return 1;
  if (sec < 900) return 2;
  if (sec < 1800) return 3;
  return 4;
}

/** 25 分钟、1 小时 20 分、不到 1 分钟。 */
export function fmtDuration(sec) {
  const m = Math.round((Number(sec) || 0) / 60);
  if (sec > 0 && m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  const hr = Math.floor(m / 60);
  return m % 60 ? `${hr} 小时 ${m % 60} 分` : `${hr} 小时`;
}

function shiftDay(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** 连续阅读：当前连续几天（今天还没读不算断）、最长连续几天。 */
export function streaks(data) {
  const read = new Set(Object.keys(data.days).filter((d) => daySeconds(data, d) > 0));
  const today = dayKey();
  let cur = 0;
  for (let d = read.has(today) ? today : shiftDay(today, -1); read.has(d); d = shiftDay(d, -1)) cur += 1;
  let best = 0;
  for (const d of read) {
    if (read.has(shiftDay(d, -1))) continue; // 只从每段的第一天往后数
    let n = 0;
    for (let x = d; read.has(x); x = shiftDay(x, 1)) n += 1;
    best = Math.max(best, n);
  }
  return { current: cur, best };
}

/** 一段日期（含 from、to）里的汇总：总时长、每篇读了多少、按分组 / 来源。 */
export function summarize(data, from, to = dayKey()) {
  const per = {};
  let seconds = 0;
  let days = 0;
  for (const [day, m] of Object.entries(data.days)) {
    if (day < from || day > to) continue;
    let any = false;
    for (const [k, v] of Object.entries(m)) {
      per[k] = (per[k] || 0) + v;
      seconds += v;
      any = any || v > 0;
    }
    if (any) days += 1;
  }
  const keys = Object.keys(per);
  const articles = keys.filter((k) => !isEditionKey(k) && per[k] >= READ_MIN);
  const editions = keys.filter((k) => isEditionKey(k) && per[k] >= READ_MIN);
  const by = (field) => {
    const out = {};
    for (const k of keys) {
      const meta = data.items[k] || {};
      const name = isEditionKey(k) ? (field === 'g' ? '__edition' : '') : meta[field] || '';
      if (!name) continue;
      out[name] = (out[name] || 0) + per[k];
    }
    return Object.entries(out).sort((a, b) => b[1] - a[1]);
  };
  return { seconds, days, per, articles, editions, groups: by('g'), sources: by('f') };
}
