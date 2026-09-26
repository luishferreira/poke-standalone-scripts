'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'pokedream-auto-refill.user.js'),
  'utf8',
);

function createFakeStore({
  potion = 10,
  ball = 20,
  gold = 50_000,
  startSeq = 40,
  queueSell = true,
  throwAfterSell = false,
  queueBuy = true,
  applyPurchases = true,
  bag = {},
  emptyBag = false,
  bagLocks = [],
  queueLock = true,
  applyLocks = true,
  handlersReady = true,
} = {}) {
  const listeners = new Set();
  let state;
  const notify = () => {
    for (const listener of [...listeners]) listener(state);
  };
  const replace = (patch) => {
    state = { ...state, ...patch };
    notify();
  };
  const replaceHud = (hud) => replace({ hud });
  const recordAction = (type, payload) => {
    const seq = state.actionSeq + 1;
    replace({
      actionSeq: seq,
      actionLog: [...state.actionLog, { seq, step: 70_000 + seq, type, payload }],
    });
  };
  const sellAllLoot = () => {
    replaceHud({ ...state.hud, money: state.hud.money + 500 });
    if (queueSell) recordAction('sellAllLoot', {});
    if (throwAfterSell) throw new Error('Falha simulada após enviar venda');
    return { ok: true, n: 3, gold: 500 };
  };
  const tradeItem = (operation, itemId, quantity) => {
    if (operation !== 'buy') return { ok: false, n: 0, gold: 0 };
    if (applyPurchases) {
      replaceHud({
        ...state.hud,
        bag: {
          ...state.hud.bag,
          [itemId]: (state.hud.bag[itemId] || 0) + quantity,
        },
      });
    }
    if (queueBuy) recordAction('buy', { itemId, qty: quantity });
    return { ok: true, n: quantity, gold: quantity * 5 };
  };
  const toggleBagLock = (itemId) => {
    if (applyLocks) {
      const locks = new Set(state.hud.bagLocks);
      if (locks.has(itemId)) locks.delete(itemId);
      else locks.add(itemId);
      replaceHud({ ...state.hud, bagLocks: [...locks] });
    }
    if (queueLock) recordAction('toggleBagLock', { itemId });
    return { ok: true };
  };
  state = {
    hud: {
      money: gold,
      bag: emptyBag ? { ...bag } : { small_potion: potion, poke_ball: ball, ...bag },
      bagLocks: [...bagLocks],
    },
    actionLog: [],
    actionSeq: startSeq,
    recordAction,
    tradeItem,
    sellAllLoot,
    toggleBagLock,
    shopFn: handlersReady ? () => {} : null,
    sellAllLootFn: handlersReady ? () => {} : null,
  };
  const store = function useStore() {};
  store.getState = () => state;
  store.subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  store.setStock = ({ potion: nextPotion, ball: nextBall }) => {
    replaceHud({
      ...state.hud,
      bag: {
        ...state.hud.bag,
        ...(nextPotion == null ? {} : { small_potion: nextPotion }),
        ...(nextBall == null ? {} : { poke_ball: nextBall }),
      },
    });
  };
  store.setGold = (goldAmount) => replaceHud({ ...state.hud, money: goldAmount });
  store.setBagLocks = (locks) => replaceHud({ ...state.hud, bagLocks: [...locks] });
  store.listenerCount = () => listeners.size;
  return store;
}

function createHarness(options = {}) {
  const store = options.store || createFakeStore(options);
  const storage = options.storage || new Map();
  const timers = new Map();
  let nextTimerId = 1;
  let now = 0;
  const moduleUrl = options.moduleUrl || 'https://pokedream.com.br/assets/hash-atualiza.js';
  const nativeFetch = function nativeFetch() {};
  const NativeWebSocket = function NativeWebSocket() {};
  const NativeXMLHttpRequest = function NativeXMLHttpRequest() {};
  const moduleNamespace = options.moduleNamespace || {
    unrelated: { getState() { return {}; }, subscribe() {} },
    minifiedExport: store,
    minifiedCatalog: {
      small_potion: { id: 'small_potion', name: 'Small Potion', kind: 'potion', buy: 5 },
      hyper_potion: { id: 'hyper_potion', name: 'Hyper Potion', kind: 'potion', buy: 12 },
      poke_ball: { id: 'poke_ball', name: 'Poké Ball', kind: 'ball', buy: 10 },
      ultra_ball: { id: 'ultra_ball', name: 'Ultra Ball', kind: 'ball', buy: 130 },
      fire_stone: { id: 'fire_stone', name: 'Fire Stone', kind: 'stone', sell: 250 },
      shiny_magikarp_fin: {
        id: 'shiny_magikarp_fin',
        name: 'Shiny Magikarp Fin',
        kind: 'loot',
        sell: 29,
      },
      red_gyarados_tail: {
        id: 'red_gyarados_tail',
        name: 'Red Gyarados Tail',
        kind: 'loot',
        sell: 29,
      },
      common_tail: { id: 'common_tail', name: 'Common Tail', kind: 'loot', sell: 10 },
    },
  };
  const context = {
    console: { warn() {} },
    JSON,
    Map,
    Math,
    Number,
    Object,
    Promise,
    Date: { now() { return (options.baseTime || 1_000_000) + now; } },
    performance: {
      getEntriesByType(type) {
        return type === 'navigation' ? [{ type: options.navigationType || 'navigate' }] : [];
      },
    },
    Set,
    String,
    URL,
    WebSocket: NativeWebSocket,
    XMLHttpRequest: NativeXMLHttpRequest,
    __POKEDREAM_AUTO_REFILL_TEST_DEPS__: {
      async importModule(url) {
        assert.equal(url, moduleUrl);
        return moduleNamespace;
      },
    },
    clearTimeout(id) { timers.delete(id); },
    confirm() { return false; },
    document: {
      body: null,
      documentElement: null,
      querySelector() { return null; },
      querySelectorAll(selector) {
        return selector === 'script[type="module"][src]' ? [{ src: moduleUrl }] : [];
      },
    },
    fetch: nativeFetch,
    location: { origin: 'https://pokedream.com.br' },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: now + Number(delay || 0) });
      return id;
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);

  async function flushMicrotasks(rounds = 80) {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  }

  async function tick(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const pending = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((left, right) => left[1].dueAt - right[1].dueAt || left[0] - right[0])[0];
      if (!pending) break;
      const [id, timer] = pending;
      timers.delete(id);
      now = timer.dueAt;
      timer.callback();
      await flushMicrotasks();
    }
    now = target;
    await flushMicrotasks();
  }

  return {
    api: context.pokedreamAutoRefill,
    context,
    nativeFetch,
    NativeWebSocket,
    NativeXMLHttpRequest,
    storage,
    store,
    tick,
  };
}

test('descobre o store pelo contrato sem depender do hash ou nome do export', async () => {
  const harness = createHarness({
    moduleUrl: 'https://pokedream.com.br/assets/qualquer-hash-novo.js',
    potion: 786,
    ball: 8_575,
    gold: 511_259,
  });
  await harness.tick(0);

  const status = harness.api.status();
  assert.equal(status.enabled, false);
  assert.equal(status.adapterStatus, 'ready');
  assert.equal(status.moduleFile, 'qualquer-hash-novo.js');
  assert.equal(status.potionStock, 786);
  assert.equal(status.ballStock, 8_575);
  assert.equal(status.gold, 511_259);
  assert.deepEqual(Array.from(status.missingContext), []);
});

test('mantém os defaults seguros e exige confirmação explícita', async () => {
  const harness = createHarness();
  await harness.tick(0);
  const savedSettings = harness.api.status().settings;
  assert.deepEqual({
    ...savedSettings,
    protectedItemIds: Array.from(savedSettings.protectedItemIds),
  }, {
    potionEnabled: true,
    potionItemId: 'small_potion',
    potionThreshold: 10,
    potionQuantity: 1_000,
    ballEnabled: true,
    ballItemId: 'poke_ball',
    ballThreshold: 20,
    ballQuantity: 1_000,
    sellAllLoot: true,
    autoResume: false,
    protectedItemIds: [],
  });
  assert.equal(harness.api.start(), false);
  assert.deepEqual(harness.store.getState().actionLog, []);
});

test('retoma após recarga com estado pronto, mas não após navegação comum', async () => {
  const first = createHarness({ potion: 10, ball: 20 });
  await first.tick(0);
  first.api.configure({ autoResume: true, sellAllLoot: false });
  first.api.start({ confirmed: true });
  const storage = first.storage;

  const navigation = createHarness({ storage, potion: 10, ball: 20 });
  await navigation.tick(10_000);
  assert.equal(navigation.api.status().enabled, false);
  assert.deepEqual(navigation.store.getState().actionLog, []);

  const reload = createHarness({ storage, navigationType: 'reload', potion: 10, ball: 20 });
  await reload.tick(4_999);
  assert.equal(reload.api.status().enabled, false);
  assert.deepEqual(reload.store.getState().actionLog, []);
  await reload.tick(151);
  assert.equal(reload.api.status().enabled, true);
  assert.deepEqual(reload.store.getState().actionLog.map((action) => action.type), ['buy', 'buy']);
});

test('retoma com mochila vazia e gold válido', async () => {
  const first = createHarness();
  await first.tick(0);
  first.api.configure({ autoResume: true, sellAllLoot: false });
  first.api.start({ confirmed: true });

  const reload = createHarness({
    storage: first.storage,
    navigationType: 'reload',
    emptyBag: true,
    gold: 50_000,
  });
  await reload.tick(5_150);
  assert.equal(reload.api.status().enabled, true);
  assert.deepEqual(reload.store.getState().actionLog.map((action) => action.type), ['buy', 'buy']);
});

test('pausar cancela a retomada automática e estado incompleto impede ativação', async () => {
  const first = createHarness();
  await first.tick(0);
  first.api.configure({ autoResume: true });
  first.api.start({ confirmed: true });
  first.api.stop();

  const stopped = createHarness({ storage: first.storage, navigationType: 'reload' });
  await stopped.tick(10_000);
  assert.equal(stopped.api.status().enabled, false);

  first.api.start({ confirmed: true });
  const incomplete = createHarness({
    storage: first.storage,
    navigationType: 'reload',
    gold: NaN,
  });
  await incomplete.tick(15_000);
  assert.equal(incomplete.api.status().enabled, false);
  assert.deepEqual(incomplete.store.getState().actionLog, []);
  incomplete.store.setGold(50_000);
  await incomplete.tick(5_000);
  assert.equal(incomplete.api.status().enabled, false);
  await incomplete.tick(5_000);
  assert.equal(incomplete.api.status().enabled, true);
});

test('desligar a opção durante a espera cancela a retomada', async () => {
  const first = createHarness();
  await first.tick(0);
  first.api.configure({ autoResume: true });
  first.api.start({ confirmed: true });

  const reload = createHarness({ storage: first.storage, navigationType: 'reload' });
  await reload.tick(0);
  assert.equal(reload.api.status().resumePending, true);
  reload.api.configure({ autoResume: false });
  await reload.tick(10_000);
  assert.equal(reload.api.status().enabled, false);
  assert.equal(reload.api.status().resumePending, false);
});

test('ciclo pendente após recarga libera cedo com estoque recuperado', async () => {
  const first = createHarness({ potion: 10, ball: 20, applyPurchases: false });
  await first.tick(0);
  first.api.configure({ autoResume: true, sellAllLoot: false });
  first.api.start({ confirmed: true });
  await first.tick(150);

  const reload = createHarness({
    storage: first.storage,
    navigationType: 'reload',
    potion: 10,
    ball: 20,
  });
  await reload.tick(10_000);
  assert.equal(reload.api.status().enabled, true);
  assert.equal(reload.api.status().resumeHold, true);
  assert.deepEqual(reload.store.getState().actionLog, []);

  reload.store.setStock({ potion: 1_010, ball: 1_020 });
  await reload.tick(150);
  assert.equal(reload.api.status().resumeHold, false);
  reload.store.setStock({ potion: 10, ball: 20 });
  await reload.tick(150);
  assert.deepEqual(reload.store.getState().actionLog.map((action) => action.type), ['buy', 'buy']);
});

test('ciclo incerto rearma sozinho após a espera sem duplicar antes dela', async () => {
  const first = createHarness({ potion: 10, ball: 20, applyPurchases: false });
  await first.tick(0);
  first.api.configure({ autoResume: true, sellAllLoot: false });
  first.api.start({ confirmed: true });
  await first.tick(150);

  const reload = createHarness({
    storage: first.storage,
    navigationType: 'reload',
    baseTime: 1_000_150,
    potion: 10,
    ball: 20,
  });
  await reload.tick(60_000);
  assert.equal(reload.api.status().resumeHold, true);
  assert.deepEqual(reload.store.getState().actionLog, []);

  const secondReload = createHarness({
    storage: first.storage,
    navigationType: 'reload',
    baseTime: 1_060_150,
    potion: 10,
    ball: 20,
  });
  await secondReload.tick(59_999);
  assert.equal(secondReload.api.status().resumeHold, true);
  assert.deepEqual(secondReload.store.getState().actionLog, []);
  await secondReload.tick(151);
  assert.equal(secondReload.api.status().resumeHold, false);
  assert.deepEqual(secondReload.store.getState().actionLog.map((action) => action.type), ['buy', 'buy']);
});

test('snapshot do store diferencia estoque zero de contexto ausente', () => {
  const harness = createHarness();
  const bag = {};
  assert.deepEqual({ ...harness.api.parseGameSnapshot({
    hud: { money: 100, bag, bagLocks: ['kept_item'] },
  }) }, {
    potionStock: 0,
    ballStock: 0,
    gold: 100,
    bag,
    bagLocks: ['kept_item'],
  });
  assert.equal(harness.api.parseGameSnapshot({ hud: null }), null);
});

test('enfileira venda, potion e Poké Ball pelo mecanismo oficial do jogo', async () => {
  const harness = createHarness({ potion: 10, ball: 20 });
  await harness.tick(0);
  assert.equal(harness.api.start({ confirmed: true }), true);
  await harness.tick(150);

  const actions = harness.store.getState().actionLog;
  assert.deepEqual(actions.map((action) => action.type), ['sellAllLoot', 'buy', 'buy']);
  assert.deepEqual(actions.map((action) => action.seq), [41, 42, 43]);
  assert.deepEqual(actions.slice(1).map((action) => action.payload), [
    { itemId: 'small_potion', qty: 1_000 },
    { itemId: 'poke_ball', qty: 1_000 },
  ]);
  assert.equal(harness.api.status().lastResult.accepted, true);
});

test('gerencia os IDs de ball e potion selecionados no catálogo oficial', async () => {
  const harness = createHarness({ potion: 500, ball: 500 });
  await harness.tick(0);
  const configured = harness.api.configure({
    potionItemId: 'hyper_potion',
    ballItemId: 'ultra_ball',
  });
  assert.equal(configured.potionItemId, 'hyper_potion');
  assert.equal(configured.ballItemId, 'ultra_ball');
  assert.equal(harness.api.status().potionStock, 0);
  assert.equal(harness.api.status().ballStock, 0);

  harness.api.start({ confirmed: true });
  await harness.tick(150);
  const actions = harness.store.getState().actionLog;
  assert.deepEqual(actions.map((action) => action.type), ['sellAllLoot', 'buy', 'buy']);
  assert.deepEqual(actions.slice(1).map((action) => action.payload), [
    { itemId: 'hyper_potion', qty: 1_000 },
    { itemId: 'ultra_ball', qty: 1_000 },
  ]);
});

test('não troca o produto gerenciado enquanto o Auto Refill está ativo', async () => {
  const harness = createHarness({ potion: 500, ball: 500 });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  const configured = harness.api.configure({ ballItemId: 'ultra_ball' });
  assert.equal(configured.ballItemId, 'poke_ball');
  assert.match(harness.api.status().lastMessage, /pause o Auto Refill/i);
  assert.deepEqual(harness.store.getState().actionLog, []);
});

test('não altera configurações ou proteções enquanto ativo; pausar permite editar', async () => {
  const harness = createHarness({ potion: 500, ball: 500, bag: { fire_stone: 1 } });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  const before = harness.api.status().settings;
  harness.api.configure({ ballThreshold: 999, sellAllLoot: false, autoResume: true });
  assert.equal(harness.api.applyStonePreset(), false);
  assert.equal(harness.api.addProtectedItem('fire_stone'), false);
  assert.equal(harness.api.removeProtectedItem('fire_stone'), false);
  assert.equal(harness.api.status().settings.ballThreshold, before.ballThreshold);
  assert.equal(harness.api.status().settings.sellAllLoot, before.sellAllLoot);
  assert.equal(harness.api.status().settings.autoResume, before.autoResume);
  assert.deepEqual(Array.from(harness.api.status().settings.protectedItemIds), []);

  harness.api.stop();
  harness.api.configure({ ballThreshold: 999 });
  assert.equal(harness.api.applyStonePreset(), true);
  assert.equal(harness.api.status().settings.ballThreshold, 999);
  assert.deepEqual(Array.from(harness.api.status().settings.protectedItemIds), ['fire_stone']);
});

test('potion mantém prioridade quando somente ela cruza o threshold', async () => {
  const harness = createHarness({ potion: 9, ball: 21 });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(150);

  const actions = harness.store.getState().actionLog;
  assert.deepEqual(actions.map((action) => action.type), ['sellAllLoot', 'buy']);
  assert.equal(actions[1].payload.itemId, 'small_potion');
});

test('volta a monitorar após observar a reposição completa no estoque oficial', async () => {
  const harness = createHarness({ potion: 10, ball: 20 });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  assert.equal(harness.api.status().lastMessage, 'Auto Refill ativo. Monitorando estoque.');
  await harness.tick(150);
  assert.equal(harness.api.status().lastResult.stockConfirmed, true);
  assert.equal(harness.api.status().lastMessage, 'Auto Refill ativo. Monitorando estoque.');
  assert.equal(JSON.parse(harness.storage.get('pokedream-auto-refill-runtime-v1')).pendingCycle, null);
  await harness.tick(30_000);
  assert.equal(harness.api.status().lastMessage, 'Auto Refill ativo. Monitorando estoque.');
  assert.equal(harness.store.getState().actionLog.length, 3);
});

test('confirma cada produto separadamente e não considera reposição parcial como completa', async () => {
  const harness = createHarness({ potion: 10, ball: 20, applyPurchases: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(150);
  assert.match(harness.api.status().lastMessage, /Aguardando atualização do estoque/);
  harness.store.setStock({ potion: 1_010, ball: 500 });
  assert.equal(harness.api.status().lastResult.stockConfirmed, false);
  harness.store.setStock({ potion: 1_009, ball: 1_020 });
  assert.equal(harness.api.status().lastResult.stockConfirmed, true);
  assert.equal(harness.api.status().lastMessage, 'Auto Refill ativo. Monitorando estoque.');
  assert.equal(harness.store.getState().actionLog.length, 3);
});

test('avisa confirmação pendente sem retry e aceita atualização tardia de estoque', async () => {
  const harness = createHarness({ potion: 10, ball: 21, applyPurchases: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(30_150);
  assert.match(harness.api.status().lastMessage, /estoque ainda não confirmou/);
  assert.equal(harness.api.status().lastResult.stockConfirmed, false);
  assert.equal(harness.store.getState().actionLog.length, 2);
  harness.store.setStock({ potion: 1_010 });
  assert.equal(harness.api.status().lastResult.stockConfirmed, true);
  assert.equal(harness.api.status().lastMessage, 'Auto Refill ativo. Monitorando estoque.');
  assert.equal(harness.store.getState().actionLog.length, 2);
});

test('pausar cancela o aviso de confirmação e não é sobrescrito por estoque tardio', async () => {
  const harness = createHarness({ potion: 10, ball: 21, applyPurchases: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(150);
  harness.api.stop();
  harness.store.setStock({ potion: 1_010 });
  await harness.tick(30_000);
  assert.equal(harness.api.status().lastMessage, 'Auto Refill pausado.');
  assert.equal(harness.api.status().enabled, false);
  assert.equal(harness.store.getState().actionLog.length, 2);
});

test('estoque baixo não repete enquanto a categoria permanece desarmada', async () => {
  const harness = createHarness({ potion: 10, ball: 21, applyPurchases: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(5_000);

  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'sellAllLoot',
    'buy',
  ]);
  assert.equal(harness.api.status().potionArmed, false);
});

test('rearma somente após o estoque subir e dispara em novo cruzamento', async () => {
  const harness = createHarness({ potion: 10, ball: 21, applyPurchases: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(150);
  assert.equal(harness.store.getState().actionLog.length, 2);

  harness.store.setStock({ potion: 11 });
  harness.store.setStock({ potion: 10 });
  await harness.tick(150);
  assert.equal(harness.store.getState().actionLog.length, 4);
});

test('usa a fila oficial mesmo quando os handlers locais da loja estão ausentes', async () => {
  const harness = createHarness({ potion: 0, ball: 0, handlersReady: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(150);

  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'sellAllLoot',
    'buy',
    'buy',
  ]);
  assert.equal(harness.api.status().lastResult.accepted, true);
});

test('protege stones e itens escolhidos antes de vender, preservando locks existentes', async () => {
  const harness = createHarness({
    potion: 10,
    ball: 21,
    bag: { fire_stone: 2, shiny_magikarp_fin: 36, common_tail: 9 },
    bagLocks: ['common_tail'],
  });
  await harness.tick(0);
  assert.equal(harness.api.addProtectedItem('shiny_magikarp_fin'), true);
  assert.equal(harness.api.applyStonePreset(), true);
  harness.api.start({ confirmed: true });
  await harness.tick(150);

  const actions = harness.store.getState().actionLog;
  assert.deepEqual(actions.map((action) => action.type), [
    'toggleBagLock',
    'toggleBagLock',
    'sellAllLoot',
    'buy',
  ]);
  assert.deepEqual(actions.slice(0, 2).map((action) => action.payload.itemId), [
    'shiny_magikarp_fin',
    'fire_stone',
  ]);
  assert.deepEqual(new Set(harness.store.getState().hud.bagLocks), new Set([
    'common_tail',
    'shiny_magikarp_fin',
    'fire_stone',
  ]));
  assert.deepEqual(actions.map((action) => action.seq), [41, 42, 43, 44]);
});

test('remover uma escolha não desbloqueia o item no jogo', async () => {
  const harness = createHarness({
    potion: 10,
    ball: 21,
    bag: { shiny_magikarp_fin: 36 },
    bagLocks: ['shiny_magikarp_fin'],
  });
  await harness.tick(0);
  assert.equal(harness.api.addProtectedItem('shiny_magikarp_fin'), true);
  assert.equal(harness.api.removeProtectedItem('shiny_magikarp_fin'), true);
  harness.api.start({ confirmed: true });
  await harness.tick(150);

  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'sellAllLoot',
    'buy',
  ]);
  assert.deepEqual(harness.store.getState().hud.bagLocks, ['shiny_magikarp_fin']);
});

test('stone já bloqueada não recebe um segundo toggle com o preset ativo', async () => {
  const harness = createHarness({
    potion: 10,
    ball: 21,
    bag: { fire_stone: 4 },
    bagLocks: ['fire_stone'],
  });
  await harness.tick(0);
  assert.equal(harness.api.applyStonePreset(), true);
  const protection = harness.api.status().protection;
  assert.deepEqual(Array.from(protection.missing), []);

  harness.api.start({ confirmed: true });
  await harness.tick(150);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'sellAllLoot',
    'buy',
  ]);
  assert.deepEqual(harness.store.getState().hud.bagLocks, ['fire_stone']);
});

test('preset de stones apenas materializa a lista e permite exceção individual', async () => {
  const harness = createHarness({
    potion: 10,
    ball: 21,
    bag: { fire_stone: 4 },
  });
  await harness.tick(0);
  assert.equal(harness.api.applyStonePreset(), true);
  assert.deepEqual(harness.store.getState().actionLog, []);
  assert.deepEqual(Array.from(harness.api.status().settings.protectedItemIds), ['fire_stone']);
  assert.equal(harness.api.removeProtectedItem('fire_stone'), true);

  harness.api.start({ confirmed: true });
  await harness.tick(150);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'sellAllLoot',
    'buy',
  ]);
});

test('preset de shiny materializa somente os itens da lista presentes no catálogo', async () => {
  const harness = createHarness({
    bag: {
      red_gyarados_tail: 1,
      shiny_magikarp_fin: 1,
    },
  });
  await harness.tick(0);

  assert.equal(harness.api.applyShinyPreset(), true);
  assert.deepEqual(harness.store.getState().actionLog, []);
  assert.deepEqual(
    Array.from(harness.api.status().settings.protectedItemIds),
    ['red_gyarados_tail'],
  );
});

test('bloqueio não confirmado cancela somente a venda e mantém a compra funcionando', async () => {
  const harness = createHarness({
    potion: 500,
    ball: 20,
    bag: { fire_stone: 1 },
    applyLocks: false,
  });
  await harness.tick(0);
  assert.equal(harness.api.applyStonePreset(), true);
  harness.api.start({ confirmed: true });
  await harness.tick(5_500);

  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'toggleBagLock',
    'buy',
  ]);
  assert.equal(harness.store.getState().actionLog[1].payload.itemId, 'poke_ball');
  assert.equal(harness.api.status().lastResult.accepted, true);
  assert.equal(harness.api.status().lastResult.stockConfirmed, true);
  assert.equal(harness.api.status().lastResult.saleStatus, 'skipped');
  assert.match(harness.api.status().lastResult.saleWarning, /Bloqueios não confirmados/i);
  assert.equal(harness.api.status().ballArmed, true);
  assert.match(harness.api.status().lastMessage, /Monitorando estoque.*Venda de loot pendente/);

  // Next refill consults fresh locks; a late confirmation must not be toggled off.
  harness.store.setBagLocks(['fire_stone']);
  harness.store.setStock({ ball: 20 });
  await harness.tick(150);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'toggleBagLock', 'buy', 'sellAllLoot', 'buy',
  ]);
  assert.deepEqual(harness.store.getState().hud.bagLocks, ['fire_stone']);
  assert.equal(harness.api.status().lastResult.saleWarning, null);
});

test('não vende quando o jogo deixa de enfileirar a action de bloqueio', async () => {
  const harness = createHarness({
    potion: 10,
    ball: 21,
    bag: { fire_stone: 1 },
    queueLock: false,
  });
  await harness.tick(0);
  assert.equal(harness.api.applyStonePreset(), true);
  harness.api.start({ confirmed: true });
  await harness.tick(150);

  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), ['buy']);
  assert.equal(harness.api.status().lastResult.accepted, true);
  assert.equal(harness.api.status().lastResult.saleStatus, 'skipped');
  assert.match(harness.api.status().lastResult.saleWarning, /action toggleBagLock/);
});

test('novo ciclo tenta proteger os itens ainda desbloqueados sem travar o refill', async () => {
  const harness = createHarness({ potion: 500, ball: 20, bag: { fire_stone: 1 }, applyLocks: false });
  await harness.tick(0);
  harness.api.applyStonePreset();
  harness.api.start({ confirmed: true });
  await harness.tick(5_500);
  harness.store.setStock({ ball: 20 });
  await harness.tick(5_500);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'toggleBagLock', 'buy', 'toggleBagLock', 'buy',
  ]);
  assert.equal(harness.api.status().ballArmed, true);
  assert.equal(harness.api.status().lastResult.stockConfirmed, true);
});

test('falha incerta na venda não repete a venda e permite a compra', async () => {
  const harness = createHarness({ potion: 500, ball: 20, throwAfterSell: true });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(150);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), ['sellAllLoot', 'buy']);
  assert.equal(harness.api.status().lastResult.accepted, true);
  assert.equal(harness.api.status().lastResult.saleStatus, 'uncertain');
  assert.equal(harness.api.status().ballArmed, true);
  await harness.tick(30_000);
  assert.equal(harness.store.getState().actionLog.length, 2);
});

test('actions nativas intercaladas durante a espera não invalidam o refill', async () => {
  const harness = createHarness({ potion: 500, ball: 20, bag: { fire_stone: 1 }, applyLocks: false });
  await harness.tick(0);
  harness.api.applyStonePreset();
  harness.api.start({ confirmed: true });
  await harness.tick(150);
  harness.store.getState().recordAction('unrelated', {});
  harness.store.setBagLocks(['fire_stone']);
  await harness.tick(0);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), [
    'toggleBagLock', 'unrelated', 'sellAllLoot', 'buy',
  ]);
  assert.equal(harness.api.status().lastResult.accepted, true);
  assert.equal(harness.api.status().lastResult.stockConfirmed, true);
  assert.equal(harness.api.status().ballArmed, true);
});

test('pausar durante a espera dos locks impede venda e compra posteriores', async () => {
  const harness = createHarness({ potion: 500, ball: 20, bag: { fire_stone: 1 }, applyLocks: false });
  await harness.tick(0);
  harness.api.applyStonePreset();
  harness.api.start({ confirmed: true });
  await harness.tick(150);
  harness.api.stop();
  harness.store.setBagLocks(['fire_stone']);
  await harness.tick(5_500);
  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), ['toggleBagLock']);
  assert.equal(harness.api.status().enabled, false);
  assert.equal(harness.api.status().lastMessage, 'Auto Refill pausado.');
});

test('action ausente interrompe o ciclo sem retry automático', async () => {
  const harness = createHarness({ potion: 10, ball: 21, queueBuy: false });
  await harness.tick(0);
  harness.api.start({ confirmed: true });
  await harness.tick(5_000);

  assert.deepEqual(harness.store.getState().actionLog.map((action) => action.type), ['sellAllLoot']);
  assert.equal(harness.api.status().lastResult.accepted, false);
  assert.equal(harness.api.status().potionArmed, false);
});

test('contrato incompatível falha fechado e não permite ativar', async () => {
  const harness = createHarness({ moduleNamespace: { exportMinificado: () => {} } });
  await harness.tick(0);

  assert.equal(harness.api.status().adapterStatus, 'incompatible');
  assert.equal(harness.api.start({ confirmed: true }), false);
  assert.equal(harness.api.status().enabled, false);
});

test('não altera fetch, XHR ou WebSocket e limpa a subscription no uninstall', async () => {
  const harness = createHarness();
  await harness.tick(0);
  assert.equal(harness.store.listenerCount(), 1);
  assert.equal(harness.context.fetch, harness.nativeFetch);
  assert.equal(harness.context.WebSocket, harness.NativeWebSocket);
  assert.equal(harness.context.XMLHttpRequest, harness.NativeXMLHttpRequest);

  assert.equal(harness.api.uninstall(), true);
  assert.equal(harness.store.listenerCount(), 0);
  assert.equal(harness.context.pokedreamAutoRefill, undefined);
});
