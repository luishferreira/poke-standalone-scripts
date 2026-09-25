// ==UserScript==
// @name         PIW Hunt Recommender
// @namespace    poke-manager
// @version      1.0.11
// @description  Analisa o Pokémon equipado e indica as melhores hunts acessíveis por XP/h.
// @author       Luis
// @match        https://poke.idleworld.online/play*
// @updateURL    https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/hunt-recommender.user.js
// @downloadURL  https://raw.githubusercontent.com/luishferreira/poke-standalone-scripts/master/hunt-recommender.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function installPiwHuntRecommender() {
  'use strict';

  if (window.piwHuntRecommender?.installed) {
    console.warn('[PIW Hunt Recommender] Já está instalado nesta página.');
    return;
  }

  const bridge = window.piwScripts?.wsBridge;
  const uiMenu = window.piwScripts?.uiMenu;
  if (!bridge || bridge.apiVersion !== 1) {
    console.warn('[PIW Hunt Recommender] PIW WS Bridge v1 indisponível.');
    return;
  }
  if (!uiMenu || uiMenu.apiVersion !== 1) {
    console.warn('[PIW Hunt Recommender] PIW UI Menu v1 indisponível.');
    return;
  }

  const GAME_TOKENS_KEY = 'pokeweb:tokens';
  const SETTINGS_KEY = 'piw-hunt-recommender-settings-v1';
  const CREATURES_URL = '/game/creatures.json';
  const MAP_MARKERS_URL = '/api/game/map-markers';
  const CHARACTER_URL = '/api/characters/me';
  const AUTH_REFRESH_URL = '/api/auth/refresh';
  const POKES_TIMEOUT_MS = 3_500;
  const MAP_OPEN_TIMEOUT_MS = 1_500;
  const MARKER_SEARCH_TIMEOUT_MS = 1_500;
  const HUNT_ENTRY_TIMEOUT_MS = 4_000;
  const DOM_RETRY_MS = 100;
  const AREA_CHANGE_DELAY_MS = 250;
  const PLAYER_ATTACK_INTERVAL_MS = 1_600;
  const WILD_ATTACK_INTERVAL_MS = 2_000;
  const HUNT_OVERHEAD_OVERRIDES_MS = Object.freeze({
    furious_scyther: 5_634,
  });
  const MAX_VISIBLE_HUNTS = 15;
  const SUPPORTED_AREAS = new Set(['kanto', 'outland']);
  const WILD_FALLBACK_MOVE = Object.freeze({
    name: 'Tackle',
    power: 40,
    type: 'NORMAL',
    category: 'PHYSICAL',
    learnLevel: 1,
  });
  const TYPE_OF_DAY_LABELS = Object.freeze({
    aco: 'STEEL',
    agua: 'WATER',
    dragao: 'DRAGON',
    eletrico: 'ELECTRIC',
    fada: 'FAIRY',
    fantasma: 'GHOST',
    fogo: 'FIRE',
    gelo: 'ICE',
    inseto: 'BUG',
    lutador: 'FIGHTING',
    normal: 'NORMAL',
    pedra: 'ROCK',
    planta: 'GRASS',
    grama: 'GRASS',
    psiquico: 'PSYCHIC',
    sombrio: 'DARK',
    terra: 'GROUND',
    veneno: 'POISON',
    voador: 'FLYING',
    steel: 'STEEL',
    water: 'WATER',
    dragon: 'DRAGON',
    electric: 'ELECTRIC',
    fairy: 'FAIRY',
    ghost: 'GHOST',
    fire: 'FIRE',
    ice: 'ICE',
    bug: 'BUG',
    fighting: 'FIGHTING',
    rock: 'ROCK',
    grass: 'GRASS',
    psychic: 'PSYCHIC',
    dark: 'DARK',
    ground: 'GROUND',
    poison: 'POISON',
    flying: 'FLYING',
  });

  const CLAN_TYPES = Object.freeze({
    ironhard: ['STEEL'],
    naturia: ['GRASS', 'BUG'],
    seavell: ['WATER', 'ICE'],
    malefic: ['GHOST', 'POISON', 'DARK'],
    orebound: ['GROUND', 'ROCK'],
    psycraft: ['PSYCHIC', 'FAIRY'],
    raibolt: ['ELECTRIC'],
    volcanic: ['FIRE'],
    gardestrike: ['FIGHTING', 'NORMAL'],
    wingeon: ['FLYING', 'DRAGON'],
  });

  const TYPE_CHART = Object.freeze({
    NORMAL: { ROCK: 0.5, GHOST: 0, STEEL: 0.5 },
    FIRE: { FIRE: 0.5, WATER: 0.5, GRASS: 2, ICE: 2, BUG: 2, ROCK: 0.5, DRAGON: 0.5, STEEL: 2 },
    WATER: { FIRE: 2, WATER: 0.5, GRASS: 0.5, GROUND: 2, ROCK: 2, DRAGON: 0.5 },
    ELECTRIC: { WATER: 2, ELECTRIC: 0.5, GRASS: 0.5, GROUND: 0, FLYING: 2, DRAGON: 0.5 },
    GRASS: { FIRE: 0.5, WATER: 2, GRASS: 0.5, POISON: 0.5, GROUND: 2, FLYING: 0.5, BUG: 0.5, ROCK: 2, DRAGON: 0.5, STEEL: 0.5 },
    ICE: { FIRE: 0.5, WATER: 0.5, GRASS: 2, ICE: 0.5, GROUND: 2, FLYING: 2, DRAGON: 2, STEEL: 0.5 },
    FIGHTING: { NORMAL: 2, ICE: 2, POISON: 0.5, FLYING: 0.5, PSYCHIC: 0.5, BUG: 0.5, ROCK: 2, GHOST: 0, DARK: 2, STEEL: 2 },
    POISON: { GRASS: 2, POISON: 0.5, GROUND: 0.5, ROCK: 0.5, GHOST: 0.5, STEEL: 0, FAIRY: 2 },
    GROUND: { FIRE: 2, ELECTRIC: 2, GRASS: 0.5, POISON: 2, FLYING: 0, BUG: 0.5, ROCK: 2, STEEL: 2 },
    FLYING: { ELECTRIC: 0.5, GRASS: 2, FIGHTING: 2, BUG: 2, ROCK: 0.5, STEEL: 0.5 },
    PSYCHIC: { FIGHTING: 2, POISON: 2, PSYCHIC: 0.5, DARK: 0, STEEL: 0.5 },
    BUG: { FIRE: 0.5, GRASS: 2, FIGHTING: 0.5, POISON: 0.5, FLYING: 0.5, PSYCHIC: 2, GHOST: 0.5, DARK: 2, STEEL: 0.5, FAIRY: 0.5 },
    ROCK: { FIRE: 2, ICE: 2, FIGHTING: 0.5, GROUND: 0.5, FLYING: 2, BUG: 2, STEEL: 0.5 },
    GHOST: { NORMAL: 0, PSYCHIC: 2, GHOST: 2, DARK: 0.5 },
    DRAGON: { DRAGON: 2, STEEL: 0.5, FAIRY: 0 },
    DARK: { FIGHTING: 0.5, PSYCHIC: 2, GHOST: 2, DARK: 0.5, FAIRY: 0.5 },
    STEEL: { FIRE: 0.5, WATER: 0.5, ELECTRIC: 0.5, ICE: 2, ROCK: 2, STEEL: 0.5, FAIRY: 2 },
    FAIRY: { FIRE: 0.5, FIGHTING: 2, POISON: 0.5, DRAGON: 2, DARK: 2, STEEL: 0.5 },
  });

  function loadSettings() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(SETTINGS_KEY) || '{}');
      return { onlyPokemonLevel: saved?.onlyPokemonLevel === true };
    } catch {
      return { onlyPokemonLevel: false };
    }
  }

  function saveSettings() {
    sessionStorage.setItem(SETTINGS_KEY, JSON.stringify({
      onlyPokemonLevel: state.onlyPokemonLevel,
    }));
  }

  const settings = loadSettings();

  const state = {
    installed: true,
    loading: false,
    socket: bridge.getSocket(),
    latestPokes: [],
    creatures: [],
    markers: [],
    leader: null,
    character: null,
    results: [],
    lastMessage: 'Clique em analisar para calcular as melhores hunts.',
    lastError: false,
    pokesWaiter: null,
    boostsWaiter: null,
    boostsLoaded: false,
    typeOfDay: null,
    navigating: false,
    navigationSlug: null,
    navigationGeneration: 0,
    navigationTimer: null,
    navigationResolve: null,
    huntEntryWaiter: null,
    onlyPokemonLevel: settings.onlyPokemonLevel,
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

  function normalizeType(value) {
    return String(value || '').trim().toUpperCase();
  }

  function normalizeLabel(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
  }

  function parseTypeOfDay(events, now = Date.now()) {
    if (!Array.isArray(events)) return null;
    const event = events.find((entry) => entry?.key === 'type-of-day');
    if (!event) return null;
    const until = finiteNumber(event.until);
    if (until !== null && until <= now) return null;
    const name = String(event.name || '');
    const label = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1).trim() : '';
    const xpMatch = String(event.desc || '').match(/\+(\d+(?:[.,]\d+)?)%\s+de\s+XP/i);
    const xpPercent = xpMatch ? Number(xpMatch[1].replace(',', '.')) : 0;
    return {
      type: TYPE_OF_DAY_LABELS[normalizeLabel(label)] || null,
      label: label || 'Desconhecido',
      emoji: String(event.emoji || ''),
      xpPercent: Number.isFinite(xpPercent) ? xpPercent : 0,
      until,
    };
  }

  function finiteNumber(value, fallback = null) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function formatNumber(value) {
    return Number.isFinite(Number(value))
      ? Math.round(Number(value)).toLocaleString('pt-BR')
      : '—';
  }

  function normalizeCreatures(payload) {
    const list = Array.isArray(payload) ? payload : payload?.creatures;
    if (!Array.isArray(list)) throw new Error('Catálogo de criaturas inválido.');
    return list.filter((creature) => Number.isFinite(Number(creature?.pokeId)));
  }

  function normalizeMarkers(payload) {
    const first = Array.isArray(payload)
      ? payload
      : (payload?.markers || payload?.hunts || payload?.data || []);
    const list = Array.isArray(first) ? first : (first?.markers || first?.hunts || []);
    if (!Array.isArray(list)) throw new Error('Catálogo de hunts inválido.');
    return list.filter((marker) => marker && typeof marker === 'object');
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

  async function gameApiRequest(url) {
    const send = (accessToken) => fetch(url, {
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    });
    let response = await send(getGameTokens()?.accessToken);
    if (response.status === 401) {
      const refreshedToken = await refreshGameAccessToken();
      if (refreshedToken) response = await send(refreshedToken);
    }
    const result = await response.json().catch(() => null);
    if (!response.ok) throw new Error(result?.message || `HTTP ${response.status}`);
    return result;
  }

  async function publicJsonRequest(url) {
    const response = await fetch(url, { credentials: 'same-origin' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  function getCharacter(payload) {
    const character = payload?.character || payload;
    const level = Math.floor(Number(character?.level));
    if (!character || !(level >= 1)) throw new Error('Nível do treinador indisponível.');
    return { ...character, level };
  }

  function getCreatureTypes(creature) {
    return [creature?.type1, creature?.type2].map(normalizeType).filter(Boolean);
  }

  function getClanMultiplier(character, creature) {
    const clan = String(character?.clan || '').trim().toLowerCase();
    const rank = Math.max(0, Math.min(5, Math.floor(Number(character?.clanRank) || 0)));
    const clanTypes = CLAN_TYPES[clan] || [];
    const eligible = getCreatureTypes(creature).some((type) => clanTypes.includes(type));
    return eligible ? 1 + rank * 0.06 : 1;
  }

  function gameEffectiveness(moveType, defender) {
    let canonical = 1;
    for (const type of getCreatureTypes(defender)) {
      canonical *= TYPE_CHART[normalizeType(moveType)]?.[type] ?? 1;
    }
    if (canonical === 0) return 0;
    if (canonical >= 4) return 5.5;
    if (canonical > 1) return 2.5;
    if (canonical < 1) return 0.33;
    return 1;
  }

  function getWildHp(creature, huntLevel) {
    return Math.max(120, 40 * (huntLevel / 100) * (Number(creature.baseHp) + 32));
  }

  function getWildDefense(creature, huntLevel, moveCategory, quality) {
    const base = moveCategory === 'SPECIAL' ? Number(creature.baseSpDef) : Number(creature.baseDef);
    return (huntLevel / 100) * (base + 32) * Math.pow(quality, 0.8);
  }

  function getDefenseModel(area, huntLevel) {
    if (area === 'outland') return { kind: 'curve', quality: 0.3 };
    if (huntLevel <= 30) return { kind: 'direct', quality: 6.537 };
    if (huntLevel <= 60) return { kind: 'curve', quality: 1.5 };
    return { kind: 'direct', quality: 0.574 };
  }

  function predictPlayerMoveDamage(move, leader, leaderCreature, wild, marker, clanMultiplier) {
    const special = move.category === 'SPECIAL';
    const attack = Number(special ? leader.stats.spAtk : leader.stats.atk) * clanMultiplier;
    const effectiveness = gameEffectiveness(move.type, wild);
    const stab = getCreatureTypes(leaderCreature).includes(normalizeType(move.type)) ? 1.5 : 1;
    const model = getDefenseModel(marker.area, marker.level);
    const defense = getWildDefense(wild, marker.level, move.category, model.quality);
    const numerator = Number(move.power) * attack * effectiveness * stab;
    const damage = model.kind === 'direct'
      ? numerator / defense
      : numerator / (45 * (1 + defense / 100));
    return { damage: Math.max(1, damage), effectiveness, stab };
  }

  function getWildAttackQuality(area, huntLevel) {
    if (area === 'outland') return 1.427;
    if (huntLevel <= 30) return 0.714;
    if (huntLevel <= 60) return 0.775;
    return 0.831;
  }

  function getIncomingDamageMargin(area, huntLevel) {
    if (area === 'outland') return 1.3;
    if (huntLevel <= 30) return 3.15;
    return 1.5;
  }

  function predictWildMoveDamage(move, wild, marker, leader, leaderCreature, clanMultiplier) {
    const special = move.category === 'SPECIAL';
    const baseAttack = Number(special ? wild.baseSpAtk : wild.baseAtk);
    const quality = getWildAttackQuality(marker.area, marker.level);
    const attack = (marker.level / 100) * Math.pow(quality, 0.8) * (baseAttack + 32);
    const defense = Number(special ? leader.stats.spDef : leader.stats.def) * clanMultiplier;
    const effectiveness = gameEffectiveness(move.type, leaderCreature);
    const stab = getCreatureTypes(wild).includes(normalizeType(move.type)) ? 1.5 : 1;
    return Number(move.power) * attack * effectiveness * stab / (45 * (1 + defense / 100));
  }

  function getUnlockedMoves(creature, level) {
    return (creature?.attacks || []).filter((move) => (
      !move.tm
      && Number(move.power) > 0
      && Number(move.learnLevel) <= level
      && (move.category === 'PHYSICAL' || move.category === 'SPECIAL')
    ));
  }

  function getMapOverheadMs(marker) {
    const observedOverhead = HUNT_OVERHEAD_OVERRIDES_MS[String(marker?.slug || '').trim().toLowerCase()];
    if (Number.isFinite(observedOverhead)) return observedOverhead;
    const range = marker?.range;
    if (!Array.isArray(range) || range.length < 4) {
      return marker.area === 'outland' ? 4_818 : 5_219;
    }
    const width = Math.abs(Number(range[2]) - Number(range[0])) + 1;
    const height = Math.abs(Number(range[3]) - Number(range[1])) + 1;
    if (!(width > 0 && height > 0)) return marker.area === 'outland' ? 4_818 : 5_219;
    return marker.area === 'outland'
      ? Math.max(0, 66 + 129.0765 * height)
      : Math.max(0, 2_816 + 36.7177 * width);
  }

  function findLeaderCreature(leader, creatures) {
    const byId = creatures.find((creature) => Number(creature.pokeId) === Number(leader.speciesId));
    if (byId) return byId;
    const name = normalizeName(leader.name);
    return creatures.find((creature) => normalizeName(creature.name) === name) || null;
  }

  function indexCreatures(creatures) {
    const byName = new Map();
    for (const creature of creatures) {
      const key = normalizeName(creature.name);
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(creature);
    }
    return byName;
  }

  function findWildCreature(marker, creaturesByName) {
    const names = creaturesByName.get(normalizeName(marker.name)) || [];
    if (names.length === 1) return names[0];
    if (names.length > 1) {
      return names.slice().sort((a, b) => (
        Math.abs((Number(a.huntLevel) || marker.level) - marker.level)
        - Math.abs((Number(b.huntLevel) || marker.level) - marker.level)
      ))[0];
    }
    const bySlug = creaturesByName.get(normalizeName(marker.slug)) || [];
    return bySlug[0] || null;
  }

  function calculateRecommendations({
    leader,
    profile,
    creatures: rawCreatures,
    markers: rawMarkers,
    typeOfDay = null,
    onlyPokemonLevel = false,
  }) {
    if (!leader?.stats) throw new Error('O Pokémon equipado não possui atributos completos.');
    const creatures = normalizeCreatures(rawCreatures);
    const markers = normalizeMarkers(rawMarkers);
    const character = getCharacter(profile);
    const leaderCreature = findLeaderCreature(leader, creatures);
    if (!leaderCreature) throw new Error('Espécie do Pokémon equipado não encontrada no catálogo.');
    if (normalizeName(leaderCreature.name) === 'ditto') {
      throw new Error('Ditto ficará fora da primeira versão do recomendador.');
    }

    const leaderLevel = Math.max(1, Math.floor(Number(leader.level) || 1));
    const playerMoves = getUnlockedMoves(leaderCreature, leaderLevel);
    if (!playerMoves.length) throw new Error('Nenhum ataque de dano disponível para este Pokémon.');
    const clanMultiplier = getClanMultiplier(character, leaderCreature);
    const creaturesByName = indexCreatures(creatures);
    const uniqueSlugs = new Set();
    const recommendations = [];

    for (const rawMarker of markers) {
      const marker = {
        ...rawMarker,
        slug: String(rawMarker?.slug || '').trim(),
        name: String(rawMarker?.name || '').trim(),
        area: String(rawMarker?.area || '').trim().toLowerCase(),
        level: Math.floor(Number(rawMarker?.level) || 0),
      };
      if (!marker.slug || uniqueSlugs.has(marker.slug)) continue;
      if (
        !SUPPORTED_AREAS.has(marker.area)
        || marker.level < 1
        || marker.level > character.level
        || (onlyPokemonLevel && marker.level > leaderLevel)
      ) continue;
      const wild = findWildCreature(marker, creaturesByName);
      if (!wild) continue;
      uniqueSlugs.add(marker.slug);

      const attacks = playerMoves.map((move) => ({
        move,
        ...predictPlayerMoveDamage(move, leader, leaderCreature, wild, marker, clanMultiplier),
      })).sort((a, b) => b.damage - a.damage);
      const bestAttack = attacks[0];
      if (!bestAttack || !(bestAttack.damage > 0)) continue;

      const wildHp = getWildHp(wild, marker.level);
      const hits = Math.max(1, Math.ceil(wildHp / bestAttack.damage));
      const overheadMs = getMapOverheadMs(marker);
      const cycleMs = overheadMs + Math.max(0, hits - 1) * PLAYER_ATTACK_INTERVAL_MS;
      const kosPerHour = 3_600_000 / cycleMs;
      const xpPerKill = Math.max(0, Number(wild.experience) || 0);
      const baseXpPerHour = kosPerHour * xpPerKill;
      const typeOfDayApplied = Boolean(
        typeOfDay?.type
        && Number(typeOfDay.xpPercent) > 0
        && getCreatureTypes(wild).includes(typeOfDay.type)
      );
      const xpMultiplier = typeOfDayApplied ? 1 + Number(typeOfDay.xpPercent) / 100 : 1;
      const xpPerHour = baseXpPerHour * xpMultiplier;

      const unlockedWildMoves = getUnlockedMoves(wild, marker.level);
      const wildMoves = (unlockedWildMoves.length ? unlockedWildMoves : [WILD_FALLBACK_MOVE])
        .map((move) => ({ move, damage: predictWildMoveDamage(move, wild, marker, leader, leaderCreature, clanMultiplier) }))
        .sort((a, b) => b.damage - a.damage);
      const bestWildAttack = wildMoves[0] || null;
      const incomingHits = Math.ceil(((hits - 1) * PLAYER_ATTACK_INTERVAL_MS) / WILD_ATTACK_INTERVAL_MS);
      const incomingDamage = incomingHits
        * Number(bestWildAttack?.damage || 0)
        * getIncomingDamageMargin(marker.area, marker.level);
      const playerHp = Number(leader.maxHp ?? leader.stats.hp);
      const lethal = playerHp > 0 && incomingDamage >= playerHp;

      recommendations.push({
        slug: marker.slug,
        name: marker.name || wild.name,
        area: marker.area,
        requiredLevel: marker.level,
        attack: bestAttack.move.name,
        attackType: normalizeType(bestAttack.move.type),
        effectiveness: bestAttack.effectiveness,
        damagePerHit: bestAttack.damage,
        wildHp,
        hits,
        kosPerHour,
        xpPerKill,
        baseXpPerHour,
        xpMultiplier,
        typeOfDayApplied,
        xpPerHour,
        lethal,
        incomingHits,
        incomingDamage,
        overheadMs,
      });
    }

    recommendations.sort((a, b) => (
      Number(a.lethal) - Number(b.lethal)
      || b.xpPerHour - a.xpPerHour
      || a.requiredLevel - b.requiredLevel
      || a.slug.localeCompare(b.slug)
    ));

    return {
      leader: {
        name: String(leader.name || leaderCreature.name),
        level: leaderLevel,
        speciesId: Number(leaderCreature.pokeId),
      },
      character,
      clanMultiplier,
      typeOfDay: typeOfDay ? { ...typeOfDay } : null,
      recommendations,
    };
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
        reject(new Error('O jogo não respondeu com o Pokémon equipado.'));
      }, POKES_TIMEOUT_MS);
      state.pokesWaiter = { timer, resolve, reject };
      if (!bridge.sendJson({ type: 'pokes-get' })) {
        clearPokesWaiter(new Error('Não foi possível solicitar os Pokémon pelo WebSocket.'));
      }
    });
  }

  function clearBoostsWaiter(error = null) {
    const waiter = state.boostsWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.boostsWaiter = null;
    if (error) waiter.reject(error);
  }

  function resolveBoostsWaiter(typeOfDay) {
    const waiter = state.boostsWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.boostsWaiter = null;
    waiter.resolve(typeOfDay);
  }

  function requestFreshBoosts() {
    clearBoostsWaiter(new Error('Solicitação anterior de eventos substituída.'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (state.boostsWaiter?.timer !== timer) return;
        state.boostsWaiter = null;
        reject(new Error('O jogo não respondeu com os eventos ativos.'));
      }, POKES_TIMEOUT_MS);
      state.boostsWaiter = { timer, resolve, reject };
      if (!bridge.sendJson({ type: 'boosts-refresh' })) {
        clearBoostsWaiter(new Error('Não foi possível solicitar os eventos pelo WebSocket.'));
      }
    });
  }

  function resolveHuntEntry(confirmed) {
    const waiter = state.huntEntryWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    state.huntEntryWaiter = null;
    waiter.resolve(Boolean(confirmed));
  }

  function cancelNavigation() {
    state.navigationGeneration += 1;
    if (state.navigationTimer) clearTimeout(state.navigationTimer);
    state.navigationTimer = null;
    state.navigationResolve?.(false);
    state.navigationResolve = null;
    resolveHuntEntry(false);
    state.navigating = false;
    state.navigationSlug = null;
  }

  function waitDuringNavigation(delayMs, generation) {
    return new Promise((resolve) => {
      state.navigationResolve = resolve;
      state.navigationTimer = setTimeout(() => {
        state.navigationTimer = null;
        state.navigationResolve = null;
        resolve(state.navigating && generation === state.navigationGeneration);
      }, delayMs);
    });
  }

  async function waitForDom(find, timeoutMs, generation) {
    const deadline = Date.now() + timeoutMs;
    while (state.navigating && generation === state.navigationGeneration) {
      const found = find();
      if (found) return found;
      if (Date.now() >= deadline) return null;
      if (!await waitDuringNavigation(DOM_RETRY_MS, generation)) return null;
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
      if (!state.navigating || generation !== state.navigationGeneration) return null;
      if (!area.matches?.('.on')) area.click();
      if (!await waitDuringNavigation(AREA_CHANGE_DELAY_MS, generation)) return null;
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

  function getNavigationConflict() {
    try {
      const pokedex = window.piwAutoPokedex?.status?.();
      if (pokedex?.running || pokedex?.transitioning) return 'Pause o Auto Pokédex antes de trocar de hunt.';
    } catch (error) {
      console.warn('[PIW Hunt Recommender] Falha ao consultar o Auto Pokédex.', error);
    }
    try {
      const boss = window.piwAutoBoss?.status?.();
      if (boss?.running || boss?.stopping || boss?.transitioning) return 'Pare o Auto Boss antes de trocar de hunt.';
    } catch (error) {
      console.warn('[PIW Hunt Recommender] Falha ao consultar o Auto Boss.', error);
    }
    return null;
  }

  async function goToHunt(slug) {
    if (state.navigating) return false;
    const target = state.results.find((result) => result.slug === slug);
    if (!target) {
      setMessage('Essa hunt não pertence à análise atual.', true);
      return false;
    }
    state.socket = bridge.getSocket();
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      setMessage('Aguarde o WebSocket do jogo conectar.', true);
      return false;
    }
    const conflict = getNavigationConflict();
    if (conflict) {
      setMessage(conflict, true);
      return false;
    }

    state.navigationGeneration += 1;
    const generation = state.navigationGeneration;
    state.navigating = true;
    state.navigationSlug = slug;
    setMessage(`Abrindo ${target.name} pelo mapa do jogo...`);
    try {
      const marker = await locateHuntMarker(slug, generation);
      if (!state.navigating || generation !== state.navigationGeneration) return false;
      if (!marker) throw new Error(`Não foi possível localizar ${target.name} no mapa.`);
      const confirmation = waitForHuntEntry(slug, generation);
      try {
        marker.click();
      } catch (error) {
        resolveHuntEntry(false);
        throw error;
      }
      const confirmed = await confirmation;
      if (!state.navigating || generation !== state.navigationGeneration) return false;
      if (!confirmed) throw new Error(`O jogo não confirmou a entrada em ${target.name}.`);
      state.lastMessage = `Entrada em ${target.name} confirmada.`;
      state.lastError = false;
      return true;
    } catch (error) {
      if (generation === state.navigationGeneration) {
        state.lastMessage = error?.message || String(error);
        state.lastError = true;
      }
      return false;
    } finally {
      if (generation === state.navigationGeneration) {
        state.navigating = false;
        state.navigationSlug = null;
        renderPanel();
      }
    }
  }

  async function loadCatalogs() {
    if (state.creatures.length && state.markers.length) return;
    const [creaturesPayload, markersPayload] = await Promise.all([
      publicJsonRequest(CREATURES_URL),
      publicJsonRequest(MAP_MARKERS_URL),
    ]);
    state.creatures = normalizeCreatures(creaturesPayload);
    state.markers = normalizeMarkers(markersPayload);
  }

  function setMessage(message, isError = false) {
    state.lastMessage = String(message || '');
    state.lastError = isError;
    renderPanel();
  }

  function applyCalculatedResults(calculated) {
    state.character = calculated.character;
    state.results = calculated.recommendations;
    state.lastMessage = state.results.length
      ? `${state.results.length} hunts ${state.onlyPokemonLevel ? 'até o nível do Pokémon ' : 'acessíveis '}analisadas.`
      : 'Nenhuma hunt compatível foi encontrada.';
    state.lastError = state.results.length === 0;
  }

  function recalculateWithCurrentData() {
    if (!state.leader || !state.character || !state.creatures.length || !state.markers.length) return false;
    const calculated = calculateRecommendations({
      leader: state.leader,
      profile: state.character,
      creatures: state.creatures,
      markers: state.markers,
      typeOfDay: state.typeOfDay,
      onlyPokemonLevel: state.onlyPokemonLevel,
    });
    applyCalculatedResults(calculated);
    return true;
  }

  async function analyze() {
    if (state.loading) return false;
    state.socket = bridge.getSocket();
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      setMessage('Aguarde o WebSocket do jogo conectar.', true);
      return false;
    }

    state.loading = true;
    setMessage('Lendo Pokémon, perfil e hunts...');
    try {
      const [pokes, typeOfDay, profile] = await Promise.all([
        requestFreshPokes(),
        requestFreshBoosts(),
        gameApiRequest(CHARACTER_URL),
        loadCatalogs(),
      ]);
      const leader = pokes.find((pokemon) => pokemon?.leader)
        || pokes.filter((pokemon) => pokemon?.team)
          .sort((a, b) => Number(a.slot ?? 99) - Number(b.slot ?? 99))[0];
      if (!leader) throw new Error('Nenhum Pokémon equipado foi encontrado.');
      const calculated = calculateRecommendations({
        leader,
        profile,
        creatures: state.creatures,
        markers: state.markers,
        typeOfDay,
        onlyPokemonLevel: state.onlyPokemonLevel,
      });
      state.leader = leader;
      applyCalculatedResults(calculated);
      return state.results.length > 0;
    } catch (error) {
      state.results = [];
      state.lastMessage = error?.message || String(error);
      state.lastError = true;
      return false;
    } finally {
      state.loading = false;
      renderPanel();
    }
  }

  function handleIncoming(message) {
    if (message?.type === 'pokes' && Array.isArray(message.list)) {
      state.latestPokes = message.list;
      resolvePokesWaiter(message.list);
      return;
    }
    if (message?.type === 'events' && Array.isArray(message.events)) {
      state.typeOfDay = parseTypeOfDay(message.events);
      state.boostsLoaded = true;
      resolveBoostsWaiter(state.typeOfDay);
      renderPanel();
    }
  }

  function handleOutgoing(message) {
    if (message?.type !== 'enter-hunt' || !message.slug) return;
    const waiter = state.huntEntryWaiter;
    if (
      waiter
      && waiter.generation === state.navigationGeneration
      && waiter.slug === String(message.slug)
    ) {
      resolveHuntEntry(true);
    }
  }

  function adoptSocket(socket) {
    if (!socket || state.socket === socket) return;
    if (state.socket && state.socket !== socket) {
      clearPokesWaiter(new Error('WebSocket substituído.'));
      clearBoostsWaiter(new Error('WebSocket substituído.'));
      cancelNavigation();
      state.boostsLoaded = false;
      state.typeOfDay = null;
    }
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
      clearBoostsWaiter(new Error('WebSocket desconectado.'));
      if (state.navigating) {
        cancelNavigation();
        state.lastMessage = 'WebSocket desconectado durante a troca de hunt.';
        state.lastError = true;
      }
      state.boostsLoaded = false;
      state.typeOfDay = null;
      renderPanel();
    },
    incoming(event) {
      if (event.socket === state.socket) handleIncoming(event.message);
    },
    outgoing(event) {
      if (event.socket === state.socket) handleOutgoing(event.message);
    },
  });

  function getStatus() {
    const best = state.results[0] || null;
    return {
      installed: state.installed,
      loading: state.loading,
      socketOpen: state.socket?.readyState === WebSocket.OPEN,
      leader: state.leader ? { name: state.leader.name, level: state.leader.level } : null,
      trainerLevel: state.character?.level ?? null,
      navigating: state.navigating,
      navigationSlug: state.navigationSlug,
      typeOfDay: state.typeOfDay ? { ...state.typeOfDay } : null,
      onlyPokemonLevel: state.onlyPokemonLevel,
      results: state.results.map((result) => ({ ...result })),
      best: best ? { ...best } : null,
      message: state.lastMessage,
      error: state.lastError,
    };
  }

  function renderResults(container) {
    container.replaceChildren();
    const visible = state.results.slice(0, MAX_VISIBLE_HUNTS);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'phr-empty';
      empty.textContent = 'Nenhum resultado calculado.';
      container.appendChild(empty);
      return;
    }

    for (const result of visible) {
      const row = document.createElement('div');
      row.className = `phr-row${result.lethal ? ' phr-lethal' : ''}`;

      const hunt = document.createElement('div');
      hunt.className = 'phr-hunt';
      const nameLine = document.createElement('div');
      nameLine.className = 'phr-hunt-name';
      const name = document.createElement('strong');
      name.textContent = result.name;
      nameLine.appendChild(name);
      if (result.typeOfDayApplied) {
        const typeOfDayBadge = document.createElement('span');
        typeOfDayBadge.className = 'phr-type-day';
        typeOfDayBadge.textContent = state.typeOfDay?.emoji || '✨';
        typeOfDayBadge.title = `Tipo do Dia: +${state.typeOfDay?.xpPercent || 0}% de XP`;
        nameLine.appendChild(typeOfDayBadge);
      }
      const meta = document.createElement('small');
      meta.textContent = `${result.area.toUpperCase()} · Nv ${result.requiredLevel}`;
      hunt.append(nameLine, meta);

      const attack = document.createElement('div');
      attack.className = 'phr-attack';
      const attackName = document.createElement('span');
      attackName.textContent = result.attack;
      const attackMeta = document.createElement('small');
      attackMeta.textContent = `${result.attackType} · ${result.effectiveness}×`;
      attack.append(attackName, attackMeta);

      const hits = document.createElement('b');
      hits.textContent = String(result.hits);
      hits.title = 'Golpes por Pokémon';

      const kos = document.createElement('b');
      kos.textContent = formatNumber(result.kosPerHour);
      kos.title = 'KOs por hora';

      const xp = document.createElement('b');
      xp.textContent = formatNumber(result.xpPerHour);
      xp.title = 'XP por hora';

      const danger = document.createElement('span');
      danger.className = `phr-danger ${result.lethal ? 'is-lethal' : 'is-safe'}`;
      danger.textContent = result.lethal ? 'Letal' : 'OK';

      const goButton = document.createElement('button');
      goButton.className = 'phr-go';
      goButton.type = 'button';
      goButton.textContent = state.navigating && state.navigationSlug === result.slug ? '…' : '➜';
      goButton.title = `Ir para ${result.name}`;
      goButton.setAttribute('aria-label', `Ir para ${result.name}`);
      goButton.disabled = state.navigating;
      goButton.addEventListener('click', () => { goToHunt(result.slug); });

      row.append(hunt, attack, hits, kos, xp, danger, goButton);
      container.appendChild(row);
    }
  }

  function renderPanel() {
    const panel = document.querySelector('#piw-hunt-recommender-panel');
    const menuButton = document.querySelector('#piw-hunt-recommender-button');
    menuButton?.classList.toggle('phr-loading', state.loading || state.navigating);
    if (!panel) return;

    const status = panel.querySelector('[data-phr="status"]');
    status.textContent = state.lastMessage;
    status.classList.toggle('phr-error', state.lastError);
    panel.querySelector('[data-phr="socket"]').textContent = state.socket?.readyState === WebSocket.OPEN ? 'Conectado' : 'Aguardando';
    panel.querySelector('[data-phr="pokemon"]').textContent = state.leader
      ? `${state.leader.name} · Nv ${state.leader.level}`
      : '—';
    panel.querySelector('[data-phr="trainer"]').textContent = state.character?.level ? `Nv ${state.character.level}` : '—';
    panel.querySelector('[data-phr="clan"]').textContent = state.character?.clan
      ? `${state.character.clan} R${state.character.clanRank || 0}`
      : 'Sem clã';
    const xpNote = panel.querySelector('[data-phr="xp-note"]');
    const typeOfDay = state.typeOfDay;
    if (!state.boostsLoaded) {
      xpNote.textContent = 'XP/h sem VIP e outros multiplicadores de XP da conta · Tipo do Dia ainda não consultado.';
    } else if (!typeOfDay) {
      xpNote.textContent = 'XP/h sem VIP e outros multiplicadores de XP da conta · Sem Tipo do Dia ativo.';
    } else if (typeOfDay.type && typeOfDay.xpPercent > 0) {
      xpNote.textContent = `XP/h sem VIP e outros multiplicadores de XP da conta · ${typeOfDay.emoji} Tipo do Dia: ${typeOfDay.label} (+${typeOfDay.xpPercent}% já aplicado).`;
    } else {
      xpNote.textContent = 'XP/h sem VIP e outros multiplicadores de XP da conta · Tipo do Dia não reconhecido; bônus não aplicado.';
    }

    const best = state.results[0];
    panel.querySelector('[data-phr="best-name"]').textContent = best?.name || '—';
    panel.querySelector('[data-phr="best-attack"]').textContent = best?.attack || '—';
    panel.querySelector('[data-phr="best-hits"]').textContent = best ? String(best.hits) : '—';
    panel.querySelector('[data-phr="best-kos"]').textContent = best ? formatNumber(best.kosPerHour) : '—';
    panel.querySelector('[data-phr="best-xp"]').textContent = best ? formatNumber(best.xpPerHour) : '—';
    const lethal = panel.querySelector('[data-phr="best-lethal"]');
    lethal.textContent = best ? (best.lethal ? 'Letal' : 'Não letal') : '—';
    lethal.classList.toggle('is-lethal', Boolean(best?.lethal));

    panel.querySelector('[data-phr="debug"]').textContent = best
      ? `Dano/golpe ${formatNumber(best.damagePerHit)} · HP selvagem ${formatNumber(best.wildHp)} · deslocamento ${Math.round(best.overheadMs / 100) / 10}s`
      : '—';
    const refreshButton = panel.querySelector('.phr-refresh');
    refreshButton.disabled = state.loading || state.navigating;
    refreshButton.textContent = state.loading ? 'Analisando...' : 'Analisar novamente';
    const levelFilter = panel.querySelector('[data-phr="level-filter"]');
    levelFilter.checked = state.onlyPokemonLevel;
    levelFilter.disabled = state.loading || state.navigating;
    renderResults(panel.querySelector('.phr-results'));
  }

  function createPanel() {
    if (!document.body || document.querySelector('#piw-hunt-recommender-panel')) return;
    const panel = document.createElement('section');
    panel.id = 'piw-hunt-recommender-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <header><span>🧭 Hunt Recommender</span><button class="phr-close" type="button">×</button></header>
      <div class="phr-body">
        <div class="phr-status" data-phr="status"></div>
        <div class="phr-meta">
          <div><small>WebSocket</small><b data-phr="socket">Aguardando</b></div>
          <div><small>Pokémon</small><b data-phr="pokemon">—</b></div>
          <div><small>Treinador</small><b data-phr="trainer">—</b></div>
          <div><small>Clã</small><b data-phr="clan">—</b></div>
        </div>
        <div class="phr-xp-note" data-phr="xp-note"></div>
        <section class="phr-best">
          <small>Melhor hunt</small>
          <strong data-phr="best-name">—</strong>
          <div class="phr-best-grid">
            <span>Ataque <b data-phr="best-attack">—</b></span>
            <span>Golpes <b data-phr="best-hits">—</b></span>
            <span>KOs/h <b data-phr="best-kos">—</b></span>
            <span>XP/h <b data-phr="best-xp">—</b></span>
          </div>
          <span class="phr-best-lethal" data-phr="best-lethal">—</span>
        </section>
        <label class="phr-option"><input data-phr="level-filter" type="checkbox"> Considerar somente hunts até o nível do Pokémon</label>
        <button class="phr-refresh" type="button">Analisar</button>
        <div class="phr-head"><span>Hunt</span><span>Ataque</span><span>Hits</span><span>KOs/h</span><span>XP/h</span><span></span><span></span></div>
        <div class="phr-results"></div>
        <details class="phr-debug"><summary>Debug</summary><code data-phr="debug">—</code></details>
      </div>`;
    document.body.appendChild(panel);
    disposePanelDrag?.();
    disposePanelDrag = uiMenu.makePanelDraggable(panel, {
      storageKey: 'piw-hunt-recommender-panel-position-v1',
      sizeStorageKey: 'piw-hunt-recommender-panel-size-v2',
    });
    panel.querySelector('.phr-close').addEventListener('click', () => { panel.hidden = true; });
    panel.querySelector('.phr-refresh').addEventListener('click', analyze);
    panel.querySelector('[data-phr="level-filter"]').addEventListener('change', (event) => {
      state.onlyPokemonLevel = event.currentTarget.checked;
      saveSettings();
      try {
        recalculateWithCurrentData();
      } catch (error) {
        state.lastMessage = error?.message || String(error);
        state.lastError = true;
      }
      renderPanel();
    });
    renderPanel();
  }

  function registerSidebarButton() {
    if (unregisterMenu) return;
    unregisterMenu = uiMenu.register({
      id: 'piw-hunt-recommender-button',
      label: 'Hunt Recommender',
      icon: '🧭',
      order: 30,
      onMount: renderPanel,
      onClick() {
        const panel = document.querySelector('#piw-hunt-recommender-panel');
        if (!panel) return;
        panel.hidden = !panel.hidden;
        if (!panel.hidden) {
          renderPanel();
          if (!state.results.length && !state.loading) analyze();
        }
      },
    });
  }

  function installStyles() {
    if (document.querySelector('#piw-hunt-recommender-styles')) return;
    const style = document.createElement('style');
    style.id = 'piw-hunt-recommender-styles';
    style.textContent = `
      #piw-hunt-recommender-button { background:transparent;border:0;box-shadow:none;font-size:16px;position:relative; }
      #piw-hunt-recommender-button::after { content:'';position:absolute;right:4px;top:4px;width:6px;height:6px;border-radius:50%;background:#48bb78; }
      #piw-hunt-recommender-button.phr-loading::after { background:#ecc94b;box-shadow:0 0 6px #ecc94b; }
      #piw-hunt-recommender-panel[hidden] { display:none !important; }
      #piw-hunt-recommender-panel { position:fixed;right:18px;top:110px;z-index:10020;width:min(560px,calc(100vw - 24px));height:min(600px,72vh);display:flex;flex-direction:column;background:#0c161f;color:#e2e8f0;border:1px solid #315269;border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.75);overflow:hidden;font:13px/1.35 system-ui,sans-serif; }
      #piw-hunt-recommender-panel header { display:flex;align-items:center;gap:8px;padding:11px 13px;background:#14222d;border-bottom:1px solid #273f52;font-weight:800;color:#90cdf4; }
      #piw-hunt-recommender-panel header span { flex:1; }
      #piw-hunt-recommender-panel button { border:1px solid #315269;border-radius:6px;background:#172a38;color:#d9e7f2;padding:7px 9px;font-weight:700;cursor:pointer; }
      #piw-hunt-recommender-panel button:hover { border-color:#4aa3c7;background:#1d3748; }
      #piw-hunt-recommender-panel button:disabled { cursor:not-allowed;opacity:.5; }
      #piw-hunt-recommender-panel .phr-close { width:29px;height:29px;padding:0;background:#23303a;font-size:19px; }
      #piw-hunt-recommender-panel .phr-body { padding:11px;overflow:auto;max-height:min(720px,calc(100vh - 145px)); }
      #piw-hunt-recommender-panel .phr-status { color:#90cdf4;background:#0a1219;border-radius:6px;padding:7px 9px;margin-bottom:8px;text-align:center;font-weight:700; }
      #piw-hunt-recommender-panel .phr-status.phr-error { color:#feb2b2; }
      #piw-hunt-recommender-panel .phr-meta { display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px; }
      #piw-hunt-recommender-panel .phr-meta div { display:flex;flex-direction:column;gap:2px;background:#101f2a;border:1px solid #20394b;border-radius:7px;padding:7px;min-width:0; }
      #piw-hunt-recommender-panel .phr-meta small { color:#718096;font-size:9px;text-transform:uppercase; }
      #piw-hunt-recommender-panel .phr-meta b { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #piw-hunt-recommender-panel .phr-xp-note { color:#a0aec0;background:#101f2a;border:1px solid #20394b;border-radius:7px;padding:7px 9px;margin-bottom:8px;font-size:11px; }
      #piw-hunt-recommender-panel .phr-best { display:grid;gap:5px;background:#111f29;border-left:3px solid #48bb78;border-radius:7px;padding:9px 11px;margin-bottom:8px; }
      #piw-hunt-recommender-panel .phr-best>small { color:#718096;text-transform:uppercase;font-size:9px; }
      #piw-hunt-recommender-panel .phr-best>strong { color:#bee3f8;font-size:17px; }
      #piw-hunt-recommender-panel .phr-best-grid { display:grid;grid-template-columns:repeat(4,1fr);gap:5px;color:#a0aec0;font-size:11px; }
      #piw-hunt-recommender-panel .phr-best-grid span { display:flex;flex-direction:column; }
      #piw-hunt-recommender-panel .phr-best-grid b { color:#e2e8f0;font-size:13px; }
      #piw-hunt-recommender-panel .phr-best-lethal { color:#9ae6b4;font-weight:800; }
      #piw-hunt-recommender-panel .phr-best-lethal.is-lethal { color:#fc8181; }
      #piw-hunt-recommender-panel .phr-option { display:flex;align-items:center;gap:7px;color:#cbd5e0;background:#101f2a;border:1px solid #20394b;border-radius:7px;padding:7px 9px;margin-bottom:8px;cursor:pointer; }
      #piw-hunt-recommender-panel .phr-option input { margin:0;accent-color:#299263; }
      #piw-hunt-recommender-panel .phr-option:has(input:disabled) { cursor:not-allowed;opacity:.6; }
      #piw-hunt-recommender-panel .phr-refresh { width:100%;margin-bottom:8px;background:#176342;border-color:#299263; }
      #piw-hunt-recommender-panel .phr-head,#piw-hunt-recommender-panel .phr-row { display:grid;grid-template-columns:minmax(120px,1.35fr) minmax(105px,1.2fr) 45px 58px 78px 48px 29px;gap:7px;align-items:center; }
      #piw-hunt-recommender-panel .phr-head { color:#718096;font-size:9px;text-transform:uppercase;padding:0 7px 4px; }
      #piw-hunt-recommender-panel .phr-results { display:grid;gap:4px; }
      #piw-hunt-recommender-panel .phr-row { background:#111f29;border:1px solid #1f3443;border-radius:6px;padding:7px; }
      #piw-hunt-recommender-panel .phr-row.phr-lethal { border-color:#623838;background:#241719; }
      #piw-hunt-recommender-panel .phr-hunt,#piw-hunt-recommender-panel .phr-attack { display:flex;flex-direction:column;min-width:0; }
      #piw-hunt-recommender-panel .phr-hunt-name { display:flex;align-items:center;gap:4px;min-width:0; }
      #piw-hunt-recommender-panel .phr-hunt strong,#piw-hunt-recommender-panel .phr-attack span { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
      #piw-hunt-recommender-panel .phr-type-day { flex:0 0 auto;font-size:13px;line-height:1;cursor:help; }
      #piw-hunt-recommender-panel .phr-row small { color:#718096;font-size:9px; }
      #piw-hunt-recommender-panel .phr-danger { border-radius:999px;padding:3px 5px;text-align:center;font-size:9px;font-weight:900;text-transform:uppercase; }
      #piw-hunt-recommender-panel .phr-danger.is-safe { color:#9ae6b4;background:#173426; }
      #piw-hunt-recommender-panel .phr-danger.is-lethal { color:#feb2b2;background:#4b2023; }
      #piw-hunt-recommender-panel .phr-go { width:29px;height:27px;padding:0;font-size:15px;line-height:1;background:#15364a;border-color:#2c6685; }
      #piw-hunt-recommender-panel .phr-empty { color:#718096;text-align:center;padding:14px; }
      #piw-hunt-recommender-panel .phr-debug { border-top:1px solid #20394b;margin-top:8px;padding-top:7px;color:#718096; }
      #piw-hunt-recommender-panel .phr-debug summary { cursor:pointer;text-transform:uppercase;font-size:10px;font-weight:800; }
      #piw-hunt-recommender-panel .phr-debug code { display:block;margin-top:5px;white-space:normal;color:#90cdf4; }
      @media (max-width:620px) {
        #piw-hunt-recommender-panel .phr-meta { grid-template-columns:1fr 1fr; }
        #piw-hunt-recommender-panel .phr-best-grid { grid-template-columns:1fr 1fr; }
        #piw-hunt-recommender-panel .phr-head { display:none; }
        #piw-hunt-recommender-panel .phr-row { grid-template-columns:1.4fr 1.2fr 42px 56px 29px; }
        #piw-hunt-recommender-panel .phr-row>b:nth-of-type(3),#piw-hunt-recommender-panel .phr-danger { display:none; }
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
    clearPokesWaiter(new Error('Hunt Recommender desinstalado.'));
    clearBoostsWaiter(new Error('Hunt Recommender desinstalado.'));
    cancelNavigation();
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
    document.querySelector('#piw-hunt-recommender-panel')?.remove();
    document.querySelector('#piw-hunt-recommender-button')?.remove();
    document.querySelector('#piw-hunt-recommender-styles')?.remove();
    delete window.piwHuntRecommender;
  }

  window.piwHuntRecommender = {
    installed: true,
    analyze,
    calculate: calculateRecommendations,
    goToHunt,
    status: getStatus,
    uninstall,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initialize, { once: true });
  } else {
    initialize();
  }
})();
