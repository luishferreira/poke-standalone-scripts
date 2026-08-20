// ==UserScript==
// @name         PIW Auto Catch
// @namespace    poke-manager
// @version      1.1.0
// @description  Captura automaticamente os Pokémon pendentes usando o WebSocket do jogo.
// @author       Keita
// @match        https://poke.idleworld.online/play*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function installPiwAutoCatch() {
  'use strict';

  if (window.piwAutoCatch?.installed) {
    console.warn('[PIW Auto Catch] Já está instalado nesta página.');
    return;
  }

  const MIN_CATCH_DELAY_MS = 4_200;
  const MAX_CATCH_DELAY_MS = 5_000;
  const CATCH_RESPONSE_TIMEOUT_MS = 5_000;
  const DEFAULT_BALL_ID = 4;
  const BALL_OPTIONS = [
    { id: 1, name: 'Poke Ball' },
    { id: 2, name: 'Great Ball' },
    { id: 3, name: 'Super Ball' },
    { id: 4, name: 'Ultra Ball' },
    { id: 6, name: 'Idle Ball' },
  ];
  const AVAILABLE_BALL_IDS = BALL_OPTIONS.map((ball) => ball.id);
  const SETTINGS_KEY = 'piw-auto-catch-settings-v1';

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        enabled: saved.enabled !== false,
        ballId: AVAILABLE_BALL_IDS.includes(Number(saved.ballId))
          ? Number(saved.ballId)
          : DEFAULT_BALL_ID,
      };
    } catch {
      return { enabled: true, ballId: DEFAULT_BALL_ID };
    }
  }

  const savedSettings = loadSettings();

  const originalSend = WebSocket.prototype.send;
  const attachedSockets = new WeakSet();
  const state = {
    enabled: true,
    enabled: savedSettings.enabled,
    socket: null,
    ballId: DEFAULT_BALL_ID,
    ballId: savedSettings.ballId,
    latestPending: new Map(),
    inFlight: null,
    responseTimer: null,
    workerTimer: null,
    workerRunning: false,
    nextCatchTime: 0,
    sent: 0,
    successes: 0,
    failures: 0,
  };
  let interfaceObserver = null;

  function saveSettings() {
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ enabled: state.enabled, ballId: state.ballId }),
      );
    } catch {
      // O autocatch continua funcionando mesmo se o navegador bloquear o storage.
    }
  }

  function log(message, details) {
    const suffix = details === undefined ? '' : ` ${JSON.stringify(details)}`;
    console.log(`[PIW Auto Catch] ${message}${suffix}`);
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-auto-catch-panel');
    const button = document.querySelector('#piw-auto-catch-button');
    const socketOpen = state.socket?.readyState === WebSocket.OPEN;

    if (button) {
      button.classList.toggle('pac-off', !state.enabled);
      button.classList.toggle('pac-waiting', state.enabled && !socketOpen);
      button.title = `Auto Catch: ${state.enabled ? 'ativo' : 'pausado'} · Ball ${state.ballId}`;
    }
    if (!panel) return;

    panel.querySelector('[data-pac="status"]').textContent = state.enabled ? 'Ativo' : 'Pausado';
    panel.querySelector('[data-pac="status"]').classList.toggle('pac-paused', !state.enabled);
    panel.querySelector('[data-pac="socket"]').textContent = socketOpen ? 'Conectado' : 'Aguardando';
    panel.querySelector('[data-pac="pending"]').textContent = String(state.latestPending.size);
    panel.querySelector('[data-pac="successes"]').textContent = String(state.successes);
    panel.querySelector('[data-pac="failures"]').textContent = String(state.failures);
    panel.querySelector('.pac-toggle').textContent = state.enabled ? 'Desativar' : 'Ativar';
    panel.querySelector('.pac-ball').value = String(state.ballId);
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
        <label for="piw-auto-catch-ball">Pokébola</label>
        <select id="piw-auto-catch-ball" class="pac-ball">
          ${BALL_OPTIONS.map((ball) => `<option value="${ball.id}">${ball.name}</option>`).join('')}
        </select>
        <div class="pac-grid">
          <div class="pac-card"><small>WebSocket</small><b data-pac="socket">Aguardando</b></div>
          <div class="pac-card"><small>Na fila</small><b data-pac="pending">0</b></div>
          <div class="pac-card"><small>Capturados</small><b data-pac="successes">0</b></div>
          <div class="pac-card"><small>Falhas</small><b data-pac="failures">0</b></div>
        </div>
        <button class="pac-toggle" type="button">Desativar</button>
      </div>`;
    document.body.appendChild(panel);
    panel.querySelector('.pac-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.pac-toggle').addEventListener('click', () => {
      if (state.enabled) window.piwAutoCatch.stop();
      else window.piwAutoCatch.start();
    });
    panel.querySelector('.pac-ball').addEventListener('change', (event) => {
      window.piwAutoCatch.setBall(event.target.value);
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

  function parseFrame(data) {
    if (typeof data !== 'string') return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function isGameSocket(socket) {
    return typeof socket?.url === 'string' && socket.url.includes('/ws');
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

  function getNextTarget() {
    return state.latestPending.values().next().value || null;
  }

  function sendDirect(payload) {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return false;
    originalSend.call(state.socket, JSON.stringify(payload));
    return true;
  }

  function wakeCatchWorker() {
    if (!state.enabled || state.workerRunning || state.workerTimer || state.inFlight) return;

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

  function releaseInFlight({ pendingId = null, dropTarget = false } = {}) {
    if (!state.inFlight) return false;
    if (pendingId != null && String(pendingId) !== String(state.inFlight.pendingId)) return false;

    const releasedId = String(state.inFlight.pendingId);
    clearResponseTimer();
    state.inFlight = null;
    if (dropTarget) state.latestPending.delete(releasedId);
    wakeCatchWorker();
    return true;
  }

  function runCatchWorker() {
    if (!state.enabled || state.workerRunning || state.inFlight) return;
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;

    const target = getNextTarget();
    if (!target) return;

    const waitMs = Math.max(0, state.nextCatchTime - Date.now());
    if (waitMs > 0) {
      wakeCatchWorker();
      return;
    }

    state.workerRunning = true;
    try {
      const payload = {
        type: 'catch',
        pendingId: target.id,
        ballId: state.ballId,
      };
      if (!sendDirect(payload)) return;

      state.inFlight = { pendingId: target.id, ballId: state.ballId };
      state.nextCatchTime = Date.now() + getCatchDelayMs();
      state.sent += 1;
      log('Captura enviada.', payload);

      const expectedPendingId = String(target.id);
      state.responseTimer = setTimeout(() => {
        if (!state.inFlight || String(state.inFlight.pendingId) !== expectedPendingId) return;
        state.failures += 1;
        log('Resposta da captura expirou; alvo removido.', { pendingId: expectedPendingId });
        releaseInFlight({ pendingId: expectedPendingId, dropTarget: true });
        renderPanel();
      }, CATCH_RESPONSE_TIMEOUT_MS);
    } finally {
      state.workerRunning = false;
    }
  }

  function handleMessage(event) {
    const message = parseFrame(event.data);
    if (!message?.type) return;

    if (message.type === 'pending' && Array.isArray(message.list)) {
      state.latestPending = new Map(
        message.list
          .filter((target) => target?.id != null)
          .map((target) => [String(target.id), target]),
      );
      renderPanel();
      wakeCatchWorker();
      return;
    }

    if (message.type === 'catch-result') {
      if (message.success) state.successes += 1;
      else state.failures += 1;
      releaseInFlight({ pendingId: message.pendingId, dropTarget: message.success === true });
      renderPanel();
      return;
    }

    if (message.type === 'catch-cooldown') {
      state.failures += 1;
      releaseInFlight({ dropTarget: true });
      renderPanel();
      return;
    }

    if (
      message.type === 'error' &&
      typeof message.message === 'string' &&
      message.message.includes('não está disponível')
    ) {
      state.failures += 1;
      releaseInFlight({ dropTarget: true });
      renderPanel();
    }
  }

  function attachSocket(socket) {
    if (!isGameSocket(socket) || attachedSockets.has(socket)) return;
    attachedSockets.add(socket);
    if (state.socket && state.socket !== socket) {
      state.latestPending.clear();
      clearResponseTimer();
      state.inFlight = null;
      renderPanel();
    }
    state.socket = socket;
    socket.addEventListener('message', handleMessage);
    socket.addEventListener('open', () => {
      state.socket = socket;
      wakeCatchWorker();
      log('WebSocket do jogo conectado.');
      renderPanel();
    });
    socket.addEventListener('close', () => {
      if (state.socket === socket) {
        state.socket = null;
        state.latestPending.clear();
        clearResponseTimer();
        state.inFlight = null;
      }
      renderPanel();
    });
    log('WebSocket do jogo identificado.');
  }

  const patchedSend = function patchedSend(data) {
    if (isGameSocket(this)) attachSocket(this);
    return originalSend.apply(this, arguments);
  };
  WebSocket.prototype.send = patchedSend;

  if (isGameSocket(window.myGameSocket)) attachSocket(window.myGameSocket);

  window.piwAutoCatch = {
    installed: true,
    start() {
      state.enabled = true;
      saveSettings();
      wakeCatchWorker();
      log('Ativado.');
      renderPanel();
      return this.status();
    },
    stop() {
      state.enabled = false;
      clearWorkerTimer();
      clearResponseTimer();
      state.inFlight = null;
      state.latestPending.clear();
      saveSettings();
      log('Pausado.');
      renderPanel();
      return this.status();
    },
    setBall(ballId) {
      const normalized = Number(ballId);
      if (!Number.isInteger(normalized) || normalized <= 0) {
        throw new Error('ballId precisa ser um número inteiro positivo.');
      }
      state.ballId = normalized;
      saveSettings();
      log('Pokébola alterada.', { ballId: normalized });
      renderPanel();
      return this.status();
    },
    status() {
      return {
        enabled: state.enabled,
        socketOpen: state.socket?.readyState === WebSocket.OPEN,
        ballId: state.ballId,
        pending: state.latestPending.size,
        inFlight: state.inFlight ? { ...state.inFlight } : null,
        nextCatchInMs: Math.max(0, state.nextCatchTime - Date.now()),
        sent: state.sent,
        successes: state.successes,
        failures: state.failures,
      };
    },
    uninstall() {
      this.stop();
      interfaceObserver?.disconnect();
      if (WebSocket.prototype.send === patchedSend) WebSocket.prototype.send = originalSend;
      document.querySelector('#piw-auto-catch-panel')?.remove();
      document.querySelector('#piw-auto-catch-button')?.remove();
      document.querySelector('#piw-auto-catch-styles')?.remove();
      delete window.piwAutoCatch;
      log('Removido. Recarregue a página para remover listeners de sockets antigos.');
    },
  };

  installInterface();

  log('Instalado. Aguardando o WebSocket e a próxima lista pending.', {
    ballId: state.ballId,
    delay: `${MIN_CATCH_DELAY_MS}-${MAX_CATCH_DELAY_MS}ms`,
  });
})();