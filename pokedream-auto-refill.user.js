// ==UserScript==
// @name         PokeDream Auto Refill
// @namespace    poke-manager
// @version      2.3.1
// @description  Protege itens, vende o loot restante e repõe balls e potions configuráveis pela fila oficial do jogo.
// @author       Luis
// @match        https://pokedream.com.br/*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/pokedream-auto-refill.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/pokedream-auto-refill.user.js
// @run-at       document-end
// @grant        none
// ==/UserScript==

// Arquivo gerado por scripts/build-userscripts.js. Não edite manualmente.
// Fonte: src/pokedream-auto-refill.js

(function installPokedreamAutoRefill() {
  'use strict';

  if (window.pokedreamAutoRefill?.installed) {
    try {
      window.pokedreamAutoRefill.uninstall?.();
    } catch {
      console.warn('[PokeDream Auto Refill] Não foi possível remover a instalação anterior.');
      return;
    }
  }

  const SETTINGS_KEY = 'pokedream-auto-refill-settings-v2';
  const SMALL_POTION_ID = 'small_potion';
  const POKE_BALL_ID = 'poke_ball';
  const MAX_QUANTITY_PER_ACTION = 1_000;
  const LOCK_CONFIRM_TIMEOUT_MS = 5_000;
  const CYCLE_DEBOUNCE_MS = 150;
  const ADAPTER_RETRY_MS = 500;
  const ADAPTER_MAX_ATTEMPTS = 120;
  const INTERFACE_DEBOUNCE_MS = 100;
  const DEFAULT_SETTINGS = Object.freeze({
    potionEnabled: true,
    potionItemId: SMALL_POTION_ID,
    potionThreshold: 10,
    potionQuantity: 1_000,
    ballEnabled: true,
    ballItemId: POKE_BALL_ID,
    ballThreshold: 20,
    ballQuantity: 1_000,
    sellAllLoot: true,
    protectStones: true,
    protectedItemIds: [],
  });
  const testDependencies = window.__POKEDREAM_AUTO_REFILL_TEST_DEPS__ || null;
  const itemCatalogCache = new WeakMap();
  const importModule = typeof testDependencies?.importModule === 'function'
    ? testDependencies.importModule
    : (url) => import(url);

  function normalizeNonNegativeInteger(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
  }

  function normalizeQuantity(value, fallback) {
    const quantity = normalizeNonNegativeInteger(value, fallback);
    return quantity >= 1 && quantity <= MAX_QUANTITY_PER_ACTION ? quantity : fallback;
  }

  function normalizeItemId(value, fallback) {
    return typeof value === 'string' && /^[a-z0-9_:-]+$/i.test(value.trim())
      ? value.trim()
      : fallback;
  }

  function normalizeSettings(input = {}) {
    const protectedItemIds = Array.isArray(input.protectedItemIds)
      ? [...new Set(input.protectedItemIds
        .filter((itemId) => typeof itemId === 'string' && /^[a-z0-9_:-]+$/i.test(itemId))
        .map((itemId) => itemId.trim())
        .filter(Boolean))]
      : [...DEFAULT_SETTINGS.protectedItemIds];
    return {
      potionEnabled: input.potionEnabled !== false,
      potionItemId: normalizeItemId(input.potionItemId, DEFAULT_SETTINGS.potionItemId),
      potionThreshold: normalizeNonNegativeInteger(input.potionThreshold, DEFAULT_SETTINGS.potionThreshold),
      potionQuantity: normalizeQuantity(input.potionQuantity, DEFAULT_SETTINGS.potionQuantity),
      ballEnabled: input.ballEnabled !== false,
      ballItemId: normalizeItemId(input.ballItemId, DEFAULT_SETTINGS.ballItemId),
      ballThreshold: normalizeNonNegativeInteger(input.ballThreshold, DEFAULT_SETTINGS.ballThreshold),
      ballQuantity: normalizeQuantity(input.ballQuantity, DEFAULT_SETTINGS.ballQuantity),
      sellAllLoot: input.sellAllLoot !== false,
      protectStones: input.protectStones !== false,
      protectedItemIds,
    };
  }

  function loadSettings() {
    try {
      return normalizeSettings(JSON.parse(sessionStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function parseGameSnapshot(gameState, selection = DEFAULT_SETTINGS) {
    const hud = gameState?.hud;
    const bag = hud?.bag;
    if (!hud || typeof hud !== 'object' || !bag || typeof bag !== 'object') return null;
    return {
      potionStock: normalizeNonNegativeInteger(bag[selection.potionItemId], 0),
      ballStock: normalizeNonNegativeInteger(bag[selection.ballItemId], 0),
      gold: normalizeNonNegativeInteger(hud.money, null),
      bag,
      bagLocks: Array.isArray(hud.bagLocks)
        ? hud.bagLocks.filter((itemId) => typeof itemId === 'string')
        : [],
    };
  }

  function hasGameStoreContract(candidate) {
    if (!candidate || typeof candidate.getState !== 'function' ||
        typeof candidate.subscribe !== 'function') return false;
    let gameState;
    try {
      gameState = candidate.getState();
    } catch {
      return false;
    }
    return Boolean(
      gameState && typeof gameState === 'object' &&
      Object.prototype.hasOwnProperty.call(gameState, 'hud') &&
      Object.prototype.hasOwnProperty.call(gameState, 'actionLog') &&
      Object.prototype.hasOwnProperty.call(gameState, 'actionSeq') &&
      typeof gameState.recordAction === 'function' &&
      typeof gameState.tradeItem === 'function' &&
      typeof gameState.sellAllLoot === 'function' &&
      typeof gameState.toggleBagLock === 'function',
    );
  }

  function selectGameStore(moduleNamespace) {
    if (!moduleNamespace || typeof moduleNamespace !== 'object') return null;
    for (const candidate of Object.values(moduleNamespace)) {
      if (hasGameStoreContract(candidate)) return candidate;
    }
    return null;
  }

  function hasItemCatalogContract(candidate) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const potion = candidate[SMALL_POTION_ID];
    const ball = candidate[POKE_BALL_ID];
    return potion?.id === SMALL_POTION_ID && potion.kind === 'potion' &&
      ball?.id === POKE_BALL_ID && ball.kind === 'ball';
  }

  function selectItemCatalog(moduleNamespace) {
    if (!moduleNamespace || typeof moduleNamespace !== 'object') return null;
    for (const candidate of Object.values(moduleNamespace)) {
      if (hasItemCatalogContract(candidate)) return candidate;
    }
    return null;
  }

  function getCatalogInfo(itemCatalog) {
    if (!itemCatalog || typeof itemCatalog !== 'object') {
      return { items: [], stoneItemIds: [], catalogKey: '' };
    }
    const cached = itemCatalogCache.get(itemCatalog);
    if (cached) return cached;
    const items = Object.values(itemCatalog)
      .filter((item) => typeof item?.id === 'string' && typeof item?.name === 'string')
      .sort((left, right) => left.name.localeCompare(right.name));
    const info = {
      items,
      stoneItemIds: items.filter((item) => item.kind === 'stone').map((item) => item.id),
      catalogKey: items.map((item) => item.id).join('|'),
    };
    itemCatalogCache.set(itemCatalog, info);
    return info;
  }

  function getBuyableCatalogItems(itemCatalog, kind) {
    return getCatalogInfo(itemCatalog).items
      .filter(
        (item) => item.kind === kind && Number.isFinite(Number(item.buy)) && Number(item.buy) > 0,
      )
      .sort((left, right) => Number(left.buy) - Number(right.buy) || left.name.localeCompare(right.name));
  }

  function resolveSelectedItemId(itemCatalog, requestedId, kind, fallbackId) {
    const options = getBuyableCatalogItems(itemCatalog, kind);
    if (options.some((item) => item.id === requestedId)) return requestedId;
    if (options.some((item) => item.id === fallbackId)) return fallbackId;
    return options[0]?.id || null;
  }

  function findMainModuleUrl() {
    const scripts = document.querySelectorAll?.('script[type="module"][src]') || [];
    for (const script of scripts) {
      try {
        const url = new URL(script.src, location.origin);
        if (url.origin === location.origin && /^\/assets\/[^/]+\.js$/.test(url.pathname)) {
          return url.href;
        }
      } catch {
        // Ignora script sem URL válida.
      }
    }
    return null;
  }

  function actionMatches(action, expected) {
    if (!action || action.type !== expected.type) return false;
    if (expected.type === 'sellAllLoot') return true;
    if (expected.type === 'toggleBagLock') return action.payload?.itemId === expected.itemId;
    return action.payload?.itemId === expected.itemId && action.payload?.qty === expected.qty;
  }

  function invokeAndCaptureAction(store, expected, invoke) {
    const beforeSeq = normalizeNonNegativeInteger(store.getState()?.actionSeq, -1);
    const result = invoke();
    const after = store.getState();
    const queued = Array.isArray(after?.actionLog)
      ? after.actionLog.find((action) => action?.seq > beforeSeq && actionMatches(action, expected))
      : null;
    if (!queued) throw new Error(`O jogo não adicionou a action ${expected.type} à fila.`);
    return {
      seq: queued.seq,
      step: queued.step,
      type: queued.type,
      result: result && typeof result === 'object' ? {
        ok: result.ok === true,
        n: normalizeNonNegativeInteger(result.n, null),
        gold: normalizeNonNegativeInteger(result.gold, null),
        reason: typeof result.reason === 'string' ? result.reason : null,
      } : null,
    };
  }

  function queueRefillActions(store, plan) {
    const queued = [];
    if (plan.sellAllLoot) {
      queued.push(invokeAndCaptureAction(
        store,
        { type: 'sellAllLoot' },
        () => store.getState().sellAllLoot(),
      ));
    }
    if (plan.needsPotion) {
      queued.push(invokeAndCaptureAction(
        store,
        { type: 'buy', itemId: plan.potionItemId, qty: plan.potionQuantity },
        () => store.getState().tradeItem('buy', plan.potionItemId, plan.potionQuantity),
      ));
    }
    if (plan.needsBall) {
      queued.push(invokeAndCaptureAction(
        store,
        { type: 'buy', itemId: plan.ballItemId, qty: plan.ballQuantity },
        () => store.getState().tradeItem('buy', plan.ballItemId, plan.ballQuantity),
      ));
    }
    for (let index = 1; index < queued.length; index += 1) {
      if (queued[index].seq !== queued[index - 1].seq + 1) {
        throw new Error('O jogo não gerou seq consecutivo para o ciclo de refill.');
      }
    }
    return queued;
  }

  function getProtectionPlan(gameState, itemCatalog, currentSettings = settings) {
    const snapshot = parseGameSnapshot(gameState, settings);
    if (!snapshot || !itemCatalog) return null;
    const desired = new Set(currentSettings.protectedItemIds);
    if (currentSettings.protectStones) {
      for (const itemId of getCatalogInfo(itemCatalog).stoneItemIds) desired.add(itemId);
    }
    const owned = [...desired].filter((itemId) => normalizeNonNegativeInteger(snapshot.bag[itemId], 0) > 0);
    const currentLocks = new Set(snapshot.bagLocks);
    return {
      desired: [...desired],
      owned,
      missing: owned.filter((itemId) => !currentLocks.has(itemId)),
      currentLocks: [...currentLocks],
    };
  }

  function queueProtectionActions(store, itemIds) {
    const queued = [];
    for (const itemId of itemIds) {
      queued.push(invokeAndCaptureAction(
        store,
        { type: 'toggleBagLock', itemId },
        () => store.getState().toggleBagLock(itemId),
      ));
    }
    return queued;
  }

  function locksConfirmed(store, itemIds) {
    const locks = new Set(parseGameSnapshot(store.getState())?.bagLocks || []);
    return itemIds.every((itemId) => locks.has(itemId));
  }

  function waitForBagLocks(store, itemIds, timeoutMs = LOCK_CONFIRM_TIMEOUT_MS) {
    if (itemIds.length === 0 || locksConfirmed(store, itemIds)) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      let unsubscribe = null;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        if (timeoutId) clearTimeout(timeoutId);
        unsubscribe?.();
        resolve(confirmed);
      };
      const timeoutId = setTimeout(() => finish(false), timeoutMs);
      unsubscribe = store.subscribe(() => {
        try {
          if (locksConfirmed(store, itemIds)) finish(true);
        } catch {
          finish(false);
        }
      });
      if (locksConfirmed(store, itemIds)) finish(true);
    });
  }

  const settings = loadSettings();
  const state = {
    installed: true,
    enabled: false,
    adapterStatus: 'loading',
    adapterError: null,
    adapterAttempts: 0,
    moduleFile: null,
    gameStore: null,
    itemCatalog: null,
    gameStoreUnsubscribe: null,
    potionStock: null,
    ballStock: null,
    gold: null,
    bagLocks: [],
    potionArmed: true,
    ballArmed: true,
    cycleRunning: false,
    cycleTimer: null,
    adapterTimer: null,
    interfaceTimer: null,
    lastMessage: 'Carregando adaptador do jogo...',
    lastError: false,
    lastResult: null,
  };
  let interfaceObserver = null;

  function saveSettings() {
    try {
      sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (error) {
      console.warn('[PokeDream Auto Refill] Não foi possível salvar as preferências da aba.', {
        message: error?.message || String(error),
      });
    }
  }

  function formatNumber(value) {
    return value == null ? '—' : Number(value).toLocaleString('pt-BR');
  }

  function setMessage(message, isError = false) {
    state.lastMessage = String(message || '');
    state.lastError = isError;
    renderPanel();
  }

  function syncGameState() {
    if (!state.installed || !state.gameStore) return;
    let gameState;
    try {
      gameState = state.gameStore.getState();
    } catch (error) {
      state.adapterStatus = 'incompatible';
      state.adapterError = error?.message || String(error);
      state.enabled = false;
      setMessage('O adaptador perdeu acesso ao estado do jogo. Auto Refill pausado.', true);
      return;
    }
    const snapshot = parseGameSnapshot(gameState, settings);
    if (!snapshot) {
      state.potionStock = null;
      state.ballStock = null;
      state.gold = null;
      if (state.enabled) setMessage('Aguardando o mundo e o inventário do jogo.');
      renderPanel();
      return;
    }
    state.potionStock = snapshot.potionStock;
    state.ballStock = snapshot.ballStock;
    state.gold = snapshot.gold;
    state.bagLocks = [...snapshot.bagLocks];
    if (state.potionStock > settings.potionThreshold) state.potionArmed = true;
    if (state.ballStock > settings.ballThreshold) state.ballArmed = true;
    scheduleRefillCheck();
    renderPanel();
  }

  function attachGameAdapter(store, itemCatalog, moduleUrl) {
    if (!state.installed || state.gameStore) return false;
    const potionItemId = resolveSelectedItemId(
      itemCatalog,
      settings.potionItemId,
      'potion',
      SMALL_POTION_ID,
    );
    const ballItemId = resolveSelectedItemId(
      itemCatalog,
      settings.ballItemId,
      'ball',
      POKE_BALL_ID,
    );
    if (!potionItemId || !ballItemId) return false;
    settings.potionItemId = potionItemId;
    settings.ballItemId = ballItemId;
    saveSettings();
    state.gameStore = store;
    state.itemCatalog = itemCatalog;
    state.adapterStatus = 'ready';
    state.adapterError = null;
    try {
      state.moduleFile = new URL(moduleUrl, location.origin).pathname.split('/').pop() || null;
    } catch {
      state.moduleFile = null;
    }
    state.gameStoreUnsubscribe = store.subscribe(syncGameState);
    syncGameState();
    setMessage('Adaptador pronto. Auto Refill pausado.');
    return true;
  }

  function scheduleAdapterDiscovery(delay = ADAPTER_RETRY_MS) {
    if (!state.installed || state.gameStore || state.adapterTimer ||
        state.adapterStatus === 'incompatible' ||
        state.adapterAttempts >= ADAPTER_MAX_ATTEMPTS) return;
    state.adapterTimer = setTimeout(() => {
      state.adapterTimer = null;
      void discoverGameAdapter();
    }, delay);
  }

  async function discoverGameAdapter() {
    if (!state.installed || state.gameStore) return;
    state.adapterAttempts += 1;
    const moduleUrl = findMainModuleUrl();
    if (!moduleUrl) {
      if (state.adapterAttempts >= ADAPTER_MAX_ATTEMPTS) {
        state.adapterStatus = 'incompatible';
        setMessage('Não foi possível localizar o módulo principal desta versão do jogo.', true);
      } else {
        scheduleAdapterDiscovery();
      }
      return;
    }
    try {
      const moduleNamespace = await importModule(moduleUrl);
      if (!state.installed) return;
      const store = selectGameStore(moduleNamespace);
      const itemCatalog = selectItemCatalog(moduleNamespace);
      if (!store || !itemCatalog) {
        state.adapterStatus = 'incompatible';
        state.adapterError = !store
          ? 'store oficial não encontrado pelo contrato esperado'
          : 'catálogo oficial de itens não encontrado pelo contrato esperado';
        setMessage('Esta versão do jogo alterou o contrato interno. Auto Refill indisponível.', true);
        return;
      }
      if (!attachGameAdapter(store, itemCatalog, moduleUrl)) {
        state.adapterStatus = 'incompatible';
        state.adapterError = 'catálogo oficial sem balls ou potions compráveis';
        setMessage('O catálogo desta versão não oferece os produtos necessários. Auto Refill indisponível.', true);
      }
    } catch (error) {
      state.adapterStatus = 'incompatible';
      state.adapterError = error?.message || String(error);
      setMessage('Falha ao carregar o adaptador desta versão do jogo.', true);
    }
  }

  function adapterReadyForPlan({ needsPotion, needsBall }) {
    if (state.adapterStatus !== 'ready' || !state.gameStore || !state.itemCatalog) return false;
    const gameState = state.gameStore.getState();
    if (!parseGameSnapshot(gameState, settings) || !Array.isArray(gameState.actionLog)) return false;
    return !(needsPotion || needsBall) || typeof gameState.tradeItem === 'function';
  }

  function categoryNeedsRefill(category) {
    if (category === 'potion') {
      return settings.potionEnabled && state.potionArmed && state.potionStock != null &&
        state.potionStock <= settings.potionThreshold;
    }
    return settings.ballEnabled && state.ballArmed && state.ballStock != null &&
      state.ballStock <= settings.ballThreshold;
  }

  function scheduleRefillCheck() {
    if (!state.installed || !state.enabled || state.cycleRunning || state.cycleTimer) return;
    state.cycleTimer = setTimeout(runRefillCycle, CYCLE_DEBOUNCE_MS);
  }

  async function runRefillCycle() {
    state.cycleTimer = null;
    if (!state.installed || !state.enabled || state.cycleRunning) return false;
    const needsPotion = categoryNeedsRefill('potion');
    const needsBall = categoryNeedsRefill('ball');
    if (!needsPotion && !needsBall) return false;
    if (!adapterReadyForPlan({ needsPotion, needsBall })) {
      setMessage('Aguardando o inventário e a fila oficial do jogo ficarem prontos.');
      return false;
    }

    if (needsPotion) state.potionArmed = false;
    if (needsBall) state.ballArmed = false;
    state.cycleRunning = true;
    state.lastResult = null;
    setMessage('Adicionando o refill à fila oficial do jogo...');
    let cycleSucceeded = false;
    try {
      const protection = settings.sellAllLoot
        ? getProtectionPlan(state.gameStore.getState(), state.itemCatalog)
        : { missing: [] };
      if (!protection) throw new Error('O jogo não forneceu o inventário necessário para proteger os itens.');
      const protectedActions = queueProtectionActions(state.gameStore, protection.missing);
      if (protection.missing.length > 0) {
        setMessage(`Aguardando confirmação de ${protection.missing.length} bloqueios oficiais...`);
        const confirmed = await waitForBagLocks(state.gameStore, protection.missing);
        if (!confirmed) {
          throw new Error('Os bloqueios não foram confirmados pelo estado oficial; a venda foi cancelada.');
        }
      }
      const refillActions = queueRefillActions(state.gameStore, {
        sellAllLoot: settings.sellAllLoot,
        needsPotion,
        needsBall,
        potionItemId: settings.potionItemId,
        ballItemId: settings.ballItemId,
        potionQuantity: settings.potionQuantity,
        ballQuantity: settings.ballQuantity,
      });
      const queued = [...protectedActions, ...refillActions];
      for (let index = 1; index < queued.length; index += 1) {
        if (queued[index].seq !== queued[index - 1].seq + 1) {
          throw new Error('O jogo não gerou seq consecutivo para proteção e refill.');
        }
      }
      state.lastResult = {
        accepted: true,
        queued: queued.map(({ seq, step, type }) => ({ seq, step, type })),
      };
      cycleSucceeded = true;
      setMessage(`${queued.length} actions adicionadas à fila oficial do jogo.`);
      return true;
    } catch (error) {
      state.lastResult = { accepted: false, error: error?.message || String(error) };
      setMessage(`Ciclo interrompido sem retry automático: ${error?.message || String(error)}`, true);
      return false;
    } finally {
      state.cycleRunning = false;
      syncGameState();
      if (!cycleSucceeded) {
        if (needsPotion) state.potionArmed = false;
        if (needsBall) state.ballArmed = false;
      }
      renderPanel();
    }
  }

  function rearm(category = 'all') {
    if (category === 'potion' || category === 'all') state.potionArmed = true;
    if (category === 'ball' || category === 'all') state.ballArmed = true;
    setMessage('Categorias rearmadas.');
    scheduleRefillCheck();
    return true;
  }

  function configure(input = {}) {
    const changesProduct =
      (input.potionItemId != null && input.potionItemId !== settings.potionItemId) ||
      (input.ballItemId != null && input.ballItemId !== settings.ballItemId);
    if (state.enabled && changesProduct) {
      setMessage('Pause o Auto Refill antes de trocar os produtos gerenciados.', true);
      return { ...settings };
    }
    const normalized = normalizeSettings({ ...settings, ...input });
    if (state.itemCatalog) {
      normalized.potionItemId = resolveSelectedItemId(
        state.itemCatalog,
        normalized.potionItemId,
        'potion',
        settings.potionItemId,
      );
      normalized.ballItemId = resolveSelectedItemId(
        state.itemCatalog,
        normalized.ballItemId,
        'ball',
        settings.ballItemId,
      );
    }
    Object.assign(settings, normalized);
    saveSettings();
    state.potionArmed = true;
    state.ballArmed = true;
    syncGameState();
    scheduleRefillCheck();
    renderPanel();
    return { ...settings };
  }

  function addProtectedItem(itemId) {
    if (typeof itemId !== 'string') return false;
    const normalized = itemId.trim();
    if (!state.itemCatalog?.[normalized]) return false;
    configure({ protectedItemIds: [...settings.protectedItemIds, normalized] });
    return true;
  }

  function removeProtectedItem(itemId) {
    if (typeof itemId !== 'string') return false;
    configure({ protectedItemIds: settings.protectedItemIds.filter((id) => id !== itemId) });
    return true;
  }

  function start({ confirmed = false } = {}) {
    if (confirmed !== true) return false;
    if (state.adapterStatus !== 'ready' || !state.gameStore) {
      setMessage('O adaptador do jogo ainda não está pronto.', true);
      return false;
    }
    state.enabled = true;
    state.potionArmed = true;
    state.ballArmed = true;
    setMessage('Auto Refill ativo. Observando o store oficial do jogo.');
    syncGameState();
    scheduleRefillCheck();
    return true;
  }

  function stop() {
    state.enabled = false;
    if (state.cycleTimer) clearTimeout(state.cycleTimer);
    state.cycleTimer = null;
    setMessage(state.adapterStatus === 'ready'
      ? 'Auto Refill pausado.'
      : 'Auto Refill pausado enquanto o adaptador carrega.');
    return true;
  }

  function createNumberField({ id, label, value, min = 0, max = null }) {
    const row = document.createElement('label');
    row.setAttribute('for', id);
    const caption = document.createElement('span');
    caption.textContent = label;
    const input = document.createElement('input');
    input.id = id;
    input.type = 'number';
    input.min = String(min);
    if (max != null) input.max = String(max);
    input.step = '1';
    input.value = String(value);
    row.append(caption, input);
    return row;
  }

  function createCheckField({ id, label, checked }) {
    const row = document.createElement('label');
    row.className = 'pdr-check';
    const input = document.createElement('input');
    input.id = id;
    input.type = 'checkbox';
    input.checked = checked;
    const caption = document.createElement('span');
    caption.textContent = label;
    row.append(input, caption);
    return row;
  }

  function createSelectField({ id, label }) {
    const row = document.createElement('label');
    row.setAttribute('for', id);
    const caption = document.createElement('span');
    caption.textContent = label;
    const select = document.createElement('select');
    select.id = id;
    row.append(caption, select);
    return row;
  }

  function installStyles() {
    if (document.querySelector('#pdr-auto-refill-styles')) return;
    const style = document.createElement('style');
    style.id = 'pdr-auto-refill-styles';
    style.textContent = `
      #pdr-auto-refill-button { position:relative; }
      #pdr-auto-refill-button::after { content:'';position:absolute;right:5px;top:4px;width:7px;height:7px;border-radius:50%;background:#64748b;box-shadow:0 0 0 1px rgba(0,0,0,.5); }
      #pdr-auto-refill-button.pdr-running::after { background:#4ade80;box-shadow:0 0 7px #4ade80; }
      #pdr-auto-refill-button.pdr-busy::after { background:#f59e0b;box-shadow:0 0 7px #f59e0b; }
      #pdr-auto-refill-panel[hidden], #pdr-protection-panel[hidden] { display:none!important; }
      #pdr-auto-refill-panel { position:fixed;right:18px;top:86px;z-index:10050;width:350px;max-width:calc(100vw - 24px);max-height:82vh;overflow:auto;background:#141721;color:#f4f4f5;border:1px solid #596070;border-radius:12px;box-shadow:0 18px 55px rgba(0,0,0,.72);font:13px/1.35 system-ui,sans-serif; }
      #pdr-protection-panel { position:fixed;right:380px;top:86px;z-index:10051;width:360px;max-width:calc(100vw - 24px);max-height:82vh;overflow:auto;background:#141721;color:#f4f4f5;border:1px solid #596070;border-radius:12px;box-shadow:0 18px 55px rgba(0,0,0,.72);font:13px/1.35 system-ui,sans-serif; }
      #pdr-auto-refill-panel header { display:flex;align-items:center;gap:8px;padding:10px 12px;background:#202532;border-bottom:1px solid #3b4252;color:#facc15;font-weight:800; }
      #pdr-protection-panel header { display:flex;align-items:center;gap:8px;padding:10px 12px;background:#202532;border-bottom:1px solid #3b4252;color:#facc15;font-weight:800; }
      #pdr-auto-refill-panel header span { flex:1; }
      #pdr-protection-panel header span { flex:1; }
      #pdr-auto-refill-panel button { border:1px solid #555e70;border-radius:7px;background:#2a3140;color:#f8fafc;padding:7px 9px;font-weight:700;cursor:pointer; }
      #pdr-protection-panel button { border:1px solid #555e70;border-radius:7px;background:#2a3140;color:#f8fafc;padding:7px 9px;font-weight:700;cursor:pointer; }
      #pdr-auto-refill-panel button:disabled { cursor:not-allowed;opacity:.5; }
      #pdr-auto-refill-panel .pdr-close { width:28px;height:28px;padding:0;color:#fecaca;background:#51252c;border-color:#85404b;font-size:17px; }
      #pdr-protection-panel .pdr-close { width:28px;height:28px;padding:0;color:#fecaca;background:#51252c;border-color:#85404b;font-size:17px; }
      #pdr-auto-refill-panel .pdr-body { padding:11px; }
      #pdr-protection-panel .pdr-body { padding:11px; }
      #pdr-auto-refill-panel .pdr-status { margin-bottom:9px;padding:8px;border-radius:7px;background:#0c1018;color:#bfdbfe;text-align:center;font-weight:700; }
      #pdr-auto-refill-panel .pdr-status.pdr-error { color:#fecaca; }
      #pdr-auto-refill-panel .pdr-summary { display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:8px; }
      #pdr-auto-refill-panel .pdr-card { min-width:0;padding:7px 5px;border:1px solid #343c4c;border-radius:7px;background:#191e29;text-align:center; }
      #pdr-auto-refill-panel .pdr-card small { display:block;color:#9ca3af;font-size:9px;text-transform:uppercase; }
      #pdr-auto-refill-panel .pdr-card b { display:block;overflow:hidden;text-overflow:ellipsis; }
      #pdr-auto-refill-panel fieldset { margin:8px 0;padding:8px;border:1px solid #3b4252;border-radius:8px; }
      #pdr-auto-refill-panel legend { padding:0 5px;color:#fde047;font-weight:800; }
      #pdr-auto-refill-panel label { display:grid;grid-template-columns:145px 1fr;align-items:center;gap:7px;margin:6px 0; }
      #pdr-auto-refill-panel input, #pdr-auto-refill-panel select { min-width:0;background:#0c1018;border:1px solid #4b5563;border-radius:6px;color:#fff;padding:6px; }
      #pdr-auto-refill-panel .pdr-check { display:flex;gap:7px; }
      #pdr-auto-refill-panel .pdr-check input { min-width:auto; }
      #pdr-auto-refill-panel .pdr-arm { color:#aab2c0;font-size:11px; }
      #pdr-auto-refill-panel .pdr-note { margin:8px 0;color:#aab2c0;font-size:11px; }
      #pdr-auto-refill-panel .pdr-protection-open { width:100%;margin-top:7px; }
      #pdr-protection-panel input { min-width:0;background:#0c1018;border:1px solid #4b5563;border-radius:6px;color:#fff;padding:6px; }
      #pdr-protection-panel .pdr-check { display:flex;align-items:center;gap:7px;margin:6px 0 10px; }
      #pdr-protection-panel .pdr-check input { min-width:auto; }
      #pdr-protection-panel .pdr-note { margin:0 0 8px;color:#aab2c0;font-size:11px; }
      #pdr-protection-panel .pdr-protection-search { display:grid;grid-template-columns:1fr auto;gap:6px;margin-top:7px; }
      #pdr-protection-panel .pdr-protection-search input { width:100%;box-sizing:border-box; }
      #pdr-protection-panel .pdr-protected-list { display:flex;flex-wrap:wrap;gap:5px;margin-top:9px; }
      #pdr-protection-panel .pdr-protected-item { display:flex;align-items:center;gap:5px;max-width:100%;padding:4px 6px;border:1px solid #465064;border-radius:999px;background:#202735;color:#dbeafe;font-size:11px; }
      #pdr-protection-panel .pdr-protected-item span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #pdr-protection-panel .pdr-protected-item small { padding:1px 4px;border-radius:999px;background:#334155;color:#bfdbfe;font-size:9px;white-space:nowrap; }
      #pdr-protection-panel .pdr-protected-item.pdr-official { border-color:#3f7658;background:#1b3026; }
      #pdr-protection-panel .pdr-protected-item.pdr-official small { background:#22543d;color:#bbf7d0; }
      #pdr-protection-panel .pdr-protected-item button { padding:0;width:18px;height:18px;border:0;background:transparent;color:#fca5a5;line-height:1; }
      #pdr-auto-refill-panel .pdr-lock-summary { margin-top:6px;color:#aab2c0;font-size:11px; }
      #pdr-auto-refill-panel .pdr-actions { display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px; }
      #pdr-auto-refill-panel .pdr-toggle { background:#17643f;border-color:#2f9e68; }
      #pdr-auto-refill-panel .pdr-toggle.pdr-stop { background:#71332f;border-color:#a84c45; }
      @media (max-width:780px) { #pdr-auto-refill-panel, #pdr-protection-panel { right:8px;top:64px;width:calc(100vw - 16px); } #pdr-protection-panel { z-index:10052; } }
    `;
    (document.head || document.documentElement)?.appendChild(style);
  }

  function createPanel() {
    if (!document.body) return;
    const existingPanel = document.querySelector('#pdr-auto-refill-panel');
    const existingProtectionPanel = document.querySelector('#pdr-protection-panel');
    if (existingPanel && existingProtectionPanel) return;
    existingPanel?.remove();
    existingProtectionPanel?.remove();
    const panel = document.createElement('section');
    panel.id = 'pdr-auto-refill-panel';
    panel.hidden = true;
    const header = document.createElement('header');
    const title = document.createElement('span');
    title.textContent = 'Auto Refill';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pdr-close';
    close.setAttribute('aria-label', 'Fechar painel');
    close.textContent = '×';
    close.addEventListener('click', () => {
      panel.hidden = true;
      const protectionPanel = document.querySelector('#pdr-protection-panel');
      if (protectionPanel) protectionPanel.hidden = true;
    });
    header.append(title, close);

    const body = document.createElement('div');
    body.className = 'pdr-body';
    const status = document.createElement('div');
    status.className = 'pdr-status';
    status.dataset.pdr = 'status';
    const summary = document.createElement('div');
    summary.className = 'pdr-summary';
    for (const [key, label, labelKey] of [
      ['potion-stock', 'Small Potion', 'potion-label'],
      ['ball-stock', 'Poké Ball', 'ball-label'],
      ['gold', 'Gold', null],
    ]) {
      const card = document.createElement('div');
      card.className = 'pdr-card';
      const small = document.createElement('small');
      small.textContent = label;
      if (labelKey) small.dataset.pdr = labelKey;
      const value = document.createElement('b');
      value.dataset.pdr = key;
      card.append(small, value);
      summary.appendChild(card);
    }

    const potionFieldset = document.createElement('fieldset');
    const potionLegend = document.createElement('legend');
    potionLegend.textContent = 'Small Potion';
    potionLegend.dataset.pdr = 'potion-legend';
    potionFieldset.append(
      potionLegend,
      createCheckField({ id: 'pdr-potion-enabled', label: 'Ativar potion', checked: settings.potionEnabled }),
      createSelectField({ id: 'pdr-potion-item', label: 'Item para repor' }),
      createNumberField({ id: 'pdr-potion-threshold', label: 'Comprar em ≤', value: settings.potionThreshold }),
      createNumberField({ id: 'pdr-potion-quantity', label: 'Quantidade', value: settings.potionQuantity, min: 1, max: MAX_QUANTITY_PER_ACTION }),
    );
    const potionArm = document.createElement('div');
    potionArm.className = 'pdr-arm';
    potionArm.dataset.pdr = 'potion-arm';
    potionFieldset.appendChild(potionArm);

    const ballFieldset = document.createElement('fieldset');
    const ballLegend = document.createElement('legend');
    ballLegend.textContent = 'Poké Ball';
    ballLegend.dataset.pdr = 'ball-legend';
    ballFieldset.append(
      ballLegend,
      createCheckField({ id: 'pdr-ball-enabled', label: 'Ativar Poké Ball', checked: settings.ballEnabled }),
      createSelectField({ id: 'pdr-ball-item', label: 'Item para repor' }),
      createNumberField({ id: 'pdr-ball-threshold', label: 'Comprar em ≤', value: settings.ballThreshold }),
      createNumberField({ id: 'pdr-ball-quantity', label: 'Quantidade', value: settings.ballQuantity, min: 1, max: MAX_QUANTITY_PER_ACTION }),
    );
    const ballArm = document.createElement('div');
    ballArm.className = 'pdr-arm';
    ballArm.dataset.pdr = 'ball-arm';
    ballFieldset.appendChild(ballArm);

    const sellField = createCheckField({
      id: 'pdr-sell-loot',
      label: 'Vender todo loot antes das compras',
      checked: settings.sellAllLoot,
    });
    const protectionFieldset = document.createElement('fieldset');
    const protectionLegend = document.createElement('legend');
    protectionLegend.textContent = 'Proteção da mochila';
    const protectStonesField = createCheckField({
      id: 'pdr-protect-stones',
      label: 'Proteger todas as stones',
      checked: settings.protectStones,
    });
    const lockSummary = document.createElement('div');
    lockSummary.className = 'pdr-lock-summary';
    lockSummary.dataset.pdr = 'lock-summary';
    const openProtectionButton = document.createElement('button');
    openProtectionButton.type = 'button';
    openProtectionButton.className = 'pdr-protection-open';
    openProtectionButton.dataset.pdr = 'protection-open';
    openProtectionButton.textContent = 'Configurar itens protegidos';
    protectionFieldset.append(
      protectionLegend,
      lockSummary,
      openProtectionButton,
    );

    const protectionPanel = document.createElement('section');
    protectionPanel.id = 'pdr-protection-panel';
    protectionPanel.hidden = true;
    const protectionHeader = document.createElement('header');
    const protectionTitle = document.createElement('span');
    protectionTitle.textContent = 'Itens protegidos';
    const protectionClose = document.createElement('button');
    protectionClose.type = 'button';
    protectionClose.className = 'pdr-close';
    protectionClose.setAttribute('aria-label', 'Fechar itens protegidos');
    protectionClose.textContent = '×';
    protectionClose.addEventListener('click', () => { protectionPanel.hidden = true; });
    protectionHeader.append(protectionTitle, protectionClose);
    const protectionBody = document.createElement('div');
    protectionBody.className = 'pdr-body';
    const protectionNote = document.createElement('p');
    protectionNote.className = 'pdr-note';
    protectionNote.textContent = 'Locks do jogo são preservados. O × remove apenas escolhas futuras do script.';
    const protectionSearch = document.createElement('div');
    protectionSearch.className = 'pdr-protection-search';
    const protectionInput = document.createElement('input');
    protectionInput.id = 'pdr-protected-item-input';
    protectionInput.type = 'search';
    protectionInput.setAttribute('list', 'pdr-item-options');
    protectionInput.placeholder = 'Nome ou ID do item';
    protectionInput.setAttribute('aria-label', 'Item adicional a proteger');
    const itemOptions = document.createElement('datalist');
    itemOptions.id = 'pdr-item-options';
    const addProtectionButton = document.createElement('button');
    addProtectionButton.type = 'button';
    addProtectionButton.textContent = 'Adicionar';
    const protectedList = document.createElement('div');
    protectedList.className = 'pdr-protected-list';
    protectedList.dataset.pdr = 'protected-list';
    protectionSearch.append(protectionInput, addProtectionButton, itemOptions);
    protectionBody.append(protectionNote, protectStonesField, protectionSearch, protectedList);
    protectionPanel.append(protectionHeader, protectionBody);
    openProtectionButton.addEventListener('click', () => {
      protectionPanel.hidden = !protectionPanel.hidden;
      if (!protectionPanel.hidden) protectionInput.focus();
    });
    const note = document.createElement('p');
    note.className = 'pdr-note';
    note.textContent = 'O ciclo usa a mesma fila oficial da interface do jogo. Fechar este painel não pausa; o ponto verde no menu indica que está ativo.';
    const actions = document.createElement('div');
    actions.className = 'pdr-actions';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'pdr-toggle';
    toggle.addEventListener('click', () => {
      if (state.enabled) return void stop();
      const confirmed = window.confirm(
        'Ativar o Auto Refill? Quando necessário, a fila oficial poderá bloquear os itens protegidos, vender somente o loot desbloqueado e comprar até 1.000 unidades de cada produto configurado.',
      );
      if (confirmed) start({ confirmed: true });
    });
    const rearmButton = document.createElement('button');
    rearmButton.type = 'button';
    rearmButton.className = 'pdr-rearm';
    rearmButton.textContent = 'Rearmar';
    rearmButton.addEventListener('click', () => rearm('all'));
    actions.append(toggle, rearmButton);
    body.append(status, summary, potionFieldset, ballFieldset, sellField, protectionFieldset, note, actions);
    panel.append(header, body);
    document.body.append(panel, protectionPanel);

    const bind = (selector, event, handler) => {
      panel.querySelector(selector)?.addEventListener(event, handler);
    };
    bind('#pdr-potion-enabled', 'change', (event) => configure({ potionEnabled: event.target.checked }));
    bind('#pdr-potion-item', 'change', (event) => configure({ potionItemId: event.target.value }));
    bind('#pdr-potion-threshold', 'change', (event) => configure({ potionThreshold: event.target.value }));
    bind('#pdr-potion-quantity', 'change', (event) => configure({ potionQuantity: event.target.value }));
    bind('#pdr-ball-enabled', 'change', (event) => configure({ ballEnabled: event.target.checked }));
    bind('#pdr-ball-item', 'change', (event) => configure({ ballItemId: event.target.value }));
    bind('#pdr-ball-threshold', 'change', (event) => configure({ ballThreshold: event.target.value }));
    bind('#pdr-ball-quantity', 'change', (event) => configure({ ballQuantity: event.target.value }));
    bind('#pdr-sell-loot', 'change', (event) => configure({ sellAllLoot: event.target.checked }));
    protectionPanel.querySelector('#pdr-protect-stones')?.addEventListener(
      'change',
      (event) => configure({ protectStones: event.target.checked }),
    );
    const addSelectedProtection = () => {
      const value = protectionInput.value.trim();
      if (!value) return;
      const exactById = state.itemCatalog?.[value];
      const exactByName = Object.values(state.itemCatalog || {}).find(
        (item) => typeof item?.name === 'string' && item.name.toLowerCase() === value.toLowerCase(),
      );
      const itemId = exactById?.id || exactByName?.id;
      if (!itemId || !addProtectedItem(itemId)) {
        setMessage('Selecione um item existente no catálogo oficial.', true);
        return;
      }
      protectionInput.value = '';
      setMessage('Item adicionado à proteção. Bloqueios existentes não serão removidos.');
    };
    addProtectionButton.addEventListener('click', addSelectedProtection);
    protectionInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        addSelectedProtection();
      }
    });
    renderPanel();
  }

  function createToolbarButton() {
    const toolbar = document.querySelector?.('div.toolbar[role="toolbar"][aria-label="Ações"]');
    if (!toolbar || toolbar.querySelector('#pdr-auto-refill-button')) return;
    const button = document.createElement('button');
    button.id = 'pdr-auto-refill-button';
    button.type = 'button';
    button.className = 'toolbar-btn';
    button.setAttribute('aria-label', 'Auto Refill');
    button.setAttribute('aria-pressed', 'false');
    button.dataset.tip = 'Auto Refill — vende loot e repõe Small Potions e Poké Balls';
    const image = document.createElement('img');
    image.className = 'toolbar-ico-img';
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.draggable = false;
    image.decoding = 'async';
    image.src = '/items/small_potion.png';
    const label = document.createElement('span');
    label.className = 'toolbar-btn-lbl';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = 'Refill';
    button.append(image, label);
    button.addEventListener('click', () => {
      const panel = document.querySelector('#pdr-auto-refill-panel');
      if (panel) {
        panel.hidden = !panel.hidden;
        if (panel.hidden) {
          const protectionPanel = document.querySelector('#pdr-protection-panel');
          if (protectionPanel) protectionPanel.hidden = true;
        }
      }
    });
    const botButton = toolbar.querySelector('button.toolbar-btn[aria-label="Bot"]');
    if (botButton) botButton.insertAdjacentElement('afterend', button);
    else toolbar.appendChild(button);
    renderPanel();
  }

  function ensureInterface() {
    if (!document.body) return;
    installStyles();
    createPanel();
    createToolbarButton();
  }

  function scheduleInterfaceCheck() {
    if (!state.installed || state.interfaceTimer) return;
    state.interfaceTimer = setTimeout(() => {
      state.interfaceTimer = null;
      ensureInterface();
    }, INTERFACE_DEBOUNCE_MS);
  }

  function renderProtectionControls(panel) {
    const protectionPanel = document.querySelector?.('#pdr-protection-panel');
    const datalist = protectionPanel?.querySelector('#pdr-item-options');
    if (datalist && state.itemCatalog) {
      const catalogInfo = getCatalogInfo(state.itemCatalog);
      const catalogItems = catalogInfo.items;
      const catalogKey = catalogInfo.catalogKey;
      if (datalist.dataset.catalogKey !== catalogKey) {
        datalist.replaceChildren(...catalogItems.map((item) => {
          const option = document.createElement('option');
          option.value = item.id;
          option.label = `${item.name} · ${item.kind}`;
          return option;
        }));
        datalist.dataset.catalogKey = catalogKey;
      }
    }

    const list = protectionPanel?.querySelector('[data-pdr="protected-list"]');
    const selectedIds = new Set(settings.protectedItemIds);
    const officialIds = new Set(state.bagLocks);
    const visibleIds = [...new Set([...officialIds, ...selectedIds])];
    const listKey = visibleIds
      .map((itemId) => `${itemId}:${state.itemCatalog?.[itemId]?.name || ''}:` +
        `${officialIds.has(itemId)}:${selectedIds.has(itemId)}`)
      .join('|');
    if (list && list.dataset.listKey !== listKey) {
      list.replaceChildren(...visibleIds.map((itemId) => {
        const isOfficial = officialIds.has(itemId);
        const isSelected = selectedIds.has(itemId);
        const wrapper = document.createElement('span');
        wrapper.className = `pdr-protected-item${isOfficial ? ' pdr-official' : ''}`;
        const label = document.createElement('span');
        label.textContent = state.itemCatalog?.[itemId]?.name || itemId;
        label.title = itemId;
        const badge = document.createElement('small');
        badge.textContent = isOfficial
          ? (isSelected ? 'No jogo · escolhido' : 'No jogo')
          : 'Escolhido';
        wrapper.append(label, badge);
        if (isSelected) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '×';
          remove.setAttribute('aria-label', `Remover ${label.textContent} das proteções futuras`);
          remove.title = isOfficial
            ? 'Remove apenas da configuração do script; o bloqueio atual do jogo será preservado.'
            : 'Remover das proteções futuras';
          remove.addEventListener('click', () => removeProtectedItem(itemId));
          wrapper.append(remove);
        }
        return wrapper;
      }));
      list.dataset.listKey = listKey;
    }

    const protection = state.gameStore && state.itemCatalog
      ? getProtectionPlan(state.gameStore.getState(), state.itemCatalog)
      : null;
    const stoneCount = getCatalogInfo(state.itemCatalog).stoneItemIds.length;
    const summary = protection
      ? `${protection.currentLocks.length} bloqueios oficiais agora · ` +
        `${protection.missing.length} proteções pendentes na mochila` +
        (settings.protectStones ? ` · ${stoneCount} stones reconhecidas` : '')
      : 'Aguardando catálogo e mochila oficiais.';
    const summaryElement = panel.querySelector('[data-pdr="lock-summary"]');
    if (summaryElement && summaryElement.textContent !== summary) summaryElement.textContent = summary;
    const openButton = panel.querySelector('[data-pdr="protection-open"]');
    const openLabel = `Configurar itens protegidos (${visibleIds.length})`;
    if (openButton && openButton.textContent !== openLabel) openButton.textContent = openLabel;
  }

  function renderManagedProductControls(panel) {
    const renderSelect = (selector, kind, selectedId) => {
      const select = panel.querySelector(selector);
      if (!select || !state.itemCatalog) return;
      const items = getBuyableCatalogItems(state.itemCatalog, kind);
      const optionsKey = items.map((item) => `${item.id}:${item.buy}:${item.name}`).join('|');
      if (select.dataset.optionsKey !== optionsKey) {
        select.replaceChildren(...items.map((item) => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = `${item.name} · ${formatNumber(item.buy)} gold`;
          return option;
        }));
        select.dataset.optionsKey = optionsKey;
      }
      if (select.value !== selectedId) select.value = selectedId;
      select.disabled = state.enabled || state.cycleRunning;
    };
    renderSelect('#pdr-potion-item', 'potion', settings.potionItemId);
    renderSelect('#pdr-ball-item', 'ball', settings.ballItemId);

    const potionName = state.itemCatalog?.[settings.potionItemId]?.name || settings.potionItemId;
    const ballName = state.itemCatalog?.[settings.ballItemId]?.name || settings.ballItemId;
    for (const [key, value] of [
      ['potion-label', potionName],
      ['potion-legend', potionName],
      ['ball-label', ballName],
      ['ball-legend', ballName],
    ]) {
      const element = panel.querySelector(`[data-pdr="${key}"]`);
      if (element && element.textContent !== value) element.textContent = value;
    }
  }

  function renderPanel() {
    const panel = document.querySelector?.('#pdr-auto-refill-panel');
    const button = document.querySelector?.('#pdr-auto-refill-button');
    if (button) {
      button.classList.toggle('pdr-running', state.enabled);
      button.classList.toggle('pdr-busy', state.cycleRunning);
      button.setAttribute('aria-pressed', String(state.enabled));
      button.title = state.enabled ? 'Auto Refill ativo' : 'Auto Refill pausado';
    }
    if (!panel) return;
    const write = (key, value) => {
      const element = panel.querySelector(`[data-pdr="${key}"]`);
      if (element && element.textContent !== value) element.textContent = value;
    };
    write('status', state.lastMessage);
    write('potion-stock', formatNumber(state.potionStock));
    write('ball-stock', formatNumber(state.ballStock));
    write('gold', formatNumber(state.gold));
    write('potion-arm', state.potionArmed ? 'Armado' : 'Aguardando rearme');
    write('ball-arm', state.ballArmed ? 'Armado' : 'Aguardando rearme');
    panel.querySelector('.pdr-status')?.classList.toggle('pdr-error', state.lastError);
    renderManagedProductControls(panel);
    renderProtectionControls(panel);
    const toggle = panel.querySelector('.pdr-toggle');
    if (toggle) {
      toggle.textContent = state.enabled ? 'Pausar' : 'Ativar';
      toggle.classList.toggle('pdr-stop', state.enabled);
      toggle.disabled = state.cycleRunning || state.adapterStatus !== 'ready';
    }
    const rearmButton = panel.querySelector('.pdr-rearm');
    if (rearmButton) rearmButton.disabled = state.cycleRunning;
  }

  function status() {
    let contextReady = false;
    try {
      contextReady = Boolean(state.gameStore && parseGameSnapshot(state.gameStore.getState(), settings));
    } catch {
      contextReady = false;
    }
    return {
      installed: state.installed,
      enabled: state.enabled,
      adapterStatus: state.adapterStatus,
      adapterReady: state.adapterStatus === 'ready',
      adapterError: state.adapterError,
      moduleFile: state.moduleFile,
      contextReady,
      missingContext: contextReady ? [] : ['store do jogo'],
      potionStock: state.potionStock,
      ballStock: state.ballStock,
      gold: state.gold,
      bagLocks: [...state.bagLocks],
      protection: state.gameStore && state.itemCatalog
        ? getProtectionPlan(state.gameStore.getState(), state.itemCatalog)
        : null,
      potionArmed: state.potionArmed,
      ballArmed: state.ballArmed,
      cycleRunning: state.cycleRunning,
      lastMessage: state.lastMessage,
      lastResult: state.lastResult ? { ...state.lastResult } : null,
      settings: { ...settings },
    };
  }

  function uninstall() {
    if (!state.installed) return false;
    stop();
    state.installed = false;
    if (state.adapterTimer) clearTimeout(state.adapterTimer);
    if (state.interfaceTimer) clearTimeout(state.interfaceTimer);
    state.adapterTimer = null;
    state.interfaceTimer = null;
    state.gameStoreUnsubscribe?.();
    state.gameStoreUnsubscribe = null;
    state.gameStore = null;
    state.itemCatalog = null;
    interfaceObserver?.disconnect();
    interfaceObserver = null;
    document.querySelector?.('#pdr-auto-refill-panel')?.remove();
    document.querySelector?.('#pdr-protection-panel')?.remove();
    document.querySelector?.('#pdr-auto-refill-button')?.remove();
    document.querySelector?.('#pdr-auto-refill-styles')?.remove();
    delete window.pokedreamAutoRefill;
    return true;
  }

  window.pokedreamAutoRefill = {
    installed: true,
    addProtectedItem,
    configure,
    getProtectionPlan,
    parseGameSnapshot,
    queueProtectionActions,
    queueRefillActions,
    rearm,
    removeProtectedItem,
    selectItemCatalog,
    selectGameStore,
    start,
    status,
    stop,
    uninstall,
  };

  ensureInterface();
  scheduleAdapterDiscovery(0);
  if (document.documentElement && typeof MutationObserver === 'function') {
    interfaceObserver = new MutationObserver(scheduleInterfaceCheck);
    interfaceObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
