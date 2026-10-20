/* 阅读记录（「我的 → 阅读记录」）：像 GitHub 的贡献图，一格一天，读得越久颜色越深；点一格看那天读了什么。
 * 下面是一段时间（近 7 天 / 近 30 天 / 今年）的阅读时长、读过的文章、连续阅读天数，读得最多的分组、来源和文章。
 * 数据来自 config/reading.json 加上本机还没写进去的（见 reading.js）。「我的」上面的小卡片也在这里（readingCard）。 */
import { h, icon, segmented } from '../../assets/ui.js';
import { S, groupName, briefingMode } from '../store.js';
import {
  readingData, loadReading, dayKey, daySeconds, heatLevel, fmtDuration, streaks, summarize, isEditionKey, READ_MIN,
} from '../reading.js';
import { emptyState } from '../common.js';

const WEEKDAYS = '日一二三四五六';
const LEVEL_TEXT = ['没有阅读', '不到 5 分钟', '5 到 15 分钟', '15 到 30 分钟', '半小时以上'];
const RANGES = [
  { value: '7', label: '近 7 天' },
  { value: '30', label: '近 30 天' },
  { value: 'year', label: '今年' },
];

function dayLabel(day) {
  const [, m, d] = day.split('-').map(Number);
  const label = `${m} 月 ${d} 日 周${WEEKDAYS[new Date(`${day}T12:00:00`).getDay()]}`;
  return day === dayKey() ? `今天 · ${label}` : label;
}

function daysAgo(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

/**
 * 热力图：一列一周（周一在最上面），最右一列是这一周，今天以后的格子不画。
 * onSelect 有值时每一格是按钮（点了看那天）；labels 时左边标一、三、五，上面标月份。
 */
export function heatmap(data, { weeks = 53, selected = '', onSelect = null, labels = true } = {}) {
  const today = daysAgo(0);
  const todayKey = dayKey(today);
  const start = daysAgo((today.getDay() + 6) % 7 + (weeks - 1) * 7); // 第一列的周一
  const cells = [];
  if (labels) cells.push(h('span', { class: 'heat-wd' }), ...['一', '', '三', '', '五', '', ''].map((t) => h('span', { class: 'heat-wd' }, t)));
  let lastMonth = -1;
  for (let w = 0; w < weeks; w += 1) {
    const monday = new Date(start);
    monday.setDate(start.getDate() + w * 7);
    // 每个月的第一列标上月份；最后两列放不下「10月」这样的字，不标
    const month = monday.getMonth();
    const showMonth = month !== lastMonth && (w > 0 || monday.getDate() <= 7) && w < weeks - 2;
    lastMonth = month;
    cells.push(h('span', { class: 'heat-month' }, showMonth ? `${month + 1}月` : ''));
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      const key = dayKey(d);
      if (key > todayKey) { cells.push(h('span', { class: 'heat-cell is-future' })); continue; }
      const sec = daySeconds(data, key);
      const level = heatLevel(sec);
      const label = `${dayLabel(key)}：${sec ? fmtDuration(sec) : '没有阅读'}`;
      cells.push(onSelect
        ? h('button', {
          type: 'button', class: `heat-cell${key === selected ? ' is-selected' : ''}`, dataset: { level: String(level), day: key },
          'aria-label': label, 'aria-pressed': String(key === selected), onclick: () => onSelect(key),
        })
        : h('span', { class: 'heat-cell', dataset: { level: String(level) }, title: label }));
    }
  }
  return h('div', { class: `heat${labels ? ' has-labels' : ''}`, role: 'group', 'aria-label': '每天的阅读时长' }, cells);
}

function legend() {
  return h('p', { class: 'heat-legend' }, '少',
    [0, 1, 2, 3, 4].map((l) => h('span', { class: 'heat-cell', dataset: { level: String(l) }, title: LEVEL_TEXT[l] })), '多');
}

/** 「我的」里的小卡片：最近几个月的热力图（放不下的早几周藏在左边），点开是阅读记录。 */
export function readingCard() {
  const data = readingData();
  const week = summarize(data, dayKey(daysAgo((new Date().getDay() + 6) % 7)));
  const today = daySeconds(data, dayKey());
  const { current } = streaks(data);
  const meta = [today ? `今天 ${fmtDuration(today)}` : '今天还没读', current > 1 ? `连续 ${current} 天` : ''].filter(Boolean);
  return h('a', { class: 'me-reading', href: '#/reading' },
    h('span', { class: 'me-reading-head' },
      h('span', { class: 'me-balance-label' }, icon('calendar-days'), '阅读记录'),
      h('span', { class: 'me-balance-go' }, week.seconds ? `本周 ${fmtDuration(week.seconds)}` : '本周还没读', icon('chevron-right'))),
    h('span', { class: 'me-reading-map' }, heatmap(data, { weeks: 26, labels: false })),
    h('span', { class: 'me-balance-meta' }, meta.join(' · ')));
}

function entryHref(key) {
  if (!isEditionKey(key)) return `#/article/${encodeURIComponent(key)}`;
  const id = encodeURIComponent(key.slice(2));
  return briefingMode() ? `#/?edition=${id}` : `#/briefing?edition=${id}`;
}

function entryRow(data, key, sec) {
  const meta = data.items[key] || {};
  const edition = isEditionKey(key);
  const title = meta.t || (edition ? '简报' : '（标题没有保存）');
  const sub = [edition ? '简报' : meta.f, fmtDuration(sec)].filter(Boolean).join(' · ');
  return h('a', { class: 'reading-entry', href: entryHref(key) },
    h('span', { class: 'reading-entry-title' }, title),
    h('span', { class: 'reading-entry-meta' }, sub));
}

/** 名字和时长占一行，下面是占比的横条（来源的名字可能很长）。 */
function bars(rows, total, label) {
  return h('ul', { class: 'reading-shares', 'aria-label': label }, rows.map(([name, sec]) => {
    const share = total ? Math.round((sec / total) * 100) : 0;
    return h('li', { class: 'reading-share' },
      h('span', { class: 'reading-share-name' }, name),
      h('span', { class: 'reading-share-value' }, `${fmtDuration(sec)} · ${share}%`),
      h('span', { class: 'reading-share-bar' }, h('span', { style: `width: ${Math.max(share, 1)}%` })));
  }));
}

function tile(label, value, note) {
  return h('div', { class: 'usage-tile' },
    h('span', { class: 'usage-tile-label' }, label),
    h('span', { class: 'usage-tile-value' }, value),
    h('span', { class: 'usage-tile-note' }, note));
}

export function ReadingPage() {
  const sub = h('p', { class: 'page-sub' });
  const body = h('div', { class: 'usage-body reading-body' });
  const el = h('div', { class: 'page page-narrow reading' },
    h('header', { class: 'lib-head' }, h('div', { class: 'lib-head-text' }, h('h1', { class: 'page-title' }, '阅读记录'), sub)),
    body);
  let selected = dayKey();
  let range = '7';
  let scroller = null;
  const rangeCtl = segmented({ items: RANGES, value: range, label: '时间范围', onChange: (v) => { range = v; draw(); } });

  function from() {
    if (range === 'year') return `${new Date().getFullYear()}-01-01`;
    return dayKey(daysAgo(Number(range) - 1));
  }

  function dayDetail(data) {
    const entries = Object.entries(data.days[selected] || {}).sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((s, [, v]) => s + v, 0);
    return h('section', { class: 'reading-day', 'aria-live': 'polite' },
      h('p', { class: 'usage-day' }, h('strong', {}, dayLabel(selected)), total ? ` · ${fmtDuration(total)}` : ' · 没有阅读'),
      entries.length ? h('div', { class: 'reading-entries', dataset: { sequence: '' } }, entries.map(([k, v]) => entryRow(data, k, v))) : null);
  }

  function stats(data) {
    const s = summarize(data, from());
    const span = range === 'year'
      ? Math.round((daysAgo(0) - new Date(new Date().getFullYear(), 0, 1, 12)) / 86400e3) + 1 : Number(range);
    const { current, best } = streaks(data);
    const groups = s.groups.map(([g, sec]) => [g === '__edition' ? '简报' : groupName(g), sec]);
    const top = Object.entries(s.per).filter(([k, v]) => !isEditionKey(k) && v >= READ_MIN)
      .sort((a, b) => b[1] - a[1]).slice(0, 5);
    return [
      h('div', { class: 'reading-range' }, rangeCtl.el),
      h('div', { class: 'usage-tiles' },
        tile('阅读时长', fmtDuration(s.seconds), `${s.days} 天有阅读`),
        tile('读过的文章', `${s.articles.length} 篇`, s.editions.length ? `简报 ${s.editions.length} 期` : '—'),
        tile('日均', fmtDuration(s.seconds / span), `共 ${span} 天`),
        tile('连续阅读', `${current} 天`, `最长 ${best} 天`)),
      groups.length ? h('section', { class: 'usage-section' },
        h('h2', { class: 'usage-h' }, '感兴趣的内容', h('span', { class: 'usage-h-note' }, '按分组 · 阅读时长')),
        bars(groups.slice(0, 8), s.seconds, '按分组')) : null,
      s.sources.length ? h('section', { class: 'usage-section' },
        h('h2', { class: 'usage-h' }, '常读的来源'),
        bars(s.sources.slice(0, 6), s.seconds, '按来源')) : null,
      top.length ? h('section', { class: 'usage-section' },
        h('h2', { class: 'usage-h' }, '读得最久'),
        h('div', { class: 'reading-entries', dataset: { sequence: '' } }, top.map(([k, v]) => entryRow(data, k, v)))) : null,
    ];
  }

  function draw() {
    const data = readingData();
    const days = Object.keys(data.days).filter((d) => daySeconds(data, d) > 0);
    const year = summarize(data, dayKey(daysAgo(364)));
    sub.textContent = days.length ? `近一年读了 ${fmtDuration(year.seconds)} · ${year.articles.length} 篇文章` : '';
    if (!days.length && S.reading == null && !S.readingError) {
      body.replaceChildren(h('div', { class: 'loading' }, '正在读取…'));
      return;
    }
    const keep = scroller?.scrollLeft; // 重画时热力图停在原来的位置
    scroller = h('div', { class: 'heat-scroll' }, heatmap(data, { selected, onSelect: (d) => { selected = d; draw(); } }));
    body.replaceChildren(...[
      S.readingError && !days.length ? emptyState('读取失败', S.readingError) : null,
      h('section', { class: 'usage-section reading-map' },
        scroller,
        legend()),
      dayDetail(data),
      ...(days.length ? stats(data) : [h('p', { class: 'usage-empty' }, '暂无阅读记录')]),
    ].filter(Boolean));
    if (keep != null) scroller.scrollLeft = keep;
  }

  draw();
  loadReading();
  return {
    el,
    refresh(what) {
      if (what.has('reading') || what.has('config')) draw();
    },
  };
}
