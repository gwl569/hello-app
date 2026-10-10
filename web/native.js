/* 只有在原生壳（Capacitor 打包的 iOS/Android App）里才会生效。
   普通浏览器 / PWA 打开时，这段代码会直接返回，不影响网页版。 */
(function () {
  var Cap = window.Capacitor;
  if (!Cap || typeof Cap.isNativePlatform !== "function" || !Cap.isNativePlatform()) return;

  var LN = Cap.Plugins && Cap.Plugins.LocalNotifications;
  if (!LN) return;                       // 没装 @capacitor/local-notifications 就跳过

  var KEY = "hello:dailyReminder";
  var ID = 1001;
  var enabled = false;
  try { enabled = localStorage.getItem(KEY) === "1"; } catch (e) {}

  // 文案复用网页里的多语言包（window.HELLO 由 index.html 暴露）
  function S(key, fallback) {
    var app = window.HELLO;
    if (app && typeof app.strings === "function") {
      var v = app.strings()[key];
      if (v) return v;
    }
    return fallback;
  }

  function morningGreeting() {
    var app = window.HELLO;
    var h = new Date().getHours();
    if (app && typeof app.greetingForHour === "function") {
      var greet = app.greetingForHour(h);
      var name = S("name", "");
      var join = S("join", "");
      return greet + (name ? join + name : "");
    }
    if (h < 5) return "夜深了，早些休息 🌙";
    if (h < 9) return "早上好，新的一天开始啦 🌅";
    if (h < 12) return "上午好，今天想做点什么？☀️";
    if (h < 14) return "中午好，记得吃午饭 🍜";
    if (h < 18) return "下午好，喝口水再继续 🌤️";
    if (h < 22) return "晚上好，今天也辛苦啦 🌆";
    return "夜深了，早点睡 🌙";
  }

  function scheduleDaily() {
    return LN.requestPermissions().then(function (perm) {
      if (perm.display !== "granted") throw new Error("permission-denied");
      return LN.cancel({ notifications: [{ id: ID }] }).catch(function () {}).then(function () {
        return LN.schedule({
          notifications: [{
            id: ID,
            title: "Hello",
            body: morningGreeting(),
            schedule: { on: { hour: 8, minute: 0 }, repeats: true },
            sound: null
          }]
        });
      });
    });
  }

  function cancelDaily() {
    return LN.cancel({ notifications: [{ id: ID }] });
  }

  var foot = document.querySelector(".card.todo .todo-foot") || document.querySelector(".todo-foot");
  if (!foot) return;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ghost";

  function paint() {
    btn.textContent = enabled ? S("remindOff", "关闭每日提醒") : S("remindOn", "开启每日提醒");
    btn.title = S("remindTip", "每天 8:00 用一句问候提醒你");
  }

  btn.addEventListener("click", function () {
    btn.disabled = true;
    var action = enabled ? cancelDaily() : scheduleDaily();
    action.then(function () {
      enabled = !enabled;
      try { localStorage.setItem(KEY, enabled ? "1" : "0"); } catch (e) {}
    }).catch(function () {
      alert(S("notifyFail", "没能设置成功，请在系统设置里允许 Hello 发送通知。"));
    }).then(function () {
      btn.disabled = false;
      paint();
    });
  });

  paint();
  foot.appendChild(btn);

  // 网页里切换语言后，按钮文字也跟着变
  var sel = document.getElementById("langSelect");
  if (sel) sel.addEventListener("change", function () { setTimeout(paint, 0); });

  // 之前开过提醒的话，每次打开时校准一下（换手机/重装也能恢复）
  if (enabled) {
    scheduleDaily().catch(function () {});
  }
})();
