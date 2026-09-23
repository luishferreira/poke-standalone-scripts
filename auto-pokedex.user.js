// ==UserScript==
// @name         PIW Auto Pokédex
// @namespace    poke-manager
// @version      1.1.3
// @description  Percorre automaticamente as hunts acessíveis até completar as capturas pendentes da Pokédex.
// @author       Luis
// @match        https://poke.idleworld.online/play*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-pokedex.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-pokedex.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.
// Fonte: src/auto-pokedex.js

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

(function installPiwAutoPokedex() {
  'use strict';

  if (window.piwAutoPokedex?.installed) {
    console.warn('[PIW Auto Pokédex] Já está instalado nesta página.');
    return;
  }

  const bridge = window.piwScripts?.wsBridge;
  const uiMenu = window.piwScripts?.uiMenu;
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[PIW Auto Pokédex] PIW WS Bridge v1 indisponível. Auto Pokédex não instalado.');
    return;
  }
  if (!uiMenu || uiMenu.apiVersion !== 1) {
    console.warn('[PIW Auto Pokédex] PIW UI Menu v1 indisponível. Auto Pokédex não instalado.');
    return;
  }

  const GAME_TOKENS_KEY = 'pokeweb:tokens';
  const CREATURES_URL = '/game/creatures.json';
  const MAP_MARKERS_URL = '/api/game/map-markers';
  const POKEDEX_URL = '/api/game/pokedex';
  const CHARACTER_URL = '/api/characters/me';
  const AUTH_REFRESH_URL = '/api/auth/refresh';
  const MAP_OPEN_TIMEOUT_MS = 1_500;
  const MARKER_SEARCH_TIMEOUT_MS = 1_500;
  const HUNT_ENTRY_TIMEOUT_MS = 4_000;
  const DOM_RETRY_MS = 100;
  const AREA_CHANGE_DELAY_MS = 250;
  const VERIFY_RETRY_MS = 2_500;
  const VERIFY_RETRIES = 4;
  const MAX_HISTORY = 10;
  const CITY_SLUGS = new Set(['cerulean', 'pewter', 'viridian', 'cassino']);
  const MARKER_SPECIES_ALIASES = Object.freeze({
    nidoranfe: ['Nidoran Female'],
    nidoranma: ['Nidoran Male'],
    nightmare_bagon_e_shelgon: ['Nightmare Bagon', 'Nightmare Shelgon'],
    nightmare_dratini_e_dragonair: ['Nightmare Dratini', 'Nightmare Dragonair'],
  });

  const state = {
    installed: true,
    running: false,
    loading: false,
    transitioning: false,
    completed: false,
    socket: bridge.getSocket(),
    knownHuntSlug: null,
    currentGroup: null,
    queue: [],
    allCandidates: [],
    creatures: [],
    markers: [],
    caughtIds: new Set(),
    skippedIds: new Set(),
    capturedThisRun: new Set(),
    trainerLevel: null,
    stats: {
      catchable: 0,
      caught: 0,
      accessible: 0,
      blocked: 0,
      withoutHunt: 0,
      skipped: 0,
    },
    vipAutoCatch: null,
    targetStartedAt: null,
    runStartedAt: null,
    lastMessage: 'Auto Pokédex pausado.',
    lastError: false,
    history: [],
    generation: 0,
    transitionTimer: null,
    transitionResolve: null,
    huntEntryWaiter: null,
    verifyTimer: null,
    verifyPromise: null,
    verifyQueued: false,
  };

  let unsubscribeBridge = null;
  let unregisterMenu = null;
  let interfaceObserver = null;
  let disposePanelDrag = null;
  let observerTimer = null;
  let uiTimer = null;

  function normalizeName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function normalizePositiveInteger(value, fallback = null) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function formatNumber(value) {
    return value == null || !Number.isFinite(Number(value))
      ? '—'
      : Number(value).toLocaleString('pt-BR');
  }

  function formatDuration(startedAt) {
    if (!startedAt) return '—';
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  function setMessage(message, isError = false) {
    state.lastMessage = String(message || '');
    state.lastError = isError;
    renderPanel();
  }

  function addHistory(message) {
    state.history.unshift({ at: Date.now(), message: String(message || '') });
    state.history = state.history.slice(0, MAX_HISTORY);
    renderPanel();
  }

  function getGameTokens() {
    try {
      return JSON.parse(sessionStorage.getItem(GAME_TOKENS_KEY) || 'null');
    } catch {
      return null;
    }
  }

  async function refreshGameAccessToken() {
    const tokens = getGameTokens();
    if (!tokens?.refreshToken) return null;
    const response = await fetch(AUTH_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refreshToken }),
    });
    if (!response.ok) return null;
    const refreshed = await response.json().catch(() => null);
    if (!refreshed?.accessToken) return null;
    sessionStorage.setItem(GAME_TOKENS_KEY, JSON.stringify(refreshed));
    return refreshed.accessToken;
  }

  async function gameApiRequest(url, options = {}) {
    const send = (accessToken) => fetch(url, {
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...(options.headers || {}),
      },
    });

    let response = await send(getGameTokens()?.accessToken);
    if (response.status === 401) {
      const refreshedToken = await refreshGameAccessToken();
      if (refreshedToken) response = await send(refreshedToken);
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(result?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  async function publicJsonRequest(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  function normalizeCreatures(payload) {
    const creatures = Array.isArray(payload) ? payload : payload?.creatures;
    if (!Array.isArray(creatures)) throw new Error('Catálogo de criaturas inválido.');
    return creatures.filter((creature) => normalizePositiveInteger(creature?.pokeId) != null);
  }

  function normalizeMarkers(payload) {
    const first = Array.isArray(payload)
      ? payload
      : (payload?.markers || payload?.hunts || payload?.data || []);
    const markers = Array.isArray(first) ? first : (first?.markers || first?.hunts || []);
    if (!Array.isArray(markers)) throw new Error('Catálogo de hunts inválido.');
    return markers.filter((marker) => marker && typeof marker === 'object');
  }

  function readTrainerLevel(payload) {
    const level = Number(payload?.character?.level ?? payload?.level);
    if (!Number.isFinite(level) || level < 1) throw new Error('Nível do perfil inválido.');
    return Math.floor(level);
  }

  function readCaughtIds(payload) {
    if (!payload || !Array.isArray(payload.species)) throw new Error('Resposta da Pokédex inválida.');
    return new Set(payload.species
      .filter((entry) => entry?.caught === true && normalizePositiveInteger(entry?.id) != null)
      .map((entry) => Number(entry.id)));
  }

  function getNpcSellValue(creature) {
    const sellValue = Number(creature?.sellValue);
    if (Number.isFinite(sellValue) && sellValue > 0) return sellValue;
    const priceNpc = Number(creature?.priceNpc);
    return Number.isFinite(priceNpc) && priceNpc > 0 ? priceNpc : Number.MAX_SAFE_INTEGER;
  }

  function chooseCreatureForMarker(candidates, marker) {
    if (!candidates.length) return null;
    const markerLevel = Number(marker?.level) || 1;
    return candidates.slice().sort((a, b) => {
      const distanceA = Math.abs((Number(a?.huntLevel) || markerLevel) - markerLevel);
      const distanceB = Math.abs((Number(b?.huntLevel) || markerLevel) - markerLevel);
      if (distanceA !== distanceB) return distanceA - distanceB;
      return Number(a.pokeId) - Number(b.pokeId);
    })[0];
  }

  function getCanonicalSpeciesId(creature) {
    return normalizePositiveInteger(creature?.captureBase)
      || normalizePositiveInteger(creature?.pokeId);
  }

  function candidateIsBetter(next, current) {
    if (!current) return true;
    if (next.requiredLevel !== current.requiredLevel) {
      return next.requiredLevel < current.requiredLevel;
    }
    if (next.canonicalSource !== current.canonicalSource) return next.canonicalSource;
    return next.slug.localeCompare(current.slug) < 0;
  }

  function buildCandidates(creatures, markers) {
    const creaturesByName = new Map();
    const creaturesById = new Map();
    for (const creature of creatures) {
      creaturesById.set(Number(creature.pokeId), creature);
      const key = normalizeName(creature.name);
      if (!key) continue;
      const entries = creaturesByName.get(key) || [];
      entries.push(creature);
      creaturesByName.set(key, entries);
    }

    const candidatesById = new Map();
    for (const marker of markers) {
      const slug = String(marker?.slug || '').trim();
      if (!slug || CITY_SLUGS.has(slug)) continue;
      const aliasNames = MARKER_SPECIES_ALIASES[slug];
      const names = aliasNames || [String(marker?.name || '').trim()];
      for (const name of names) {
        const matches = creaturesByName.get(normalizeName(name)) || [];
        const creature = chooseCreatureForMarker(matches, marker);
        if (!creature) continue;
        const id = getCanonicalSpeciesId(creature);
        if (id == null) continue;
        const canonicalCreature = creaturesById.get(id) || creature;
        const candidate = {
          id,
          name: String(canonicalCreature.name || creature.name || name),
          slug,
          requiredLevel: Math.max(1, Math.floor(Number(marker.level) || 1)),
          price: getNpcSellValue(canonicalCreature),
          canonicalSource: Number(creature.pokeId) === id,
        };
        if (candidateIsBetter(candidate, candidatesById.get(id))) {
          candidatesById.set(id, candidate);
        }
      }
    }
    return [...candidatesById.values()].map(({ canonicalSource, ...candidate }) => candidate);
  }

  function compareTargets(a, b) {
    return a.price - b.price || a.requiredLevel - b.requiredLevel || a.id - b.id;
  }

  function compareGroups(a, b) {
    return compareTargets(a.targets[0], b.targets[0]) || a.slug.localeCompare(b.slug);
  }

  function buildPlan() {
    const mappedIds = new Set(state.allCandidates.map((candidate) => candidate.id));
    const catalogSpeciesIds = new Set(state.creatures.map(getCanonicalSpeciesId).filter(Boolean));
    const remaining = state.allCandidates.filter((candidate) => !state.caughtIds.has(candidate.id));
    const accessible = remaining.filter((candidate) => (
      candidate.requiredLevel <= state.trainerLevel && !state.skippedIds.has(candidate.id)
    ));
    const grouped = new Map();
    for (const target of accessible.sort(compareTargets)) {
      const group = grouped.get(target.slug) || {
        slug: target.slug,
        requiredLevel: target.requiredLevel,
        targets: [],
      };
      group.requiredLevel = Math.max(group.requiredLevel, target.requiredLevel);
      group.targets.push(target);
      group.targets.sort(compareTargets);
      grouped.set(target.slug, group);
    }

    state.queue = [...grouped.values()].sort(compareGroups);
    state.stats = {
      catchable: state.allCandidates.length,
      caught: state.allCandidates.filter((candidate) => state.caughtIds.has(candidate.id)).length,
      accessible: accessible.length,
      blocked: remaining.filter((candidate) => candidate.requiredLevel > state.trainerLevel).length,
      withoutHunt: [...catalogSpeciesIds].filter((id) => !mappedIds.has(id)).length,
      skipped: remaining.filter((candidate) => state.skippedIds.has(candidate.id)).length,
    };
  }

  async function loadGameState({ reloadCatalogs = false } = {}) {
    const catalogRequests = reloadCatalogs || !state.creatures.length || !state.markers.length
      ? Promise.all([publicJsonRequest(CREATURES_URL), publicJsonRequest(MAP_MARKERS_URL)])
      : Promise.resolve([state.creatures, state.markers]);
    const [[creaturesPayload, markersPayload], pokedex, profile] = await Promise.all([
      catalogRequests,
      gameApiRequest(POKEDEX_URL),
      gameApiRequest(CHARACTER_URL),
    ]);

    state.creatures = normalizeCreatures(creaturesPayload);
    state.markers = normalizeMarkers(markersPayload);
    state.allCandidates = buildCandidates(state.creatures, state.markers);
    state.caughtIds = readCaughtIds(pokedex);
    state.trainerLevel = readTrainerLevel(profile);
    buildPlan();
  }

  function resolveHuntEntry(confirmed) {
    const waiter = state.huntEntryWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.huntEntryWaiter = null;
    waiter.resolve(Boolean(confirmed));
  }

  function clearTransition() {
    state.generation += 1;
    if (state.transitionTimer) clearTimeout(state.transitionTimer);
    state.transitionTimer = null;
    state.transitionResolve?.(false);
    state.transitionResolve = null;
    resolveHuntEntry(false);
    state.transitioning = false;
  }

  function waitDuringTransition(delayMs, generation) {
    return new Promise((resolve) => {
      state.transitionResolve = resolve;
      state.transitionTimer = setTimeout(() => {
        state.transitionTimer = null;
        state.transitionResolve = null;
        resolve(state.running && generation === state.generation);
      }, delayMs);
    });
  }

  async function waitForDom(find, timeoutMs, generation) {
    const deadline = Date.now() + timeoutMs;
    while (state.running && generation === state.generation) {
      const found = find();
      if (found) return found;
      if (Date.now() >= deadline) return null;
      if (!await waitDuringTransition(DOM_RETRY_MS, generation)) return null;
    }
    return null;
  }

  function findHuntMarker(slug) {
    const guide = `hunt-${slug}`;
    return Array.from(document.querySelectorAll('[data-guide]'))
      .find((element) => element.dataset?.guide === guide) || null;
  }

  function getAvailableMapAreas() {
    return Array.from(document.querySelectorAll('.map-area:not(.locked), .map-plate:not(.locked)'));
  }

  function isElementVisible(element) {
    return Boolean(element) && (
      typeof getComputedStyle !== 'function' || getComputedStyle(element).display !== 'none'
    );
  }

  async function locateHuntMarker(slug, generation) {
    const mapWindow = document.querySelector('.map-window');
    if (!isElementVisible(mapWindow)) {
      const mapButton = document.querySelector('button[data-guide="dock-map"]');
      if (!mapButton) return null;
      mapButton.click();
      const opened = await waitForDom(
        () => {
          const candidate = document.querySelector('.map-window');
          return isElementVisible(candidate) ? candidate : null;
        },
        MAP_OPEN_TIMEOUT_MS,
        generation,
      );
      if (!opened) return null;
    }

    let marker = await waitForDom(
      () => findHuntMarker(slug),
      MARKER_SEARCH_TIMEOUT_MS,
      generation,
    );
    if (marker) return marker;

    for (const area of getAvailableMapAreas()) {
      if (!state.running || generation !== state.generation) return null;
      if (!area.matches?.('.on')) area.click();
      if (!await waitDuringTransition(AREA_CHANGE_DELAY_MS, generation)) return null;
      marker = await waitForDom(
        () => findHuntMarker(slug),
        MARKER_SEARCH_TIMEOUT_MS,
        generation,
      );
      if (marker) return marker;
    }
    return null;
  }

  function waitForHuntEntry(slug, generation) {
    resolveHuntEntry(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (state.huntEntryWaiter?.timer !== timer) return;
        state.huntEntryWaiter = null;
        resolve(false);
      }, HUNT_ENTRY_TIMEOUT_MS);
      state.huntEntryWaiter = { slug, generation, timer, resolve };
    });
  }

  function clearVerification() {
    if (state.verifyTimer) clearTimeout(state.verifyTimer);
    state.verifyTimer = null;
    state.verifyQueued = false;
  }

  function findGroupBySlug(slug) {
    return state.queue.find((group) => group.slug === slug) || null;
  }

  function getCurrentTargetIds() {
    return new Set((state.currentGroup?.targets || []).map((target) => target.id));
  }

  function describeTargets(group) {
    return (group?.targets || []).map((target) => target.name).join(' e ');
  }

  function activateConfirmedGroup(group) {
    if (!state.running || !group) return false;
    state.transitioning = false;
    state.transitionTimer = null;
    state.currentGroup = group;
    state.targetStartedAt = Date.now();
    state.knownHuntSlug = group.slug;
    addHistory(`Entrou em ${group.slug}: ${describeTargets(group)}.`);
    setMessage(`Aguardando captura de ${describeTargets(group)}.`);
    return true;
  }

  async function navigateToGroup(group, generation) {
    if (state.knownHuntSlug === group.slug) {
      activateConfirmedGroup(group);
      return;
    }

    setMessage(`Abrindo ${group.slug} pelo mapa do jogo...`);
    const marker = await locateHuntMarker(group.slug, generation);
    if (!state.running || generation !== state.generation) return;
    if (!marker) {
      state.running = false;
      state.transitioning = false;
      setMessage(`Não foi possível localizar ${group.slug} no mapa. Automação pausada.`, true);
      return;
    }

    const confirmation = waitForHuntEntry(group.slug, generation);
    try {
      marker.click();
    } catch (error) {
      resolveHuntEntry(false);
      state.running = false;
      state.transitioning = false;
      setMessage(`Falha ao abrir ${group.slug}: ${error?.message || String(error)}.`, true);
      return;
    }
    const confirmed = await confirmation;
    if (!state.running || generation !== state.generation) return;
    if (!confirmed) {
      state.running = false;
      state.transitioning = false;
      setMessage(`O jogo não confirmou a entrada em ${group.slug}. Automação pausada.`, true);
      return;
    }
    activateConfirmedGroup(group);
  }

  function switchToGroup(group) {
    if (!state.running || !group) return false;
    clearTransition();
    const generation = state.generation;
    state.currentGroup = group;
    state.transitioning = true;
    state.targetStartedAt = null;
    renderPanel();
    navigateToGroup(group, generation);
    return true;
  }

  async function finishOrExpandPlan(generation) {
    const previousLevel = state.trainerLevel;
    try {
      const profile = await gameApiRequest(CHARACTER_URL);
      if (!state.running || generation !== state.generation) return;
      state.trainerLevel = readTrainerLevel(profile);
      buildPlan();
      if (state.queue.length > 0 && state.trainerLevel > previousLevel) {
        addHistory(`Nível ${state.trainerLevel}: novas hunts foram liberadas.`);
        switchToGroup(state.queue[0]);
        return;
      }
    } catch (error) {
      console.warn('[PIW Auto Pokédex] Falha ao atualizar o nível no encerramento.', {
        message: error?.message || String(error),
      });
    }
    if (!state.running || generation !== state.generation) return;
    state.running = false;
    state.completed = true;
    state.transitioning = false;
    state.currentGroup = null;
    state.targetStartedAt = null;
    setMessage('Pokédex concluída para todas as hunts acessíveis neste nível.');
    addHistory('Execução concluída; permanecendo na última hunt.');
  }

  function continuePlan({ preferCurrentSlug = false } = {}) {
    if (!state.running) return;
    buildPlan();
    const next = preferCurrentSlug && state.currentGroup
      ? findGroupBySlug(state.currentGroup.slug)
      : state.queue[0];
    if (next) {
      switchToGroup(next);
      return;
    }
    finishOrExpandPlan(state.generation);
  }

  async function verifyCurrentTargets(retriesLeft = VERIFY_RETRIES) {
    state.verifyTimer = null;
    if (!state.running || !state.currentGroup) return false;
    if (state.verifyPromise) {
      state.verifyQueued = true;
      return state.verifyPromise;
    }

    const generation = state.generation;
    const currentSlug = state.currentGroup.slug;
    const previousIds = getCurrentTargetIds();
    state.verifyPromise = (async () => {
      try {
        const pokedex = await gameApiRequest(POKEDEX_URL);
        if (!state.running || generation !== state.generation || state.currentGroup?.slug !== currentSlug) {
          return false;
        }
        state.caughtIds = readCaughtIds(pokedex);
        const newlyCaught = [...previousIds].filter((id) => state.caughtIds.has(id));
        for (const id of newlyCaught) {
          const target = state.allCandidates.find((candidate) => candidate.id === id);
          state.capturedThisRun.add(id);
          addHistory(`Captura confirmada: ${target?.name || `#${id}`}.`);
        }
        buildPlan();

        const sameHunt = findGroupBySlug(currentSlug);
        if (sameHunt) {
          state.currentGroup = sameHunt;
          if (newlyCaught.length > 0) {
            state.targetStartedAt = Date.now();
            setMessage(`Ainda aguardando ${describeTargets(sameHunt)} nesta hunt.`);
          } else if (retriesLeft > 0) {
            state.verifyTimer = setTimeout(
              () => verifyCurrentTargets(retriesLeft - 1),
              VERIFY_RETRY_MS,
            );
          }
          renderPanel();
          return newlyCaught.length > 0;
        }

        if (newlyCaught.length > 0) {
          const next = state.queue[0];
          if (next) switchToGroup(next);
          else finishOrExpandPlan(generation);
          return true;
        }
        if (retriesLeft > 0) {
          state.verifyTimer = setTimeout(
            () => verifyCurrentTargets(retriesLeft - 1),
            VERIFY_RETRY_MS,
          );
        }
        return false;
      } catch (error) {
        if (state.running && generation === state.generation) {
          setMessage(`Falha ao confirmar a Pokédex: ${error?.message || String(error)}.`, true);
          if (retriesLeft > 0) {
            state.verifyTimer = setTimeout(
              () => verifyCurrentTargets(retriesLeft - 1),
              VERIFY_RETRY_MS,
            );
          }
        }
        return false;
      } finally {
        state.verifyPromise = null;
        if (state.verifyQueued && state.running) {
          state.verifyQueued = false;
          if (!state.verifyTimer) state.verifyTimer = setTimeout(() => verifyCurrentTargets(0), 0);
        }
      }
    })();
    return state.verifyPromise;
  }

  function scheduleVerification() {
    if (!state.running || !state.currentGroup || state.verifyTimer) return;
    state.verifyTimer = setTimeout(() => verifyCurrentTargets(), 0);
  }

  function handleIncoming(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'autohelper') {
      state.vipAutoCatch = message.autoCatch === true;
      renderPanel();
    }
    if (message.type === 'catch-result' && message.auto === true) {
      state.vipAutoCatch = true;
    }
    if (!state.running || !state.currentGroup) return;

    if (message.type === 'catch-result' && message.success === true) {
      scheduleVerification();
      return;
    }
    if (message.type === 'poke-delta' && message.poke?.xp === 0) {
      const speciesId = normalizePositiveInteger(message.poke.speciesId);
      if (speciesId != null && getCurrentTargetIds().has(speciesId)) scheduleVerification();
    }
  }

  function handleOutgoing(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'enter-hunt' && message.slug) {
      state.knownHuntSlug = String(message.slug);
      const waiter = state.huntEntryWaiter;
      if (
        waiter &&
        waiter.generation === state.generation &&
        waiter.slug === state.knownHuntSlug
      ) {
        resolveHuntEntry(true);
      }
    } else if (message.type === 'leave-hunt') {
      state.knownHuntSlug = null;
    }
  }

  function adoptSocket(socket) {
    if (!socket || state.socket === socket) return;
    state.socket = socket;
    renderPanel();
  }

  function handleOpen(socket) {
    adoptSocket(socket);
    if (!state.running || !state.currentGroup || state.transitioning) return;
    state.knownHuntSlug = null;
    addHistory('WebSocket reconectado; sincronizando a hunt pelo mapa.');
    switchToGroup(state.currentGroup);
  }

  function handleClose(socket) {
    if (state.socket !== socket) return;
    clearTransition();
    state.socket = null;
    state.knownHuntSlug = null;
    if (state.running) setMessage('WebSocket desconectado; aguardando reconexão.', true);
    else renderPanel();
  }

  unsubscribeBridge = bridge.subscribe({
    socket(event) {
      adoptSocket(event.socket);
    },
    open(event) {
      handleOpen(event.socket);
    },
    close(event) {
      handleClose(event.socket);
    },
    incoming(event) {
      if (event.socket === state.socket) handleIncoming(event.message);
    },
    outgoing(event) {
      if (event.socket === state.socket) handleOutgoing(event.message);
    },
  });

  async function start() {
    if (state.running || state.loading) return false;
    state.socket = bridge.getSocket();
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      setMessage('Aguarde o WebSocket do jogo conectar antes de iniciar.', true);
      return false;
    }

    state.running = true;
    state.loading = true;
    state.completed = false;
    state.generation += 1;
    const generation = state.generation;
    if (!state.runStartedAt) state.runStartedAt = Date.now();
    setMessage('Carregando perfil, Pokédex e hunts...');
    try {
      await loadGameState({ reloadCatalogs: state.creatures.length === 0 });
      if (!state.running || generation !== state.generation) return false;
      state.loading = false;
      const resumeGroup = state.currentGroup ? findGroupBySlug(state.currentGroup.slug) : null;
      const next = resumeGroup || state.queue[0];
      if (!next) {
        finishOrExpandPlan(generation);
        return true;
      }
      addHistory(`Plano carregado no nível ${state.trainerLevel}.`);
      switchToGroup(next);
      return true;
    } catch (error) {
      if (generation !== state.generation) return false;
      state.running = false;
      state.loading = false;
      setMessage(`Não foi possível iniciar: ${error?.message || String(error)}.`, true);
      console.warn('[PIW Auto Pokédex] Inicialização falhou.', {
        message: error?.message || String(error),
      });
      return false;
    } finally {
      if (generation === state.generation) {
        state.loading = false;
        renderPanel();
      }
    }
  }

  function pause() {
    if (!state.running && !state.loading) return getStatus();
    clearTransition();
    clearVerification();
    state.running = false;
    state.loading = false;
    setMessage('Auto Pokédex pausado; a hunt atual continua.');
    addHistory('Automação pausada sem sair da hunt.');
    return getStatus();
  }

  function skipCurrent() {
    if (!state.running || !state.currentGroup || state.transitioning) return false;
    const skippedNames = describeTargets(state.currentGroup);
    for (const target of state.currentGroup.targets) state.skippedIds.add(target.id);
    addHistory(`Alvo pulado nesta execução: ${skippedNames}.`);
    state.currentGroup = null;
    continuePlan();
    return true;
  }

  async function refreshPlan() {
    if (state.loading || state.transitioning) return false;
    const wasRunning = state.running;
    state.loading = true;
    state.generation += 1;
    const generation = state.generation;
    setMessage('Atualizando perfil, Pokédex e catálogos...');
    try {
      await loadGameState({ reloadCatalogs: true });
      if (generation !== state.generation) return false;
      state.loading = false;
      addHistory('Lista de alvos atualizada manualmente.');
      if (wasRunning) {
        state.running = true;
        const current = state.currentGroup ? findGroupBySlug(state.currentGroup.slug) : null;
        if (current) {
          state.currentGroup = current;
          setMessage(`Aguardando captura de ${describeTargets(current)}.`);
        } else if (state.queue[0]) {
          switchToGroup(state.queue[0]);
        } else {
          finishOrExpandPlan(generation);
        }
      } else {
        setMessage('Lista atualizada. Auto Pokédex permanece pausado.');
      }
      renderPanel();
      return true;
    } catch (error) {
      if (generation !== state.generation) return false;
      state.loading = false;
      state.running = wasRunning;
      setMessage(`Falha ao atualizar: ${error?.message || String(error)}.`, true);
      return false;
    }
  }

  function getStatus() {
    return {
      installed: state.installed,
      running: state.running,
      loading: state.loading,
      transitioning: state.transitioning,
      completed: state.completed,
      socketOpen: bridge.isOpen(),
      trainerLevel: state.trainerLevel,
      knownHuntSlug: state.knownHuntSlug,
      currentGroup: state.currentGroup && {
        slug: state.currentGroup.slug,
        requiredLevel: state.currentGroup.requiredLevel,
        targets: state.currentGroup.targets.map((target) => ({ ...target })),
      },
      queue: state.queue.map((group) => ({
        slug: group.slug,
        requiredLevel: group.requiredLevel,
        targets: group.targets.map((target) => ({ ...target })),
      })),
      stats: { ...state.stats },
      capturedThisRun: [...state.capturedThisRun],
      skippedIds: [...state.skippedIds],
      vipAutoCatch: state.vipAutoCatch,
      lastMessage: state.lastMessage,
      history: state.history.map((entry) => ({ ...entry })),
    };
  }

  function renderList(container, groups, emptyMessage) {
    container.replaceChildren();
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'pap-empty';
      empty.textContent = emptyMessage;
      container.appendChild(empty);
      return;
    }
    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'pap-list-row';
      const names = document.createElement('span');
      names.textContent = describeTargets(group);
      const meta = document.createElement('small');
      meta.textContent = `Nv ${group.requiredLevel} · ${formatNumber(group.targets[0]?.price)} gold`;
      row.append(names, meta);
      container.appendChild(row);
    }
  }

  function renderHistory(container) {
    container.replaceChildren();
    if (!state.history.length) {
      const empty = document.createElement('div');
      empty.className = 'pap-empty';
      empty.textContent = 'Nenhuma ação nesta execução.';
      container.appendChild(empty);
      return;
    }
    for (const entry of state.history) {
      const row = document.createElement('div');
      row.className = 'pap-history-row';
      const time = new Date(entry.at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
      row.textContent = `${time} · ${entry.message}`;
      container.appendChild(row);
    }
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-auto-pokedex-panel');
    const menuButton = document.querySelector('#piw-auto-pokedex-button');
    if (menuButton) {
      menuButton.classList.toggle('pap-running', state.running);
      menuButton.classList.toggle('pap-busy', state.loading || state.transitioning);
      menuButton.title = state.running ? 'Auto Pokédex ativo' : 'Auto Pokédex pausado';
    }
    if (!panel) return;

    panel.querySelector('[data-pap="status"]').textContent = state.lastMessage;
    panel.querySelector('[data-pap="status"]').classList.toggle('pap-error', state.lastError);
    panel.querySelector('[data-pap="socket"]').textContent = bridge.isOpen() ? 'Conectado' : 'Aguardando';
    panel.querySelector('[data-pap="level"]').textContent = formatNumber(state.trainerLevel);
    panel.querySelector('[data-pap="caught"]').textContent = formatNumber(state.stats.caught);
    panel.querySelector('[data-pap="run-caught"]').textContent = formatNumber(state.capturedThisRun.size);
    panel.querySelector('[data-pap="accessible"]').textContent = formatNumber(state.stats.accessible);
    panel.querySelector('[data-pap="blocked"]').textContent = formatNumber(state.stats.blocked);
    panel.querySelector('[data-pap="without-hunt"]').textContent = formatNumber(state.stats.withoutHunt);
    panel.querySelector('[data-pap="skipped"]').textContent = formatNumber(state.stats.skipped);

    const vip = panel.querySelector('.pap-vip');
    vip.classList.toggle('pap-warning', state.vipAutoCatch !== true);
    vip.textContent = state.vipAutoCatch === true
      ? 'Autocatch VIP detectado.'
      : state.vipAutoCatch === false
        ? 'Autocatch VIP desativado. O script aguardará sem capturar.'
        : 'Autocatch VIP ainda não detectado. O script não realiza capturas.';

    const current = state.currentGroup;
    panel.querySelector('[data-pap="target-name"]').textContent = current ? describeTargets(current) : 'Nenhum alvo';
    panel.querySelector('[data-pap="target-slug"]').textContent = current?.slug || '—';
    panel.querySelector('[data-pap="target-level"]').textContent = current ? formatNumber(current.requiredLevel) : '—';
    panel.querySelector('[data-pap="target-price"]').textContent = current
      ? `${formatNumber(current.targets[0]?.price)} gold`
      : '—';
    panel.querySelector('[data-pap="target-time"]').textContent = formatDuration(state.targetStartedAt);

    const startButton = panel.querySelector('.pap-start');
    startButton.hidden = state.running;
    startButton.disabled = state.loading;
    startButton.textContent = state.loading ? 'Carregando...' : 'Iniciar';
    panel.querySelector('.pap-pause').hidden = !state.running;
    panel.querySelector('.pap-skip').disabled = !state.running || !current || state.transitioning;
    panel.querySelector('.pap-refresh').disabled = state.loading || state.transitioning;

    renderList(panel.querySelector('.pap-next-list'), state.queue.filter((group) => group.slug !== current?.slug).slice(0, 5), 'Nenhum próximo alvo acessível.');
    renderList(panel.querySelector('.pap-full-list'), state.queue, 'Nenhum alvo acessível pendente.');
    renderHistory(panel.querySelector('.pap-history'));
  }

  function createPanel() {
    if (!document.body || document.querySelector('#piw-auto-pokedex-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'piw-auto-pokedex-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>📖 Auto Pokédex</span><button class="pap-close" type="button">×</button></header>
      <div class="pap-body">
        <div class="pap-status" data-pap="status"></div>
        <div class="pap-vip"></div>
        <div class="pap-grid">
          <div><small>WebSocket</small><b data-pap="socket">Aguardando</b></div>
          <div><small>Nível</small><b data-pap="level">—</b></div>
          <div><small>Capturados</small><b data-pap="caught">0</b></div>
          <div><small>Nesta execução</small><b data-pap="run-caught">0</b></div>
          <div><small>Acessíveis</small><b data-pap="accessible">0</b></div>
          <div><small>Por nível</small><b data-pap="blocked">0</b></div>
          <div><small>Sem hunt</small><b data-pap="without-hunt">0</b></div>
          <div><small>Pulados</small><b data-pap="skipped">0</b></div>
        </div>
        <section class="pap-target">
          <small>Alvo atual</small>
          <strong data-pap="target-name">Nenhum alvo</strong>
          <span><code data-pap="target-slug">—</code> · Nv <b data-pap="target-level">—</b></span>
          <span><b data-pap="target-price">—</b> · <b data-pap="target-time">—</b></span>
        </section>
        <div class="pap-actions">
          <button class="pap-start primary" type="button">Iniciar</button>
          <button class="pap-pause warn" type="button" hidden>Pausar</button>
          <button class="pap-skip" type="button">Pular alvo</button>
          <button class="pap-refresh" type="button">Atualizar lista</button>
        </div>
        <details class="pap-next" open><summary>Próximos alvos</summary><div class="pap-next-list"></div></details>
        <details class="pap-full"><summary>Fila completa</summary><div class="pap-full-list"></div></details>
        <details class="pap-log"><summary>Histórico</summary><div class="pap-history"></div></details>
      </div>`;
    document.body.appendChild(panel);
    disposePanelDrag?.();
    disposePanelDrag = uiMenu.makePanelDraggable(panel, {
      storageKey: 'piw-auto-pokedex-panel-position-v1',
      sizeStorageKey: 'piw-auto-pokedex-panel-size-v1',
    });

    panel.querySelector('.pap-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.pap-start').addEventListener('click', start);
    panel.querySelector('.pap-pause').addEventListener('click', pause);
    panel.querySelector('.pap-skip').addEventListener('click', skipCurrent);
    panel.querySelector('.pap-refresh').addEventListener('click', refreshPlan);
    renderPanel();
  }

  function registerSidebarButton() {
    if (unregisterMenu) return;
    unregisterMenu = uiMenu.register({
      id: 'piw-auto-pokedex-button',
      label: 'Auto Pokédex',
      icon: '📖',
      order: 25,
      onMount: renderPanel,
      onClick() {
        const panel = document.querySelector('#piw-auto-pokedex-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) renderPanel();
      },
    });
    renderPanel();
  }

  function installStyles() {
    if (document.querySelector('#piw-auto-pokedex-styles')) return;
    const style = document.createElement('style');
    style.id = 'piw-auto-pokedex-styles';
    style.textContent = `
      #piw-auto-pokedex-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
      #piw-auto-pokedex-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#718096; }
      #piw-auto-pokedex-button.pap-running::after { background:#48bb78;box-shadow:0 0 6px #48bb78; }
      #piw-auto-pokedex-button.pap-busy::after { background:#ecc94b;box-shadow:0 0 6px #ecc94b; }
      #piw-auto-pokedex-panel[hidden] { display:none !important; }
      #piw-auto-pokedex-panel { position:fixed;right:18px;top:110px;z-index:10020;width:340px;display:flex;flex-direction:column;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
      #piw-auto-pokedex-panel header { display:flex;align-items:center;gap:8px;padding:11px 13px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-auto-pokedex-panel header span { flex:1; }
      #piw-auto-pokedex-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
      #piw-auto-pokedex-panel button:hover { border-color:#4aa3c7;background:#1d3748; }
      #piw-auto-pokedex-panel button:disabled { cursor:not-allowed;opacity:.5; }
      #piw-auto-pokedex-panel .pap-close { width:29px;height:29px;padding:0;background:#23303a;color:#cbd5e0;font-size:19px; }
      #piw-auto-pokedex-panel .pap-body { padding:11px;overflow:auto;max-height:min(680px,calc(100vh - 145px)); }
      #piw-auto-pokedex-panel .pap-status { color:#90cdf4;background:#0a1219;border-radius:6px;padding:7px 9px;margin-bottom:7px;text-align:center;font-weight:700; }
      #piw-auto-pokedex-panel .pap-status.pap-error { color:#feb2b2; }
      #piw-auto-pokedex-panel .pap-vip { color:#9ae6b4;background:#10271d;border:1px solid #24563d;border-radius:6px;padding:6px 8px;margin-bottom:8px;font-size:11px; }
      #piw-auto-pokedex-panel .pap-vip.pap-warning { color:#faf089;background:#2d2711;border-color:#66591d; }
      #piw-auto-pokedex-panel .pap-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:8px; }
      #piw-auto-pokedex-panel .pap-grid div { display:flex;flex-direction:column;gap:2px;background:#101f2a;border:1px solid #20394b;border-radius:7px;padding:6px;min-width:0; }
      #piw-auto-pokedex-panel .pap-grid small { color:#718096;font-size:9px;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      #piw-auto-pokedex-panel .pap-grid b { color:#e2e8f0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
      #piw-auto-pokedex-panel .pap-target { display:flex;flex-direction:column;gap:3px;background:#111f29;border-left:3px solid #4299e1;border-radius:7px;padding:8px 10px;margin-bottom:8px; }
      #piw-auto-pokedex-panel .pap-target small { color:#718096;text-transform:uppercase;font-size:9px; }
      #piw-auto-pokedex-panel .pap-target strong { color:#bee3f8;font-size:15px; }
      #piw-auto-pokedex-panel .pap-target span { color:#a0aec0;font-size:11px; }
      #piw-auto-pokedex-panel .pap-target code { color:#90cdf4; }
      #piw-auto-pokedex-panel .pap-actions { display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:9px; }
      #piw-auto-pokedex-panel .pap-actions .primary { background:#176342;border-color:#299263; }
      #piw-auto-pokedex-panel .pap-actions .warn { background:#654b16;border-color:#987024; }
      #piw-auto-pokedex-panel details { border-top:1px solid #20394b;padding-top:7px;margin-top:7px; }
      #piw-auto-pokedex-panel summary { color:#a0aec0;text-transform:uppercase;font-size:10px;font-weight:800;cursor:pointer;margin-bottom:5px; }
      #piw-auto-pokedex-panel .pap-next-list,#piw-auto-pokedex-panel .pap-full-list,#piw-auto-pokedex-panel .pap-history { display:grid;gap:4px;max-height:190px;overflow:auto; }
      #piw-auto-pokedex-panel .pap-list-row { display:flex;align-items:center;justify-content:space-between;gap:8px;background:#111f29;border-radius:5px;padding:5px 7px; }
      #piw-auto-pokedex-panel .pap-list-row span { color:#cbd5e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #piw-auto-pokedex-panel .pap-list-row small { color:#718096;white-space:nowrap;font-size:10px; }
      #piw-auto-pokedex-panel .pap-history-row { background:#111f29;border-left:2px solid #4a5568;border-radius:4px;padding:4px 6px;color:#a0aec0;font-size:10px; }
      #piw-auto-pokedex-panel .pap-empty { color:#718096;text-align:center;padding:7px;font-size:11px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function initialize() {
    if (!document.body) return;
    installStyles();
    createPanel();
    registerSidebarButton();
    if (!uiTimer) uiTimer = setInterval(renderPanel, 1_000);
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
    clearTransition();
    clearVerification();
    state.running = false;
    state.loading = false;
    state.installed = false;
    unsubscribeBridge?.();
    unsubscribeBridge = null;
    unregisterMenu?.();
    unregisterMenu = null;
    disposePanelDrag?.();
    disposePanelDrag = null;
    interfaceObserver?.disconnect();
    interfaceObserver = null;
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = null;
    if (uiTimer) clearInterval(uiTimer);
    uiTimer = null;
    document.querySelector('#piw-auto-pokedex-panel')?.remove();
    document.querySelector('#piw-auto-pokedex-button')?.remove();
    document.querySelector('#piw-auto-pokedex-styles')?.remove();
    delete window.piwAutoPokedex;
  }

  window.piwAutoPokedex = {
    installed: true,
    start,
    pause,
    skipCurrent,
    refresh: refreshPlan,
    status: getStatus,
    uninstall,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
