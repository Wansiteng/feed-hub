/* 路由导航：页面之间跳转用这里，避免页面模块反过来依赖入口模块。 */
export const nav = { previous: null, leaving: null };

const SEQ_KEY = 'feedhub.sequence';

/** 阅读顺序：从哪一页点开的文章，那一页上的文章依次是哪些（阅读器的「下一篇」用）。刷新页面后还在。 */
export function setSequence(list) {
  try { sessionStorage.setItem(SEQ_KEY, JSON.stringify(list)); } catch { /* 隐私模式等：没有「下一篇」 */ }
}

export function nextInSequence(id) {
  let list = [];
  try { list = JSON.parse(sessionStorage.getItem(SEQ_KEY) || '[]'); } catch { /* ignore */ }
  const i = Array.isArray(list) ? list.findIndex((x) => x.id === id) : -1;
  return i >= 0 ? list[i + 1] || null : null;
}

export function navigate(hash) {
  nav.leaving?.(); // 记下当前页的滚动位置，后退回来时恢复
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}

/** 请求退出登录，由应用外壳处理（有未保存的更改时会先确认）。 */
export function requestLogout() {
  window.dispatchEvent(new Event('feedhub:logout'));
}
