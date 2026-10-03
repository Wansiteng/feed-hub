/* 往期简报（「我的」里，电脑上在侧边栏）：最近几天的每一期，按天分组，点开在 app 里看那一期。
 * 数据和首页一样来自 briefings.json；收藏的更早的往期在「收藏」里。 */
import { h, icon } from '../../assets/ui.js';
import { S, loadBriefings, briefingMode } from '../store.js';
import { emptyState } from '../common.js';
import { editionTitle } from './briefing.js';

/** 最近几天、有内容的各期，新的在前（和首页的上一期 / 下一期同一个范围）。 */
function recentEditions() {
  const since = Date.now() - (S.settings?.digest?.days || 7) * 86400e3;
  return (S.briefings || []).filter((e) => e.total && Date.parse(e.published) >= since)
    .sort((a, b) => (a.published < b.published ? 1 : -1));
}

export function EditionsPage() {
  const sub = h('p', { class: 'page-sub' });
  const list = h('div', { class: 'editions' });
  const el = h('div', { class: 'page page-narrow' },
    h('header', { class: 'lib-head' }, h('div', { class: 'lib-head-text' }, h('h1', { class: 'page-title' }, '往期简报'), sub)),
    list);

  function href(e, latest) {
    const base = briefingMode() ? '#/' : '#/briefing';
    return latest ? base : `${base}?edition=${encodeURIComponent(e.id)}`;
  }

  function draw() {
    if (!S.briefings) {
      list.replaceChildren(S.briefingsError ? emptyState('读取失败', S.briefingsError) : h('div', { class: 'loading' }, '正在读取简报…'));
      return;
    }
    const all = recentEditions();
    sub.textContent = all.length ? `最近 ${S.settings?.digest?.days || 7} 天，共 ${all.length} 期` : '';
    if (!all.length) {
      list.replaceChildren(emptyState('还没有往期', '简报按设置的推送时间出刊，出过的都会列在这里。'));
      return;
    }
    // 按天分组：「午报 · 10 月 1 日 周四」→ 日期一组，组里是早报 / 午报 / 晚报
    const days = new Map();
    for (const e of all) {
      const [, name, date] = editionTitle(e).match(/^(\S+) · (.+)$/) || [null, '简报', editionTitle(e)];
      if (!days.has(date)) days.set(date, []);
      days.get(date).push({ e, name });
    }
    list.replaceChildren(...[...days].map(([date, rows]) => h('section', { class: 'editions-day' },
      h('h2', { class: 'editions-date' }, date),
      h('div', { class: 'editions-rows' }, rows.map(({ e, name }) => {
        const headline = e.stories?.[0]?.headline || '';
        const meta = [`${e.total} 篇`, e.stories?.length ? `头版 ${e.stories.length} 件` : '', e.features?.length ? `特稿 ${e.features.length} 篇` : '']
          .filter(Boolean).join(' · ');
        return h('a', { class: 'editions-row', href: href(e, e === all[0]) },
          h('span', { class: 'editions-name' }, name),
          h('span', { class: 'editions-text' },
            headline ? h('span', { class: 'editions-headline' }, headline) : null,
            h('span', { class: 'editions-meta' }, meta)),
          e === all[0] ? h('span', { class: 'editions-latest' }, '最新') : null,
          icon('chevron-right', { cls: 'editions-go' }));
      })))));
  }

  draw();
  if (!S.briefings || Date.now() - S.briefingsAt > 60e3) loadBriefings({ force: true });
  return {
    el,
    refresh(what) {
      if (what.has('briefings') || what.has('config')) draw();
    },
  };
}
