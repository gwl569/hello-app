// 离线缓存：第一次打开后，断网也能用（问候页 + 待办都是本地的）
const CACHE = "hello-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./i18n.js",
  "./remind-i18n.js",
  "./reminders.js",
  "./native.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    // 用 allSettled：个别文件拉取失败也不至于让整个 SW 安装失败
    caches.open(CACHE)
      .then(cache => Promise.allSettled(ASSETS.map(a => cache.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;

  // 页面本身用「网络优先」：改版后刷新就能看到新版本；断网时回落到缓存
  // 所有请求都网络优先、缓存兜底：避免改了代码用户还拿到旧版
  const isPage = true;

  if (isPage) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match(event.request).then(hit => hit || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(hit => {
      if (hit) return hit;
      return fetch(event.request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("./index.html"));
    })
  );
});

/* ---------- 定时提醒：接收云端推送 ---------- */
const PUSHLOG = "hello-pushlog";

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || "提醒";
  const body = data.body || "";

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body,
      tag: data.tag || "hello-push",
      renotify: true,
      data: { reminderId: data.reminderId || "", title, body }
    }),
    // 页面开着的话，直接让它弹出全屏闹钟
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      list.forEach(c => c.postMessage({ type: "alarm", reminderId: data.reminderId || "", title, body }));
    }),
    // 记下最近一次收到的推送，页面里可以自查是否真的送达
    caches.open(PUSHLOG)
      .then(c => c.put("/last", new Response(
        JSON.stringify(Object.assign({}, data, { receivedAt: Date.now() })),
        { headers: { "Content-Type": "application/json" } }
      )))
      .catch(() => {})
  ]));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const info = event.notification.data || {};
  const id = info.reminderId || "";
  const qs = "alarm=" + encodeURIComponent(id) +
    "&title=" + encodeURIComponent(info.title || "") +
    "&body=" + encodeURIComponent(info.body || "");
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of list) {
      if (c.url.indexOf(self.registration.scope) === 0) {
        c.postMessage({ type: "alarm", reminderId: id, title: info.title, body: info.body });
        return c.focus();
      }
    }
    return clients.openWindow("./?" + qs);
  })());
});

self.addEventListener("message", event => {
  const msg = event.data || {};
  const port = event.ports && event.ports[0];
  if (msg.type === "lastPush" && port) {
    caches.open(PUSHLOG)
      .then(c => c.match("/last"))
      .then(r => (r ? r.json() : null))
      .then(v => port.postMessage(v))
      .catch(() => port.postMessage(null));
  }
});
