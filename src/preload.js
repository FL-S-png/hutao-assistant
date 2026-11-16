'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  boot: () => ipcRenderer.invoke('app:boot'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  action: (name, payload) => ipcRenderer.invoke('win:action', name, payload),
  load: (payload) => ipcRenderer.invoke('bili:load', payload),
  // 游戏内热键需要管理员身份（UIPI），由用户在启动器里按需触发 UAC 提权重启
  relaunchElevated: () => ipcRenderer.invoke('app:relaunch-elevated'),
  updateHotkeys: (hotkeys) => ipcRenderer.invoke('hotkeys:update', hotkeys),
  resetHotkeys: () => ipcRenderer.invoke('hotkeys:reset'),

  // 输入状态：告诉主进程现在是不是在输入框里打字、是不是在录制新热键，
  // 这两段时间单键热键要让路，其余情况（包括窗口在前台）都该正常触发
  typing: (on) => ipcRenderer.send('ui:typing', !!on),
  capturing: (on) => ipcRenderer.send('ui:capture', !!on),

  onHotkey: (cb) => ipcRenderer.on('hotkey', (_e, action) => cb(action)),
  onWinState: (cb) => ipcRenderer.on('win:state', (_e, state) => cb(state)),

  // 启动器 ↔ 浮窗
  onFloatState: (cb) => ipcRenderer.on('float:state', (_e, s) => cb(s)),
  onFloatCmd: (cb) => ipcRenderer.on('float:cmd', (_e, c) => cb(c)),
  // 浮窗切了分 P，启动器的分 P 下拉跟着换
  onPartSync: (cb) => ipcRenderer.on('part:sync', (_e, s) => cb(s)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, s) => cb(s))
});
