/* 设计预览页：把同一份样张渲染到浅色、深色两栏，实时读取 token 值、计算对比度，并挂上可交互的组件。 */
import {
  h, icon, createComposer, openMenu, openDialog, confirmDialog, toast, enhanceCodeBlocks,
  followScroll, thinking, initTooltips, copyText, wheelPicker,
} from '../assets/ui.js';

const template = document.getElementById('specimen');
for (const slot of document.querySelectorAll('.theme .slot')) {
  slot.append(template.content.cloneNode(true));
}

// ---------------------------------------------------------------- token 值与对比度

// 把任意 CSS 颜色解析成 [r, g, b, a]（0–1）。借助浏览器计算颜色，兼容 hex、rgba、color-mix。
const probe = document.createElement('span');
probe.style.display = 'none';
function resolve(scope, cssValue) {
  scope.append(probe);
  probe.style.color = cssValue;
  const out = getComputedStyle(probe).color;
  probe.remove();
  const nums = out.match(/[\d.]+/g).map(Number);
  if (out.startsWith('color(')) return [nums[0], nums[1], nums[2], nums[3] ?? 1];
  return [nums[0] / 255, nums[1] / 255, nums[2] / 255, nums[3] ?? 1];
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
function luminance([r, g, b]) {
  const f = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const BG_LABELS = { '--bg-canvas': 'canvas', '--bg-muted': 'muted', '--bg-elevated': 'elevated', '--bg-sidebar': 'sidebar', '--code-bg': 'code' };

for (const theme of document.querySelectorAll('.theme')) {
  const style = getComputedStyle(theme);
  for (const el of theme.querySelectorAll('[data-token]')) {
    el.textContent = style.getPropertyValue(el.dataset.token).trim();
  }
  for (const el of theme.querySelectorAll('.ratios')) {
    const fgs = el.dataset.fg.split(',');
    const bgs = (el.dataset.bgs || '--bg-canvas,--bg-muted,--bg-elevated').split(',');
    const labels = el.dataset.labels ? el.dataset.labels.split(',') : null;
    el.replaceChildren();
    fgs.forEach((fgToken, i) => {
      for (const bgToken of bgs) {
        const bg = resolve(theme, `var(${bgToken})`);
        const ratio = contrast(over(resolve(theme, `var(${fgToken})`), bg), bg);
        const label = labels ? labels[i] : BG_LABELS[bgToken] || bgToken;
        el.append(h('span', { class: `ratio${ratio < 4.5 ? ' low' : ''}` }, `${label} `, h('b', {}, ratio.toFixed(2))));
      }
    });
  }
}

// ---------------------------------------------------------------- 主题切换状态

const NAMES = { light: '浅色', dark: '深色', system: '跟随系统' };
function showStatus() {
  const t = window.FeedHubTheme;
  document.getElementById('st-pref').textContent = NAMES[t.pref];
  document.getElementById('st-theme').textContent = NAMES[t.theme];
  document.getElementById('st-system').textContent = NAMES[t.system];
  const meta = document.querySelector('meta[name="theme-color"]');
  document.getElementById('st-meta').textContent = meta?.content || '—';
}
if (window.FeedHubTheme) {
  window.FeedHubTheme.subscribe(showStatus);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', showStatus);
  showStatus();
}

// ---------------------------------------------------------------- 组件

initTooltips();

const MODES = [
  { id: 'search', label: '搜索文章', icon: 'search', placeholder: '搜索文章：输入关键词，比如 固态电池、MLX' },
  { id: 'interest', label: '补充兴趣', icon: 'lightbulb', placeholder: '告诉 AI 你想多看或少看什么' },
  { id: 'add', label: '添加订阅源', icon: 'rss', placeholder: '粘贴 RSS / Atom 地址，可以一次粘贴多个' },
];

function mountComposer(host) {
  let mode = MODES[0];
  const composer = createComposer({
    placeholder: mode.placeholder,
    label: '主输入框',
    attachLabel: '导入 OPML 文件',
    onAttach: () => toast('这里会打开 OPML 导入'),
    onSubmit: (text) => { toast(`已发送：${text.slice(0, 24)}`); },
    pills: [{
      icon: () => mode.icon,
      label: () => mode.label,
      items: () => MODES.map((m) => ({
        label: m.label, icon: m.icon, checked: m.id === mode.id,
        onSelect: () => { mode = m; composer.setPlaceholder(m.placeholder); composer.refresh(); composer.focus(); },
      })),
    }],
  });
  host.replaceWith(composer.el);
}

for (const theme of document.querySelectorAll('.theme')) {
  theme.querySelectorAll('.mount-composer, .mount-hero-composer').forEach(mountComposer);
  enhanceCodeBlocks(theme);

  // 消息的复制、重试
  theme.querySelectorAll('.msg-actions [aria-label="复制"]').forEach((btn) => {
    btn.addEventListener('click', () => copyText(btn.closest('.msg').querySelector('.prose').innerText, '回复已复制'));
  });
  theme.querySelectorAll('.msg-actions [aria-label="重试"]').forEach((btn) => {
    btn.addEventListener('click', () => toast('会重新执行这条指令'));
  });

  // 滑块数值
  theme.querySelectorAll('.range').forEach((r) => {
    const input = r.querySelector('input');
    input.addEventListener('input', () => { r.querySelector('output').textContent = input.value; });
  });
  // 分段选择
  theme.querySelectorAll('.segmented[role="radiogroup"]:not([aria-label="主题"])').forEach((g) => {
    g.addEventListener('click', (e) => {
      const b = e.target.closest('.segmented-item');
      if (!b) return;
      g.querySelectorAll('.segmented-item').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    });
  });

  // 滚轮选择（设置页的推送时间）
  theme.querySelectorAll('.mount-wheel').forEach((host) => {
    const wheel = wheelPicker({
      items: Array.from({ length: 24 }, (_, hr) => ({ value: hr, label: `${String(hr).padStart(2, '0')}:00` })),
      value: 7,
      label: '推送时间',
    });
    wheel.el.style.width = '120px';
    host.replaceWith(wheel.el);
  });

  // 流式输出
  const scroller = theme.querySelector('.stream-scroll');
  const threadEl = theme.querySelector('.stream-thread');
  const follow = followScroll(scroller, threadEl, theme.querySelector('.scroll-bottom'));
  theme.querySelector('[data-action="stream"]').addEventListener('click', (e) => streamDemo(e.currentTarget, threadEl, follow));

  theme.querySelector('[data-action="menu"]').addEventListener('click', (e) => openMenu(e.currentTarget, [
    { header: '显示方式' },
    { label: '只看中文', checked: true, onSelect: () => toast('只看中文') },
    { label: '中英对照', checked: false, onSelect: () => toast('中英对照') },
    { separator: true },
    { label: '编辑', icon: 'pencil', hint: 'E', onSelect: () => toast('编辑') },
    { label: '复制链接', icon: 'link', onSelect: () => toast('已复制') },
    { label: '删除', icon: 'trash-2', danger: true, onSelect: () => toast('删除') },
  ]));
  theme.querySelector('[data-action="dialog"]').addEventListener('click', (e) => {
    const name = h('input', { class: 'input', value: 'Simon Willison' });
    openDialog({
      title: '编辑订阅源',
      description: '改动先保存在本页，点底部「保存」后才会提交。',
      anchor: e.currentTarget,
      body: [
        h('div', { class: 'field' }, h('label', { class: 'label' }, '名称'), name),
        h('div', { class: 'field' }, h('label', { class: 'label' }, '订阅地址'), h('input', { class: 'input mono-input', value: 'https://simonwillison.net/atom/everything/' })),
      ],
      actions: [
        { label: '删除', variant: 'danger', start: true, onClick: () => toast('删除') },
        { label: '取消', variant: 'ghost' },
        { label: '确定', variant: 'primary', onClick: () => new Promise((r) => setTimeout(() => { toast(`已更新：${name.value}`); r(true); }, 900)) },
      ],
    });
  });
  theme.querySelector('[data-action="confirm"]').addEventListener('click', async (e) => {
    const ok = await confirmDialog({ title: '删除订阅源？', message: '「Mavs Moneyball」会从清单里移除。', confirmLabel: '删除', danger: true, anchor: e.currentTarget });
    toast(ok ? '已删除' : '已取消');
  });
  theme.querySelector('[data-action="toast"]').addEventListener('click', () => toast('已保存，会自动运行一次'));
}

const STREAM_TEXT = [
  '已触发运行。', 'GitHub 分配了运行器，开始抓取 58 个订阅源。', '抓取完成：新条目 143 条，',
  '其中 20 条超过 72 小时被跳过。', '正在按你的兴趣描述打分，每批 12 条……', '打分完成：推送 31 篇，过滤 112 篇。',
  '开始翻译 30 篇文章，重要的优先。', '翻译完成，已生成 9 个 feed 并发布到 GitHub Pages。',
  '这次运行用了 84 秒，模型请求 52 次。',
];

async function streamDemo(btn, threadEl, follow) {
  btn.disabled = true;
  const body = h('div', { class: 'prose' });
  const msg = h('div', { class: 'msg msg-ai' }, thinking('正在等待 GitHub 开始运行…'));
  threadEl.append(msg);
  follow.toBottom();
  await new Promise((r) => setTimeout(r, 900));
  msg.replaceChildren(body);
  let p = h('p');
  body.append(p);
  for (const [i, chunk] of STREAM_TEXT.entries()) {
    for (const piece of chunk.match(/.{1,6}/gu)) {
      p.append(piece); // 直接追加文字，不做逐字动画
      await new Promise((r) => setTimeout(r, 35));
    }
    if (i % 3 === 2 && i < STREAM_TEXT.length - 1) { p = h('p'); body.append(p); }
  }
  msg.append(h('div', { class: 'msg-actions' },
    h('button', { type: 'button', class: 'btn btn-icon btn-sm', 'aria-label': '复制', 'data-tooltip': '复制', onclick: () => copyText(body.innerText) }, icon('copy'))));
  btn.disabled = false;
}

// ---------------------------------------------------------------- 动效重播

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-replay]');
  if (!btn) return;
  const cls = `play-${btn.dataset.replay}`;
  btn.classList.remove(cls);
  void btn.offsetWidth; // 强制重排，让动画重新开始
  btn.classList.add(cls);
});
