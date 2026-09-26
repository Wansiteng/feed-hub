/* Feed Hub 组件库（ES module），管理页面和设计预览共用。
 *
 * 安全约定：动态文字一律通过 textContent 写入（h() 不支持 innerHTML）。
 * 唯一接收外部 HTML 的入口是 sanitizeHtml()，它按白名单重建节点。 */

const SPRITE = new URL('icons.svg', import.meta.url).href;
const SVG_NS = 'http://www.w3.org/2000/svg';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ---------------------------------------------------------------- DOM

/** 只允许 http(s)、mailto、站内锚点和相对路径，挡掉 javascript: 之类。 */
export function safeUrl(url) {
  const s = String(url ?? '').trim();
  return /^(https?:|mailto:|#|\.{0,2}\/)/i.test(s) ? s : '#';
}

const PROPS = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'indeterminate', 'open']);

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = {};
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'href') el.setAttribute('href', safeUrl(value));
    else if (PROPS.has(key)) props[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  Object.assign(el, props); // select 的 value 要在 option 加进去之后再设
  return el;
}

/** 过滤掉 null / false，方便把条件渲染的节点直接交给 replaceChildren、append（否则会显示成 "null"）。 */
export function nodes(...items) {
  return items.flat(Infinity).filter((x) => x != null && x !== false);
}

function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
}

export function icon(name, { lg = false, cls = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon${lg ? ' icon-lg' : ''}${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `${SPRITE}#${name}`);
  svg.append(use);
  return svg;
}

/** 品牌标识（占位）。breathe=true 时是「思考中」的呼吸动画。 */
export function mark({ breathe = false, small = false } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `mark${small ? ' mark-sm' : ''}${breathe ? ' mark-breathe' : ''}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', '6'); dot.setAttribute('cy', '18'); dot.setAttribute('r', '2.2');
  const arcs = document.createElementNS(SVG_NS, 'path');
  arcs.setAttribute('d', 'M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16');
  svg.append(dot, arcs);
  return svg;
}

/** 浮层挂在 body 上，要继承触发它的元素所在的局部主题（设计预览里的左右两栏）。 */
function adoptTheme(el, anchor) {
  const scope = anchor?.closest?.('[data-theme]');
  if (scope && scope !== document.documentElement) el.setAttribute('data-theme', scope.getAttribute('data-theme'));
}

// ---------------------------------------------------------------- 小组件

export function iconButton(name, label, onClick, { small = false, lg = false, cls = '' } = {}) {
  return h('button', {
    type: 'button',
    class: `btn btn-icon${small ? ' btn-sm' : ''}${cls ? ` ${cls}` : ''}`,
    'aria-label': label,
    'data-tooltip': label,
    onclick: onClick,
  }, icon(name, { lg }));
}

export function thinking(text = '思考中…') {
  return h('div', { class: 'thinking', role: 'status' }, mark({ breathe: true }), h('span', {}, text));
}

export function badge(text, tone = '') {
  return h('span', { class: `badge${tone ? ` badge-${tone}` : ''}` }, text);
}

export function switchControl({ checked = false, label, disabled = false, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, disabled, 'aria-label': label });
  if (onChange) input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }));
}

export function selectControl({ value, options, label, onChange, cls = '' }) {
  const select = h('select', { 'aria-label': label, value },
    options.map((o) => h('option', { value: o.value }, o.label)));
  if (onChange) select.addEventListener('change', () => onChange(select.value));
  return h('div', { class: `select${cls ? ` ${cls}` : ''}` }, select, icon('chevron-down'));
}

/** 分段单选：方向键切换，读屏读作单选组。 */
export function segmented({ items, value, label, onChange }) {
  let current = value;
  const group = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label });
  const buttons = items.map((it) => h('button', {
    type: 'button', class: 'segmented-item', role: 'radio', dataset: { value: it.value },
    onclick: () => select(it.value),
  }, it.icon ? icon(it.icon) : null, h('span', {}, it.label)));
  function render() {
    for (const b of buttons) {
      const on = b.dataset.value === current;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }
  function select(v, focus = false) {
    if (v === current) return;
    current = v;
    render();
    if (focus) buttons.find((b) => b.dataset.value === v)?.focus();
    onChange?.(v);
  }
  group.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const i = items.findIndex((it) => it.value === current);
    select(items[(i + step + items.length) % items.length].value, true);
  });
  group.append(...buttons);
  render();
  return { el: group, set(v) { current = v; render(); }, get value() { return current; } };
}

let wheelSeq = 0;

/**
 * 滚轮选择（像 iPhone 闹钟）：上下滑动，停下时吸附到中间一格；点一格直接选中；方向键、Page Up / Down、Home / End 也能选。
 * 读屏读作列表框。items: [{ value, label }]
 */
export function wheelPicker({ items, value, label, onChange }) {
  const seq = ++wheelSeq;
  let index = Math.max(0, items.findIndex((it) => it.value === value));
  const opts = items.map((it, i) => h('li', {
    class: 'wheel-item', role: 'option', id: `wheel-${seq}-${i}`, onclick: () => go(i, true),
  }, it.label));
  const list = h('ul', { class: 'wheel-list', role: 'listbox', tabindex: 0, 'aria-label': label }, opts);
  const el = h('div', { class: 'wheel' }, h('div', { class: 'wheel-band', 'aria-hidden': 'true' }), list);
  const row = () => opts[0].offsetHeight || 40;

  function render() {
    opts.forEach((o, i) => o.setAttribute('aria-selected', String(i === index)));
    list.setAttribute('aria-activedescendant', opts[index].id);
  }
  function choose(i) {
    if (i === index) return;
    index = i;
    render();
    onChange?.(items[i].value);
  }
  function go(i, smooth = false) {
    const target = Math.min(items.length - 1, Math.max(0, i));
    list.scrollTo({ top: target * row(), behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto' });
    choose(target);
  }
  // 滑动时中间那一格就是选中的；吸附（scroll-snap）保证停下时正好对齐
  list.addEventListener('scroll', () => choose(Math.min(items.length - 1, Math.max(0, Math.round(list.scrollTop / row())))));
  list.addEventListener('keydown', (e) => {
    const to = { ArrowDown: index + 1, ArrowUp: index - 1, PageDown: index + 5, PageUp: index - 5, Home: 0, End: items.length - 1 }[e.key];
    if (to == null) return;
    e.preventDefault();
    // 键盘直接跳过去：平滑滚动途中的滚动事件会把选中项拉回半路，连按时就会少走几格
    go(to);
  });
  // 放进页面、有了尺寸之后再滚到当前值
  const sized = new ResizeObserver(() => {
    if (!list.clientHeight) return;
    list.scrollTop = index * row();
    sized.disconnect();
  });
  sized.observe(list);
  render();
  return {
    el,
    get value() { return items[index].value; },
    set(v) { go(items.findIndex((it) => it.value === v)); },
  };
}

// ---------------------------------------------------------------- 时间

export function fmtTime(iso, { withYear = false } = {}) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', {
    hour12: false, year: withYear ? 'numeric' : undefined, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(s)) return '';
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} 天前`;
  return fmtTime(iso);
}

// ---------------------------------------------------------------- 复制、通知

let toastRegion;
export function toast(message, { tone = '', duration = 2400 } = {}) {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toast-region', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const el = h('div', { class: `toast${tone === 'danger' ? ' is-danger' : ''}` }, message);
  toastRegion.append(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  }, tone === 'danger' ? Math.max(duration, 5000) : duration);
}

export async function copyText(text, message = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: 'position:fixed;opacity:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(message);
}

// ---------------------------------------------------------------- 提示

export function initTooltips() {
  if (initTooltips.done) return;
  initTooltips.done = true;
  let timer = 0;
  let tip = null;
  let current = null;

  function show(el) {
    const text = el.getAttribute('data-tooltip');
    if (!text || !el.isConnected) return;
    hide();
    current = el;
    tip = h('div', { class: 'tooltip', role: 'tooltip' }, text);
    adoptTheme(tip, el);
    document.body.append(tip);
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    const hgt = tip.offsetHeight;
    let top = r.top - hgt - 6;
    if (top < 4) top = r.bottom + 6;
    const left = Math.max(4, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - 4));
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
  }
  function hide() {
    clearTimeout(timer);
    tip?.remove();
    tip = null;
    current = null;
  }
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = e.target.closest?.('[data-tooltip]');
    if (!el || el === current) return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el), 450);
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('[data-tooltip]');
    if (el && !el.contains(e.relatedTarget)) hide();
  });
  document.addEventListener('focusin', (e) => {
    const el = e.target.closest?.('[data-tooltip]');
    if (el && el.matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('scroll', hide, true);
}

// ---------------------------------------------------------------- 菜单

let activeMenu = null;

export function closeMenu() {
  activeMenu?.close({ restoreFocus: false });
}

/**
 * items: [{ label, icon, hint, checked, danger, disabled, onSelect } | { separator: true } | { header: '标题' }]
 * checked 不为 undefined 时是单选项（右侧显示对勾）。
 */
export function openMenu(anchor, items, { align = 'start', placement = 'bottom' } = {}) {
  if (activeMenu && activeMenu.anchor === anchor) {
    activeMenu.close();
    return;
  }
  closeMenu();

  const menu = h('div', { class: 'menu is-floating', role: 'menu' });
  adoptTheme(menu, anchor);
  const buttons = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'menu-label' }, it.header)); continue; }
    const radio = it.checked !== undefined;
    const btn = h('button', {
      type: 'button',
      class: `menu-item${it.danger ? ' is-danger' : ''}`,
      role: radio ? 'menuitemradio' : 'menuitem',
      'aria-checked': radio ? String(!!it.checked) : null,
      disabled: it.disabled,
      tabindex: '-1',
      onclick: () => { close({ restoreFocus: !it.keepFocus }); it.onSelect?.(); },
    },
    it.icon ? icon(it.icon) : null,
    h('span', { class: 'menu-text' }, it.label),
    it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
    radio ? icon('check', { cls: 'menu-check' }) : null);
    buttons.push(btn);
    menu.append(btn);
  }
  document.body.append(menu);
  place(menu, anchor, align, placement);
  anchor.setAttribute('aria-expanded', 'true');

  const enabled = () => buttons.filter((b) => !b.disabled);
  function onKey(e) {
    const list = enabled();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close({ restoreFocus: false });
  }
  function onDown(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) close({ restoreFocus: false });
  }
  // 页面滚动（比如流式输出时的自动跟随）时菜单跟着按钮走；按钮滚出屏幕才关闭
  function onScroll(e) {
    if (e?.target && menu.contains(e.target)) return;
    const r = anchor.getBoundingClientRect();
    if (!anchor.isConnected || r.bottom < 0 || r.top > innerHeight) close({ restoreFocus: false });
    else place(menu, anchor, align, placement);
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onDown, true);
  window.addEventListener('resize', onScroll);
  window.addEventListener('scroll', onScroll, true);

  let closed = false;
  function close({ restoreFocus = true } = {}) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('resize', onScroll);
    window.removeEventListener('scroll', onScroll, true);
    anchor.setAttribute('aria-expanded', 'false');
    menu.classList.add('is-leaving');
    setTimeout(() => menu.remove(), 130);
    if (restoreFocus && anchor.isConnected) anchor.focus({ preventScroll: true });
    if (activeMenu?.menu === menu) activeMenu = null;
  }
  activeMenu = { menu, anchor, close };
  (buttons.find((b) => b.getAttribute('aria-checked') === 'true') || enabled()[0])?.focus({ preventScroll: true });
  return close;
}

function place(menu, anchor, align, placement) {
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  const gap = 6;
  let top;
  let vertical;
  const below = r.bottom + gap;
  const above = r.top - hgt - gap;
  if (placement === 'top') {
    [top, vertical] = above >= 8 ? [above, 'bottom'] : [below, 'top'];
  } else {
    [top, vertical] = below + hgt <= innerHeight - 8 || above < 8 ? [below, 'top'] : [above, 'bottom'];
  }
  let left = align === 'end' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  menu.style.top = `${Math.max(8, top)}px`;
  menu.style.left = `${left}px`;
  menu.style.setProperty('--menu-origin', `${vertical} ${align === 'end' ? 'right' : 'left'}`);
}

// ---------------------------------------------------------------- 弹窗

let dialogSeq = 0;

/**
 * actions: [{ label, variant: 'primary'|'secondary'|'ghost'|'danger', icon, start, onClick(api) }]
 * sheet: 手机上从屏幕底部升起（像 iPhone 的选择面板），电脑上和普通弹窗一样。
 * onClick 返回 false 则不关闭；返回 Promise 时按钮进入加载状态，resolve 后关闭（resolve 为 false 则不关）。
 */
export function openDialog({ title, description, body, actions = [], wide = false, sheet = false, anchor = null, onClose }) {
  const id = `dlg-${++dialogSeq}`;
  const bodyEl = h('div', { class: 'dialog-body' }, body);
  const dlg = h('dialog', { class: `dialog${wide ? ' dialog-wide' : ''}${sheet ? ' dialog-sheet' : ''}`, 'aria-labelledby': id });
  adoptTheme(dlg, anchor);

  let closing = false;
  const api = {
    el: dlg,
    body: bodyEl,
    close(result) {
      if (closing) return;
      closing = true;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (dlg.open) dlg.close();
        dlg.remove();
        onClose?.(result);
      };
      if (reduceMotion.matches) { finish(); return; }
      dlg.classList.add('is-closing');
      dlg.addEventListener('animationend', finish, { once: true });
      setTimeout(finish, 220);
    },
  };

  const startButtons = [];
  const endButtons = [];
  for (const a of actions) {
    const btn = h('button', { type: 'button', class: `btn btn-${a.variant || 'secondary'}` }, a.icon ? icon(a.icon) : null, a.label);
    btn.addEventListener('click', async () => {
      const result = a.onClick ? a.onClick(api) : undefined;
      if (result && typeof result.then === 'function') {
        btn.classList.add('is-loading');
        btn.prepend(mark({ breathe: true, small: true }));
        dlg.querySelectorAll('.dialog-foot .btn').forEach((b) => { b.disabled = true; });
        let ok;
        try { ok = await result; } finally {
          btn.classList.remove('is-loading');
          btn.querySelector('.mark')?.remove();
          dlg.querySelectorAll('.dialog-foot .btn').forEach((b) => { b.disabled = false; });
        }
        if (ok !== false) api.close(ok);
      } else if (result !== false) {
        api.close(result);
      }
    });
    (a.start ? startButtons : endButtons).push(btn);
  }

  dlg.append(
    h('div', { class: 'dialog-head' },
      h('h2', { class: 'dialog-title', id }, title),
      description ? h('p', { class: 'dialog-desc' }, description) : null),
    bodyEl,
    actions.length ? h('div', { class: 'dialog-foot' }, startButtons, h('span', { class: 'spacer' }), endButtons) : null,
  );
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); api.close(); });
  dlg.addEventListener('click', (e) => {
    if (e.target !== dlg) return;
    const r = dlg.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) api.close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return api;
}

export function confirmDialog({ title, message, confirmLabel = '确定', danger = false, anchor = null }) {
  return new Promise((resolve) => {
    openDialog({
      title,
      description: message,
      anchor,
      actions: [
        { label: '取消', variant: 'ghost', onClick: () => undefined },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => true },
      ],
      onClose: (result) => resolve(result === true),
    });
  });
}

// ---------------------------------------------------------------- 代码块

const KEYWORDS = new Set((
  'abstract and as assert async await break case catch class const continue def default del delete do elif else enum '
  + 'except export extends false False final finally fn for from func function go if impl import in instanceof interface '
  + 'is lambda let loop match mod mut new nil None nonlocal not null or package pass private protected pub public raise '
  + 'return self static struct super switch this throw throws true True try type typeof use var void while with yield'
).split(' '));
const HASH_COMMENT = /^(py|python|sh|bash|shell|zsh|console|yaml|yml|toml|rb|ruby|r|perl|dockerfile|make|makefile|ini|conf|nginx)$/i;
const NO_HIGHLIGHT = /^(text|plain|plaintext|txt|html|xml|svg|md|markdown|csv|log)$/i;
const STRINGS = String.raw`"(?:\\[\s\S]|[^"\\\n])*"|'(?:\\[\s\S]|[^'\\\n])*'|` + '`(?:\\\\[\\s\\S]|[^`\\\\])*`';
const TOKENS_C = new RegExp(String.raw`(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(${STRINGS})|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)`, 'g');
const TOKENS_HASH = new RegExp(String.raw`(#[^\n]*)|(${STRINGS})|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_$][\w$]*)`, 'g');

/** 很轻量的通用高亮：注释、字符串、数字、关键字、函数调用、类型名。 */
export function highlight(code, lang = '') {
  const frag = document.createDocumentFragment();
  if (!lang || NO_HIGHLIGHT.test(lang)) {
    frag.append(code);
    return frag;
  }
  const re = HASH_COMMENT.test(lang) ? TOKENS_HASH : TOKENS_C;
  re.lastIndex = 0;
  let last = 0;
  for (const m of code.matchAll(re)) {
    const [text, comment, str, num, ident] = m;
    if (m.index > last) frag.append(code.slice(last, m.index));
    let cls = null;
    if (comment) cls = 'hl-comment';
    else if (str) cls = 'hl-string';
    else if (num) cls = 'hl-number';
    else if (ident) {
      if (KEYWORDS.has(ident)) cls = 'hl-keyword';
      else if (/^\s*\(/.test(code.slice(m.index + text.length, m.index + text.length + 8))) cls = 'hl-function';
      else if (/^[A-Z][a-z]/.test(ident)) cls = 'hl-type';
    }
    frag.append(cls ? h('span', { class: cls }, text) : text);
    last = m.index + text.length;
  }
  if (last < code.length) frag.append(code.slice(last));
  return frag;
}

export function codeBlock(code, lang = '') {
  const copyBtn = iconButton('copy', '复制代码', () => {
    copyText(code, '代码已复制');
    copyBtn.replaceChildren(icon('check'));
    setTimeout(() => copyBtn.replaceChildren(icon('copy')), 1500);
  }, { small: true });
  return h('div', { class: 'code-block' },
    h('div', { class: 'code-head' }, h('span', {}, lang || '代码'), copyBtn),
    h('pre', {}, h('code', {}, highlight(code.replace(/\n$/, ''), lang))));
}

/** 把正文里的 <pre> 换成带语言标签和复制按钮的代码块。 */
export function enhanceCodeBlocks(root) {
  for (const pre of [...root.querySelectorAll('pre')]) {
    if (pre.closest('.code-block')) continue;
    const code = pre.querySelector('code');
    const cls = `${pre.className} ${code?.className || ''}`;
    const lang = (cls.match(/language-([\w+-]+)/) || [])[1] || '';
    pre.replaceWith(codeBlock(pre.textContent, lang));
  }
}

// ---------------------------------------------------------------- 外部 HTML 净化

const ALLOWED_TAGS = new Set((
  'a abbr b blockquote br caption cite code dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img '
  + 'ins kbd li mark ol p pre q s samp small span strong sub summary sup table tbody td tfoot th thead time tr u ul'
).split(' '));
const DROPPED_TAGS = new Set((
  'script style iframe frame frameset object embed applet noscript template svg math form input button select option '
  + 'textarea video audio canvas link meta base head title'
).split(' '));

/**
 * 按白名单重建外部 HTML（订阅源内容、模型译文），返回 DocumentFragment。
 * 不认识的标签去壳保留文字；链接只保留 http(s)/mailto 并在新标签页打开；图片只保留 http(s)。
 * DOMParser 生成的文档是惰性的，解析过程中不会执行脚本、也不会加载图片。
 */
export function sanitizeHtml(html, baseUrl = '') {
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html || ''}`, 'text/html');
  const frag = document.createDocumentFragment();
  const resolve = (url) => {
    if (!url) return null;
    try { return new URL(url, baseUrl || undefined).href; } catch { return null; }
  };

  function walk(src, dst) {
    for (const node of src.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { dst.append(node.data); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = node.tagName.toLowerCase();
      if (DROPPED_TAGS.has(tag)) continue;
      if (!ALLOWED_TAGS.has(tag)) { walk(node, dst); continue; }
      const el = document.createElement(tag);
      if (tag === 'a') {
        const href = resolve(node.getAttribute('href'));
        if (href && /^(https?|mailto):/i.test(href)) {
          el.setAttribute('href', href);
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      } else if (tag === 'img') {
        const src = resolve(node.getAttribute('src') || node.getAttribute('data-src'));
        if (!src || !/^https?:/i.test(src)) continue;
        el.setAttribute('src', src);
        el.setAttribute('alt', node.getAttribute('alt') || '');
        el.setAttribute('loading', 'lazy');
        el.setAttribute('decoding', 'async');
        el.setAttribute('referrerpolicy', 'no-referrer');
      } else if (tag === 'td' || tag === 'th') {
        for (const attr of ['colspan', 'rowspan']) {
          const v = node.getAttribute(attr);
          if (v && /^\d{1,2}$/.test(v)) el.setAttribute(attr, v);
        }
      } else if (tag === 'ol') {
        const start = node.getAttribute('start');
        if (start && /^\d{1,5}$/.test(start)) el.setAttribute('start', start);
      } else if (tag === 'pre' || tag === 'code') {
        const lang = (node.className.match(/language-[\w+-]+/) || [])[0];
        if (lang) el.className = lang;
      }
      // 中英对照里的译文标着 lang，阅读器据此排版
      const lang = node.getAttribute('lang');
      if (lang && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) el.setAttribute('lang', lang);
      walk(node, el);
      dst.append(el);
    }
  }
  walk(doc.body, frag);
  return frag;
}

// ---------------------------------------------------------------- 主输入框

export function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
}

/**
 * 主输入框：自动增高（上限 40vh），Enter 发送、Shift+Enter 换行，中文输入法选词时的 Enter 不会误发。
 * pills: [{ icon: () => name, label: () => text, items: () => menuItems, hidden: () => bool }]
 */
export function createComposer({ placeholder = '', label = '输入', onSubmit, onAttach, attachLabel = '添加附件', pills = [] }) {
  const input = h('textarea', { class: 'composer-input', rows: 1, placeholder, 'aria-label': label, enterkeyhint: 'send' });
  const send = h('button', { type: 'submit', class: 'btn btn-send', 'aria-label': '发送', 'data-tooltip': '发送', disabled: true }, icon('arrow-up'));
  const pillBox = h('div', { style: 'display:contents' });
  const attach = onAttach ? iconButton('paperclip', attachLabel, () => onAttach()) : null;
  const form = h('form', { class: 'composer' },
    input,
    h('div', { class: 'composer-bar' }, attach, h('span', { class: 'spacer' }), pillBox, send));

  let busy = false;
  const update = () => {
    send.disabled = busy || !input.value.trim();
    autoGrow(input);
  };
  function submit() {
    const text = input.value.trim();
    if (!text || busy) return;
    if (onSubmit(text) !== false) {
      input.value = '';
      update();
    }
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  form.addEventListener('click', (e) => {
    if (e.target === form || e.target.classList?.contains('composer-bar') || e.target.classList?.contains('spacer')) input.focus();
  });
  input.addEventListener('input', update);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submit();
    }
  });

  function renderPills() {
    pillBox.replaceChildren(...pills.filter((p) => !p.hidden?.()).map((p) => h('button', {
      type: 'button', class: 'pill', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
      onclick: (e) => openMenu(e.currentTarget, p.items(), { align: 'end' }),
    }, p.icon ? icon(p.icon()) : null, h('span', {}, p.label()), icon('chevron-down', { cls: 'icon-chevron' }))));
  }
  renderPills();
  update();

  return {
    el: form,
    input,
    focus() { input.focus({ preventScroll: true }); },
    refresh() { renderPills(); update(); },
    setPlaceholder(text) { input.placeholder = text; },
    setBusy(value) { busy = value; update(); },
    setValue(text) { input.value = text; update(); },
  };
}

// ---------------------------------------------------------------- 流式输出时的滚动跟随

/**
 * 内容增长时平滑跟随到底部；用户往上滑就暂停跟随，并显示「回到底部」按钮。
 * scroller：滚动容器；content：会变高的内容；button：回到底部按钮（带 hidden 属性）。
 */
export function followScroll(scroller, content, button) {
  let stick = true;
  let lastTop = scroller.scrollTop;
  const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
  const toBottom = (smooth = true) => scroller.scrollTo({
    top: scroller.scrollHeight,
    behavior: smooth && !reduceMotion.matches ? 'smooth' : 'auto',
  });
  scroller.addEventListener('scroll', () => {
    const top = scroller.scrollTop;
    if (top < lastTop - 2) stick = false; // 用户往上滑（程序滚动只会往下）
    if (atBottom()) stick = true;
    lastTop = top;
    button.hidden = stick;
  }, { passive: true });
  new ResizeObserver(() => {
    if (stick) toBottom();
    else button.hidden = false;
  }).observe(content);
  button.addEventListener('click', () => {
    stick = true;
    button.hidden = true;
    toBottom();
  });
  return {
    toBottom(smooth = true) { stick = true; button.hidden = true; toBottom(smooth); },
    get following() { return stick; },
  };
}
