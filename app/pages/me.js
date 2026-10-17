/* 我的（手机底部第三个标签）：账户、模型余额、阅读记录（热力图）、往期简报、收藏和稍后阅读，
 * 以及不常用的管理页面入口：设置、订阅源、运行记录。 */
import { h, icon, timeAgo } from '../../assets/ui.js';
import {
  S, displayName, initials, failingFeeds, loadStatus, loadLibrary, laterUnread, loadUsage, latestBalance, fmtMoney,
  usageDay,
} from '../store.js';
import { loadReading } from '../reading.js';
import { readingCard } from './reading.js';
import { LOCAL } from '../api.js';

/** 往期简报有几期（最近几天、有内容的）。 */
function editionCount() {
  const since = Date.now() - (S.settings?.digest?.days || 7) * 86400e3;
  const n = (S.briefings || []).filter((e) => e.total && Date.parse(e.published) >= since).length;
  return n ? `${n} 期` : '';
}

/** 模型余额：点开是用量看板。余额是最近一次运行时查到的。 */
function balanceCard() {
  const b = latestBalance();
  const today = S.usage?.days?.[usageDay()];
  const meta = b ? [today?.spent ? `今天花了 ${fmtMoney(today.spent, b.currency)}` : '', `${timeAgo(b.at)}查询`]
    : [S.usage || S.runs ? '还没查到余额，点开看用量' : '正在读取…'];
  return h('a', { class: `me-balance${b && !b.available ? ' is-warning' : ''}`, href: '#/usage' },
    h('span', { class: 'me-balance-text' },
      h('span', { class: 'me-balance-label' }, icon('wallet'), 'DeepSeek 余额'),
      h('span', { class: 'me-balance-value' }, b ? fmtMoney(b.total, b.currency) : '—'),
      h('span', { class: 'me-balance-meta' }, meta.filter(Boolean).join(' · '))),
    h('span', { class: 'me-balance-go' }, '用量', icon('chevron-right')));
}

function row(href, iconName, label, hint, { external = false } = {}) {
  return h('a', {
    class: 'me-row', href, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
  },
  icon(iconName),
  h('span', { class: 'me-row-label' }, label),
  hint ? h('span', { class: 'me-row-hint' }, hint) : null,
  icon(external ? 'external-link' : 'chevron-right', { cls: 'me-row-go' }));
}

export function MePage() {
  const balance = h('div', { class: 'me-balance-slot' });
  const reading = h('div', { class: 'me-reading-slot' });
  const saved = h('div', { class: 'me-list' });
  const list = h('div', { class: 'me-list' });
  const el = h('div', { class: 'page page-narrow me' },
    h('header', { class: 'me-head' },
      h('span', { class: 'avatar avatar-lg' }, initials()),
      h('div', {},
        h('h1', { class: 'me-name' }, displayName() || S.repo),
        h('p', { class: 'me-sub' }, LOCAL ? '这台 Mac' : S.repo))),
    balance, reading, saved, list);

  function draw() {
    const enabled = S.feeds ? S.feeds.feeds.filter((f) => f.enabled).length : null;
    const failing = failingFeeds().length;
    const last = S.runs?.[0]?.started_at;
    const favorites = S.library?.favorites.length || 0;
    const later = S.library?.later.length || 0;
    const unread = laterUnread();
    balance.replaceChildren(balanceCard());
    reading.replaceChildren(readingCard());
    saved.replaceChildren(
      S.settings?.digest?.enabled !== false ? row('#/editions', 'archive', '往期简报', editionCount()) : null,
      row('#/favorites', 'star', '收藏', favorites ? `${favorites} 项` : ''),
      row('#/later', 'clock', '稍后阅读', later ? (unread ? `${unread} 篇没读` : `${later} 篇，都读过了`) : ''),
    );
    list.replaceChildren(
      row('#/settings', 'settings', '设置', '兴趣、简报时间、阅读'),
      row('#/feeds', 'rss', '订阅源', enabled != null ? `${enabled} 个${failing ? `，${failing} 个出错` : ''}` : ''),
      row('#/runs', 'history', '运行记录', last ? `上次 ${timeAgo(last)}` : ''),
    );
  }

  draw();
  if (!S.runs) loadStatus();
  if (!S.library) loadLibrary();
  loadUsage(); // 今天花了多少；余额也可能比运行记录里的新
  loadReading();
  return {
    el,
    refresh(what) {
      if (['status', 'config', 'library', 'usage', 'briefings', 'reading'].some((w) => what.has(w))) draw();
    },
  };
}
