/* 暂停 / 恢复服务的界面（store.js 的 pauseService / resumeService，config/service.json）。
 * 「我的」和「设置」最上面是一张卡片：运行中 / 已暂停，一个按钮切换。暂停时其他页面顶上有一条提示，可以直接恢复。 */
import { h, icon, mark, toast, confirmDialog, fmtTime, timeAgo, nodes } from '../assets/ui.js';
import { S, servicePaused, pauseService, resumeService } from './store.js';
import { explain, LOCAL } from './api.js';

async function pause(anchor) {
  const ok = await confirmDialog({
    title: '暂停服务？',
    message: '暂停后不再抓取订阅源、不推送通知、不调用 DeepSeek，GitHub 上的运行也会停下。已经发布的简报和订阅照常能看，随时可以恢复。',
    confirmLabel: '暂停',
    danger: true,
    anchor,
  });
  if (!ok) return;
  try {
    const { disabled, cancelled } = await pauseService();
    toast(LOCAL || disabled
      ? (cancelled ? `已暂停，停下了 ${cancelled} 次正在进行的运行` : '已暂停')
      : '已暂停。GitHub 上的定时任务还会启动，但一启动就停');
  } catch (e) {
    toast(`没能暂停：${explain(e)}`, { tone: 'danger' });
  }
}

async function resume() {
  try {
    const { ran } = await resumeService();
    toast(ran ? '已恢复，正在运行一次' : '已恢复，下次定时运行时开始');
  } catch (e) {
    toast(`没能恢复：${explain(e)}`, { tone: 'danger' });
  }
}

/** 「我的」「设置」里的卡片。返回 { el, draw }，服务状态变了时调 draw。 */
export function serviceCard() {
  const el = h('section', { class: 'service-card', 'aria-live': 'polite' });

  function draw() {
    const paused = servicePaused();
    const busy = S.serviceBusy;
    const sv = S.service || {};
    const lastRun = S.runs?.[0]?.started_at;
    const notes = paused
      ? [`${sv.paused_at ? `${fmtTime(sv.paused_at)} 起` : '已暂停'} · 不抓取、不推送、不调用模型`]
      : [lastRun ? `每小时自动运行 · 上次 ${timeAgo(lastRun)}` : '每小时自动运行'];
    if (paused && !LOCAL && !sv.workflow_disabled) {
      notes.push('GitHub 上的定时任务还会按时启动，一启动就停。给 token 加上 Actions 读写权限，暂停时连它也停掉。');
    }
    if (!paused && !LOCAL && S.workflowState === 'disabled_manually') {
      notes.push('GitHub 上的工作流已停用（可能已经切到本机运行），这里不会再有新的运行。');
    }
    const button = h('button', {
      type: 'button',
      class: `btn ${paused ? 'btn-primary' : 'btn-secondary'} btn-sm`,
      disabled: busy || S.service == null,
      onclick: (e) => (paused ? resume() : pause(e.currentTarget)),
    }, ...(busy ? [mark({ breathe: true, small: true }), paused ? '正在恢复' : '正在暂停']
      : [icon(paused ? 'play' : 'pause'), paused ? '恢复' : '暂停']));
    el.classList.toggle('is-paused', paused);
    // 网格：状态和按钮一行，说明在下面（手机上占满整行，电脑上按钮在右边居中）
    el.replaceChildren(...nodes(
      h('p', { class: 'service-status' }, h('span', { class: 'service-dot', 'aria-hidden': 'true' }),
        S.service == null ? '正在读取…' : paused ? '服务已暂停' : '服务运行中'),
      button,
      notes.map((t, i) => h('p', { class: i ? 'service-note is-extra' : 'service-note' }, t)),
      S.serviceError ? h('p', { class: 'service-note is-error' }, `读不到服务状态：${S.serviceError}`) : null));
  }

  draw();
  return { el, draw };
}

/** 暂停时其他页面顶上的一条提示（「我的」「设置」和文章里不显示）。没暂停时返回 null。 */
export function pausedBanner() {
  if (!servicePaused()) return null;
  return h('div', { class: 'service-banner', role: 'status' },
    icon('pause'),
    h('span', { class: 'service-banner-text' }, h('strong', {}, '服务已暂停'), h('span', {}, '不抓取、不推送、不调用模型')),
    h('button', { type: 'button', class: 'btn btn-ghost btn-sm', disabled: S.serviceBusy, onclick: resume },
      S.serviceBusy ? '正在恢复' : '恢复'));
}
