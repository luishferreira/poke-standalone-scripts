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
      { id: 14, name: 'Free Loot', category: 'loot', npcPrice: 0 },
      { id: 19354, name: 'Fresh Herbs', category: 'loot', npcPrice: 1_000 },
      { id: 19356, name: 'Wild Herbs', category: 'loot', npcPrice: 5_000 },
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
    AbortController,
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
      querySelectorAll() { return []; },
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

  async function replyToSnapshot(socket, type, payload) {
    await flushMicrotasks();
    socket.emit('message', { type, ...payload });
    await flushMicrotasks();
  }

  return {
    api: context.piwAutoRefill,
    captureSocket,
    context,
    getGold: () => gold,
    requests,
    replyToSnapshot,
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

test('status ativo não diz que aguarda estoque já conhecido', () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'inventory', items: [{ itemId: 203, quantity: 1_000 }] });
  socket.emit('message', { type: 'balls', counts: { 4: 1_000 } });
  assert.equal(harness.api.start().lastMessage, 'Auto Refill ativo.');
  assert.equal(harness.api.status().potionStock, 1_000);
  assert.equal(harness.api.status().ballStock, 1_000);
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

test('reutiliza o catálogo da loja e recebe gold passivamente pelo WebSocket', async () => {
  const harness = createHarness({ initialGold: 2_000 });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, ballQuantity: 10 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop').length, 1);

  harness.setGold(50);
  socket.emit('message', { type: 'balls', counts: { 4: 1 }, gold: 50 });
  socket.emit('message', { type: 'balls', counts: { 4: 0 }, gold: 50 });
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop').length, 1);
  assert.equal(requestsTo(harness, '/api/game/profile').length, 0);
  assert.deepEqual(socket.sent, []);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 1);
  assert.equal(harness.api.status().lastResult.ball.reason, 'not_enough_gold');
  assert.equal(harness.api.status().currentGold, 50);
});

test('saldo antigo solicita balls-get uma vez no refill e usa a resposta', async () => {
  const harness = createHarness();
  await harness.api.loadShop();
  await harness.tick(5 * 60_000 + 1);
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, ballQuantity: 10 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.deepEqual(socket.sent, [{ type: 'balls-get' }]);
  await harness.replyToSnapshot(socket, 'balls', { counts: { 4: 0 }, gold: 50 });

  assert.equal(requestsTo(harness, '/api/game/shop').length, 1);
  assert.equal(requestsTo(harness, '/api/game/profile').length, 0);
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy'), []);
  assert.equal(harness.api.status().lastResult.ball.reason, 'not_enough_gold');
});

test('balls-get sem gold válido bloqueia compra com catálogo em cache', async () => {
  const harness = createHarness({
    fetchOverride: async ({ url, requests, response, shopCatalog }) => {
      requests.push({ url });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      throw new Error(`Request inesperada: ${url}`);
    },
  });
  await harness.api.loadShop();
  await harness.tick(5 * 60_000 + 1);
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, ballQuantity: 10 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.deepEqual(socket.sent, [{ type: 'balls-get' }]);
  await harness.replyToSnapshot(socket, 'balls', { counts: { 4: 0 }, gold: null });

  assert.equal(requestsTo(harness, '/api/game/shop').length, 1);
  assert.equal(requestsTo(harness, '/api/game/profile').length, 0);
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy'), []);
  assert.match(harness.api.status().lastResult.error, /Saldo do jogo indisponível/);
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
      { itemId: 14, quantity: 6 },
      { itemId: 19354, quantity: 770 },
      { itemId: 19356, quantity: 7 },
    ],
  });
  socket.emit('message', { type: 'balls', counts: { 4: 5 } });
  await harness.tick(100);
  assert.deepEqual(socket.sent, [{ type: 'inv-get' }]);
  await harness.replyToSnapshot(socket, 'inventory', {
    items: [
      { itemId: 203, quantity: 5 },
      { itemId: 10, quantity: 2 },
      { itemId: 11, quantity: 3 },
      { itemId: 12, quantity: 4 },
      { itemId: 13, quantity: 5 },
      { itemId: 14, quantity: 6 },
      { itemId: 19354, quantity: 770 },
      { itemId: 19356, quantity: 7 },
    ],
  });

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

test('falha na preparação da venda não bloqueia refill', async () => {
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
  await harness.replyToSnapshot(socket, 'inventory', { items: [{ itemId: 10, quantity: 1 }] });

  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy').map((request) => request.body), [
    { ballId: 4, qty: 10 },
  ]);
  assert.equal(harness.api.status().lastResult.trash.ok, false);
  assert.equal(harness.api.status().lastResult.ball.ok, true);
  assert.equal(harness.api.status().lastMessage.includes('Venda de lixo falhou.'), true);
});

test('venda parcial de loot não impede venda de Pokémon nem refill e não se repete', async () => {
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, itemsCatalog, shopCatalog }) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url === '/game/items.json') return response(200, itemsCatalog);
      if (url === '/api/game/shop/sell') return response(200, {
        ok: true, soldKinds: 1, soldCount: 1, goldGained: 100, gold: 1_000_100,
      });
      if (url === '/api/game/pokemon/sell') return response(200, {
        sold: body.pokeIds.length, goldGained: 500, gold: 1_000_600,
      });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty, gold: 900_000 });
      throw new Error(url);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: true, potionThreshold: 0, potionQuantity: 10,
    ballThreshold: 0, ballQuantity: 10, sellTrash: true, sellPokemon: true });
  harness.api.start();
  socket.emit('message', { type: 'inventory', items: [{ itemId: 203, quantity: 0 }, { itemId: 10, quantity: 2 }] });
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  await harness.replyToSnapshot(socket, 'inventory', { items: [{ itemId: 203, quantity: 0 }, { itemId: 10, quantity: 2 }] });
  assert.deepEqual(socket.sent.slice(-1), [{ type: 'pokes-get' }]);
  await harness.replyToSnapshot(socket, 'pokes', { list: [
    { id: 'low-iv', ivTotal: 100, quality: 1.2, level: 50, sellValue: 500 },
  ] });
  await harness.tick(120_000);
  assert.equal(requestsTo(harness, '/api/game/shop/sell').length, 1);
  assert.deepEqual(requestsTo(harness, '/api/game/pokemon/sell').map((request) => request.body), [
    { pokeIds: ['low-iv'] },
  ]);
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy').map((request) => request.body), [
    { itemId: 203, qty: 10 },
    { ballId: 4, qty: 10 },
  ]);
  assert.equal(harness.api.status().lastResult.trash.ok, false);
  assert.equal(harness.api.status().lastResult.trash.reason, 'partial_sale');
  assert.equal(harness.api.status().lastResult.trash.soldCount, 1);
  assert.equal(harness.api.status().lastResult.trash.requestedCount, 2);
  assert.match(harness.api.status().lastMessage, /Venda de loot parcial: 1\/2 unidades \(1\/1 tipos\)/);
  assert.equal(harness.api.status().lastResult.pokemon.soldCount, 1);
  assert.equal(harness.api.status().lastResult.potion.ok, true);
  assert.equal(harness.api.status().lastResult.ball.ok, true);
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

test('compra sem gold confirmado não libera compra de ball', async () => {
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog }) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty });
      throw new Error(url);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionThreshold: 10, potionQuantity: 5, ballThreshold: 10, ballQuantity: 5 });
  harness.api.start();
  socket.emit('message', { type: 'inventory', items: [{ itemId: 203, quantity: 0 }] });
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);

  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy').map((request) => request.body), [
    { itemId: 203, qty: 5 },
  ]);
  assert.equal(harness.api.status().lastResult.potion.reason, 'missing_gold_confirmation');
  assert.equal(harness.api.status().lastResult.potion.ok, false);
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
  socket.emit('message', { type: 'balls', counts: { 4: 0 }, gold: 100_000 });
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

test('balls recebidas primeiro esperam inventário e compram potion antes', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({ potionThreshold: 20, potionQuantity: 10, ballThreshold: 10, ballQuantity: 10 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.deepEqual(socket.sent, [{ type: 'inv-get' }]);
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy'), []);
  await harness.replyToSnapshot(socket, 'inventory', { items: [{ itemId: 200, quantity: 5 }] });
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy').map((request) => request.body), [
    { itemId: 203, qty: 10 },
    { ballId: 4, qty: 10 },
  ]);
});

test('potion com estoque antigo consulta inventário e não compra se já foi reposta', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({ potionThreshold: 20, potionQuantity: 10, ballEnabled: false });
  socket.emit('message', { type: 'inventory', items: [{ itemId: 203, quantity: 5 }] });
  await harness.tick(61_000);
  harness.api.start();
  await harness.tick(100);
  assert.deepEqual(socket.sent, [{ type: 'inv-get' }]);
  await harness.replyToSnapshot(socket, 'inventory', { items: [{ itemId: 203, quantity: 25 }] });
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy'), []);
  assert.equal(harness.api.status().potionStock, 25);
});

test('balls podem gastar mais de metade do gold sem piso adicional', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, ballQuantity: 6_000 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 6);
  assert.equal(harness.getGold(), 400_000);
  assert.equal(harness.api.status().lastResult.ball.ok, true);
});

test('venda automática usa lista fresca, IV configurável e bloqueia quality e level altos', async () => {
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog, setGold }) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url === '/api/game/pokemon/sell') {
        setGold(1_015_000);
        return response(200, { sold: body.pokeIds.length, goldGained: 15_000, gold: 1_015_000 });
      }
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty, gold: 1_014_000 });
      throw new Error(url);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, ballQuantity: 10, sellPokemon: true, pokemonMaxIv: 160 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  assert.deepEqual(socket.sent, [{ type: 'pokes-get' }]);
  await harness.replyToSnapshot(socket, 'pokes', { list: [
    { id: 'safe-a', ivTotal: 119, quality: 1.69, level: 99, sellValue: 1000 },
    { id: 'safe-b', ivTotal: 160, quality: 1.7, level: 100, sellValue: 1000 },
    { id: 'keep-level', ivTotal: 10, quality: 1.1, level: 101, sellValue: 1000 },
    { id: 'keep-missing-level', ivTotal: 10, quality: 1.1, sellValue: 1000 },
    { id: 'keep-quality', ivTotal: 10, quality: 1.71, level: 10, sellValue: 1000 },
    { id: 'keep-iv', ivTotal: 179, quality: 1.2, level: 10, sellValue: 1000 },
    { id: 'keep-missing-quality', ivTotal: 10, level: 10, sellValue: 1000 },
    { id: 'keep-shiny', ivTotal: 10, quality: 1.1, level: 10, shiny: true, sellValue: 1000 },
    { id: 'keep-locked', ivTotal: 10, quality: 1.1, level: 10, locked: true, sellValue: 1000 },
    { id: 'keep-team', ivTotal: 10, quality: 1.1, level: 10, team: true, sellValue: 1000 },
    { id: 'keep-market', ivTotal: 10, quality: 1.1, level: 10, listed: true, sellValue: 1000 },
  ] });
  assert.deepEqual(requestsTo(harness, '/api/game/pokemon/sell')[0].body, { pokeIds: ['safe-a', 'safe-b'] });
  assert.equal(harness.api.status().lastResult.pokemon.soldCount, 2);
});

test('limite de IV inválido preserva o default e zero é aceito', async () => {
  const harness = createHarness();
  assert.equal(harness.api.configure({ pokemonMaxIv: 999 }).settings.pokemonMaxIv, 160);
  assert.equal(harness.api.configure({ pokemonMaxIv: 0 }).settings.pokemonMaxIv, 0);
});

test('venda parcial de Pokémon permite refill e não tenta vender novamente sozinha', async () => {
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog }) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url === '/api/game/pokemon/sell') return response(200, { sold: 0, goldGained: 0, gold: 1_000_000 });
      if (url === '/api/game/shop') return response(200, shopCatalog);
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty, gold: 900_000 });
      throw new Error(url);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, sellPokemon: true });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  await harness.replyToSnapshot(socket, 'pokes', { list: [
    { id: 'sell-me', ivTotal: 100, quality: 1.2, level: 50, sellValue: 100 },
  ] });
  await harness.tick(120_000);
  assert.equal(requestsTo(harness, '/api/game/pokemon/sell').length, 1);
  assert.deepEqual(requestsTo(harness, '/api/game/shop/buy').map((request) => request.body), [
    { ballId: 4, qty: 1000 },
  ]);
  assert.equal(harness.api.status().lastResult.pokemon.reason, 'partial_sale');
  assert.equal(harness.api.status().lastMessage.includes('Venda de Pokémon falhou.'), true);
});

test('pausar enquanto espera Pokémon cancela a venda', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, sellPokemon: true });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  harness.api.stop();
  socket.emit('message', { type: 'pokes', list: [{ id: 'x', ivTotal: 10, quality: 1, level: 10, sellValue: 1000 }] });
  await harness.tick(1);
  assert.deepEqual(requestsTo(harness, '/api/game/pokemon/sell'), []);
  assert.equal(harness.api.status().enabled, false);
});

test('rearmar durante ciclo não duplica compra', async () => {
  let releaseShop;
  const shopPending = new Promise((resolve) => { releaseShop = resolve; });
  const harness = createHarness({
    fetchOverride: async ({ url, options, requests, response, shopCatalog }) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, body });
      if (url === '/api/game/shop') return shopPending;
      if (url === '/api/game/shop/buy') return response(200, { ok: true, bought: body.qty, gold: 999_000 });
      throw new Error(url);
    },
  });
  const socket = harness.captureSocket();
  harness.api.configure({ potionEnabled: false, ballThreshold: 0, ballQuantity: 10 });
  harness.api.start();
  socket.emit('message', { type: 'balls', counts: { 4: 0 } });
  await harness.tick(100);
  harness.api.rearm('ball');
  releaseShop({ ok: true, status: 200, async json() { return shopCatalogFor(harness); } });
  await harness.tick(1_000);
  assert.equal(requestsTo(harness, '/api/game/shop/buy').length, 1);
});

function shopCatalogFor(harness) {
  return {
    gold: harness.getGold(),
    items: [{ id: 203, name: 'Hyper Potion', priceGold: 55, category: 'heal' }],
    balls: [{ id: 4, name: 'Ultra Ball', priceGold: 100 }],
  };
}
