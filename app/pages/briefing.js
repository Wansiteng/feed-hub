/* 简报（简报模式下的首页）：像一份报纸，打开就是内容。
 * 顶部一行刊头，接着是「本期要点」目录（一屏看完整期，点哪条跳到哪条），然后是头版综述、特稿、其他；
 * 最上面是还没读过的新鲜重磅，上一期 / 下一期在最底下。打开时和从后台切回来时自动取最新的，不用手动刷新。
 * 出刊时间过了还没出（GitHub 的定时任务被推迟）：自动运行一次补上，刊头显示「正在生成」。
 * 数据来自 data 分支的 briefings.json（每期编好的内容）和 items.json（要点、配图、重磅标记）。
 * 右上角是收藏这一期和刷新；收藏的往期过了保留期也留着，从「收藏」里打开，不排进上一期 / 下一期。
 * 所有往期在「我的 → 往期简报」（pages/editions.js）。 */
import { h, icon, iconButton, thinking, toast, fmtTime, nodes, mark } from '../../assets/ui.js';
import {
  S, loadBriefings, loadItems, groupName, isRead, scheduleHours, ensureLatestEdition, missingEdition,
  isFavorite, setFavorite,
} from '../store.js';
import { emptyState, setToggle } from '../common.js';

const BREAKING_HOURS = 48;
const WEEKDAYS = '一二三四五六日';

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
  const name = editionName(+parts.hour);
  const weekday = WEEKDAYS[['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday)];
  return `${name} · ${parts.month} 月 ${parts.day} 日 周${weekday}`;
}

/** 短标题：早报 · 9/27 周日（翻页按钮里用）。 */
function shortTitle(e) {
  const m = editionTitle(e).match(/^(\S+) · (\d+) 月 (\d+) 日 (周.)$/);
  return m ? `${m[1]} · ${m[2]}/${m[3]} ${m[4]}` : editionTitle(e);
}

function editionName(hour) {
  return hour < 11 ? '早报' : hour < 16 ? '午报' : '晚报';
}

/** 某个出刊时间的那一期叫什么（早报 / 午报 / 晚报）。 */
function slotName(when) {
  const zone = S.settings?.digest?.timezone || 'Asia/Shanghai';
  try {
    return editionName(+new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23' })
      .format(new Date(when)));
  } catch {
    return '简报';
  }
}

/** 正在补的那一期叫什么。 */
function pendingName() {
  return S.editionPending ? slotName(S.editionPending) : '';
}

/** 下一期几点出（按设置里的出刊时间，北京时间）。 */
function nextEdition() {
  const hours = scheduleHours();
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
  const refreshBtn = iconButton('refresh-cw', '刷新', () => refresh(), { cls: 'brief-more spin-on-busy' });
  const favBtn = iconButton('star', '收藏这一期', toggleFavorite, { cls: 'brief-fav toggle-fav' });
  const head = h('header', { class: 'brief-masthead' }, h('div', { class: 'brief-masthead-text' }, kicker, title, meta),
    h('div', { class: 'brief-actions' }, favBtn, refreshBtn));
  let shown = null; // 正在看的这一期
  const body = h('div', { class: 'brief-body' });
  const el = h('div', { class: 'page stream brief' }, head, body);

  function editions() {
    // 新的在前；空的一期（这段时间没有推送）不显示。收藏的往期（过了保留期还留着的）不排进来
    const since = Date.now() - (S.settings?.digest?.days || 7) * 86400e3;
    return (S.briefings || []).filter((e) => e.total && Date.parse(e.published) >= since)
      .sort((a, b) => (a.published < b.published ? 1 : -1));
  }

  /** 从「收藏」打开的往期：已经不在最近几天里了。 */
  function savedEdition() {
    return wanted ? (S.briefings || []).find((e) => e.id === wanted && e.total) || null : null;
  }

  function toggleFavorite() {
    const e = shown;
    if (!e) return;
    const on = !isFavorite('edition', e.id);
    setFavorite({
      kind: 'edition', id: e.id, title: editionTitle(e), published: e.published,
      headline: e.stories?.[0]?.headline || '', total: e.total,
    }, on);
    toast(on ? '已收藏这一期' : '已取消收藏');
  }

  function drawFavorite() {
    favBtn.hidden = !shown;
    const on = Boolean(shown && isFavorite('edition', shown.id));
    setToggle(favBtn, on, 'star', on ? '取消收藏这一期' : '收藏这一期');
  }

  function currentIndex(list) {
    const i = wanted ? list.findIndex((e) => e.id === wanted) : 0;
    return i < 0 ? 0 : i;
  }

  function editionHref(list, e) {
    return e === list[0] ? base : `${base}?edition=${encodeURIComponent(e.id)}`;
  }

  /** 右上角的刷新：转着圈取最新的简报和文章，转完就是刷新好了；失败才提示。 */
  async function refresh() {
    if (refreshBtn.classList.contains('is-spinning')) return;
    refreshBtn.classList.add('is-spinning');
    refreshBtn.setAttribute('aria-busy', 'true');
    await Promise.all([loadBriefings({ force: true }), loadItems({ force: true }), new Promise((r) => setTimeout(r, 600))]);
    refreshBtn.classList.remove('is-spinning');
    refreshBtn.removeAttribute('aria-busy');
    if (S.briefingsError || S.itemsError) toast(`刷新失败：${S.briefingsError || S.itemsError}`, { tone: 'danger' });
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

  /** 翻页的一格：上一期在左、下一期在右（只有一格时居中），一行说明加一行短标题（早报 · 9/27 周日），手机上两格并排也放得下。 */
  function pageLink(list, e, side, label) {
    return h('a', { class: `brief-page is-${side}`, href: editionHref(list, e) },
      h('span', { class: 'brief-page-label' }, side === 'prev' ? icon('arrow-left') : null, label,
        side === 'next' ? icon('arrow-right') : null),
      h('span', { class: 'brief-page-title' }, shortTitle(e)));
  }

  /** 读到最后：下一期几点出，以及上一期 / 下一期。 */
  function ending(list, i, next) {
    const older = list[i + 1];
    const newer = i > 0 ? list[i - 1] : null;
    return h('footer', { class: 'brief-end' },
      h('p', { class: 'brief-end-note' }, i === 0 ? `读完了${next ? ` · 下一期 ${next}` : ''}` : `往期 · ${fmtTime(list[i].published)}`),
      older || newer ? h('nav', { class: 'brief-pager', 'aria-label': '翻看往期' },
        older ? pageLink(list, older, 'prev', '上一期') : null,
        newer ? pageLink(list, newer, 'next', newer === list[0] ? '回到最新一期' : '下一期') : null) : null);
  }

  function savedEnding(list) {
    return h('footer', { class: 'brief-end' },
      h('p', { class: 'brief-end-note' }, `收藏的往期 · ${fmtTime(shown.published)}`),
      list.length ? h('nav', { class: 'brief-pager', 'aria-label': '翻看往期' }, pageLink(list, list[0], 'next', '回到最新一期')) : null);
  }

  /** 最上面的重磅：48 小时内、这台设备上还没读过的。读过就不再占着首页（「全部文章」和之后的简报里还有）。 */
  function breakingNow() {
    const since = Date.now() - BREAKING_HOURS * 3600e3;
    return (S.items || [])
      .filter((it) => it.breaking && it.status === 'passed' && !isRead(it.id)
        && new Date(it.processed_at || it.published || 0).getTime() >= since)
      .sort((a, b) => ((a.processed_at || '') < (b.processed_at || '') ? 1 : -1));
  }

  function draw() {
    if (!S.briefings) {
      body.replaceChildren(h('div', { class: 'loading' }, thinking('正在读取简报…')));
      return;
    }
    const list = editions();
    let i = currentIndex(list);
    let e = list[i];
    const saved = wanted && e?.id !== wanted ? savedEdition() : null;
    if (saved) {
      e = saved;
      i = -1;
    }
    shown = e || null;
    drawFavorite();
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

    const pending = latest && pendingName();
    const late = latest && !pending && S.editionKickError ? missingEdition() : null;
    if (pending) {
      kicker.replaceChildren(mark({ breathe: true, small: true }), ` ${pending}正在生成，一两分钟后自动出现`);
    } else if (late) {
      kicker.textContent = `${slotName(late)}还没出，没能自动补出：${S.editionKickError}`;
    } else {
      kicker.textContent = latest ? `最新一期${next ? ` · 下一期 ${next}` : ''}`
        : saved ? `收藏的往期 · ${fmtTime(e.published)}` : `往期 · ${fmtTime(e.published)}`;
    }
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
      saved ? savedEnding(list) : ending(list, i, next)));
  }

  draw();
  // 打开时取最新的一期（本机缓存先显示着）；一分钟内取过就不再取。
  // 取到最新的之后看该出的一期出了没有（只按刚取到的判断，缓存里的可能是旧的）
  if (Date.now() - S.briefingsAt > 60e3) loadBriefings({ force: true });
  else if (S.briefingsAt) ensureLatestEdition();
  if (Date.now() - S.itemsAt > 60e3) loadItems({ force: true });

  return {
    el,
    refresh(what) {
      if (what.has('briefings') && Date.now() - S.briefingsAt < 5e3) ensureLatestEdition();
      if (what.has('briefings') || what.has('items') || what.has('config') || what.has('read')) draw();
      else if (what.has('library')) drawFavorite();
    },
  };
}
