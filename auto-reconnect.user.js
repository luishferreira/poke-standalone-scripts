// ==UserScript==
// @name         Auto reconnect
// @namespace    http://tampermonkey.net/
// @version      2026-09-22.1
// @description  auto reconecta e pula mega sableye
// @author       Luis
// @match        https://poke.idleworld.online/play
// @icon         https://www.google.com/s2/favicons?sz=64&domain=idleworld.online
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-reconnect.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-reconnect.user.js
// @grant        none
// ==/UserScript==

// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.
// Fonte: src/auto-reconnect.js

// Shared module: src/shared/ws-bridge.js
(function installPiwWebSocketBridge(global) {
  'use strict';

  const API_VERSION = 1;
  const NAMESPACE_KEY = 'piwScripts';
  const BRIDGE_KEY = 'wsBridge';
  const existingNamespace = global[NAMESPACE_KEY];

  if (existingNamespace != null && typeof existingNamespace !== 'object') {
    console.warn('[PIW WS Bridge] window.piwScripts já existe e não é um objeto.');
    return;
  }

  const namespace = existingNamespace || {};
  if (!existingNamespace) global[NAMESPACE_KEY] = namespace;

  if (namespace[BRIDGE_KEY]) {
    if (namespace[BRIDGE_KEY].apiVersion !== API_VERSION) {
      console.warn('[PIW WS Bridge] Bridge incompatível já instalado.', {
        expected: API_VERSION,
        installed: namespace[BRIDGE_KEY].apiVersion,
      });
    }
    return;
  }

  const PreviousWebSocket = global.WebSocket;
  const previousSend = PreviousWebSocket?.prototype?.send;
  if (typeof PreviousWebSocket !== 'function' || typeof previousSend !== 'function') {
    console.warn('[PIW WS Bridge] WebSocket nativo indisponível.');
    return;
  }

  const subscribers = new Map();
  const socketBindings = new Map();
  const retiredSockets = new WeakSet();
  let nextSubscriberId = 1;
  let currentSocket = null;
  let installed = true;

  function isGameSocket(socket, url = socket?.url) {
    return typeof url === 'string' && url.includes('/ws');
  }

  function parseFrame(data) {
    if (typeof data !== 'string') return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function notify(event) {
    for (const subscriber of [...subscribers.values()]) {
      try {
        if (typeof subscriber === 'function') {
          subscriber(event);
        } else {
          subscriber[event.type]?.(event);
        }
      } catch (error) {
        console.warn('[PIW WS Bridge] Subscriber falhou.', {
          eventType: event.type,
          message: error?.message || String(error),
        });
      }
    }
  }

  function createEvent(type, details = {}) {
    return Object.freeze({
      type,
      timestamp: Date.now(),
      ...details,
    });
  }

  function detachSocket(socket) {
    const binding = socketBindings.get(socket);
    if (!binding) return false;
    socket.removeEventListener('message', binding.onMessage);
    socket.removeEventListener('open', binding.onOpen);
    socket.removeEventListener('close', binding.onClose);
    socket.removeEventListener('error', binding.onError);
    socketBindings.delete(socket);
    return true;
  }

  function setCurrentSocket(socket) {
    if (currentSocket === socket) return;
    const previousSocket = currentSocket;
    currentSocket = socket;

    if (previousSocket) {
      retiredSockets.add(previousSocket);
      notify(createEvent('replaced', { socket, previousSocket }));
      detachSocket(previousSocket);
    }
    notify(createEvent('socket', { socket, previousSocket }));
  }

  function attachSocket(socket, url = socket?.url) {
    if (!installed || retiredSockets.has(socket) || !isGameSocket(socket, url)) return false;
    if (socketBindings.has(socket)) {
      setCurrentSocket(socket);
      return true;
    }

    const onMessage = (originalEvent) => {
      if (!installed || currentSocket !== socket) return;
      notify(createEvent('incoming', {
        socket,
        data: originalEvent.data,
        message: parseFrame(originalEvent.data),
        originalEvent,
      }));
    };
    const onOpen = (originalEvent) => {
      if (!installed) return;
      setCurrentSocket(socket);
      notify(createEvent('open', { socket, originalEvent }));
    };
    const onClose = (originalEvent) => {
      const wasCurrent = currentSocket === socket;
      if (wasCurrent) currentSocket = null;
      if (installed) {
        notify(createEvent('close', { socket, originalEvent, wasCurrent }));
      }
      detachSocket(socket);
    };
    const onError = (originalEvent) => {
      if (!installed || currentSocket !== socket) return;
      notify(createEvent('error', { socket, originalEvent }));
    };

    socketBindings.set(socket, { onMessage, onOpen, onClose, onError });
    socket.addEventListener('message', onMessage);
    socket.addEventListener('open', onOpen);
    socket.addEventListener('close', onClose);
    socket.addEventListener('error', onError);
    setCurrentSocket(socket);
    return true;
  }

  function isCurrentSocketOpen() {
    return currentSocket?.readyState === PreviousWebSocket.OPEN;
  }

  function sendThroughBridge(data) {
    if (!isCurrentSocketOpen()) return false;
    try {
      currentSocket.send(data);
      return true;
    } catch (error) {
      console.warn('[PIW WS Bridge] Falha ao enviar mensagem.', {
        message: error?.message || String(error),
      });
      return false;
    }
  }

  function BridgedWebSocket(url, protocols) {
    const socket = protocols === undefined
      ? new PreviousWebSocket(url)
      : new PreviousWebSocket(url, protocols);
    attachSocket(socket, url);
    return socket;
  }

  BridgedWebSocket.prototype = PreviousWebSocket.prototype;
  Object.setPrototypeOf(BridgedWebSocket, PreviousWebSocket);

  const patchedSend = function patchedSend(data) {
    const tracked = attachSocket(this);
    let result;
    try {
      result = previousSend.apply(this, arguments);
    } catch (error) {
      if (tracked && installed) {
        notify(createEvent('send-error', {
          socket: this,
          data,
          message: parseFrame(data),
          error,
        }));
      }
      throw error;
    }

    if (tracked && installed) {
      notify(createEvent('outgoing', {
        socket: this,
        data,
        message: parseFrame(data),
      }));
    }
    return result;
  };

  PreviousWebSocket.prototype.send = patchedSend;
  global.WebSocket = BridgedWebSocket;

  const api = Object.freeze({
    apiVersion: API_VERSION,
    subscribe(subscriber) {
      if (!installed) throw new Error('PIW WS Bridge não está instalado.');
      const validFunction = typeof subscriber === 'function';
      const validObject = subscriber && typeof subscriber === 'object';
      if (!validFunction && !validObject) {
        throw new TypeError('subscriber precisa ser uma função ou objeto de handlers.');
      }

      const subscriberId = nextSubscriberId++;
      subscribers.set(subscriberId, subscriber);
      let active = true;
      return function unsubscribe() {
        if (!active) return false;
        active = false;
        return subscribers.delete(subscriberId);
      };
    },
    getSocket() {
      return currentSocket;
    },
    isOpen() {
      return isCurrentSocketOpen();
    },
    send(data) {
      return sendThroughBridge(data);
    },
    sendJson(payload) {
      let data;
      try {
        data = JSON.stringify(payload);
      } catch (error) {
        console.warn('[PIW WS Bridge] Payload não pôde ser serializado.', {
          message: error?.message || String(error),
        });
        return false;
      }
      return sendThroughBridge(data);
    },
    attach(socket) {
      return attachSocket(socket);
    },
    status() {
      return {
        installed,
        apiVersion: API_VERSION,
        socket: currentSocket,
        socketOpen: isCurrentSocketOpen(),
        subscribers: subscribers.size,
        trackedSockets: socketBindings.size,
      };
    },
    uninstall() {
      if (!installed) return false;
      installed = false;
      for (const socket of [...socketBindings.keys()]) detachSocket(socket);
      subscribers.clear();
      currentSocket = null;
      if (global.WebSocket === BridgedWebSocket) global.WebSocket = PreviousWebSocket;
      if (PreviousWebSocket.prototype.send === patchedSend) {
        PreviousWebSocket.prototype.send = previousSend;
      }
      if (namespace[BRIDGE_KEY] === api) delete namespace[BRIDGE_KEY];
      return true;
    },
  });

  namespace[BRIDGE_KEY] = api;
  if (isGameSocket(global.myGameSocket)) attachSocket(global.myGameSocket);
})(window);

// Shared module: src/shared/ui-menu.js
(function installPiwUiMenu() {
  'use strict';

  const namespace = window.piwScripts = window.piwScripts || {};
  const attachedPanels = new WeakMap();

  function createPanelDragHandler(panel, {
    storageKey,
    handle = panel?.querySelector?.('header'),
    margin = 8,
  } = {}) {
    if (!panel || !handle || !storageKey) {
      throw new TypeError('Configuração de painel móvel inválida.');
    }

    attachedPanels.get(panel)?.();
    const safeMargin = Math.max(0, Number(margin) || 0);
    const originalHandleStyle = {
      cursor: handle.style.cursor,
      touchAction: handle.style.touchAction,
      userSelect: handle.style.userSelect,
    };
    let dragging = null;
    let lastSize = { width: 0, height: 0 };

    function readPosition() {
      try {
        const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
        const left = Number(saved?.left);
        const top = Number(saved?.top);
        return Number.isFinite(left) && Number.isFinite(top) ? { left, top } : null;
      } catch {
        return null;
      }
    }

    function savePosition(position) {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify(position));
      } catch {
        // O movimento continua funcionando mesmo quando o storage está indisponível.
      }
    }

    function removeSavedPosition() {
      try {
        sessionStorage.removeItem(storageKey);
      } catch {
        // A posição visual ainda pode ser restaurada sem acesso ao storage.
      }
    }

    function getPanelSize() {
      const rect = panel.getBoundingClientRect();
      const computed = typeof getComputedStyle === 'function' ? getComputedStyle(panel) : null;
      const measured = {
        width: rect.width || panel.offsetWidth || parseFloat(computed?.width) || 0,
        height: rect.height || panel.offsetHeight || parseFloat(computed?.height) || 0,
      };
      if (measured.width > 0) lastSize.width = measured.width;
      if (measured.height > 0) lastSize.height = measured.height;
      return {
        width: measured.width || lastSize.width,
        height: measured.height || lastSize.height,
      };
    }

    function clampPosition(left, top) {
      const { width, height } = getPanelSize();
      const viewportWidth = Number(window.innerWidth) || document.documentElement?.clientWidth || width;
      const viewportHeight = Number(window.innerHeight) || document.documentElement?.clientHeight || height;
      const minLeft = Math.min(safeMargin, Math.max(0, viewportWidth - width));
      const minTop = Math.min(safeMargin, Math.max(0, viewportHeight - height));
      const maxLeft = Math.max(minLeft, viewportWidth - width - safeMargin);
      const maxTop = Math.max(minTop, viewportHeight - height - safeMargin);
      return {
        left: Math.round(Math.min(maxLeft, Math.max(minLeft, Number(left) || 0))),
        top: Math.round(Math.min(maxTop, Math.max(minTop, Number(top) || 0))),
      };
    }

    function applyPosition(left, top, { persist = false } = {}) {
      const position = clampPosition(left, top);
      panel.style.left = `${position.left}px`;
      panel.style.top = `${position.top}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      panel.style.transform = 'none';
      if (persist) savePosition(position);
      return position;
    }

    function isInteractive(target) {
      let current = target;
      while (current && current !== handle) {
        if (current.matches?.('button,a,input,select,textarea,label,[data-piw-no-drag]')) return true;
        current = current.parentElement;
      }
      return false;
    }

    function stopDragging(event) {
      if (!dragging || (event?.pointerId != null && event.pointerId !== dragging.pointerId)) return;
      const position = applyPosition(panel.getBoundingClientRect().left, panel.getBoundingClientRect().top);
      savePosition(position);
      dragging = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    }

    function onPointerMove(event) {
      if (!dragging || event.pointerId !== dragging.pointerId) return;
      applyPosition(event.clientX - dragging.offsetX, event.clientY - dragging.offsetY);
      event.preventDefault?.();
    }

    function onPointerDown(event) {
      if ((event.button != null && event.button !== 0) || event.isPrimary === false || isInteractive(event.target)) {
        return;
      }
      const rect = panel.getBoundingClientRect();
      dragging = {
        pointerId: event.pointerId,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
      };
      applyPosition(rect.left, rect.top);
      handle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', stopDragging);
      window.addEventListener('pointercancel', stopDragging);
      event.preventDefault?.();
    }

    function resetPosition(event) {
      if (isInteractive(event?.target)) return;
      dragging = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      panel.style.left = '';
      panel.style.top = '';
      panel.style.right = '';
      panel.style.bottom = '';
      panel.style.transform = '';
      removeSavedPosition();
      event?.preventDefault?.();
    }

    function keepInsideViewport() {
      if (!panel.style.left || !panel.style.top) return;
      const rect = panel.getBoundingClientRect();
      const styledLeft = parseFloat(panel.style.left);
      const styledTop = parseFloat(panel.style.top);
      const position = applyPosition(
        Number.isFinite(styledLeft) ? styledLeft : rect.left,
        Number.isFinite(styledTop) ? styledTop : rect.top,
      );
      savePosition(position);
    }

    handle.dataset.piwDraggableHandle = 'true';
    handle.title = handle.title || 'Arraste para mover · duplo clique para restaurar';
    handle.style.cursor = 'move';
    handle.style.touchAction = 'none';
    handle.style.userSelect = 'none';
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('dblclick', resetPosition);
    window.addEventListener('resize', keepInsideViewport);
    const visibilityObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (!panel.hidden) keepInsideViewport();
        })
      : null;
    visibilityObserver?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    const savedPosition = readPosition();
    if (savedPosition) applyPosition(savedPosition.left, savedPosition.top);

    let active = true;
    const cleanup = () => {
      if (!active) return false;
      active = false;
      dragging = null;
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('dblclick', resetPosition);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      window.removeEventListener('resize', keepInsideViewport);
      visibilityObserver?.disconnect();
      handle.style.cursor = originalHandleStyle.cursor;
      handle.style.touchAction = originalHandleStyle.touchAction;
      handle.style.userSelect = originalHandleStyle.userSelect;
      delete handle.dataset.piwDraggableHandle;
      attachedPanels.delete(panel);
      return true;
    };
    attachedPanels.set(panel, cleanup);
    return cleanup;
  }

  if (namespace.uiMenu?.apiVersion === 1) {
    if (typeof namespace.uiMenu.makePanelDraggable !== 'function') {
      namespace.uiMenu.makePanelDraggable = createPanelDragHandler;
    }
    return;
  }

  const SIDEBAR_ID = 'script-sidebar';
  const GROUP_ID = 'piw-tools-sidebar-group';
  const STYLE_ID = 'piw-tools-menu-styles';
  const entries = new Map();
  let observer = null;
  let observerTimer = null;
  let domReadyListenerInstalled = false;
  let entriesDirty = false;

  function installStyles() {
    if (!document.documentElement || document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${SIDEBAR_ID} {
        position:fixed;left:8px;top:50%;transform:translateY(-50%);
        display:flex;flex-direction:column;align-items:center;gap:6px;
        padding:8px 6px;background:rgba(20,16,10,.85);
        border:2px solid rgb(120,90,40);border-radius:10px;
        z-index:9000;backdrop-filter:blur(4px);
      }
      #${GROUP_ID} { display:contents; }
      #${GROUP_ID} .piw-tools-sidebar-item {
        position:relative;
        display:inline-flex;align-items:center;justify-content:center;
        width:36px;height:36px;padding:0;background:transparent;border:0;
        border-radius:8px;box-shadow:none;color:#e2e8f0;font-size:17px;
        cursor:pointer;transition:background .15s;
      }
      #${GROUP_ID} .piw-tools-sidebar-item:hover,
      #${GROUP_ID} .piw-tools-sidebar-item:focus-visible {
        background:rgba(255,255,255,.12);
        outline:none;
      }
      [data-piw-draggable-handle="true"] {
        cursor:move;touch-action:none;user-select:none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getOrCreateSidebar() {
    let sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar) return sidebar;
    sidebar = document.createElement('div');
    sidebar.id = SIDEBAR_ID;
    sidebar.dataset.piwToolsHost = 'true';
    document.body.appendChild(sidebar);
    return sidebar;
  }

  function renderEntries(group) {
    group.replaceChildren();
    const sorted = [...entries.values()].sort((left, right) =>
      left.order - right.order || left.label.localeCompare(right.label),
    );
    for (const entry of sorted) {
      const item = document.createElement('button');
      item.id = entry.id;
      item.className = 'dock-btn piw-tools-sidebar-item';
      item.type = 'button';
      item.textContent = entry.icon;
      item.title = entry.label;
      item.setAttribute('aria-label', entry.label);
      item.addEventListener('click', entry.onClick);
      group.appendChild(item);
      entry.onMount?.(item);
    }
  }

  function createGroup(sidebar) {
    const group = document.createElement('span');
    group.id = GROUP_ID;
    sidebar.appendChild(group);
    return group;
  }

  function ensureMounted() {
    if (!document.body || entries.size === 0) return;
    installStyles();
    const sidebar = getOrCreateSidebar();
    let group = document.getElementById(GROUP_ID);
    let created = false;
    if (!group) {
      group = createGroup(sidebar);
      created = true;
    }
    else if (group.parentElement !== sidebar) sidebar.appendChild(group);
    if (created || entriesDirty) {
      renderEntries(group);
      entriesDirty = false;
    }
  }

  function scheduleMount() {
    if (!document.body) {
      if (!domReadyListenerInstalled) {
        domReadyListenerInstalled = true;
        document.addEventListener('DOMContentLoaded', () => {
          domReadyListenerInstalled = false;
          ensureMounted();
          startObserver();
        }, { once: true });
      }
      return;
    }
    if (observerTimer) return;
    observerTimer = setTimeout(() => {
      observerTimer = null;
      ensureMounted();
    }, 0);
    startObserver();
  }

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(() => {
      if (document.getElementById(GROUP_ID) || entries.size === 0) return;
      scheduleMount();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function removeEntry(id) {
    if (!entries.delete(id)) return false;
    document.getElementById(id)?.remove();
    if (entries.size > 0) {
      const group = document.getElementById(GROUP_ID);
      if (group) renderEntries(group);
      return true;
    }
    document.getElementById(GROUP_ID)?.remove();
    const sidebar = document.getElementById(SIDEBAR_ID);
    if (sidebar?.dataset.piwToolsHost === 'true' && sidebar.childElementCount === 0) sidebar.remove();
    return true;
  }

  namespace.uiMenu = {
    apiVersion: 1,
    register({ id, label, icon = '•', order = 100, onClick, onMount = null }) {
      if (!id || !label || typeof onClick !== 'function') {
        throw new TypeError('Registro de menu inválido.');
      }
      entries.set(String(id), {
        id: String(id),
        label: String(label),
        icon: String(icon),
        order: Number.isFinite(Number(order)) ? Number(order) : 100,
        onClick,
        onMount: typeof onMount === 'function' ? onMount : null,
      });
      entriesDirty = true;
      scheduleMount();
      let active = true;
      return () => {
        if (!active) return false;
        active = false;
        return removeEntry(String(id));
      };
    },
    refresh() {
      ensureMounted();
    },
    makePanelDraggable: createPanelDragHandler,
    status() {
      return {
        installed: true,
        entries: [...entries.keys()],
        mounted: Boolean(document.getElementById(GROUP_ID)),
        sharedSidebar: Boolean(document.getElementById(SIDEBAR_ID)),
      };
    },
  };
})();

(function() {
    'use strict';

(function installPiwHuntWatchdog() {
  'use strict';

  if (window.piwHuntWatchdog?.installed) {
    console.warn('[Hunt Watchdog] Já está instalado nesta página.');
    return;
  }

  const bridge = window.piwScripts?.wsBridge;
  const uiMenu = window.piwScripts?.uiMenu;
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[Hunt Watchdog] PIW WS Bridge v1 indisponível. Watchdog não instalado.');
    return;
  }
  if (!uiMenu || uiMenu.apiVersion !== 1) {
    console.warn('[Hunt Watchdog] PIW UI Menu v1 indisponível. Watchdog não instalado.');
    return;
  }

  const HUNT_SILENCE_MS = 10_000;
  const REENTRY_DELAY_MS = 500;
  const CHECK_INTERVAL_MS = 1_000;
  const RECOVERY_COOLDOWN_MS = 5_000;
  const STORAGE_KEY = 'piw_hunt_watchdog_v1';
  const HUNT_MESSAGE_TYPES = new Set([
    'field',
    'field-init',
    'field-kill',
    'poke-xp',
    'pending',
    'catch-result',
  ]);

  const saved = readSavedState();
  const state = {
    installed: true,
    enabled: true,
    socket: bridge.getSocket(),
    huntSlug: saved.huntSlug || null,
    huntActive: false,
    lastHuntMessageAt: 0,
    lastRecoveryAt: 0,
    transitioning: false,
    recoveries: 0,
    megaSableyeEscapes: 0,
    skipMegaSableye: saved.skipMegaSableye !== false,
  };
  let unsubscribeBridge = null;
  let unregisterMenu = null;
  let disposePanelDrag = null;

  function readSavedState() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveState() {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
      huntSlug: state.huntSlug,
      skipMegaSableye: state.skipMegaSableye,
    }));
  }

  function log(message, details) {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    console.log(`[Hunt Watchdog] ${message}${suffix}`);
  }

  function formatSilentTime(milliseconds) {
    if (milliseconds === null) return '—';
    return `${Math.max(0, milliseconds / 1000).toFixed(1)}s`;
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-hunt-watchdog-panel');
    const dockButton = document.querySelector('#piw-hunt-watchdog-button');
    if (dockButton) {
      dockButton.classList.toggle('phw-alert', state.transitioning);
      dockButton.classList.toggle('phw-off', !state.enabled);
      dockButton.title = state.enabled ? 'Hunt Watchdog ativo' : 'Hunt Watchdog pausado';
    }
    if (!panel) return;

    const socketOpen = state.socket?.readyState === WebSocket.OPEN;
    const silentForMs = state.lastHuntMessageAt ? Date.now() - state.lastHuntMessageAt : null;
    panel.querySelector('[data-phw="socket"]').textContent = socketOpen ? 'Conectado' : 'Aguardando';
    panel.querySelector('[data-phw="socket"]').className = socketOpen ? 'phw-good' : 'phw-warn';
    panel.querySelector('[data-phw="hunt"]').textContent = state.huntSlug || 'Não capturada';
    panel.querySelector('[data-phw="silence"]').textContent = formatSilentTime(silentForMs);
    panel.querySelector('[data-phw="recoveries"]').textContent = String(state.recoveries);
    panel.querySelector('[data-phw="sableye"]').textContent = String(state.megaSableyeEscapes);
    panel.querySelector('.phw-sableye').textContent = state.skipMegaSableye
      ? 'Pular Sableye: ligado'
      : 'Pular Sableye: desligado';
    panel.querySelector('.phw-sableye').classList.toggle('phw-disabled', !state.skipMegaSableye);
    panel.querySelector('[data-phw="status"]').textContent = state.transitioning
      ? 'Reconectando na hunt...'
      : state.enabled
        ? state.huntActive ? 'Monitorando hunt' : 'Aguardando entrada na hunt'
        : 'Monitoramento pausado';
    panel.querySelector('.phw-toggle').textContent = state.enabled ? 'Pausar' : 'Retomar';
    panel.querySelector('.phw-reconnect').disabled = !socketOpen || !state.huntActive || !state.huntSlug || state.transitioning;
  }

  function installPanelStyles() {
    if (document.querySelector('#piw-hunt-watchdog-styles')) return;
    const style = document.createElement('style');
    style.id = 'piw-hunt-watchdog-styles';
    style.textContent = `
      #piw-hunt-watchdog-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
      #piw-hunt-watchdog-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#48bb78;box-shadow:0 0 6px #48bb78; }
      #piw-hunt-watchdog-button.phw-alert::after { background:#f6ad55;box-shadow:0 0 7px #f6ad55; }
      #piw-hunt-watchdog-button.phw-off::after { background:#718096;box-shadow:none; }
      #piw-hunt-watchdog-panel[hidden] { display:none !important; }
      #piw-hunt-watchdog-panel { position:fixed;right:18px;top:140px;z-index:10021;width:280px;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
      #piw-hunt-watchdog-panel header { display:flex;align-items:center;gap:8px;padding:10px 12px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-hunt-watchdog-panel header span { flex:1; }
      #piw-hunt-watchdog-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
      #piw-hunt-watchdog-panel button:disabled { cursor:not-allowed;opacity:.45; }
      #piw-hunt-watchdog-panel .phw-close { width:28px;height:28px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:18px; }
      #piw-hunt-watchdog-panel .phw-body { padding:11px; }
      #piw-hunt-watchdog-panel .phw-state { margin-bottom:8px;padding:7px 9px;border-radius:6px;background:#0a1219;color:#90cdf4;text-align:center;font-weight:700; }
      #piw-hunt-watchdog-panel .phw-grid { display:grid;grid-template-columns:1fr 1fr;gap:6px; }
      #piw-hunt-watchdog-panel .phw-card { min-width:0;padding:7px 8px;border:1px solid #20394b;border-radius:7px;background:#101f2a; }
      #piw-hunt-watchdog-panel .phw-card small { display:block;color:#718096;font-size:10px;font-weight:800;text-transform:uppercase; }
      #piw-hunt-watchdog-panel .phw-card b { display:block;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #piw-hunt-watchdog-panel .phw-good { color:#68d391; }
      #piw-hunt-watchdog-panel .phw-warn { color:#f6ad55; }
      #piw-hunt-watchdog-panel .phw-actions { display:flex;gap:6px;margin-top:9px; }
      #piw-hunt-watchdog-panel .phw-actions button { flex:1; }
      #piw-hunt-watchdog-panel .phw-reconnect { background:#176342;border-color:#299263; }
      #piw-hunt-watchdog-panel .phw-sableye { width:100%;margin-top:6px; }
      #piw-hunt-watchdog-panel .phw-sableye.phw-disabled { color:#a0aec0;background:#111c24;border-color:#2d3748; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createPanel() {
    if (document.querySelector('#piw-hunt-watchdog-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'piw-hunt-watchdog-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>📡 Hunt Watchdog</span><button class="phw-close" type="button">×</button></header>
      <div class="phw-body">
        <div class="phw-state" data-phw="status">Aguardando entrada na hunt</div>
        <div class="phw-grid">
          <div class="phw-card"><small>WebSocket</small><b data-phw="socket">Aguardando</b></div>
          <div class="phw-card"><small>Silêncio</small><b data-phw="silence">—</b></div>
          <div class="phw-card"><small>Hunt</small><b data-phw="hunt">Não capturada</b></div>
          <div class="phw-card"><small>Recuperações</small><b data-phw="recoveries">0</b></div>
          <div class="phw-card"><small>Mega Sableye</small><b data-phw="sableye">0</b></div>
          <div class="phw-card"><small>Limite</small><b>10 segundos</b></div>
        </div>
        <div class="phw-actions">
          <button class="phw-toggle" type="button">Pausar</button>
          <button class="phw-reconnect" type="button">Reconectar</button>
        </div>
        <button class="phw-sableye" type="button">Pular Sableye: ligado</button>
      </div>`;
    document.body.appendChild(panel);
    disposePanelDrag?.();
    disposePanelDrag = uiMenu.makePanelDraggable(panel, {
      storageKey: 'piw-hunt-watchdog-panel-position-v1',
    });
    panel.querySelector('.phw-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.phw-toggle').addEventListener('click', () => {
      if (state.enabled) window.piwHuntWatchdog.stop();
      else window.piwHuntWatchdog.start();
      renderPanel();
    });
    panel.querySelector('.phw-reconnect').addEventListener('click', () => window.piwHuntWatchdog.reconnect());
    panel.querySelector('.phw-sableye').addEventListener('click', () => {
      window.piwHuntWatchdog.setMegaSableyeSkip(!state.skipMegaSableye);
    });
  }

  function registerSidebarButton() {
    if (unregisterMenu) return;
    unregisterMenu = uiMenu.register({
      id: 'piw-hunt-watchdog-button',
      label: 'Auto Reconnect',
      icon: '📡',
      order: 20,
      onMount: renderPanel,
      onClick() {
        const panel = document.querySelector('#piw-hunt-watchdog-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        renderPanel();
      },
    });
    renderPanel();
  }

  function installInterface() {
    installPanelStyles();
    createPanel();
    registerSidebarButton();
    let observerPending = false;
    const observer = new MutationObserver(() => {
      if (observerPending) return;
      observerPending = true;
      setTimeout(() => {
        observerPending = false;
        registerSidebarButton();
      }, 150);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return observer;
  }

  function sendDirect(payload) {
    state.socket = bridge.getSocket();
    if (!bridge.isOpen()) {
      log('Não foi possível enviar: WebSocket indisponível.');
      return false;
    }
    return bridge.sendJson(payload);
  }

  function mobIsMegaSableye(mob) {
    let text;
    try {
      text = JSON.stringify(mob);
    } catch {
      return false;
    }
    const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return normalized.includes('mega') && normalized.includes('sableye');
  }

  function fieldHasMegaSableye(message) {
    return message?.type === 'field' && Array.isArray(message.mobs) && message.mobs.some(mobIsMegaSableye);
  }

  function observeOutgoing(message) {
    if (message?.type === 'enter-hunt' && message.slug) {
      state.huntSlug = String(message.slug);
      state.huntActive = true;
      state.lastHuntMessageAt = Date.now();
      saveState();
      log('Hunt acompanhada.', { slug: state.huntSlug });
    } else if (message?.type === 'leave-hunt' && !state.transitioning) {
      state.huntActive = false;
      state.huntSlug = null;
      state.lastHuntMessageAt = 0;
      saveState();
      log('Saída manual detectada; watchdog aguardando nova hunt.');
    }
  }

  async function recoverHunt(reason) {
    const now = Date.now();
    if (!state.enabled || !state.huntActive || !state.huntSlug || state.transitioning) return false;
    if (now - state.lastRecoveryAt < RECOVERY_COOLDOWN_MS) return false;

    state.transitioning = true;
    state.lastRecoveryAt = now;
    state.lastHuntMessageAt = now;
    if (reason === 'mega-sableye') state.megaSableyeEscapes += 1;
    else state.recoveries += 1;

    log('Reiniciando hunt.', { reason, slug: state.huntSlug });
    sendDirect({ type: 'leave-hunt' });

    await new Promise((resolve) => setTimeout(resolve, REENTRY_DELAY_MS));
    const entered = state.enabled && state.huntActive
      ? sendDirect({ type: 'enter-hunt', slug: state.huntSlug })
      : false;
    state.lastHuntMessageAt = Date.now();
    state.transitioning = false;
    return entered;
  }

  function handleMessage(message) {
    if (!state.enabled) return;
    if (!message?.type) return;

    if (HUNT_MESSAGE_TYPES.has(message.type)) {
      state.lastHuntMessageAt = Date.now();
      // Se o script foi reinjetado e já conhecia o slug salvo, a primeira mensagem
      // de hunt volta a habilitar a supervisão sem enviar nada ao jogo.
      if (state.huntSlug) state.huntActive = true;
    }

    if (state.skipMegaSableye && fieldHasMegaSableye(message)) {
      recoverHunt('mega-sableye');
    }
  }

  unsubscribeBridge = bridge.subscribe({
    socket(event) {
      state.socket = event.socket;
      log('WebSocket do jogo capturado.');
    },
    open(event) {
      state.socket = event.socket;
    },
    close(event) {
      if (state.socket === event.socket) state.socket = null;
    },
    incoming(event) {
      handleMessage(event.message);
    },
    outgoing(event) {
      observeOutgoing(event.message);
    },
  });

  const watchdogTimer = setInterval(() => {
    renderPanel();
    if (!state.enabled || !state.huntActive || state.transitioning || !state.huntSlug) return;
    if (!state.lastHuntMessageAt) return;
    if (Date.now() - state.lastHuntMessageAt >= HUNT_SILENCE_MS) recoverHunt('hunt-silent-10s');
  }, CHECK_INTERVAL_MS);

  const interfaceObserver = document.body ? installInterface() : null;

  window.piwHuntWatchdog = {
    installed: true,
    status() {
      return {
        enabled: state.enabled,
        socketOpen: state.socket?.readyState === WebSocket.OPEN,
        huntSlug: state.huntSlug,
        huntActive: state.huntActive,
        silentForMs: state.lastHuntMessageAt ? Date.now() - state.lastHuntMessageAt : null,
        transitioning: state.transitioning,
        recoveries: state.recoveries,
        megaSableyeEscapes: state.megaSableyeEscapes,
        skipMegaSableye: state.skipMegaSableye,
      };
    },
    setHunt(slug) {
      state.huntSlug = String(slug || '').trim() || null;
      state.huntActive = Boolean(state.huntSlug);
      state.lastHuntMessageAt = Date.now();
      saveState();
      return this.status();
    },
    setMegaSableyeSkip(enabled) {
      state.skipMegaSableye = Boolean(enabled);
      saveState();
      renderPanel();
      log(`Fuga do Mega Sableye ${state.skipMegaSableye ? 'ativada' : 'desativada'}.`);
      return this.status();
    },
    reconnect() {
      return recoverHunt('manual-test');
    },
    stop() {
      state.enabled = false;
      log('Supervisão pausada.');
    },
    start() {
      state.enabled = true;
      state.lastHuntMessageAt = Date.now();
      log('Supervisão ativada.');
      return this.status();
    },
    uninstall() {
      clearInterval(watchdogTimer);
      interfaceObserver?.disconnect();
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      unregisterMenu?.();
      unregisterMenu = null;
      disposePanelDrag?.();
      disposePanelDrag = null;
      state.enabled = false;
      document.querySelector('#piw-hunt-watchdog-panel')?.remove();
      document.querySelector('#piw-hunt-watchdog-button')?.remove();
      document.querySelector('#piw-hunt-watchdog-styles')?.remove();
      delete window.piwHuntWatchdog;
      log('Removido.');
    },
  };

  log('Instalado. O slug será capturado na próxima entrada em uma hunt.');
})();

})();
