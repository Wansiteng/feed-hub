/* 页面之间共用的小部件。 */
import { h, icon, badge, timeAgo } from '../assets/ui.js';
import { S, groupName, voteOf, setVote, modelStatus, pendingOverride } from './store.js';

export function pageHead(title, sub, actions = []) {
  return h('header', { class: 'page-head' },
    h('div', { class: 'page-head-text' },
      h('h1', { class: 'page-title' }, title),
      sub ? h('p', { class: 'page-sub' }, sub) : null),
    actions.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export function itemTitle(it) {
  return it.title_zh || it.title || '（无标题）';
}

/** 通过筛选的文章在站内阅读器打开；其余打开原文。 */
export function articleLink(it) {
  if (it.status === 'passed') return { href: `#/article/${encodeURIComponent(it.id)}` };
  // 重复报道打开并入的那篇
  if (it.status === 'duplicate' && it.duplicate_of) return { href: `#/article/${encodeURIComponent(it.duplicate_of)}` };
  return { href: it.link, target: '_blank', rel: 'noopener noreferrer' };
}

export function scoreBadge(it) {
  const filter = S.settings?.filter || {};
  const important = filter.important_threshold ?? 9;
  const threshold = filter.threshold ?? 6;
  let cls = 'score';
  if (it.score == null) cls += ' is-low';
  else if (it.score >= important) cls += ' is-important';
  else if (it.score < threshold) cls += ' is-low';
  return h('span', { class: cls, title: 'AI 评分', 'aria-label': `AI 评分 ${it.score ?? '未知'}` }, it.score ?? '?');
}

export function itemBadges(it) {
  return [
    it.important ? badge('重要', 'solid') : null,
    it.status === 'filtered' && it.user_override !== 'hide' ? badge('已过滤', 'outline') : null,
    ...overrideBadges(it),
    it.status === 'duplicate' ? badge('重复', 'outline') : null,
    it.status === 'error' ? badge(`打分失败 ×${it.attempts || 1}`, 'danger') : null,
    it.translation === 'pending' ? badge('排队翻译', 'warning') : null,
    it.translation === 'partial' ? badge('还在翻译', 'warning') : null,
    it.translation === 'failed' ? badge('翻译失败', 'danger') : null,
  ];
}

export function itemMeta(it) {
  return [it.feed_name || it.feed_id, groupName(it.group), timeAgo(it.published || it.processed_at)].filter(Boolean).join(' · ');
}

export function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} 分 ${s % 60} 秒` : `${m} 分钟`;
}

export function emptyState(title, text, action = null) {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), text ? h('p', {}, text) : null, action);
}

export function externalLink(href, text) {
  return h('a', { class: 'link', href, target: '_blank', rel: 'noopener noreferrer' }, text, ' ', icon('external-link'));
}

/** 「想多看 / 不想看」：用来校准以后的打分。 */
const PENDING_LABEL = { push: '等待推送', hide: '等待撤下', revert: '等待恢复' };

/** 读者改过的判断：生效了的标出来，还在等运行处理的也标出来。 */
function overrideBadges(it) {
  const pending = pendingOverride(it);
  if (pending) return [badge(PENDING_LABEL[pending], 'warning')];
  if (it.user_override === 'push') return [badge('你撤销了过滤', 'outline')];
  if (it.user_override === 'hide') return [badge('你不感兴趣', 'outline')];
  return [];
}

/**
 * 反馈按钮，按模型当初的判断给：
 * - 模型过滤了的：「撤销过滤」——推送这篇，也告诉 AI 它过滤错了
 * - 模型推送了的：「想多看」「不感兴趣」——不感兴趣会从 feed 里撤下，也告诉 AI 它推错了
 * 再点一次取消。纠正 AI 的反馈在打分提示词里分量最重（见 feedhub/score.py）。
 */
export function voteButtons(it, { labels = false } = {}) {
  const current = voteOf(it.id);
  const model = modelStatus(it);
  const make = (vote, iconName, text, title, { withText = labels } = {}) => h('button', {
    type: 'button',
    class: `btn ${labels ? 'btn-secondary' : withText ? 'btn-ghost btn-sm' : 'btn-icon btn-sm'} vote-btn${current === vote ? ' is-active' : ''}`,
    'aria-pressed': String(current === vote),
    'aria-label': title,
    title,
    onclick: (e) => {
      e.preventDefault();
      e.stopPropagation();
      setVote(it, current === vote ? 0 : vote);
    },
  }, icon(iconName), withText ? text : null);
  if (model === 'filtered') {
    // 列表里位置窄，用短一点的字；完整说明在 title 和 aria-label 里
    return h('div', { class: 'vote' }, current === 1
      ? make(1, 'rotate-ccw', labels ? '已撤销过滤' : '已撤销', '已撤销过滤，点一下恢复为已过滤', { withText: true })
      : make(1, 'rotate-ccw', labels ? '撤销过滤' : '撤销', '撤销过滤：推送这篇，并让 AI 以后多推这类内容', { withText: true }));
  }
  const passed = model === 'passed';
  return h('div', { class: 'vote' },
    make(1, 'thumbs-up', '想多看', '想多看这类内容'),
    make(-1, 'thumbs-down', passed ? '不感兴趣' : '不想看',
      passed ? '不感兴趣：从 feed 里撤下，并让 AI 以后少推这类内容' : '不想看这类内容'));
}
