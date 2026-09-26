/* 我的（手机底部第三个标签）：账户，以及不常用的管理页面入口：设置、订阅源、运行记录。 */
import { h, icon, timeAgo } from '../../assets/ui.js';
import { S, displayName, initials, failingFeeds, siteBase, loadStatus } from '../store.js';

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
  const list = h('div', { class: 'me-list' });
  const el = h('div', { class: 'page page-narrow me' },
    h('header', { class: 'me-head' },
      h('span', { class: 'avatar avatar-lg' }, initials()),
      h('div', {},
        h('h1', { class: 'me-name' }, displayName() || S.repo),
        h('p', { class: 'me-sub' }, S.repo))),
    list);

  function draw() {
    const enabled = S.feeds ? S.feeds.feeds.filter((f) => f.enabled).length : null;
    const failing = failingFeeds().length;
    const last = S.runs?.[0]?.started_at;
    const site = siteBase();
    list.replaceChildren(
      row('#/settings', 'settings', '设置', '兴趣、简报时间、阅读'),
      row('#/feeds', 'rss', '订阅源', enabled != null ? `${enabled} 个${failing ? `，${failing} 个出错` : ''}` : ''),
      row('#/runs', 'history', '运行记录', last ? `上次 ${timeAgo(last)}` : ''),
      site ? row(`${site}briefing/`, 'book-open', '往期简报（网页版）', '', { external: true }) : null,
    );
  }

  draw();
  if (!S.runs) loadStatus();
  return {
    el,
    refresh(what) {
      if (what.has('status') || what.has('config')) draw();
    },
  };
}
