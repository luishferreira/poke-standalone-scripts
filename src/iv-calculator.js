// ==UserScript==
// @name         PIW IV Calculator
// @namespace    poke-manager
// @version      1.0.0
// @description  Calcula os IVs dos Pokémon atualmente equipados no Poke Idle World.
// @author       Luis
// @match        https://poke.idleworld.online/play*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/iv-calculator.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/iv-calculator.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function installPiwIvCalculator() {
  'use strict';

  if (window.piwIvCalculator?.installed) {
    console.warn('[PIW IV Calculator] Já está instalado nesta página.');
    return;
  }

  const bridge = window.piwScripts?.wsBridge;
  const uiMenu = window.piwScripts?.uiMenu;
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[PIW IV Calculator] PIW WS Bridge v1 indisponível.');
    return;
  }
  if (!uiMenu || uiMenu.apiVersion !== 1) {
    console.warn('[PIW IV Calculator] PIW UI Menu v1 indisponível.');
    return;
  }

  const CREATURES_URL = '/game/creatures.json';
  const POKES_TIMEOUT_MS = 3_500;
  const MAX_IV = 32;
  const TOTAL_MAX_IV = MAX_IV * 6;
  const STAT_DEFINITIONS = Object.freeze([
    { key: 'hp', label: 'HP', baseKey: 'baseHp', exponent: 0.95 },
    { key: 'atk', label: 'ATK', baseKey: 'baseAtk', exponent: 0.8 },
    { key: 'def', label: 'DEF', baseKey: 'baseDef', exponent: 0.8 },
    { key: 'spAtk', label: 'Sp. ATK', baseKey: 'baseSpAtk', exponent: 0.8 },
    { key: 'spDef', label: 'Sp. DEF', baseKey: 'baseSpDef', exponent: 0.8 },
    { key: 'speed', label: 'Speed', baseKey: 'baseSpeed', exponent: 0.95 },
  ]);

  const state = {
    installed: true,
    loading: false,
    socket: bridge.getSocket(),
    creatures: [],
    entries: [],
    selectedIndex: -1,
    lastMessage: 'Abra o painel para carregar a equipe.',
    lastError: false,
    pokesWaiter: null,
  };

  let unsubscribeBridge = null;
  let unregisterMenu = null;
  let interfaceObserver = null;
  let observerTimer = null;
  let disposePanelDrag = null;

  function normalizeName(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\bshiny\b/gi, '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '');
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function normalizeCreatures(payload) {
    const list = Array.isArray(payload) ? payload : payload?.creatures;
    if (!Array.isArray(list)) throw new Error('Catálogo de criaturas inválido.');
    return list.filter((creature) => Number.isFinite(Number(creature?.pokeId)));
  }

  function findCreature(pokemon, creatures) {
    const speciesId = finiteNumber(pokemon?.speciesId);
    if (speciesId !== null) {
      const byId = creatures.find((creature) => Number(creature.pokeId) === speciesId);
      if (byId) return byId;
    }
    const normalizedName = normalizeName(pokemon?.name);
    return creatures.find((creature) => normalizeName(creature?.name) === normalizedName) || null;
  }

  function calculateIndividualIVs(level, quality, stats, baseStats) {
    const normalizedLevel = finiteNumber(level);
    const normalizedQuality = finiteNumber(quality);
    if (!(normalizedLevel > 0) || !(normalizedQuality > 0) || !stats || !baseStats) return null;

    const ivs = {};
    for (const definition of STAT_DEFINITIONS) {
      const stat = finiteNumber(stats[definition.key]);
      const base = finiteNumber(baseStats[definition.baseKey]);
      const multiplier = (normalizedLevel / 100) * Math.pow(normalizedQuality, definition.exponent);
      if (stat === null || base === null || !(multiplier > 0)) return null;
      const rawIv = (stat / multiplier - base) / 2;
      ivs[definition.key] = Math.max(0, Math.min(MAX_IV, Math.round(rawIv)));
    }
    return ivs;
  }

  function calculatePokemon(pokemon, creaturesPayload) {
    if (!pokemon || typeof pokemon !== 'object') throw new Error('Pokémon inválido.');
    const creatures = normalizeCreatures(creaturesPayload);
    const creature = findCreature(pokemon, creatures);
    if (!creature) throw new Error(`Espécie de ${pokemon.name || 'Pokémon'} não encontrada.`);
    const ivs = calculateIndividualIVs(pokemon.level, pokemon.quality, pokemon.stats, creature);
    if (!ivs) throw new Error(`Dados de IV incompletos para ${pokemon.name || creature.name}.`);
    const total = STAT_DEFINITIONS.reduce((sum, definition) => sum + ivs[definition.key], 0);
    return {
      pokemon: {
        name: String(pokemon.name || creature.name),
        level: Math.max(1, Math.floor(Number(pokemon.level) || 1)),
        quality: Number(pokemon.quality),
        leader: Boolean(pokemon.leader),
        slot: finiteNumber(pokemon.slot),
      },
      species: {
        pokeId: Number(creature.pokeId),
        name: String(creature.name || pokemon.name || ''),
      },
      ivs,
      total,
      totalMax: TOTAL_MAX_IV,
      percent: total / TOTAL_MAX_IV * 100,
    };
  }

  function getTeamPokemon(list) {
    return (Array.isArray(list) ? list : [])
      .filter((pokemon) => pokemon && (pokemon.team || pokemon.leader))
      .sort((left, right) => Number(left.slot ?? 99) - Number(right.slot ?? 99));
  }

  function calculateTeam(list, creaturesPayload) {
    const team = getTeamPokemon(list);
    if (!team.length) throw new Error('Nenhum Pokémon equipado foi encontrado.');
    return team.map((pokemon) => {
      try {
        return { pokemon, result: calculatePokemon(pokemon, creaturesPayload), error: null };
      } catch (error) {
        return { pokemon, result: null, error: error?.message || String(error) };
      }
    });
  }

  async function publicJsonRequest(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  async function loadCreatures() {
    if (state.creatures.length) return state.creatures;
    state.creatures = normalizeCreatures(await publicJsonRequest(CREATURES_URL));
    return state.creatures;
  }

  function clearPokesWaiter(error = null) {
    const waiter = state.pokesWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.pokesWaiter = null;
    if (error) waiter.reject(error);
  }

  function resolvePokesWaiter(list) {
    const waiter = state.pokesWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.pokesWaiter = null;
    waiter.resolve(list);
  }

  function requestFreshPokes() {
    clearPokesWaiter(new Error('Solicitação anterior substituída.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.pokesWaiter?.timer !== timer) return;
        state.pokesWaiter = null;
        reject(new Error('O jogo não respondeu com a equipe.'));
      }, POKES_TIMEOUT_MS);
      state.pokesWaiter = { timer, resolve, reject };
      if (!bridge.sendJson({ type: 'pokes-get' })) {
        clearPokesWaiter(new Error('Não foi possível solicitar a equipe pelo WebSocket.'));
      }
    });
  }

  function setMessage(message, isError = false) {
    state.lastMessage = String(message || '');
    state.lastError = isError;
    renderPanel();
  }

  function selectPokemon(index) {
    const normalizedIndex = Math.floor(Number(index));
    if (!(normalizedIndex >= 0 && normalizedIndex < state.entries.length)) return false;
    state.selectedIndex = normalizedIndex;
    const entry = state.entries[normalizedIndex];
    state.lastMessage = entry.error || 'IVs calculados com os atributos atuais.';
    state.lastError = Boolean(entry.error);
    renderPanel();
    return !entry.error;
  }

  async function refresh() {
    if (state.loading) return false;
    state.socket = bridge.getSocket();
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      setMessage('Aguarde o WebSocket do jogo conectar.', true);
      return false;
    }

    state.loading = true;
    setMessage('Lendo a equipe e calculando IVs...');
    try {
      const [pokes, creatures] = await Promise.all([requestFreshPokes(), loadCreatures()]);
      state.entries = calculateTeam(pokes, creatures);
      const leaderIndex = state.entries.findIndex((entry) => entry.pokemon?.leader);
      state.selectedIndex = leaderIndex >= 0 ? leaderIndex : 0;
      const selected = state.entries[state.selectedIndex];
      state.lastMessage = selected.error
        ? selected.error
        : `${state.entries.length} Pokémon da equipe carregados.`;
      state.lastError = Boolean(selected.error);
      return !selected.error;
    } catch (error) {
      state.entries = [];
      state.selectedIndex = -1;
      state.lastMessage = error?.message || String(error);
      state.lastError = true;
      return false;
    } finally {
      state.loading = false;
      renderPanel();
    }
  }

  function handleIncoming(message) {
    if (message?.type !== 'pokes' || !Array.isArray(message.list)) return;
    resolvePokesWaiter(message.list);
  }

  function adoptSocket(socket) {
    if (!socket || state.socket === socket) return;
    if (state.socket && state.socket !== socket) clearPokesWaiter(new Error('WebSocket substituído.'));
    state.socket = socket;
    renderPanel();
  }

  unsubscribeBridge = bridge.subscribe({
    socket(event) {
      adoptSocket(event.socket);
    },
    open(event) {
      if (bridge.getSocket() !== event.socket) return;
      state.socket = event.socket;
      renderPanel();
    },
    close(event) {
      if (state.socket !== event.socket) return;
      state.socket = null;
      clearPokesWaiter(new Error('WebSocket desconectado.'));
      renderPanel();
    },
    incoming(event) {
      if (event.socket === state.socket) handleIncoming(event.message);
    },
  });

  function getSelectedEntry() {
    return state.entries[state.selectedIndex] || null;
  }

  function getStatus() {
    const selected = getSelectedEntry();
    return {
      installed: state.installed,
      loading: state.loading,
      socketOpen: state.socket?.readyState === WebSocket.OPEN,
      teamSize: state.entries.length,
      selectedIndex: state.selectedIndex,
      selected: selected?.result ? JSON.parse(JSON.stringify(selected.result)) : null,
      message: state.lastMessage,
      error: state.lastError,
    };
  }

  function formatQuality(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('pt-BR', { maximumFractionDigits: 3 }) : '—';
  }

  function renderSelector(select) {
    const currentValue = String(state.selectedIndex);
    select.replaceChildren();
    if (!state.entries.length) {
      const option = document.createElement('option');
      option.value = '-1';
      option.textContent = 'Nenhum Pokémon carregado';
      select.appendChild(option);
      select.disabled = true;
      return;
    }

    state.entries.forEach((entry, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      const leader = entry.pokemon?.leader ? '★ ' : '';
      option.textContent = `${leader}${entry.pokemon?.name || 'Pokémon'} · Nv ${entry.pokemon?.level || '?'}`;
      select.appendChild(option);
    });
    select.disabled = false;
    select.value = currentValue;
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-iv-calculator-panel');
    const menuButton = document.querySelector('#piw-iv-calculator-button');
    menuButton?.classList.toggle('piv-loading', state.loading);
    if (!panel) return;

    const status = panel.querySelector('[data-piv="status"]');
    status.textContent = state.lastMessage;
    status.classList.toggle('piv-error', state.lastError);
    const selector = panel.querySelector('[data-piv="pokemon"]');
    renderSelector(selector);

    const entry = getSelectedEntry();
    const result = entry?.result || null;
    panel.querySelector('[data-piv="level"]').textContent = result ? `Nv ${result.pokemon.level}` : '—';
    panel.querySelector('[data-piv="quality"]').textContent = result ? formatQuality(result.pokemon.quality) : '—';
    panel.querySelector('[data-piv="total"]').textContent = result ? `${result.total}/${result.totalMax}` : '—';
    panel.querySelector('[data-piv="percent"]').textContent = result ? `${result.percent.toFixed(1)}%` : '—';

    for (const definition of STAT_DEFINITIONS) {
      const card = panel.querySelector(`[data-piv-stat="${definition.key}"]`);
      const iv = result?.ivs?.[definition.key];
      const hasIv = Number.isFinite(iv);
      card.querySelector('b').textContent = hasIv ? String(iv) : '—';
      const fill = card.querySelector('.piv-fill');
      fill.style.width = hasIv ? `${iv / MAX_IV * 100}%` : '0%';
      fill.style.background = hasIv ? `hsl(${Math.round(iv / MAX_IV * 120)} 65% 48%)` : '#314351';
    }

    const refreshButton = panel.querySelector('.piv-refresh');
    refreshButton.disabled = state.loading;
    refreshButton.textContent = state.loading ? 'Atualizando...' : 'Atualizar equipe';
  }

  function createPanel() {
    if (!document.body || document.querySelector('#piw-iv-calculator-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'piw-iv-calculator-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>🧬 Calculadora de IVs</span><button class="piv-close" type="button">×</button></header>
      <div class="piv-body">
        <div class="piv-status" data-piv="status"></div>
        <label class="piv-selector">Pokémon da equipe
          <select data-piv="pokemon"><option>Nenhum Pokémon carregado</option></select>
        </label>
        <div class="piv-summary">
          <span><small>Nível</small><b data-piv="level">—</b></span>
          <span><small>Quality</small><b data-piv="quality">—</b></span>
          <span><small>Total</small><b data-piv="total">—</b></span>
          <span><small>Aproveitamento</small><b data-piv="percent">—</b></span>
        </div>
        <div class="piv-stats">
          ${STAT_DEFINITIONS.map((definition) => `
            <div class="piv-stat" data-piv-stat="${definition.key}">
              <span>${definition.label}</span><strong><b>—</b><small>/32</small></strong>
              <div class="piv-track"><i class="piv-fill"></i></div>
            </div>`).join('')}
        </div>
        <button class="piv-refresh" type="button">Atualizar equipe</button>
      </div>`;
    document.body.appendChild(panel);
    disposePanelDrag?.();
    disposePanelDrag = uiMenu.makePanelDraggable(panel, {
      storageKey: 'piw-iv-calculator-panel-position-v1',
    });
    panel.querySelector('.piv-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.piv-refresh').addEventListener('click', refresh);
    panel.querySelector('[data-piv="pokemon"]').addEventListener('change', (event) => {
      selectPokemon(event.target.value);
    });
    renderPanel();
  }

  function registerSidebarButton() {
    if (unregisterMenu) return;
    unregisterMenu = uiMenu.register({
      id: 'piw-iv-calculator-button',
      label: 'Calculadora de IVs',
      icon: '🧬',
      order: 35,
      onMount: renderPanel,
      onClick() {
        const panel = document.querySelector('#piw-iv-calculator-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
          renderPanel();
          if (!state.entries.length && !state.loading) refresh();
        }
      },
    });
  }

  function installStyles() {
    if (document.querySelector('#piw-iv-calculator-styles')) return;
    const style = document.createElement('style');
    style.id = 'piw-iv-calculator-styles';
    style.textContent = `
      #piw-iv-calculator-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
      #piw-iv-calculator-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#48bb78; }
      #piw-iv-calculator-button.piv-loading::after { background:#ecc94b;box-shadow:0 0 6px #ecc94b; }
      #piw-iv-calculator-panel[hidden] { display:none !important; }
      #piw-iv-calculator-panel { position:fixed;right:18px;top:110px;z-index:10020;width:min(420px,calc(100vw - 24px));display:flex;flex-direction:column;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
      #piw-iv-calculator-panel header { display:flex;align-items:center;gap:8px;padding:11px 13px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-iv-calculator-panel header span { flex:1; }
      #piw-iv-calculator-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
      #piw-iv-calculator-panel button:hover { border-color:#4aa3c7;background:#1d3748; }
      #piw-iv-calculator-panel button:disabled { cursor:not-allowed;opacity:.5; }
      #piw-iv-calculator-panel .piv-close { width:29px;height:29px;padding:0;background:#23303a;font-size:19px; }
      #piw-iv-calculator-panel .piv-body { padding:11px; }
      #piw-iv-calculator-panel .piv-status { color:#90cdf4;background:#0a1219;border-radius:6px;padding:7px 9px;margin-bottom:9px;text-align:center;font-weight:700; }
      #piw-iv-calculator-panel .piv-status.piv-error { color:#feb2b2; }
      #piw-iv-calculator-panel .piv-selector { display:grid;gap:4px;color:#718096;font-size:10px;font-weight:800;text-transform:uppercase; }
      #piw-iv-calculator-panel select { width:100%;border:1px solid #315269;border-radius:6px;background:#101f2a;color:#e2e8f0;padding:8px;font:600 13px system-ui,sans-serif;text-transform:none; }
      #piw-iv-calculator-panel .piv-summary { display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin:9px 0; }
      #piw-iv-calculator-panel .piv-summary span { display:flex;flex-direction:column;gap:2px;background:#101f2a;border:1px solid #20394b;border-radius:7px;padding:7px;min-width:0; }
      #piw-iv-calculator-panel .piv-summary small { color:#718096;font-size:9px;text-transform:uppercase; }
      #piw-iv-calculator-panel .piv-summary b { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #piw-iv-calculator-panel .piv-stats { display:grid;grid-template-columns:repeat(2,1fr);gap:6px; }
      #piw-iv-calculator-panel .piv-stat { display:grid;grid-template-columns:1fr auto;gap:5px;align-items:center;background:#111f29;border:1px solid #1f3443;border-radius:7px;padding:8px; }
      #piw-iv-calculator-panel .piv-stat>span { color:#a0aec0;font-size:11px;font-weight:800; }
      #piw-iv-calculator-panel .piv-stat strong { color:#f7fafc;font-size:17px; }
      #piw-iv-calculator-panel .piv-stat strong small { color:#718096;font-size:9px; }
      #piw-iv-calculator-panel .piv-track { grid-column:1/-1;height:5px;background:#263746;border-radius:999px;overflow:hidden; }
      #piw-iv-calculator-panel .piv-fill { display:block;width:0;height:100%;border-radius:inherit;transition:width .15s ease; }
      #piw-iv-calculator-panel .piv-refresh { width:100%;margin-top:9px;background:#176342;border-color:#299263; }
      @media (max-width:420px) {
        #piw-iv-calculator-panel .piv-summary { grid-template-columns:repeat(2,1fr); }
      }
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
    state.installed = false;
    clearPokesWaiter(new Error('Calculadora de IVs desinstalada.'));
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
    document.querySelector('#piw-iv-calculator-panel')?.remove();
    document.querySelector('#piw-iv-calculator-button')?.remove();
    document.querySelector('#piw-iv-calculator-styles')?.remove();
    delete window.piwIvCalculator;
  }

  window.piwIvCalculator = {
    installed: true,
    calculateIndividualIVs,
    calculatePokemon,
    calculateTeam,
    refresh,
    select: selectPokemon,
    status: getStatus,
    uninstall,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
