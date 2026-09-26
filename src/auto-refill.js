// ==UserScript==
// @name         PIW Auto Refill
// @namespace    poke-manager
// @version      1.3.10
// @description  Reabastece potions e Pokébolas e pode vender loot comum e Pokémon fracos automaticamente.
// @author       Luis
// @match        https://poke.idleworld.online/play*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-refill.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/auto-refill.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

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
  const POKEMON_SELL_URL = '/api/game/pokemon/sell';
  const AUTH_REFRESH_URL = '/api/auth/refresh';
  const POTION_IDS = new Set([200, 201, 202, 203, 204]);
  const PROTECTED_LOOT_IDS = new Set([19356]); // Fresh Herbs
  const MAX_PURCHASE_QUANTITY = 10_000;
  const MAX_BATCH_QUANTITY = 1_000;
  const REFILL_DEBOUNCE_MS = 100;
  const SNAPSHOT_TIMEOUT_MS = 5_000;
  const REQUEST_TIMEOUT_MS = 12_000;
  const RETRY_DELAY_MS = 60_000;
  const RECENT_INVENTORY_MS = 60_000;
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
    sellPokemon: false,
    pokemonMaxIv: 160,
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

  function normalizePokemonMaxIv(value, fallback) {
    if (value == null || value === '') return fallback;
    const maxIv = Number(value);
    return Number.isInteger(maxIv) && maxIv >= 0 && maxIv <= 192 ? maxIv : fallback;
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
      sellPokemon: input.sellPokemon === true,
      pokemonMaxIv: normalizePokemonMaxIv(input.pokemonMaxIv, DEFAULT_SETTINGS.pokemonMaxIv),
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
    inventoryUpdatedAt: 0,
    ballCounts: null,
    ballsUpdatedAt: 0,
    potionStock: null,
    ballStock: null,
    potionArmed: true,
    ballArmed: true,
    cycleRunning: false,
    cycleTimer: null,
    retryTimer: null,
    retryNotBefore: 0,
    pendingSnapshots: new Set(),
    cycleSocket: null,
    needsAttention: false,
    catalogLoading: false,
    shopLoadPromise: null,
    shopCatalog: null,
    itemsCatalogPromise: null,
    currentGold: null,
    lastMessage: settings.enabled ? 'Auto Refill ativo.' : 'Auto Refill pausado.',
    lastMessageIsError: false,
    lastResult: null,
  };
  let unsubscribeBridge = null;
  let unregisterMenu = null;
  let interfaceObserver = null;
  let disposePanelDrag = null;
  let compactPanelStyle = null;
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
    state.lastMessageIsError = isError;
    document.querySelectorAll('#piw-auto-refill-panel .par-status').forEach((element) => {
      element.textContent = state.lastMessage;
      element.classList.toggle('par-error', isError);
    });
  }

  function formatNumber(value) {
    return value == null ? '—' : Number(value).toLocaleString('pt-BR');
  }

  function canContinueCycle() {
    return state.installed && settings.enabled && bridge.isOpen() &&
      bridge.getSocket() === state.cycleSocket;
  }

  function invalidateSocketSnapshots() {
    for (const cancel of [...state.pendingSnapshots]) cancel();
    state.inventoryItems = null;
    state.inventoryUpdatedAt = 0;
    state.ballCounts = null;
    state.ballsUpdatedAt = 0;
    state.potionStock = null;
    state.ballStock = null;
    renderPanel();
  }

  function getGameTokens() {
    try {
      return JSON.parse(sessionStorage.getItem(GAME_TOKENS_KEY) || 'null');
    } catch {
      return null;
    }
  }

  async function timedFetch(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function refreshGameAccessToken() {
    const tokens = getGameTokens();
    if (!tokens?.refreshToken) return null;
    const response = await timedFetch(AUTH_REFRESH_URL, {
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
    const send = (accessToken) => timedFetch(url, {
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
    return item?.category === 'loot' && !PROTECTED_LOOT_IDS.has(Number(item?.id)) &&
      npcPrice > 0 && npcPrice <= 4_000;
  }

  async function loadItemsCatalog() {
    if (!state.itemsCatalogPromise) {
      state.itemsCatalogPromise = timedFetch(ITEMS_CATALOG_URL)
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
    let submitted = false;
    try {
      const catalog = await loadItemsCatalog();
      if (!canContinueCycle()) return { attempted: false, ok: false, soldCount: 0, reason: 'paused' };
      const items = buildTrashSale(state.inventoryItems, catalog);
      if (items.length === 0) return { attempted: false, ok: true, soldCount: 0 };
      submitted = true;
      const result = await gameApiRequest(SHOP_SELL_URL, {
        method: 'POST',
        body: JSON.stringify({ items }),
      });
      const expectedCount = items.reduce((total, item) => total + item.qty, 0);
      const ok = result?.ok === true && result?.soldKinds === items.length &&
        result?.soldCount === expectedCount;
      if (result?.gold != null && Number.isFinite(Number(result.gold))) state.currentGold = Number(result.gold);
      state.inventoryItems = null;
      state.inventoryUpdatedAt = 0;
      return {
        attempted: true,
        ok,
        soldCount: normalizeNonNegativeInteger(result?.soldCount, 0),
        goldGained: normalizeNonNegativeInteger(result?.goldGained, 0),
      };
    } catch (error) {
      console.warn('[PIW Auto Refill] Venda de lixo falhou; ciclo interrompido.', {
        message: error?.message || String(error),
      });
      return { attempted: submitted, ok: false, soldCount: 0, error: error?.message || String(error) };
    }
  }

  function buildPokemonSale(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((pokemon) => {
      const id = pokemon?.id;
      const iv = pokemon?.ivTotal == null ? NaN : Number(pokemon.ivTotal);
      const quality = pokemon?.quality == null ? NaN : Number(pokemon.quality);
      const level = pokemon?.level == null ? NaN : Number(pokemon.level);
      const locked = pokemon?.locked || pokemon?.isLocked || pokemon?.protected || pokemon?.sellLocked;
      if (typeof id !== 'string' || !id || !Number.isFinite(iv) || iv < 0 || iv > 192 ||
        !Number.isFinite(quality) || !Number.isInteger(level) || level < 1 || level > 100) return false;
      if (pokemon.team || pokemon.starter || pokemon.shiny || pokemon.market || pokemon.listed || locked) return false;
      if (!(Number(pokemon.sellValue) > 0)) return false;
      return iv <= settings.pokemonMaxIv && quality <= 1.7;
    }).map((pokemon) => pokemon.id);
  }

  function requestSnapshot(type, requestType) {
    return new Promise((resolve, reject) => {
      const socket = bridge.getSocket();
      if (!bridge.isOpen() || !socket) {
        reject(new Error('WebSocket indisponível para atualizar o estoque.'));
        return;
      }
      let settled = false;
      const finish = (value, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        unsubscribe();
        state.pendingSnapshots.delete(cancel);
        if (error) reject(error);
        else resolve(value);
      };
      const cancel = () => finish(null, new Error('Atualização de estoque cancelada.'));
      const unsubscribe = bridge.subscribe({
        incoming(event) {
          if (event.socket !== socket || event.message?.type !== type) return;
          const value = type === 'inventory' ? event.message.items
            : type === 'pokes' ? event.message.list : event.message.counts;
          if (type === 'balls' ? value && typeof value === 'object' : Array.isArray(value)) finish(value);
        },
        close(event) { if (event.socket === socket) cancel(); },
        replaced(event) { if (event.previousSocket === socket) cancel(); },
      });
      const timeout = setTimeout(() => finish(null, new Error(`Tempo esgotado ao solicitar ${type}.`)), SNAPSHOT_TIMEOUT_MS);
      state.pendingSnapshots.add(cancel);
      if (!bridge.sendJson({ type: requestType })) cancel();
    });
  }

  async function sellPokemonIfEnabled() {
    if (!settings.sellPokemon) return { attempted: false, ok: true, soldCount: 0 };
    let submitted = false;
    try {
      const list = await requestSnapshot('pokes', 'pokes-get');
      if (!canContinueCycle()) return { attempted: false, ok: false, reason: 'paused' };
      const pokeIds = buildPokemonSale(list);
      if (!pokeIds.length) return { attempted: false, ok: true, soldCount: 0 };
      submitted = true;
      const result = await gameApiRequest(POKEMON_SELL_URL, {
        method: 'POST',
        body: JSON.stringify({ pokeIds }),
      });
      const sold = Number(result?.sold);
      const ok = Number.isInteger(sold) && sold === pokeIds.length;
      if (result?.gold != null && Number.isFinite(Number(result.gold))) state.currentGold = Number(result.gold);
      return {
        attempted: true,
        ok,
        soldCount: Number.isInteger(sold) && sold >= 0 ? sold : 0,
        requested: pokeIds.length,
        goldGained: normalizeNonNegativeInteger(result?.goldGained, 0),
        reason: ok ? null : 'partial_sale',
      };
    } catch (error) {
      return { attempted: submitted, ok: false, soldCount: 0, reason: error?.message || String(error) };
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
      if (!canContinueCycle()) {
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
      if (result?.gold != null && Number.isFinite(Number(result.gold)) && Number(result.gold) >= 0) {
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
      ok: bought === quantity && !reason,
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
    if (needsPotion) state.potionArmed = false;
    if (needsBall) state.ballArmed = false;
    state.cycleRunning = true;
    state.cycleSocket = bridge.getSocket();
    state.lastResult = null;
    setMessage('Preparando reabastecimento...');
    renderPanel();

    const cycleResult = { trash: null, pokemon: null, potion: null, ball: null };
    let mutationStarted = false;
    try {
      if (needsBall && (!state.ballsUpdatedAt || Date.now() - state.ballsUpdatedAt > RECENT_INVENTORY_MS)) {
        const counts = await requestSnapshot('balls', 'balls-get');
        if (!canContinueCycle()) return false;
        updateBallStock(counts);
      }
      if (settings.sellTrash) {
        setMessage('Atualizando inventário antes da venda...');
        const items = await requestSnapshot('inventory', 'inv-get');
        if (!canContinueCycle()) return false;
        updatePotionStock(items);
      } else if ((needsPotion || needsBall) && settings.potionEnabled &&
        (!state.inventoryUpdatedAt || Date.now() - state.inventoryUpdatedAt > RECENT_INVENTORY_MS)) {
        setMessage('Atualizando estoque de potions...');
        const items = await requestSnapshot('inventory', 'inv-get');
        if (!canContinueCycle()) return false;
        updatePotionStock(items);
      }
      const potionFirst = categoryNeedsRefill('potion');
      if (potionFirst) state.potionArmed = false;
      if (!canContinueCycle()) return false;
      cycleResult.trash = await sellTrashIfEnabled();
      mutationStarted ||= cycleResult.trash.attempted;
      if (!canContinueCycle()) throw new Error('Automação pausada durante a venda de loot.');
      if (cycleResult.trash.ok) {
        cycleResult.pokemon = await sellPokemonIfEnabled();
        mutationStarted ||= cycleResult.pokemon.attempted;
        if (!canContinueCycle()) throw new Error('Automação pausada durante a venda de Pokémon.');
      }
      // Falhas de venda ficam registradas no resultado, mas não impedem o refill.
      // A loja fornece o gold atualizado antes de qualquer compra.
      const shop = await loadShop({ render: false });
      if (!canContinueCycle()) return false;

      if ((needsPotion || potionFirst) && settings.enabled && settings.potionEnabled &&
        state.potionStock != null && state.potionStock <= settings.potionThreshold) {
        mutationStarted = true;
        cycleResult.potion = await purchaseProduct({
          kind: 'item',
          id: settings.potionItemId,
          quantity: settings.potionQuantity,
          shop,
        });
        if (!cycleResult.potion.ok) {
          state.lastResult = cycleResult;
          state.needsAttention = true;
          setMessage(`Potion incompleta: ${cycleResult.potion.reason || 'resposta parcial'}`, true);
          return false;
        }
      }
      if (needsBall && state.ballStock <= settings.ballThreshold && settings.enabled && settings.ballEnabled) {
        mutationStarted = true;
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
      const trashWarning = cycleResult.trash?.ok === false;
      const pokemonWarning = cycleResult.pokemon?.ok === false;
      setMessage(
        `${summaries.join(' · ') || 'Nenhuma compra realizada.'}` +
          ` · Gold: ${formatNumber(state.currentGold)}` +
          (trashWarning ? ' · Venda de lixo falhou.' : '') +
          (pokemonWarning ? ' · Venda de Pokémon falhou.' : '') +
          (cycleResult.pokemon?.soldCount ? ` · Pokémon vendidos: ${formatNumber(cycleResult.pokemon.soldCount)}` : ''),
        incomplete || trashWarning || pokemonWarning,
      );
      state.needsAttention = incomplete || trashWarning || pokemonWarning;
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
        pokemonSold: cycleResult.pokemon?.soldCount || 0,
      });
      return true;
    } catch (error) {
      state.lastResult = { error: error?.message || String(error), ...cycleResult };
      setMessage(`Falha no reabastecimento: ${error?.message || String(error)}. Tente novamente pelo painel.`, true);
      state.needsAttention = true;
      if (!mutationStarted && state.installed && settings.enabled) {
        state.retryNotBefore = Date.now() + RETRY_DELAY_MS;
        state.retryTimer = setTimeout(() => {
          state.retryTimer = null;
          if (!state.installed || !settings.enabled) return;
          state.retryNotBefore = 0;
          if (needsPotion) state.potionArmed = true;
          if (needsBall) state.ballArmed = true;
          scheduleRefillCheck();
        }, RETRY_DELAY_MS);
        setMessage('Falha antes de qualquer operação. Nova tentativa em 1 minuto.', true);
      }
      console.warn('[PIW Auto Refill] Ciclo interrompido.', {
        message: error?.message || String(error),
      });
      return false;
    } finally {
      state.cycleRunning = false;
      state.cycleSocket = null;
      renderPanel();
      scheduleRefillCheck();
    }
  }

  function scheduleRefillCheck() {
    if (!state.installed || !settings.enabled || state.cycleRunning || state.cycleTimer ||
      Date.now() < state.retryNotBefore) return;
    if (!categoryNeedsRefill('potion') && !categoryNeedsRefill('ball')) return;
    state.cycleTimer = setTimeout(runRefillCycle, REFILL_DEBOUNCE_MS);
  }

  function updatePotionStock(items) {
    state.inventoryItems = items;
    state.inventoryUpdatedAt = Date.now();
    state.potionStock = items.reduce((total, entry) => (
      POTION_IDS.has(Number(entry?.itemId))
        ? total + normalizeNonNegativeInteger(entry?.quantity, 0)
        : total
    ), 0);
    updateCategoryArming('potion');
    scheduleRefillCheck();
    renderPanel();
  }

  function updateBallStock(counts) {
    state.ballCounts = { ...counts };
    state.ballsUpdatedAt = Date.now();
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
    } else if (existingValue) {
      const option = document.createElement('option');
      option.value = existingValue;
      option.textContent = `Produto #${existingValue} · aguardando loja`;
      select.appendChild(option);
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

    panel.querySelectorAll('.par-status').forEach((element) => {
      element.textContent = state.lastMessage;
      element.classList.toggle('par-error', state.lastMessageIsError);
    });
    const potionName = state.shopCatalog?.items.find((item) => Number(item.id) === settings.potionItemId)?.name ||
      `Potion #${settings.potionItemId}`;
    const ballName = state.shopCatalog?.balls.find((item) => Number(item.id) === settings.ballId)?.name ||
      `Ball #${settings.ballId}`;
    panel.querySelector('[data-par="potion-plan"]').textContent = settings.potionEnabled
      ? `${potionName} · ${formatNumber(settings.potionQuantity)} ao chegar a ${formatNumber(settings.potionThreshold)}`
      : 'Desligadas';
    panel.querySelector('[data-par="ball-plan"]').textContent = settings.ballEnabled
      ? `${ballName} · ${formatNumber(settings.ballQuantity)} ao chegar a ${formatNumber(settings.ballThreshold)}`
      : 'Desligadas';
    panel.querySelector('[data-par="sales"]').textContent =
      `Vendas: ${[settings.sellTrash && 'loot', settings.sellPokemon && 'Pokémon'].filter(Boolean).join(' + ') || 'desligadas'}`;
    panel.querySelector('[data-par="reserve"]').textContent = `Reserva: ${formatNumber(settings.goldReserve)} gold`;
    panel.querySelector('[data-par="potion-stock"]').textContent = formatNumber(state.potionStock);
    panel.querySelector('[data-par="ball-stock"]').textContent = formatNumber(state.ballStock);
    panel.querySelector('[data-par="gold"]').textContent = formatNumber(state.currentGold);
    const latestStock = Math.max(state.inventoryUpdatedAt, state.ballsUpdatedAt);
    panel.querySelector('[data-par="connection"]').textContent = bridge.isOpen() ? 'Conectado' : 'Desconectado';
    panel.querySelector('[data-par="connection"]').classList.toggle('par-offline', !bridge.isOpen());
    panel.querySelector('[data-par="updated"]').textContent = latestStock
      ? `Estoque atualizado às ${new Date(latestStock).toLocaleTimeString('pt-BR')}`
      : 'Aguardando estoque';
    panel.querySelector('.par-toggle').textContent = settings.enabled ? 'Pausar' : 'Ativar';
    panel.querySelector('.par-toggle').disabled = false;
    panel.querySelector('.par-retry').hidden = !state.needsAttention || !settings.enabled;
    panel.querySelector('.par-retry').disabled = state.cycleRunning;
    panel.querySelectorAll('.par-settings input, .par-settings select').forEach((control) => {
      control.disabled = settings.enabled || state.cycleRunning;
    });
  }

  function syncFormFromSettings(panel) {
    populateSelect(panel.querySelector('#par-potion-id'), [], settings.potionItemId);
    populateSelect(panel.querySelector('#par-ball-id'), [], settings.ballId);
    panel.querySelector('#par-potion-enabled').checked = settings.potionEnabled;
    panel.querySelector('#par-potion-threshold').value = String(settings.potionThreshold);
    panel.querySelector('#par-potion-quantity').value = String(settings.potionQuantity);
    panel.querySelector('#par-ball-enabled').checked = settings.ballEnabled;
    panel.querySelector('#par-ball-threshold').value = String(settings.ballThreshold);
    panel.querySelector('#par-ball-quantity').value = String(settings.ballQuantity);
    panel.querySelector('#par-sell-trash').checked = settings.sellTrash;
    panel.querySelector('#par-sell-pokemon').checked = settings.sellPokemon;
    panel.querySelector('#par-pokemon-max-iv').value = String(settings.pokemonMaxIv);
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
      sellPokemon: panel.querySelector('#par-sell-pokemon').checked,
      pokemonMaxIv: panel.querySelector('#par-pokemon-max-iv').value,
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
      #piw-auto-refill-panel { position:fixed;right:18px;top:clamp(12px,12vh,120px);z-index:10022;width:360px;height:370px;min-height:min(370px,82vh);max-width:calc(100vw - 20px);max-height:82vh;overflow:hidden;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);font:13px/1.45 system-ui,sans-serif; }
      #piw-auto-refill-panel.par-expanded { box-sizing:border-box;right:12px;top:clamp(12px,5vh,48px);width:min(560px,calc(100vw - 24px));height:min(90vh,720px);min-height:min(370px,calc(100vh - 24px));max-width:calc(100vw - 24px);max-height:calc(100vh - 24px); }
      #piw-auto-refill-panel header { display:flex;align-items:center;gap:8px;padding:10px 12px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-auto-refill-panel header span { flex:1; }
      #piw-auto-refill-panel header .par-back { padding:3px 7px;font-size:12px; }
      #piw-auto-refill-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
      #piw-auto-refill-panel button:disabled { cursor:not-allowed;opacity:.45; }
      #piw-auto-refill-panel .par-close { width:28px;height:28px;padding:0;background:#44212a;border-color:#74313d;color:#feb2b2;font-size:18px; }
      #piw-auto-refill-panel .par-body { display:flex;flex-direction:column;min-height:0;padding:12px;overflow:hidden!important; }
      #piw-auto-refill-panel .par-view { flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-width:thin; }
      #piw-auto-refill-panel .par-view[hidden],#piw-auto-refill-panel .par-back[hidden] { display:none!important; }
      #piw-auto-refill-panel .par-open-settings { display:block;width:100%;margin-top:12px;text-align:left;background:transparent;border:0;border-top:1px solid #273f52;border-radius:0;padding:10px 0 2px;color:#90cdf4; }
      #piw-auto-refill-panel .par-status { padding:9px 10px;margin-bottom:12px;border-radius:6px;background:#0a1219;color:#90cdf4;text-align:center;font-weight:700; }
      #piw-auto-refill-panel .par-status.par-error { color:#feb2b2; }
      #piw-auto-refill-panel .par-plan { display:grid;gap:8px;margin-bottom:11px; }
      #piw-auto-refill-panel .par-plan-row { display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;align-items:start; }
      #piw-auto-refill-panel .par-plan-row b { color:#90cdf4; }
      #piw-auto-refill-panel .par-plan-row span { min-width:0;overflow-wrap:anywhere; }
      #piw-auto-refill-panel .par-meta { display:flex;flex-wrap:wrap;gap:4px 12px;margin-bottom:11px; }
      #piw-auto-refill-panel .par-stocks { display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-bottom:8px; }
      #piw-auto-refill-panel .par-stock { min-width:0;padding:7px 8px;border:1px solid #20394b;border-radius:7px;background:#101f2a; }
      #piw-auto-refill-panel .par-stock small { display:block;color:#94a3b8;font-size:10px; }
      #piw-auto-refill-panel .par-stock strong { display:block;overflow-wrap:anywhere;font-size:14px; }
      #piw-auto-refill-panel .par-footnote { display:flex;flex-wrap:wrap;gap:4px 10px;justify-content:space-between; }
      #piw-auto-refill-panel .par-offline { color:#feb2b2; }
      #piw-auto-refill-panel .par-muted { color:#94a3b8;font-size:11px; }
      #piw-auto-refill-panel .par-settings { padding-right:3px; }
      #piw-auto-refill-panel .par-settings-inner { max-width:980px;margin:0 auto; }
      #piw-auto-refill-panel .par-settings-grid { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start; }
      #piw-auto-refill-panel .par-economy { grid-column:1 / -1; }
      @media (max-width:600px) { #piw-auto-refill-panel .par-settings-grid { grid-template-columns:1fr; } #piw-auto-refill-panel .par-economy { grid-column:auto; } }
      #piw-auto-refill-panel .par-retry[hidden] { display:none; }
      #piw-auto-refill-panel fieldset { margin:7px 0;padding:8px;border:1px solid #273f52;border-radius:7px; }
      #piw-auto-refill-panel legend { padding:0 5px;color:#90cdf4;font-weight:800; }
      #piw-auto-refill-panel label { display:grid;grid-template-columns:110px 1fr;align-items:center;gap:6px;margin:5px 0; }
      #piw-auto-refill-panel input,#piw-auto-refill-panel select { min-width:0;background:#0a1219;border:1px solid #315269;border-radius:5px;color:#fff;padding:5px 6px; }
      #piw-auto-refill-panel .par-check { display:flex;gap:6px;grid-template-columns:none; }
      #piw-auto-refill-panel .par-check input { min-width:auto; }
      #piw-auto-refill-panel .par-arm { color:#a0aec0;font-size:11px; }
      #piw-auto-refill-panel .par-actions { display:flex;flex:0 0 auto;gap:6px;margin-top:10px; }
      #piw-auto-refill-panel .par-actions button { flex:1; }
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
      <header><button class="par-back" type="button" hidden aria-label="Voltar ao resumo">← Voltar</button><span data-par="title">🧰 Auto Refill</span><button class="par-close" type="button">×</button></header>
      <div class="par-body">
        <div class="par-view" data-par-view="summary">
        <div class="par-status" data-par="status">Auto Refill pausado.</div>
        <div class="par-plan">
          <div class="par-plan-row"><b>Potions</b><span data-par="potion-plan"></span></div>
          <div class="par-plan-row"><b>Balls</b><span data-par="ball-plan"></span></div>
        </div>
        <div class="par-meta par-muted"><span data-par="sales"></span><span data-par="reserve"></span></div>
        <div class="par-stocks">
          <div class="par-stock"><small>Potions</small><strong data-par="potion-stock"></strong></div>
          <div class="par-stock"><small>Balls</small><strong data-par="ball-stock"></strong></div>
          <div class="par-stock"><small>Gold</small><strong data-par="gold"></strong></div>
        </div>
        <div class="par-footnote par-muted"><span data-par="connection"></span><span data-par="updated"></span></div>
        <button class="par-open-settings" type="button">▸ Configurar</button>
        </div>
        <div class="par-view par-settings" data-par-view="settings" hidden>
        <div class="par-settings-inner">
        <div class="par-status" data-par="settings-status">Auto Refill pausado.</div>
        <p class="par-muted">As escolhas são salvas ao alterar. Pause para editar. A automação ativa volta após recarregar esta aba.</p>
        <div class="par-settings-grid">
        <fieldset>
          <legend>Potions</legend>
          <label class="par-check"><input id="par-potion-enabled" type="checkbox"> Comprar potions</label>
          <label>Produto <select id="par-potion-id"></select></label>
          <label>Comprar em <input id="par-potion-threshold" type="number" min="0" step="1"></label>
          <label>Comprar unidades <input id="par-potion-quantity" type="number" min="1" max="10000" step="1"></label>
        </fieldset>
        <fieldset>
          <legend>Pokébolas</legend>
          <label class="par-check"><input id="par-ball-enabled" type="checkbox"> Comprar balls</label>
          <label>Produto <select id="par-ball-id"></select></label>
          <label>Comprar em <input id="par-ball-threshold" type="number" min="0" step="1"></label>
          <label>Comprar unidades <input id="par-ball-quantity" type="number" min="1" max="10000" step="1"></label>
        </fieldset>
        <fieldset class="par-economy">
          <legend>Economia</legend>
          <label class="par-check par-danger"><input id="par-sell-trash" type="checkbox"> Vender loot NPC de 1 a 4.000 gold (exceto Fresh Herbs)</label>
          <label class="par-check par-danger"><input id="par-sell-pokemon" type="checkbox"> Vender Pokémon automaticamente</label>
          <label>Vender até IV <input id="par-pokemon-max-iv" type="number" min="0" max="192" step="1"></label>
          <p class="par-muted">Nunca vende level acima de 100 ou desconhecido, quality acima de 1,7, shiny, starter, Pokémon no time, protegido ou listado.</p>
          <label>Reserva de gold <input id="par-gold-reserve" type="number" min="0" step="1"></label>
          <p class="par-muted">Potions são compradas antes de balls. A reserva configurada vale para ambas.</p>
        </fieldset>
        </div>
        </div>
        </div>
        <div class="par-actions">
          <button class="par-retry" type="button" hidden>Tentar novamente</button>
          <button class="par-toggle" type="button">Ativar</button>
        </div>
      </div>`;
    document.body.appendChild(panel);
    disposePanelDrag?.();
    compactPanelStyle = null;
    panel.dataset.parView = 'summary';
    disposePanelDrag = uiMenu.makePanelDraggable(panel, {
      storageKey: 'piw-auto-refill-panel-position-v1',
      sizeStorageKey: 'piw-auto-refill-panel-size-v1',
    });
    syncFormFromSettings(panel);
    populateProductSelectors();

    panel.querySelector('.par-close').addEventListener('click', () => {
      panel.hidden = true;
      setPanelView(panel, 'summary');
    });
    panel.querySelector('.par-open-settings').addEventListener('click', () => {
      syncFormFromSettings(panel);
      populateProductSelectors();
      setPanelView(panel, 'settings');
    });
    panel.querySelector('.par-back').addEventListener('click', () => setPanelView(panel, 'summary'));
    panel.querySelector('.par-settings').addEventListener('change', () => {
      if (settings.enabled || state.cycleRunning) return;
      applySettings(readFormSettings(panel));
      setMessage('Configurações salvas nesta aba.');
    });
    panel.querySelectorAll('.par-settings input[type="number"]').forEach((input) => {
      for (const type of ['keydown', 'keypress', 'keyup']) {
        input.addEventListener(type, (event) => event.stopPropagation());
      }
    });
    panel.querySelector('.par-retry').addEventListener('click', () => {
      if (state.cycleRunning) return;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = null;
      state.retryNotBefore = 0;
      state.needsAttention = false;
      state.potionArmed = true;
      state.ballArmed = true;
      setMessage('Tentando novamente com estoque atualizado...');
      scheduleRefillCheck();
      renderPanel();
    });
    panel.querySelector('.par-toggle').addEventListener('click', () => {
      if (settings.enabled) window.piwAutoRefill.stop();
      else {
        window.piwAutoRefill.start();
      }
      renderPanel();
    });
    renderPanel();
  }

  function setPanelView(panel, view) {
    const showingSettings = view === 'settings';
    if (panel.dataset.parView !== view) {
      if (showingSettings) {
        compactPanelStyle = panel.getAttribute('style');
        disposePanelDrag?.();
        panel.removeAttribute('style');
        panel.classList.add('par-expanded');
      } else {
        disposePanelDrag?.();
        panel.classList.remove('par-expanded');
        if (compactPanelStyle == null) panel.removeAttribute('style');
        else panel.setAttribute('style', compactPanelStyle);
        compactPanelStyle = null;
      }
      disposePanelDrag = uiMenu.makePanelDraggable(panel, {
        storageKey: showingSettings ? 'piw-auto-refill-settings-position-v1' : 'piw-auto-refill-panel-position-v1',
        sizeStorageKey: showingSettings ? 'piw-auto-refill-settings-size-v1' : 'piw-auto-refill-panel-size-v1',
      });
      panel.dataset.parView = view;
    }
    panel.querySelector('[data-par-view="summary"]').hidden = showingSettings;
    panel.querySelector('[data-par-view="settings"]').hidden = !showingSettings;
    panel.querySelector('.par-back').hidden = !showingSettings;
    panel.querySelector('[data-par="title"]').textContent = showingSettings ? 'Configurações' : '🧰 Auto Refill';
    if (showingSettings) panel.querySelector('[data-par-view="settings"]').scrollTop = 0;
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
        if (panel.hidden) setPanelView(panel, 'summary');
        if (!panel.hidden && !state.shopCatalog && !state.catalogLoading) {
          loadShop().catch((error) => setMessage(`Loja indisponível: ${error?.message || String(error)}`, true));
        }
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
      if (state.socket && state.socket !== event.socket) invalidateSocketSnapshots();
      state.socket = event.socket;
      renderPanel();
    },
    open(event) {
      state.socket = event.socket;
      renderPanel();
    },
    close(event) {
      if (state.socket === event.socket) {
        state.socket = null;
        invalidateSocketSnapshots();
      }
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
      if (settings.enabled || state.cycleRunning) return this.status();
      applySettings({ ...settings, ...patch });
      return this.status();
    },
    start() {
      if (state.cycleRunning || !state.installed) return this.status();
      settings.enabled = true;
      state.potionArmed = true;
      state.ballArmed = true;
      state.needsAttention = false;
      state.retryNotBefore = 0;
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = null;
      saveSettings();
      setMessage('Auto Refill ativo.');
      scheduleRefillCheck();
      renderPanel();
      return this.status();
    },
    stop() {
      settings.enabled = false;
      saveSettings();
      for (const cancel of [...state.pendingSnapshots]) cancel();
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = null;
      state.retryNotBefore = 0;
      if (state.cycleTimer) clearTimeout(state.cycleTimer);
      state.cycleTimer = null;
      setMessage(state.cycleRunning
        ? 'Pausa agendada após a request atual.'
        : 'Auto Refill pausado.');
      renderPanel();
      return this.status();
    },
    rearm(category = 'all') {
      if (state.cycleRunning) return this.status();
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
      for (const cancel of [...state.pendingSnapshots]) cancel();
      if (state.retryTimer) clearTimeout(state.retryTimer);
      state.retryTimer = null;
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
