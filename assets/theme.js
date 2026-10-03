/* 主题：浅色 / 深色 / 跟随系统。
 *
 * 首帧之前的主题由各页面 <head> 里的内联脚本 <script id="theme-init"> 设置，杜绝白闪；
 * 这里负责之后的事：切换、跟随系统变化、多个标签页同步、同步 Safari 工具栏颜色、渲染切换控件。
 *
 * 用法：
 *   <div data-theme-switcher></div>            带文字的三段切换
 *   <div data-theme-switcher="compact"></div>  只有图标
 *   FeedHubTheme.set('dark') / .pref / .theme / .subscribe(fn)
 */
(() => {
  'use strict';

  const KEY = 'feedhub.theme';
  const PREFS = ['light', 'dark', 'system'];
  const LABELS = { light: '浅色', dark: '深色', system: '跟随系统' };
  const ICONS = { light: 'sun', dark: 'moon', system: 'monitor' };
  const SWITCH_MS = 300; // 略长于 --dur-base，保证过渡走完

  const root = document.documentElement;
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const sprite = new URL('icons.svg', document.currentScript.src).href;
  const listeners = new Set();
  let pref = readPref();
  let switchTimer = 0;

  function readPref() {
    try {
      const value = localStorage.getItem(KEY);
      return PREFS.includes(value) ? value : 'system';
    } catch {
      return 'system';
    }
  }

  function savePref(value) {
    try { localStorage.setItem(KEY, value); } catch { /* 隐私模式等：只在本页生效 */ }
  }

  function resolve(value) {
    return value === 'system' ? (media.matches ? 'dark' : 'light') : value;
  }

  function syncThemeColor() {
    const color = getComputedStyle(root).getPropertyValue('--bg-canvas').trim();
    if (!color) return; // 样式表还没加载
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.append(meta);
    }
    meta.content = color;
  }

  function apply({ animate }) {
    const theme = resolve(pref);
    if (animate && root.dataset.theme !== theme) {
      root.classList.add('theme-switching');
      clearTimeout(switchTimer);
      switchTimer = setTimeout(() => root.classList.remove('theme-switching'), SWITCH_MS);
    }
    root.dataset.theme = theme;
    root.dataset.themePref = pref;
    syncThemeColor();
    for (const fn of listeners) fn({ pref, theme });
  }

  function set(next) {
    if (!PREFS.includes(next) || next === pref) return;
    pref = next;
    savePref(next);
    apply({ animate: true });
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function mountSwitcher(host, { labels = true } = {}) {
    const group = document.createElement('div');
    group.className = 'segmented';
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '主题');

    const buttons = PREFS.map((value) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segmented-item';
      btn.dataset.pref = value;
      btn.setAttribute('role', 'radio');
      btn.title = LABELS[value];
      // 图标是静态内容，不含任何外部数据
      btn.innerHTML = `<svg class="icon" aria-hidden="true"><use href="${sprite}#${ICONS[value]}"></use></svg>`;
      if (labels) {
        const text = document.createElement('span');
        text.textContent = LABELS[value];
        btn.append(text);
      } else {
        btn.setAttribute('aria-label', LABELS[value]);
      }
      btn.addEventListener('click', () => set(value));
      return btn;
    });

    // 单选组的键盘操作：左右（上下）方向键切换并移动焦点
    group.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      const next = buttons[(PREFS.indexOf(pref) + step + PREFS.length) % PREFS.length];
      set(next.dataset.pref);
      next.focus();
    });

    const render = () => {
      for (const btn of buttons) {
        const on = btn.dataset.pref === pref;
        btn.setAttribute('aria-checked', String(on));
        btn.tabIndex = on ? 0 : -1;
      }
    };
    render();
    listeners.add(render);
    group.append(...buttons);
    host.replaceChildren(group);
    return group;
  }

  // 系统外观变化（比如 iPad 自动切换深色）时，跟随系统的页面随之变化
  media.addEventListener('change', () => {
    if (pref === 'system') apply({ animate: true });
  });

  // 其他标签页改了主题
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    pref = readPref();
    apply({ animate: true });
  });

  window.FeedHubTheme = {
    get pref() { return pref; },
    get theme() { return resolve(pref); },
    get system() { return media.matches ? 'dark' : 'light'; },
    set,
    subscribe,
    mountSwitcher,
  };

  for (const el of document.querySelectorAll('[data-theme-switcher]')) {
    mountSwitcher(el, { labels: el.dataset.themeSwitcher !== 'compact' });
  }
  apply({ animate: false });
  window.addEventListener('load', syncThemeColor);
})();
