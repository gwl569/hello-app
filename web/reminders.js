/* Hello · 定时提醒
   滚轮选时间 → 云端排期 → 到点系统通知 + 页面内全屏闹钟（三种合成铃声）
   依赖：i18n.js / remind-i18n.js / index.html 里的页面骨架 */
(function () {
  "use strict";

  const API = "https://hello-reminders.gwl13453461902.workers.dev";
  const UID_KEY = "hello:uid";
  const BUILD = "v8 · 2026-10-11";
  const REM_KEY = "hello:reminders";
  const CELL = 36;
  const MAX_SNOOZE = 3;
  const RE_RING_MS = 2 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const pad = (n) => String(n).padStart(2, "0");

  /* ---------------- 语言 ---------------- */
  const I18N = window.HELLO_REMIND_I18N || {};
  function dict() {
    const lang = (window.HELLO && window.HELLO.lang && window.HELLO.lang()) || "zh-CN";
    return Object.assign({}, I18N.en || {}, I18N[lang] || {});
  }
  function rt(key, vars) {
    const v = dict()[key];
    if (v === undefined) return key;
    if (typeof v !== "string") return v;
    if (!vars) return v;
    return Object.keys(vars).reduce((s, k) => s.replace("{" + k + "}", vars[k]), v);
  }
  const locale = () =>
    (window.HELLO && window.HELLO.strings && (window.HELLO.strings().dateLocale || window.HELLO.strings().htmlLang)) ||
    "zh-CN";

  /* ---------------- 本地存储 ---------------- */
  const store = (() => {
    try {
      localStorage.setItem("__p", "1");
      localStorage.removeItem("__p");
      return localStorage;
    } catch (e) {
      const m = {};
      return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: (k) => { delete m[k]; } };
    }
  })();

  function makeUid() {
    let v = null;
    try { v = store.getItem(UID_KEY); } catch (e) {}
    if (!v) {
      v = "u" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      try { store.setItem(UID_KEY, v); } catch (e) {}
    }
    return v;
  }
  const UID = makeUid();

  let reminders = [];
  try { reminders = JSON.parse(store.getItem(REM_KEY) || "[]") || []; } catch (e) { reminders = []; }
  if (!Array.isArray(reminders)) reminders = [];
  const saveLocal = () => {
    try { store.setItem(REM_KEY, JSON.stringify(reminders)); } catch (e) {}
    // 通知原生壳（如果有）重新排本地通知
    try { window.dispatchEvent(new CustomEvent("hello:reminders-changed")); } catch (e) {}
  };

  /* ---------------- 重复规则（与 Worker 端同一套逻辑） ---------------- */
  function stepOnce(t, rule) {
    const d = new Date(t);
    switch (rule.type) {
      case "daily":
        d.setDate(d.getDate() + 1);
        return d.getTime();
      case "weekdays":
        do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
        return d.getTime();
      case "weekly": {
        const days = Array.isArray(rule.days) && rule.days.length ? rule.days : [new Date(t).getDay()];
        for (let k = 1; k <= 7; k++) {
          const n = new Date(t);
          n.setDate(n.getDate() + k);
          if (days.indexOf(n.getDay()) > -1) return n.getTime();
        }
        return t + 7 * 86400000;
      }
      case "monthly": {
        const base = new Date(t);
        const day = rule.monthDay || base.getDate();
        const n = new Date(base.getFullYear(), base.getMonth() + 1, 1);
        const dim = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
        n.setDate(Math.min(day, dim));
        n.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
        return n.getTime();
      }
      case "interval":
        return t + Math.max(1, Number(rule.intervalHours) || 1) * 3600000;
      default:
        return null;
    }
  }

  function nextAt(rem, from) {
    const start = Number(rem.at);
    if (!start) return null;
    const rule = rem.repeat && rem.repeat.type ? rem.repeat : { type: "once" };
    if (rule.type === "once") {
      if (rem.firedAt && rem.firedAt >= start) return null;
      return start >= from ? start : null;
    }
    let t = start;
    let n = 1;
    for (let i = 0; i < 20000 && t !== null; i++) {
      if (rule.until && t > Number(rule.until)) return null;
      if (rule.count && n > Number(rule.count)) return null;
      if (t >= from) return t;
      t = stepOnce(t, rule);
      n += 1;
    }
    return null;
  }

  /* ---------------- 时间显示 ---------------- */
  function fmtDateTime(ms) {
    try {
      return new Intl.DateTimeFormat(locale(), {
        month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit"
      }).format(new Date(ms));
    } catch (e) {
      const d = new Date(ms);
      return d.getMonth() + 1 + "月" + d.getDate() + "日 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    }
  }
  function fmtCountdown(ms) {
    let s = Math.max(0, Math.round((ms - Date.now()) / 1000));
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    if (d > 0) return d + "d " + pad(h) + ":" + pad(m);
    if (h > 0) return pad(h) + ":" + pad(m) + ":" + pad(s);
    return pad(m) + ":" + pad(s);
  }

  /* ---------------- 铃声（Web Audio 合成，三种风格） ---------------- */
  let audioCtx = null;
  let ringTimer = null;
  let ringPlaying = false;

  function audio() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === "suspended" && audioCtx.resume) audioCtx.resume();
    return audioCtx;
  }

  /* iOS 必须由用户手势"解锁"音频，否则闹钟响的时候没声音 */
  const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";
  let unlocked = false;
  let silentAudio = null;
  function unlockAudio() {
    if (unlocked) return;
    unlocked = true;
    try {
      const ac = audio();
      if (ac && ac.state === "suspended" && ac.resume) ac.resume();
    } catch (e) {}
    try {
      if (!silentAudio) silentAudio = new Audio(SILENT_WAV);
      silentAudio.volume = 0.001;
      const p = silentAudio.play();
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }

  function tone(ac, { freq, at, dur, level, type, bend }) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type || "sine";
    osc.frequency.setValueAtTime(freq, at);
    if (bend) osc.frequency.exponentialRampToValueAtTime(bend, at + dur);
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(at);
    osc.stop(at + dur + 0.05);
  }

  // 每个铃声一段 2 秒左右的动机，循环播放
  const RING = {
    chime(t0, ac) {
      tone(ac, { freq: 1318.5, at: t0, dur: 0.5, level: 0.22 });
      tone(ac, { freq: 1568.0, at: t0 + 0.18, dur: 0.5, level: 0.2 });
      tone(ac, { freq: 2093.0, at: t0 + 0.36, dur: 0.7, level: 0.16 });
    },
    soft(t0, ac) {
      [523.25, 659.25, 783.99, 659.25].forEach((f, i) => {
        tone(ac, { freq: f, at: t0 + i * 0.28, dur: 0.85, level: 0.16, type: "triangle" });
      });
    },
    classic(t0, ac) {
      for (let i = 0; i < 8; i++) {
        const at = t0 + i * 0.11;
        tone(ac, { freq: 880, at, dur: 0.07, level: 0.2, type: "square" });
        tone(ac, { freq: 1174.7, at: at + 0.055, dur: 0.06, level: 0.16, type: "square" });
      }
      for (let i = 0; i < 4; i++) tone(ac, { freq: 1760, at: t0 + 1.0 + i * 0.12, dur: 0.08, level: 0.14, type: "square" });
    }
  };

  function playMotif(style) {
    const ac = audio();
    if (!ac) return;
    const fn = RING[style] || RING.chime;
    fn(ac.currentTime + 0.03, ac);
  }

  function startRing(style) {
    stopRing();
    ringPlaying = true;
    const ov = $("alarm");
    if (ov) ov.classList.add("ringing");
    const loop = () => {
      if (!ringPlaying) return;
      unlockAudioSilently();
      playMotif(style);
      if (navigator.vibrate) { try { navigator.vibrate([260, 140, 260]); } catch (e) {} }
      ringTimer = setTimeout(loop, 2000);
    };
    loop();
  }
  // 每次响铃前顺便再 resume 一次音频上下文（有些机型会自己挂起）
  function unlockAudioSilently() {
    try {
      const ac = audio();
      if (ac && ac.state === "suspended" && ac.resume) ac.resume();
    } catch (e) {}
  }
  function stopRing() {
    ringPlaying = false;
    if (ringTimer) { clearTimeout(ringTimer); ringTimer = null; }
    const ov = $("alarm");
    if (ov) ov.classList.remove("ringing");
  }

  /* ---------------- 云端同步 + 推送订阅 ---------------- */
  let swReg = null;
  let subState = "unknown";    // unknown | ok | none —— 云提醒是否已连上
  let cloudNext = 0;           // 云端排的下一次提醒时间
  let vapidKey = null;         // 提前取好的推送公钥，点击时就不用等网络
  async function ensureSW() {
    if (swReg && swReg.active) return swReg;
    if (!("serviceWorker" in navigator)) { diag("✗ 这个环境没有 Service Worker"); return null; }
    try {
      let reg = await Promise.race([
        navigator.serviceWorker.getRegistration(),
        new Promise((r) => setTimeout(() => r(null), 4000))
      ]);
      if (!reg) {
        diag("没有已注册的 Service Worker，正在注册…");
        reg = await Promise.race([
          navigator.serviceWorker.register("./sw.js"),
          new Promise((r) => setTimeout(() => r(null), 6000))
        ]);
      }
      if (!reg) { diag("✗ Service Worker 注册调用超时：这台设备上它起不来，推送无法使用"); return null; }
      for (let i = 0; i < 20 && !reg.active; i++) {
        await new Promise((r) => setTimeout(r, 300));
        reg = (await navigator.serviceWorker.getRegistration()) || reg;
        if (i === 3 && !reg.active) diag("SW 状态：" + (reg.installing ? "安装中…" : reg.waiting ? "等待激活…" : "尚未激活"));
      }
      if (!reg.active) {
        diag("✗ Service Worker 没能激活，所以无法创建推送订阅。");
        diag("→ 请下拉刷新一次页面再点按钮；若仍失败，把这段发我。");
        return null;
      }
      swReg = reg;
      diag("Service Worker 已激活 ✓");
      return reg;
    } catch (e) {
      diag("SW 注册失败：" + ((e && e.name) || "") + " " + ((e && e.message) || e));
      return null;
    }
  }

  async function loadVapidKey() {
    if (vapidKey) return vapidKey;
    try {
      const res = await fetch(API + "/api/vapid");
      const data = await res.json();
      if (data && data.key) vapidKey = data.key;
    } catch (e) { diag("取推送公钥失败：" + ((e && e.message) || e)); }
    return vapidKey;
  }

  async function getSubscription(create) {
    const reg = await ensureSW();
    if (!reg || !reg.pushManager) { diag("✗ 这个环境没有 PushManager（iOS 需 16.4+ 且从主屏打开）"); return null; }
    let sub = await Promise.race([
      reg.pushManager.getSubscription().catch(() => null),
      new Promise((r) => setTimeout(() => r("timeout"), 4000))
    ]);
    if (sub === "timeout") { diag("读取已有订阅超时，直接尝试新建…"); sub = null; }
    if (sub || !create) return sub;
    try {
      const key = await loadVapidKey();
      if (!key) { diag("✗ 没拿到推送公钥"); return null; }
      diag("正在创建订阅（需要在这次点击内完成）…");
      sub = await Promise.race([
        reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8(key)
        }),
        new Promise((r) => setTimeout(() => r("timeout"), 15000))
      ]);
      if (sub === "timeout") {
        diag("✗ 创建订阅超时。请再点一次「开启通知权限」（这一次不需要再授权，会直接订阅）");
        return null;
      }
    } catch (e) {
      diag("订阅异常：" + ((e && e.name) || "") + " " + ((e && e.message) || e));
      sub = null;
    }
    return sub;
  }

  function urlBase64ToUint8(base64) {
    const s = String(base64).replace(/-/g, "+").replace(/_/g, "/");
    const pad2 = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
    const bin = atob(s + pad2);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 问一下 Service Worker：最近一次真的收到推送了吗 */
  function lastPush() {
    return new Promise((resolve) => {
      if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return resolve(null);
      const ch = new MessageChannel();
      const timer = setTimeout(() => resolve(null), 1500);
      ch.port1.onmessage = (e) => { clearTimeout(timer); resolve(e.data || null); };
      try { navigator.serviceWorker.controller.postMessage({ type: "lastPush" }, [ch.port2]); }
      catch (e) { clearTimeout(timer); resolve(null); }
    });
  }

  /** 打开某条提醒的闹钟界面（通知点击进来时用） */
  function openAlarmFor(id, fallbackTitle, fallbackBody) {
    const rem = reminders.find((r) => r.id === id);
    const shown = rem || {
      id: id || "push",
      title: fallbackTitle || rt("alarmNow"),
      note: fallbackBody || "",
      ring: extra.ring || "chime",
      ringAgain: true
    };
    alarm = { rem: shown, at: Date.now(), snoozeLeft: rem ? MAX_SNOOZE : 0, lastRing: Date.now(), snoozeAt: 0 };
    showAlarm(shown);
    startRing(shown.ring || "chime");
    return !!rem;
  }

  let syncTimer = null;
  function scheduleSync(delay) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(pushToCloud, delay === undefined ? 500 : delay);
  }

  async function pushToCloud() {
    try {
      const sub = await getSubscription(false);
      const res = await fetch(API + "/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: UID, subscription: sub, reminders })
      });
      const data = await res.json().catch(() => null);
      if (data && data.ok) {
        subState = data.subscribed ? "ok" : "none";
        cloudNext = data.next || 0;
      }
      paintHint();
    } catch (e) {}
  }

  async function enableNotifications() {
    try {
      if (!("Notification" in window)) { toast(rt("pushFail")); return; }
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { toast(rt("notifNeeded")); return; }
      await getSubscription(true);
      await pushToCloud();
      toast(rt("pushOk"));
      refresh();
    } catch (e) {}
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
      (window.navigator.standalone === true);
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  /* ---------------- 滚轮 ---------------- */
  let editingId = null;
  let wheel = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };
  let repeat = { type: "once", days: [], monthDay: 1, intervalHours: 2, until: 0, count: 0, endMode: "never", endCount: 3, endDate: "" };
  let extra = { seconds: false, advance: 0, ringAgain: true, ring: "chime" };

  const cols = () => Array.from(document.querySelectorAll("#wheel .col"));
  const years = () => { const y = new Date().getFullYear(); return [y, y + 1, y + 2, y + 3, y + 4]; };
  const daysIn = (y, mo) => new Date(y, mo + 1, 0).getDate();

  function fillCol(col, values, selected, fmt) {
    col.innerHTML = "";
    values.forEach((v) => {
      const div = document.createElement("div");
      div.className = "cell";
      div.dataset.v = String(v);
      div.textContent = fmt ? fmt(v) : pad(v);
      col.appendChild(div);
    });
    setCol(col, selected);
  }
  function setCol(col, value) {
    const cells = Array.from(col.children);
    let idx = cells.findIndex((c) => Number(c.dataset.v) === Number(value));
    if (idx < 0) idx = 0;
    col.scrollTop = idx * CELL;
    mark(col);
  }
  function readCol(col) {
    const cells = Array.from(col.children);
    if (!cells.length) return 0;
    const idx = Math.min(Math.max(Math.round(col.scrollTop / CELL), 0), cells.length - 1);
    return Number(cells[idx].dataset.v);
  }
  function mark(col) {
    const idx = Math.min(Math.max(Math.round(col.scrollTop / CELL), 0), col.children.length - 1);
    Array.from(col.children).forEach((c, i) => c.classList.toggle("on", i === idx));
  }

  function buildWheel() {
    const c = cols();
    fillCol(c[0], years(), wheel.y, (v) => v + "");
    fillCol(c[1], Array.from({ length: 12 }, (_, i) => i + 1), wheel.mo + 1, (v) => pad(v));
    fillCol(c[2], Array.from({ length: daysIn(wheel.y, wheel.mo) }, (_, i) => i + 1), wheel.d, (v) => pad(v));
    fillCol(c[3], Array.from({ length: 24 }, (_, i) => i), wheel.h, (v) => pad(v));
    fillCol(c[4], Array.from({ length: 60 }, (_, i) => i), wheel.mi, (v) => pad(v));
    fillCol(c[5], Array.from({ length: 60 }, (_, i) => i), wheel.s, (v) => pad(v));
    c[5].classList.toggle("off", !extra.seconds);
    paintWhen();
  }

  function syncDaysColumn() {
    const c = cols();
    const dim = daysIn(wheel.y, wheel.mo);
    if (c[2].children.length !== dim) {
      const keep = Math.min(wheel.d, dim);
      fillCol(c[2], Array.from({ length: dim }, (_, i) => i + 1), keep, (v) => pad(v));
      wheel.d = keep;
    }
  }

  function readWheel() {
    const c = cols();
    wheel.y = readCol(c[0]);
    wheel.mo = readCol(c[1]) - 1;
    wheel.d = readCol(c[2]);
    wheel.h = readCol(c[3]);
    wheel.mi = readCol(c[4]);
    wheel.s = extra.seconds ? readCol(c[5]) : 0;
  }

  function wheelTime() {
    return new Date(wheel.y, wheel.mo, wheel.d, wheel.h, wheel.mi, wheel.s, 0).getTime();
  }

  function setWheelFromTime(ms) {
    const d = new Date(ms);
    wheel = { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() };
    buildWheel();
  }

  function paintWhen() {
    const el = $("whenPreview");
    if (!el) return;
    el.textContent = rt("nextRing") + " " + fmtDateTime(wheelTime());
  }

  /* ---------------- 预设 ---------------- */
  const PRESETS = [
    ["preset5", 5 * 60000],
    ["preset30", 30 * 60000],
    ["preset60", 60 * 60000],
    ["presetTonight", null],
    ["presetMorning", null]
  ];
  function applyPreset(key) {
    const now = new Date();
    if (key === "preset5" || key === "preset30" || key === "preset60") {
      const mins = key === "preset5" ? 5 : key === "preset30" ? 30 : 60;
      setWheelFromTime(now.getTime() + mins * 60000);
    } else if (key === "presetTonight") {
      const t = new Date(now);
      t.setHours(22, 0, 0, 0);
      if (t.getTime() <= now.getTime()) t.setDate(t.getDate() + 1);
      setWheelFromTime(t.getTime());
    } else {
      const t = new Date(now);
      t.setDate(t.getDate() + 1);
      t.setHours(8, 0, 0, 0);
      setWheelFromTime(t.getTime());
    }
  }

  /* ---------------- 表单渲染 ---------------- */
  function renderPresets() {
    const box = $("presets");
    box.innerHTML = "";
    PRESETS.forEach(([key]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.dataset.preset = key;
      b.textContent = rt(key);
      b.addEventListener("click", () => applyPreset(key));
      box.appendChild(b);
    });
  }

  const REPEATS = ["repOnce", "repDaily", "repWeekdays", "repWeekly", "repMonthly", "repInterval"];
  const REPEAT_TYPES = ["once", "daily", "weekdays", "weekly", "monthly", "interval"];

  function renderRepeat() {
    const box = $("repeatChips");
    box.innerHTML = "";
    REPEATS.forEach((key, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (repeat.type === REPEAT_TYPES[i] ? " on" : "");
      b.textContent = rt(key);
      b.addEventListener("click", () => {
        repeat.type = REPEAT_TYPES[i];
        // 切到「每周」时默认选中当前选中的那个星期，避免一个都没选
        if (repeat.type === "weekly" && !repeat.days.length) {
          repeat.days = [new Date(wheelTime()).getDay()];
        }
        renderRepeat();
        renderExtra();
      });
      box.appendChild(b);
    });
  }

  function renderExtra() {
    const box = $("repeatExtra");
    box.innerHTML = "";
    if (repeat.type === "weekly") {
      const wrap = document.createElement("div");
      wrap.className = "week-chips";
      const names = rt("weekShort");
      for (let i = 0; i < 7; i++) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "chip" + (repeat.days.indexOf(i) > -1 ? " on" : "");
        b.textContent = Array.isArray(names) ? names[i] : String(i);
        b.addEventListener("click", () => {
          const idx = repeat.days.indexOf(i);
          if (idx > -1) repeat.days.splice(idx, 1); else repeat.days.push(i);
          renderExtra();
        });
        wrap.appendChild(b);
      }
      box.appendChild(wrap);
    }
    if (repeat.type === "monthly") {
      const row = document.createElement("div");
      row.className = "inline-row";
      row.innerHTML = '<span class="lab">' + rt("monthDay") + '</span>';
      const sel = document.createElement("select");
      for (let i = 1; i <= 31; i++) {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = i + "";
        sel.appendChild(o);
      }
      sel.value = String(repeat.monthDay);
      sel.addEventListener("change", () => { repeat.monthDay = Number(sel.value); });
      row.appendChild(sel);
      box.appendChild(row);
    }
    if (repeat.type === "interval") {
      const row = document.createElement("div");
      row.className = "inline-row";
      const sel = document.createElement("select");
      [1, 2, 3, 4, 6, 8, 12].forEach((h) => {
        const o = document.createElement("option");
        o.value = String(h);
        o.textContent = rt("everyNH", { n: h });
        sel.appendChild(o);
      });
      sel.value = String(repeat.intervalHours);
      sel.addEventListener("change", () => { repeat.intervalHours = Number(sel.value); });
      row.appendChild(sel);
      box.appendChild(row);
    }
    if (repeat.type !== "once") {
      const row = document.createElement("div");
      row.className = "inline-row";
      const sel = document.createElement("select");
      [["endNever", "never"], ["endCount", "count"], ["endDate", "date"]].forEach(([k, v]) => {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = rt("endLabel") + " · " + rt(k);
        sel.appendChild(o);
      });
      sel.value = repeat.endMode || "never";
      sel.addEventListener("change", () => { repeat.endMode = sel.value; renderExtra(); });
      row.appendChild(sel);
      if (repeat.endMode === "count") {
        const inp = document.createElement("input");
        inp.type = "number";
        inp.min = "1";
        inp.max = "99";
        inp.value = String(repeat.endCount || 3);
        inp.className = "rem-input";
        inp.style.width = "90px";
        inp.style.height = "38px";
        inp.addEventListener("input", () => { repeat.endCount = Number(inp.value) || 1; });
        row.appendChild(inp);
      }
      if (repeat.endMode === "date") {
        const inp = document.createElement("input");
        inp.type = "date";
        inp.value = repeat.endDate || "";
        inp.className = "rem-input";
        inp.style.width = "170px";
        inp.style.height = "38px";
        inp.addEventListener("change", () => { repeat.endDate = inp.value; });
        row.appendChild(inp);
      }
      box.appendChild(row);
    }
  }

  function switchRow(labelKey, id, checked, onToggle) {
    const row = document.createElement("div");
    row.className = "sw-row";
    const lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = rt(labelKey);
    const sw = document.createElement("label");
    sw.className = "sw";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = !!checked;
    const knob = document.createElement("i");
    sw.appendChild(input);
    sw.appendChild(knob);
    row.appendChild(lab);
    row.appendChild(sw);
    if (onToggle) input.addEventListener("change", () => onToggle(input.checked));
    return { row, input };
  }

  function renderSwitches() {
    const box = $("switches");
    box.innerHTML = "";

    const sec = switchRow("optSeconds", "swSeconds", extra.seconds, (v) => {
      extra.seconds = v;
      cols()[5].classList.toggle("off", !v);
      paintWhen();
    });
    box.appendChild(sec.row);

    const adv = switchRow("optAdvance", "swAdvance", extra.advance > 0, (v) => {
      extra.advance = v ? 5 : 0;
      renderSwitches();
    });
    box.appendChild(adv.row);
    if (extra.advance > 0) {
      const row = document.createElement("div");
      row.className = "inline-row";
      const sel = document.createElement("select");
      [[1, "1"], [5, "5"], [10, "10"], [15, "15"], [30, "30"], [60, "1h"], [1440, "1d"]].forEach(([m]) => {
        const o = document.createElement("option");
        o.value = String(m);
        o.textContent = rt("advanceBefore") + " " + (m >= 1440 ? m / 1440 + "d" : m >= 60 ? m / 60 + "h" : m + "min");
        sel.appendChild(o);
      });
      sel.value = String(extra.advance);
      sel.addEventListener("change", () => { extra.advance = Number(sel.value); });
      row.appendChild(sel);
      box.appendChild(row);
    }

    const again = switchRow("optRingAgain", "swAgain", extra.ringAgain, (v) => { extra.ringAgain = v; });
    box.appendChild(again.row);

    const ringRow = document.createElement("div");
    ringRow.className = "sw-row";
    const lab = document.createElement("span");
    lab.className = "lab";
    lab.textContent = rt("ringLabel");
    const sel = document.createElement("select");
    [["ringChime", "chime"], ["ringSoft", "soft"], ["ringClassic", "classic"]].forEach(([k, v]) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = rt(k);
      sel.appendChild(o);
    });
    sel.value = extra.ring;
    sel.style.cssText = "height:38px;padding:0 12px;font:inherit;font-size:13.5px;font-weight:700;color:var(--text);background:rgba(255,255,255,.08);border:1px solid var(--line);border-radius:999px;outline:none";
    sel.addEventListener("change", () => { extra.ring = sel.value; playMotif(extra.ring); });
    const pv = document.createElement("button");
    pv.type = "button";
    pv.className = "chip";
    pv.textContent = rt("previewRing");
    pv.addEventListener("click", () => playMotif(extra.ring));
    ringRow.appendChild(lab);
    ringRow.appendChild(sel);
    ringRow.appendChild(pv);
    box.appendChild(ringRow);
  }

  /* ---------------- 表单操作 ---------------- */
  function resetForm() {
    editingId = null;
    const t = new Date(Date.now() + 5 * 60000);
    t.setSeconds(0, 0);
    wheel = { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: 0 };
    extra = { seconds: false, advance: 0, ringAgain: true, ring: extra.ring || "chime" };
    repeat = { type: "once", days: [], monthDay: 1, intervalHours: 2, until: 0, count: 0, endMode: "never", endCount: 3, endDate: "" };
    $("remTitleInput").value = "";
    $("remNoteInput").value = "";
    buildWheel();
    renderRepeat();
    renderExtra();
    renderSwitches();
    $("remFormTitle").textContent = rt("newTitle");
    $("saveRem").textContent = rt("save");
    $("resetRem").textContent = rt("resetBtn");
    $("deleteRem").textContent = rt("deleteBtn");
    $("deleteRem").hidden = true;
  }

  function loadForm(rem) {
    editingId = rem.id;
    setWheelFromTime(rem.at);
    repeat = Object.assign({ type: "once", days: [], monthDay: 1, intervalHours: 2, endMode: "never", endCount: 3, endDate: "" }, rem.repeat || {});
    extra = { seconds: !!rem.seconds, advance: rem.advance || 0, ringAgain: rem.ringAgain !== false, ring: rem.ring || "chime" };
    $("remTitleInput").value = rem.title || "";
    $("remNoteInput").value = rem.note || "";
    renderRepeat();
    renderExtra();
    renderSwitches();
    $("remFormTitle").textContent = rt("editTitle");
    $("saveRem").textContent = rt("update");
    $("resetRem").textContent = rt("resetBtn");
    $("deleteRem").textContent = rt("deleteBtn");
    $("deleteRem").hidden = false;
    goPage(1);
  }

  function collectRule() {
    const rule = { type: repeat.type };
    if (repeat.type === "weekly") rule.days = repeat.days.slice().sort();
    if (repeat.type === "monthly") rule.monthDay = repeat.monthDay;
    if (repeat.type === "interval") rule.intervalHours = repeat.intervalHours;
    if (repeat.type !== "once") {
      if (repeat.endMode === "count") rule.count = Math.max(1, repeat.endCount || 1);
      if (repeat.endMode === "date" && repeat.endDate) rule.until = new Date(repeat.endDate + "T23:59:59").getTime();
    }
    return rule;
  }

  function saveReminder() {
    readWheel();
    const title = ($("remTitleInput").value || "").trim();
    if (!title) { $("remTitleInput").focus(); toast(rt("titleLabel")); return; }
    const at = wheelTime();
    if (repeat.type === "once" && at <= Date.now()) { toast(rt("timeLabel")); return; }

    const data = {
      title,
      note: ($("remNoteInput").value || "").trim(),
      at,
      seconds: !!extra.seconds,
      advance: extra.advance || 0,
      ringAgain: extra.ringAgain !== false,
      ring: extra.ring,
      repeat: collectRule(),
      enabled: true,
      firedAt: 0,
      lastFired: 0
    };

    if (editingId) {
      const idx = reminders.findIndex((r) => r.id === editingId);
      if (idx > -1) reminders[idx] = Object.assign({}, reminders[idx], data);
    } else {
      data.id = "r" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      reminders.push(data);
    }
    saveLocal();
    scheduleSync(0);
    resetForm();
    renderList();
    toast(rt("savedToast"));
    goPage(2);
  }

  function deleteReminder() {
    if (!editingId) return;
    reminders = reminders.filter((r) => r.id !== editingId);
    saveLocal();
    scheduleSync(0);
    resetForm();
    renderList();
    toast(rt("deletedToast"));
    goPage(2);
  }

  /* ---------------- 列表 ---------------- */
  function repeatLabel(rem) {
    const r = rem.repeat || { type: "once" };
    const key = { once: "repOnce", daily: "repDaily", weekdays: "repWeekdays", weekly: "repWeekly", monthly: "repMonthly", interval: "repInterval" }[r.type] || "repOnce";
    let label = rt(key);
    if (r.type === "weekly" && Array.isArray(r.days) && r.days.length) {
      const names = rt("weekShort");
      label += " " + r.days.map((d) => (Array.isArray(names) ? names[d] : d)).join("");
    }
    if (r.type === "interval") label = rt("everyNH", { n: r.intervalHours || 1 });
    if (r.type === "monthly") label += " " + (r.monthDay || 1);
    return label;
  }

  function renderList() {
    const box = $("remList");
    if (!box) return;
    box.innerHTML = "";
    const sorted = reminders.slice().sort((a, b) => (nextAt(a, Date.now()) || Infinity) - (nextAt(b, Date.now()) || Infinity));

    sorted.forEach((rem) => {
      const item = document.createElement("div");
      item.className = "rem-item" + (rem.enabled === false ? " off" : "");

      const meta = document.createElement("div");
      meta.className = "meta";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = rem.title;
      const s = document.createElement("div");
      s.className = "s";
      const nxt = nextAt(rem, Date.now());
      s.innerHTML = nxt
        ? '<b>' + fmtDateTime(nxt) + "</b> · " + fmtCountdown(nxt)
        : "—";
      const tl = document.createElement("div");
      tl.className = "tagline";
      tl.textContent = repeatLabel(rem) + (rem.advance ? " · " + rt("advanceBefore") + " " + rem.advance + "min" : "");

      meta.appendChild(t);
      meta.appendChild(s);
      meta.appendChild(tl);
      meta.addEventListener("click", () => loadForm(rem));

      const sw = document.createElement("label");
      sw.className = "sw";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = rem.enabled !== false;
      const knob = document.createElement("i");
      sw.appendChild(input);
      sw.appendChild(knob);
      input.addEventListener("change", () => {
        rem.enabled = input.checked;
        saveLocal();
        scheduleSync(0);
        item.classList.toggle("off", !input.checked);
      });

      item.appendChild(meta);
      item.appendChild(sw);
      box.appendChild(item);
    });

    $("remEmpty").textContent = reminders.length ? "" : rt("noReminders");
  }

  /* ---------------- 到点提醒 ---------------- */
  let alarm = { rem: null, at: 0, snoozeLeft: MAX_SNOOZE, lastRing: 0, snoozeAt: 0 };

  function fire(rem, at) {
    rem.lastFired = at;
    if ((rem.repeat && rem.repeat.type) === "once" || !rem.repeat) {
      rem.firedAt = at;
      rem.enabled = false;
    } else {
      rem.firedAt = at;
    }
    saveLocal();
    scheduleSync(0);
    renderList();

    alarm = { rem, at, snoozeLeft: MAX_SNOOZE, lastRing: Date.now(), snoozeAt: 0 };
    showAlarm(rem);
    startRing(rem.ring || "chime");
    notifyLocal(rem);
  }

  function notifyLocal(rem) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return;         // 页面在前台就用全屏闹钟，不重复弹通知
    ensureSW().then((reg) => {
      if (!reg) return;
      reg.showNotification(rem.title || "提醒", {
        body: rem.note || "",
        tag: "hello-" + rem.id,
        renotify: true,
        data: { reminderId: rem.id }
      });
    });
  }

  function showAlarm(rem) {
    $("alarmTitleH").textContent = rem.title || "";
    $("alarmNote").textContent = rem.note || "";
    $("alarm").hidden = false;
    tickAlarmTime();
  }

  function tickAlarmTime() {
    const d = new Date();
    $("alarmTime").textContent = pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }

  function closeAlarm() {
    $("alarm").hidden = true;
    stopRing();
    alarm.rem = null;
    renderList();
  }

  function tick() {
    const now = Date.now();

    // 全屏闹钟开着的时候：更新大字时间，必要时再响一次
    if (!$("alarm").hidden) {
      tickAlarmTime();
      if (alarm.rem && alarm.rem.ringAgain !== false && now - alarm.lastRing > RE_RING_MS) {
        alarm.lastRing = now;
        startRing(alarm.rem.ring || "chime");
      }
    }

    // 贪睡到点
    if (alarm.rem && alarm.snoozeAt && now >= alarm.snoozeAt) {
      alarm.snoozeAt = 0;
      alarm.lastRing = now;
      showAlarm(alarm.rem);
      startRing(alarm.rem.ring || "chime");
      notifyLocal(alarm.rem);
    }

    // 到点判断
    reminders.forEach((rem) => {
      if (rem.enabled === false) return;
      const at = nextAt(rem, now - 1000);
      if (!at) return;
      if (at <= now + 500 && rem.lastFired !== at) {
        if (now - at < 5 * 60 * 1000) fire(rem, at);
        else rem.lastFired = at;
      }
      // 提前提醒
      if (rem.advance) {
        const pre = at - rem.advance * 60000;
        if (pre <= now && now < at && rem.lastPre !== pre) {
          rem.lastPre = pre;
          saveLocal();
          if (document.hidden) {
            ensureSW().then((reg) => reg && reg.showNotification(rem.title, {
              body: (rem.note ? rem.note + " · " : "") + fmtDateTime(at),
              tag: "hello-pre-" + rem.id,
              data: { reminderId: rem.id }
            }));
          }
        }
      }
    });

    if (!document.hidden) renderListTimers();
  }

  let lastTimerPaint = 0;
  function renderListTimers() {
    const now = Date.now();
    if (now - lastTimerPaint < 1000) return;
    lastTimerPaint = now;
    if (currentPage !== 2) return;
    renderList();
  }

  /* ---------------- 提示条 ---------------- */
  let diagLines = [];
  let lastDiag = "";
  function diag(msg) {
    const stamp = new Date().toLocaleTimeString();
    diagLines.push(stamp + "  " + msg);
    if (diagLines.length > 8) diagLines.shift();
    lastDiag = msg;
    const el = $("diag");
    if (el) { el.hidden = false; el.textContent = diagLines.join("\n"); }
    paintHint();
  }

  function diagExtras() {
    return [
      "UA: " + navigator.userAgent,
      "standalone: " + isStandalone(),
      "Notification: " + (("Notification" in window) ? Notification.permission : "不支持"),
      "serviceWorker: " + (("serviceWorker" in navigator) ? "有" : "无"),
      "PushManager: " + (("PushManager" in window) ? "有" : "无"),
      "uid: " + UID,
      "build: " + BUILD,
      "url: " + location.href
    ].join("\n");
  }

  async function copyDiag() {
    const text = diagLines.join("\n") + "\n---\n" + diagExtras();
    try {
      await navigator.clipboard.writeText(text);
      toast("已复制自检信息 ✓");
      return;
    } catch (e) {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      toast("已复制自检信息 ✓");
    } catch (e) { toast("复制失败，请手动截图"); }
  }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add("on"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("on");
      setTimeout(() => { el.hidden = true; }, 240);
    }, 2200);
  }

  /* ---------------- 分页 ---------------- */
  let currentPage = 0;
  function goPage(i) {
    const pager = $("pager");
    if (!pager) return;
    currentPage = i;
    const left = pager.clientWidth * i;
    pager.scrollTo({ left, behavior: "smooth" });
    paintTabs(i);
    // 兜底：个别环境（或动画被中断）下平滑滚动可能不生效，稍后强制对齐
    setTimeout(() => {
      if (Math.abs(pager.scrollLeft - left) > 8) {
        const prev = pager.style.scrollBehavior;
        pager.style.scrollBehavior = "auto";     // 关掉平滑才能立即跳转
        pager.scrollLeft = left;
        pager.style.scrollBehavior = prev;
      }
    }, 420);
  }
  function paintTabs(i) {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", Number(t.dataset.page) === i));
    document.querySelectorAll("#dots i").forEach((d, k) => d.classList.toggle("on", k === i));
  }

  function bindPager() {
    const pager = $("pager");
    if (!pager) return;
    let raf = null;
    pager.addEventListener("scroll", () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const i = Math.round(pager.scrollLeft / pager.clientWidth);
        if (i !== currentPage) { currentPage = i; paintTabs(i); }
      });
    }, { passive: true });

    document.querySelectorAll(".tab").forEach((t) =>
      t.addEventListener("click", () => goPage(Number(t.dataset.page)))
    );
    document.querySelectorAll("#dots i").forEach((d, i) =>
      d.addEventListener("click", () => goPage(i))
    );
    window.addEventListener("resize", () => {
      pager.scrollTo({ left: pager.clientWidth * currentPage, behavior: "auto" });
    });
    document.addEventListener("keydown", (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowRight" && currentPage < 2) goPage(currentPage + 1);
      if (e.key === "ArrowLeft" && currentPage > 0) goPage(currentPage - 1);
    });
  }

  /* ---------------- 刷新（语言变化 / 权限变化） ---------------- */
  function refresh() {
    $("remFormTitle").textContent = editingId ? rt("editTitle") : rt("newTitle");
    $("saveRem").textContent = editingId ? rt("update") : rt("save");
    $("resetRem").textContent = rt("resetBtn");
    $("deleteRem").textContent = rt("deleteBtn");
    $("listTitleH").textContent = rt("listTitle");
    $("testPush").textContent = rt("testPush");
    $("alarmLabel").textContent = rt("alarmNow");
    $("alarmStop").textContent = rt("stopAlarm");
    $("alarmSnooze").textContent = rt("snooze");
    document.querySelectorAll("[data-remind]").forEach((el) => {
      el.textContent = rt(el.getAttribute("data-remind"));
    });
    document.querySelectorAll(".tab").forEach((t, i) => {
      t.textContent = rt(["tabToday", "tabNew", "tabList"][i]);
    });
    // 滚轮单位
    const units = rt("units");
    const u = $("wheelUnits");
    if (u && Array.isArray(units)) {
      u.innerHTML = "";
      units.forEach((s) => {
        const sp = document.createElement("span");
        sp.textContent = s;
        u.appendChild(sp);
      });
    }
    const titleIn = $("remTitleInput");
    if (titleIn) titleIn.placeholder = rt("titlePh");
    const noteIn = $("remNoteInput");
    if (noteIn) noteIn.placeholder = rt("notePh");

    renderPresets();
    renderRepeat();
    renderExtra();
    renderSwitches();
    renderList();
    paintWhen();
    paintHint();
  }

  function paintHint() {
    const el = $("notifHint");
    if (!el) return;
    const perm = ("Notification" in window) ? Notification.permission : "unsupported";
    const iosBrowser = isIOS() && !isStandalone();
    const lines = [
      rt("permLabel") + "：" + (perm === "granted" ? rt("okWord") + " ✓"
        : perm === "denied" ? rt("deniedMsg")
        : perm === "unsupported" ? "这个浏览器不支持（iOS 需 16.4+）"
        : rt("offWord")),
      rt("cloudLabel") + "：" + (subState === "ok"
        ? rt("okWord") + (cloudNext ? " ✓ " + fmtDateTime(cloudNext) : " ✓")
        : rt("offWord"))
    ];
    if (lastDiag) lines.push("最近一步：" + lastDiag);
    if (iosBrowser) {
      const steps = rt("steps");
      if (Array.isArray(steps)) steps.forEach((s) => lines.push(s));
      else lines.push(rt("installHint"));
    }
    const needAction = perm !== "granted" || subState !== "ok";
    el.hidden = false;
    el.innerHTML = lines.map((s) => "<div>" + s + "</div>").join("") +
      (needAction
        ? '<div style="margin-top:6px">' + rt("notifNeeded") + "</div>" +
          '<button class="primary" id="notifBtn" type="button">' + rt("enableNotif") + "</button>" +
          ' <button class="ghost" id="copyDiagBtn" type="button">复制自检信息</button>' +
          ' <button class="ghost" id="forceUpdateBtn" type="button">强制更新</button>'
        : "");
  }

  /* ---------------- 自检：逐步显示卡在哪一步 ---------------- */
  async function forceUpdate() {
    diag("正在清理缓存并重载…");
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
    } catch (e) { diag("清理时出错：" + ((e && e.message) || e)); }
    location.reload();
  }

  async function runTestPush() {
    diagLines = [];
    diag("开始自检");
    try {
      diag("主屏应用：" + (isStandalone() ? "是 ✓" : (isIOS() ? "否 ✗ —— iPhone 必须从主屏图标打开才能收通知" : "否")));
      if (!("Notification" in window)) { diag("✗ 这个浏览器不支持通知 API"); return; }
      diag("通知权限：" + Notification.permission);
      if (Notification.permission !== "granted") {
        diag("正在请求权限…");
        const p = await Promise.race([
          Notification.requestPermission(),
          new Promise((r) => setTimeout(() => r("timeout"), 5000))
        ]);
        if (p === "timeout") {
          diag("✗ iOS 没有弹出授权框。最可能的原因：这个页面不是从主屏图标打开的。");
          diag("→ 请用 Safari「添加到主屏幕」，再从图标打开本应用重试。");
          return;
        }
        diag("请求权限结果：" + p);
        if (p !== "granted") {
          diag(isIOS()
            ? "✗ 已被系统拒绝。去 iOS 设置 → 通知 → Hello 打开；若没有这一项，就删掉主屏图标重新添加一次。"
            : "✗ 权限没给，收不到通知。");
          return;
        }
      }
      diag("① 检查/创建推送订阅…");
      const sub = await getSubscription(true);
      if (!sub) { diag("✗ 订阅失败：可能没添加到主屏，或浏览器不支持 Push"); return; }
      diag("✓ 订阅 OK：" + String(sub.endpoint).slice(0, 34) + "…");

      diag("② 上传给云端…");
      const sr = await fetch(API + "/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: UID, subscription: sub, reminders })
      });
      const sd = await sr.json().catch(() => null);
      diag("云端同步：" + JSON.stringify(sd));
      if (sd && sd.ok) { subState = sd.subscribed ? "ok" : "none"; cloudNext = sd.next || 0; paintHint(); }

      diag("③ 让服务器发一条测试推送…");
      const tr = await fetch(API + "/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: UID })
      });
      const td = await tr.json().catch(() => null);
      diag("发送返回：" + JSON.stringify(td));
      if (!td || !td.ok) { diag("✗ 服务器拒绝了这条推送"); toast(rt("pushFail")); return; }
      toast(rt("pushOk"));

      diag("④ 等 4 秒，看浏览器有没有真的收到…");
      setTimeout(async () => {
        const last = await lastPush();
        if (last && Date.now() - last.receivedAt < 90000) {
          diag("✓ 浏览器已收到并成功解码：" + (last.title || ""));
          toast(rt("pushDelivered") + " ✓");
        } else {
          diag("…浏览器说没收到（通知可能仍会由系统显示，或推送还在路上）");
          toast(rt("pushSentOnly"));
        }
      }, 4000);
    } catch (e) {
      diag("✗ 异常：" + ((e && e.message) || e));
      toast(rt("pushFail"));
    }
  }

  /* ---------------- 启动 ---------------- */
  function init() {
    if (!$("pager")) return;
    const t = new Date(Date.now() + 5 * 60000);
    t.setSeconds(0, 0);
    wheel = { y: t.getFullYear(), mo: t.getMonth(), d: t.getDate(), h: t.getHours(), mi: t.getMinutes(), s: 0 };

    const prev = document.createElement("p");
    prev.className = "hint";
    prev.id = "whenPreview";
    $("wheelUnits").insertAdjacentElement("afterend", prev);

    buildWheel();
    renderRepeat();
    renderExtra();
    renderSwitches();
    bindPager();

    cols().forEach((col) => {
      let timer = null;
      col.addEventListener("scroll", () => {
        mark(col);
        clearTimeout(timer);
        timer = setTimeout(() => {
          readWheel();
          syncDaysColumn();
          paintWhen();
        }, 120);
      }, { passive: true });
    });

    $("saveRem").addEventListener("click", saveReminder);
    $("resetRem").addEventListener("click", resetForm);
    $("deleteRem").addEventListener("click", deleteReminder);
    $("alarmStop").addEventListener("click", closeAlarm);
    $("alarmSnooze").addEventListener("click", () => {
      if (!alarm.rem) return;
      if (alarm.snoozeLeft <= 0) { closeAlarm(); return; }
      alarm.snoozeLeft -= 1;
      alarm.snoozeAt = Date.now() + 5 * 60000;
      $("alarm").hidden = true;
      stopRing();
      toast(rt("snoozeLeft", { n: alarm.snoozeLeft }));
    });
    // 用事件委托绑定，避免按钮被重新渲染后丢事件
    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#testPush") || t.closest("#notifBtn")) {
        e.preventDefault();
        runTestPush();
      } else if (t.closest("#copyDiagBtn")) {
        e.preventDefault();
        copyDiag();
      } else if (t.closest("#forceUpdateBtn")) {
        e.preventDefault();
        forceUpdate();
      }
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", (e) => {
        const d = e.data || {};
        if (d.type === "alarm") openAlarmFor(d.reminderId, d.title, d.body);
      });
    }
    const params = new URLSearchParams(location.search);
    const wanted = params.get("alarm");
    if (wanted) {
      setTimeout(() => openAlarmFor(wanted, params.get("title") || "", params.get("body") || ""), 300);
    }

    // 首次用户手势时解锁音频（iOS 不这样做的话，到点没有铃声）
    document.addEventListener("touchstart", unlockAudio, { once: true, passive: true });
    document.addEventListener("click", unlockAudio, { once: true });
    document.addEventListener("keydown", unlockAudio, { once: true });

    // 关掉页面/切到后台时，用 sendBeacon 再同步一次，确保云端一定拿到排期
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) return;
      try {
        const payload = JSON.stringify({ uid: UID, reminders });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(API + "/api/sync", new Blob([payload], { type: "application/json" }));
        }
      } catch (e) {}
    });

    // 已经允许过通知：直接把推送订阅补上并同步给云端
    if ("Notification" in window && Notification.permission === "granted") {
      getSubscription(true).then((sub) => {
        subState = sub ? "ok" : "none";
        paintHint();
        if (sub) pushToCloud();
      });
    }

    // 提前把推送公钥和 Service Worker 准备好，点击时才是"同一个手势内"完成订阅
    loadVapidKey();
    ensureSW().catch(() => {});

    setInterval(tick, 1000);
    setTimeout(pushToCloud, 1200);
    renderList();
  }

  async function enableNotificationsIfNeeded() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") { await getSubscription(true); return; }
    await enableNotifications();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { init(); refresh(); });
  } else {
    init();
    refresh();
  }

  window.HelloReminders = { refresh, goPage, fire };
})();
