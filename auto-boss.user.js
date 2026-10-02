// ==UserScript==
// @name         Auto Boss Farmer PIW
// @version      1.6.4
// @description  Painel para farmar Bosses com HUD, cura entre lutas e parada agendada.
// @author       Luis
// @match        https://poke.idleworld.online/play
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-boss.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.
// Fonte: src/auto-boss.js

// Shared module: src/shared/panel-interaction.js
(function installPanelInteraction() {
  'use strict';

  const namespace = window.pokeScripts = window.pokeScripts || {};
  if (namespace.panelInteraction?.apiVersion === 1) return;
  const attachedPanels = new WeakMap();

  function createPanelDragHandler(panel, {
    storageKey,
    sizeStorageKey = null,
    handle = panel?.querySelector?.('header'),
    margin = 8,
    minWidth = 240,
    minHeight = 160,
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
    const body = Array.from(panel.children || []).find((child) => child !== handle) || null;
    const originalPanelStyle = {
      display: panel.style.display,
      flexDirection: panel.style.flexDirection,
      overflow: panel.style.overflow,
      width: panel.style.width,
      height: panel.style.height,
      maxWidth: panel.style.maxWidth,
      maxHeight: panel.style.maxHeight,
    };
    const originalHandleFlex = handle.style.flex;
    const originalBodyStyle = body ? {
      flex: body.style.flex,
      minHeight: body.style.minHeight,
      maxHeight: body.style.maxHeight,
      overflow: body.style.overflow,
    } : null;
    const safeMinWidth = Math.max(160, Number(minWidth) || 240);
    const safeMinHeight = Math.max(100, Number(minHeight) || 160);
    let dragging = null;
    let resizing = null;
    let resizeHandle = null;
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

    function readSize() {
      if (!sizeStorageKey) return null;
      try {
        const saved = JSON.parse(sessionStorage.getItem(sizeStorageKey) || 'null');
        const width = Number(saved?.width);
        const height = Number(saved?.height);
        return Number.isFinite(width) && Number.isFinite(height) ? { width, height } : null;
      } catch {
        return null;
      }
    }

    function saveSize(size) {
      if (!sizeStorageKey) return;
      try {
        sessionStorage.setItem(sizeStorageKey, JSON.stringify(size));
      } catch {
        // O redimensionamento continua funcionando mesmo quando o storage está indisponível.
      }
    }

    function removeSavedSize() {
      if (!sizeStorageKey) return;
      try {
        sessionStorage.removeItem(sizeStorageKey);
      } catch {
        // O tamanho visual ainda pode ser restaurado sem acesso ao storage.
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

    function clampSize(width, height) {
      const rect = panel.getBoundingClientRect();
      const viewportWidth = Number(window.innerWidth) || document.documentElement?.clientWidth || width;
      const viewportHeight = Number(window.innerHeight) || document.documentElement?.clientHeight || height;
      const anchoredLeft = panel.style.left ? rect.left : safeMargin;
      const anchoredTop = panel.style.top ? rect.top : safeMargin;
      const maxWidth = Math.max(safeMinWidth, viewportWidth - Math.max(safeMargin, anchoredLeft) - safeMargin);
      const maxHeight = Math.max(safeMinHeight, viewportHeight - Math.max(safeMargin, anchoredTop) - safeMargin);
      return {
        width: Math.round(Math.min(maxWidth, Math.max(safeMinWidth, Number(width) || safeMinWidth))),
        height: Math.round(Math.min(maxHeight, Math.max(safeMinHeight, Number(height) || safeMinHeight))),
      };
    }

    function applySize(width, height, { persist = false } = {}) {
      const size = clampSize(width, height);
      panel.style.width = `${size.width}px`;
      panel.style.height = `${size.height}px`;
      panel.style.maxWidth = `calc(100vw - ${safeMargin * 2}px)`;
      panel.style.maxHeight = `calc(100vh - ${safeMargin * 2}px)`;
      if (persist) saveSize(size);
      return size;
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

    function stopResizing(event) {
      if (!resizing || (event?.pointerId != null && event.pointerId !== resizing.pointerId)) return;
      const size = applySize(panel.getBoundingClientRect().width, panel.getBoundingClientRect().height);
      saveSize(size);
      const position = applyPosition(panel.getBoundingClientRect().left, panel.getBoundingClientRect().top);
      savePosition(position);
      resizing = null;
      window.removeEventListener('pointermove', onResizePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
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

    function onResizePointerMove(event) {
      if (!resizing || event.pointerId !== resizing.pointerId) return;
      applySize(
        resizing.width + event.clientX - resizing.startX,
        resizing.height + event.clientY - resizing.startY,
      );
      event.preventDefault?.();
    }

    function onResizePointerDown(event) {
      if ((event.button != null && event.button !== 0) || event.isPrimary === false) return;
      const rect = panel.getBoundingClientRect();
      applyPosition(rect.left, rect.top);
      resizing = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        width: rect.width,
        height: rect.height,
      };
      resizeHandle.setPointerCapture?.(event.pointerId);
      window.addEventListener('pointermove', onResizePointerMove);
      window.addEventListener('pointerup', stopResizing);
      window.addEventListener('pointercancel', stopResizing);
      event.stopPropagation?.();
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

    function resetSize(event) {
      resizing = null;
      window.removeEventListener('pointermove', onResizePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      panel.style.width = originalPanelStyle.width;
      panel.style.height = originalPanelStyle.height;
      panel.style.maxWidth = originalPanelStyle.maxWidth;
      panel.style.maxHeight = originalPanelStyle.maxHeight;
      removeSavedSize();
      keepInsideViewport();
      event?.stopPropagation?.();
      event?.preventDefault?.();
    }

    function keepInsideViewport() {
      if (sizeStorageKey && panel.style.width && panel.style.height) {
        const rect = panel.getBoundingClientRect();
        applySize(rect.width, rect.height, { persist: true });
      }
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
    if (sizeStorageKey) {
      panel.dataset.piwResizablePanel = 'true';
      panel.style.display = 'flex';
      panel.style.flexDirection = 'column';
      panel.style.overflow = 'hidden';
      handle.style.flex = '0 0 auto';
      if (body) {
        body.style.flex = '1 1 auto';
        body.style.minHeight = '0';
        body.style.maxHeight = 'none';
        body.style.overflow = 'auto';
      }
      resizeHandle = document.createElement('span');
      resizeHandle.dataset.piwResizeHandle = 'true';
      resizeHandle.title = 'Arraste para redimensionar · duplo clique para restaurar';
      resizeHandle.setAttribute('aria-hidden', 'true');
      Object.assign(resizeHandle.style, {
        position: 'absolute',
        right: '1px',
        bottom: '1px',
        width: '15px',
        height: '15px',
        zIndex: '3',
        cursor: 'nwse-resize',
        touchAction: 'none',
        userSelect: 'none',
        background: 'linear-gradient(135deg, transparent 0 45%, #718096 46% 54%, transparent 55% 65%, #a0aec0 66% 74%, transparent 75%)',
      });
      resizeHandle.addEventListener('pointerdown', onResizePointerDown);
      resizeHandle.addEventListener('dblclick', resetSize);
      panel.appendChild(resizeHandle);
    }
    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('dblclick', resetPosition);
    window.addEventListener('resize', keepInsideViewport);
    const visibilityObserver = typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (!panel.hidden) keepInsideViewport();
        })
      : null;
    visibilityObserver?.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
    const savedSize = readSize();
    if (savedSize) applySize(savedSize.width, savedSize.height);
    const savedPosition = readPosition();
    if (savedPosition) applyPosition(savedPosition.left, savedPosition.top);

    let active = true;
    const cleanup = () => {
      if (!active) return false;
      active = false;
      dragging = null;
      resizing = null;
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('dblclick', resetPosition);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
      window.removeEventListener('pointermove', onResizePointerMove);
      window.removeEventListener('pointerup', stopResizing);
      window.removeEventListener('pointercancel', stopResizing);
      window.removeEventListener('resize', keepInsideViewport);
      visibilityObserver?.disconnect();
      handle.style.cursor = originalHandleStyle.cursor;
      handle.style.touchAction = originalHandleStyle.touchAction;
      handle.style.userSelect = originalHandleStyle.userSelect;
      handle.style.flex = originalHandleFlex;
      resizeHandle?.removeEventListener('pointerdown', onResizePointerDown);
      resizeHandle?.removeEventListener('dblclick', resetSize);
      resizeHandle?.remove();
      panel.style.display = originalPanelStyle.display;
      panel.style.flexDirection = originalPanelStyle.flexDirection;
      panel.style.overflow = originalPanelStyle.overflow;
      panel.style.width = originalPanelStyle.width;
      panel.style.height = originalPanelStyle.height;
      panel.style.maxWidth = originalPanelStyle.maxWidth;
      panel.style.maxHeight = originalPanelStyle.maxHeight;
      if (body && originalBodyStyle) {
        body.style.flex = originalBodyStyle.flex;
        body.style.minHeight = originalBodyStyle.minHeight;
        body.style.maxHeight = originalBodyStyle.maxHeight;
        body.style.overflow = originalBodyStyle.overflow;
      }
      delete handle.dataset.piwDraggableHandle;
      delete panel.dataset.piwResizablePanel;
      attachedPanels.delete(panel);
      return true;
    };
    attachedPanels.set(panel, cleanup);
    return cleanup;
  }


  namespace.panelInteraction = { apiVersion: 1, makePanelDraggable: createPanelDragHandler };
})();

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
  const createPanelDragHandler = window.pokeScripts.panelInteraction.makePanelDraggable;

  if (namespace.uiMenu?.apiVersion === 1) {
    if (
      typeof namespace.uiMenu.makePanelDraggable !== 'function'
      || Number(namespace.uiMenu.panelInteractionVersion) < 2
    ) {
      namespace.uiMenu.makePanelDraggable = createPanelDragHandler;
      namespace.uiMenu.panelInteractionVersion = 2;
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
    panelInteractionVersion: 2,
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

(function installPiwBossFarm() {
    'use strict';

    if (window.piwBossFarm?.installed || window.piwBossFarmInjected) return;

    const bridge = window.piwScripts?.wsBridge;
    const uiMenu = window.piwScripts?.uiMenu;
    if (!bridge || bridge.apiVersion !== 1) {
        console.warn('[PIW Auto Boss] PIW WS Bridge v1 indisponível. Auto Boss não instalado.');
        return;
    }
    if (!uiMenu || uiMenu.apiVersion !== 1) {
        console.warn('[PIW Auto Boss] PIW UI Menu v1 indisponível. Auto Boss não instalado.');
        return;
    }

    window.piwBossFarmInjected = true;

    const STORAGE_KEY = 'piw_boss_farm_v1';
    const TRANSITION_DELAY_MS = 1500;
    const WATCHDOG_SILENCE_MS = 45000;
    const WATCHDOG_CHECK_MS = 5000;
    const BOSS_DOM_TIMEOUT_MS = 5000;
    const HUNT_ENTRY_TIMEOUT_MS = 4000;
    const DOM_RETRY_MS = 100;
    const BOSS_NAMES = ['Giant Cruel', 'Ancient Aero'];
    // Preserve a entrada padrão já usada pelo Auto Boss. Outros slugs vêm do jogo.
    const DEFAULT_BOSS_SLUGS = { 'Giant Cruel': 'cruel_boss' };

    let state = readState();
    let gameSocket = null;
    let isTransitioning = false;
    let transitionGeneration = 0;
    let transitionTimer = null;
    let navigationInProgress = false;
    let navigationResolve = null;
    let huntEntryWaiter = null;
    let knownBossSlug = null;
    let lastActivity = Date.now();
    let watchdogTimer = null;
    let resultMonitorTimer = null;
    let interfaceObserver = null;
    let observerTimer = null;
    let unregisterMenu = null;
    let unsubscribeBridge = null;
    let disposePanelDrag = null;

    function blankState() {
        return {
            slug: 'cruel_boss',
            bossName: 'Giant Cruel',
            bossSlugs: readBossSlugs(),
            useWebSocket: false,
            wins: 0,
            losses: 0,
            running: false,
            stopping: false,
            lastMessage: 'Aguardando inicialização...',
            lootHistory: []
        };
    }

    function normalizeCount(value) {
        const number = Number(value);
        return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
    }

    function readBossSlugs(saved) {
        return Object.fromEntries(BOSS_NAMES.map(name => {
            const slug = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved[name] : null;
            return [name, typeof slug === 'string' && slug.trim() ? slug : DEFAULT_BOSS_SLUGS[name] || null];
        }));
    }

    function readState() {
        try {
            const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
            if (!saved || typeof saved !== 'object') return blankState();
            const bossName = BOSS_NAMES.includes(saved.bossName) ? saved.bossName : 'Giant Cruel';
            const bossSlugs = readBossSlugs(saved.bossSlugs);
            const lootHistory = Array.isArray(saved.lootHistory)
                ? saved.lootHistory.filter(item => typeof item === 'string').slice(0, 10)
                : [];
            return {
                // O campo livre antigo não vinculava slug ao nome. Não atribua seu valor ao Aero.
                slug: bossSlugs[bossName],
                bossName,
                bossSlugs,
                useWebSocket: saved.useWebSocket === true,
                wins: normalizeCount(saved.wins),
                losses: normalizeCount(saved.losses),
                running: false,
                stopping: false,
                lastMessage: typeof saved.lastMessage === 'string'
                    ? saved.lastMessage
                    : 'Aguardando inicialização...',
                lootHistory
            };
        } catch {
            return blankState();
        }
    }

    function saveState() {
        try {
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                slug: state.slug,
                bossName: state.bossName,
                bossSlugs: state.bossSlugs,
                useWebSocket: state.useWebSocket,
                wins: state.wins,
                losses: state.losses,
                lastMessage: state.lastMessage,
                lootHistory: state.lootHistory
            }));
        } catch (error) {
            console.warn('[PIW Auto Boss] Não foi possível salvar o estado da aba.', error);
        }
    }

    function getStatus() {
        return {
            running: state.running,
            stopping: state.stopping,
            transitioning: isTransitioning,
            socketOpen: gameSocket?.readyState === WebSocket.OPEN,
            slug: state.slug,
            bossName: state.bossName,
            bossSlugs: { ...state.bossSlugs },
            webSocketAvailable: Boolean(state.bossSlugs[state.bossName]),
            useWebSocket: state.useWebSocket,
            lastMessage: state.lastMessage,
            wins: state.wins,
            losses: state.losses,
            lastActivityAt: lastActivity,
            lootHistory: [...state.lootHistory]
        };
    }

    function clearWatchdog() {
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = null;
        if (resultMonitorTimer) clearInterval(resultMonitorTimer);
        resultMonitorTimer = null;
    }

    function cancelTransition() {
        transitionGeneration += 1;
        if (transitionTimer) clearTimeout(transitionTimer);
        transitionTimer = null;
        navigationResolve?.(false);
        navigationResolve = null;
        resolveHuntEntry(false);
        navigationInProgress = false;
        isTransitioning = false;
    }

    function resolveHuntEntry(confirmed) {
        const waiter = huntEntryWaiter;
        if (!waiter) return;
        clearTimeout(waiter.timer);
        huntEntryWaiter = null;
        waiter.resolve(Boolean(confirmed));
    }

    function waitDuringNavigation(delayMs, generation) {
        return new Promise(resolve => {
            navigationResolve = resolve;
            transitionTimer = setTimeout(() => {
                transitionTimer = null;
                navigationResolve = null;
                resolve((state.running || isTransitioning) && generation === transitionGeneration);
            }, delayMs);
        });
    }

    async function waitForDom(find, timeoutMs, generation) {
        const deadline = Date.now() + timeoutMs;
        while ((state.running || isTransitioning) && generation === transitionGeneration) {
            const found = find();
            if (found) return found;
            if (Date.now() >= deadline) return null;
            if (!await waitDuringNavigation(DOM_RETRY_MS, generation)) return null;
        }
        return null;
    }

    function normalizeBossName(value) {
        return String(value || '').replace(/^\s*⚔️?\s*/, '').trim();
    }

    function isElementVisible(element) {
        return Boolean(element) && (
            typeof getComputedStyle !== 'function' || getComputedStyle(element).display !== 'none'
        );
    }

    function getSelectedBossChallenge(bossName) {
        const bossWindow = document.querySelector('.boss-window:not(.bvic-window)');
        const selected = Array.from(bossWindow?.querySelectorAll('button.boss-litem') || [])
            .find(item => item.matches('.on')
                && normalizeBossName(item.querySelector('.boss-lname')?.textContent) === bossName);
        if (!selected || normalizeBossName(bossWindow.querySelector('.boss-hname')?.textContent) !== bossName) return null;
        const challenge = bossWindow.querySelector('button.boss-challenge');
        return isElementVisible(challenge) ? challenge : null;
    }

    async function locateBossChallenge(bossName, generation) {
        if (document.querySelector('.bvic-window')) throw new Error('Há uma recompensa pendente. Confirme-a no jogo antes de iniciar.');
        if (!isElementVisible(document.querySelector('.boss-window:not(.bvic-window)'))) {
            const bossesButton = document.querySelector('button[data-guide="dock-bosses"]');
            if (!bossesButton || bossesButton.disabled) throw new Error('Botão Bosses indisponível.');
            bossesButton.click();
            const opened = await waitForDom(() => {
                const candidate = document.querySelector('.boss-window:not(.bvic-window)');
                return isElementVisible(candidate) ? candidate : null;
            }, BOSS_DOM_TIMEOUT_MS, generation);
            if (!opened) return null;
        }

        const bossesTab = Array.from(document.querySelector('.boss-window:not(.bvic-window)')?.querySelectorAll('button.mk-tab') || [])
            .find(tab => tab.textContent.trim() === 'Bosses');
        if (bossesTab && !bossesTab.matches('.on')) bossesTab.click();

        const boss = await waitForDom(() => {
            const bossWindow = document.querySelector('.boss-window:not(.bvic-window)');
            return Array.from(bossWindow?.querySelectorAll('button.boss-litem') || [])
                .find(item => normalizeBossName(item.querySelector('.boss-lname')?.textContent) === bossName);
        }, BOSS_DOM_TIMEOUT_MS, generation);
        if (!boss || !state.running || generation !== transitionGeneration) return null;
        if (boss.disabled || boss.matches('.soon')) throw new Error(`${bossName} está indisponível.`);
        boss.click();

        // A lista só seleciona o boss. Confira o detalhe antes do clique que consome a entrada.
        return waitForDom(() => getSelectedBossChallenge(bossName), BOSS_DOM_TIMEOUT_MS, generation);
    }

    function waitForHuntEntry(bossName, generation) {
        resolveHuntEntry(false);
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                if (huntEntryWaiter?.timer !== timer) return;
                huntEntryWaiter = null;
                resolve(false);
            }, HUNT_ENTRY_TIMEOUT_MS);
            huntEntryWaiter = { bossName, generation, timer, resolve, clicked: false };
        });
    }

    async function enterBossThroughWindow(generation) {
        try {
            const challenge = await locateBossChallenge(state.bossName, generation);
            if (!state.running || generation !== transitionGeneration) return;
            if (!challenge) throw new Error(`Não foi possível preparar o desafio de ${state.bossName} na janela Bosses.`);
            if (getSelectedBossChallenge(state.bossName) !== challenge) throw new Error('A seleção do boss mudou antes do desafio.');
            if (challenge.disabled) throw new Error('Challenge Boss está desabilitado. Confira nível, time e Boss Tokens no jogo.');
            const confirmation = waitForHuntEntry(state.bossName, generation);
            huntEntryWaiter.clicked = true;
            challenge.click();
            const confirmed = await confirmation;
            if (!state.running || generation !== transitionGeneration) return;
            if (!confirmed) throw new Error(`O jogo não confirmou a entrada em ${state.bossName}. Não haverá nova tentativa automática.`);
            navigationInProgress = false;
            isTransitioning = false;
            lastActivity = Date.now();
            setMessage(`⚔️ Luta iniciada pelo botão Challenge Boss: ${state.bossName}`);
            saveState();
            renderPanel();
        } catch (error) {
            if (generation !== transitionGeneration) return;
            pauseFarm(`⚠️ ${error?.message || String(error)} Automação pausada.`);
        }
    }

    function enterBoss() {
        if (state.useWebSocket) {
            if (!sendWs({ type: 'enter-hunt', slug: state.slug })) {
                pauseFarm('⚠️ Não foi possível enviar enter-hunt. Automação pausada.');
                return false;
            }
            lastActivity = Date.now();
            setMessage(`⚔️ Luta iniciada via WebSocket em: ${state.slug}`);
            return true;
        }
        isTransitioning = true;
        navigationInProgress = true;
        const generation = ++transitionGeneration;
        setMessage(`Abrindo ${state.bossName} pela janela Bosses...`);
        void enterBossThroughWindow(generation);
        return true;
    }

    function scheduleTransitionStep(generation, callback) {
        transitionTimer = setTimeout(() => {
            transitionTimer = null;
            if (generation !== transitionGeneration) return;
            callback();
        }, TRANSITION_DELAY_MS);
    }

    function pauseFarm(message) {
        clearWatchdog();
        cancelTransition();
        state.running = false;
        state.stopping = false;
        setMessage(message, true);
        saveState();
        renderPanel();
    }

    function startWatchdog() {
        clearWatchdog();
        if (!state.useWebSocket) {
            resultMonitorTimer = setInterval(() => {
                if (!state.running || isTransitioning) return;
                const victory = getBossVictory();
                if (!victory) return;
                const bossLoot = Array.from(victory.querySelectorAll('.bvic-chip')).map(chip => ({
                    name: chip.querySelector('.bvic-chip-name')?.textContent,
                    qty: Number(chip.querySelector('.bvic-chip-qty')?.textContent.replace('×', '').trim()),
                }));
                finishOutcome({ bossOutcome: 'won', bossLoot });
            }, 500);
        }
        watchdogTimer = setInterval(() => {
            if (!state.running || isTransitioning) return;
            if (Date.now() - lastActivity <= WATCHDOG_SILENCE_MS) return;
            pauseFarm('⚠️ Boss sem mensagens de batalha por 45 segundos. Automação pausada.');
        }, WATCHDOG_CHECK_MS);
    }

    function adoptSocket(socket) {
        if (!socket || gameSocket === socket) return;
        const replacedActiveSocket = Boolean(gameSocket && (state.running || isTransitioning));
        if (replacedActiveSocket) {
            pauseFarm('⚠️ O WebSocket foi substituído. Automação pausada sem iniciar outro Boss.');
        }
        gameSocket = socket;
        if (!replacedActiveSocket && !state.running && !isTransitioning) {
            setMessage('✅ Conexão capturada! Pronto para iniciar.');
            renderPanel();
        }
    }

    function sendWs(payload) {
        gameSocket = bridge.getSocket();
        if (!gameSocket || !bridge.isOpen()) return false;
        const sent = bridge.sendJson(payload);
        if (!sent) {
            console.warn('[PIW Auto Boss] Falha ao enviar mensagem.', { type: payload?.type });
        }
        return sent;
    }

    function buildLootText(message) {
        if (!Array.isArray(message.bossLoot) || message.bossLoot.length === 0) return 'Sem loot';
        return message.bossLoot.map(item => {
            const quantity = Number.isFinite(Number(item?.qty)) ? Number(item.qty) : 0;
            const name = typeof item?.name === 'string' ? item.name : 'Item desconhecido';
            return `${quantity}x ${name}`;
        }).join(', ');
    }

    function failOutcomeCleanup(message) {
        pauseFarm(`⚠️ ${message} Automação pausada para evitar uma transição incorreta.`);
    }

    function getBossVictory() {
        const victory = document.querySelector('.bvic-window');
        return isElementVisible(victory)
            && victory.querySelector('.bvic-desc b')?.textContent.trim() === state.bossName ? victory : null;
    }

    function teamIsHealed() {
        const team = Array.from(document.querySelectorAll('.phud-mon'));
        return team.length > 0 && team.every(mon => {
            const hp = mon.querySelector('.sbar-hp .sbar-txt')?.textContent.match(/^(\d+)\/(\d+)$/);
            return hp && Number(hp[2]) > 0 && hp[1] === hp[2];
        });
    }

    function completeOutcome(won) {
        isTransitioning = false;
        if (won && state.running && !state.stopping) {
            enterBoss();
        } else {
            state.running = false;
            state.stopping = false;
            clearWatchdog();
            setMessage(won
                ? '🛑 Automação encerrada após confirmar a recompensa e curar o time.'
                : '🛑 Automação pausada após derrota. Inicie manualmente para retomar.', !won);
        }
        saveState();
        renderPanel();
    }

    async function finishOutcomeThroughWindow(generation) {
        try {
            const victory = await waitForDom(getBossVictory, BOSS_DOM_TIMEOUT_MS, generation);
            if (generation !== transitionGeneration) return;
            const ok = victory?.querySelector('button.bvic-ok');
            if (!ok || ok.disabled) throw new Error('A janela de vitória do boss selecionado não está pronta.');
            ok.click();
            const closed = await waitForDom(() => !document.querySelector('.bvic-window'), BOSS_DOM_TIMEOUT_MS, generation);
            if (generation !== transitionGeneration) return;
            if (!closed) throw new Error('O jogo não fechou a recompensa após OK.');

            // Nesta captura, o primeiro Conversar abriu Nurse Joy. Nunca cure sem confirmar o nome.
            let dialog = document.querySelector('.npc-dialog');
            if (!dialog) {
                const talk = await waitForDom(() => Array.from(document.querySelectorAll('button.npc-plate-btn'))
                    .find(button => button.textContent.trim() === 'Conversar'), BOSS_DOM_TIMEOUT_MS, generation);
                if (generation !== transitionGeneration) return;
                if (!talk || talk.disabled) throw new Error('Conversa da Nurse Joy indisponível em Cerulean.');
                talk.click();
                dialog = await waitForDom(() => document.querySelector('.npc-dialog'), BOSS_DOM_TIMEOUT_MS, generation);
            }
            if (generation !== transitionGeneration) return;
            if (dialog?.querySelector('.npc-dlg-name')?.textContent.trim() !== 'Nurse Joy') {
                throw new Error('O NPC aberto não é Nurse Joy. Nenhuma cura será enviada.');
            }
            const heal = Array.from(dialog.querySelectorAll('button.npc-dlg-btn'))
                .find(button => button.textContent.trim() === '💊 Curar equipe');
            if (!heal || heal.disabled) throw new Error('Curar equipe está indisponível.');
            heal.click();
            // HP já estava cheio antes de OK na captura: exigir também o encerramento do diálogo.
            const healed = await waitForDom(() => !document.querySelector('.npc-dialog') && teamIsHealed(),
                BOSS_DOM_TIMEOUT_MS, generation);
            if (generation !== transitionGeneration) return;
            if (!healed) throw new Error('A interface não confirmou o encerramento da cura e HP completo.');
            completeOutcome(true);
        } catch (error) {
            if (generation !== transitionGeneration) return;
            failOutcomeCleanup(error?.message || String(error));
        }
    }

    function finishOutcome(message) {
        isTransitioning = true;
        const generation = ++transitionGeneration;
        const won = message.bossOutcome === 'won';

        if (won) {
            state.wins += 1;
            const time = new Date().toLocaleTimeString('pt-BR');
            state.lootHistory.unshift(`[${time}] ${buildLootText(message)}`);
            state.lootHistory = state.lootHistory.slice(0, 10);
            setMessage('🏆 Boss derrotado! Saindo para curar o time...');
        } else {
            state.losses += 1;
            state.running = false;
            state.stopping = false;
            clearWatchdog();
            setMessage('🔴 Derrota no Boss. Automação pausada; saindo para curar o time...', true);
        }

        saveState();
        renderPanel();
        if (!state.useWebSocket) {
            if (won) {
                void finishOutcomeThroughWindow(generation);
            } else {
                // O fluxo visual de derrota não foi capturado. Pause sem inventar ações de saída/cura.
                completeOutcome(false);
            }
            return;
        }
        if (!sendWs({ type: 'leave-hunt' })) {
            failOutcomeCleanup('Não foi possível enviar leave-hunt.');
            return;
        }

        scheduleTransitionStep(generation, () => {
            if (!sendWs({ type: 'joy-heal' })) {
                failOutcomeCleanup('Não foi possível enviar joy-heal.');
                return;
            }
            setMessage(won
                ? '🏥 Time curado. Preparando o próximo passo...'
                : '🏥 Time curado. Automação pausada após derrota.', !won);
            saveState();
            renderPanel();

            scheduleTransitionStep(generation, () => {
                isTransitioning = false;
                if (won && state.running && !state.stopping) {
                    if (!enterBoss()) return;
                } else {
                    state.running = false;
                    state.stopping = false;
                    clearWatchdog();
                    setMessage(won
                        ? '🛑 Automação encerrada após sair e curar o time.'
                        : '🛑 Automação pausada após derrota. Time curado; inicie manualmente para retomar.', !won);
                }
                saveState();
                renderPanel();
            });
        });
    }

    function handleSocketMessage(socket, message) {
        if (socket !== gameSocket || !state.running) return;
        if (message?.type !== 'field') return;
        lastActivity = Date.now();
        if (isTransitioning) return;

        // bossOutcome é a única confirmação de que a luta terminou.
        if (message.bossOutcome) {
            finishOutcome(message);
            return;
        }

        if (!Array.isArray(message.mobs) || message.mobs.length === 0) return;
        const bossMob = message.mobs[0];
        const hp = Number(bossMob?.hp);
        const maxHp = Number(bossMob?.maxHp);
        if (!Number.isFinite(hp) || !Number.isFinite(maxHp) || maxHp <= 0) return;
        const percentage = Math.max(0, Math.floor((hp / maxHp) * 100));
        setMessage(
            `⚔️ HP: ${hp.toLocaleString('pt-BR')} / ${maxHp.toLocaleString('pt-BR')} (${percentage}%)`
        );
    }

    function handleSocketClose(socket) {
        if (gameSocket !== socket) return;
        gameSocket = null;
        if (state.running || isTransitioning) {
            pauseFarm('⚠️ WebSocket fechado. Automação pausada sem reentrada automática.');
        } else {
            setMessage('⚠️ WebSocket fechado. Aguardando uma nova conexão.', true);
            renderPanel();
        }
    }

    unsubscribeBridge = bridge.subscribe({
        socket(event) {
            adoptSocket(event.socket);
        },
        open(event) {
            adoptSocket(event.socket);
        },
        close(event) {
            handleSocketClose(event.socket);
        },
        incoming(event) {
            handleSocketMessage(event.socket, event.message);
        },
        outgoing(event) {
            const waiter = huntEntryWaiter;
            if (event.socket !== gameSocket || !waiter) return;
            if (waiter.generation !== transitionGeneration) return;
            if (!waiter.clicked || waiter.bossName !== state.bossName) return;
            if (event.message?.type !== 'enter-hunt' || typeof event.message.slug !== 'string' || !event.message.slug) return;
            if (knownBossSlug && event.message.slug !== knownBossSlug) {
                pauseFarm('⚠️ O jogo enviou entrada em outra hunt durante o desafio. Automação pausada.');
                return;
            }
            // O HTML não informa slug: observe o envio do jogo, sem derivar ID do nome do boss.
            knownBossSlug = event.message.slug;
            state.slug = event.message.slug;
            state.bossSlugs[state.bossName] = event.message.slug;
            resolveHuntEntry(true);
        }
    });
    adoptSocket(bridge.getSocket());

    function startFarm() {
        if (state.running) return false;
        if (isTransitioning) {
            setMessage('Aguarde a finalização da cura atual antes de iniciar novamente.', true);
            return false;
        }
        if (!gameSocket || gameSocket.readyState !== WebSocket.OPEN) {
            setMessage('Aguarde o WebSocket do jogo conectar antes de iniciar.', true);
            renderPanel();
            return false;
        }

        const bossInput = document.querySelector('#pba-boss-name');
        const bossName = bossInput?.value ?? state.bossName;
        if (!BOSS_NAMES.includes(bossName)) {
            setMessage('Selecione um Boss disponível antes de iniciar.', true);
            renderPanel();
            return false;
        }
        const slug = state.bossSlugs[bossName];
        if (state.useWebSocket && !slug) {
            setMessage('Para usar este Boss via WebSocket, entre nele uma vez pelo modo de clique.', true);
            renderPanel();
            return false;
        }

        cancelTransition();
        state.bossName = bossName;
        state.slug = slug;
        knownBossSlug = null;
        state.running = true;
        state.stopping = false;
        lastActivity = Date.now();
        if (!enterBoss()) return false;
        startWatchdog();
        saveState();
        renderPanel();
        return true;
    }

    function stopFarm() {
        if (!state.running && !isTransitioning) return getStatus();
        if (navigationInProgress) {
            pauseFarm('🛑 Entrada pela janela Bosses interrompida. Nenhuma saída enviada ao jogo.');
            return getStatus();
        }
        if (!state.stopping) {
            state.stopping = true;
            setMessage('⏳ Parada agendada para depois de sair e curar o time...');
        } else {
            const cleanupInProgress = isTransitioning;
            state.running = false;
            state.stopping = false;
            clearWatchdog();
            if (cleanupInProgress) {
                setMessage('🛑 Automação interrompida. A cura atual será concluída, sem reentrada.');
            } else {
                cancelTransition();
                setMessage('🛑 Automação interrompida. A luta atual continua no jogo.');
            }
        }
        saveState();
        renderPanel();
        return getStatus();
    }

    function setMessage(message, isError = false) {
        state.lastMessage = String(message || '');
        const statusElement = document.querySelector('#piw-boss-panel .pba-status');
        if (!statusElement) return;
        statusElement.textContent = state.lastMessage;
        statusElement.classList.toggle('error', isError);
    }

    function resetStats() {
        state.wins = 0;
        state.losses = 0;
        state.lootHistory = [];
        saveState();
        renderPanel();
        return getStatus();
    }

    function renderLoot(container) {
        container.replaceChildren();
        if (state.lootHistory.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'pba-empty';
            empty.textContent = 'Nenhum loot recente.';
            container.appendChild(empty);
            return;
        }
        for (const entry of state.lootHistory) {
            const row = document.createElement('div');
            row.className = 'pba-loot-row';
            row.textContent = entry;
            container.appendChild(row);
        }
    }

    function renderPanel() {
        const panel = document.querySelector('#piw-boss-panel');
        const dockButton = document.querySelector('#piw-boss-route-button');
        if (dockButton) {
            dockButton.classList.toggle('pba-running', state.running);
            dockButton.title = state.running ? 'Auto Boss Farm ativo' : 'Auto Boss Farm pausado';
        }
        if (!panel) return;

        panel.querySelector('#pba-wins').textContent = String(state.wins);
        panel.querySelector('#pba-losses').textContent = String(state.losses);
        const bossInput = panel.querySelector('#pba-boss-name');
        bossInput.value = state.bossName;
        bossInput.disabled = state.running || isTransitioning;
        const webSocketInput = panel.querySelector('#pba-use-websocket');
        webSocketInput.checked = state.useWebSocket;
        webSocketInput.disabled = state.running || isTransitioning;

        const startButton = panel.querySelector('.pba-start');
        startButton.hidden = state.running || isTransitioning;
        const missingSlug = state.useWebSocket && !state.bossSlugs[state.bossName];
        startButton.disabled = missingSlug;
        const entryHelp = panel.querySelector('.pba-entry-help');
        entryHelp.hidden = !missingSlug;
        entryHelp.textContent = missingSlug
            ? 'Para usar este Boss via WebSocket, entre nele uma vez pelo modo de clique.' : '';
        const pauseButton = panel.querySelector('.pba-pause');
        pauseButton.hidden = !state.running;
        pauseButton.textContent = state.stopping ? 'Parar Somente Automação' : 'Agendar Parada';
        pauseButton.style.backgroundColor = state.stopping ? '#9b2c2c' : '';
        pauseButton.style.borderColor = state.stopping ? '#742a2a' : '';
        renderLoot(panel.querySelector('.pba-loot'));
    }

    function createPanel() {
        if (!document.body || document.querySelector('#piw-boss-panel')) return;
        const panel = document.createElement('section');
        panel.id = 'piw-boss-panel';
        panel.hidden = true;
        panel.innerHTML = `
            <header><span>☠️ Auto Boss</span><button class="pba-close" type="button">×</button></header>
            <div class="pba-body">
                <div class="pba-input-group">
                    <label for="pba-boss-name">Boss:</label>
                    <select id="pba-boss-name"><option>Giant Cruel</option><option>Ancient Aero</option></select>
                </div>
                <label class="pba-option" for="pba-use-websocket">
                    <input type="checkbox" id="pba-use-websocket" /> Entrar via WebSocket
                </label>
                <div class="pba-option-help">Desmarcado: desafia pelos botões do jogo, confirma a vitória e cura com Nurse Joy. A entrada consome os Boss Tokens indicados pelo jogo. Marcado: usa WebSocket. Derrota pausa sem iniciar outro boss.</div>
                <div class="pba-entry-help" hidden></div>
                <div class="pba-summary">
                    <span>🏆 <b id="pba-wins" class="text-green">0</b></span>
                    <span>💀 <b id="pba-losses" class="text-red">0</b></span>
                    <button class="pba-reset" type="button" title="Zerar estatísticas">🔄</button>
                </div>
                <div class="pba-actions">
                    <button class="pba-start primary" type="button">Iniciar Farm</button>
                    <button class="pba-pause warn" type="button" hidden>Agendar Parada</button>
                </div>
                <div class="pba-status"></div>
                <div class="pba-loot-header">Últimos Loots:</div>
                <div class="pba-loot"></div>
            </div>`;
        document.body.appendChild(panel);
        disposePanelDrag?.();
        disposePanelDrag = uiMenu.makePanelDraggable(panel, {
            storageKey: 'piw-auto-boss-panel-position-v1',
            sizeStorageKey: 'piw-auto-boss-panel-size-v1',
        });

        panel.querySelector('.pba-close').addEventListener('click', () => { panel.hidden = true; });
        panel.querySelector('.pba-start').addEventListener('click', startFarm);
        panel.querySelector('.pba-pause').addEventListener('click', stopFarm);
        panel.querySelector('.pba-reset').addEventListener('click', resetStats);
        panel.querySelector('#pba-use-websocket').addEventListener('change', event => {
            if (state.running || isTransitioning) return;
            state.useWebSocket = event.target.checked === true;
            saveState();
            renderPanel();
        });
        panel.querySelector('#pba-boss-name').addEventListener('change', event => {
            if (state.running || isTransitioning || !BOSS_NAMES.includes(event.target.value)) return;
            state.bossName = event.target.value;
            state.slug = state.bossSlugs[state.bossName];
            saveState();
            renderPanel();
        });
        panel.querySelector('.pba-status').textContent = state.lastMessage;
        renderPanel();
    }

    function registerSidebarButton() {
        if (unregisterMenu) return;
        unregisterMenu = uiMenu.register({
            id: 'piw-boss-route-button',
            label: 'Auto Boss',
            icon: '☠️',
            order: 30,
            onMount: renderPanel,
            onClick() {
                const panel = document.querySelector('#piw-boss-panel');
                if (!panel) return;
                panel.hidden = !panel.hidden;
                if (!panel.hidden) renderPanel();
            }
        });
        renderPanel();
    }

    function installStyles() {
        if (document.querySelector('#piw-boss-route-styles')) return;
        const style = document.createElement('style');
        style.id = 'piw-boss-route-styles';
        style.textContent = `
            #piw-boss-route-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
            #piw-boss-route-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#718096; }
            #piw-boss-route-button.pba-running::after { background:#48bb78;box-shadow:0 0 6px #48bb78; }
            #piw-boss-panel[hidden] { display:none !important; }
            #piw-boss-panel { position:fixed;right:18px;top:140px;z-index:10020;width:300px;display:flex;flex-direction:column;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
            #piw-boss-panel header { display:flex;align-items:center;gap:8px;padding:11px 13px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#f56565; }
            #piw-boss-panel header span { flex:1; }
            #piw-boss-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
            #piw-boss-panel button:hover { border-color:#4aa3c7;background:#1d3748; }
            #piw-boss-panel button:disabled { cursor:not-allowed;opacity:.5; }
            #piw-boss-panel .pba-close { width:29px;height:29px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:19px; }
            #piw-boss-panel .pba-body { padding:11px;overflow:auto;max-height:400px; }
            #piw-boss-panel .pba-input-group { margin-bottom:10px;display:flex;flex-direction:column;gap:4px; }
            #piw-boss-panel .pba-input-group label { font-size:11px;color:#a0aec0;text-transform:uppercase;font-weight:bold; }
            #piw-boss-panel .pba-input-group select { background:#0a1219;border:1px solid #315269;color:#fff;padding:6px 8px;border-radius:6px;font-family:monospace; }
            #piw-boss-panel .pba-option { display:flex;align-items:center;gap:7px;cursor:pointer; }
            #piw-boss-panel .pba-option-help { color:#a0aec0;font-size:11px;margin:5px 0 10px; }
            #piw-boss-panel .pba-entry-help { color:#fbd38d;font-size:11px;margin-bottom:10px; }
            #piw-boss-panel .pba-summary { display:flex;align-items:center;justify-content:space-around;background:#101f2a;border:1px solid #20394b;border-radius:8px;padding:9px 11px;margin-bottom:8px;font-size:16px; }
            #piw-boss-panel .text-green { color:#48bb78; }
            #piw-boss-panel .text-red { color:#f56565; }
            #piw-boss-panel .pba-reset { padding:2px 6px;font-size:12px;background:transparent;border:1px solid #4a5568; }
            #piw-boss-panel .pba-actions { display:flex;gap:6px; }
            #piw-boss-panel .pba-actions button { flex:1;padding:10px;font-size:14px;transition:background-color .2s; }
            #piw-boss-panel .primary { background:#176342;border-color:#299263; }
            #piw-boss-panel .warn { background:#654b16;border-color:#987024; }
            #piw-boss-panel .pba-status { color:#90cdf4;background:#0a1219;border-radius:6px;padding:7px 9px;margin:7px 0;text-align:center;font-weight:bold; }
            #piw-boss-panel .pba-status.error { color:#feb2b2; }
            #piw-boss-panel .pba-loot-header { font-size:11px;color:#a0aec0;margin-top:10px;margin-bottom:4px;text-transform:uppercase;font-weight:bold; }
            #piw-boss-panel .pba-loot { display:grid;gap:4px; }
            #piw-boss-panel .pba-loot-row { background:#111f29;border-left:3px solid #d6b35c;border-radius:5px;padding:4px 6px;font-size:11px;color:#cbd5e0;word-break:break-word;white-space:normal;line-height:1.4; }
            #piw-boss-panel .pba-empty { color:#718096;text-align:center;padding:7px;font-size:11px; }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function initialize() {
        if (!document.body) return;
        installStyles();
        createPanel();
        registerSidebarButton();
        if (interfaceObserver) return;
        interfaceObserver = new MutationObserver(() => {
            if (observerTimer) return;
            observerTimer = setTimeout(() => {
                observerTimer = null;
                createPanel();
                registerSidebarButton();
            }, 150);
        });
        interfaceObserver.observe(document.body, { childList: true, subtree: true });
    }

    function uninstall() {
        clearWatchdog();
        cancelTransition();
        state.running = false;
        state.stopping = false;
        saveState();
        unsubscribeBridge?.();
        unsubscribeBridge = null;
        unregisterMenu?.();
        unregisterMenu = null;
        disposePanelDrag?.();
        disposePanelDrag = null;
        gameSocket = null;
        interfaceObserver?.disconnect();
        interfaceObserver = null;
        if (observerTimer) clearTimeout(observerTimer);
        observerTimer = null;
        document.querySelector('#piw-boss-panel')?.remove();
        document.querySelector('#piw-boss-route-button')?.remove();
        document.querySelector('#piw-boss-route-styles')?.remove();
        delete window.piwBossFarm;
        delete window.piwBossFarmInjected;
    }

    window.piwBossFarm = {
        installed: true,
        start: startFarm,
        stop: stopFarm,
        resetStats,
        status: getStatus,
        uninstall
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
