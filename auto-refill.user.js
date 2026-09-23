// ==UserScript==
// @name         PIW Auto Refill
// @namespace    poke-manager
// @version      1.2.1
// @description  Reabastece potions e Pokébolas com limites configuráveis e venda opcional de loot comum.
// @author       Luis
// @match        https://poke.idleworld.online/play*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-refill.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-refill.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.
// Fonte: src/auto-refill.js

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

(function installPiwAutoRefill() {
  'use strict';

  if (window.piwAutoRefill?.installed) {
    console.warn('[PIW Auto Refill] Já está instalado nesta página.');
    return;
  }

  const bridge = window.piwScripts?.wsBridge;
  const uiMenu = window.piwScripts?.uiMenu;
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[PIW Auto Refill] PIW WS Bridge v1 indisponível. Auto Refill não instalado.');
    return;
  }
  if (!uiMenu || uiMenu.apiVersion !== 1) {
    console.warn('[PIW Auto Refill] PIW UI Menu v1 indisponível. Auto Refill não instalado.');
    return;
  }

  const SETTINGS_KEY = 'piw-auto-refill-settings-v1';
  const GAME_TOKENS_KEY = 'pokeweb:tokens';
  const ITEMS_CATALOG_URL = '/game/items.json';
  const SHOP_URL = '/api/game/shop';
  const SHOP_BUY_URL = '/api/game/shop/buy';
  const SHOP_SELL_URL = '/api/game/shop/sell';
  const AUTH_REFRESH_URL = '/api/auth/refresh';
  const MAX_PURCHASE_QUANTITY = 10_000;
  const MAX_BATCH_QUANTITY = 1_000;
  const REFILL_DEBOUNCE_MS = 100;
  const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    potionEnabled: true,
    potionItemId: 203,
    potionThreshold: 20,
    potionQuantity: 1_000,
    ballEnabled: true,
    ballId: 4,
    ballThreshold: 50,
    ballQuantity: 1_000,
    sellTrash: false,
    goldReserve: 0,
  });

  function normalizeNonNegativeInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }

  function normalizePositiveId(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
  }

  function normalizePurchaseQuantity(value, fallback) {
    const quantity = normalizeNonNegativeInteger(value, fallback);
    return quantity >= 1 && quantity <= MAX_PURCHASE_QUANTITY ? quantity : fallback;
  }

  function normalizeSettings(input = {}) {
    return {
      enabled: input.enabled === true,
      potionEnabled: input.potionEnabled !== false,
      potionItemId: normalizePositiveId(input.potionItemId, DEFAULT_SETTINGS.potionItemId),
      potionThreshold: normalizeNonNegativeInteger(input.potionThreshold, DEFAULT_SETTINGS.potionThreshold),
      potionQuantity: normalizePurchaseQuantity(input.potionQuantity, DEFAULT_SETTINGS.potionQuantity),
      ballEnabled: input.ballEnabled !== false,
      ballId: normalizePositiveId(input.ballId, DEFAULT_SETTINGS.ballId),
      ballThreshold: normalizeNonNegativeInteger(input.ballThreshold, DEFAULT_SETTINGS.ballThreshold),
      ballQuantity: normalizePurchaseQuantity(input.ballQuantity, DEFAULT_SETTINGS.ballQuantity),
      sellTrash: input.sellTrash === true,
      goldReserve: normalizeNonNegativeInteger(input.goldReserve, DEFAULT_SETTINGS.goldReserve),
    };
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SETTINGS_KEY) || '{}');
      return normalizeSettings(saved);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  const settings = loadSettings();
  const state = {
    installed: true,
    socket: bridge.getSocket(),
    inventoryItems: null,
    ballCounts: null,
    potionStock: null,
    ballStock: null,
    potionArmed: true,
    ballArmed: true,
    cycleRunning: false,
    cycleTimer: null,
    catalogLoading: false,
    shopLoadPromise: null,
    shopCatalog: null,
    itemsCatalogPromise: null,
    currentGold: null,
    lastMessage: settings.enabled
      ? 'Aguardando estoque do jogo.'
      : 'Auto Refill pausado.',
    lastResult: null,
  };
  let unsubscribeBridge = null;
  let unregisterMenu = null;
  let interfaceObserver = null;
  let disposePanelDrag = null;
  let observerTimer = null;

  function saveSettings() {
    try {
      sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('[PIW Auto Refill] Não foi possível salvar as configurações da aba.', error);
    }
  }

  function log(message, details) {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    console.log(`[PIW Auto Refill] ${message}${suffix}`);
  }

  function setMessage(message, isError = false) {
    state.lastMessage = String(message || '');
    const element = document.querySelector('#piw-auto-refill-panel .par-status');
    if (element) {
      element.textContent = state.lastMessage;
      element.classList.toggle('par-error', isError);
    }
  }

  function formatNumber(value) {
    return value == null ? '—' : Number(value).toLocaleString('pt-BR');
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

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(result?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return result;
  }

  function splitPurchaseBatches(quantity) {
    const batches = [];
    let remaining = normalizePurchaseQuantity(quantity, 0);
    while (remaining > 0) {
      const batch = Math.min(MAX_BATCH_QUANTITY, remaining);
      batches.push(batch);
      remaining -= batch;
    }
    return batches;
  }

  function isTrashLootItem(item) {
    const npcPrice = Number(item?.npcPrice || 0);
    return item?.category === 'loot' && npcPrice > 0 && npcPrice <= 4_000;
  }

  async function loadItemsCatalog() {
    if (!state.itemsCatalogPromise) {
      state.itemsCatalogPromise = fetch(ITEMS_CATALOG_URL)
        .then(async (response) => {
          if (!response.ok) throw new Error(`Catálogo de itens indisponível: HTTP ${response.status}`);
          const payload = await response.json();
          const items = Array.isArray(payload) ? payload : payload?.items;
          if (!Array.isArray(items)) throw new Error('Catálogo de itens inválido.');
          return new Map(items.map((item) => [String(item.id), item]));
        })
        .catch((error) => {
          state.itemsCatalogPromise = null;
          throw error;
        });
    }
    return state.itemsCatalogPromise;
  }

  function buildTrashSale(inventoryItems, catalog) {
    if (!Array.isArray(inventoryItems)) return [];
    return inventoryItems.flatMap((entry) => {
      const itemId = entry?.itemId;
      const quantity = normalizeNonNegativeInteger(entry?.quantity, 0);
      const item = catalog.get(String(itemId));
      if (itemId == null || quantity <= 0 || !isTrashLootItem(item)) return [];
      return [{ itemId, qty: quantity }];
    });
  }

  async function sellTrashIfEnabled() {
    if (!settings.sellTrash) return { attempted: false, ok: true, soldCount: 0 };
    try {
      const catalog = await loadItemsCatalog();
      const items = buildTrashSale(state.inventoryItems, catalog);
      if (items.length === 0) return { attempted: false, ok: true, soldCount: 0 };
      const result = await gameApiRequest(SHOP_SELL_URL, {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      const ok = result?.ok === true;
      if (Number.isFinite(Number(result?.gold))) state.currentGold = Number(result.gold);
      return {
        attempted: true,
        ok,
        soldCount: normalizeNonNegativeInteger(result?.soldCount, 0),
        goldGained: normalizeNonNegativeInteger(result?.goldGained, 0),
      };
    } catch (error) {
      console.warn('[PIW Auto Refill] Venda de lixo falhou; compra continuará com o saldo atual.', {
        message: error?.message || String(error),
      });
      return { attempted: true, ok: false, soldCount: 0, error: error?.message || String(error) };
    }
  }

  function normalizeShopCatalog(shop) {
    if (!shop || !Array.isArray(shop.items) || !Array.isArray(shop.balls)) {
      throw new Error('Resposta da loja inválida.');
    }
    const gold = Number(shop.gold);
    if (!Number.isFinite(gold) || gold < 0) throw new Error('Gold da loja inválido.');
    return {
      gold: Math.floor(gold),
      items: shop.items,
      balls: shop.balls,
    };
  }

  async function loadShop({ render = true } = {}) {
    if (state.shopLoadPromise) return state.shopLoadPromise;
    state.catalogLoading = true;
    if (render) renderPanel();
    state.shopLoadPromise = (async () => {
      const shop = normalizeShopCatalog(await gameApiRequest(SHOP_URL));
      state.shopCatalog = shop;
      state.currentGold = shop.gold;
      populateProductSelectors();
      return shop;
    })();
    try {
      return await state.shopLoadPromise;
    } finally {
      state.shopLoadPromise = null;
      state.catalogLoading = false;
      if (render) renderPanel();
    }
  }

  function findShopProduct(shop, kind, id) {
    const products = kind === 'ball' ? shop.balls : shop.items;
    return products.find((product) => Number(product?.id) === Number(id)) || null;
  }

  async function purchaseProduct({ kind, id, quantity, shop }) {
    const product = findShopProduct(shop, kind, id);
    const price = Number(product?.priceGold);
    if (!product || !Number.isFinite(price) || price <= 0) {
      return { ok: false, requested: quantity, bought: 0, reason: 'product_unavailable' };
    }

    const batches = splitPurchaseBatches(quantity);
    let bought = 0;
    let reason = null;

    for (const batch of batches) {
      if (!state.installed || !settings.enabled) {
        reason = 'automation_paused';
        break;
      }

      const batchCost = price * batch;
      if (state.currentGold - batchCost < settings.goldReserve) {
        reason = 'not_enough_gold';
        break;
      }

      let result;
      try {
        result = await gameApiRequest(SHOP_BUY_URL, {
          method: 'POST',
          body: JSON.stringify(kind === 'ball'
            ? { ballId: id, qty: batch }
            : { itemId: id, qty: batch }),
        });
      } catch (error) {
        reason = `request_failed:${error?.message || String(error)}`;
        break;
      }

      const batchBought = normalizeNonNegativeInteger(result?.bought, 0);
      bought += Math.min(batch, batchBought);
      if (Number.isFinite(Number(result?.gold))) {
        state.currentGold = Math.max(0, Number(result.gold));
      } else {
        reason = 'missing_gold_confirmation';
        break;
      }
      if (result?.ok === false || batchBought !== batch) {
        reason = 'partial_batch';
        break;
      }
    }

    return {
      ok: bought === quantity,
      requested: quantity,
      bought,
      reason,
      productId: id,
      productName: product.name || `${kind} ${id}`,
    };
  }

  function categoryNeedsRefill(category) {
    if (category === 'potion') {
      return settings.potionEnabled && state.potionArmed && state.potionStock != null &&
        state.potionStock <= settings.potionThreshold;
    }
    return settings.ballEnabled && state.ballArmed && state.ballStock != null &&
      state.ballStock <= settings.ballThreshold;
  }

  function updateCategoryArming(category) {
    if (category === 'potion') {
      if (state.potionStock != null && state.potionStock > settings.potionThreshold) {
        state.potionArmed = true;
      }
    } else if (state.ballStock != null && state.ballStock > settings.ballThreshold) {
      state.ballArmed = true;
    }
  }

  function formatPurchaseSummary(label, result) {
    if (!result) return null;
    return `${label}: ${formatNumber(result.bought)}/${formatNumber(result.requested)}`;
  }

  async function runRefillCycle() {
    state.cycleTimer = null;
    if (!state.installed || !settings.enabled || state.cycleRunning) return false;

    const needsPotion = categoryNeedsRefill('potion');
    const needsBall = categoryNeedsRefill('ball');
    if (!needsPotion && !needsBall) return false;
    if (settings.sellTrash && !state.inventoryItems) {
      setMessage('Aguardando um inventory do jogo antes de vender lixo.');
      return false;
    }

    if (needsPotion) state.potionArmed = false;
    if (needsBall) state.ballArmed = false;
    state.cycleRunning = true;
    state.lastResult = null;
    setMessage('Preparando reabastecimento...');
    renderPanel();

    const cycleResult = { trash: null, potion: null, ball: null };
    try {
      cycleResult.trash = await sellTrashIfEnabled();
      const shop = await loadShop({ render: false });

      if (needsPotion && settings.enabled && settings.potionEnabled) {
        cycleResult.potion = await purchaseProduct({
          kind: 'item',
          id: settings.potionItemId,
          quantity: settings.potionQuantity,
          shop,
        });
      }
      if (needsBall && settings.enabled && settings.ballEnabled) {
        cycleResult.ball = await purchaseProduct({
          kind: 'ball',
          id: settings.ballId,
          quantity: settings.ballQuantity,
          shop,
        });
      }

      state.lastResult = cycleResult;
      const summaries = [
        formatPurchaseSummary('Potion', cycleResult.potion),
        formatPurchaseSummary('Ball', cycleResult.ball),
      ].filter(Boolean);
      const incomplete = [cycleResult.potion, cycleResult.ball]
        .filter(Boolean)
        .some((result) => !result.ok);
      const trashWarning = cycleResult.trash?.attempted && !cycleResult.trash.ok;
      setMessage(
        `${summaries.join(' · ') || 'Nenhuma compra realizada.'}` +
          ` · Gold: ${formatNumber(state.currentGold)}` +
          (trashWarning ? ' · Venda de lixo falhou.' : ''),
        incomplete || trashWarning,
      );
      log('Ciclo concluído.', {
        potion: cycleResult.potion && {
          requested: cycleResult.potion.requested,
          bought: cycleResult.potion.bought,
          reason: cycleResult.potion.reason,
        },
        ball: cycleResult.ball && {
          requested: cycleResult.ball.requested,
          bought: cycleResult.ball.bought,
          reason: cycleResult.ball.reason,
        },
        trashSold: cycleResult.trash?.soldCount || 0,
      });
      return true;
    } catch (error) {
      state.lastResult = { error: error?.message || String(error), ...cycleResult };
      setMessage(`Falha no reabastecimento: ${error?.message || String(error)}. Rearme manualmente.`, true);
      console.warn('[PIW Auto Refill] Ciclo interrompido.', {
        message: error?.message || String(error),
      });
      return false;
    } finally {
      state.cycleRunning = false;
      renderPanel();
      scheduleRefillCheck();
    }
  }

  function scheduleRefillCheck() {
    if (!state.installed || !settings.enabled || state.cycleRunning || state.cycleTimer) return;
    if (!categoryNeedsRefill('potion') && !categoryNeedsRefill('ball')) return;
    state.cycleTimer = setTimeout(runRefillCycle, REFILL_DEBOUNCE_MS);
  }

  function updatePotionStock(items) {
    state.inventoryItems = items;
    state.potionStock = items.reduce((total, entry) => (
      Number(entry?.itemId) === settings.potionItemId
        ? total + normalizeNonNegativeInteger(entry?.quantity, 0)
        : total
    ), 0);
    updateCategoryArming('potion');
    scheduleRefillCheck();
    renderPanel();
  }

  function updateBallStock(counts) {
    state.ballCounts = { ...counts };
    state.ballStock = normalizeNonNegativeInteger(counts?.[settings.ballId], 0);
    updateCategoryArming('ball');
    scheduleRefillCheck();
    renderPanel();
  }

  function handleIncoming(message) {
    if (message?.type === 'inventory' && Array.isArray(message.items)) {
      updatePotionStock(message.items);
    } else if (message?.type === 'balls' && message.counts && typeof message.counts === 'object') {
      updateBallStock(message.counts);
    }
  }

  function recalculateSelectedStocks() {
    if (state.inventoryItems) updatePotionStock(state.inventoryItems);
    if (state.ballCounts) updateBallStock(state.ballCounts);
  }

  function populateSelect(select, products, selectedId) {
    if (!select) return;
    const existingValue = String(selectedId);
    select.replaceChildren();
    for (const product of products) {
      const id = normalizePositiveId(product?.id, 0);
      const price = Number(product?.priceGold);
      if (!id || !Number.isFinite(price) || price <= 0) continue;
      const option = document.createElement('option');
      option.value = String(id);
      option.textContent = `${product.name || `Produto ${id}`} · ${formatNumber(price)} gold`;
      select.appendChild(option);
    }
    if ([...select.options].some((option) => option.value === existingValue)) {
      select.value = existingValue;
    }
  }

  function populateProductSelectors() {
    const panel = document.querySelector('#piw-auto-refill-panel');
    if (!panel || !state.shopCatalog) return;
    const potions = state.shopCatalog.items.filter((item) => item?.category === 'heal');
    populateSelect(panel.querySelector('#par-potion-id'), potions, settings.potionItemId);
    populateSelect(panel.querySelector('#par-ball-id'), state.shopCatalog.balls, settings.ballId);
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-auto-refill-panel');
    const dockButton = document.querySelector('#piw-auto-refill-button');
    if (dockButton) {
      dockButton.classList.toggle('par-running', settings.enabled);
      dockButton.classList.toggle('par-busy', state.cycleRunning);
      dockButton.title = settings.enabled ? 'Auto Refill ativo' : 'Auto Refill pausado';
    }
    if (!panel) return;

    panel.querySelector('[data-par="status"]').textContent = state.lastMessage;
    panel.querySelector('[data-par="socket"]').textContent = bridge.isOpen() ? 'Conectado' : 'Aguardando';
    panel.querySelector('[data-par="potion-stock"]').textContent = formatNumber(state.potionStock);
    panel.querySelector('[data-par="ball-stock"]').textContent = formatNumber(state.ballStock);
    panel.querySelector('[data-par="gold"]').textContent = formatNumber(state.currentGold);
    panel.querySelector('[data-par="potion-arm"]').textContent = state.potionArmed ? 'Armado' : 'Aguardando rearme';
    panel.querySelector('[data-par="ball-arm"]').textContent = state.ballArmed ? 'Armado' : 'Aguardando rearme';
    panel.querySelector('.par-toggle').textContent = settings.enabled ? 'Pausar' : 'Ativar';
    panel.querySelector('.par-toggle').disabled = state.cycleRunning;
    panel.querySelector('.par-load-shop').disabled = state.catalogLoading || state.cycleRunning;
    panel.querySelector('.par-load-shop').textContent = state.catalogLoading ? 'Carregando...' : 'Carregar loja';
  }

  function syncFormFromSettings(panel) {
    panel.querySelector('#par-potion-enabled').checked = settings.potionEnabled;
    panel.querySelector('#par-potion-threshold').value = String(settings.potionThreshold);
    panel.querySelector('#par-potion-quantity').value = String(settings.potionQuantity);
    panel.querySelector('#par-ball-enabled').checked = settings.ballEnabled;
    panel.querySelector('#par-ball-threshold').value = String(settings.ballThreshold);
    panel.querySelector('#par-ball-quantity').value = String(settings.ballQuantity);
    panel.querySelector('#par-sell-trash').checked = settings.sellTrash;
    panel.querySelector('#par-gold-reserve').value = String(settings.goldReserve);
  }

  function readFormSettings(panel) {
    return normalizeSettings({
      ...settings,
      potionEnabled: panel.querySelector('#par-potion-enabled').checked,
      potionItemId: panel.querySelector('#par-potion-id').value || settings.potionItemId,
      potionThreshold: panel.querySelector('#par-potion-threshold').value,
      potionQuantity: panel.querySelector('#par-potion-quantity').value,
      ballEnabled: panel.querySelector('#par-ball-enabled').checked,
      ballId: panel.querySelector('#par-ball-id').value || settings.ballId,
      ballThreshold: panel.querySelector('#par-ball-threshold').value,
      ballQuantity: panel.querySelector('#par-ball-quantity').value,
      sellTrash: panel.querySelector('#par-sell-trash').checked,
      goldReserve: panel.querySelector('#par-gold-reserve').value,
    });
  }

  function applySettings(nextSettings, { rearm = true } = {}) {
    Object.assign(settings, normalizeSettings(nextSettings));
    if (rearm) {
      state.potionArmed = true;
      state.ballArmed = true;
    }
    saveSettings();
    recalculateSelectedStocks();
    renderPanel();
  }

  function installStyles() {
    if (document.querySelector('#piw-auto-refill-styles')) return;
    const style = document.createElement('style');
    style.id = 'piw-auto-refill-styles';
    style.textContent = `
      #piw-auto-refill-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
      #piw-auto-refill-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#718096; }
      #piw-auto-refill-button.par-running::after { background:#48bb78;box-shadow:0 0 6px #48bb78; }
      #piw-auto-refill-button.par-busy::after { background:#f6ad55;box-shadow:0 0 7px #f6ad55; }
      #piw-auto-refill-panel[hidden] { display:none!important; }
      #piw-auto-refill-panel { position:fixed;right:18px;top:120px;z-index:10022;width:340px;max-height:78vh;overflow:auto;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);font:13px/1.35 system-ui,sans-serif; }
      #piw-auto-refill-panel header { display:flex;align-items:center;gap:8px;padding:10px 12px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-auto-refill-panel header span { flex:1; }
      #piw-auto-refill-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
      #piw-auto-refill-panel button:disabled { cursor:not-allowed;opacity:.45; }
      #piw-auto-refill-panel .par-close { width:28px;height:28px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:18px; }
      #piw-auto-refill-panel .par-body { padding:11px; }
      #piw-auto-refill-panel .par-status { padding:7px 9px;margin-bottom:8px;border-radius:6px;background:#0a1219;color:#90cdf4;text-align:center;font-weight:700; }
      #piw-auto-refill-panel .par-status.par-error { color:#feb2b2; }
      #piw-auto-refill-panel .par-summary { display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px; }
      #piw-auto-refill-panel .par-card { min-width:0;padding:6px;border:1px solid #20394b;border-radius:6px;background:#101f2a;text-align:center; }
      #piw-auto-refill-panel .par-card small { display:block;color:#718096;font-size:9px;text-transform:uppercase; }
      #piw-auto-refill-panel .par-card b { display:block;overflow:hidden;text-overflow:ellipsis; }
      #piw-auto-refill-panel fieldset { margin:7px 0;padding:8px;border:1px solid #273f52;border-radius:7px; }
      #piw-auto-refill-panel legend { padding:0 5px;color:#90cdf4;font-weight:800; }
      #piw-auto-refill-panel label { display:grid;grid-template-columns:110px 1fr;align-items:center;gap:6px;margin:5px 0; }
      #piw-auto-refill-panel input,#piw-auto-refill-panel select { min-width:0;background:#0a1219;border:1px solid #315269;border-radius:5px;color:#fff;padding:5px 6px; }
      #piw-auto-refill-panel .par-check { display:flex;gap:6px;grid-template-columns:none; }
      #piw-auto-refill-panel .par-check input { min-width:auto; }
      #piw-auto-refill-panel .par-arm { color:#a0aec0;font-size:11px; }
      #piw-auto-refill-panel .par-actions { display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px; }
      #piw-auto-refill-panel .par-toggle { background:#176342;border-color:#299263; }
      #piw-auto-refill-panel .par-danger { color:#feb2b2; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createPanel() {
    if (!document.body || document.querySelector('#piw-auto-refill-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'piw-auto-refill-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>🧰 Auto Refill</span><button class="par-close" type="button">×</button></header>
      <div class="par-body">
        <div class="par-status" data-par="status">Auto Refill pausado.</div>
        <div class="par-summary">
          <div class="par-card"><small>Socket</small><b data-par="socket">Aguardando</b></div>
          <div class="par-card"><small>Potion</small><b data-par="potion-stock">—</b></div>
          <div class="par-card"><small>Ball</small><b data-par="ball-stock">—</b></div>
          <div class="par-card"><small>Gold</small><b data-par="gold">—</b></div>
          <div class="par-card"><small>Potion</small><b class="par-arm" data-par="potion-arm">Armado</b></div>
          <div class="par-card"><small>Ball</small><b class="par-arm" data-par="ball-arm">Armado</b></div>
        </div>
        <fieldset>
          <legend>Potions</legend>
          <label class="par-check"><input id="par-potion-enabled" type="checkbox"> Comprar potions</label>
          <label>Produto <select id="par-potion-id"><option value="203">Hyper Potion</option></select></label>
          <label>Threshold <input id="par-potion-threshold" type="number" min="0" step="1"></label>
          <label>Quantidade <input id="par-potion-quantity" type="number" min="1" max="10000" step="1"></label>
        </fieldset>
        <fieldset>
          <legend>Pokébolas</legend>
          <label class="par-check"><input id="par-ball-enabled" type="checkbox"> Comprar balls</label>
          <label>Produto <select id="par-ball-id"><option value="4">Ultra Ball</option></select></label>
          <label>Threshold <input id="par-ball-threshold" type="number" min="0" step="1"></label>
          <label>Quantidade <input id="par-ball-quantity" type="number" min="1" max="10000" step="1"></label>
        </fieldset>
        <fieldset>
          <legend>Economia</legend>
          <label class="par-check par-danger"><input id="par-sell-trash" type="checkbox"> Vender loot NPC de 1 a 4.000 gold</label>
          <label>Reserva de gold <input id="par-gold-reserve" type="number" min="0" step="1"></label>
        </fieldset>
        <div class="par-actions">
          <button class="par-load-shop" type="button">Carregar loja</button>
          <button class="par-rearm" type="button">Rearmar</button>
          <button class="par-save" type="button">Salvar</button>
          <button class="par-toggle" type="button">Ativar</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    disposePanelDrag?.();
    disposePanelDrag = uiMenu.makePanelDraggable(panel, {
      storageKey: 'piw-auto-refill-panel-position-v1',
      sizeStorageKey: 'piw-auto-refill-panel-size-v1',
    });
    syncFormFromSettings(panel);
    populateProductSelectors();

    panel.querySelector('.par-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.par-load-shop').addEventListener('click', async () => {
      try {
        await loadShop();
        setMessage('Catálogo e gold atualizados.');
      } catch (error) {
        setMessage(`Não foi possível carregar a loja: ${error?.message || String(error)}`, true);
      }
      renderPanel();
    });
    panel.querySelector('.par-save').addEventListener('click', () => {
      applySettings(readFormSettings(panel));
      setMessage('Configurações salvas e categorias rearmadas.');
      renderPanel();
    });
    panel.querySelector('.par-rearm').addEventListener('click', () => {
      state.potionArmed = true;
      state.ballArmed = true;
      setMessage('Categorias rearmadas manualmente.');
      scheduleRefillCheck();
      renderPanel();
    });
    panel.querySelector('.par-toggle').addEventListener('click', () => {
      if (settings.enabled) window.piwAutoRefill.stop();
      else {
        applySettings(readFormSettings(panel));
        window.piwAutoRefill.start();
      }
      renderPanel();
    });
    renderPanel();
  }

  function registerSidebarButton() {
    if (unregisterMenu) return;
    unregisterMenu = uiMenu.register({
      id: 'piw-auto-refill-button',
      label: 'Auto Refill',
      icon: '🧰',
      order: 40,
      onMount: renderPanel,
      onClick() {
        const panel = document.querySelector('#piw-auto-refill-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        renderPanel();
      },
    });
    renderPanel();
  }

  function initializeInterface() {
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

  unsubscribeBridge = bridge.subscribe({
    socket(event) {
      state.socket = event.socket;
      renderPanel();
    },
    open(event) {
      state.socket = event.socket;
      renderPanel();
    },
    close(event) {
      if (state.socket === event.socket) state.socket = null;
      renderPanel();
    },
    incoming(event) {
      handleIncoming(event.message);
    },
  });

  window.piwAutoRefill = {
    installed: true,
    status() {
      return {
        enabled: settings.enabled,
        socketOpen: bridge.isOpen(),
        potionStock: state.potionStock,
        ballStock: state.ballStock,
        potionArmed: state.potionArmed,
        ballArmed: state.ballArmed,
        cycleRunning: state.cycleRunning,
        currentGold: state.currentGold,
        lastMessage: state.lastMessage,
        lastResult: state.lastResult,
        settings: { ...settings },
      };
    },
    configure(patch) {
      applySettings({ ...settings, ...patch });
      return this.status();
    },
    start() {
      settings.enabled = true;
      state.potionArmed = true;
      state.ballArmed = true;
      saveSettings();
      setMessage('Auto Refill ativo. Aguardando estoque do jogo.');
      scheduleRefillCheck();
      renderPanel();
      return this.status();
    },
    stop() {
      settings.enabled = false;
      saveSettings();
      if (state.cycleTimer) clearTimeout(state.cycleTimer);
      state.cycleTimer = null;
      setMessage(state.cycleRunning
        ? 'Pausa agendada após a request atual.'
        : 'Auto Refill pausado.');
      renderPanel();
      return this.status();
    },
    rearm(category = 'all') {
      if (category === 'all' || category === 'potion') state.potionArmed = true;
      if (category === 'all' || category === 'ball') state.ballArmed = true;
      scheduleRefillCheck();
      renderPanel();
      return this.status();
    },
    loadShop,
    splitPurchaseBatches,
    uninstall() {
      state.installed = false;
      settings.enabled = false;
      if (state.cycleTimer) clearTimeout(state.cycleTimer);
      state.cycleTimer = null;
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
      document.querySelector('#piw-auto-refill-panel')?.remove();
      document.querySelector('#piw-auto-refill-button')?.remove();
      document.querySelector('#piw-auto-refill-styles')?.remove();
      delete window.piwAutoRefill;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeInterface, { once: true });
  } else {
    initializeInterface();
  }

  log('Instalado em modo pausado. Nenhuma compra ou venda foi executada.');
})();
