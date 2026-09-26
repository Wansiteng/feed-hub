/* 运行记录：处理流程每次运行的统计、GitHub Actions 的运行状态、抓取失败的订阅源。 */
import { h, icon, mark, badge, thinking, toast, fmtTime, timeAgo } from '../../assets/ui.js';
import { S, loadStatus, loadWorkflowRuns, loadItems, failingFeeds } from '../store.js';
import { dispatchWorkflow, listWorkflowRuns, explain } from '../api.js';
import { pageHead, emptyState, fmtDuration } from '../common.js';

const EVENTS = { schedule: '定时', workflow_dispatch: '手动', push: '配置更新' };

export function RunsPage() {
  const statsBox = h('div');
  const actionsBox = h('div');
  const failBox = h('div');
  const cron = '每小时第 23 分钟自动运行';
  const runBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: runNow }, icon('play'), '立即运行');
  const el = h('div', { class: 'page' },
    pageHead('运行记录', cron, [
      h('button', { type: 'button', class: 'btn btn-secondary', onclick: refreshAll }, icon('refresh-cw'), '刷新'),
      runBtn,
    ]),
    failBox, statsBox, actionsBox);
  let alive = true;

  /** 触发一次运行，跟着 GitHub Actions 的状态刷新列表，跑完读取新结果。 */
  async function runNow() {
    runBtn.disabled = true;
    runBtn.replaceChildren(mark({ breathe: true, small: true }), '运行中');
    const since = Date.now() - 60 * 1000;
    try {
      await dispatchWorkflow();
    } catch (e) {
      toast(`触发失败：${explain(e)}`, { tone: 'danger' });
      resetButton();
      return;
    }
    toast('已触发运行，GitHub 通常要十几秒分配运行器');
    const deadline = Date.now() + 20 * 60 * 1000;
    let run = null;
    while (alive && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      loadWorkflowRuns();
      let runs;
      try { runs = await listWorkflowRuns(5); } catch { continue; }
      run = runs.find((r) => r.event === 'workflow_dispatch' && new Date(r.created_at).getTime() >= since) || null;
      if (run?.status === 'completed') break;
    }
    resetButton();
    if (!alive) return;
    if (!run || run.status !== 'completed') { toast('还没跑完，稍后刷新看看'); return; }
    if (run.conclusion !== 'success') { toast(`运行失败（${run.conclusion}），点下面的记录看日志`, { tone: 'danger' }); return; }
    await Promise.all([loadStatus(), loadItems({ force: true })]);
    const s = S.runs?.[0];
    toast(s ? `运行完成：推送 ${s.passed} 篇，过滤 ${s.filtered} 篇` : '运行完成');
  }

  function resetButton() {
    runBtn.disabled = false;
    runBtn.replaceChildren(icon('play'), '立即运行');
  }

  function refreshAll() {
    statsBox.replaceChildren(h('div', { class: 'loading' }, thinking('正在刷新…')));
    loadStatus();
    loadWorkflowRuns();
  }

  function drawStats() {
    const runs = S.runs;
    const title = h('h2', { class: 'section-title' }, '处理记录', h('span', { class: 'section-count' }, runs ? `最近 ${runs.length} 次` : ''));
    if (!runs) { statsBox.replaceChildren(h('section', { class: 'section' }, title, h('div', { class: 'loading' }, thinking('正在读取运行记录…')))); return; }
    if (!runs.length) {
      statsBox.replaceChildren(h('section', { class: 'section' }, title,
        emptyState('还没有运行记录', '在仓库的 Settings → Secrets 里设置 DEEPSEEK_API_KEY 和 PUBLISH_TOKEN，然后点「立即运行」。')));
      return;
    }
    const cols = ['时间', '耗时', '新条目', '推送', '重复', '过滤', '只有摘要', '翻译', '排队', '失败源', '模型用量'];
    const usage = (u) => (u ? `${u.requests} 次 · ${Math.round((u.prompt_tokens + u.completion_tokens) / 1000)}k tokens` : '—');
    const rows = runs.slice(0, 30).map((r) => h('tr', {},
      h('td', { title: fmtTime(r.started_at, { withYear: true }) }, fmtTime(r.started_at)),
      h('td', {}, fmtDuration(r.duration_seconds)),
      h('td', {}, r.new_items),
      h('td', {}, r.passed),
      h('td', { title: '同一件事已经推送过，并入了那篇' }, r.duplicates ?? '—'),
      h('td', {}, r.filtered),
      h('td', { title: '通过筛选、但原网页抓不到全文的文章' }, r.summary_only ?? '—'),
      h('td', {}, r.translated),
      h('td', {}, r.pending_translation || 0),
      h('td', {}, r.feeds_failed ? h('span', { class: 'text-danger' }, r.feeds_failed) : 0),
      h('td', { class: 'muted' }, usage(r.usage))));
    const table = h('table', { class: 'data-table' },
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
      h('tbody', {}, rows));
    statsBox.replaceChildren(h('section', { class: 'section' }, title, h('div', { class: 'table-wrap' }, table)));
  }

  function drawActions() {
    const title = h('h2', { class: 'section-title' }, 'GitHub Actions');
    if (!S.wfRuns) { actionsBox.replaceChildren(h('section', { class: 'section' }, title, h('div', { class: 'loading' }, thinking('正在读取…')))); return; }
    if (S.wfError) { actionsBox.replaceChildren(h('section', { class: 'section' }, title, h('p', { class: 'hint' }, `读取失败：${S.wfError}`))); return; }
    if (!S.wfRuns.length) { actionsBox.replaceChildren(h('section', { class: 'section' }, title, h('p', { class: 'hint' }, '还没有运行过。'))); return; }
    actionsBox.replaceChildren(h('section', { class: 'section' }, title,
      h('div', { class: 'run-list' }, S.wfRuns.map((r) => {
        let state;
        if (r.status !== 'completed') state = badge(r.status === 'in_progress' ? '运行中' : '排队中', 'warning');
        else if (r.conclusion === 'success') state = badge('成功', 'success');
        else if (r.conclusion === 'skipped' || r.conclusion === 'cancelled') state = badge(r.conclusion === 'skipped' ? '跳过' : '已取消');
        else state = badge('失败', 'danger');
        const seconds = (new Date(r.updated_at) - new Date(r.run_started_at || r.created_at)) / 1000;
        return h('a', { class: 'run-row', href: r.html_url, target: '_blank', rel: 'noopener noreferrer' },
          state,
          h('span', { class: 'run-text' }, `${EVENTS[r.event] || r.event} · ${fmtTime(r.created_at)}`),
          h('span', { class: 'run-sub' }, r.status === 'completed' ? fmtDuration(seconds) : timeAgo(r.created_at)),
          icon('external-link'));
      }))));
  }

  function drawFailing() {
    const bad = failingFeeds();
    if (!bad.length) { failBox.replaceChildren(); return; }
    failBox.replaceChildren(h('section', { class: 'section callout' },
      h('h2', { class: 'section-title' }, icon('circle-alert'), `${bad.length} 个订阅源抓取失败`),
      h('ul', { class: 'fail-list' }, bad.map((f) => {
        const st = S.feedStatus[f.id];
        return h('li', {}, h('strong', {}, f.name), h('span', { class: 'muted' }, ` · ${st.error} · 连续 ${st.error_count || 1} 次`));
      })),
      h('a', { class: 'btn btn-secondary btn-sm', href: '#/feeds?filter=failing' }, '去订阅源页处理')));
  }

  drawStats();
  drawActions();
  drawFailing();
  loadWorkflowRuns();
  if (!S.runs) loadStatus();

  return {
    el,
    destroy() { alive = false; },
    refresh(what) {
      if (what.has('status')) { drawStats(); drawFailing(); }
      if (what.has('runs')) drawActions();
      if (what.has('config')) drawFailing();
    },
  };
}
