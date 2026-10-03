/* Feed Hub 的 service worker：只负责推送通知（Web Push），不拦截请求、不缓存页面。
 * 流水线发来的消息是加密的 JSON：{title, body, url, tag}（见 feedhub/webpush.py）。
 * 点通知时打开 Feed Hub（已经开着就切过去），并跳到消息里的地址（这一期简报 / 这篇文章）。 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  // iOS 要求每条推送都显示出来，否则会收回推送权限
  event.waitUntil(self.registration.showNotification(data.title || 'Feed Hub', {
    body: data.body || '',
    tag: data.tag || undefined,
    icon: 'assets/app-icon-192.png',
    data: { url: data.url || self.registration.scope },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '', self.registration.scope);
  const url = target.origin === self.location.origin ? target.href : self.registration.scope;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((w) => w.url.startsWith(self.registration.scope));
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open', url }); // 页面自己切换地址（只差 # 后面的部分，不用重新加载）
      return;
    }
    await self.clients.openWindow(url);
  })());
});
