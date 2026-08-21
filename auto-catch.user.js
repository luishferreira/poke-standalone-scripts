// ==UserScript==
// @name         PIW Auto Catch
// @namespace    poke-manager
// @version      1.5.1
// @description  Captura automaticamente os Pokémon pendentes usando o WebSocket do jogo.
// @author       Luis
// @match        https://poke.idleworld.online/play*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-catch.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-catch.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.
// Fonte: src/auto-catch.js

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

(function installPiwAutoCatch() {
  'use strict';

  if (window.piwAutoCatch?.installed) {
    console.warn('[PIW Auto Catch] Já está instalado nesta página.');
    return;
  }

  const bridge = window.piwScripts?.wsBridge;
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[PIW Auto Catch] PIW WS Bridge v1 indisponível. Auto Catch não instalado.');
    return;
  }

  const MIN_CATCH_DELAY_MS = 4_200;
  const MAX_CATCH_DELAY_MS = 5_000;
  const CATCH_RESPONSE_TIMEOUT_MS = 5_000;
  const BALL_REFRESH_COOLDOWN_MS = 2_000;
  const MAX_ATTEMPTED_PENDING_IDS = 2_000;
  const DEFAULT_NORMAL_BALL_ID = 4;
  const DEFAULT_SHINY_BALL_ID = 6;
  const BALL_OPTIONS = [
    { id: 1, name: 'Poke Ball' },
    { id: 2, name: 'Great Ball' },
    { id: 3, name: 'Super Ball' },
    { id: 4, name: 'Ultra Ball' },
    { id: 6, name: 'Idle Ball' },
  ];
  const AVAILABLE_BALL_IDS = BALL_OPTIONS.map((ball) => ball.id);
  const SETTINGS_KEY = 'piw-auto-catch-settings-v1';

  function normalizeBallId(ballId, fallback) {
    const normalized = Number(ballId);
    return AVAILABLE_BALL_IDS.includes(normalized) ? normalized : fallback;
  }

  function loadSettings() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SETTINGS_KEY) || '{}');
      const legacyBallId = normalizeBallId(saved.ballId, DEFAULT_NORMAL_BALL_ID);
      return {
        enabled: saved.enabled !== false,
        normalBallId: normalizeBallId(saved.normalBallId, legacyBallId),
        shinyBallId: normalizeBallId(saved.shinyBallId, DEFAULT_SHINY_BALL_ID),
      };
    } catch {
      return {
        enabled: true,
        normalBallId: DEFAULT_NORMAL_BALL_ID,
        shinyBallId: DEFAULT_SHINY_BALL_ID,
      };
    }
  }

  const savedSettings = loadSettings();

  const state = {
    enabled: savedSettings.enabled,
    socket: null,
    normalBallId: savedSettings.normalBallId,
    shinyBallId: savedSettings.shinyBallId,
    ballCounts: null,
    latestPending: new Map(),
    attemptedPendingIds: new Set(),
    attemptedPendingOrder: [],
    inFlight: null,
    responseTimer: null,
    workerTimer: null,
    ballsRequestTimer: null,
    workerRunning: false,
    nextCatchTime: 0,
    lastBallsRequestAt: 0,
    stockWarning: null,
    vipAutoCatchDetected: false,
    vipAutoCatchNormal: false,
    vipAutoCatchShiny: false,
    sent: 0,
    successes: 0,
    failures: 0,
  };
  let interfaceObserver = null;
  let unsubscribeBridge = null;

  function saveSettings() {
    try {
      sessionStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          enabled: state.enabled,
          normalBallId: state.normalBallId,
          shinyBallId: state.shinyBallId,
        }),
      );
    } catch {
      // O autocatch continua funcionando mesmo se o navegador bloquear o storage.
    }
  }

  function log(message, details) {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    console.log(`[PIW Auto Catch] ${message}${suffix}`);
  }

  function getBallName(ballId) {
    return BALL_OPTIONS.find((ball) => ball.id === ballId)?.name || `Ball ${ballId}`;
  }

  function getBallQuantity(ballId) {
    if (!state.ballCounts) return null;
    return Math.max(0, Number(state.ballCounts[ballId]) || 0);
  }

  function getBlockingMessage() {
    if (state.vipAutoCatchDetected) {
      const modes = [
        state.vipAutoCatchNormal ? 'normal' : null,
        state.vipAutoCatchShiny ? 'shiny' : null,
      ].filter(Boolean).join(' e ');
      return `Autocatch VIP ${modes ? `(${modes}) ` : ''}detectado. Captura manual bloqueada.`;
    }
    if (state.enabled && !state.ballCounts) return 'Aguardando o estoque de Pokébolas.';
    return state.stockWarning;
  }

  function formatBallQuantity(ballId) {
    const quantity = getBallQuantity(ballId);
    return quantity == null ? '—' : quantity.toLocaleString('pt-BR');
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-auto-catch-panel');
    const button = document.querySelector('#piw-auto-catch-button');
    const socketOpen = state.socket?.readyState === WebSocket.OPEN;
    const blockingMessage = getBlockingMessage();
    const blocked = state.enabled && Boolean(blockingMessage);

    if (button) {
      button.classList.toggle('pac-off', !state.enabled);
      button.classList.toggle('pac-waiting', state.enabled && (!socketOpen || blocked));
      button.title =
        `Auto Catch: ${state.enabled ? 'ativo' : 'pausado'}` +
        ` · Normal: ${getBallName(state.normalBallId)}` +
        ` · Shiny: ${getBallName(state.shinyBallId)}` +
        (blockingMessage ? ` · ${blockingMessage}` : '');
    }
    if (!panel) return;

    panel.querySelector('[data-pac="status"]').textContent = !state.enabled
      ? 'Pausado'
      : blocked ? 'Bloqueado' : 'Ativo';
    panel.querySelector('[data-pac="status"]').classList.toggle('pac-paused', !state.enabled);
    panel.querySelector('[data-pac="status"]').classList.toggle('pac-blocked', blocked);
    panel.querySelector('[data-pac="socket"]').textContent = socketOpen ? 'Conectado' : 'Aguardando';
    panel.querySelector('[data-pac="pending"]').textContent = String(state.latestPending.size);
    panel.querySelector('[data-pac="successes"]').textContent = String(state.successes);
    panel.querySelector('[data-pac="failures"]').textContent = String(state.failures);
    panel.querySelector('[data-pac="normal-stock"]').textContent = formatBallQuantity(state.normalBallId);
    panel.querySelector('[data-pac="shiny-stock"]').textContent = formatBallQuantity(state.shinyBallId);
    const warning = panel.querySelector('.pac-warning');
    warning.hidden = !blockingMessage;
    warning.textContent = blockingMessage || '';
    panel.querySelector('.pac-toggle').textContent = state.enabled ? 'Desativar' : 'Ativar';
    panel.querySelector('.pac-normal-ball').value = String(state.normalBallId);
    panel.querySelector('.pac-shiny-ball').value = String(state.shinyBallId);
  }

  function installPanelStyles() {
    if (document.querySelector('#piw-auto-catch-styles')) return;
    const style = document.createElement('style');
    style.id = 'piw-auto-catch-styles';
    style.textContent = `
      #piw-auto-catch-button { background:transparent;border:0;box-shadow:none;font-size:17px;position:relative; }
      #piw-auto-catch-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#48bb78;box-shadow:0 0 6px #48bb78; }
      #piw-auto-catch-button.pac-waiting::after { background:#f6ad55;box-shadow:0 0 7px #f6ad55; }
      #piw-auto-catch-button.pac-off::after { background:#718096;box-shadow:none; }
      #piw-auto-catch-panel[hidden] { display:none !important; }
      #piw-auto-catch-panel { position:fixed;right:18px;top:140px;z-index:10022;width:270px;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
      #piw-auto-catch-panel header { display:flex;align-items:center;gap:8px;padding:10px 12px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-auto-catch-panel header span { flex:1; }
      #piw-auto-catch-panel button,#piw-auto-catch-panel select { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700; }
      #piw-auto-catch-panel button { cursor:pointer; }
      #piw-auto-catch-panel .pac-close { width:28px;height:28px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:18px; }
      #piw-auto-catch-panel .pac-body { padding:11px; }
      #piw-auto-catch-panel .pac-state { margin-bottom:9px;padding:7px 9px;border-radius:6px;background:#123a2b;color:#9ae6b4;text-align:center;font-weight:800; }
      #piw-auto-catch-panel .pac-state.pac-paused { background:#252e38;color:#a0aec0; }
      #piw-auto-catch-panel .pac-state.pac-blocked { background:#4a2f12;color:#fbd38d; }
      #piw-auto-catch-panel .pac-warning { margin:0 0 9px;padding:7px 9px;border:1px solid #8b5b20;border-radius:6px;background:#3b2811;color:#fbd38d;font-size:11px;font-weight:700; }
      #piw-auto-catch-panel .pac-warning[hidden] { display:none !important; }
      #piw-auto-catch-panel label { display:block;margin:9px 0 5px;color:#a9bfd0;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.04em; }
      #piw-auto-catch-panel .pac-ball { width:100%;box-sizing:border-box; }
      #piw-auto-catch-panel .pac-grid { display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin-top:9px; }
      #piw-auto-catch-panel .pac-card { padding:7px 8px;border:1px solid #243b4c;border-radius:7px;background:#0a1219; }
      #piw-auto-catch-panel .pac-card small { display:block;color:#7891a4;font-size:10px; }
      #piw-auto-catch-panel .pac-card b { display:block;margin-top:2px;color:#d9e7f2; }
      #piw-auto-catch-panel .pac-toggle { width:100%;margin-top:10px;background:#176342;border-color:#299263; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function createPanel() {
    if (!document.body || document.querySelector('#piw-auto-catch-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'piw-auto-catch-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>🎯 Auto Catch</span><button class="pac-close" type="button">×</button></header>
      <div class="pac-body">
        <div class="pac-state" data-pac="status">Ativo</div>
        <div class="pac-warning" hidden></div>
        <label for="piw-auto-catch-normal-ball">Pokémon normal</label>
        <select id="piw-auto-catch-normal-ball" class="pac-ball pac-normal-ball">
          ${BALL_OPTIONS.map((ball) => `<option value="${ball.id}">${ball.name}</option>`).join('')}
        </select>
        <label for="piw-auto-catch-shiny-ball">Pokémon shiny</label>
        <select id="piw-auto-catch-shiny-ball" class="pac-ball pac-shiny-ball">
          ${BALL_OPTIONS.map((ball) => `<option value="${ball.id}">${ball.name}</option>`).join('')}
        </select>
        <div class="pac-grid">
          <div class="pac-card"><small>WebSocket</small><b data-pac="socket">Aguardando</b></div>
          <div class="pac-card"><small>Na fila</small><b data-pac="pending">0</b></div>
          <div class="pac-card"><small>Capturados</small><b data-pac="successes">0</b></div>
          <div class="pac-card"><small>Falhas</small><b data-pac="failures">0</b></div>
          <div class="pac-card"><small>Estoque normal</small><b data-pac="normal-stock">—</b></div>
          <div class="pac-card"><small>Estoque shiny</small><b data-pac="shiny-stock">—</b></div>
        </div>
        <button class="pac-toggle" type="button">Desativar</button>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.pac-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.pac-toggle').addEventListener('click', () => {
      if (state.enabled) window.piwAutoCatch.stop();
      else window.piwAutoCatch.start();
    });
    panel.querySelector('.pac-normal-ball').addEventListener('change', (event) => {
      window.piwAutoCatch.setNormalBall(event.target.value);
    });
    panel.querySelector('.pac-shiny-ball').addEventListener('change', (event) => {
      window.piwAutoCatch.setShinyBall(event.target.value);
    });
    renderPanel();
  }

  function injectDockButton() {
    const dock = document.querySelector('nav.game-dock');
    if (!dock || dock.querySelector('#piw-auto-catch-button')) return;
    const button = document.createElement('button');
    button.id = 'piw-auto-catch-button';
    button.className = 'dock-btn';
    button.type = 'button';
    button.textContent = '🎯';
    button.addEventListener('click', () => {
      const panel = document.querySelector('#piw-auto-catch-panel');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      renderPanel();
    });
    dock.appendChild(button);
    renderPanel();
  }

  function installInterface() {
    if (!document.documentElement) {
      document.addEventListener('DOMContentLoaded', installInterface, { once: true });
      return;
    }
    installPanelStyles();
    createPanel();
    injectDockButton();
    if (interfaceObserver || !document.documentElement) return;
    interfaceObserver = new MutationObserver(() => {
      createPanel();
      injectDockButton();
    });
    interfaceObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function getCatchDelayMs() {
    return (
      Math.floor(Math.random() * (MAX_CATCH_DELAY_MS - MIN_CATCH_DELAY_MS + 1)) +
      MIN_CATCH_DELAY_MS
    );
  }

  function clearResponseTimer() {
    if (state.responseTimer) clearTimeout(state.responseTimer);
    state.responseTimer = null;
  }

  function clearWorkerTimer() {
    if (state.workerTimer) clearTimeout(state.workerTimer);
    state.workerTimer = null;
  }

  function clearBallsRequestTimer() {
    if (state.ballsRequestTimer) clearTimeout(state.ballsRequestTimer);
    state.ballsRequestTimer = null;
  }

  function getBallIdForTarget(target) {
    return target?.shiny === true ? state.shinyBallId : state.normalBallId;
  }

  function setStockWarning(message) {
    if (state.stockWarning === message) return;
    state.stockWarning = message;
    renderPanel();
  }

  function markPendingAttempted(pendingId) {
    const id = String(pendingId);
    if (state.attemptedPendingIds.has(id)) return;
    state.attemptedPendingIds.add(id);
    state.attemptedPendingOrder.push(id);
    while (state.attemptedPendingOrder.length > MAX_ATTEMPTED_PENDING_IDS) {
      const oldestId = state.attemptedPendingOrder.shift();
      state.attemptedPendingIds.delete(oldestId);
    }
  }

  function clearSocketCatchState() {
    state.latestPending.clear();
    state.attemptedPendingIds.clear();
    state.attemptedPendingOrder = [];
    state.ballCounts = null;
    state.stockWarning = null;
    state.vipAutoCatchDetected = false;
    state.vipAutoCatchNormal = false;
    state.vipAutoCatchShiny = false;
    state.nextCatchTime = 0;
    state.lastBallsRequestAt = 0;
    clearWorkerTimer();
    clearBallsRequestTimer();
    clearResponseTimer();
    state.inFlight = null;
  }

  function getNextCatchCandidate() {
    if (!state.ballCounts) {
      setStockWarning(null);
      requestBallSnapshot();
      return null;
    }

    const unavailableBalls = new Map();
    for (const target of state.latestPending.values()) {
      const pendingId = String(target.id);
      if (state.attemptedPendingIds.has(pendingId)) continue;
      const ballId = getBallIdForTarget(target);
      if (getBallQuantity(ballId) > 0) {
        setStockWarning(null);
        return { target, ballId };
      }
      unavailableBalls.set(ballId, getBallName(ballId));
    }

    if (unavailableBalls.size > 0) {
      setStockWarning(`Sem estoque: ${[...unavailableBalls.values()].join(', ')}.`);
    } else {
      setStockWarning(null);
    }
    return null;
  }

  function sendDirect(payload) {
    if (!state.socket || bridge.getSocket() !== state.socket || !bridge.isOpen()) return false;
    return bridge.sendJson(payload);
  }

  function requestBallSnapshot({ force = false } = {}) {
    if (!state.enabled || state.vipAutoCatchDetected) return false;
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;

    const waitMs = Math.max(0, BALL_REFRESH_COOLDOWN_MS - (Date.now() - state.lastBallsRequestAt));
    if (!force && waitMs > 0) {
      if (!state.ballsRequestTimer) {
        state.ballsRequestTimer = setTimeout(() => {
          state.ballsRequestTimer = null;
          requestBallSnapshot({ force: true });
        }, waitMs);
      }
      return false;
    }

    clearBallsRequestTimer();
    if (!sendDirect({ type: 'balls-get' })) return false;
    state.lastBallsRequestAt = Date.now();
    return true;
  }

  function wakeCatchWorker() {
    if (
      !state.enabled ||
      state.vipAutoCatchDetected ||
      state.workerRunning ||
      state.workerTimer ||
      state.inFlight
    ) return;

    const waitMs = Math.max(0, state.nextCatchTime - Date.now());
    if (waitMs > 0) {
      state.workerTimer = setTimeout(() => {
        state.workerTimer = null;
        runCatchWorker();
      }, waitMs);
      return;
    }

    runCatchWorker();
  }

  function releaseInFlight({ pendingId = null } = {}) {
    if (!state.inFlight) return false;
    if (pendingId != null && String(pendingId) !== String(state.inFlight.pendingId)) return false;

    const releasedBallId = state.inFlight.ballId;
    clearResponseTimer();
    state.inFlight = null;
    if (getBallQuantity(releasedBallId) === 0) requestBallSnapshot();
    wakeCatchWorker();
    return true;
  }

  function runCatchWorker() {
    if (state.vipAutoCatchDetected || !state.enabled || state.workerRunning || state.inFlight) return;
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;

    const candidate = getNextCatchCandidate();
    if (!candidate) return;

    const waitMs = Math.max(0, state.nextCatchTime - Date.now());
    if (waitMs > 0) {
      wakeCatchWorker();
      return;
    }

    state.workerRunning = true;
    try {
      const { target, ballId } = candidate;
      const payload = {
        type: 'catch',
        pendingId: target.id,
        ballId,
      };
      if (!sendDirect(payload)) return;

      const pendingId = String(target.id);
      markPendingAttempted(pendingId);
      state.latestPending.delete(pendingId);
      state.ballCounts[ballId] = Math.max(0, getBallQuantity(ballId) - 1);
      state.inFlight = { pendingId: target.id, ballId, shiny: target.shiny === true };
      state.nextCatchTime = Date.now() + getCatchDelayMs();
      state.sent += 1;
      log('Captura enviada.', payload);

      const expectedPendingId = String(target.id);
      state.responseTimer = setTimeout(() => {
        if (!state.inFlight || String(state.inFlight.pendingId) !== expectedPendingId) return;
        state.failures += 1;
        log('Resposta da captura expirou; alvo removido.', { pendingId: expectedPendingId });
        releaseInFlight({ pendingId: expectedPendingId });
        renderPanel();
      }, CATCH_RESPONSE_TIMEOUT_MS);
    } finally {
      state.workerRunning = false;
    }
  }

  function updateVipAutoCatchState({ detected, normal = false, shiny = false }) {
    const changed =
      state.vipAutoCatchDetected !== detected ||
      state.vipAutoCatchNormal !== normal ||
      state.vipAutoCatchShiny !== shiny;

    state.vipAutoCatchDetected = detected;
    state.vipAutoCatchNormal = normal;
    state.vipAutoCatchShiny = shiny;

    if (detected) {
      clearWorkerTimer();
      state.stockWarning = null;
      if (changed) log('Autocatch VIP detectado; captura manual bloqueada.', { normal, shiny });
    } else if (changed) {
      log('Autocatch VIP não está ativo; captura manual liberada.');
      requestBallSnapshot();
      wakeCatchWorker();
    }
    renderPanel();
  }

  function handleMessage(message) {
    if (!message?.type) return;

    if (message.type === 'autohelper') {
      const normal = message.autoCatch === true;
      const shiny = message.autoCatchShiny === true;
      updateVipAutoCatchState({ detected: normal || shiny, normal, shiny });
      return;
    }

    if (message.type === 'balls' && message.counts && typeof message.counts === 'object') {
      const counts = {};
      for (const [rawBallId, rawQuantity] of Object.entries(message.counts)) {
        const ballId = Number(rawBallId);
        const quantity = Math.max(0, Number(rawQuantity) || 0);
        if (Number.isInteger(ballId) && ballId > 0) counts[ballId] = quantity;
      }
      state.ballCounts = counts;
      state.stockWarning = null;
      renderPanel();
      wakeCatchWorker();
      return;
    }

    if (message.type === 'pending' && Array.isArray(message.list)) {
      state.latestPending = new Map(
        message.list
          .filter((target) => target?.id != null)
          .filter((target) => !state.attemptedPendingIds.has(String(target.id)))
          .map((target) => [String(target.id), target]),
      );
      renderPanel();
      wakeCatchWorker();
      return;
    }

    if (message.type === 'catch-result') {
      if (message.auto === true) {
        updateVipAutoCatchState({ detected: true });
        return;
      }
      const released = releaseInFlight({ pendingId: message.pendingId });
      if (!released) return;
      if (message.success === true) state.successes += 1;
      else state.failures += 1;
      renderPanel();
      return;
    }

    if (message.type === 'catch-cooldown') {
      if (!releaseInFlight()) return;
      state.failures += 1;
      renderPanel();
      return;
    }

    if (
      message.type === 'error' &&
      typeof message.message === 'string' &&
      message.message.includes('não está disponível')
    ) {
      if (!releaseInFlight()) return;
      state.failures += 1;
      renderPanel();
    }
  }

  function scheduleInitialBallSnapshot(socket) {
    if (!state.enabled || state.ballsRequestTimer) return;
    state.ballsRequestTimer = setTimeout(() => {
      state.ballsRequestTimer = null;
      if (state.socket === socket && bridge.getSocket() === socket) requestBallSnapshot();
    }, 0);
  }

  function adoptSocket(socket) {
    if (!socket) return;
    const replaced = Boolean(state.socket && state.socket !== socket);
    if (replaced) clearSocketCatchState();
    state.socket = socket;
    if (socket.readyState === WebSocket.OPEN) scheduleInitialBallSnapshot(socket);
    log(replaced ? 'WebSocket do jogo substituído.' : 'WebSocket do jogo identificado.');
    renderPanel();
  }

  unsubscribeBridge = bridge.subscribe({
    socket(event) {
      adoptSocket(event.socket);
    },
    open(event) {
      if (bridge.getSocket() !== event.socket) return;
      state.socket = event.socket;
      requestBallSnapshot();
      log('WebSocket do jogo conectado.');
      renderPanel();
    },
    close(event) {
      if (state.socket === event.socket) {
        state.socket = null;
        clearSocketCatchState();
      }
      renderPanel();
    },
    incoming(event) {
      handleMessage(event.message);
    },
  });

  adoptSocket(bridge.getSocket());

  window.piwAutoCatch = {
    installed: true,
    start() {
      state.enabled = true;
      saveSettings();
      requestBallSnapshot({ force: true });
      wakeCatchWorker();
      log('Ativado.');
      renderPanel();
      return this.status();
    },
    stop() {
      state.enabled = false;
      clearWorkerTimer();
      clearBallsRequestTimer();
      clearResponseTimer();
      state.inFlight = null;
      state.latestPending.clear();
      saveSettings();
      log('Pausado.');
      renderPanel();
      return this.status();
    },
    setBall(ballId) {
      return this.setNormalBall(ballId);
    },
    setNormalBall(ballId) {
      const normalized = Number(ballId);
      if (!AVAILABLE_BALL_IDS.includes(normalized)) {
        throw new Error('Pokébola normal inválida.');
      }
      state.normalBallId = normalized;
      state.stockWarning = null;
      saveSettings();
      log('Pokébola normal alterada.', { ballId: normalized });
      requestBallSnapshot({ force: true });
      wakeCatchWorker();
      renderPanel();
      return this.status();
    },
    setShinyBall(ballId) {
      const normalized = Number(ballId);
      if (!AVAILABLE_BALL_IDS.includes(normalized)) {
        throw new Error('Pokébola shiny inválida.');
      }
      state.shinyBallId = normalized;
      state.stockWarning = null;
      saveSettings();
      log('Pokébola shiny alterada.', { ballId: normalized });
      requestBallSnapshot({ force: true });
      wakeCatchWorker();
      renderPanel();
      return this.status();
    },
    status() {
      return {
        enabled: state.enabled,
        socketOpen: state.socket?.readyState === WebSocket.OPEN,
        ballId: state.normalBallId,
        normalBallId: state.normalBallId,
        shinyBallId: state.shinyBallId,
        normalBallStock: getBallQuantity(state.normalBallId),
        shinyBallStock: getBallQuantity(state.shinyBallId),
        stockKnown: Boolean(state.ballCounts),
        blocked:
          state.enabled &&
          (state.vipAutoCatchDetected || !state.ballCounts || Boolean(state.stockWarning)),
        blockingMessage: getBlockingMessage(),
        vipAutoCatchDetected: state.vipAutoCatchDetected,
        vipAutoCatchNormal: state.vipAutoCatchNormal,
        vipAutoCatchShiny: state.vipAutoCatchShiny,
        pending: state.latestPending.size,
        attempted: state.attemptedPendingIds.size,
        inFlight: state.inFlight ? { ...state.inFlight } : null,
        nextCatchInMs: Math.max(0, state.nextCatchTime - Date.now()),
        sent: state.sent,
        successes: state.successes,
        failures: state.failures,
      };
    },
    uninstall() {
      this.stop();
      unsubscribeBridge?.();
      unsubscribeBridge = null;
      interfaceObserver?.disconnect();
      clearBallsRequestTimer();
      document.querySelector('#piw-auto-catch-panel')?.remove();
      document.querySelector('#piw-auto-catch-button')?.remove();
      document.querySelector('#piw-auto-catch-styles')?.remove();
      delete window.piwAutoCatch;
      log('Removido. Inscrição no WebSocket bridge encerrada.');
    },
  };

  installInterface();

  log('Instalado. Aguardando o WebSocket e a próxima lista pending.', {
    normalBallId: state.normalBallId,
    shinyBallId: state.shinyBallId,
    delay: `${MIN_CATCH_DELAY_MS}-${MAX_CATCH_DELAY_MS}ms`,
  });
})();
