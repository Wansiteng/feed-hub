/* 全局状态和数据操作。页面通过 onChange 订阅，数据变化时自行刷新需要更新的部分。 */
import {
  fetchRepo, fetchUser, readConfig, writeConfig, readData, listWorkflowRuns, dispatchWorkflow, explain,
} from './api.js';
import { toast } from '../assets/ui.js';

export const CFG = window.FEEDHUB || {};

const KEYS = {
  token: 'feedhub.token', repo: 'feedhub.repo', sidebar: 'feedhub.sidebar', font: 'feedhub.readingFont',
  size: 'feedhub.readingSize', read: 'feedhub.read', cache: 'feedhub.cache.v1', cacheItems: 'feedhub.cache.items.v1',
  translating: 'feedhub.translating',
};
export const READING_SIZES = ['sm', 'md', 'lg', 'xl'];
const READ_MAX = 3000; // 本机记住多少篇已读

export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 隐私模式等 */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export const S = {
  token: storage.get(KEYS.token) || '',
  repo: storage.get(KEYS.repo) || CFG.repo || '',
  branch: 'main',
  user: null,
  feeds: null, feedsSha: null, feedsDirty: false,
  settings: null, settingsSha: null, settingsDirty: false,
  feedStatus: null, runs: null,
  items: null, itemsLoading: false, itemsError: '', itemsAt: 0,
  briefings: null, briefingsLoading: false, briefingsError: '', briefingsAt: 0,
  interestHistory: null,
  configFresh: false, // 配置是这次从 GitHub 读到的（不是本机缓存）；读到之前不能保存
  wfRuns: null, wfError: '',
  readingFont: storage.get(KEYS.font) === 'sans' ? 'sans' : 'serif',
  readingSize: READING_SIZES.includes(storage.get(KEYS.size)) ? storage.get(KEYS.size) : 'md',
  sidebarCollapsed: storage.get(KEYS.sidebar) === 'collapsed',
  read: loadRead(),
  translating: loadTranslating(), // 点过「翻译」、还在等的文章：{ id: 请求时间 }
};

// ---------------------------------------------------------------- 本机缓存
// 打开时先显示上次读到的简报和文章，同时在后台取最新的（手机上打开就能读，不用等网络）。
// 缓存只在这台设备上，读写失败（隐私模式、空间不够）就当没有缓存。

function readCache(key) {
  try {
    const c = JSON.parse(storage.get(key) || 'null');
    return c && c.repo === S.repo ? c : null;
  } catch {
    return null;
  }
}

function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ repo: S.repo, ...data }));
  } catch {
    storage.del(key); // 多半是空间不够：宁可没有缓存，也不留一份旧的
  }
}

function saveCache() {
  writeCache(KEYS.cache, { branch: S.branch, feeds: S.feeds, settings: S.settings, user: S.user, briefings: S.briefings });
}

/** 有上次的缓存就先用上；返回是否用上了。 */
function hydrate() {
  if (!S.token || !S.repo) return false;
  const c = readCache(KEYS.cache);
  if (!c?.feeds || !c?.settings) return false;
  Object.assign(S, { branch: c.branch || S.branch, feeds: c.feeds, settings: c.settings, user: c.user, briefings: c.briefings || null });
  S.items = readCache(KEYS.cacheItems)?.items || null;
  return true;
}

export const fromCache = hydrate();

function loadRead() {
  try {
    const ids = JSON.parse(storage.get(KEYS.read) || '[]');
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------- 订阅

const listeners = new Set();
const pending = new Set();
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
/** what：'config' | 'status' | 'items' | 'briefings' | 'runs' | 'dirty' | 'prefs' | 'feedback' | 'read' */
export function changed(what) {
  pending.add(what);
  if (pending.size > 1) return;
  queueMicrotask(() => {
    const batch = new Set(pending);
    pending.clear();
    for (const fn of listeners) fn(batch);
  });
}

// ---------------------------------------------------------------- 本机偏好

export function setReadingSize(size) {
  S.readingSize = READING_SIZES.includes(size) ? size : 'md';
  storage.set(KEYS.size, S.readingSize);
  changed('prefs');
}

export function setReadingFont(font) {
  S.readingFont = font === 'sans' ? 'sans' : 'serif';
  storage.set(KEYS.font, S.readingFont);
  changed('prefs');
}

// 已读：只记在这台设备上（和 Reeder 一样，换设备不同步），只用来把读过的变灰、算未读数
export function isRead(id) {
  return S.read.has(id);
}

export function markRead(id) {
  if (!id || S.read.has(id)) return;
  S.read.add(id);
  const ids = [...S.read].slice(-READ_MAX);
  S.read = new Set(ids);
  storage.set(KEYS.read, JSON.stringify(ids));
  changed('read');
}

export function setSidebarCollapsed(collapsed) {
  S.sidebarCollapsed = collapsed;
  storage.set(KEYS.sidebar, collapsed ? 'collapsed' : 'open');
  changed('prefs');
}

// ---------------------------------------------------------------- 登录

/** 登录失败时进一步判断原因，给出能照着改的提示。 */
async function loginProblem(e) {
  if (e.status === 401) {
    return 'GitHub 不认这个 token：可能没复制完整、已经过期，或者已经删除 / 重新生成过。去 GitHub 生成一个新的再试。';
  }
  if (e.stage === 'repo' && e.status === 404) {
    const user = await fetchUser();
    if (!user) return `找不到仓库 ${S.repo}：检查仓库名是否写对。`;
    const head = `token 有效（账号 ${user.login}），但它没有被授权访问 ${S.repo}。`;
    // 仓库从公开改成私有后，只能访问公开仓库的 token 会走到这里
    if (S.token.startsWith('ghp_')) {
      return head + '这是经典 token（ghp_ 开头），访问私有仓库需要 repo 权限。'
        + '建议按下面的步骤新建一个 fine-grained token，只授权这个仓库。';
    }
    return head + '去 GitHub 编辑这个 token：Repository access 选 Only select repositories，并勾上这个仓库'
      + '（选 Public repositories 的 token 看不到私有仓库）；'
      + '注意发布用的 PUBLISH_TOKEN 只授权了 feed-hub，不能用来登录这里。';
  }
  if (e.stage === 'config' && e.status === 403) {
    return 'token 能看到仓库，但没有读取文件的权限：Permissions 里把 Contents 设为 Read and write（Actions 也一样）。';
  }
  if (e.stage === 'config' && e.status === 404) {
    return `仓库 ${S.repo} 的默认分支（${S.branch}）上找不到 config/feeds.json 或 config/settings.json。`;
  }
  return explain(e);
}

export async function connect(repo, token) {
  S.repo = repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
  // 复制时常带上空格、换行，甚至「Bearer 」前缀
  S.token = token.replace(/\s+/g, '').replace(/^Bearer/i, '');
  try {
    await loadConfig();
  } catch (e) {
    e.message = await loginProblem(e);
    S.token = '';
    throw e;
  }
  storage.set(KEYS.token, S.token);
  storage.set(KEYS.repo, S.repo);
}

export function disconnect() {
  storage.del(KEYS.token);
  storage.del(KEYS.cache);
  storage.del(KEYS.cacheItems);
  Object.assign(S, {
    token: '', user: null, feeds: null, settings: null, feedsDirty: false, settingsDirty: false,
    feedStatus: null, runs: null, items: null, briefings: null, wfRuns: null, interestHistory: null, configFresh: false,
  });
}

// ---------------------------------------------------------------- 读取

function normalizeFeeds(data) {
  data.groups = Array.isArray(data.groups) ? data.groups : [];
  data.feeds = Array.isArray(data.feeds) ? data.feeds : [];
  return data;
}

function normalizeSettings(data) {
  for (const key of ['site', 'publish', 'llm', 'filter', 'translate', 'output', 'retention']) {
    if (!data[key] || typeof data[key] !== 'object') data[key] = {};
  }
  if (typeof data.interests !== 'string') data.interests = '';
  return data;
}

export async function loadConfig() {
  const info = await fetchRepo().catch((e) => { e.stage = 'repo'; throw e; });
  S.branch = info.default_branch;
  // 仓库改过名时 GitHub 会跳转到新名字；之后的读写都用新名字，并记住它
  if (info.full_name && info.full_name !== S.repo) {
    S.repo = info.full_name;
    if (storage.get(KEYS.repo)) storage.set(KEYS.repo, S.repo);
  }
  const [feeds, settings, user] = await Promise.all([
    readConfig('feeds.json'), readConfig('settings.json'), fetchUser(),
  ]).catch((e) => { e.stage = 'config'; throw e; });
  Object.assign(S, {
    feeds: normalizeFeeds(feeds.data), feedsSha: feeds.sha, feedsDirty: false,
    settings: normalizeSettings(settings.data), settingsSha: settings.sha, settingsDirty: false,
    user: user || { login: S.repo.split('/')[0], name: '' },
    configFresh: true,
  });
  saveCache();
  changed('config');
  changed('dirty');
}

export async function loadStatus() {
  const [feedStatus, runs] = await Promise.allSettled([readData('feeds.json'), readData('runs.json')]);
  if (feedStatus.status === 'fulfilled') S.feedStatus = feedStatus.value || {};
  if (runs.status === 'fulfilled') S.runs = runs.value || [];
  changed('status');
}

export async function loadItems({ force = false } = {}) {
  if (S.itemsLoading || (S.itemsAt && !force)) return;
  S.itemsLoading = true;
  try {
    const j = await readData('items.json');
    S.items = (j && j.items) || [];
    S.itemsError = '';
    S.itemsAt = Date.now();
    writeCache(KEYS.cacheItems, { items: S.items });
  } catch (e) {
    S.items = S.items || [];
    S.itemsError = e.message;
  } finally {
    S.itemsLoading = false;
    changed('items');
  }
}

/** 各期简报（data 分支的 briefings.json），旧的在前。 */
export async function loadBriefings({ force = false } = {}) {
  if (S.briefingsLoading || (S.briefingsAt && !force)) return;
  S.briefingsLoading = true;
  try {
    const list = await readData('briefings.json');
    S.briefings = Array.isArray(list) ? list : [];
    S.briefingsError = '';
    S.briefingsAt = Date.now();
    if (S.configFresh) saveCache();
  } catch (e) {
    S.briefings = S.briefings || [];
    S.briefingsError = e.message;
  } finally {
    S.briefingsLoading = false;
    changed('briefings');
  }
}

export async function loadWorkflowRuns() {
  try {
    S.wfRuns = await listWorkflowRuns();
    S.wfError = '';
  } catch (e) {
    S.wfRuns = S.wfRuns || [];
    S.wfError = e.status === 404 ? `默认分支（${S.branch}）上还没有 pipeline.yml` : e.status === 403 ? 'token 没有 Actions 读取权限' : e.message;
  }
  changed('runs');
}

export async function loadAll() {
  await loadConfig();
  loadStatus();
  loadItems();
  loadFeedback();
}

/** 回到前台时：数据超过 maxAge 没更新就在后台重新取（简报、文章、运行状态）。 */
export function refreshStale(maxAge = 5 * 60e3) {
  if (!S.configFresh) return;
  const old = (t) => Date.now() - t > maxAge;
  if (old(S.briefingsAt)) loadBriefings({ force: true });
  if (old(S.itemsAt)) loadItems({ force: true });
  loadStatus();
}

// ---------------------------------------------------------------- 阅读反馈

const FEEDBACK_MAX = 300;
let feedbackTimer = null;
let feedbackPending = new Map(); // id → { item, vote }，还没写进仓库的改动

function applyVote(data, item, vote) {
  data.votes = data.votes.filter((v) => v.id !== item.id);
  if (vote) {
    data.votes.push({
      id: item.id, vote, title: item.title_zh || item.title || '', feed: item.feed_name || '',
      at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      // 模型当时的判断、分数和理由：打分时告诉模型「你给了几分，读者不同意」
      model: modelStatus(item), score: item.score ?? null, reason: item.reason || '',
    });
  }
  if (data.votes.length > FEEDBACK_MAX) data.votes = data.votes.slice(-FEEDBACK_MAX);
}

export async function loadFeedback() {
  try {
    const f = await readConfig('feedback.json');
    S.feedback = { votes: Array.isArray(f.data?.votes) ? f.data.votes : [] };
    S.feedbackSha = f.sha;
  } catch (e) {
    S.feedback = { votes: [] };
    S.feedbackSha = undefined; // 还没有这个文件，第一次保存时新建
  }
  changed('feedback');
}

export function voteOf(id) {
  return S.feedback?.votes.find((v) => v.id === id)?.vote || 0;
}

// 读者改过的判断（和 feedhub/overrides.py 的规则一致）：
// 模型过滤了、读者「撤销过滤」→ 推送；模型推送了、读者「不感兴趣」→ 从 feed 撤下
export function modelStatus(it) {
  return it.model_status || it.status || '';
}

function wantedOverride(model, vote) {
  if (model === 'filtered' && vote > 0) return 'push';
  if (model === 'passed' && vote < 0) return 'hide';
  return null;
}

/** 反馈已经保存、还等着下次运行处理的改动：'push' | 'hide' | 'revert'；没有返回 null。 */
export function pendingOverride(it) {
  const want = wantedOverride(modelStatus(it), voteOf(it.id));
  const applied = it.user_override || null;
  if (want === applied) return null;
  return want || 'revert';
}

async function applyOverridesSoon() {
  try {
    await dispatchWorkflow();
    toast('已保存，正在运行一次，一两分钟后生效');
    // 运行完之后刷新文章列表，状态就对上了
    setTimeout(() => loadItems({ force: true }), 100e3);
    setTimeout(() => loadItems({ force: true }), 200e3);
  } catch {
    toast('已保存，下次定时运行时生效');
  }
}

/** 记录「想多看 / 不想看」：1、-1，0 表示撤销。攒一会儿再一起写进仓库。 */
export function setVote(item, vote) {
  if (!S.feedback) S.feedback = { votes: [] };
  applyVote(S.feedback, item, vote);
  feedbackPending.set(item.id, { item, vote });
  changed('feedback');
  clearTimeout(feedbackTimer);
  feedbackTimer = setTimeout(flushFeedback, 1500);
}

async function flushFeedback() {
  const pending = [...feedbackPending.values()];
  feedbackPending = new Map();
  if (!pending.length) return;
  const message = `阅读反馈：${pending.length} 条`;
  try {
    S.feedbackSha = await writeConfig('feedback.json', S.feedback, S.feedbackSha, message);
  } catch (e) {
    if (e.status !== 409 && e.status !== 422) {
      S.feedbackError = e.message;
      changed('feedback');
      return;
    }
    // 别的设备也改过：读最新的，把这批改动重新放上去
    await loadFeedback();
    pending.forEach(({ item, vote }) => applyVote(S.feedback, item, vote));
    S.feedbackSha = await writeConfig('feedback.json', S.feedback, S.feedbackSha, message);
    changed('feedback');
  }
  // 推送 / 撤下文章要等运行处理；普通的喜好只在下次打分时用，不用专门跑一次
  const current = (item) => S.items?.find((it) => it.id === item.id) || item;
  if (pending.some(({ item }) => pendingOverride(current(item)))) applyOverridesSoon();
}

// 离开页面前把没写的反馈写掉
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && feedbackPending.size) {
    clearTimeout(feedbackTimer);
    flushFeedback();
  }
});

/** 每个订阅源最近 days 天的条目数和推送数。 */
export function passRates(days = 7) {
  const since = Date.now() - days * 24 * 3600e3;
  const rates = {};
  for (const it of S.items || []) {
    if (Date.parse(it.processed_at || it.published || 0) < since) continue;
    if (!['passed', 'filtered', 'duplicate'].includes(it.status)) continue;
    const r = rates[it.feed_id] || (rates[it.feed_id] = { total: 0, passed: 0 });
    r.total += 1;
    if (it.status === 'passed') r.passed += 1;
  }
  return rates;
}

// ---------------------------------------------------------------- 修改与保存

export function markDirty(which) {
  S[`${which}Dirty`] = true;
  changed('dirty');
}

export async function saveDirty() {
  if (!S.configFresh) throw new Error('还在和 GitHub 同步，过几秒再保存');
  if (S.feedsDirty) {
    S.feedsSha = await writeConfig('feeds.json', S.feeds, S.feedsSha, '管理页面：更新订阅源');
    S.feedsDirty = false;
  }
  if (S.settingsDirty) {
    S.settingsSha = await writeConfig('settings.json', S.settings, S.settingsSha, '管理页面：更新设置');
    S.settingsDirty = false;
  }
  saveCache();
  changed('dirty');
  changed('config');
}

export async function discardDirty() {
  await loadConfig();
}

/**
 * 读最新的配置、修改、立即提交（首页的指令用）。本页有未保存的同一份配置时拒绝执行，避免覆盖。
 * mutate 返回 false 表示不需要提交。
 */
export async function updateConfigNow(name, mutate, message) {
  const key = name === 'feeds.json' ? 'feeds' : 'settings';
  if (S[`${key}Dirty`]) {
    throw new Error(`「${key === 'feeds' ? '订阅源' : '设置'}」页还有未保存的更改，请先保存或放弃，再试一次。`);
  }
  const fresh = await readConfig(name);
  const data = key === 'feeds' ? normalizeFeeds(fresh.data) : normalizeSettings(fresh.data);
  const result = mutate(data);
  if (result === false) return false;
  const sha = await writeConfig(name, data, fresh.sha, message);
  S[key] = data;
  S[`${key}Sha`] = sha;
  saveCache();
  changed('config');
  return result;
}

// ---------------------------------------------------------------- 兴趣：一句话调整

const HISTORY_FILE = 'interests_history.json';

async function readHistory() {
  try {
    const f = await readConfig(HISTORY_FILE);
    return { changes: Array.isArray(f.data?.changes) ? f.data.changes : [], sha: f.sha };
  } catch (e) {
    if (e.status === 404) return { changes: [], sha: null };
    throw e;
  }
}

/** 兴趣描述的改动记录（流水线按读者的要求改写时记下的），新的在后。 */
export async function loadInterestHistory() {
  try {
    S.interestHistory = (await readHistory()).changes;
  } catch {
    S.interestHistory = S.interestHistory || [];
  }
  changed('config');
}

/** 记下一句「想多看 / 少看」，下次运行时 AI 改写进兴趣描述。保存后会自动运行一次。 */
export async function requestInterestChange(text) {
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await updateConfigNow('settings.json', (d) => {
    d.interest_requests = [...(Array.isArray(d.interest_requests) ? d.interest_requests : []), { text, at }];
  }, '管理页面：调整兴趣');
}

/** 撤销一次改写：兴趣描述恢复成改写之前的样子，并记一笔。 */
export async function undoInterestChange(change) {
  await updateConfigNow('settings.json', (d) => { d.interests = change.before; }, '管理页面：撤销兴趣调整');
  const h = await readHistory();
  const record = {
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), requests: [], undo: true,
    summary: `撤销：${change.summary || change.requests?.join('；') || '上次调整'}`, before: change.after, after: change.before,
  };
  const changes = [...h.changes, record].slice(-20);
  await writeConfig(HISTORY_FILE, { changes }, h.sha || undefined, '管理页面：撤销兴趣调整');
  S.interestHistory = changes;
  changed('config');
}

// ---------------------------------------------------------------- 按需翻译
// 「全部文章」里点「翻译」：把文章 id 记进 config/translate_requests.json（写配置会触发一次运行），
// 运行时按中英对照翻译（feedhub/pipeline.py 的 apply_translate_requests）。浏览器里没有模型的 key，
// 翻译只能在 GitHub Actions 上做，一两分钟后译好。等的时候只轮询这篇文章（items.json 太大）。

const TRANSLATE_FILE = 'translate_requests.json';
const TRANSLATE_WAIT = 15 * 60e3; // 这么久还没译好（运行出错之类）就不再显示「翻译中」，按钮重新出现
const TRANSLATE_KEEP = 3 * 86400e3; // 请求文件只留最近几天的
const TRANSLATE_POLL = 20e3;
let translateTimer = 0;

function loadTranslating() {
  try {
    const m = JSON.parse(storage.get(KEYS.translating) || '{}');
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}

function saveTranslating() {
  storage.set(KEYS.translating, JSON.stringify(S.translating));
}

/** 能不能点「翻译」：原文不是中文、还没翻译，或者上次翻译失败了。 */
export function canTranslate(it) {
  return it.translation === 'deferred' || it.translation === 'failed';
}

/** 点过「翻译」、还在等运行译好。 */
export function isTranslating(id) {
  const at = S.translating[id];
  return Boolean(at) && Date.now() - Date.parse(at) < TRANSLATE_WAIT;
}

/** 请求翻译一篇（中英对照）。写进仓库后会自动运行一次；之后轮询到译好为止。 */
export async function requestTranslation(it) {
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const title = (it.title_zh || it.title || it.id).slice(0, 40);
  async function write() {
    let file = null;
    try {
      file = await readConfig(TRANSLATE_FILE);
    } catch (e) {
      if (e.status !== 404) throw e; // 第一次用：还没有这个文件
    }
    const since = Date.now() - TRANSLATE_KEEP;
    const requests = (Array.isArray(file?.data?.requests) ? file.data.requests : [])
      .filter((r) => r && r.id !== it.id && Date.parse(r.at) > since);
    requests.push({ id: it.id, at });
    await writeConfig(TRANSLATE_FILE, { requests }, file?.sha, `管理页面：翻译「${title}」`);
  }
  try {
    await write();
  } catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    await write(); // 别的设备刚好也点了：读最新的再写一次
  }
  S.translating[it.id] = at;
  saveTranslating();
  changed('translating');
  watchTranslations();
}

async function checkTranslations() {
  let settled = false;
  for (const [id, at] of Object.entries(S.translating)) {
    if (!isTranslating(id)) {
      delete S.translating[id];
      settled = true;
      continue;
    }
    let a;
    try {
      a = await readData(`articles/${encodeURIComponent(id)}.json`);
    } catch {
      continue; // 网络不好：下次再看
    }
    // 运行处理过这次请求（requested_at 对得上），并且不再排队：译好了，或者失败了
    if (!a || a.requested_at !== at || a.status === 'pending') continue;
    delete S.translating[id];
    settled = true;
    const title = (a.title_zh || a.title || '').slice(0, 24);
    if (a.status === 'failed') toast(`「${title}」翻译失败了，可以再点一次「翻译」`, { tone: 'danger' });
    else toast(`「${title}」翻译好了`);
  }
  if (!settled) return;
  saveTranslating();
  changed('translating');
  await loadItems({ force: true }); // 列表上的翻译状态跟着更新
}

/** 有在等的译文就定时看一眼，都有结果（或等太久）了就停。打开页面时也调用一次，接着等上次没等完的。 */
export function watchTranslations() {
  clearTimeout(translateTimer);
  if (!Object.keys(S.translating).length) return;
  translateTimer = setTimeout(async () => {
    await checkTranslations();
    watchTranslations();
  }, TRANSLATE_POLL);
}

// ---------------------------------------------------------------- 常用派生数据

export function groupName(id) {
  const g = S.feeds?.groups.find((x) => x.id === id);
  return g ? g.name || g.id : id || '未分组';
}

export function siteBase() {
  const url = S.settings?.site?.url || CFG.siteUrl || '';
  return url ? url.replace(/\/?$/, '/') : '';
}

/** 简报模式（默认）：平时只出简报，单独推送的只有重磅；普通文章不翻译。和 feedhub/config.py 一致。 */
export function briefingMode() {
  return (S.settings?.delivery?.mode || 'briefing') === 'briefing';
}

export function outputFeeds() {
  const base = siteBase();
  if (!base) return [];
  const digest = S.settings?.digest?.enabled === false ? [] : [{ key: 'digest', name: '只看简报' }];
  // 简报模式下「全部」是简报加重磅，分组 feed 不再有内容
  const list = briefingMode()
    ? [{ key: 'all', name: '简报与重磅' }, { key: 'important', name: '只看重磅' }, ...digest]
    : [{ key: 'all', name: '全部' }, { key: 'important', name: '重要' }, ...digest,
      ...(S.feeds?.groups || []).map((g) => ({ key: g.id, name: g.name || g.id }))];
  return list.map((o) => ({ ...o, url: `${base}feeds/${o.key}.xml` }));
}

export function failingFeeds() {
  if (!S.feedStatus || !S.feeds) return [];
  return S.feeds.feeds.filter((f) => f.enabled && S.feedStatus[f.id]?.error);
}

export function recentItems(hours, predicate = () => true) {
  if (!S.items) return [];
  const since = Date.now() - hours * 3600 * 1000;
  return S.items.filter((it) => new Date(it.processed_at || it.published || 0).getTime() >= since && predicate(it));
}

export function displayName() {
  const name = S.user?.name?.trim();
  if (name) return name.split(/\s+/)[0];
  return S.user?.login || '';
}

export function initials() {
  const name = S.user?.name?.trim();
  if (name) {
    const parts = name.split(/\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
  }
  return (S.user?.login || '?').slice(0, 2).toUpperCase();
}
