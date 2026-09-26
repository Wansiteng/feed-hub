/* 信息流：像 Reeder 一样一条条读推送的文章。按篇推送模式下是首页，简报模式下在「全部文章」里。
 * 侧边栏切换视图（全部 / 重要 / 已过滤）和分组；右上角搜索、刷新、全部标为已读。 */
import { h, icon, iconButton, thinking, toast, fmtTime, nodes, mark } from '../../assets/ui.js';
import {
  S, loadItems, groupName, isRead, markRead, recentItems, briefingMode, canTranslate, isTranslating, requestTranslation,
} from '../store.js';
import { explain } from '../api.js';
import { itemTitle, articleLink, itemBadges, emptyState, voteButtons } from '../common.js';

export const VIEWS = {
  all: { title: '全部文章', icon: 'newspaper', match: (it) => it.status === 'passed' },
  important: { title: '重要', icon: 'star', match: (it) => it.status === 'passed' && it.important },
  filtered: { title: '已过滤', icon: 'funnel', match: (it) => it.status === 'filtered' },
};
// 旧的「文章」页地址（#/articles?status=…）也能打开
const OLD_STATUS = { passed: 'all', important: 'important', filtered: 'filtered', all: 'all' };
const CHUNK = 40;
const WEEKDAYS = '日一二三四五六';

/** 地址里的视图、分组、搜索词。 */
export function streamState(route) {
  const p = route.params;
  let view = p.get('view') || OLD_STATUS[p.get('status')] || 'all';
  if (!VIEWS[view]) view = 'all';
  return { view, group: p.get('group') || '', q: p.get('q') || '' };
}

export function streamTitle(route) {
  const { view, group } = streamState(route);
  return group ? groupName(group) : VIEWS[view].title;
}

/** 信息流某个视图的地址。home：信息流就是首页（按篇推送模式）。 */
export function streamHash({ view = 'all', group = '', q = '' }, home = false) {
  const p = new URLSearchParams();
  if (view !== 'all') p.set('view', view);
  if (group) p.set('group', group);
  if (q) p.set('q', q);
  const qs = p.toString();
  return `#/${home ? '' : 'articles'}${qs ? `?${qs}` : ''}`;
}

function when(it) {
  return it.published || it.processed_at || '';
}

function dayLabel(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '更早';
  const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${WEEKDAYS[d.getDay()]}`;
}

function shortTime(iso) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(s)) return '';
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return fmtTime(iso).replace(/^.*\s/, ''); // 更早的只写时刻，日期在分隔标题里
}

function avatarText(name) {
  const clean = (name || '').replace(/^r\//, '').trim();
  return ([...clean][0] || '·').toUpperCase();
}

export function StreamPage(route, saved) {
  // saved：从阅读器后退回来时，离开前已经显示了多少篇（滚动位置由外壳恢复）
  const state = { ...streamState(route), limit: Math.max(CHUNK, saved?.limit || 0) };
  const searching = { open: !!state.q };

  const title = h('h1', { class: 'stream-title' });
  const sub = h('p', { class: 'stream-sub' });
  const search = h('input', {
    class: 'input', type: 'search', value: state.q, placeholder: '搜索标题、来源、要点', 'aria-label': '搜索文章',
    oninput: (e) => { state.q = e.target.value; state.limit = CHUNK; sync(); draw(); },
    onkeydown: (e) => { if (e.key === 'Escape') toggleSearch(false); },
  });
  const searchBox = h('div', { class: 'stream-search input-with-icon' }, icon('search'), search);
  const readAllBtn = iconButton('check', '全部标为已读', markAllRead, { cls: 'stream-read-all' });
  const actions = h('div', { class: 'stream-actions' },
    iconButton('search', '搜索', () => toggleSearch(!searching.open)),
    iconButton('refresh-cw', '刷新', refresh),
    readAllBtn);
  const head = h('header', { class: 'stream-head' }, h('div', { class: 'stream-head-text' }, title, sub), actions);
  // 手机上没有侧边栏：视图和分组放在标题下面一排，可以左右滑
  const chips = h('nav', { class: 'stream-chips', 'aria-label': '视图和分组' });
  const list = h('div', { class: 'stream-list', dataset: { sequence: '' } });
  const sentinel = h('div', { class: 'stream-sentinel' });
  const el = h('div', { class: 'page stream' }, head, chips, searchBox, list, sentinel);

  function drawChips() {
    const home = !route.name && !briefingMode();
    const chip = (label, target, on) => h('a', {
      class: `chip${on ? ' is-current' : ''}`, href: streamHash(target, home), 'aria-current': on ? 'page' : null,
    }, label);
    chips.replaceChildren(
      ...Object.entries(VIEWS).map(([id, v]) => chip(id === 'all' ? '全部' : v.title, { view: id }, !state.group && state.view === id)),
      ...(S.feeds?.groups || []).map((g) => chip(g.name || g.id, { group: g.id }, state.group === g.id)),
    );
  }

  // 滚到底部附近自动再显示一批
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting) && state.limit < filtered().length) {
      state.limit += CHUNK;
      draw();
    }
  }, { rootMargin: '600px 0px' });
  observer.observe(sentinel);

  function sync() { history.replaceState(history.state, '', streamHash(state, !route.name && !briefingMode())); }

  function toggleSearch(open) {
    searching.open = open;
    searchBox.classList.toggle('is-open', open);
    if (open) search.focus();
    else if (state.q) { state.q = ''; search.value = ''; sync(); draw(); }
  }

  async function refresh() {
    await loadItems({ force: true });
    toast(S.itemsError ? `刷新失败：${S.itemsError}` : '已刷新');
  }

  function base() {
    const v = VIEWS[state.view];
    return (S.items || []).filter((it) => v.match(it) && (!state.group || it.group === state.group));
  }

  function filtered() {
    const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
    const all = base().filter((it) => {
      if (!terms.length) return true;
      const hay = [it.title_zh, it.title, it.reason, it.feed_name, ...(it.key_points || [])].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    return all.sort((a, b) => (when(a) < when(b) ? 1 : when(a) > when(b) ? -1 : 0));
  }

  function markAllRead() {
    const ids = filtered().filter((it) => !isRead(it.id)).map((it) => it.id);
    ids.forEach(markRead);
    toast(ids.length ? `${ids.length} 篇标为已读` : '没有未读的文章');
  }

  /** 「翻译」：还没翻译的外文文章。点了之后显示「翻译中」，译好后按钮消失，点开就是中英对照。 */
  function translateControl(it) {
    if (isTranslating(it.id)) {
      return h('span', { class: 'translate-wait', role: 'status' }, mark({ breathe: true, small: true }), '翻译中');
    }
    if (!canTranslate(it)) return null;
    return h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm translate-btn',
      title: '中英对照翻译这篇：每段原文下面跟着译文，一两分钟后译好',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await requestTranslation(it);
          toast('开始翻译了，一两分钟后译好');
        } catch (err) {
          btn.disabled = false;
          toast(`没能开始翻译：${explain(err)}`, { tone: 'danger' });
        }
      },
    }, icon('languages'), it.translation === 'failed' ? '重新翻译' : '翻译');
  }

  function card(it) {
    const reading = it.status === 'passed' || it.status === 'duplicate';
    const points = it.key_points?.length ? it.key_points.join('；') : '';
    const preview = state.view === 'filtered'
      ? `${it.score != null ? `AI 评分 ${it.score}：` : ''}${it.reason || ''}`
      : points || it.reason || '';
    const image = /^https?:\/\//.test(it.image || '') ? it.image : '';
    const thumb = image ? h('img', {
      class: 'card-thumb', src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      onerror: (e) => e.target.remove(),
    }) : null;
    const link = h('a', {
      class: 'card-link', ...articleLink(it), dataset: { title: itemTitle(it) },
      onclick: () => { if (reading) markRead(it.id); },
    },
    h('span', { class: 'card-avatar', 'aria-hidden': 'true' }, avatarText(it.feed_name)),
    h('div', { class: 'card-meta' },
      h('span', { class: 'card-source' }, it.feed_name || it.feed_id || ''),
      it.important ? icon('star', { cls: 'card-star' }) : null,
      h('span', { class: 'card-time' }, shortTime(when(it)))),
    h('div', { class: 'card-body' },
      h('h2', { class: 'card-title' }, itemTitle(it)),
      preview ? h('p', { class: 'card-preview' }, preview) : null),
    thumb);
    // 重要已经用星标表示；已过滤视图里不用再标「已过滤」
    const badges = itemBadges({ ...it, important: false })
      .filter((b) => b && !(state.view === 'filtered' && b.textContent === '已过滤'));
    return h('article', { class: `card-item${reading && isRead(it.id) ? ' is-read' : ''}` },
      link,
      h('div', { class: 'card-foot' }, h('div', { class: 'card-badges' }, badges), translateControl(it), voteButtons(it)));
  }

  function drawHead(all) {
    title.textContent = state.group ? groupName(state.group) : VIEWS[state.view].title;
    const unread = all.filter((it) => !isRead(it.id)).length;
    readAllBtn.hidden = state.view === 'filtered' || !unread;
    if (state.view === 'filtered') {
      sub.textContent = `${all.length} 篇被 AI 过滤掉。觉得过滤错了就点「撤销」：下次运行会推送给你，AI 以后也会少犯同样的错。`;
    } else if (state.view === 'all' && !state.group && briefingMode()) {
      const day = recentItems(24, (it) => it.status === 'passed');
      sub.textContent = `过去 24 小时 AI 挑出 ${day.length} 篇，简报从这里选题。重磅和特稿会自动翻译；想读别的，点「翻译」按中英对照翻译。`;
    } else if (state.view === 'all' && !state.group) {
      const day = recentItems(24, (it) => it.status === 'passed');
      const imp = day.filter((it) => it.important).length;
      sub.textContent = `过去 24 小时推送 ${day.length} 篇${imp ? `，重要 ${imp} 篇` : ''}${unread ? ` · ${unread} 篇未读` : ''}`;
    } else {
      sub.textContent = `${all.length} 篇${unread ? ` · ${unread} 篇未读` : ''}`;
    }
  }

  function draw() {
    drawChips();
    searchBox.classList.toggle('is-open', searching.open);
    if (!S.items) {
      title.textContent = state.group ? groupName(state.group) : VIEWS[state.view].title;
      list.replaceChildren(h('div', { class: 'loading' }, thinking('正在读取文章…')));
      return;
    }
    if (S.itemsError && !S.items.length) {
      list.replaceChildren(emptyState('读取失败', S.itemsError));
      return;
    }
    drawHead(base());
    const all = filtered();
    if (!all.length) {
      list.replaceChildren(state.q
        ? emptyState('没有找到', '换个关键词试试。')
        : S.items.length
          ? emptyState(state.view === 'filtered' ? '没有被过滤的文章' : '这里还没有文章', '有新文章推送后会出现在这里。')
          : emptyState('还没有文章', '第一次运行之后，推送的文章会出现在这里。可以去「运行记录」点「立即运行」。'));
      return;
    }
    const shown = all.slice(0, state.limit);
    const out = [];
    let day = null;
    for (const it of shown) {
      const label = dayLabel(when(it));
      if (label !== day) {
        out.push(h('h3', { class: 'stream-day' }, label));
        day = label;
      }
      out.push(card(it));
    }
    list.replaceChildren(...nodes(out,
      all.length > shown.length
        ? h('div', { class: 'list-more' }, h('button', {
          type: 'button', class: 'btn btn-secondary', onclick: () => { state.limit += CHUNK; draw(); },
        }, `再显示 ${Math.min(CHUNK, all.length - shown.length)} 篇`))
        : null));
  }

  draw();
  loadItems();

  return {
    el,
    destroy() { observer.disconnect(); },
    snapshot: () => ({ limit: state.limit }),
    refresh(what) {
      if (['items', 'config', 'feedback', 'read', 'translating'].some((w) => what.has(w))) draw();
    },
  };
}
