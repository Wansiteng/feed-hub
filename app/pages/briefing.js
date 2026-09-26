/* 简报（简报模式下的首页）：像一份报纸，打开就是内容。
 * 顶部一行刊头，接着是「本期要点」目录（一屏看完整期，点哪条跳到哪条），然后是头版综述、特稿、其他；
 * 最上面是还新鲜的重磅消息，上一期 / 下一期在最底下。打开时和从后台切回来时自动取最新的，不用手动刷新。
 * 数据来自 data 分支的 briefings.json（每期编好的内容）和 items.json（要点、配图、重磅标记）。 */
import { h, icon, iconButton, openMenu, thinking, toast, fmtTime, nodes } from '../../assets/ui.js';
import { S, loadBriefings, loadItems, groupName, isRead, siteBase } from '../store.js';
import { emptyState } from '../common.js';

const BREAKING_HOURS = 48;
const WEEKDAYS = '一二三四五六日';

function editionUrl(e) {
  const base = siteBase();
  return base ? `${base}briefing/${e.id}.html` : '';
}

/** 和 feedhub/briefing.py 的 edition_title 一致：早报 / 午报 / 晚报 · 9 月 26 日 周六（北京时间）。 */
export function editionTitle(e) {
  const zone = S.settings?.digest?.timezone || 'Asia/Shanghai';
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: 'numeric', hourCycle: 'h23', month: 'numeric', day: 'numeric', weekday: 'short',
    }).formatToParts(new Date(e.published)).map((p) => [p.type, p.value]));
  } catch {
    return e.id;
  }
  const hour = +parts.hour;
  const name = hour < 11 ? '早报' : hour < 16 ? '午报' : '晚报';
  const weekday = WEEKDAYS[['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday)];
  return `${name} · ${parts.month} 月 ${parts.day} 日 周${weekday}`;
}

/** 下一期几点出（按设置里的出刊时间，北京时间）。 */
function nextEdition() {
  const hours = (S.settings?.digest?.hours || [7, 19]).map(Number).filter((n) => n >= 0 && n <= 23).sort((a, b) => a - b);
  if (!hours.length) return '';
  const zone = S.settings?.digest?.timezone || 'Asia/Shanghai';
  let now;
  try {
    now = +new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' }).format(new Date());
  } catch {
    return '';
  }
  const next = hours.find((x) => x > now);
  return next == null ? `明天 ${hours[0]}:00` : `${next}:00`;
}

function readerHref(id) {
  return `#/article/${encodeURIComponent(id)}`;
}

function itemById(id) {
  return S.items?.find((it) => it.id === id) || null;
}

function safeImage(src) {
  return /^https?:\/\//.test(src || '') ? src : '';
}

export function BriefingPage(route) {
  const wanted = route.params.get('edition') || '';
  const base = route.name === 'briefing' ? '#/briefing' : '#/'; // 按篇推送模式下简报在 #/briefing

  const kicker = h('p', { class: 'brief-kicker' });
  const title = h('h1', { class: 'brief-title' }, '简报');
  const meta = h('p', { class: 'brief-meta' });
  const more = iconButton('ellipsis', '更多', (e) => openMore(e.currentTarget), { cls: 'brief-more' });
  const head = h('header', { class: 'brief-masthead' }, h('div', { class: 'brief-masthead-text' }, kicker, title, meta), more);
  const body = h('div', { class: 'brief-body' });
  const el = h('div', { class: 'page stream brief' }, head, body);

  function editions() {
    // 新的在前；空的一期（这段时间没有推送）不显示
    return (S.briefings || []).filter((e) => e.total).sort((a, b) => (a.published < b.published ? 1 : -1));
  }

  function currentIndex(list) {
    const i = wanted ? list.findIndex((e) => e.id === wanted) : 0;
    return i < 0 ? 0 : i;
  }

  function editionHref(list, e) {
    return e === list[0] ? base : `${base}?edition=${encodeURIComponent(e.id)}`;
  }

  async function refresh() {
    await Promise.all([loadBriefings({ force: true }), loadItems({ force: true })]);
    toast(S.briefingsError || S.itemsError ? `刷新失败：${S.briefingsError || S.itemsError}` : '已刷新');
  }

  function openMore(anchor) {
    const list = editions();
    const e = list[currentIndex(list)];
    const url = e ? editionUrl(e) : '';
    const site = siteBase();
    openMenu(anchor, [
      { label: '刷新', icon: 'refresh-cw', onSelect: refresh },
      url ? { label: '在网页中打开这一期', icon: 'external-link', onSelect: () => window.open(url, '_blank', 'noopener') } : null,
      site ? { label: '往期简报（网页版）', icon: 'book-open', onSelect: () => window.open(`${site}briefing/`, '_blank', 'noopener') } : null,
    ], { align: 'end' });
  }

  // data-sequence：从这一栏点开文章时，「下一篇」只在这一栏里接着走
  function section(label, ...children) {
    return h('section', { class: 'brief-section', dataset: { sequence: '' } }, h('h2', { class: 'brief-section-title' }, label), ...children);
  }

  /** 一条单独的文章（重磅、特稿）：标题、来源和时间、要点，右边配图。 */
  function row(id, fallback, { breaking = false } = {}) {
    const it = itemById(id) || {};
    const titleText = it.title_zh || fallback.title || it.title || '（无标题）';
    const points = it.key_points?.length ? it.key_points.join('；') : '';
    const image = safeImage(it.image);
    const when = it.published || it.processed_at;
    return h('a', {
      class: `brief-row${isRead(id) ? ' is-read' : ''}${breaking ? ' is-breaking' : ''}`, href: readerHref(id),
      dataset: { title: titleText },
    },
    h('div', { class: 'brief-row-body' },
      h('p', { class: 'brief-row-meta' },
        breaking ? h('span', { class: 'brief-flag' }, '重磅') : null,
        h('span', {}, it.feed_name || fallback.feed_name || ''),
        when ? h('span', {}, fmtTime(when)) : null),
      h('h3', { class: 'brief-row-title' }, titleText),
      points ? h('p', { class: 'brief-row-points' }, points) : null),
    image ? h('img', {
      class: 'brief-row-thumb', src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
      onerror: (e) => e.target.remove(),
    }) : null);
  }

  /** 头版的一件事：配图、标题、综述，最后一行小字列出来源。 */
  function story(s, k) {
    const image = safeImage(s.image);
    const sources = (s.sources || []).map((src) => (src.article
      ? h('a', { class: 'brief-source', href: readerHref(src.article), title: src.title || '', dataset: { title: src.title || s.headline || '' } },
        src.feed_name || '来源')
      : /^https?:\/\//.test(src.link || '')
        ? h('a', { class: 'brief-source is-external', href: src.link, target: '_blank', rel: 'noopener noreferrer', title: src.title || '' },
          src.feed_name || '原文', icon('external-link'))
        : null)).filter(Boolean);
    return h('article', { class: 'brief-story', id: `story-${k}` },
      image ? h('img', {
        class: 'brief-story-image', src: image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer',
        onerror: (e) => e.target.remove(),
      }) : null,
      h('h3', { class: 'brief-story-title' }, s.headline || ''),
      s.summary ? h('p', { class: 'brief-story-summary' }, s.summary) : null,
      sources.length ? h('p', { class: 'brief-sources' },
        h('span', { class: 'brief-sources-label' }, '来源'),
        ...sources.flatMap((a, i) => (i ? [h('span', { class: 'brief-sources-sep', 'aria-hidden': 'true' }, '·'), a] : [a]))) : null);
  }

  /** 本期要点：头版每件事一行，点一下跳过去。 */
  function toc(stories) {
    return h('nav', { class: 'brief-toc', 'aria-label': '本期要点' },
      h('h2', { class: 'brief-section-title' }, '本期要点'),
      h('ol', {}, stories.map((s, k) => h('li', {},
        h('button', {
          type: 'button', class: 'brief-toc-item',
          onclick: () => el.querySelector(`#story-${k}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        }, s.headline || '')))));
  }

  /** 其他文章：按分组列标题，默认收起。 */
  function others(list) {
    const groups = new Map();
    for (const o of list) {
      const key = o.group || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    return h('details', { class: 'brief-others', dataset: { sequence: '' } },
      h('summary', {}, icon('chevron-down'), `其他 ${list.length} 篇`),
      [...groups].map(([g, rows]) => h('div', { class: 'brief-others-group' },
        h('h4', {}, g ? groupName(g) : '未分组'),
        h('ul', {}, rows.map((o) => h('li', {},
          h('a', { class: isRead(o.article) ? 'is-read' : '', href: readerHref(o.article) }, o.title || '（无标题）'),
          h('span', { class: 'brief-others-source' }, ` · ${o.feed_name || ''}`)))))));
  }

  /** 读到最后：下一期几点出，以及上一期 / 下一期。 */
  function ending(list, i, next) {
    const older = list[i + 1];
    const newer = i > 0 ? list[i - 1] : null;
    return h('footer', { class: 'brief-end' },
      h('p', { class: 'brief-end-note' }, i === 0 ? `读完了${next ? ` · 下一期 ${next}` : ''}` : `往期 · ${fmtTime(list[i].published)}`),
      h('div', { class: 'brief-pager' },
        older ? h('a', { class: 'btn btn-secondary', href: editionHref(list, older) }, icon('arrow-left'), `上一期 · ${editionTitle(older)}`) : null,
        newer ? h('a', { class: 'btn btn-secondary', href: editionHref(list, newer) },
          newer === list[0] ? '回到最新一期' : `下一期 · ${editionTitle(newer)}`, icon('arrow-right')) : null));
  }

  function breakingNow() {
    const since = Date.now() - BREAKING_HOURS * 3600e3;
    return (S.items || [])
      .filter((it) => it.breaking && it.status === 'passed' && new Date(it.processed_at || it.published || 0).getTime() >= since)
      .sort((a, b) => ((a.processed_at || '') < (b.processed_at || '') ? 1 : -1));
  }

  function draw() {
    if (!S.briefings) {
      body.replaceChildren(h('div', { class: 'loading' }, thinking('正在读取简报…')));
      return;
    }
    const list = editions();
    const i = currentIndex(list);
    const e = list[i];
    const latest = i === 0;
    const breaking = latest ? breakingNow() : [];
    const next = nextEdition();
    const breakingSection = breaking.length
      ? section('重磅', h('div', { class: 'brief-rows' }, breaking.map((it) => row(it.id, it, { breaking: true })))) : null;
    if (!e) {
      kicker.textContent = '简报';
      title.textContent = S.settings?.digest?.enabled === false ? '简报已关闭' : '还没有简报';
      meta.textContent = '';
      body.replaceChildren(...nodes(
        breakingSection,
        S.briefingsError
          ? emptyState('读取失败', S.briefingsError)
          : S.settings?.digest?.enabled === false
            ? emptyState('简报已关闭', '在「设置 → 简报」里打开。关闭时只推送重磅消息。')
            : emptyState('第一期还没出', `简报按设置的时间出刊${next ? `，下一期 ${next}` : ''}。在这之前可以先看「全部文章」。`,
              h('a', { class: 'btn btn-secondary', href: '#/articles' }, icon('newspaper'), '全部文章'))));
      return;
    }

    kicker.textContent = latest ? `最新一期${next ? ` · 下一期 ${next}` : ''}` : `往期 · ${fmtTime(e.published)}`;
    title.textContent = editionTitle(e);
    meta.textContent = [`收录 ${e.total} 篇`, e.stories?.length ? `头版 ${e.stories.length} 件` : '',
      e.features?.length ? `特稿 ${e.features.length} 篇` : ''].filter(Boolean).join(' · ');

    const stories = e.stories || [];
    body.replaceChildren(...nodes(
      breakingSection,
      stories.length > 1 ? toc(stories) : null,
      stories.length ? section('头版', ...stories.map(story)) : null,
      e.features?.length ? section('特稿', h('p', { class: 'brief-hint' }, '值得读全文的文章，已经翻译好。'),
        h('div', { class: 'brief-rows' }, e.features.map((f) => row(f.article, f)))) : null,
      e.others?.length ? others(e.others) : null,
      ending(list, i, next)));
  }

  draw();
  // 打开时取最新的一期（本机缓存先显示着）；一分钟内取过就不再取
  if (Date.now() - S.briefingsAt > 60e3) loadBriefings({ force: true });
  if (Date.now() - S.itemsAt > 60e3) loadItems({ force: true });

  return {
    el,
    refresh(what) {
      if (what.has('briefings') || what.has('items') || what.has('config') || what.has('read')) draw();
    },
  };
}
