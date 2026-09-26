/* 管理页面入口：路由、应用外壳（侧边栏 / 抽屉）、登录、全局保存提示条。 */
import {
  h, icon, mark, iconButton, openMenu, initTooltips, toast, confirmDialog, closeMenu,
} from '../assets/ui.js';
import {
  S, CFG, onChange, connect, disconnect, loadAll, loadStatus, loadItems, saveDirty, discardDirty,
  setReadingFont, setSidebarCollapsed, displayName, initials, failingFeeds, isRead, briefingMode, fromCache, refreshStale,
  watchTranslations,
} from './store.js';
import { explain } from './api.js';
import { nav, setSequence } from './nav.js';
import { StreamPage, VIEWS, streamState, streamTitle, streamHash } from './pages/stream.js';
import { BriefingPage } from './pages/briefing.js';
import { ReaderPage } from './pages/reader.js';
import { FeedsPage } from './pages/feeds.js';
import { RunsPage } from './pages/runs.js';
import { SettingsPage } from './pages/settings.js';
import { MePage } from './pages/me.js';

const app = document.getElementById('app');

// 首页：简报模式下是简报，按篇推送时是信息流。#/briefing 和 #/articles 两种模式下都能打开
const ROUTES = {
  '': null,
  briefing: { page: BriefingPage, title: '简报' },
  articles: { page: StreamPage, title: '全部文章' },
  article: { page: ReaderPage, title: '文章' },
  feeds: { page: FeedsPage, title: '订阅源' },
  runs: { page: RunsPage, title: '运行记录' },
  settings: { page: SettingsPage, title: '设置' },
  me: { page: MePage, title: '我的' },
};
// 手机上「我的」标签下的页面
const ME_ROUTES = new Set(['me', 'settings', 'feeds', 'runs']);

function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  const [name = '', id = null] = path.split('/').filter(Boolean);
  return { name: ROUTES[name] ? name : '', id: id && decodeURIComponent(id), params: new URLSearchParams(query || '') };
}

function routeDef(route) {
  if (route.name) return ROUTES[route.name];
  // 以前的信息流首页地址（#/?view=…、#/?group=…）照样打开信息流
  const p = route.params;
  if (!briefingMode() || p.has('view') || p.has('group') || p.has('status') || p.has('q')) return ROUTES.articles;
  return ROUTES.briefing;
}

let shell = null;
let current = null;

// ---------------------------------------------------------------- 登录

function LoginView(errorText = '') {
  const repo = h('input', { class: 'input', id: 'login-repo', value: S.repo || CFG.repo || '', placeholder: 'owner/repo', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const token = h('input', { class: 'input', id: 'login-token', type: 'password', placeholder: 'github_pat_…', autocomplete: 'off' });
  const error = h('p', { class: 'field-error', role: 'alert' }, errorText);
  const submit = h('button', { type: 'submit', class: 'btn btn-primary login-submit' }, '连接');
  const form = h('form', {
    class: 'login-form',
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      submit.replaceChildren(mark({ breathe: true, small: true }), '正在连接');
      try {
        await connect(repo.value, token.value);
        loadStatus();
        loadItems();
        render();
      } catch (ex) {
        error.textContent = ex.message;
        submit.disabled = false;
        submit.replaceChildren('连接');
      }
    },
  },
  h('div', { class: 'field' }, h('label', { class: 'label', for: 'login-repo' }, '私有仓库'), repo),
  h('div', { class: 'field' }, h('label', { class: 'label', for: 'login-token' }, 'GitHub token'), token,
    h('span', { class: 'hint' }, '只保存在这台设备的浏览器里，只发给 GitHub。')),
  error,
  submit);

  return h('main', { class: 'login' },
    h('div', { class: 'login-inner' },
      h('div', { class: 'login-brand' }, mark(), 'Feed Hub'),
      h('h1', { class: 'login-title' }, '连接你的中转站'),
      h('p', { class: 'login-lede' }, '管理订阅源、调整兴趣描述、查看 AI 挑出来的文章。'),
      form,
      h('div', { class: 'card card-muted login-help' },
        h('p', { class: 'label' }, '第一次使用：创建一个只授权这个仓库的 token'),
        h('ol', {},
          h('li', {}, 'GitHub → Settings → Developer settings → Fine-grained tokens'),
          h('li', {}, 'Repository access 选 Only select repositories，只勾这个私有仓库'),
          h('li', {}, 'Permissions：Contents 和 Actions 都选 Read and write')),
        h('p', { class: 'hint' }, '发布用的 PUBLISH_TOKEN 只授权了公开仓库，不能用来登录这里。')),
    ));
}

function ErrorView(message) {
  return h('main', { class: 'login' },
    h('div', { class: 'login-inner' },
      h('div', { class: 'login-brand' }, mark(), 'Feed Hub'),
      h('h1', { class: 'login-title' }, '加载失败'),
      h('p', { class: 'login-lede' }, message),
      h('div', { class: 'login-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => boot() }, icon('refresh-cw'), '重试'),
        h('button', { type: 'button', class: 'btn btn-secondary', onclick: logout }, '重新登录'))));
}

async function logout() {
  if ((S.feedsDirty || S.settingsDirty) && !(await confirmDialog({ title: '退出登录？', message: '还有未保存的更改，退出后会丢失。', confirmLabel: '退出', danger: true }))) return;
  disconnect();
  shell = null;
  current = null;
  render();
}

// ---------------------------------------------------------------- 外壳

/* 电脑上：左边侧边栏（可以收起，收起后顶栏有按钮展开）。
 * 手机上：没有侧边栏，底部三个标签（简报 / 文章 / 我的），往下读时藏起来，往上滑再出现；读文章时不显示。 */
function buildShell() {
  const sidebar = h('aside', { class: 'sidebar app-sidebar', 'aria-label': '导航' });
  const topTitle = h('span', { class: 'topbar-title' });
  const topbar = h('header', { class: 'topbar' },
    iconButton('panel-left', '展开侧边栏', () => setSidebarCollapsed(false), { cls: 'topbar-menu' }),
    topTitle);
  const host = h('main', { class: 'page-host', id: 'main', tabindex: '-1' });
  const scroller = h('div', { class: 'app-main' }, topbar, host);
  const tabbar = h('nav', { class: 'tabbar', 'aria-label': '主要页面' });
  const root = h('div', { class: 'app' }, sidebar, scroller, tabbar);
  const savebarSlot = h('div');
  root.append(savebarSlot);
  const jumpTo = watchScroll(scroller, root);
  return { root, sidebar, topTitle, host, scroller, tabbar, savebarSlot, jumpTo };
}

/** 滚动方向：往下读时给外壳加 is-reading，底部标签和文章顶栏据此藏起来；往上滑、回到顶部或读到底时再出现。
 * 返回 jumpTo(y)：换页、恢复位置这类程序滚动用它，不算作「往下读」。 */
function watchScroll(scroller, root) {
  let last = 0;
  let ignore = false;
  scroller.addEventListener('scroll', () => {
    const y = scroller.scrollTop;
    const atEnd = y + scroller.clientHeight >= scroller.scrollHeight - 4;
    if (ignore) ignore = false;
    else if (y < 60 || atEnd) root.classList.remove('is-reading');
    else if (y > last + 6) root.classList.add('is-reading');
    else if (y < last - 6) root.classList.remove('is-reading');
    last = y;
  }, { passive: true });
  return (y) => {
    root.classList.remove('is-reading');
    if (Math.abs(scroller.scrollTop - y) > 1) ignore = true;
    last = y;
    scroller.scrollTo({ top: y, behavior: 'instant' }); // 同时打断上一页还没结束的平滑滚动
  };
}

function renderTabbar(route) {
  const def = routeDef(route);
  const briefing = briefingMode();
  const tab = (href, iconName, label, current) => h('a', {
    class: `tab${current ? ' is-current' : ''}`, href, 'aria-current': current ? 'page' : null,
  }, icon(iconName), h('span', {}, label));
  const onBriefing = def === ROUTES.briefing;
  const onStream = def === ROUTES.articles || route.name === 'article';
  const tabs = [
    tab(briefing ? '#/' : '#/briefing', 'tab-briefing', '简报', onBriefing),
    tab(briefing ? '#/articles' : '#/', 'tab-articles', '文章', onStream),
    tab('#/me', 'tab-me', '我的', ME_ROUTES.has(route.name)),
  ];
  // 首页放在第一个：按篇推送模式下文章是首页
  shell.tabbar.replaceChildren(...(briefing ? tabs : [tabs[1], tabs[0], tabs[2]]));
}

function navItem(href, iconName, label, { current = false, count = null, primary = false } = {}) {
  return h('a', {
    class: `nav-item${current ? ' is-current' : ''}${primary ? ' is-primary' : ''}`,
    href,
    'aria-current': current ? 'page' : null,
  }, icon(iconName), h('span', { class: 'nav-label' }, label), count != null ? h('span', { class: 'nav-count' }, count) : null);
}

function renderSidebar(route) {
  const { sidebar } = shell;
  const def = routeDef(route);
  const onStream = def === ROUTES.articles;
  const { view, group } = onStream ? streamState(route) : { view: null, group: null };
  const briefing = briefingMode();
  // 未读数：像 Reeder 一样，只数推送了、这台设备上还没读过的。简报模式下不逐篇读，不显示
  const unread = briefing ? [] : (S.items || []).filter((it) => it.status === 'passed' && !isRead(it.id));
  const countByGroup = {};
  for (const it of unread) countByGroup[it.group] = (countByGroup[it.group] || 0) + 1;
  const counts = S.items && !briefing ? {
    all: unread.length,
    important: unread.filter((it) => it.important).length,
    filtered: null,
  } : {};
  const failing = failingFeeds().length;
  const enabled = S.feeds ? S.feeds.feeds.filter((f) => f.enabled).length : null;
  const digestOn = S.settings?.digest?.enabled !== false;
  const briefingItem = navItem(briefing ? '#/' : '#/briefing', 'book-open', '简报', { current: def === ROUTES.briefing });

  const userBtn = h('button', {
    type: 'button', class: 'user-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    onclick: (e) => openUserMenu(e.currentTarget),
  },
  h('span', { class: 'avatar' }, initials()),
  h('span', { class: 'user-text' }, h('span', { class: 'user-name' }, displayName() || '未登录'), h('span', { class: 'user-sub' }, S.repo)),
  icon('chevron-down'));

  sidebar.replaceChildren(
    h('div', { class: 'sidebar-head' },
      h('a', { class: 'sidebar-brand', href: '#/' }, 'Feed Hub'),
      iconButton('panel-left', '收起侧边栏', () => setSidebarCollapsed(true), { small: true, cls: 'sidebar-toggle' })),
    h('div', { class: 'sidebar-scroll' },
      h('nav', { class: 'sidebar-nav', 'aria-label': '阅读' },
        briefing ? briefingItem : null,
        Object.entries(VIEWS).map(([id, v]) => navItem(streamHash({ view: id }, !briefing), v.icon, v.title, {
          current: onStream && !group && view === id, count: counts[id] || null,
        })),
        !briefing && digestOn ? briefingItem : null),
      S.feeds?.groups.length ? h('div', { class: 'sidebar-section' }, '分组') : null,
      h('nav', { class: 'sidebar-nav', 'aria-label': '分组' },
        (S.feeds?.groups || []).map((g) => navItem(streamHash({ group: g.id }, !briefing), 'hash', g.name || g.id, {
          current: onStream && group === g.id,
          count: S.items ? countByGroup[g.id] || null : null,
        })))),
    h('div', { class: 'sidebar-foot' },
      h('nav', { class: 'sidebar-nav sidebar-manage', 'aria-label': '管理' },
        navItem('#/feeds', 'rss', '订阅源', { current: route.name === 'feeds', count: enabled }),
        navItem('#/runs', 'history', '运行记录', { current: route.name === 'runs', count: failing ? `${failing} 个失败` : null }),
        navItem('#/settings', 'settings', '设置', { current: route.name === 'settings' })),
      userBtn),
  );
}

function openUserMenu(anchor) {
  const theme = window.FeedHubTheme;
  openMenu(anchor, [
    { header: '主题' },
    ...[['light', '浅色', 'sun'], ['dark', '深色', 'moon'], ['system', '跟随系统', 'monitor']].map(([v, label, ic]) => ({
      label, icon: ic, checked: theme?.pref === v, onSelect: () => theme?.set(v),
    })),
    { separator: true },
    { header: '阅读字体' },
    { label: '衬线', icon: 'type', checked: S.readingFont === 'serif', onSelect: () => setReadingFont('serif') },
    { label: '无衬线', icon: 'type', checked: S.readingFont === 'sans', onSelect: () => setReadingFont('sans') },
    { separator: true },
    { label: '设计预览', icon: 'palette', onSelect: () => window.open('design-preview/', '_blank', 'noopener') },
    { label: 'GitHub 仓库', icon: 'external-link', onSelect: () => window.open(`https://github.com/${S.repo}`, '_blank', 'noopener') },
    { label: '退出登录', icon: 'log-out', onSelect: logout },
  ], { placement: 'top' });
}

// ---------------------------------------------------------------- 保存提示条

function renderSavebar(route) {
  const { savebarSlot } = shell;
  if (!(S.feedsDirty || S.settingsDirty)) { savebarSlot.replaceChildren(); return; }
  const what = [S.feedsDirty && '订阅源', S.settingsDirty && '设置'].filter(Boolean).join('和');
  // 内容没变就不重建：输入框失焦时还会再标记一次未保存，这时换掉按钮，正在点的「保存」就点空了
  const key = what;
  if (savebarSlot.firstElementChild?.dataset.key === key) return;
  const save = h('button', { type: 'button', class: 'btn btn-primary btn-sm' }, '保存');
  save.addEventListener('click', async () => {
    save.disabled = true;
    save.replaceChildren(mark({ breathe: true, small: true }), '保存中');
    try {
      await saveDirty();
      toast('已保存，几秒后会自动运行一次');
    } catch (e) {
      toast(`保存失败：${explain(e)}`, { tone: 'danger' });
      save.disabled = false;
      save.replaceChildren('保存');
    }
  });
  const discard = h('button', {
    type: 'button', class: 'btn btn-ghost btn-sm',
    onclick: async () => {
      if (!(await confirmDialog({ title: '放弃更改？', message: `${what}的改动会还原成上次保存的样子。`, confirmLabel: '放弃', danger: true }))) return;
      try { await discardDirty(); render(); } catch (e) { toast(explain(e), { tone: 'danger' }); }
    },
  }, '放弃');
  const bar = h('div', { class: 'savebar', role: 'region', 'aria-label': '未保存的更改', dataset: { key } },
    h('span', { class: 'savebar-text' }, `${what}有未保存的更改`), discard, save);
  savebarSlot.replaceChildren(bar);
}

// ---------------------------------------------------------------- 渲染

/* 滚动位置：离开一页时记在这条历史记录上（连同页面自己要记住的，比如信息流已经显示了多少篇），
 * 后退回来时恢复。点链接新打开的页面没有记录，从顶部开始。 */
function remember() {
  if (!shell || !current) return;
  try {
    history.replaceState({ ...history.state, scroll: shell.scroller.scrollTop, view: current.page.snapshot?.() }, '');
  } catch { /* Safari 限制调用频率；记不住就从顶部开始 */ }
}
nav.leaving = remember;

/** 从列表或简报点开一篇时，记下同一栏（data-sequence 标出的区块，比如简报的「特稿」、文章列表）里文章的顺序，
 * 阅读器末尾的「下一篇」照着走。 */
function readingSequence(link) {
  const scope = link.closest('[data-sequence]') || shell.host;
  const seen = new Set();
  const out = [];
  for (const a of scope.querySelectorAll('a[href^="#/article/"]')) {
    const id = decodeURIComponent(a.getAttribute('href').slice('#/article/'.length));
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: a.dataset.title || a.textContent.trim() });
  }
  return out;
}

document.addEventListener('click', (e) => {
  const a = e.target.closest?.('a[href^="#"]');
  if (!a || !shell) return;
  remember();
  // 阅读器里点「下一篇」不改顺序
  if (a.getAttribute('href').startsWith('#/article/') && current?.route.name !== 'article') setSequence(readingSequence(a));
}, true);

function render({ restore = false } = {}) {
  closeMenu();
  if (!S.token) {
    shell = null;
    app.replaceChildren(LoginView());
    document.title = '登录 · Feed Hub';
    return;
  }
  if (!S.feeds) {
    app.replaceChildren(h('div', { class: 'loading page-loading' }, h('div', { class: 'thinking' }, mark({ breathe: true }), h('span', {}, '正在连接 GitHub…'))));
    return;
  }
  if (!shell) {
    shell = buildShell();
    app.replaceChildren(shell.root);
  }
  const route = parseRoute();
  const def = routeDef(route);
  if (current?.page?.destroy) current.page.destroy();
  const saved = restore ? history.state : null;
  const page = def.page(route, saved?.view);
  current = { route, page, def };
  shell.host.replaceChildren(page.el);
  const title = def === ROUTES.articles ? streamTitle(route) : def.title;
  shell.topTitle.textContent = title;
  document.title = `${title} · Feed Hub`;
  shell.root.classList.toggle('is-collapsed', S.sidebarCollapsed);
  shell.root.dataset.route = route.name || 'home';
  applyPrefs();
  renderSidebar(route);
  renderTabbar(route);
  renderSavebar(route);
  shell.jumpTo(saved?.scroll || 0);
  page.onShow?.(shell.scroller);
}

function applyPrefs() {
  shell.root.classList.toggle('is-collapsed', S.sidebarCollapsed);
  shell.root.dataset.readingFont = S.readingFont;
  shell.root.dataset.readingSize = S.readingSize;
}

onChange((what) => {
  if (!shell || !current) return;
  if (what.has('prefs')) applyPrefs();
  if (what.has('dirty')) renderSavebar(current.route);
  if (what.has('config') || what.has('status') || what.has('items') || what.has('read')) {
    renderSidebar(current.route);
    renderTabbar(current.route);
  }
  // 在设置里切换了推送方式：首页换成另一种
  if (what.has('config') && !current.route.name && routeDef(current.route) !== current.def) render();
  current.page.refresh?.(what);
});

window.addEventListener('hashchange', () => {
  nav.previous = current?.route || null;
  render({ restore: true });
});
// 从后台切回来（比如早上点开主屏幕图标）：数据旧了就在后台刷新
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshStale();
});
window.addEventListener('feedhub:logout', logout);
window.addEventListener('beforeunload', (e) => {
  if (S.feedsDirty || S.settingsDirty) { e.preventDefault(); e.returnValue = ''; }
});

// 编辑配置的页面绑定着配置对象，读到最新的配置后要重建
const EDIT_ROUTES = new Set(['settings', 'feeds']);

async function boot() {
  initTooltips();
  if (!S.token || !S.repo) { render(); return; }
  render(); // 有本机缓存时直接显示上次的内容
  try {
    await loadAll();
    // 从缓存打开的阅读页面只刷新数据，不重建，免得打断正在读的位置
    if (!fromCache || !current || EDIT_ROUTES.has(current.route.name)) render();
    watchTranslations(); // 上次点了「翻译」还没等到结果：接着等
  } catch (e) {
    if (e.status === 401) {
      disconnect();
      app.replaceChildren(LoginView('token 已失效或过期，请重新登录。'));
      return;
    }
    if (fromCache && shell) {
      toast(`没连上 GitHub（${explain(e)}），先显示上次的内容`, { tone: 'danger' });
      return;
    }
    shell = null;
    app.replaceChildren(ErrorView(explain(e)));
  }
}

boot();
