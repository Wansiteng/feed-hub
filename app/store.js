/* 全局状态和数据操作。页面通过 onChange 订阅，数据变化时自行刷新需要更新的部分。 */
import {
  fetchRepo, fetchUser, readConfig, writeConfig, readData, listWorkflowRuns, dispatchWorkflow, explain, feedKey, LOCAL,
} from './api.js';
import { toast } from '../assets/ui.js';

export const CFG = window.FEEDHUB || {};

const KEYS = {
  token: 'feedhub.token', repo: 'feedhub.repo', sidebar: 'feedhub.sidebar', font: 'feedhub.readingFont',
  size: 'feedhub.readingSize', read: 'feedhub.read', cache: 'feedhub.cache.v1', cacheItems: 'feedhub.cache.items.v1',
  translating: 'feedhub.translating', editionKick: 'feedhub.editionKick', cacheLibrary: 'feedhub.cache.library.v1',
  balanceKick: 'feedhub.balanceKick', readerLang: 'feedhub.readerLang',
};
export const READING_SIZES = ['sm', 'md', 'lg', 'xl'];
export const READER_LANGS = ['bilingual', 'zh', 'original']; // 阅读器显示：中英对照、仅中文、原文
const READ_MAX = 3000; // 本机记住多少篇已读

export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* 隐私模式等 */ } },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export const S = {
  token: storage.get(KEYS.token) || '',
  // 本机模式（docs/local-run.md）没有仓库，固定叫 local；缓存按它区分，和 GitHub 模式的互不干扰
  repo: LOCAL ? 'local' : storage.get(KEYS.repo) || CFG.repo || '',
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
  // 译过的文章怎么显示；auto 是译好时的样子（点「翻译」的是中英对照，自动翻译的按设置）
  readerLang: READER_LANGS.includes(storage.get(KEYS.readerLang)) ? storage.get(KEYS.readerLang) : 'auto',
  sidebarCollapsed: storage.get(KEYS.sidebar) === 'collapsed',
  read: loadRead(),
  translating: loadTranslating(), // 点过「翻译」、还在等的文章：{ id: 请求时间 }
  editionPending: null, // 该出的一期还没出、已经触发运行在补：出刊时间（ISO）
  editionKickError: '', // 补跑没触发成功的原因
  push: null, pushError: '', pushEndpoint: '', // 通知：config/push.json、读取出错、这台设备的订阅地址
  library: null, libraryError: '', // 收藏和稍后阅读：config/library.json
  reading: null, readingRepo: '', readingError: '', // 阅读记录：config/reading.json（见 reading.js）
  usage: null, usageError: '', // 模型用量和余额：data 分支的 usage.json
  balanceRefreshing: false, balanceError: '', // 正在运行一次取最新的余额、没能触发的原因
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
  S.library = readCache(KEYS.cacheLibrary)?.library || null;
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
/** what：'config' | 'status' | 'items' | 'briefings' | 'runs' | 'dirty' | 'prefs' | 'feedback' | 'read' | 'library' … */
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

export function setReaderLang(lang) {
  S.readerLang = READER_LANGS.includes(lang) ? lang : 'auto';
  storage.set(KEYS.readerLang, S.readerLang);
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
  if (LOCAL) {
    if (e.status === 401) return '口令不对：在 Mac 上运行 cat ~/.feedhub/server-token，把那一串完整复制过来。';
    return explain(e);
  }
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
  S.repo = LOCAL ? 'local' : repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/+$/, '');
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
  storage.del('feedhub.cache.reading.v1'); // 阅读记录的缓存（reading.js）；本机还没写进仓库的留着，下次登录再写
  Object.assign(S, {
    token: '', user: null, feeds: null, settings: null, feedsDirty: false, settingsDirty: false,
    feedStatus: null, runs: null, items: null, briefings: null, wfRuns: null, interestHistory: null, configFresh: false,
    reading: null, readingRepo: '',
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
  loadLibrary();
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
    await triggerRun('按反馈推送 / 撤下文章');
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

// ---------------------------------------------------------------- 运行一次
// 优先用 workflow_dispatch（token 要有 Actions 写权限）。没有这个权限时改为往 config/run_requests.json 记一笔：
// 写配置会触发一次运行（pipeline.yml 的 push 触发），只要 Contents 写权限——「翻译」按钮也是这样触发的。

const RUN_REQUESTS = 'run_requests.json';

/** 运行一次处理流程。返回 'dispatch'（手动运行）或 'push'（写配置触发）；都不行时抛出错误。 */
export async function triggerRun(reason) {
  try {
    await dispatchWorkflow();
    return 'dispatch';
  } catch (e) {
    if (![403, 404, 422].includes(e.status)) throw e;
  }
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  async function write() {
    let file = null;
    try {
      file = await readConfig(RUN_REQUESTS);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const requests = [...(Array.isArray(file?.data?.requests) ? file.data.requests : []), { at, reason }].slice(-10);
    await writeConfig(RUN_REQUESTS, { requests }, file?.sha, `管理页面：运行一次（${reason}）`);
  }
  try {
    await write();
  } catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    await write(); // 别的设备刚好也写了：读最新的再写一次
  }
  return 'push';
}

// ---------------------------------------------------------------- 简报补跑
// GitHub 的定时任务在高峰期经常被推迟、甚至跳过，出刊时间过了简报还没出。打开 app 时发现该出的一期还没出，
// 就运行一次（和「运行记录」里的「立即运行」一样），页面上显示「正在生成」，出来了自动显示。

const EDITION_MAX_LATE = 6 * 3600e3; // 和 feedhub/briefing.py 的 MAX_LATE 一致：晚了这么久就不补这一期了
const KICK_AGAIN_AFTER = 10 * 60e3; // 同一期隔这么久还没出，才再触发一次
const EDITION_POLL = 20e3;
const EDITION_WAIT = 8 * 60e3;
let editionTimer = 0;
let editionSince = 0; // 开始等这一期的时间
let ensuring = null; // 正在检查 / 触发：同时调用多次只触发一次

/** 出刊时间（整点，按设置的时区），和 feedhub/briefing.py 的 schedule_hours 一致。 */
export function scheduleHours() {
  const hours = (S.settings?.digest?.hours || [7, 19]).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23);
  return [...new Set(hours)].sort((a, b) => a - b);
}

/** 最近一个已经过了的出刊时间；算不出来返回 null。 */
export function lastEditionSlot(now = new Date()) {
  const zone = S.settings?.digest?.timezone || 'Asia/Shanghai';
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
    }).formatToParts(now).map((x) => [x.type, x.value]));
  } catch {
    return null;
  }
  // 这个时区比 UTC 快多少（整分钟）
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(now.getTime() / 60e3) * 60e3;
  let best = null;
  for (const back of [0, 1]) {
    for (const hour of scheduleHours()) {
      const t = Date.UTC(+p.year, +p.month - 1, +p.day - back, hour) - offset;
      if (t <= now.getTime() && (best == null || t > best)) best = t;
    }
  }
  return best == null ? null : new Date(best);
}

/** 该出的一期还没出：返回它的出刊时间；已经出了（或更晚的一期出了）、简报关着、晚太久了返回 null。 */
export function missingEdition(now = new Date()) {
  if (!S.briefings || S.settings?.digest?.enabled === false) return null;
  const slot = lastEditionSlot(now);
  if (!slot || now - slot > EDITION_MAX_LATE) return null;
  const latest = Math.max(0, ...S.briefings.map((e) => Date.parse(e.end || e.published) || 0));
  return latest >= slot.getTime() ? null : slot;
}

/**
 * 该出的一期还没出就运行一次补上，并且等到它出来。已经有运行在排队或在跑时不再触发；同一期 10 分钟内只触发一次。
 * 没有触发运行的权限时什么都不做（等定时任务）。
 */
export function ensureLatestEdition() {
  ensuring = ensuring || kickEdition().finally(() => { ensuring = null; });
  return ensuring;
}

async function kickEdition() {
  const slot = missingEdition();
  if (!slot) {
    if (S.editionPending || S.editionKickError) {
      S.editionPending = null;
      S.editionKickError = '';
      changed('briefings');
    }
    return;
  }
  const key = slot.toISOString();
  let kicked = null;
  try {
    kicked = JSON.parse(storage.get(KEYS.editionKick) || 'null');
  } catch { /* 当没触发过 */ }
  if (!(kicked && kicked.slot === key && Date.now() - kicked.at < KICK_AGAIN_AFTER)) {
    try {
      const runs = await listWorkflowRuns(5).catch(() => []); // 没有 Actions 读权限时当作没有在跑的
      if (!runs.some((r) => r.status === 'queued' || r.status === 'in_progress')) {
        const hour = new Intl.DateTimeFormat('en-US', {
          timeZone: S.settings?.digest?.timezone || 'Asia/Shanghai', hour: '2-digit', hourCycle: 'h23',
        }).format(slot);
        await triggerRun(`补出 ${hour}:00 的简报`);
      }
      storage.set(KEYS.editionKick, JSON.stringify({ slot: key, at: Date.now() }));
      S.editionKickError = '';
    } catch (e) {
      S.editionKickError = explain(e);
      changed('briefings');
      return;
    }
  }
  if (S.editionPending !== key) {
    S.editionPending = key;
    editionSince = Date.now();
    changed('briefings');
  }
  waitForEdition();
}

function waitForEdition() {
  clearTimeout(editionTimer);
  editionTimer = setTimeout(async () => {
    await loadBriefings({ force: true });
    if (!missingEdition()) {
      S.editionPending = null;
      changed('briefings');
      loadItems({ force: true }); // 新一期的要点、配图在 items.json 里
      return;
    }
    if (Date.now() - editionSince > EDITION_WAIT) {
      S.editionPending = null; // 等太久了：下次打开再看
      changed('briefings');
      return;
    }
    ensureLatestEdition(); // 触发过的运行没出来（比如它开始得太早）：隔 10 分钟再触发一次
  }, EDITION_POLL);
}

// ---------------------------------------------------------------- 通知（Web Push）
// config/push.json：{vapid_public_key, subscriptions: [{endpoint, keys, device, created_at}], test_at}。
// 私钥只在生成时显示一次，由读者添加到 GitHub Secrets 的 VAPID_PRIVATE_KEY，不保存在任何地方（见 feedhub/webpush.py）。

const PUSH_FILE = 'push.json';

function b64u(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64uBytes(text) {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function normalizePush(d) {
  return {
    ...(d && typeof d === 'object' ? d : {}),
    subscriptions: Array.isArray(d?.subscriptions) ? d.subscriptions.filter((s) => s && s.endpoint) : [],
  };
}

/** 这台设备能不能开启通知：'ok'、'install'（iPhone / iPad 要先添加到主屏幕、从主屏幕打开）、'denied'、'unsupported'。 */
export function pushSupport() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
  if (ios && !standalone) return 'install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission === 'denied' ? 'denied' : 'ok';
}

export function deviceName() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  return '这台设备';
}

async function currentSubscription() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    return (await reg?.pushManager?.getSubscription()) || null;
  } catch {
    return null;
  }
}

/** 读 config/push.json 和这台设备的订阅。 */
export async function loadPush() {
  try {
    S.push = normalizePush((await readConfig(PUSH_FILE)).data);
    S.pushError = '';
  } catch (e) {
    S.push = e.status === 404 ? normalizePush(null) : S.push;
    S.pushError = e.status === 404 ? '' : explain(e);
  }
  S.pushEndpoint = (await currentSubscription())?.endpoint || '';
  changed('push');
}

/** 读最新的 push.json、修改、写回（别的设备同时写了就重来一次）。 */
async function updatePush(mutate, message) {
  for (let attempt = 0; ; attempt += 1) {
    let file = null;
    try {
      file = await readConfig(PUSH_FILE);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const data = normalizePush(file?.data);
    mutate(data);
    try {
      await writeConfig(PUSH_FILE, data, file?.sha, message);
      S.push = data;
      changed('push');
      return;
    } catch (e) {
      if (attempt || (e.status !== 409 && e.status !== 422)) throw e;
    }
  }
}

/**
 * 生成一对推送密钥：公钥存进 config/push.json，返回私钥（只给读者看这一次）。
 * 换了密钥以后，之前开启过的设备要重新开启（订阅是跟着公钥的）。
 */
export async function createPushKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  await updatePush((d) => {
    d.vapid_public_key = publicKey;
    d.subscriptions = [];
  }, '管理页面：生成推送密钥');
  const sub = await currentSubscription();
  await sub?.unsubscribe().catch(() => {});
  S.pushEndpoint = '';
  return jwk.d;
}

/** 在这台设备上开启通知：请求权限、订阅推送服务、把订阅存进 config/push.json。要在点按钮时调用（iOS 的要求）。 */
export async function enablePush() {
  const key = S.push?.vapid_public_key;
  if (!key) throw new Error('还没有推送密钥，先生成一次');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? '通知被拒绝了：到系统设置里允许 Feed Hub 发通知，再来开启' : '没有允许通知');
  }
  const reg = await navigator.serviceWorker.register('sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const subKey = sub?.options?.applicationServerKey;
  if (sub && (!subKey || b64u(new Uint8Array(subKey)) !== key)) { // 旧密钥时订阅的：换成新的
    await sub.unsubscribe();
    sub = null;
  }
  sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(key) });
  const json = sub.toJSON();
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await updatePush((d) => {
    d.subscriptions = d.subscriptions.filter((s) => s.endpoint !== json.endpoint);
    d.subscriptions.push({ endpoint: json.endpoint, keys: json.keys, device: deviceName(), created_at: at });
  }, `管理页面：在 ${deviceName()} 上开启通知`);
  S.pushEndpoint = json.endpoint;
  changed('push');
}

/** 关掉某台设备的通知（这台设备的话也退订）。 */
export async function disablePush(endpoint) {
  if (endpoint === S.pushEndpoint) {
    const sub = await currentSubscription();
    await sub?.unsubscribe().catch(() => {});
    S.pushEndpoint = '';
  }
  await updatePush((d) => {
    d.subscriptions = d.subscriptions.filter((s) => s.endpoint !== endpoint);
  }, '管理页面：关掉一台设备的通知');
}

/** 发一条测试通知：记下时间并运行一次，运行时发给所有开启了通知的设备。 */
export async function sendTestPush() {
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  await updatePush((d) => { d.test_at = at; }, '管理页面：发一条测试通知');
  return triggerRun('测试通知');
}

// ---------------------------------------------------------------- 收藏和稍后阅读
// 存在 config/library.json（改它不触发运行），换设备也在。点了马上在本机生效，再排队写进仓库；
// 别的设备同时改过就读最新的，把这边的改动重新放上去。每个改动都是「设成某个样子」，放几次结果都一样。

const LIBRARY_FILE = 'library.json';
const LIBRARY_MAX = 1000; // 每个列表最多留多少条
let libraryBase = null; // 最近一次从仓库读到 / 写进仓库的内容：{ data, sha }
let libraryOps = []; // 还没写进仓库的改动：[{ apply(data), message }]
let libraryWriting = null;
let libraryWrites = 0; // 写成功了几次：读的时候又写过，读到的就是旧的

function normalizeLibrary(d) {
  const list = (key) => (Array.isArray(d?.[key]) ? d[key] : [])
    .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && e.id);
  return { favorites: list('favorites'), later: list('later') };
}

function cloneLibrary(d) {
  return { favorites: d.favorites.map((e) => ({ ...e })), later: d.later.map((e) => ({ ...e })) };
}

async function fetchLibrary() {
  try {
    const f = await readConfig(LIBRARY_FILE);
    return { data: normalizeLibrary(f.data), sha: f.sha };
  } catch (e) {
    if (e.status === 404) return { data: normalizeLibrary(null), sha: undefined }; // 还没有这个文件，第一次保存时新建
    throw e;
  }
}

function showLibrary(data) {
  S.library = cloneLibrary(data);
  libraryOps.forEach((op) => op.apply(S.library)); // 还没写完的改动不能被读回来的旧内容盖掉
  writeCache(KEYS.cacheLibrary, { library: S.library });
  changed('library');
}

export async function loadLibrary() {
  if (libraryWriting) return libraryWriting; // 正在写：写完的就是最新的
  const before = libraryWrites;
  let fetched;
  try {
    fetched = await fetchLibrary();
  } catch (e) {
    S.libraryError = explain(e);
    changed('library');
    return;
  }
  if (libraryWrites !== before || libraryWriting) return; // 读的时候又写过：这份是旧的，不用
  libraryBase = fetched;
  S.libraryError = '';
  showLibrary(libraryBase.data);
}

function changeLibrary(apply, message) {
  if (!S.library) S.library = normalizeLibrary(null);
  apply(S.library);
  writeCache(KEYS.cacheLibrary, { library: S.library });
  changed('library');
  libraryOps.push({ apply, message });
  if (!libraryWriting) libraryWriting = flushLibrary().finally(() => { libraryWriting = null; });
  return libraryWriting;
}

async function flushLibrary() {
  while (libraryOps.length) {
    const ops = libraryOps.slice();
    const message = ops.length === 1 ? ops[0].message : `收藏和稍后阅读：${ops.length} 处改动`;
    try {
      for (let attempt = 0; ; attempt += 1) {
        if (!libraryBase || attempt) libraryBase = await fetchLibrary();
        const data = cloneLibrary(libraryBase.data);
        ops.forEach((op) => op.apply(data));
        try {
          const sha = await writeConfig(LIBRARY_FILE, data, libraryBase.sha, message);
          libraryBase = { data, sha };
          libraryWrites += 1;
          break;
        } catch (e) {
          if (attempt >= 2 || (e.status !== 409 && e.status !== 422)) throw e;
        }
      }
    } catch (e) {
      libraryOps = [];
      toast(`没能保存：${explain(e)}`, { tone: 'danger' });
      try { // 回到仓库里的样子
        libraryBase = await fetchLibrary();
        showLibrary(libraryBase.data);
      } catch { /* 连不上：先留着本机的样子，下次打开再取 */ }
      return;
    }
    libraryOps.splice(0, ops.length);
    showLibrary(libraryBase.data);
  }
}

export function favoriteKey(e) {
  return `${e.kind || 'article'}:${e.id}`;
}

export function isFavorite(kind, id) {
  return !!S.library?.favorites.some((e) => (e.kind || 'article') === kind && e.id === id);
}

/** 收藏 / 取消收藏一篇文章（kind: 'article'）或一期简报（kind: 'edition'）。entry 里带上标题等，列表里直接显示。 */
export function setFavorite(entry, on) {
  const key = favoriteKey(entry);
  const saved = { ...entry, at: new Date().toISOString() };
  return changeLibrary((d) => {
    d.favorites = d.favorites.filter((e) => favoriteKey(e) !== key);
    if (on) d.favorites = [saved, ...d.favorites].slice(0, LIBRARY_MAX);
  }, `${on ? '收藏' : '取消收藏'}：${entry.title || entry.id}`);
}

export function removeFavorites(keys) {
  const drop = new Set(keys);
  return changeLibrary((d) => { d.favorites = d.favorites.filter((e) => !drop.has(favoriteKey(e))); },
    `取消收藏 ${drop.size} 项`);
}

export function laterEntry(id) {
  return S.library?.later.find((e) => e.id === id) || null;
}

export function setLater(entry, on) {
  const saved = { ...entry, at: new Date().toISOString() };
  return changeLibrary((d) => {
    d.later = d.later.filter((e) => e.id !== entry.id);
    if (on) d.later = [saved, ...d.later].slice(0, LIBRARY_MAX);
  }, `${on ? '稍后阅读' : '移出稍后阅读'}：${entry.title || entry.id}`);
}

export function removeLater(ids) {
  const drop = new Set(ids);
  return changeLibrary((d) => { d.later = d.later.filter((e) => !drop.has(e.id)); }, `移出稍后阅读 ${drop.size} 篇`);
}

/** 打开了稍后阅读里的一篇：记为读过（加进来之后才打开的才算，在这篇里点「稍后阅读」不算）。 */
export function markLaterRead(id, openedAt) {
  const e = laterEntry(id);
  if (!e || e.read_at || !(Date.parse(e.at) < openedAt)) return;
  const at = new Date(openedAt).toISOString();
  changeLibrary((d) => {
    const x = d.later.find((y) => y.id === id);
    if (x && !x.read_at) x.read_at = at;
  }, `读过稍后阅读里的一篇：${e.title || id}`);
}

/** 推送通知配好了没有（按最近一次运行的记录）：Web Push 有设备、私钥对得上，或者配了 Bark / ntfy。 */
export function notifyOn() {
  const n = S.runs?.[0]?.notify;
  return Boolean(n?.configured || (n?.webpush?.devices && n.webpush.matches));
}

/** 加进稍后阅读（已经在里面就不动，免得把读过的记录清掉）。 */
export function ensureLater(entry) {
  if (!laterEntry(entry.id)) setLater(entry, true);
}

export function laterUnread() {
  return (S.library?.later || []).filter((e) => !e.read_at).length;
}

// ---------------------------------------------------------------- 模型用量和余额
// 每次运行最后查一次 DeepSeek 的余额，和按天累计的用量一起存在 data 分支的 usage.json（见 feedhub/usage.py）。
// 管理页面拿不到 API key（只在 GitHub Secrets 里），余额是最近一次运行时查到的；要最新的就运行一次，一分钟左右。

const BALANCE_FRESH = 15 * 60e3; // 打开用量看板时，余额比这更旧就自动运行一次
const BALANCE_KICK_AGAIN = 10 * 60e3; // 自动触发的间隔
const USAGE_POLL = 20e3;
const USAGE_WAIT = 8 * 60e3;
let usageTimer = 0;

export async function loadUsage() {
  try {
    S.usage = (await readData('usage.json')) || { days: {} }; // 还没运行过：空的
    S.usageError = '';
  } catch (e) {
    S.usageError = explain(e);
  }
  changed('usage');
}

/** 最近查到的余额：usage.json 和运行记录里较新的那个；从来没查到过返回 null。 */
export function latestBalance() {
  const a = S.usage?.balance || null;
  const b = S.runs?.find((r) => r.balance)?.balance || null;
  if (!a || !b) return a || b;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
}

/**
 * 运行一次，等它把最新的余额记下来。auto：打开看板时调用，余额还新、或者 10 分钟内自动触发过就不触发。
 * 已经有运行在排队或在跑时不再触发，等它跑完就行。
 */
export async function refreshBalance({ auto = false } = {}) {
  if (S.balanceRefreshing) return;
  if (auto) {
    const b = latestBalance();
    if (b && Date.now() - Date.parse(b.at) < BALANCE_FRESH) return;
    if (Date.now() - Number(storage.get(KEYS.balanceKick) || 0) < BALANCE_KICK_AGAIN) return;
  }
  const since = S.usage?.updated_at || '';
  S.balanceRefreshing = true;
  S.balanceError = '';
  changed('usage');
  try {
    const runs = await listWorkflowRuns(5).catch(() => []); // 没有 Actions 读权限时当作没有在跑的
    if (!runs.some((r) => r.status === 'queued' || r.status === 'in_progress')) await triggerRun('刷新模型余额');
    storage.set(KEYS.balanceKick, String(Date.now()));
  } catch (e) {
    S.balanceRefreshing = false;
    S.balanceError = explain(e);
    changed('usage');
    return;
  }
  const started = Date.now();
  const poll = async () => {
    await loadUsage();
    if (S.usage?.updated_at && S.usage.updated_at !== since) {
      S.balanceRefreshing = false;
      changed('usage');
      loadStatus();
      return;
    }
    if (Date.now() - started > USAGE_WAIT) {
      S.balanceRefreshing = false;
      S.balanceError = '等了几分钟还没运行完，可以到「运行记录」里看看';
      changed('usage');
      return;
    }
    usageTimer = setTimeout(poll, USAGE_POLL);
  };
  clearTimeout(usageTimer);
  usageTimer = setTimeout(poll, USAGE_POLL);
}

/** 金额：¥12.34；不到一毛钱的多留一位（¥0.032）。 */
export function fmtMoney(value, currency = 'CNY') {
  const sign = { CNY: '¥', USD: '$' }[currency] ?? `${currency} `;
  const v = Number(value) || 0;
  return `${sign}${v !== 0 && Math.abs(v) < 0.1 ? v.toFixed(3) : v.toFixed(2)}`;
}

/** 某个时刻在简报时区里是哪一天（YYYY-MM-DD），和 feedhub/usage.py 按天累计的口径一致。 */
export function usageDay(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: S.settings?.digest?.timezone || 'Asia/Shanghai' }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

/** 最近 n 天（今天在最后）：[{ key, date, ...当天的用量（没有就是空的） }]。 */
export function usageDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86400e3);
    const key = usageDay(date);
    out.push({ key, date, ...(S.usage?.days?.[key] || {}) });
  }
  return out;
}

// ---------------------------------------------------------------- 常用派生数据

export function groupName(id) {
  const g = S.feeds?.groups.find((x) => x.id === id);
  return g ? g.name || g.id : id || '未分组';
}

export function siteBase() {
  // 本机模式：就是现在打开管理页面的这个地址（用 IP 还是名字打开都对得上登录时发的 cookie）
  if (LOCAL) return new URL('./', window.location.href).href;
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
  // 本机模式下订阅地址要带 key：RSS 阅读器带不了口令和 cookie（这个 key 只能读站点内容）
  const key = LOCAL && feedKey() ? `?key=${feedKey()}` : '';
  return list.map((o) => ({ ...o, url: `${base}feeds/${o.key}.xml${key}` }));
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
