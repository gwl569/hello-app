/* 原生 App（Capacitor）里的定时提醒：直接用系统本地通知。
   优点：精确到秒、锁屏显示+响铃、完全离线、响到你手动处理，不依赖服务器和 Service Worker。*/
(function () {
  "use strict";
  var Cap = window.Capacitor;
  if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return;
  var LN = Cap.Plugins && Cap.Plugins.LocalNotifications;
  if (!LN) { console.warn("未安装 @capacitor/local-notifications，原生提醒不可用"); return; }

  var REM_KEY = "hello:reminders";
  var BASE_ID = 90000;

  function load() {
    try { return JSON.parse(localStorage.getItem(REM_KEY) || "[]") || []; } catch (e) { return []; }
  }

  function stepOnce(t, rule) {
    var d = new Date(t);
    switch (rule.type) {
      case "daily": d.setDate(d.getDate() + 1); return d.getTime();
      case "weekdays":
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
        return d.getTime();
      case "weekly": {
        var days = (rule.days && rule.days.length) ? rule.days : [new Date(t).getDay()];
        for (var k = 1; k <= 7; k++) {
          var n = new Date(t); n.setDate(n.getDate() + k);
          if (days.indexOf(n.getDay()) > -1) return n.getTime();
        }
        return t + 7 * 86400000;
      }
      case "monthly": {
        var b = new Date(t);
        var day = rule.monthDay || b.getDate();
        var m = new Date(b.getFullYear(), b.getMonth() + 1, 1);
        var dim = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
        m.setDate(Math.min(day, dim));
        m.setHours(b.getHours(), b.getMinutes(), b.getSeconds(), 0);
        return m.getTime();
      }
      case "interval": return t + Math.max(1, Number(rule.intervalHours) || 1) * 3600000;
      default: return null;
    }
  }

  function nextAt(rem, from) {
    var start = Number(rem.at);
    if (!start) return null;
    var rule = (rem.repeat && rem.repeat.type) ? rem.repeat : { type: "once" };
    if (rule.type === "once") return start >= from ? start : null;
    var t = start, n = 1;
    for (var i = 0; i < 5000 && t !== null; i++) {
      if (rule.until && t > Number(rule.until)) return null;
      if (rule.count && n > Number(rule.count)) return null;
      if (t >= from) return t;
      t = stepOnce(t, rule);
      n++;
    }
    return null;
  }

  /* 每条提醒排未来 20 次「一次性」本地通知——比用 repeating 更稳，复杂重复规则也能覆盖 */
  function plan() {
    var out = [];
    var now = Date.now();
    load().forEach(function (rem, idx) {
      if (rem.enabled === false) return;
      var t = nextAt(rem, now - 1000);
      var k = 0;
      while (t && k < 20) {
        out.push({
          id: BASE_ID + idx * 30 + k,
          title: rem.title || "提醒",
          body: rem.note || "",
          schedule: { at: new Date(t), allowWhileIdle: true },
          extra: { reminderId: rem.id }
        });
        k++;
        t = (rem.repeat && rem.repeat.type !== "once") ? nextAt(rem, t + 1000) : null;
      }
    });
    return out;
  }

  var syncing = false;
  async function resync() {
    if (syncing) return;
    syncing = true;
    try {
      var perm = await LN.checkPermissions();
      if (perm.display !== "granted") perm = await LN.requestPermissions();
      if (perm.display !== "granted") { syncing = false; return; }
      var pending = await LN.getPending();
      var ids = (pending.notifications || [])
        .filter(function (n) { return n.id >= BASE_ID; })
        .map(function (n) { return { id: n.id }; });
      if (ids.length) await LN.cancel({ notifications: ids });
      var list = plan();
      if (list.length) await LN.schedule({ notifications: list });
    } catch (e) { console.warn("本地通知同步失败", e); }
    syncing = false;
  }

  window.addEventListener("hello:reminders-changed", function () { resync(); });
  document.addEventListener("visibilitychange", function () { if (!document.hidden) resync(); });
  setTimeout(resync, 1500);
  window.HelloNativeReminders = { resync: resync };
})();
