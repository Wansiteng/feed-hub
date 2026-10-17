/* 阅读器：第一屏就是正文。顶栏只有返回、收藏、稍后阅读、字号和「…」，往下读时藏起来；要点默认展开（可以收起），
 * 推荐理由放到文末；读完可以接着读「下一篇」（点开这篇的那一页上的下一篇）。正文来自订阅源和模型，先按白名单净化再显示。
 * 还没翻译的外文文章可以点「翻译」：一两分钟后自动换成译文，配了通知的话译好时推送一条，同时加进稍后阅读。
 * 译过的文章在「…」里选怎么显示：中英对照、仅中文、英文原文（记在这台设备上，之后的文章都这样显示）。
 * 手机上长按正文里的图片可以存储到相册（images.js）。读这篇的时间记进阅读记录（reading.js）。 */
import {
  h, icon, iconButton, openMenu, thinking, sanitizeHtml, enhanceCodeBlocks, copyText, fmtTime, badge, nodes, mark, toast,
} from '../../assets/ui.js';
import {
  S, groupName, loadItems, markRead, setReadingSize, READING_SIZES, isTranslating, requestTranslation, notifyOn,
  isFavorite, setFavorite, laterEntry, setLater, markLaterRead, ensureLater, setReaderLang,
} from '../store.js';
import { readData, explain } from '../api.js';
import { itemTitle, scoreBadge, emptyState, voteButtons, setToggle } from '../common.js';
import { nav, navigate, nextInSequence } from '../nav.js';
import { enableImageSave } from '../images.js';
import { trackReading } from '../reading.js';

const SIZE_LABELS = { sm: '小', md: '标准', lg: '大', xl: '特大' };
const LANG_LABELS = { bilingual: '中英对照', zh: '仅中文', original: '英文原文' };
const ZH = '[lang|="zh"]';

/**
 * 这篇能怎么显示。译文有两种存法：点「翻译」的是中英对照（translated_html 里的译文标着 lang="zh-CN"）；
 * 自动翻译的按设置，设置是只看中文时另存了一份中英对照（bilingual_html，以前译的文章没有）。
 * zh 为 null 时，仅中文由中英对照去掉原文得到（onlyChinese）。
 */
export function versions(a, status) {
  const translated = status === 'ready' && a.translated_html != null ? a.translated_html : null;
  if (translated == null) return { natural: 'original', original: a.source_html || '', bilingual: null, zh: null };
  const bilingual = /\slang="zh/i.test(translated);
  return {
    natural: bilingual ? 'bilingual' : 'zh', // 译好时的样子
    original: a.source_html || '',
    bilingual: bilingual ? translated : a.bilingual_html || null,
    zh: bilingual ? null : translated,
  };
}

/** 按这台设备上选的显示方式；这篇没有中英对照时退回译好时的样子。 */
export function pickLang(v, pref = S.readerLang) {
  if (v.natural === 'original') return 'original';
  const want = pref === 'auto' ? v.natural : pref;
  return want === 'bilingual' && !v.bilingual ? v.natural : want;
}

/**
 * 中英对照 → 仅中文：去掉每段译文前面的原文，只留译文。和 feedhub/translate.py 的 assemble 对应：
 * 段落、标题这些在最外层，原文是译文前面紧挨着的那个元素；列表项、单元格、图注里，译文前面的全是原文。
 */
export function onlyChinese(root) {
  for (const zh of [...root.querySelectorAll(ZH)]) {
    const outer = zh.parentNode.closest?.(ZH); // 译文里面又标了 lang 的不单独处理（只看正文里面，页面本身也是 lang="zh-CN"）
    if (!root.contains(zh) || (outer && root.contains(outer))) continue;
    if (zh.parentNode === root) {
      const orig = zh.previousElementSibling;
      if (orig && !orig.matches(ZH)) orig.remove();
    } else {
      while (zh.previousSibling) zh.previousSibling.remove();
    }
    zh.replaceWith(...zh.childNodes);
  }
}


export function ReaderPage(route) {
  const id = route.id;
  let content = h('div', { class: 'loading' }, thinking('正在读取正文…'));
  const more = iconButton('ellipsis', '更多', (e) => openMore(e.currentTarget), { small: true });
  const favBtn = iconButton('star', '收藏', toggleFavorite, { small: true, cls: 'toggle-fav' });
  const laterBtn = iconButton('clock-plus', '稍后阅读', toggleLater, { small: true, cls: 'toggle-later' });
  const openedAt = Date.now();
  const bar = h('div', { class: 'reader-bar' },
    iconButton('arrow-left', '返回', back, { small: true, cls: 'reader-back' }),
    h('span', { class: 'spacer' }),
    // 手机上返回和这一组各是一颗悬浮在正文上的毛玻璃按钮
    h('span', { class: 'reader-tools' },
      favBtn, laterBtn,
      iconButton('a-large-small', '字号', (e) => openSizes(e.currentTarget), { small: true }),
      more));
  const el = h('article', { class: 'reader' }, bar, content);
  enableImageSave(el); // 手机上长按正文里的图片：存储到相册
  let article = null;
  let status = '';
  let shownLang = '';
  let voteEl = null;
  let link = null;
  let waiting = isTranslating(id); // 点了「翻译」、在等译文
  let stopTracking = null; // 读到正文以后开始记阅读时间，离开时停

  function show(node) {
    if (content.classList.contains('loading')) node.classList.add('fade-enter'); // 读到正文：淡入，不是一下跳出来
    content.replaceWith(node);
    content = node;
  }

  function back() {
    // 从站内点进来的就回到原来那一页（滚动位置会恢复）；直接打开的回首页
    if (nav.previous) history.back();
    else navigate('#/');
  }

  /** 收藏和稍后阅读里记下标题、来源等，列表里不用再读文章。 */
  function entry() {
    const a = article || S.items?.find((it) => it.id === id) || {};
    return { id, title: itemTitle(a), feed_name: a.feed_name || '', published: a.published || '', link: a.link || '' };
  }

  function toggleFavorite() {
    const on = !isFavorite('article', id);
    setFavorite({ kind: 'article', ...entry() }, on);
    toast(on ? '已收藏' : '已取消收藏');
  }

  function toggleLater() {
    const on = !laterEntry(id);
    setLater(entry(), on);
    toast(on ? '已加入稍后阅读' : '已移出稍后阅读');
  }

  function drawToggles() {
    const fav = isFavorite('article', id);
    const later = Boolean(laterEntry(id));
    setToggle(favBtn, fav, 'star', fav ? '取消收藏' : '收藏');
    setToggle(laterBtn, later, later ? 'clock-check' : 'clock-plus', later ? '移出稍后阅读' : '稍后阅读');
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
    const v = article ? versions(article, status) : null;
    const langs = v && v.natural !== 'original' ? [
      { header: '显示' },
      ...Object.entries(LANG_LABELS).map(([lang, label]) => ({
        label, checked: shownLang === lang, disabled: lang === 'bilingual' && !v.bilingual,
        hint: lang === 'bilingual' && !v.bilingual ? '这篇只有中文译文' : '',
        onSelect: () => setReaderLang(lang),
      })),
      { separator: true },
    ] : [];
    openMenu(anchor, [...langs, ...(link ? [
      { label: '阅读原文', icon: 'external-link', onSelect: () => window.open(link, '_blank', 'noopener') },
      { label: '复制原文链接', icon: 'link', onSelect: () => copyText(link, '链接已复制') },
    ] : [{ label: '这篇没有原文链接', icon: 'info', disabled: true }])], { align: 'end' });
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
    markLaterRead(id, openedAt);
  }

  /** 要点：默认展开；点「要点」这一行收起，收起时只显示第一条。 */
  function points(list) {
    return h('details', { class: 'reader-points', open: true },
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
        notifyOn() ? '正在翻译，译好后推送通知给你，这里也会自动换成译文。已加进稍后阅读。'
          : '正在翻译，一两分钟后自动换成译文。已加进稍后阅读。');
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
            ensureLater(entry()); // 译好了再来读：放进稍后阅读
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
    status = a.status || (a.translated_html != null ? 'ready' : 'pending');
    const v = versions(a, status);
    shownLang = pickLang(v);
    const html = shownLang === 'original' ? v.original : shownLang === 'bilingual' ? v.bilingual : v.zh ?? v.bilingual;
    const body = h('div', { class: 'prose reader-body' }, sanitizeHtml(html || '', link || ''));
    if (shownLang === 'zh' && v.zh == null) onlyChinese(body);
    enhanceCodeBlocks(body);

    const header = h('header', { class: 'reader-head' },
      h('p', { class: 'reader-kicker' }, [a.feed_name, a.published ? fmtTime(a.published) : ''].filter(Boolean).join(' · ')),
      h('h1', { class: 'reader-title' }, itemTitle(a)),
      a.title_zh && a.title && a.title_zh !== a.title ? h('p', { class: 'reader-orig' }, a.title) : null);

    const others = (a.also_from || []).filter((o) => /^https?:\/\//.test(o.link || ''));
    const next = nextInSequence(id);
    const note = translateNote({ ...a, status });
    const langNote = shownLang === 'original' && v.natural !== 'original'
      ? h('p', { class: 'reader-note' }, icon('info'), '正在看英文原文，在右上角「…」里可以换回译文。') : null;
    show(h('div', {}, ...nodes(
      header,
      a.key_points?.length ? points(a.key_points) : null,
      note || (status === 'pending' ? h('p', { class: 'reader-note' }, icon('info'), '还在排队翻译，先显示原文。') : null),
      langNote,
      // 视频页：网站拒绝访问时抓取那边认不出来，按网址判断
      a.summary_only ? h('p', { class: 'reader-note' }, icon('info'), a.fulltext_error?.startsWith('原文是视频') || /\/videos?\//.test(link ? new URL(link).pathname : '')
        ? '原文是视频，网页上没有文字稿。点「阅读原文」去看视频。'
        : `这个来源只提供摘要，原网页的全文没抓到${a.fulltext_error ? `（${a.fulltext_error}）` : ''}。点「…」里的「阅读原文」看全文。`) : null,
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
      link ? h('footer', { class: 'reader-foot' },
        h('a', { class: 'btn btn-secondary', href: link, target: '_blank', rel: 'noopener noreferrer' }, icon('external-link'), '阅读原文')) : null)));
    article = a;
    document.title = `${itemTitle(a)} · Feed Hub`;
    stopTracking ||= trackReading(id, { t: itemTitle(a), f: a.feed_name || '', g: a.group || '' });
  }

  // 文章记录里的 status 是翻译状态；推送 / 过滤的判断在条目记录里（items.json）
  function voteItem(a) {
    const item = S.items?.find((it) => it.id === id);
    return item ? { ...a, status: item.status, model_status: item.model_status, user_override: item.user_override }
      : { ...a, status: '' };
  }

  drawToggles();
  load();
  return {
    el,
    destroy() { stopTracking?.(); },
    refresh(what) {
      // 在「…」里换了显示方式
      if (what.has('prefs') && article && pickLang(versions(article, status)) !== shownLang) render(article);
      if (what.has('library')) {
        drawToggles();
        if (article) markLaterRead(id, openedAt); // 收藏和稍后阅读刚读到
      }
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
