/* 订阅源：按分组列出，启用开关、编辑、删除、导入 OPML、管理分组。改动先暂存，点底部「保存」统一提交。 */
import {
  h, icon, iconButton, openMenu, openDialog, confirmDialog, switchControl, selectControl, segmented, badge,
  timeAgo, toast, copyText,
} from '../../assets/ui.js';
import { S, markDirty, loadItems, passRates } from '../store.js';
import { pageHead, emptyState } from '../common.js';

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'failing', label: '抓取失败' },
  { value: 'disabled', label: '已停用' },
];

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'feed';
}

function uniqueId(base) {
  const ids = new Set(S.feeds.feeds.map((f) => f.id));
  let id = base;
  for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
  return id;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function groupOptions(extraEmpty = true) {
  return [...S.feeds.groups.map((g) => ({ value: g.id, label: g.name || g.id })), ...(extraEmpty ? [{ value: '', label: '未分组' }] : [])];
}

export function FeedsPage(route) {
  const state = {
    filter: FILTERS.some((f) => f.value === route.params.get('filter')) ? route.params.get('filter') : 'all',
    q: '',
  };
  const sub = h('p', { class: 'page-sub' });
  const head = pageHead('订阅源', null, [
    h('button', { type: 'button', class: 'btn btn-secondary', onclick: (e) => openGroupsDialog(e.currentTarget) }, icon('folder-plus'), '管理分组'),
    h('button', { type: 'button', class: 'btn btn-secondary', onclick: () => openImportDialog({}) }, icon('upload'), '导入 OPML'),
    h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openFeedDialog(null) }, icon('plus'), '添加订阅源'),
  ]);
  head.querySelector('.page-head-text').append(sub);
  const filter = segmented({ items: FILTERS, value: state.filter, label: '筛选', onChange: (v) => { state.filter = v; draw(); } });
  const search = h('input', {
    class: 'input', type: 'search', placeholder: '搜索名称或地址', 'aria-label': '搜索订阅源',
    oninput: (e) => { state.q = e.target.value.trim().toLowerCase(); draw(); },
  });
  const body = h('div');
  const el = h('div', { class: 'page' }, head,
    h('div', { class: 'toolbar' }, filter.el, h('div', { class: 'input-with-icon toolbar-grow' }, icon('search'), search)),
    body);

  function statusLine(feed) {
    const st = S.feedStatus?.[feed.id];
    if (!feed.enabled) return [h('span', { class: 'dot' }), '已停用'];
    if (!S.feedStatus) return [h('span', { class: 'dot' }), '正在读取状态…'];
    if (!st) return [h('span', { class: 'dot dot-warning' }), '还没抓取过，下次运行后显示'];
    if (st.error) {
      return [h('span', { class: 'dot dot-danger' }), h('span', { class: 'feed-error', title: st.error }, `失败：${st.error}`),
        h('span', { class: 'muted' }, `连续 ${st.error_count || 1} 次${st.last_ok ? ` · 上次成功 ${timeAgo(st.last_ok)}` : ''}`)];
    }
    return [h('span', { class: 'dot dot-success' }), `正常 · ${timeAgo(st.last_ok)}${st.last_new ? ` · 新 ${st.last_new} 条` : ''}`, passRate(feed)];
  }

  /** 最近 7 天：处理了多少条、推送了多少。几乎全被过滤的源值得考虑停用。 */
  function passRate(feed) {
    const r = rates?.[feed.id];
    if (!r || !r.total) return null;
    const text = `7 天推送 ${r.passed}/${r.total}`;
    if (r.total >= 10 && r.passed / r.total < 0.1) return badge(`${text}，几乎都被过滤`, 'warning');
    return h('span', { class: 'feed-rate', title: '最近 7 天处理的条目里，推送给你的有多少' }, ` · ${text}`);
  }

  function feedRow(feed) {
    const rowEl = h('div', { class: `feed-row${feed.enabled ? '' : ' is-disabled'}` });
    const toggle = switchControl({
      checked: !!feed.enabled,
      label: `启用 ${feed.name}`,
      onChange: (on) => { feed.enabled = on; markDirty('feeds'); draw(); },
    });
    const main = h('button', { type: 'button', class: 'feed-main', onclick: () => openFeedDialog(feed) },
      h('span', { class: 'feed-name' }, feed.name),
      h('span', { class: 'feed-url' }, feed.url),
      h('span', { class: 'feed-status' }, statusLine(feed),
        feed.filter ? null : badge('不筛选', 'outline'),
        feed.translate ? null : badge('不翻译', 'outline'),
        feed.fulltext ? badge('总是抓全文', 'outline') : null),
      feed.note ? h('span', { class: 'feed-note' }, feed.note) : null);
    const more = iconButton('ellipsis', '更多操作', (e) => openMenu(e.currentTarget, [
      { label: '编辑', icon: 'pencil', onSelect: () => openFeedDialog(feed) },
      { label: feed.enabled ? '停用' : '启用', icon: feed.enabled ? 'x' : 'check', onSelect: () => { feed.enabled = !feed.enabled; markDirty('feeds'); draw(); } },
      { label: '复制地址', icon: 'copy', onSelect: () => copyText(feed.url, '地址已复制') },
      { label: '在新标签页打开', icon: 'external-link', onSelect: () => window.open(feed.url, '_blank', 'noopener') },
      { separator: true },
      { label: '删除', icon: 'trash-2', danger: true, onSelect: () => removeFeed(feed, more) },
    ], { align: 'end' }), { small: true });
    rowEl.append(toggle, main, more);
    return rowEl;
  }

  function matches(feed) {
    if (state.filter === 'failing' && !(feed.enabled && S.feedStatus?.[feed.id]?.error)) return false;
    if (state.filter === 'disabled' && feed.enabled) return false;
    if (state.q && !`${feed.name} ${feed.url} ${feed.note || ''}`.toLowerCase().includes(state.q)) return false;
    return true;
  }

  let rates = null;

  function draw() {
    rates = S.items ? passRates(7) : null;
    const feeds = S.feeds.feeds;
    const failing = feeds.filter((f) => f.enabled && S.feedStatus?.[f.id]?.error).length;
    sub.textContent = `共 ${feeds.length} 个，启用 ${feeds.filter((f) => f.enabled).length} 个${failing ? ` · ${failing} 个抓取失败` : ''}`;
    const groupIds = new Set(S.feeds.groups.map((g) => g.id));
    const sections = S.feeds.groups.map((g) => [g.id, g.name || g.id]);
    if (feeds.some((f) => !groupIds.has(f.group))) sections.push(['__none', '未分组']);
    const nodes = [];
    for (const [gid, name] of sections) {
      const list = feeds.filter((f) => (gid === '__none' ? !groupIds.has(f.group) : f.group === gid) && matches(f));
      if (!list.length && (state.filter !== 'all' || state.q)) continue;
      nodes.push(h('section', { class: 'section' },
        h('h2', { class: 'section-title' }, name, h('span', { class: 'section-count' }, `${list.length}`)),
        list.length ? h('div', { class: 'feed-list' }, list.map(feedRow)) : h('p', { class: 'hint' }, '这个分组还没有订阅源。')));
    }
    body.replaceChildren(...(nodes.length ? nodes : [emptyState('没有符合条件的订阅源', state.filter === 'failing' ? '所有启用的订阅源都能正常抓取。' : '换个条件试试。')]));
  }

  async function removeFeed(feed, anchor) {
    if (!(await confirmDialog({ title: '删除订阅源？', message: `「${feed.name}」会从清单里移除，已推送的文章不受影响。保存后生效。`, confirmLabel: '删除', danger: true, anchor }))) return;
    S.feeds.feeds = S.feeds.feeds.filter((f) => f !== feed);
    markDirty('feeds');
    draw();
  }

  draw();
  loadItems(); // 通过率要用最近的条目
  return {
    el,
    refresh(what) { if (what.has('status') || what.has('config') || what.has('dirty') || what.has('items')) draw(); },
  };

  // ---------------------------------------------------------------- 编辑 / 添加

  function openFeedDialog(feed) {
    const isNew = !feed;
    const d = feed ? { ...feed } : { name: '', url: '', group: S.feeds.groups[0]?.id || '', enabled: true, filter: true, translate: true, fulltext: false, note: '' };
    const url = h('input', { class: 'input mono-input', type: 'url', value: d.url, placeholder: 'https://example.com/feed.xml', autocapitalize: 'off', spellcheck: 'false' });
    const name = h('input', { class: 'input', value: d.name, placeholder: '留空则用网站域名' });
    const group = selectControl({ value: d.group, label: '分组', options: groupOptions() });
    const note = h('input', { class: 'input', value: d.note || '', placeholder: '可选' });
    const opt = (key, label) => {
      const input = h('input', { type: 'checkbox', checked: !!d[key] });
      return [input, h('label', { class: 'check' }, input, label)];
    };
    const [enabled, enabledL] = opt('enabled', '启用');
    const [filterIn, filterL] = opt('filter', 'AI 筛选');
    const [translate, translateL] = opt('translate', '翻译');
    const [fulltext, fulltextL] = opt('fulltext', '总是抓全文');
    const error = h('p', { class: 'field-error', role: 'alert' });

    openDialog({
      title: isNew ? '添加订阅源' : '编辑订阅源',
      description: '改动先暂存在本页，点底部「保存」后才提交。',
      body: [
        h('div', { class: 'field' }, h('label', { class: 'label' }, '订阅地址（RSS / Atom）'), url),
        h('div', { class: 'field-row' },
          h('div', { class: 'field' }, h('label', { class: 'label' }, '名称'), name),
          h('div', { class: 'field' }, h('label', { class: 'label' }, '分组'), group)),
        h('div', { class: 'field' }, h('span', { class: 'label' }, '选项'),
          h('div', { class: 'check-row' }, enabledL, filterL, translateL, fulltextL),
          h('span', { class: 'hint' }, '关掉「AI 筛选」就全部推送（仍会打分，用来标重要）。feed 里正文太短（只有摘要）时会自动去原网页抓全文；打开「总是抓全文」则每篇都抓，适合 feed 只给前几段的网站。')),
        h('div', { class: 'field' }, h('label', { class: 'label' }, '备注'), note),
        error,
      ],
      actions: [
        isNew ? null : { label: '删除', variant: 'danger', start: true, onClick: () => { removeFeed(feed); } },
        { label: '取消', variant: 'ghost' },
        {
          label: isNew ? '添加' : '确定',
          variant: 'primary',
          onClick: () => {
            const u = url.value.trim();
            if (!/^https?:\/\/\S+$/i.test(u)) { error.textContent = '请填写以 http:// 或 https:// 开头的地址'; url.setAttribute('aria-invalid', 'true'); return false; }
            const dup = S.feeds.feeds.find((f) => f.url === u && f !== feed);
            if (dup) { error.textContent = `这个地址已经在「${dup.name}」里了`; return false; }
            const next = {
              ...d,
              url: u,
              name: name.value.trim() || hostOf(u),
              group: group.querySelector('select').value,
              enabled: enabled.checked,
              filter: filterIn.checked,
              translate: translate.checked,
              fulltext: fulltext.checked,
              note: note.value.trim(),
            };
            if (isNew) {
              next.id = uniqueId(slugify(name.value.trim() || hostOf(u)));
              S.feeds.feeds.push(next);
            } else {
              Object.assign(feed, next);
            }
            markDirty('feeds');
            draw();
            return undefined;
          },
        },
      ].filter(Boolean),
    });
    setTimeout(() => (isNew ? url : name).focus(), 50);
  }

  // ---------------------------------------------------------------- 分组

  function openGroupsDialog(anchor) {
    const draft = S.feeds.groups.map((g) => ({ ...g }));
    const used = new Set(S.feeds.feeds.map((f) => f.group));
    const list = h('div', { class: 'group-list' });
    const newId = h('input', { class: 'input mono-input', placeholder: 'security', autocapitalize: 'off', spellcheck: 'false' });
    const newName = h('input', { class: 'input', placeholder: '安全' });
    const error = h('p', { class: 'field-error', role: 'alert' });

    function drawList() {
      list.replaceChildren(...draft.map((g, i) => h('div', { class: 'group-row' },
        h('div', { class: 'field' },
          h('input', { class: 'input', value: g.name || '', 'aria-label': `分组 ${g.id} 的名称`, oninput: (e) => { g.name = e.target.value; } }),
          h('span', { class: 'hint mono' }, `feeds/${g.id}.xml`)),
        iconButton('trash-2', used.has(g.id) ? '还有订阅源在这个分组里，不能删除' : '删除分组', () => {
          if (used.has(g.id)) { toast('先把这个分组里的订阅源移走'); return; }
          draft.splice(i, 1);
          drawList();
        }, { small: true }))));
    }
    drawList();

    openDialog({
      title: '管理分组',
      description: '每个分组会单独生成一个 feed。id 会出现在订阅地址里，创建后不能改。',
      anchor,
      body: [
        list,
        h('div', { class: 'field-row group-new' },
          h('div', { class: 'field' }, h('label', { class: 'label' }, '新分组 id'), newId),
          h('div', { class: 'field' }, h('label', { class: 'label' }, '名称'), newName),
          h('button', {
            type: 'button', class: 'btn btn-secondary group-add',
            onclick: () => {
              const id = newId.value.trim().toLowerCase();
              error.textContent = '';
              if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { error.textContent = 'id 只能用小写字母、数字和连字符'; return; }
              if (['all', 'important', 'index'].includes(id) || draft.some((g) => g.id === id)) { error.textContent = '这个 id 已经被占用了'; return; }
              draft.push({ id, name: newName.value.trim() || id });
              newId.value = '';
              newName.value = '';
              drawList();
            },
          }, icon('plus'), '添加')),
        error,
      ],
      actions: [
        { label: '取消', variant: 'ghost' },
        { label: '确定', variant: 'primary', onClick: () => { S.feeds.groups = draft; markDirty('feeds'); draw(); return undefined; } },
      ],
    });
  }
}

// ---------------------------------------------------------------- OPML 导入（首页附件按钮也用）

export function openImportDialog({ group = '', onDone } = {}) {
  const picker = h('input', { type: 'file', accept: '.opml,.xml,text/xml,application/xml', style: 'display:none' });
  document.body.append(picker);
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.remove();
    if (!file) return;
    let doc;
    try {
      doc = new DOMParser().parseFromString(await file.text(), 'text/xml');
    } catch {
      toast('读取文件失败', { tone: 'danger' });
      return;
    }
    const existing = new Set(S.feeds.feeds.map((f) => f.url));
    const found = new Map();
    for (const o of doc.querySelectorAll('outline')) {
      const url = (o.getAttribute('xmlUrl') || o.getAttribute('xmlurl') || '').trim();
      if (!/^https?:\/\//i.test(url) || existing.has(url) || found.has(url)) continue;
      found.set(url, { url, name: (o.getAttribute('title') || o.getAttribute('text') || '').trim() });
    }
    if (!found.size) {
      toast('没有发现新的订阅源（已经在清单里的会自动跳过）');
      return;
    }
    const target = selectControl({ value: group || S.feeds.groups[0]?.id || '', label: '分组', options: groupOptions() });
    const rows = [...found.values()].map((c) => {
      const input = h('input', { type: 'checkbox', checked: true });
      return { c, input, el: h('label', { class: 'import-row' }, input, h('span', { class: 'import-text' }, h('span', { class: 'feed-name' }, c.name || hostOf(c.url)), h('span', { class: 'feed-url' }, c.url))) };
    });
    openDialog({
      title: `从 OPML 导入 ${found.size} 个订阅源`,
      description: '已经在清单里的地址会自动跳过。导入后记得点底部「保存」。',
      wide: true,
      body: [
        h('div', { class: 'field' }, h('label', { class: 'label' }, '放进分组'), target),
        h('div', { class: 'import-list' }, rows.map((r) => r.el)),
      ],
      actions: [
        { label: '取消', variant: 'ghost' },
        {
          label: '导入',
          variant: 'primary',
          onClick: () => {
            const g = target.querySelector('select').value;
            let n = 0;
            for (const { c, input } of rows) {
              if (!input.checked) continue;
              const name = c.name || hostOf(c.url);
              S.feeds.feeds.push({ id: uniqueId(slugify(name)), name, url: c.url, group: g, enabled: true, filter: true, translate: true, fulltext: false, note: '' });
              n++;
            }
            if (n) markDirty('feeds');
            toast(n ? `已加入 ${n} 个，记得保存` : '没有选中任何订阅源');
            onDone?.(n);
            return undefined;
          },
        },
      ],
    });
  });
  picker.click();
}

