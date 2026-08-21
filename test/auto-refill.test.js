const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auto-refill.user.js'), 'utf8');

function createHarness({
  savedSettings = null,
  initialGold = 1_000_000,
  fetchOverride = null,
} = {}) {
  let now = 1_000_000;
  let gold = initialGold;
  let nextTimerId = 1;
  const timers = new Map();
  const storage = new Map([
    ['pokeweb:tokens', JSON.stringify({ accessToken: 'test-access', refreshToken: 'test-refresh' })],
  ]);
  const requests = [];
  if (savedSettings) {
    storage.set('piw-auto-refill-settings-v1', JSON.stringify(savedSettings));
  }

  class FakeDate extends Date {
    constructor(...args) {
      super(args.length ? args[0] : now);
    }

    static now() {
      return now;
    }
  }

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url = 'wss://poke.idleworld.online/ws1') {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.listeners = new Map();
      this.sent = [];
    }

    send(data) {
      this.sent.push(JSON.parse(data));
    }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      this.listeners.set(type, handlers.filter((candidate) => candidate !== handler));
    }

    emit(type, payload = null) {
      if (type === 'open') this.readyState = FakeWebSocket.OPEN;
      if (type === 'close') this.readyState = FakeWebSocket.CLOSED;
      const event = type === 'message' ? { data: JSON.stringify(payload) } : {};
      for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    }
  }

  function response(status, data) {
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() { return data; },
    };
  }

  const shopCatalog = {
    get gold() { return gold; },
    items: [
      { id: 201, name: 'Great Potion', priceGold: 10, category: 'heal' },
      { id: 203, name: 'Hyper Potion', priceGold: 55, category: 'heal' },
    ],
    balls: [
      { id: 1, name: 'Poke Ball', priceGold: 10 },
      { id: 4, name: 'Ultra Ball', priceGold: 100 },
    ],
  };
  const itemsCatalog = {
    items: [
      { id: 10, name: 'Cheap Loot', category: 'loot', npcPrice: 100 },
      { id: 11, name: 'Boundary Loot', category: 'loot', npcPrice: 4_000 },
      { id: 12, name: 'Valuable Loot', category: 'loot', npcPrice: 4_001 },
      { id: 13, name: 'Stone', category: 'stone', npcPrice: 100 },
    ],
  };

  async function defaultFetch(url, options = {}) {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method, body, headers: options.headers || {} });

    if (url === '/game/items.json') return response(200, itemsCatalog);
    if (url === '/api/game/shop' && method === 'GET') return response(200, shopCatalog);
    if (url === '/api/game/shop/sell') {
      gold += 1_000;
      return response(200, { ok: true, soldKinds: body.items.length, soldCount: 5, goldGained: 1_000, gold });
    }
    if (url === '/api/game/shop/buy') {
      const id = body.itemId ?? body.ballId;
      const products = body.itemId != null ? shopCatalog.items : shopCatalog.balls;
      const price = products.find((product) => product.id === id)?.priceGold || 0;
      gold -= price * body.qty;
      return response(200, { ok: true, bought: body.qty, goldSpent: price * body.qty, gold });
    }
    throw new Error(`Fetch inesperado: ${method} ${url}`);
  }

  const context = {
    console: { log() {}, warn() {} },
    Date: FakeDate,
    JSON,
    Map,
    Math,
    MutationObserver: class {},
    Number,
    Object,
    Set,
    String,
    WeakSet,
    WebSocket: FakeWebSocket,
    clearTimeout(id) { timers.delete(id); },
    document: {
      body: null,
      documentElement: null,
      readyState: 'loading',
      addEventListener() {},
      querySelector() { return null; },
    },
    fetch(url, options) {
      return fetchOverride
        ? fetchOverride({ url, options: options || {}, requests, response, shopCatalog, itemsCatalog, getGold: () => gold, setGold: (value) => { gold = value; } })
        : defaultFetch(url, options);
    },
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

  async function flushMicrotasks(rounds = 60) {
    for (let index = 0; index < rounds; index += 1) await Promise.resolve();
  }

  async function tick(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const pending = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
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

  function captureSocket() {
    const socket = new context.WebSocket('wss://poke.idleworld.online/ws1');
    socket.send(JSON.stringify({ type: 'bootstrap-test' }));
    socket.sent = [];
    return socket;
  }

  return {
    api: context.piwAutoRefill,
    captureSocket,
    context,
    getGold: () => gold,
    requests,
    setGold(value) { gold = value; },
    storage,
    tick,
  };
}

function requestsTo(harness, url) {
  return harness.requests.filter((request) => request.url === url);
}

test('divide qualquer quantidade em lotes de no máximo 1000', () => {
  const harness = createHarness();
  assert.deepEqual([...harness.api.splitPurchaseBatches(750)], [750]);
  assert.deepEqual([...harness.api.splitPurchaseBatches(1_500)], [1_000, 500]);
  assert.deepEqual([...harness.api.splitPurchaseBatches(6_250)], [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 250]);
  assert.deepEqual([...harness.api.splitPurchaseBatches(10_000)], Array(10).fill(1_000));
});

test('instala pausado, usa um subscriber e não consulta estoque', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'inventory', items: [{ itemId: 203, quantity: 0 }] });
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(1_000);

  assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 1);
  assert.deepEqual(harness.requests, []);
  assert.deepEqual(socket.sent, []);
  assert.equal(harness.api.status().enabled, false);
});

test('compra quantidade quebrada sem sair da hunt', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({
    potionEnabled: false,
    ballEnabled: true,
    ballId: 4,
    ballThreshold: 10,
    ballQuantity: 2_500,
    sellTrash: false,
  });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 10 } });
  await harness.tick(100);

  assert.deepEqual(
    requestsTo(harness, '/api/game/shop/buy').map((request) => request.body),
    [
      { ballId: 4, qty: 1_000 },
      { ballId: 4, qty: 1_000 },
      { ballId: 4, qty: 500 },
    ],
  );
  assert.deepEqual(socket.sent, []);
  assert.equal(harness.api.status().ballArmed, false);
  assert.equal(harness.api.status().lastResult.ball.bought, 2_500);
});

test('reserva de gold é validada antes de cada lote', async () => {
  const harness = createHarness({ initialGold: 2_500 });
  const socket = harness.captureSocket();
  harness.api.configure({
    potionEnabled: false,
    ballEnabled: true,
    ballId: 1,
    ballThreshold: 0,
    ballQuantity: 250,
    goldReserve: 700,
  });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 1: 0 } });
  await harness.tick(100);

  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy'), []);
  assert.equal(harness.api.status().lastResult.ball.reason, 'not_enough_gold');
  assert.equal(harness.api.status().ballArmed, false);
  assert.equal(harness.getGold(), 2_500);
});

test('não repete enquanto baixo e rearma somente após cruzar o threshold', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({
    potionEnabled: false,
    ballEnabled: true,
    ballId: 1,
    ballThreshold: 10,
    ballQuantity: 50,
  });
  harness.api.start();

  socket.emit('message', { type: 'balls', counts: { 1: 10 } });
  await harness.tick(100);
  socket.emit('message', { type: 'balls', counts: { 1: 5 } });
  await harness.tick(1_000);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 1);

  socket.emit('message', { type: 'balls', counts: { 1: 11 } });
  socket.emit('message', { type: 'balls', counts: { 1: 10 } });
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 2);
});

test('vende somente loot de 1 a 4000 e compra potion antes de ball', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({
    potionEnabled: true,
    potionItemId: 203,
    potionThreshold: 5,
    potionQuantity: 10,
    ballEnabled: true,
    ballId: 4,
    ballThreshold: 5,
    ballQuantity: 10,
    sellTrash: true,
  });
  harness.api.start();
  socket.emit('message', {
    type: 'inventory',
    items: [
      { itemId: 203, quantity: 5 },
      { itemId: 10, quantity: 2 },
      { itemId: 11, quantity: 3 },
      { itemId: 12, quantity: 4 },
      { itemId: 13, quantity: 5 },
    ],
  });
  socket.emit('message', { type: 'balls', counts: { 4: 5 } });
  await harness.tick(100);

  const relevant = harness.requests.filter((request) => request.url !== '/game/items.json');
  assert.deepEqual(relevant.map((request) => request.url), [
    '/api/game/shop/sell',
    '/api/game/shop',
    '/api/game/shop/buy',
    '/api/game/shop/buy',
  ]);
  assert.deepEqual(relevant[0].body, {
    items: [
      { itemId: 10, qty: 2 },
      { itemId: 11, qty: 3 },
    ],
  });
  assert.deepEqual(relevant[2].body, { itemId: 203, qty: 10 });
  assert.deepEqual(relevant[3].body, { ballId: 4, qty: 10 });
});

test('venda habilitada aguarda inventory antes de qualquer operação', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballEnabled: true, ballThreshold: 0, sellTrash: true });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.deepEqual(harness.requests, []);

  socket.emit('message', { type: 'inventory', items: [] });
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop').length, 1);
});

test('falha na preparação da venda não impede compra com o gold atual', async () => {
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog }) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method, body, headers: options.headers || {} });
      if (url === '/game/items.json') return response(500, { message: 'catalog unavailable' });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty, gold: 900_000 });
      throw new Error(`Fetch inesperado: ${url}`);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballEnabled: true, ballThreshold: 0, ballQuantity: 10, sellTrash: true });
  harness.api.start();
  socket.emit('message', { type: 'inventory', items: [{ itemId: 10, quantity: 1 }] });
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);

  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 1);
  assert.equal(harness.api.status().lastResult.trash.ok, false);
  assert.equal(harness.api.status().lastResult.ball.bought, 10);
});

test('resposta parcial interrompe os lotes e exige rearme', async () => {
  let buyCalls = 0;
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog }) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method, body, headers: options.headers || {} });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') {
        buyCalls += 1;
        return response(200, { ok: true, bought: 600, gold: 900_000 });
      }
      throw new Error(`Fetch inesperado: ${url}`);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballEnabled: true, ballThreshold: 0, ballQuantity: 2_500 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);

  assert.equal(buyCalls, 1);
  assert.equal(harness.api.status().lastResult.ball.bought, 600);
  assert.equal(harness.api.status().lastResult.ball.reason, 'partial_batch');
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(1_000);
  assert.equal(buyCalls, 1);
});

test('sem gold não repete até rearme manual', async () => {
  const harness = createHarness({ initialGold: 0 });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballEnabled: true, ballThreshold: 0, ballQuantity: 100 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 0);

  harness.setGold(100_000);
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(1_000);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 0);

  harness.api.rearm('ball');
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 1);
});

test('renova token uma vez após 401 sem expor credenciais', async () => {
  let shopAttempts = 0;
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog }) => {
      const method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, method, body, headers: options.headers || {} });
      if (url === '/api/game/shop' && ++shopAttempts === 1) return response(401, { message: 'expired' });
      if (url === '/api/auth/refresh') return response(200, { accessToken: 'renewed', refreshToken: 'renewed-refresh' });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty, gold: 900_000 });
      throw new Error(`Fetch inesperado: ${url}`);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballEnabled: true, ballThreshold: 0, ballQuantity: 10 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);

  assert.equal(requestsTo(harness, '/api/auth/refresh').length, 1);
  assert.equal(JSON.parse(harness.storage.get('pokeweb:tokens')).accessToken, 'renewed');
  assert.equal(harness.api.status().lastResult.ball.bought, 10);
});

test('uninstall remove somente o subscriber do Auto Refill', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  assert.equal(bridge.status().subscribers, 1);
  harness.api.uninstall();
  assert.equal(bridge.status().subscribers, 0);
  assert.equal(harness.context.piwScripts.wsBridge, bridge);
  assert.equal(harness.context.piwAutoRefill, undefined);
});
