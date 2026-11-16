'use strict';

/**
 * 注入到 B 站页面（player.bilibili.com / www.bilibili.com）的访客脚本。
 * 通过 <webview> 的 preload 运行，能直接操作页面里的 <video>，
 * 因此全局快捷键可以真正控制 B 站播放器（含其自有 UI 播放时）。
 */

const { ipcRenderer } = require('electron');

/* --------------------------------------------------- 全屏行为改写 */

/**
 * B 站播放器的全屏按钮、双击视频，最终都走 Element.requestFullscreen()。
 * 那样会把 <video> 铺满整个客户端，连我们自己的标题栏和设置按钮一起盖掉
 * —— 用户会「找不到设置」。这里拦下来，改成让整个浮窗窗口全屏：
 * 视频照样放大到满屏，而标题栏、设置抽屉仍然是窗口里的普通 DOM，随时能点。
 */
try {
  // 用户要求：窗口只做 16:9 等比例缩放，不做全屏铺满（之前全屏铺满后
  // 退出会出现底部白框）。因此 B 站的双击视频、全屏按钮一律拦截成 no-op，
  // 不触发窗口 fullscreen。
  Element.prototype.requestFullscreen = function requestFullscreen() {
    return Promise.resolve();
  };
  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;
  Element.prototype.mozRequestFullScreen = Element.prototype.requestFullscreen;

  document.exitFullscreen = function exitFullscreen() {
    return Promise.resolve();
  };
  document.webkitExitFullscreen = document.exitFullscreen;
  document.mozCancelFullScreen = document.exitFullscreen;
} catch {
  /* 改写失败就退回原生行为，不影响播放 */
}

/* 裸方向键做「后退/前进 5 秒」时，B 站播放器自己也会吃 ←/→ 各 seek 5 秒，
   结果我们的全局钩子 + 页面原生处理叠加成 ±10 秒。这里在 capture 阶段把
   裸 ←/→ 吞掉，只留全局钩子那一份，保证按键等于正好 5 秒。
   输入框里打字时不拦（页面自己的输入框要用方向键移动光标）。 */
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  const t = e.target;
  if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName)) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}, true);

/* 双击视频会触发 B 站播放/暂停切换，暂停时底部控制条会浮现成白块。
   用户要求双击无副作用：capture 阶段拦截，仅吃掉点击不做任何切换。 */
document.addEventListener('dblclick', (e) => {
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}, true);

let video = null;
let cleanOn = false;
let cleanStyle = null;

/* ------------------------------------------------------------- 元素发现 */

function visibleArea(v) {
  const r = v.getBoundingClientRect();
  if (r.width < 80 || r.height < 60) return 0;
  const st = getComputedStyle(v);
  if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return 0;
  return r.width * r.height;
}

function pickVideo() {
  const list = Array.from(document.querySelectorAll('video'));
  if (!list.length) return null;
  let best = null;
  let bestArea = 0;
  for (const v of list) {
    const a = visibleArea(v);
    if (a > bestArea) {
      bestArea = a;
      best = v;
    }
  }
  return best || list[0];
}

const EVENTS = [
  'play', 'pause', 'timeupdate', 'durationchange', 'loadedmetadata',
  'ratechange', 'volumechange', 'ended', 'waiting', 'playing',
  'seeking', 'seeked', 'error', 'canplay', 'emptied'
];

function bind(v) {
  if (!v || v === video) return;
  if (video) {
    for (const ev of EVENTS) video.removeEventListener(ev, onEvent, true);
  }
  video = v;
  for (const ev of EVENTS) v.addEventListener(ev, onEvent, true);
  console.log('[跟跑助手] 已接管视频元素', v.currentSrc || v.src || '');
  push(true);
}

function onEvent() {
  push();
}

/* --------------------------------------------------------------- 状态上报 */

/**
 * B 站视频页形如 /video/BV1xx411c7mD/?p=3&autoplay=1。
 * 一 P 播完自动连播下一 P 时，播放器会把 ?p= 改掉（整页导航或 SPA 都可能），
 * 但浮窗的 state.p 只在用户手动 loadVideo 时更新过，下拉框会一直停在旧页码。
 * 所以把页码和视频 id 随每次状态一起带回，让浮窗自己校准。
 */
function partFromUrl(u) {
  const m = /[?&](?:p|page)=(\d+)/.exec(String(u || ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function idFromUrl(u) {
  const m = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : '';
}

function snapshot() {
  const p = partFromUrl(location.href);
  const vid = idFromUrl(location.pathname);
  if (!video || !video.isConnected) return { found: false, p, vid };
  const d = video.duration;
  return {
    found: true,
    p,
    vid,
    playing: !video.paused && !video.ended,
    current: video.currentTime || 0,
    duration: Number.isFinite(d) && d > 0 ? d : 0,
    rate: video.playbackRate || 1,
    muted: video.muted || video.volume === 0,
    volume: video.muted ? 0 : video.volume,
    ready: video.readyState >= 3,
    title: document.title.replace(/\s*[-_]\s*bilibili.*$/i, '').trim()
  };
}

function push(force) {
  try {
    ipcRenderer.sendToHost('state', snapshot());
  } catch {
    /* 页面正在卸载 */
  }
}

/* ---------------------------------------------------------------- 指令 */

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function safePlay() {
  if (!video) return;
  const p = video.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function apply(msg) {
  if (!msg || typeof msg !== 'object') return;

  if (msg.cmd === 'clean') {
    setClean(!!msg.on);
    return;
  }
  if (msg.cmd === 'ping') {
    if (!video) bind(pickVideo());
    push(true);
    return;
  }
  if (!video) {
    bind(pickVideo());
    if (!video) return;
  }

  switch (msg.cmd) {
    case 'toggle':
      if (video.paused || video.ended) safePlay();
      else video.pause();
      break;
    case 'play':
      safePlay();
      break;
    case 'pause':
      video.pause();
      break;
    case 'seek': {
      const t = Number(msg.value) || 0;
      video.currentTime = clamp(t, 0, video.duration || 1e9);
      break;
    }
    case 'seekBy': {
      const t = video.currentTime + (Number(msg.value) || 0);
      video.currentTime = clamp(t, 0, video.duration || 1e9);
      break;
    }
    case 'rate':
      video.playbackRate = clamp(Number(msg.value) || 1, 0.25, 3);
      break;
    case 'mute':
      video.muted = !!msg.value;
      break;
    case 'volume':
      video.volume = clamp(Number(msg.value) || 0, 0, 1);
      video.muted = video.volume === 0;
      break;
    default:
      break;
  }
  push(true);
}

/* ------------------------------------------------- 网页版「纯净模式」样式 */

const CLEAN_CSS = `
  .bili-header, #biliMainHeader, .international-header,
  .right-container, #reco_list, .recommend-list-v1,
  .video-toolbar-container, .video-toolbar-left, .video-toolbar-right,
  #commentapp, .bili-comments, .comment-container,
  .video-sections-container, .bili-video-card, .pop-live-small-mode,
  .fixed-sidenav-storage-component, .ad-report { display: none !important; }
  .left-container { width: 100% !important; max-width: 100% !important; padding: 0 !important; margin: 0 !important; }
  html, body { background: #000 !important; overflow: hidden !important; max-width: 100vw !important; }
  /* 弹幕与字幕：跟跑不需要，且字幕轨道会抢占画面；一并摘掉。
     注意登录后 B 站换了弹幕渲染层类名：旧 .bili-danmaku-x-dm-rotate→
     新 .bili-danmaku-x-dm（容器 .bpx-player-render-dm-wrap），
     把整条渲染容器链一起隐藏最稳（新弹幕滚动进来也不会再显示）。 */
  .bili-danmaku-x-dm-rotate, .bpx-player-danmaku-wrap,
  .bpx-player-render-dm-wrap, .bpx-player-dm-mask-wrap, .bpx-player-row-dm-wrap,
  .bpx-player-subtitle-wrap, .bpx-player-subtitle { display: none !important; }
  /* 全屏/非16:9 窗口下：把播放器整体钉满 webview 可视区，video 用 cover 裁切铺满，
     消除视频 16:9 在非 16:9 容器里的上下/左右黑边；下方 B 站简介区与弹幕工具条一并隐藏 */
  .bpx-player-container {
    position: fixed !important; top: 0 !important; left: 0 !important;
    width: 100vw !important; height: 100vh !important;
    z-index: 9998 !important; background: #000 !important;
  }
  .bpx-player-container video,
  .bpx-player-container .bpx-player-video-wrap video {
    object-fit: cover !important; width: 100% !important; height: 100% !important;
  }
  .video-desc-container, .basic-desc-info, .bpx-player-tooltip-item { display: none !important; }
  /* 顶部标题条（P14/24 视频名那行白色文字条）：小窗口下"白边"来源，永久隐藏 */
  .bpx-player-top-title { display: none !important; }
  /* 播放器控制条：平时隐藏（纯净画面），鼠标移到画面下缘才浮现（保留暂停/进度/音量交互） */
  .bpx-player-control-wrap, .bpx-player-control-wrap > * { opacity: 0 !important; transition: opacity 0.2s ease !important; pointer-events: none !important; }
  .bpx-player-container:hover .bpx-player-control-wrap,
  .bpx-player-container:focus-within .bpx-player-control-wrap { opacity: 1 !important; pointer-events: auto !important; }
  /* 底部弹幕发送区/输入条/高能进度条/弹幕管理：视频下方常年白色横条，永久隐藏 */
  .bpx-player-sending-area, .bpx-player-sending-bar, .bpx-player-video-inputbar,
  .bpx-player-video-inputbar-wrap, .bpx-player-dm-root, .bpx-player-pbp {
    display: none !important;
  }
  /* 内置水印/头像等白色叠加标记：纯画面不要 */
  .bpx-player-video-perch .bpx-player-video-watermark,
  .bpx-player-video-watermark, .bpx-player-ctrl-tooltip,
  .bpx-player-video-danmaku-watermark { display: none !important; }
`;

// 物理摘除的重负载模块：右侧推荐流 / 评论区 / 弹幕楼 / 分P列表 / 下方工具条
// 这些跟跑功能完全用不到。注意 display:none 只是「不画」，JS 对象与 DOM 仍驻留
// 内存；remove() 才真正释放。实测 www 页初始 ~3250 节点，摘除后 ~1850（-43%），
// 视频不受影响（仍 1920×1080 正常解码播放）。
const REMOVE_SELECTORS = [
  '.right-container',           // 右侧推荐流（单个最大头）
  '#reco_list',
  '.recommend-list-v1',
  '#commentapp',                // 评论区
  '.bili-comments',
  '.comment-container',
  '.video-sections-container',  // 分P列表
  '.video-toolbar-container',   // 点赞/收藏/分享工具条
  '.video-toolbar-left',
  '.video-toolbar-right',
  '.fixed-sidenav-storage-component',
  '.ad-report',
  // 弹幕渲染层与字幕轨道（实测 B 站类名，见 setClean 说明）
  // 登录后新弹幕层 .bili-danmaku-x-dm → 容器 .bpx-player-render-dm-wrap/.dm-mask-wrap/.row-dm-wrap
  '.bili-danmaku-x-dm-rotate',
  '.bpx-player-danmaku-wrap',
  '.bpx-player-render-dm-wrap',
  '.bpx-player-dm-mask-wrap',
  '.bpx-player-row-dm-wrap',
  '.bpx-player-subtitle-wrap',
  '.bpx-player-subtitle',
  // 播放器下方的 B 站简介区与弹幕输入/工具条（全屏或非 16:9 窗口会露出来）
  '.video-desc-container',
  '.basic-desc-info',
  '.bpx-player-tooltip-item'
];

let cleanObserver = null;
let removedCount = 0;

function sweepClean() {
  let removed = 0;
  for (const sel of REMOVE_SELECTORS) {
    for (const el of document.querySelectorAll(sel)) {
      removed += 1 + el.querySelectorAll('*').length;
      el.remove();
    }
  }
  if (removed) {
    removedCount += removed;
    console.log(`[跟跑助手] 纯净模式已物理摘除 ${removed} 个节点（累计 ${removedCount}）`);
  }
}

// 观察器节流的挂起标记与计时器
let cleanTimer = 0;

function startCleanObserver() {
  if (cleanObserver) return;
  // B 站是 SPA，切 P / 换片 / 滚动都可能重建被删模块，用观察器兜底再摘一次。
  //
  // 必须节流：弹幕层每秒能产生几十次 childList 变更，而 sweepClean() 要跑
  // REMOVE_SELECTORS 全部 20 条选择器 × 整文档 querySelectorAll。不节流就是
  // 「每次变更都全document扫20遍」，主线程直接吃满。这里合成 120ms 一次，
  // 视觉上仍是一闪就没，开销降一个数量级。
  cleanObserver = new MutationObserver(() => {
    if (cleanTimer) return;
    cleanTimer = setTimeout(() => {
      cleanTimer = 0;
      sweepClean();
    }, 120);
  });
  cleanObserver.observe(document.documentElement, { childList: true, subtree: true });
}

function stopCleanObserver() {
  if (cleanTimer) { clearTimeout(cleanTimer); cleanTimer = 0; }
  if (cleanObserver) {
    cleanObserver.disconnect();
    cleanObserver = null;
  }
}

function setClean(on) {
  cleanOn = on;
  if (!/^www\.bilibili\.com$/.test(location.hostname)) return;
  if (on) {
    if (!cleanStyle) {
      // 轻量 CSS：瞬时不闪白 + 布局收拢到播放器
      cleanStyle = document.createElement('style');
      cleanStyle.id = 'route-buddy-clean';
      cleanStyle.textContent = CLEAN_CSS;
      (document.head || document.documentElement).appendChild(cleanStyle);
    }
    sweepClean();          // 立即摘除已存在的重负载 DOM
    startCleanObserver();  // 兜底 SPA 重建
    expandPlayer();
  } else {
    stopCleanObserver();
    if (cleanStyle) {
      cleanStyle.remove();
      cleanStyle = null;
    }
  }
}

/**
 * 浮窗尺寸很小时，替用户点一下播放器的「网页全屏」，
 * 让视频铺满整个浮窗（比把页面元素一个个隐藏掉可靠得多）。
 */
let lastExpandAt = 0;

function expandPlayer() {
  // 这里以前还有一条 `window.innerWidth >= 900` 的跳过条件：窗口一旦被调宽，
  // 就再也不点网页全屏了，可 B 站页面里的 video 还是 320×180 的小窗，
  // 于是宽窗口里只有中间一小块画面。浮窗永远是小窗口，一律铺满。
  //
  // 原来用 fullscreenTried 永久锁死：自动连播切到下一 P 时播放器重建，
  // 网页全屏状态被重置、画面又缩回小窗，却因为永久锁不再补点。这里改成
  // 冷却式重试——SPA 切 P / 换片后由 href 轮询再次触发，重新把播放器顶起来。
  const now = Date.now();
  if (now - lastExpandAt < 8000) return; // 8s 冷却，避免连续点击
  lastExpandAt = now;

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tries > 12 || !document.body) {
      clearInterval(timer);
      return;
    }
    const btn = document.querySelector('.bpx-player-ctrl-web');
    if (!btn) return;
    btn.click();
    clearInterval(timer);
    console.log('[跟跑助手] 已切到播放器网页全屏');
  }, 1000);
}

/* ---------------------------------------------------------------- 启动 */

function boot() {
  bind(pickVideo());
  if (cleanOn) setClean(cleanOn);

  // 自动连播下一 P 时 ?p= 会变，但不一定伴随视频事件（也可能整页导航）。
  // 单独轮询地址栏，变了就立刻把新页码推给浮窗；整页导航则由新 preload 的
  // boot() → bind() → push(true) 覆盖。两条路都指向同一个 snapshot()。
  // 原来这里是三个定时器（500ms 查 href / 700ms 认 video / 1000ms 推状态），
  // 每个 tick 各自 pickVideo()/比对地址栏，等于同一份状态被算三遍。合成一个
  // 500ms tick：省两次 querySelectorAll + 两个定时器，状态还在同一拍上更新。
  let lastHref = location.href;
  let tickN = 0;
  setInterval(() => {
    tickN += 1;

    // (a) 地址栏：自动连播切 P 时 ?p= 会变，但不一定伴随视频事件
    if (location.href !== lastHref) {
      lastHref = location.href;
      push(true);
      // SPA 切到下一 P / 换片后播放器重建，网页全屏被重置，冷却期过了就再顶一次
      if (cleanOn) expandPlayer();
    }

    // (b) 视频元素：B 站是 SPA，切 P / 换片会重建 <video>，持续兜底
    const v = pickVideo();
    if (v && v !== video) bind(v);
    else if (!v && video && !video.isConnected) {
      video = null;
      push(true);
    }

    // (c) 状态新鲜度：无播放事件时（卡在加载中）也每 2 拍推一次
    if (tickN % 2 === 0 && video && !video.paused) push();
  }, 500);
}

ipcRenderer.on('player', (_e, msg) => apply(msg));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

