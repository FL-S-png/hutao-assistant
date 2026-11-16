'use strict';

/* 胡桃助手 —— 渲染进程
   负责：<webview> 生命周期、播放器控制、进度条、快捷键与设置面板 */

const $ = (id) => document.getElementById(id);

const SPEEDS = [0.75, 1, 1.25, 1.5, 2, 0.5];

const state = {
  boot: null,
  id: '',
  p: 1,
  pages: [],
  autoPlay: true,
  attached: false,
  guestReady: false,
  pendingUrl: '',
  queue: [],
  video: { found: false, playing: false, current: 0, duration: 0, rate: 1, muted: false, volume: 1 },
  seeking: false,
  drawer: false,
  uiTimer: null,
  toastTimer: null,
  immersiveTimer: null,
  loadIssuedAt: 0
};

let wv = null;

/* -------------------------------------------------------------- 分 P 同步 */

/** B 站视频页 URL 读 ?p=（1 起）；读不到返回 0 */
function partFromUrl(u) {
  const m = /[?&](?:p|page)=(\d+)/.exec(String(u || ''));
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 读 /video/BVxxx/ 或 /video/av123/，用来过滤旧页面迟到的状态心跳 */
function idFromUrl(u) {
  const m = /\/video\/(BV[0-9A-Za-z]{10}|av\d+)/i.exec(String(u || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 播放器自己跳到下一 P（自动连播 / 在 B 站页面里点分 P）时校准浮窗。
 * fromGuest = 来自访客页状态心跳：刚 loadVideo 完的 1.5s 内忽略，
 * 否则旧页面残留的一条 state 会把刚设好的页码拽回去。
 * Electron 层的导航事件带的是确定的新 URL，不受这个门限约束。
 */
function syncPartFromGuest(v, fromGuest) {
  const n = Number(v && v.p);
  if (!Number.isFinite(n) || n < 1 || n === state.p) return;
  if (!state.pages.length || n > state.pages.length) return;
  const vid = String((v && v.vid) || '').toLowerCase();
  if (vid && state.id && vid !== String(state.id).toLowerCase()) return;
  if (fromGuest && Date.now() - state.loadIssuedAt < 1500) return;
  setCurrentPart(n, true);
}

/** 统一写入当前分 P：下拉框、快捷键基准、下次启动的记忆一起走 */
function setCurrentPart(n, auto) {
  if (!Number.isFinite(n) || n < 1) return;
  state.p = n;
  renderParts();
  if (!auto) return;
  try {
    const r = window.api.save({ lastPart: n });
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch {
    /* 设置写入失败不影响播放 */
  }
  toast(`已切到 P${n}${state.pages.length ? '/' + state.pages.length : ''}`, 1600);
}

/* ------------------------------------------------------------------ 启动 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.boot = await window.api.boot();
  const s = state.boot.settings;

  state.pages = [];

  createWebview();
  wireUi();
  wireHotkeys();

  document.body.classList.add('ui');

  if (state.boot.failedHotkeys && state.boot.failedHotkeys.length) {
    const names = state.boot.failedHotkeys.map((f) => prettify(f.accelerator)).join('、');
    toast(`快捷键被占用，已失效：${names}`, 4200);
  }

  if (state.boot.initialUrl) {
    loadVideo(state.boot.initialUrl, 1, true);
  } else if (s.lastText) {
    // 「上次看到」：带标题和 Pn 提示，避免忘了自己在看哪个视频、第几 P。
    // autoplay=true 是用户明确要的「下次启动接着播」，不再是只把页面打开。
    const p = Number(s.lastPart) || 1;
    loadVideo(s.lastText, p, true);
    const name = s.lastTitle || s.lastVideoId || s.lastText;
    toast(`继续上次观看：${name} · P${p}`, 4200);
  } else {
    $('urlInput').focus();
  }
}

/* --------------------------------------------------------------- webview */

function createWebview() {
  wv = document.createElement('webview');
  wv.id = 'view';
  wv.setAttribute('partition', 'persist:bili');
  wv.setAttribute('preload', state.boot.webviewPreload);
  wv.setAttribute('src', 'about:blank');
  wv.style.width = '100%';
  wv.style.height = '100%';

  wv.addEventListener('dom-ready', () => {
    state.attached = true;
    state.guestReady = true;
    flush();
    if (state.pendingUrl) {
      const u = state.pendingUrl;
      state.pendingUrl = '';
      loadUrl(u);
    }
  });

  wv.addEventListener('ipc-message', (e) => {
    if (e.channel === 'state') {
      applyState(e.args && e.args[0]);
      return;
    }
    if (e.channel === 'want-window-fullscreen') {
      // 全屏已整体禁用（m03607）：只做 16:9 等比缩放，不铺满，忽略此请求。
      return;
    }
  });

  wv.addEventListener('did-stop-loading', () => {
    state.guestReady = true;
    sendVolume();
    sendPlayer({ cmd: 'clean', on: true });
    if (state.autoPlay) {
      sendPlayer({ cmd: 'play' });
      setTimeout(() => sendPlayer({ cmd: 'play' }), 700);
    }
  });

  // 分 P 自动连播：Electron 层的导航事件是访客状态心跳之外的独立通道，
  // SPA pushState 和整页跳转都能拿到确定的新 URL（不依赖 B 站页面内部实现）。
  const onNav = (e) => {
    if (e && e.isMainFrame === false) return;
    const u = (e && e.url) || '';
    const p = partFromUrl(u);
    if (p) syncPartFromGuest({ p, vid: idFromUrl(u) }, false);
  };
  wv.addEventListener('did-navigate-in-page', onNav);
  wv.addEventListener('did-navigate', onNav);

  wv.addEventListener('did-fail-load', (e) => {
    if (!e.isMainFrame) return;
    hidePlaceholderIfVideo();
    toast(`加载失败（${e.errorCode}），检查网络或换「网页版」试试`, 4000);
  });

  $('stage').appendChild(wv);
}

function loadUrl(url) {
  if (!state.attached) {
    state.pendingUrl = url;
    return;
  }
  try {
    wv.loadURL(url);
  } catch (err) {
    toast('载入失败：' + err.message, 4000);
  }
}

function sendPlayer(msg) {
  if (!wv) return;
  if (!state.guestReady) {
    state.queue.push(msg);
    return;
  }
  try {
    wv.send('player', msg);
  } catch {
    state.queue.push(msg);
  }
}

function flush() {
  const q = state.queue.splice(0);
  for (const m of q) sendPlayer(m);
}

function sendVolume() {
  const vol = (state.boot.settings.volume ?? 100) / 100;
  sendPlayer({ cmd: 'volume', value: vol });
}

/* ------------------------------------------------------------------ 载入 */

async function loadVideo(text, part, autoplay) {
  const t = String(text || '').trim();
  if (!t) {
    toast('先粘贴一个视频链接');
    return;
  }

  showPlaceholder('载入中…');
  const res = await window.api.load({ text: t, p: part || 1 });

  if (!res.ok) {
    toast(res.message || '载入失败', 4000);
    if (!state.video.found) showPlaceholder('粘贴一个 B 站攻略视频链接');
    return;
  }

  state.id = res.id;
  state.p = res.p;
  state.pages = res.pages || [];
  state.autoPlay = !!autoplay;
  state.guestReady = false;
  state.queue = [];
  state.loadIssuedAt = Date.now();

  $('urlInput').value = t;
  $('videoTitle').textContent = res.title || res.id;
  $('videoTitle').title = res.owner ? `${res.title} · UP：${res.owner}` : res.title || '';

  renderParts();
  toggleUrlbar(false);

  // 分 P 双向联动：浮窗里换的 P（点菜单、Alt+↑↓ 连播下一 P）要推回启动器，
  // 否则启动器的下拉还停在旧 P，再点「启动跟跑」就会跳回去。
  window.api
    .action('part-sync', {
      text: t,
      id: res.id,
      title: res.title || '',
      p: res.p,
      pages: res.pages || []
    })
    .catch(() => {});

  loadUrl(res.url);
  if (res.message) toast(res.message, 3500);
}

function renderParts() {
  const float = $('partFloat');
  const label = $('partLabel');
  const menu = $('partMenu');
  menu.textContent = '';

  if (!state.pages.length) {
    float.classList.add('hidden');
    return;
  }

  const total = state.pages.length;
  let curLabel = '';
  for (const pg of state.pages) {
    const item = document.createElement('div');
    item.className = 'p-item' + (pg.page === state.p ? ' cur' : '');
    const num = document.createElement('span');
    num.className = 'p-num';
    num.textContent = `P${pg.page}/${total}`;
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = pg.part || '';
    item.appendChild(num);
    item.appendChild(name);
    item.title = `P${pg.page}/${total} ${pg.part || ''}`.trim();
    item.addEventListener('click', () => {
      if (pg.page !== state.p) loadVideo(state.id, pg.page, true);
      closePartMenu();
    });
    menu.appendChild(item);
    if (pg.page === state.p) curLabel = `P${pg.page}/${total} ${pg.part || ''}`.trim();
  }
  label.textContent = curLabel || '分 P';
  label.title = curLabel ? `当前 ${curLabel}` : '分 P';
  updatePartVisibility();
}

/* 分 P 入口显隐：播放中隐藏，暂停/播放完才显现（仅当多 P 视频） */
function updatePartVisibility() {
  const float = $('partFloat');
  const multi = state.pages.length >= 2;
  const playing = !!(state.video && state.video.playing);
  float.classList.toggle('hidden', !multi || playing);
  if (playing) closePartMenu();
}

function openPartMenu() {
  $('partMenu').classList.remove('hidden');
}

function closePartMenu() {
  $('partMenu').classList.add('hidden');
}

function changePart(delta) {
  if (state.pages.length < 2) {
    toast('这个视频只有一个分 P');
    return;
  }
  const next = Math.min(state.pages.length, Math.max(1, state.p + delta));
  if (next === state.p) {
    toast(delta > 0 ? '已经是最后一个分 P' : '已经是第一个分 P');
    return;
  }
  loadVideo(state.id, next, true);
}

/* ---------------------------------------------------------------- 状态应用 */

function applyState(v) {
  if (!v) return;
  state.video = v;
  // 访客页心跳里带了 ?p=，自动连播下一 P 时在这里把下拉框校准过来
  syncPartFromGuest(v, true);

  if (v.found) hidePlaceholderIfVideo();

  // 图标是内联 SVG，这里只切状态 class，显示哪一枚由 style.css 决定
  $('btnPlay').classList.toggle('playing', !!v.playing);
  updatePartVisibility();
  $('btnMute').classList.toggle('muted', !!(v.muted || v.volume === 0));
  $('btnSpeed').textContent = `${(v.rate || 1).toFixed(2).replace(/0$/, '')}×`;

  if (!state.seeking) paintProgress(v.current, v.duration);
  $('timeText').textContent = `${fmt(v.current)} / ${fmt(v.duration)}`;

  if (v.title && v.title !== '哔哩哔哩') $('videoTitle').textContent = v.title;
}

function paintProgress(cur, total) {
  const pct = total > 0 ? Math.min(100, (cur / total) * 100) : 0;
  $('bar').style.width = pct + '%';
  $('knob').style.left = pct + '%';
}

function fmt(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
}

/* -------------------------------------------------------------------- UI */

function wireUi() {
  $('btnLoad').addEventListener('click', () => loadVideo($('urlInput').value, 1, true));
  $('urlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadVideo($('urlInput').value, 1, true);
    e.stopPropagation();
  });

  $('btnLink').addEventListener('click', () => {
    const bar = $('urlbar');
    const willHide = !bar.classList.contains('hidden');
    toggleUrlbar(!willHide);
    if (!willHide) $('urlInput').focus();
  });

  $('btnPlay').addEventListener('click', () => sendPlayer({ cmd: 'toggle' }));
  $('btnMute').addEventListener('click', () => {
    sendPlayer({ cmd: 'mute', value: !state.video.muted });
  });
  $('btnSpeed').addEventListener('click', () => {
    const cur = state.video.rate || 1;
    const i = SPEEDS.indexOf(cur);
    const next = SPEEDS[(i < 0 ? 1 : i + 1) % SPEEDS.length];
    sendPlayer({ cmd: 'rate', value: next });
  });

  $('partBtn').addEventListener('click', () => {
    const menu = $('partMenu');
    if (menu.classList.contains('hidden')) openPartMenu();
    else closePartMenu();
  });
  // 点击面板外部关闭
  document.addEventListener('click', (e) => {
    if (!$('partFloat').contains(e.target)) closePartMenu();
  });

  $('btnMin').addEventListener('click', () => window.api.action('minimize'));
  $('btnClose').addEventListener('click', () => window.api.action('close'));

  // 浮窗不带设置，⚙ 只负责把启动器叫到前台
  $('btnSettings').addEventListener('click', () => window.api.action('open-console'));

  // 启动器发来的命令：换视频
  window.api.onFloatCmd((c) => {
    if (!c) return;
    if (c.cmd === 'load' && c.text) loadVideo(c.text, Number(c.p) || 1, true);
  });

  // 启动器改了设置（音量等），浮窗这边跟着更新
  window.api.onSettingsChanged((next) => {
    if (!next) return;
    state.boot.settings = next;
    sendVolume();
  });

  // 全屏时标题栏/控制条浮层化（设置入口在启动器里，这里只是为了不挡画面）
  window.api.onWinState((s) => {
    if (s && s.fullscreen !== undefined) setImmersive(s.fullscreen);
  });

  wireProgress();
  wireGrip();
  wireAutoHide();
}

function toggleUrlbar(show) {
  $('urlbar').classList.toggle('hidden', !show);
}

/* ---------------------------------------------------------------- 进度条 */

function wireProgress() {
  const el = $('progress');

  const ratio = (e) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const seekTo = (e) => {
    const d = state.video.duration;
    if (!d) return;
    const t = ratio(e) * d;
    paintProgress(t, d);
    $('timeText').textContent = `${fmt(t)} / ${fmt(d)}`;
    sendPlayer({ cmd: 'seek', value: t });
  };

  el.addEventListener('pointerdown', (e) => {
    if (!state.video.duration) {
      toast('视频还没准备好');
      return;
    }
    state.seeking = true;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);
    seekTo(e);
  });

  el.addEventListener('pointermove', (e) => {
    if (!state.seeking) return;
    const d = state.video.duration;
    if (!d) return;
    const t = ratio(e) * d;
    paintProgress(t, d);
    $('timeText').textContent = `${fmt(t)} / ${fmt(d)}`;
  });

  el.addEventListener('pointerup', (e) => {
    if (!state.seeking) return;
    state.seeking = false;
    el.classList.remove('dragging');
    seekTo(e);
  });

  el.addEventListener('pointercancel', () => {
    state.seeking = false;
    el.classList.remove('dragging');
  });
}

/* ------------------------------------------------------------ 缩放手柄 */

function wireGrip() {
  const grip = $('grip');
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const startW = window.innerWidth;
    const startH = window.innerHeight;
    const sx = e.screenX;
    const sy = e.screenY;
    grip.setPointerCapture(e.pointerId);

    const move = (ev) => {
      window.api.action('resize', {
        w: Math.max(240, startW + (ev.screenX - sx)),
        h: Math.max(150, startH + (ev.screenY - sy))
      });
    };
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
}

/* ------------------------------------------------------------ 自动隐藏 UI */

function wireAutoHide() {
  document.addEventListener('mousemove', wakeUi);
  document.addEventListener('mouseenter', wakeUi);
  wakeUi();
}

function wakeUi() {
  document.body.classList.add('ui');
  clearTimeout(state.uiTimer);
  state.uiTimer = setTimeout(() => {
    if (!state.video.playing || state.seeking || state.drawer) return;
    if ($('urlbar').matches(':hover') || $('titlebar').matches(':hover')) return;
    document.body.classList.remove('ui');
  }, 2600);
}

/**
 * 窗口全屏（= 视频全屏）时，标题栏和底部控制条改成浮层：默认淡出，
 * 鼠标移上去就出现。这样设置按钮不会被视频盖住，也不会挡画面。
 */
function setImmersive(on) {
  const app = $('app');
  app.classList.toggle('immersive', !!on);
  if (!on) return;
  // 刚进全屏先亮 3 秒，告诉用户「入口还在上面」，之后自己淡出
  const bar = $('titlebar');
  bar.classList.add('show');
  clearTimeout(state.immersiveTimer);
  state.immersiveTimer = setTimeout(() => bar.classList.remove('show'), 3000);
}

/* -------------------------------------------------------------- 快捷键 */

function wireHotkeys() {
  // 在地址栏里打字时，单键热键必须让路，否则敲个 j 就暂停了
  const isField = (el) => !!el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'range';
  document.addEventListener('focusin', (e) => window.api.typing(isField(e.target)));
  document.addEventListener('focusout', () => window.api.typing(false));

  window.api.onHotkey((action) => {
    switch (action) {
      case 'togglePlay':
        sendPlayer({ cmd: 'toggle' });
        break;
      case 'seekBack':
        sendPlayer({ cmd: 'seekBy', value: -5 });
        break;
      case 'seekFwd':
        sendPlayer({ cmd: 'seekBy', value: 5 });
        break;
      case 'prevPart':
        changePart(-1);
        break;
      case 'nextPart':
        changePart(1);
        break;
      default:
        break;
    }
  });

  // 窗口聚焦时也支持键盘操作
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.target && e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') {
      // 全屏优先退出全屏
      if ($('app').classList.contains('immersive')) window.api.action('fullscreen', false);
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      sendPlayer({ cmd: 'toggle' });
    } else if (e.code === 'ArrowLeft') {
      sendPlayer({ cmd: 'seekBy', value: -5 });
    } else if (e.code === 'ArrowRight') {
      sendPlayer({ cmd: 'seekBy', value: 5 });
    }
  });
}

function prettify(acc) {
  if (!acc) return '未设置';
  // 鼠标侧键单独映射，别让后续的 Left/Right 替换把它搅乱
  if (/^Mouse4$/i.test(acc)) return '鼠标侧键 ◀';
  if (/^Mouse5$/i.test(acc)) return '鼠标侧键 ▶';
  return String(acc)
    .replace(/\bSuper\b/g, 'Win')
    .replace(/\bLeft\b/g, '←')
    .replace(/\bRight\b/g, '→')
    .replace(/\bUp\b/g, '↑')
    .replace(/\bDown\b/g, '↓')
    .replace(/\bSpace\b/g, '空格');
}

/* ---------------------------------------------------------------- 占位层 */

function showPlaceholder(text) {
  const ph = $('placeholder');
  ph.classList.remove('hidden');
  ph.querySelector('p').textContent = text;
}

function hidePlaceholderIfVideo() {
  $('placeholder').classList.add('hidden');
}

/* ------------------------------------------------------------------ toast */

function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}
