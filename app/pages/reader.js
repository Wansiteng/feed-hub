/* 阅读器：第一屏就是正文。顶栏只有返回、字号和「…」，往下读时藏起来；要点折成一行，推荐理由放到文末；
 * 读完可以接着读「下一篇」（点开这篇的那一页上的下一篇）。正文来自订阅源和模型，先按白名单净化再显示。
 * 还没翻译的外文文章可以点「翻译」：一两分钟后自动换成中英对照（每段原文下面跟着译文）。 */
import {
  h, icon, iconButton, openMenu, thinking, sanitizeHtml, enhanceCodeBlocks, copyText, fmtTime, badge, nodes, mark, toast,
} from '../../assets/ui.js';
import {
  S, groupName, loadItems, markRead, setReadingSize, READING_SIZES, isTranslating, requestTranslation,
} from '../store.js';
import { readData, explain } from '../api.js';
import { itemTitle, scoreBadge, emptyState, voteButtons } from '../common.js';
import { nav, navigate, nextInSequence } from '../nav.js';

const SIZE_LABELS = { sm: '小', md: '标准', lg: '大', xl: '特大' };

export function ReaderPage(route) {
  const id = route.id;
  let content = h('div', { class: 'loading' }, thinking('正在读取正文…'));
  const more = iconButton('ellipsis', '更多', (e) => openMore(e.currentTarget), { small: true });
  const bar = h('div', { class: 'reader-bar' },
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm reader-back', onclick: back }, icon('arrow-left'), '返回'),
    h('span', { class: 'spacer' }),
    // 手机上返回和这一组各是一颗悬浮在正文上的毛玻璃按钮
    h('span', { class: 'reader-tools' },
      iconButton('a-large-small', '字号', (e) => openSizes(e.currentTarget), { small: true }),
      more));
  const el = h('article', { class: 'reader' }, bar, content);
  let article = null;
  let voteEl = null;
  let link = null;
  let waiting = isTranslating(id); // 点了「翻译」、在等译文

  function show(node) {
    content.replaceWith(node);
    content = node;
  }

  function back() {
    // 从站内点进来的就回到原来那一页（滚动位置会恢复）；直接打开的回首页
    if (nav.previous) history.back();
    else navigate('#/');
  }

  function openSizes(anchor) {
    openMenu(anchor, [
      { header: '字号' },
      ...READING_SIZES.map((size) => ({
        label: SIZE_LABELS[size], checked: S.readingSize === size, onSelect: () => setReadingSize(size),
      })),
    ], { align: 'end' });
  }

  function openMore(anchor) {
    openMenu(anchor, link ? [
      { label: '阅读原文', icon: 'external-link', onSelect: () => window.open(link, '_blank', 'noopener') },
      { label: '复制原文链接', icon: 'link', onSelect: () => copyText(link, '链接已复制') },
    ] : [{ label: '这篇没有原文链接', icon: 'info', disabled: true }], { align: 'end' });
  }

  async function load() {
    let data;
    try {
      data = await readData(`articles/${encodeURIComponent(id)}.json`);
    } catch (e) {
      show(emptyState('读取失败', explain(e)));
      return;
    }
    if (!S.items) loadItems();
    const item = S.items?.find((it) => it.id === id) || {};
    if (!data) {
      show(emptyState('正文已经过期', '文章正文只保留 30 天。', item.link
        ? h('a', { class: 'btn btn-secondary', href: item.link, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link'), '打开原文')
        : null));
      return;
    }
    render({ ...item, ...data });
    markRead(id);
  }

  /** 要点折成一行：显示第一条，点开看全部。 */
  function points(list) {
    return h('details', { class: 'reader-points' },
      h('summary', {},
        h('span', { class: 'reader-points-label' }, '要点'),
        h('span', { class: 'reader-points-first' }, list[0]),
        icon('chevron-down')),
      h('ul', {}, list.map((pt) => h('li', {}, pt))));
  }

  /** 还没翻译（或翻译失败）的外文文章：说明一句，旁边是「翻译」；点了之后显示在等。 */
  function translateNote(a) {
    if (isTranslating(id)) {
      return h('p', { class: 'reader-note', role: 'status' }, mark({ breathe: true, small: true }),
        '正在翻译，一两分钟后自动换成中英对照。下面先显示原文。');
    }
    const failed = a.status === 'failed';
    if (!failed && !(a.needs_translation && a.translated_html == null && a.status !== 'pending')) return null;
    return h('div', { class: `reader-note${failed ? ' is-danger' : ''}` },
      icon(failed ? 'circle-alert' : 'info'),
      h('span', {}, failed ? '翻译失败，下面是原文。' : '这篇没有自动翻译，下面是原文。'),
      h('button', {
        type: 'button', class: 'btn btn-secondary btn-sm',
        onclick: async (e) => {
          e.currentTarget.disabled = true;
          try {
            await requestTranslation({ id, title: a.title, title_zh: a.title_zh });
            waiting = true;
          } catch (err) {
            e.currentTarget.disabled = false;
            toast(`没能开始翻译：${explain(err)}`, { tone: 'danger' });
          }
        },
      }, icon('languages'), failed ? '重新翻译' : '翻译'));
  }

  function nextLink(next) {
    const href = `#/article/${encodeURIComponent(next.id)}`;
    // 替换当前这条历史记录：读完几篇后点「返回」直接回到列表
    return h('a', {
      class: 'reader-next', href,
      onclick: (e) => { e.preventDefault(); location.replace(href); },
    },
    h('span', { class: 'reader-next-label' }, '下一篇'),
    h('span', { class: 'reader-next-title' }, next.title || '继续阅读'),
    icon('arrow-right'));
  }

  function render(a) {
    link = /^https?:\/\//.test(a.link || '') ? a.link : null;
    const status = a.status || (a.translated_html != null ? 'ready' : 'pending');
    const html = status === 'ready' && a.translated_html != null ? a.translated_html : a.source_html;
    const body = h('div', { class: 'prose reader-body' }, sanitizeHtml(html || '', link || ''));
    enhanceCodeBlocks(body);

    const header = h('header', { class: 'reader-head' },
      h('p', { class: 'reader-kicker' }, [a.feed_name, a.published ? fmtTime(a.published) : ''].filter(Boolean).join(' · ')),
      h('h1', { class: 'reader-title' }, itemTitle(a)),
      a.title_zh && a.title && a.title_zh !== a.title ? h('p', { class: 'reader-orig' }, a.title) : null);

    const others = (a.also_from || []).filter((o) => /^https?:\/\//.test(o.link || ''));
    const next = nextInSequence(id);
    const note = translateNote({ ...a, status });
    show(h('div', {}, ...nodes(
      header,
      a.key_points?.length ? points(a.key_points) : null,
      note || (status === 'pending' ? h('p', { class: 'reader-note' }, icon('info'), '还在排队翻译，先显示原文。') : null),
      a.summary_only ? h('p', { class: 'reader-note' }, icon('info'), `这个来源只提供摘要，原网页的全文没抓到${a.fulltext_error ? `（${a.fulltext_error}）` : ''}。点「…」里的「阅读原文」看全文。`) : null,
      body,
      others.length ? h('aside', { class: 'reader-aside' }, h('span', { class: 'reader-aside-label' }, '同一件事的其他来源'),
        h('ul', {}, others.map((o) => h('li', {},
          h('a', { class: 'link', href: o.link, target: '_blank', rel: 'noopener noreferrer' }, o.title || o.feed_name || o.link),
          o.title && o.feed_name ? h('span', { class: 'reader-source' }, ` · ${o.feed_name}`) : null)))) : null,
      // 推荐理由和反馈放在文末：读完再判断这篇值不值
      h('aside', { class: 'reader-aside reader-why' },
        h('div', { class: 'reader-why-head' },
          h('span', { class: 'reader-aside-label' }, 'AI 为什么推给你'),
          a.score != null ? scoreBadge(a) : null,
          a.important ? badge('重要', 'solid') : null),
        a.reason ? h('p', {}, a.reason) : null,
        h('p', { class: 'reader-why-meta' }, [a.feed_name, groupName(a.group), a.author && a.author !== a.feed_name ? a.author : '']
          .filter(Boolean).join(' · ')),
        voteEl = voteButtons(voteItem(a), { labels: true })),
      next ? nextLink(next) : null,
      h('footer', { class: 'reader-foot' },
        link ? h('a', { class: 'btn btn-secondary', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link'), '阅读原文') : null,
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: back }, '返回列表')))));
    article = a;
    document.title = `${itemTitle(a)} · Feed Hub`;
  }

  // 文章记录里的 status 是翻译状态；推送 / 过滤的判断在条目记录里（items.json）
  function voteItem(a) {
    const item = S.items?.find((it) => it.id === id);
    return item ? { ...a, status: item.status, model_status: item.model_status, user_override: item.user_override }
      : { ...a, status: '' };
  }

  load();
  return {
    el,
    refresh(what) {
      if (what.has('translating') && article) {
        if (waiting && !isTranslating(id)) {
          waiting = false;
          load(); // 译好了（或失败了）：重新读这篇
        } else {
          render(article); // 刚点了「翻译」：说明换成「正在翻译」
        }
        return;
      }
      if ((what.has('feedback') || what.has('items')) && article && voteEl) {
        const next = voteButtons(voteItem(article), { labels: true });
        voteEl.replaceWith(next);
        voteEl = next;
      }
    },
  };
}
