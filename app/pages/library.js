/* 收藏和稍后阅读（手机上在「我的」里，电脑上在侧边栏）。数据在 config/library.json，换设备也在。
 * 稍后阅读里读过的文章右边有 ×，点一下就移出；「选择」可以勾选任意几项一起移出（收藏也一样）。 */
import { h, icon, iconButton, fmtTime, toast, confirmDialog } from '../../assets/ui.js';
import {
  S, loadLibrary, loadItems, briefingMode, favoriteKey, removeFavorites, removeLater,
} from '../store.js';
import { emptyState } from '../common.js';

const KINDS = {
  favorites: {
    title: '收藏',
    empty: ['还没有收藏', '在文章页或简报右上角点星标，就会收在这里。收藏的文章和简报会一直保留。'],
    hint: '',
    list: () => S.library?.favorites || [],
    key: favoriteKey,
    unit: '项',
  },
  later: {
    title: '稍后阅读',
    empty: ['稍后阅读是空的', '在文章页右上角点时钟，想读的文章就排在这里。'],
    hint: '读过的文章右边会出现 ×，点一下就移出。',
    list: () => S.library?.later || [],
    key: (e) => e.id,
    unit: '篇',
  },
};

function href(e) {
  const id = encodeURIComponent(e.id);
  if (e.kind === 'edition') return briefingMode() ? `#/?edition=${id}` : `#/briefing?edition=${id}`;
  return `#/article/${id}`;
}

function titleOf(e) {
  if (e.kind === 'edition') return e.title || '简报';
  const it = S.items?.find((x) => x.id === e.id);
  return it?.title_zh || e.title || it?.title || '（无标题）';
}

function metaOf(e) {
  const parts = e.kind === 'edition' ? ['简报', e.total ? `收录 ${e.total} 篇` : ''] : [e.feed_name, e.published ? fmtTime(e.published) : ''];
  return parts.filter(Boolean).join(' · ');
}

export function LibraryPage(route) {
  const kind = route.name === 'later' ? 'later' : 'favorites';
  const K = KINDS[kind];
  let selecting = false;
  let selected = new Set();

  const sub = h('p', { class: 'page-sub' });
  const selectBtn = h('button', { type: 'button', class: 'btn btn-secondary btn-sm', onclick: () => setSelecting(!selecting) }, '选择');
  const toolbar = h('div', { class: 'lib-toolbar', hidden: true });
  const list = h('div', { class: 'lib-list', dataset: { sequence: '' } });
  const el = h('div', { class: 'page page-narrow lib' },
    h('header', { class: 'lib-head' },
      h('div', { class: 'lib-head-text' }, h('h1', { class: 'page-title' }, K.title), sub),
      selectBtn),
    toolbar, list);

  function setSelecting(on) {
    selecting = on;
    selected = new Set();
    draw();
  }

  function toggle(key) {
    if (selected.has(key)) selected.delete(key);
    else selected.add(key);
    draw();
  }

  function remove(keys) {
    if (kind === 'favorites') {
      removeFavorites(keys);
      toast(`已取消收藏 ${keys.length} 项`);
    } else {
      removeLater(keys);
      toast(keys.length === 1 ? '已移出稍后阅读' : `已移出 ${keys.length} 篇`);
    }
  }

  async function removeSelected(e) {
    const keys = [...selected];
    if (!keys.length) return;
    // 收藏是要长期留着的：一次取消多项先问一句
    if (kind === 'favorites' && keys.length > 1 && !await confirmDialog({
      title: `取消收藏 ${keys.length} 项？`, message: '取消后过了保留期就会被清理掉。', confirmLabel: '取消收藏', danger: true,
      anchor: e.currentTarget,
    })) return;
    remove(keys);
    setSelecting(false);
  }

  function row(e) {
    const key = K.key(e);
    const read = kind === 'later' && Boolean(e.read_at);
    const on = selected.has(key);
    const title = titleOf(e);
    const link = h('a', {
      class: 'lib-link', href: href(e), dataset: { title },
      // 选择时点整行是勾选，不打开
      onclick: selecting ? (ev) => { ev.preventDefault(); toggle(key); } : null,
    },
    h('p', { class: 'lib-meta' }, e.kind === 'edition' ? icon('newspaper') : null, h('span', {}, metaOf(e))),
    h('h3', { class: 'lib-title' }, title),
    e.kind === 'edition' && e.headline ? h('p', { class: 'lib-sub' }, `头条：${e.headline}`) : null);
    return h('div', { class: `lib-row${read ? ' is-read' : ''}${on ? ' is-selected' : ''}` },
      selecting ? h('button', {
        type: 'button', class: `lib-check${on ? ' is-on' : ''}`, role: 'checkbox', 'aria-checked': String(on),
        'aria-label': `选择：${title}`, onclick: () => toggle(key),
      }, icon(on ? 'circle-check' : 'circle')) : null,
      link,
      !selecting && read ? iconButton('x', '从稍后阅读移除', () => remove([key]), { small: true, cls: 'lib-remove' }) : null);
  }

  function draw() {
    const entries = K.list();
    const keys = new Set(entries.map(K.key));
    selected = new Set([...selected].filter((k) => keys.has(k)));
    if (selecting && !entries.length) selecting = false;
    selectBtn.hidden = !entries.length;
    selectBtn.textContent = selecting ? '完成' : '选择';
    selectBtn.classList.toggle('btn-primary', selecting);
    selectBtn.classList.toggle('btn-secondary', !selecting);

    const unread = kind === 'later' ? entries.filter((e) => !e.read_at).length : 0;
    sub.textContent = !entries.length ? '' : kind === 'later'
      ? `${entries.length} 篇${!unread ? '，都读过了' : unread < entries.length ? `，${unread} 篇没读` : ''}。${K.hint}`
      : `${entries.length} 项`;

    toolbar.hidden = !selecting;
    if (selecting) {
      const all = selected.size === entries.length;
      toolbar.replaceChildren(
        h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm',
          onclick: () => { selected = all ? new Set() : new Set(keys); draw(); },
        }, all ? '全不选' : '全选'),
        h('span', { class: 'lib-selected', role: 'status' }, selected.size ? `已选 ${selected.size} ${K.unit}` : '点一项勾选'),
        h('button', { type: 'button', class: 'btn btn-danger btn-sm', disabled: !selected.size, onclick: removeSelected },
          icon('trash-2'), kind === 'later' ? '移出' : '取消收藏'));
    }

    if (!S.library) {
      list.replaceChildren(S.libraryError ? emptyState('读取失败', S.libraryError)
        : h('div', { class: 'loading' }, `正在读取${K.title}…`));
      return;
    }
    list.replaceChildren(...(entries.length ? entries.map(row) : [emptyState(...K.empty)]));
  }

  draw();
  loadLibrary(); // 每次打开都取一次：别的设备可能刚加过
  if (!S.items) loadItems();
  return {
    el,
    refresh(what) {
      if (what.has('library') || what.has('items') || what.has('config')) draw();
    },
  };
}
