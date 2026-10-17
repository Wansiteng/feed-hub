/* 模型用量看板（「我的 → 模型用量」）：DeepSeek 的余额、每天花了多少、token 用在哪里。
 * 数据来自 data 分支的 usage.json（每次运行记一次，见 feedhub/usage.py）。余额是最近一次运行时查到的，
 * 打开看板时如果已经过了一刻钟就自动运行一次取最新的，也可以点「刷新」。 */
import { h, icon, timeAgo, fmtTime, mark } from '../../assets/ui.js';
import {
  S, loadUsage, loadStatus, latestBalance, refreshBalance, fmtMoney, usageDays, usageDay,
} from '../store.js';
import { emptyState } from '../common.js';

const CHART_DAYS = 30;
const WEEKDAYS = '日一二三四五六';
const TASK_ORDER = ['翻译', '打分', '简报', '要点', '去重', '兴趣'];

/** token 数写成中文习惯的单位：8600、12.3 万、1.2 亿。 */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1).replace(/\.0$/, '')} 亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1).replace(/\.0$/, '')} 万`;
  return String(v);
}

const tokensOf = (d) => (d.prompt_tokens || 0) + (d.completion_tokens || 0);
const sum = (list, key) => list.reduce((s, d) => s + (typeof key === 'function' ? key(d) : d[key] || 0), 0);

function dayLabel(d) {
  const [, m, day] = d.key.split('-').map(Number);
  return d.key === usageDay() ? '今天' : `${m} 月 ${day} 日 周${WEEKDAYS[new Date(`${d.key}T12:00:00`).getDay()]}`;
}

export function UsagePage() {
  const sub = h('p', { class: 'page-sub' });
  const refreshBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => refreshBalance() },
    icon('refresh-cw'), '刷新');
  const body = h('div', { class: 'usage-body' });
  const el = h('div', { class: 'page page-narrow usage' },
    h('header', { class: 'lib-head' },
      h('div', { class: 'lib-head-text' }, h('h1', { class: 'page-title' }, '模型用量'), sub),
      refreshBtn),
    body);
  let selected = usageDay(); // 图上点中的那一天

  /** 柱状图：每天一根，点一下看那天的明细。segments：[{ key, cls }] 叠在一起。 */
  function chart(days, segments, format, label) {
    const totals = days.map((d) => sum(segments, (s) => d[s.key] || 0));
    const max = Math.max(...totals, 0);
    const bars = days.map((d, i) => h('button', {
      type: 'button', class: `usage-bar${d.key === selected ? ' is-selected' : ''}`,
      'aria-label': `${dayLabel(d)}：${format(totals[i])}`, 'aria-pressed': String(d.key === selected),
      onclick: () => { selected = d.key; draw(); },
    }, h('span', { class: 'usage-bar-stack', style: `height: ${max ? Math.max(totals[i] ? 3 : 0, (totals[i] / max) * 100) : 0}%` },
      // 各段按占这一天的比例分高度（flex-grow 加起来是 1，正好填满）
      ...segments.map((s) => (d[s.key] ? h('span', { class: `usage-seg ${s.cls}`, style: `flex-grow: ${d[s.key] / totals[i]}` }) : null)))));
    const first = days[0].key.slice(5).replace('-', '/');
    const mid = days[Math.floor(days.length / 2)].key.slice(5).replace('-', '/');
    return h('figure', { class: 'usage-chart', 'aria-label': label },
      h('div', { class: 'usage-chart-max' }, max ? format(max) : ''),
      h('div', { class: 'usage-bars' }, bars),
      h('figcaption', { class: 'usage-axis' }, h('span', {}, first), h('span', {}, mid), h('span', {}, '今天')));
  }

  function balanceCard(b) {
    const days7 = usageDays(7);
    const spent7 = sum(days7, 'spent');
    const perDay = spent7 / 7;
    const left = b && perDay > 0 ? Math.floor(b.total / perDay) : null;
    const warn = b && (!b.available || (left != null && left < 14));
    return h('section', { class: `usage-balance${warn ? ' is-warning' : ''}` },
      h('p', { class: 'usage-label' }, icon('wallet'), 'DeepSeek 余额'),
      h('p', { class: 'usage-balance-value' }, fmtMoney(b.total, b.currency)),
      h('p', { class: 'usage-balance-meta' }, [
        `充值 ${fmtMoney(b.topped_up, b.currency)}`, `赠送 ${fmtMoney(b.granted, b.currency)}`,
      ].join(' · ')),
      !b.available ? h('p', { class: 'usage-balance-note' }, icon('circle-alert'), '余额不足，模型调用将失败，请前往 DeepSeek 开放平台充值')
        : left != null ? h('p', { class: 'usage-balance-note' }, left < 14 ? icon('circle-alert') : null,
          `按近 7 天日均 ${fmtMoney(perDay, b.currency)}，预计可用 ${left > 999 ? '999+' : left} 天`) : null);
  }

  function tiles(cur) {
    const days = usageDays(CHART_DAYS);
    const today = days[days.length - 1];
    const last7 = days.slice(-7);
    const prompt7 = sum(last7, 'prompt_tokens');
    const hit = prompt7 ? Math.round((sum(last7, 'cache_hit_tokens') / prompt7) * 100) : null;
    const tile = (label, value, note) => h('div', { class: 'usage-tile' },
      h('span', { class: 'usage-tile-label' }, label), h('span', { class: 'usage-tile-value' }, value),
      note ? h('span', { class: 'usage-tile-note' }, note) : null);
    return h('div', { class: 'usage-tiles' },
      tile('今天花费', fmtMoney(today.spent || 0, cur), `${today.requests || 0} 次调用`),
      tile('近 7 天', fmtMoney(sum(last7, 'spent'), cur), `${fmtTokens(sum(last7, tokensOf))} tokens`),
      tile('近 30 天', fmtMoney(sum(days, 'spent'), cur), `${fmtTokens(sum(days, tokensOf))} tokens`),
      tile('缓存命中', hit == null ? '—' : `${hit}%`, '近 7 天输入'));
  }

  function dayDetail(d, cur) {
    const parts = [
      d.spent ? `花费 ${fmtMoney(d.spent, cur)}` : '没有花费记录',
      d.topped_up ? `充值 ${fmtMoney(d.topped_up, cur)}` : '',
      d.runs ? `${d.runs} 次运行、${d.requests || 0} 次调用` : '没有运行',
      tokensOf(d) ? `输入 ${fmtTokens(d.prompt_tokens)}（缓存命中 ${fmtTokens(d.cache_hit_tokens)}）/ 输出 ${fmtTokens(d.completion_tokens)} tokens` : '',
      d.failures ? `${d.failures} 次调用失败` : '',
    ].filter(Boolean);
    return h('p', { class: 'usage-day' }, h('strong', {}, dayLabel(d)), ` · ${parts.join(' · ')}`);
  }

  function tasks() {
    const totals = {};
    for (const d of usageDays(7)) {
      for (const [name, t] of Object.entries(d.tasks || {})) {
        const x = totals[name] || (totals[name] = { requests: 0, tokens: 0 });
        x.requests += t.requests || 0;
        x.tokens += tokensOf(t);
      }
    }
    const all = sum(Object.values(totals), 'tokens');
    const names = Object.keys(totals).sort((a, b) => totals[b].tokens - totals[a].tokens
      || TASK_ORDER.indexOf(a) - TASK_ORDER.indexOf(b));
    if (!all) return null;
    return h('section', { class: 'usage-section' },
      h('h2', { class: 'usage-h' }, '用在哪里', h('span', { class: 'usage-h-note' }, '近 7 天 · tokens')),
      h('ul', { class: 'usage-tasks' }, names.map((name) => {
        const share = Math.round((totals[name].tokens / all) * 100);
        return h('li', { class: 'usage-task' },
          h('span', { class: 'usage-task-name' }, name),
          h('span', { class: 'usage-task-bar' }, h('span', { style: `width: ${Math.max(share, 1)}%` })),
          h('span', { class: 'usage-task-value' }, `${share}%`),
          h('span', { class: 'usage-task-note' }, `${totals[name].requests} 次 · ${fmtTokens(totals[name].tokens)} tokens`));
      })));
  }

  function draw() {
    const b = latestBalance();
    refreshBtn.disabled = S.balanceRefreshing;
    refreshBtn.replaceChildren(...(S.balanceRefreshing ? [mark({ breathe: true, small: true }), '正在刷新'] : [icon('refresh-cw'), '刷新']));
    sub.replaceChildren(...(S.balanceRefreshing
      ? ['正在获取最新余额…']
      : S.balanceError ? [h('span', { class: 'usage-error' }, `没能刷新：${S.balanceError}`)]
        : b ? [`余额截至 ${fmtTime(b.at)}（${timeAgo(b.at)}）`] : ['']));

    if (!S.usage) {
      body.replaceChildren(S.usageError ? emptyState('读取失败', S.usageError) : h('div', { class: 'loading' }, '正在读取用量…'));
      return;
    }
    const cur = b?.currency || 'CNY';
    // prompt_miss：输入里没命中缓存的部分，叠柱子用
    const days = usageDays(CHART_DAYS).map((d) => ({ ...d, prompt_miss: Math.max(0, (d.prompt_tokens || 0) - (d.cache_hit_tokens || 0)) }));
    const pick = days.find((d) => d.key === selected) || days[days.length - 1];
    const hasSpend = days.some((d) => d.spent);
    const hasTokens = days.some((d) => tokensOf(d));
    const llmBase = S.settings?.llm?.base_url || '';
    body.replaceChildren(...[
      b ? balanceCard(b) : h('section', { class: 'usage-balance' },
        h('p', { class: 'usage-label' }, icon('wallet'), '余额'),
        h('p', { class: 'usage-balance-meta' }, /deepseek\.com/.test(llmBase) || !llmBase
          ? '暂无余额数据，点右上角「刷新」获取'
          : '当前接口不支持查询余额')),
      tiles(cur),
      h('section', { class: 'usage-section' },
        h('h2', { class: 'usage-h' }, '每天花费', h('span', { class: 'usage-h-note' }, `近 ${CHART_DAYS} 天`)),
        hasSpend ? chart(days, [{ key: 'spent', cls: 'is-spent' }], (v) => fmtMoney(v, cur), '每天花费')
          : h('p', { class: 'usage-empty' }, '暂无花费记录')),
      h('section', { class: 'usage-section' },
        h('h2', { class: 'usage-h' }, '每天用量', h('span', { class: 'usage-h-note' }, 'tokens')),
        hasTokens ? chart(days, [
          { key: 'completion_tokens', cls: 'is-output' },
          { key: 'prompt_miss', cls: 'is-input' },
          { key: 'cache_hit_tokens', cls: 'is-cached' },
        ], fmtTokens, '每天用量') : h('p', { class: 'usage-empty' }, '暂无用量记录'),
        hasTokens ? h('p', { class: 'usage-legend' },
          h('span', { class: 'usage-key is-output' }), '输出', h('span', { class: 'usage-key is-input' }), '输入',
          h('span', { class: 'usage-key is-cached' }), '输入（缓存命中）') : null),
      dayDetail(pick, cur),
      tasks(),
    ].filter(Boolean));
  }

  draw();
  loadUsage().then(() => refreshBalance({ auto: true }));
  if (!S.runs) loadStatus();
  return {
    el,
    refresh(what) {
      if (what.has('usage') || what.has('status') || what.has('config')) draw();
    },
  };
}
