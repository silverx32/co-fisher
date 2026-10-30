'use strict';
// Bridges the pages to the Rust side (Tauri commands and events).
(() => {
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  const current = window.__TAURI__.window.getCurrentWindow();

  window.api = {
    init: () => invoke('init'),
    setProfile: ({ name, char }) => invoke('set_profile', { name: name ?? null, character: char ?? null }),
    setSkin: (idle, typing) => invoke('set_skin', { idle, typing }),
    clearSkin: () => invoke('clear_skin'),
    host: ({ port, password }) => invoke('host', { port: Number(port) || 0, password: password || '' }),
    join: ({ address, password, room }) => invoke('join', { address: address || '', password: password || '', room: room || '' }),
    leave: () => invoke('leave'),
    steamStatus: (retry = false) => invoke('steam_status', { retry }),
    steamRooms: () => invoke('steam_rooms'),
    steamInvite: () => invoke('steam_invite'),
    buy: (item, qty) => invoke('buy', { item, qty }),
    throwItem: (item, target) => invoke('throw_item', { item, target }),
    hitRects: (rects) => invoke('hit_rects', { rects }),
    startDrag: () => current.startDragging(),
    overlayIdle: (seen) => invoke('overlay_idle', { seen }),
    quit: () => invoke('quit'),
    on: (channel, fn) => listen(channel, (e) => fn(e.payload)),
  };
})();
