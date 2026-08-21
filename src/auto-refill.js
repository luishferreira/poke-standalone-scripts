// ==UserScript==
// @name         PIW Auto Refill
// @namespace    poke-manager
// @version      1.0.0
// @description  Reabastece potions e Pokébolas com limites configuráveis e venda opcional de loot comum.
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
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[PIW Auto Refill] PIW WS Bridge v1 indisponível. Auto Refill não instalado.');
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
  let interfaceObserver = null;
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

  function injectDockButton() {
    const dock = document.querySelector('nav.game-dock');
    if (!dock || dock.querySelector('#piw-auto-refill-button')) return;
    const button = document.createElement('button');
    button.id = 'piw-auto-refill-button';
    button.className = 'dock-btn';
    button.type = 'button';
    button.textContent = '🧰';
    button.title = 'Auto Refill';
    button.addEventListener('click', () => {
      const panel = document.querySelector('#piw-auto-refill-panel');
      if (!panel) return;
      panel.hidden = !panel.hidden;
      renderPanel();
    });
    dock.appendChild(button);
    renderPanel();
  }

  function initializeInterface() {
    if (!document.body) return;
    installStyles();
    createPanel();
    injectDockButton();
    if (interfaceObserver) return;
    interfaceObserver = new MutationObserver(() => {
      if (observerTimer) return;
      observerTimer = setTimeout(() => {
        observerTimer = null;
        createPanel();
        injectDockButton();
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
