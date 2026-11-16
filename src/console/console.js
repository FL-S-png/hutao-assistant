'use strict';

/**
 * 启动器 —— 所有设置都在这里改。
 * 浮窗只负责播放，本身不带任何设置界面。
 */

const $ = (id) => document.getElementById(id);

const state = {
  boot: null,
  video: null, // 当前载入的 { text, id, pages, p, title }
  floatRunning: false,
  toastTimer: null
};

/* ------------------------------------------------------------------ 启动 */

document.addEventListener('DOMContentLoaded', init);

async function init() {
  state.boot = await window.api.boot();
  const s = state.boot.settings;

  renderHotkeys();

  // 分 P 下拉必须预置到上次那一集：空 <select> 的 value 是 ''，
  // 点「启动跟跑」时 Number('')||1 会把 lastPart 覆写成 P1，进度就丢了。
  // 上次的链接不回填进输入框：输入框留空才看得见 placeholder；
  // 链接本身仍在 settings.lastText 里，启动/切P 时按回退顺序取用。
  renderLastPart(s);
  updateVideoMeta();

  wireVideo();
  wireGlassPart();
  wireHotkeys();
  wireSettings();
  fillSettings(s);
  // 冷启动就把上次那个视频的分 P 列表拉回来：否则下拉是灰的，
  // 用户在启动器上根本切不了 P，只能去浮窗里点。
  hydrateLastVideo(s);

  // 只有在输入框里真的打字时才让单键热键让路。以前是「本程序窗口在前台就全忽略」，
  // 结果用户在启动器里按 J 想试试热键，一律被吞掉，看起来就像热键没接上。
  const isField = (el) =>
    !!el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && !['checkbox', 'radio', 'range'].includes(el.type);
  document.addEventListener('focusin', (e) => window.api.typing(isField(e.target)));
  document.addEventListener('focusout', () => window.api.typing(false));

  window.api.onFloatState((st) => setFloatState(!!(st && st.running)));
  // 浮窗先切了 P：启动器跟着换（这是「两边永远是同一个 P」的一半）
  window.api.onPartSync((s) => applyPartSync(s));
  // 浮窗改了设置（比如按热键切了穿透）就同步回界面
  window.api.onSettingsChanged((next) => {
    state.boot.settings = next;
    fillSettings(next);
    // 同一个视频里切了 P，启动器的下拉与当前 P 标注也跟着走
    if (
      state.video &&
      next.lastPart &&
      next.lastPart !== state.video.p &&
      (!next.lastVideoId || !state.video.id ||
        String(next.lastVideoId).toLowerCase() === String(state.video.id).toLowerCase())
    ) {
      state.video.p = next.lastPart;
      renderParts();
      updateVideoMeta();
    }
  });
}

/* ------------------------------------------------------------ 视频与浮窗 */

function wireVideo() {
  $('btnLaunch').addEventListener('click', launch);
  $('url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') launch();
  });

  $('part').addEventListener('change', () => {
    switchPart(Number($('part').value) || 1);
  });
}

/**
 * 切分 P：启动器这一下拉就是浮窗那个分 P 按钮的「遥控器」。
 * 以前这里 `if (!state.video) return;` 直接掐掉，而 state.video 只有「本次会话里
 * 从启动器点过启动跟跑」才有值 —— 只要视频是浮窗自己续播/热键切的，下拉就是灰的，
 * 于是「启动器上切换分 P，播放器跟着切」永远做不到。现在文本回退到输入框/上次记录，
 * 第一次切 P 时就地补一次 bili:load 拿到 pages，再推给浮窗。
 */
async function switchPart(p) {
  const text =
    (state.video && state.video.text) ||
    $('url').value.trim() ||
    (state.boot.settings && state.boot.settings.lastText) ||
    '';
  if (!text) return;

  if (!state.video) {
    const info = await window.api.load({ text, p });
    if (!info || !info.ok) return;
    state.video = {
      text,
      id: info.id,
      title: info.title || '',
      pages: info.pages || [],
      p: info.p
    };
  }

  state.video.p = p;
  renderParts();
  updateVideoMeta();

  await window.api.save({ lastPart: p });
  await window.api.load({ text, p });
  // 浮窗没起的时候这句是空操作，起了就立刻换片
  await window.api.action('float-load', { text, p });
  updateVideoMeta();
}

/** 浮窗切了 P（点它自己的分 P 菜单 / 连播下一 P）→ 启动器跟上，不反向再推一次 */
function applyPartSync(s) {
  if (!s || !s.p) return;
  const p = Math.floor(Number(s.p)) || 1;
  const pages = Array.isArray(s.pages) ? s.pages : null;

  if (!state.video || (s.id && state.video.id && String(state.video.id) !== String(s.id))) {
    state.video = {
      text: s.text || s.id || (state.boot.settings && state.boot.settings.lastText) || '',
      id: s.id || '',
      title: s.title || '',
      pages: pages || [],
      p
    };
    renderParts();
    updateVideoMeta();
    return;
  }

  if (pages && pages.length && pages.length !== state.video.pages.length) state.video.pages = pages;
  if (state.video.p === p) return;
  state.video.p = p;
  renderParts();
  updateVideoMeta();
}

/**
 * 分 P 液态玻璃下拉：原生 <select> 展开层是系统画的（白底方块），玻璃贴不上去，
 * 所以 #part 退居成数据源（.sel-src 视觉隐藏），真正给用户点的是 #partBtnG + #partMenuG。
 * renderParts()/renderLastPart() 一个字节都不用改：它们改 #part 的 DOM，这里用
 * MutationObserver 把 option 列表镜像到玻璃菜单；点菜单项再回写 select 并派发 change，
 * 原有 change 处理链（存 lastPart + 重载浮窗）照常跑。
 */
function wireGlassPart() {
  const sel = $('part');
  const btn = $('partBtnG');
  const menu = $('partMenuG');
  const label = $('partLabelG');
  if (!sel || !btn || !menu || !label) return;

  // 菜单挪到 body 末尾：卡片是 overflow:hidden + backdrop-filter 的玻璃，
  // 留在卡片里既会被裁切、fixed 也会以卡片为包含块，挪出来才能按窗口算位置。
  if (menu.parentElement !== document.body) document.body.appendChild(menu);

  const close = () => {
    menu.hidden = true;
    btn.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  };

  // 高度按「按钮下方到红框上方」的可用空间算：够就向下展开，不够就翻到按钮上方。
  const place = () => {
    const r = btn.getBoundingClientRect();
    const banner = $('freeBanner');
    const br = banner && !banner.hidden ? banner.getBoundingClientRect() : null;
    const limit = (br && br.height > 0 ? br.top : window.innerHeight) - 10;
    const width = Math.max(220, Math.min(r.width, window.innerWidth - r.left - 12));
    menu.style.width = width + 'px';
    menu.style.left = Math.min(r.left, window.innerWidth - width - 12) + 'px';

    const below = limit - (r.bottom + 6);
    if (below >= 150) {
      menu.style.top = r.bottom + 6 + 'px';
      menu.style.bottom = '';
      menu.style.maxHeight = Math.min(430, below) + 'px';
      return;
    }
    // 下方不够：整块翻到按钮上沿，最高到窗口顶部留 10px
    menu.style.bottom = window.innerHeight - r.top + 6 + 'px';
    menu.style.top = '';
    menu.style.maxHeight = Math.min(430, Math.max(140, r.top - 12)) + 'px';
  };

  const sync = () => {
    const opts = Array.from(sel.options);
    const idx = sel.selectedIndex;
    const cur = opts[idx] || opts[0];
    label.textContent = cur ? (cur.textContent || '分 P') : '分 P';
    btn.title = (cur && (cur.title || cur.textContent)) || '分 P';
    btn.disabled = !!sel.disabled;

    menu.textContent = '';
    opts.forEach((o, i) => {
      const it = document.createElement('button');
      it.type = 'button';
      it.className = 'dd-item' + (i === idx ? ' cur' : '');
      it.setAttribute('role', 'option');
      it.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      // 和浮窗的分 P 菜单同一套排版：左边 P2/24，右边分 P 标题
      const raw = String(o.textContent || '').replace(/^▶\s*/, '').trim();
      const mm = raw.match(/^(P\d+\/\d+)\s*(.*)$/);
      const num = document.createElement('span');
      num.className = 'dd-num';
      const name = document.createElement('span');
      name.className = 'dd-name';
      if (mm) {
        num.textContent = mm[1];
        name.textContent = mm[2] || '';
      } else {
        num.textContent = raw;
      }
      it.appendChild(num);
      if (name.textContent) it.appendChild(name);
      it.title = o.title || o.textContent;
      it.addEventListener('click', () => {
        sel.selectedIndex = i;
        close();
        // 原生 select 用代码赋值不会自动触发 change，这里手动补一次，
        // 让「切 P 就重载浮窗」的既有逻辑仍然生效。
        sel.dispatchEvent(new Event('change'));
        sync();
      });
      menu.appendChild(it);
    });
    if (btn.disabled) close();
  };

  new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true });
  sel.addEventListener('change', sync);
  sync();

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    const willOpen = menu.hidden;
    if (willOpen) {
      menu.hidden = false;
      place();
      btn.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      const cur = menu.querySelector('.dd-item.cur');
      if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
    } else {
      close();
    }
  });

  // 窗口缩放 / 面板滚动时菜单跟着重新定位（fixed 坐标不会自己跟）
  const replace = () => { if (!menu.hidden) place(); };
  window.addEventListener('resize', replace);
  document.addEventListener('scroll', replace, true);

  // 点空白处 / 按 Esc 收起，行为对齐原生 select
  document.addEventListener('click', (e) => {
    if (menu.hidden) return;
    if (menu.contains(e.target) || btn === e.target || btn.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || menu.hidden) return;
    close();
    btn.focus();
  });
}

/**
 * 冷启动补一次视频信息：把上次那个视频的 pages 拉回来，让分 P 下拉一进来就是可用的。
 * 链接失效/断网就静静保持占位态，不弹任何提示 —— 这是后台补数据，不是用户操作。
 */
async function hydrateLastVideo(s) {
  if (state.video || !s || !s.lastText) return;
  try {
    const res = await window.api.load({ text: s.lastText, p: Math.max(1, Number(s.lastPart) || 1) });
    if (!res || !res.ok || state.video) return;
    state.video = {
      text: s.lastText,
      id: res.id,
      title: res.title || '',
      pages: res.pages || [],
      p: res.p
    };
    renderParts();
    updateVideoMeta();
  } catch (e) {
    /* 离线或链接已失效：保持「▶ Pn」占位，用户重新粘链接即可 */
  }
}

/**
 * 点「启动跟跑」时用第几 P。
 * 输入框里贴了和上次不同的链接 = 换片 → P1；否则沿用下拉里选中的（上次那一集）。
 * 抽成纯函数便于离线回归。
 */
function partForLaunch(text, s, selValue) {
  const t = String(text || '').trim();
  const last = String((s && s.lastText) || '').trim();
  // 链接里自带 ?p=N 时以它为准：输入框提示写着「支持 ?p= 分 P」，
  // 而下面「换片就从 P1 起」的分支会把这层意图吃掉（粘 ?p=7 却从 P1 播）。
  const m = /[?&]p=(\d+)/.exec(t);
  if (m) {
    const n0 = Number(m[1]);
    if (Number.isFinite(n0) && n0 > 0) return Math.floor(n0);
  }
  if (t && last && t !== last) return 1;
  const n = Number(selValue);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return Math.max(1, Math.floor(Number(s && s.lastPart) || 1));
}

async function launch() {
  const text = $('url').value.trim();
  if (!text && !state.boot.settings.lastText) {
    toast('先粘一个 B 站链接', true);
    $('url').focus();
    return;
  }

  $('btnLaunch').disabled = true;
  $('btnLaunch').textContent = '载入中…';

  try {
    if (text) {
      const p = partForLaunch(text, state.boot.settings, $('part').value);
      const res = await window.api.load({ text, p });
      if (!res.ok) {
        toast(res.message || '载入失败', true);
        return;
      }
      state.video = {
        text,
        id: res.id,
        title: res.title || '',
        pages: res.pages || [],
        p: res.p
      };
      // 本地先同步一次：bili:load 的广播是异步的，紧接着再点「启动跟跑」
      // 不能因为快照还没刷新就被误判成「换片」而退回 P1。
      Object.assign(state.boot.settings, {
        lastText: text,
        lastPart: res.p,
        lastTitle: res.title || '',
        lastVideoId: res.id,
      });
      renderParts();
      updateVideoMeta();
    }

    await window.api.action('start-float');
    // 浮窗已经在跑的时候不能只切窗口，得让它换片
    if (state.floatRunning && text) {
      await window.api.action('float-load', { text, p: (state.video && state.video.p) || 1 });
    }
    toast('浮窗已启动，按 Alt+H 可以随时隐藏');
  } finally {
    $('btnLaunch').disabled = false;
    $('btnLaunch').textContent = '启动跟跑';
  }
}

/** 还没载入视频时，先给分 P 下拉一个「上次的 P」占位，避免 launch() 取到空值 */
function renderLastPart(s) {
  if (state.video) return;
  const sel = $('part');
  const p = Math.max(1, Number(s.lastPart) || 1);
  sel.textContent = '';
  const opt = document.createElement('option');
  opt.value = String(p);
  opt.textContent = `▶ P${p}`;
  opt.title = opt.textContent;
  sel.appendChild(opt);
  sel.value = String(p);
  sel.disabled = true;
  sel.title = '载入视频后可选分 P';
}

function renderParts() {
  const sel = $('part');
  const pages = (state.video && state.video.pages) || [];
  sel.textContent = '';

  if (!pages.length) {
    const opt = document.createElement('option');
    opt.textContent = '仅 1 个分 P';
    opt.value = '1';
    opt.title = '仅 1 个分 P';
    sel.appendChild(opt);
    sel.value = '1';
    sel.disabled = true;
    sel.title = '仅 1 个分 P';
    return;
  }

  sel.disabled = false;
  const total = pages.length;
  let curLabel = '';
  for (const pg of pages) {
    const opt = document.createElement('option');
    opt.value = String(pg.page);
    // 和浮窗的下拉保持一致：把「第几 P / 共几 P」写进文本，当前项加 ▶
    const label = `P${pg.page}/${total} ${pg.part || ''}`.trim();
    const cur = !!(state.video && pg.page === state.video.p);
    opt.textContent = cur ? `▶ ${label}` : label;
    opt.title = label;
    sel.appendChild(opt);
    if (cur) curLabel = label;
  }
  sel.value = String(state.video ? state.video.p : 1);
  sel.title = curLabel ? `当前 ${curLabel}` : '分 P';
}

function updateVideoMeta() {
  const v = state.video;
  if (!v) {
    $('videoMeta').textContent = '';
    return;
  }
  const title = v.title || v.id;
  $('videoMeta').innerHTML =
    `<b>${escapeHtml(title)}</b> · 当前 P${v.p}${v.pages.length ? '/' + v.pages.length : ''}`;
}

function setFloatState(on) {
  state.floatRunning = on;
}

/* ---------------------------------------------------------------- 设置 */

// 用户自选的背景图只覆盖 --bg-img 变量：body 上那层渐变暗角（#shell::before/::after）
// 是独立元素，不会被 background-image 覆盖，所以换图不会把画面压平。
function fillSettings(s) {
  const raw = s && s.background;
  if (!raw) { document.body.style.removeProperty('--bg-img'); return; }
  const url = String(raw).startsWith('file:')
    ? String(raw)
    : 'file:///' + String(raw).replace(/\\\\/g, '/');
  document.body.style.setProperty('--bg-img', `url("${url}")`);
}

function wireSettings() {
  const bg = $('btnBg');
  if (bg && !bg.dataset.bound) {
    bg.dataset.bound = '1';
    bg.addEventListener('click', () => window.api.action('pick-background'));
  }
}

/* --------------------------------------------------------------- 热键 */

function wireHotkeys() {
  $('btnResetHk').addEventListener('click', async () => {
    const res = await window.api.resetHotkeys();
    state.boot.settings.hotkeys = res.hotkeys;
    state.boot.hookRunning = res.hookRunning;
    renderHotkeys();
    reportFailed(res.failed);
  });
}

function renderHotkeys() {
  const list = $('hkList');
  const hotkeys = state.boot.settings.hotkeys || {};
  list.textContent = '';

  // 只展示播放/暂停、后退、前进三组常用键位（其余走功能保留但不外显）
  const show = new Set(['togglePlay', 'seekBack', 'seekFwd']);
  for (const meta of state.boot.hotkeys) {
    if (!show.has(meta.key)) continue;
    const row = document.createElement('div');
    row.className = 'hk-row';

    const label = document.createElement('span');
    label.textContent = meta.label;

    const kbd = document.createElement('button');
    kbd.className = 'kbd';
    paintKeys(kbd, hotkeys[meta.key]);
    kbd.addEventListener('click', () => captureHotkey(kbd, meta.key));

    row.append(label, kbd);
    list.appendChild(row);
  }

  renderHookState();
}

/**
 * 把加速器画成一组键帽：Alt+Space → [Alt] + [空格]。
 * 一整串「Alt+空格」塞在一个按钮里，扫一眼分不清是几个键；拆开后和键盘上的样子对得上。
 * 鼠标侧键是一个整体，不按 + 拆。
 */
function paintKeys(kbd, acc) {
  kbd.textContent = '';
  kbd.title = '点击后按下新的键位';
  if (!acc) {
    kbd.textContent = '未设置';
    return;
  }
  const parts = /^Mouse[45]$/i.test(acc) ? [acc] : String(acc).split('+');
  parts.forEach((part, i) => {
    if (i) {
      const plus = document.createElement('span');
      plus.className = 'plus';
      plus.textContent = '+';
      kbd.appendChild(plus);
    }
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = prettify(part);
    kbd.appendChild(key);
  });
}

/**
 * 单键 / 侧键靠系统钩子，钩子没起来时这两类热键是彻底不响的。
 * 与其让用户猜「是不是坏了」，不如直接把状态摆在键盘位下面。
 */
function renderHookState() {
  const el = $('hkState');
  if (!el) return;
  // 提权提示与「有没有单键绑定」无关：Alt 组合键走 RegisterHotKey，
  // 在提权窗口（原神）前台时同样收不到（UIPI），所以永远要在首屏提示
  renderElevateState();

  const hotkeys = state.boot.settings.hotkeys || {};
  const hookKeys = Object.entries(hotkeys).filter(([, acc]) => acc && !String(acc).includes('+'));
  const running = !!state.boot.hookRunning;
  // 精简版只保留组合键三组，单键监听钩子未必有键位 —— 状态统一显示「监听中」绿点，
  // 系统独占组合键（Alt 组合）由 Windows RegisterHotKey 全局接管，不需要单键钩子
  el.className = 'hk-state ' + (running ? 'ok' : 'bad');
  el.textContent = running ? '监听中' : '未启动';
  void hookKeys;
  return;
  // 以下为完整版文案，精简版不再使用
  if (!hookKeys.length) {
    el.className = 'hk-state';
    el.textContent = '当前没有单键 / 侧键绑定，全部走系统独占组合键';
    return;
  }
  el.className = 'hk-state ' + (running ? 'ok' : 'bad');
  el.textContent = running
    ? `单键与侧键监听已启动（${hookKeys.length} 个键位）${
        state.boot.elevated ? '，在游戏里也能触发' : '，但游戏内需管理员身份（见上）'
      }`
    : '单键与侧键监听未启动，这些键位目前不会响应（可能被杀毒软件拦截）';
}

/**
 * 没提权时，游戏里的热键必然不响 —— 这是 Windows 的 UIPI 规则，不是程序坏了：
 * 原神这类游戏以管理员启动，非提权进程的低级钩子收不到「提权窗口在前台」时的按键。
 * 与其让用户反复试，不如把原因和办法直接写在键盘位下面。
 */
function renderElevateState() {
  const el = $('elevBanner');
  if (!el) return;
  if (state.boot.elevated) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const text = $('elevBannerText');
  if (text) {
    text.textContent =
      '未以管理员身份运行：原神等以管理员权限启动的程序在前台时，全局快捷键（含单键与组合键）收不到，这是 Windows 的 UIPI 限制。点右侧按钮重启即可，当前配置不会丢。';
  }

  const btn = $('btnElevate');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '正在请求权限…';
      // 成功时主进程会退出本实例，UAC 确认后以管理员身份重新拉起；
      // 失败基本只有一种原因：用户在 UAC 弹窗上点了「否」
      const r = await window.api.relaunchElevated();
      if (!r || !r.ok) {
        btn.disabled = false;
        btn.textContent = r && r.reason === 'uac-cancelled' ? '已取消，重试' : label;
      }
    });
  }
}

/** 当前正在录制的那一个键位，点别的键位时先取消它，避免监听器叠加 */
let activeCapture = null;

function captureHotkey(kbd, key) {
  if (activeCapture) activeCapture();

  // 录制期间把全局单键热键挡掉，否则按 J 会先暂停视频再被录进去，顺序全靠运气
  window.api.capturing(true);

  kbd.classList.add('capturing');
  kbd.textContent = '按键位或鼠标侧键…';

  const cleanup = () => {
    window.api.capturing(false);
    kbd.classList.remove('capturing');
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('mousedown', onMouse, true);
    if (activeCapture === cleanup) activeCapture = null;
  };

  const commit = async (acc) => {
    cleanup();
    const res = await window.api.updateHotkeys({ [key]: acc });
    state.boot.settings.hotkeys = res.hotkeys;
    state.boot.hookRunning = res.hookRunning;
    renderHotkeys();

    // 注册被系统否决时主进程已经把旧键位还原了，这里要说清楚，别让用户以为改成了
    if (res.rejected && res.rejected.includes(key)) {
      toast(`${prettify(acc)} 被系统或其他程序占用，已保留原来的键位`, true);
      return;
    }
    // 撞到别的动作时主进程做了互换，得提示一句，否则用户会发现自己另一个热键变了却不知道为什么
    if (res.swapped && res.swapped.length && !(res.failed || []).length) {
      toast(`已设置为 ${prettify(acc)}，原来占用它的动作已和它互换`);
      return;
    }
    reportFailed(res.failed, key);
  };

  const onKey = async (e) => {
    // 只按住 Ctrl/Alt/Shift/Win 时不算一次录入，继续等真正的按键
    if (/^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(e.code || '')) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      cleanup();
      renderHotkeys();
      return;
    }

    const acc = toAccelerator(e);
    if (!acc) {
      kbd.textContent = '这个键不支持，换一个';
      return;
    }
    await commit(acc);
  };

  // 鼠标侧键：DOM 里 button 3 = 后退侧键、4 = 前进侧键
  const onMouse = async (e) => {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    e.stopPropagation();
    await commit(`Mouse${e.button + 1}`);
  };

  activeCapture = cleanup;
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onMouse, true);
}

function reportFailed(failed, focusKey) {
  if (!failed || !failed.length) return;
  const hit = focusKey ? failed.find((f) => f.key === focusKey) : failed[0];
  if (!hit) return;
  if (hit.unsupported) {
    toast(`${prettify(hit.accelerator)} 这个键钩子认不出来，换成字母、数字、F 键或方向键试试`, true);
    return;
  }
  if (hit.hook) {
    toast('单键和鼠标侧键靠系统钩子实现，当前钩子启动失败（常见于杀毒软件拦截），可先用带 Alt/Ctrl 的组合', true);
    return;
  }
  toast(`${prettify(hit.accelerator)} 被系统或其他程序占用，请换一个`, true);
}

function toAccelerator(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const k = keyName(e);
  if (!k) return '';
  // 单键（不带修饰键）现在也允许：它们走低级钩子被动监听，不会把键从别的程序里抢走
  return [...mods, k].join('+');
}

function keyName(e) {
  const code = e.code || '';
  let m;
  if ((m = code.match(/^Key([A-Z])$/))) return m[1];
  if ((m = code.match(/^Digit(\d)$/))) return m[1];
  if ((m = code.match(/^F(\d{1,2})$/))) return 'F' + m[1];

  const map = {
    Space: 'Space',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    Escape: 'Esc',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Semicolon: ';',
    Comma: ',',
    Period: '.',
    Slash: '/'
  };
  if (map[code]) return map[code];
  if (e.key && e.key.length === 1) return e.key.toUpperCase();
  return '';
}

function prettify(acc) {
  if (!acc) return '未设置';
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

/* ---------------------------------------------------------------- 杂项 */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text, bad) {
  const el = $('toast');
  el.textContent = text;
  el.classList.toggle('bad', !!bad);
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}
