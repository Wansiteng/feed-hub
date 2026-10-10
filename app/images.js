/* 正文图片长按（手机）：后面的页面模糊下去，图片在原位浮起来，下面两颗毛玻璃按钮「存储到相册」「打开原图」，点别处收回。
 * 网页不能直接写进相册：iPhone、iPad 上交给系统分享面板（里面的「存储图像」），其他设备下载成文件。
 * 图片在别的网站上，要对方允许跨域（CORS）才能拿到内容（经 canvas 转一次，不放宽 CSP 的 connect-src）；
 * 拿不到时「存储到相册」改成打开原图，在那里长按存储。电脑上不拦右键，用浏览器自己的「图片另存为」。 */
import { h, icon, toast } from '../assets/ui.js';

const HOLD_MS = 450;
const SLOP = 10; // 手指挪动超过这么多像素算滚动，不算长按
const MAX_PIXELS = 16e6; // iOS 上 canvas 大约 1670 万像素封顶，再大就缩小
const LIFT = 1.03; // 浮起来时放大一点
const EDGE = 16; // 浮起的图片离屏幕边缘、离按钮的距离
const ACTIONS_H = 44; // 按钮的高度

const isApple = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/** 在 root 里长按 selector 的图片时让它浮起来，下面是操作按钮。 */
export function enableImageSave(root, selector = '.reader-body img') {
  let timer = 0;
  let start = null;
  let touchedAt = 0;
  let held = false;
  const cancel = () => { clearTimeout(timer); timer = 0; start = null; };

  root.addEventListener('pointerdown', (e) => {
    held = false;
    if (e.pointerType !== 'touch' || !e.isPrimary) return;
    const img = e.target.closest?.(selector);
    if (!img || !img.currentSrc && !img.src) return;
    touchedAt = Date.now();
    start = { x: e.clientX, y: e.clientY };
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      start = null;
      held = true;
      open(img);
    }, HOLD_MS);
  });
  root.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
  });
  root.addEventListener('pointerup', cancel);
  root.addEventListener('pointercancel', cancel); // 开始滚动时浏览器会发 pointercancel
  // 安卓长按会弹系统菜单：触摸长按的换成我们的面板；鼠标右键照旧
  root.addEventListener('contextmenu', (e) => {
    if (e.target.closest?.(selector) && (e.pointerType === 'touch' || Date.now() - touchedAt < 2000)) e.preventDefault();
  });
  // 图片外面包着链接时，长按松手不要再打开链接
  root.addEventListener('click', (e) => {
    if (!held) return;
    held = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
}

/** 刘海和底部横条占的地方：env(safe-area-inset-*) 在 JS 里读不到，借一个看不见的元素量一下。 */
function safeArea() {
  const probe = h('div', { class: 'lift-probe' });
  document.body.append(probe);
  const s = getComputedStyle(probe);
  const out = { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 };
  probe.remove();
  return out;
}

/** 浮起来的图片放在哪：尽量就在原位；下面放不下按钮就往上挪；太高的竖图缩小到放得下。 */
function placement(r) {
  const vw = document.documentElement.clientWidth;
  const safe = safeArea();
  const grow = (LIFT - 1) / 2; // 放大后每边多出来的比例
  const minTop = safe.top + EDGE;
  const maxBottom = window.innerHeight - safe.bottom - EDGE - ACTIONS_H - EDGE; // 图片（放大后）的底边最多到这里
  let { left, width: w, height: hgt } = r;
  const room = (maxBottom - minTop) / LIFT;
  if (hgt > room) {
    w *= room / hgt;
    hgt = room;
    left = (vw - w) / 2;
  }
  const top = Math.min(Math.max(r.top, minTop + hgt * grow), maxBottom - hgt * (1 + grow));
  return { left, top, w, hgt, grow };
}

function open(img) {
  const src = img.currentSrc || img.src;
  const r = img.getBoundingClientRect();
  const box = placement(r);
  let file = null;
  let failed = false;
  let pressed = false; // 打开以后在上面按下过：长按松手那一下不算点按
  let closing = false;

  const lifted = h('img', { class: 'lift-image', src, alt: img.alt || '', referrerpolicy: 'no-referrer' });
  const saveBtn = h('button', { type: 'button', class: 'lift-pill', disabled: true, onclick: (e) => act(e, save) },
    icon('download'), isApple() ? '存储到相册' : '存储图片');
  const openBtn = h('button', { type: 'button', class: 'lift-pill', onclick: (e) => act(e, () => openOriginal(src)) },
    icon('external-link'), '打开原图');
  const actions = h('div', { class: 'lift-actions' }, saveBtn, openBtn);
  const dlg = h('dialog', { class: 'lift', 'aria-label': '图片' }, h('div', { class: 'lift-scrim' }), lifted, actions);

  // 从原来的位置和大小出发，放大一点停在目标位置（变换以左上角为原点）
  Object.assign(lifted.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.w}px`, height: `${box.hgt}px` });
  lifted.style.setProperty('--from', `translate(${r.left - box.left}px, ${r.top - box.top}px) scale(${r.width / box.w})`);
  lifted.style.setProperty('--to', `translate(${-box.w * box.grow}px, ${-box.hgt * box.grow}px) scale(${LIFT})`);
  actions.style.top = `${box.top + box.hgt * (1 + box.grow) + EDGE}px`;

  dlg.addEventListener('pointerdown', () => { pressed = true; });
  dlg.addEventListener('click', (e) => { if (pressed && !actions.contains(e.target)) close(); }); // 点别处收回
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dlg.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false }); // 浮起时后面的页面不跟着滚
  window.addEventListener('resize', close, { once: true });
  document.body.append(dlg);
  dlg.showModal();
  void dlg.offsetWidth; // 先按起点画一帧，再过渡到浮起的样子
  dlg.classList.add('is-open');

  imageFile(src).then((f) => { file = f; }, () => { failed = true; }).finally(() => { saveBtn.disabled = false; });

  function act(e, fn) {
    if (e.detail !== 0 && !pressed) return; // detail 为 0 是键盘触发的
    fn();
    close();
  }

  function close() {
    if (closing) return;
    closing = true;
    window.removeEventListener('resize', close);
    dlg.classList.remove('is-open');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove();
    };
    lifted.addEventListener('transitionend', finish, { once: true });
    setTimeout(finish, 400); // 减少动效时没有过渡
  }

  // 要在点按的同一个事件里调用分享，iOS 才认是用户操作，所以图片在浮起来的时候就开始准备
  function save() {
    if (failed || !file) {
      openOriginal(src);
      toast('这张图片的网站不允许直接存储，已打开原图，长按即可存储', { duration: 4000 });
      return;
    }
    if (isApple() && navigator.canShare?.({ files: [file] })) {
      navigator.share({ files: [file] }).catch((e) => {
        if (e?.name !== 'AbortError') download(file);
      });
      return;
    }
    download(file);
    toast('图片已下载');
  }
}

function openOriginal(src) {
  window.open(src, '_blank', 'noopener,noreferrer');
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a'); // h() 会把 blob: 地址当成不安全的改掉
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 按跨域方式重新载入图片，画到 canvas 上转成文件：不透明的存 JPEG，带透明的存 PNG。 */
export function imageFile(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onerror = () => reject(new Error('图片载入失败'));
    img.onload = () => {
      try {
        const w0 = img.naturalWidth;
        const h0 = img.naturalHeight;
        if (!w0 || !h0) throw new Error('图片没有尺寸');
        const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (w0 * h0)));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w0 * scale));
        canvas.height = Math.max(1, Math.round(h0 * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const type = opaque(img) ? 'image/jpeg' : 'image/png';
        canvas.toBlob((blob) => {
          if (blob) resolve(new File([blob], fileName(src, type), { type }));
          else reject(new Error('图片转换失败'));
        }, type, 0.92);
      } catch (e) {
        reject(e); // 对方不允许跨域时 canvas 被污染，读不出来
      }
    };
    img.src = src;
  });
}

/** 缩成 32×32 看一眼有没有透明的地方，不用把整张大图的像素都读出来。 */
function opaque(img) {
  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, 32, 32);
  const { data } = ctx.getImageData(0, 0, 32, 32);
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return false;
  return true;
}

function fileName(src, type) {
  let base = '';
  try {
    base = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
  } catch { /* 用默认名 */ }
  base = base.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[^\w一-鿿-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${base || 'image'}.${type === 'image/png' ? 'png' : 'jpg'}`;
}
