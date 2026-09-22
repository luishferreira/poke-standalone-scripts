const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auto-pokedex.user.js'), 'utf8');

function createHarness({
  creatures,
  markers,
  pokedex = [],
  level = 100,
  availableMarkerSlugs = null,
  markersVisibleAfterAreaClick = false,
} = {}) {
  let now = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const storage = new Map();
  let currentPokedex = pokedex;
  let currentLevel = level;
  let currentSocket = null;
  let visualHuntSlug = null;
  let mapOpen = false;
  let areaSelected = false;
  const requests = [];

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

    constructor(url = 'wss://poke.idleworld.online/ws') {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.listeners = new Map();
      currentSocket = this;
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
      this.listeners.set(type, handlers.filter((item) => item !== handler));
    }

    emit(type, payload = null) {
      const event = type === 'message' ? { data: JSON.stringify(payload) } : {};
      for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    }
  }

  const mapButton = {
    click() { mapOpen = true; },
  };
  const allowedMarkers = availableMarkerSlugs == null ? null : new Set(availableMarkerSlugs);
  const markerElements = (markers || [])
    .filter((entry) => !allowedMarkers || allowedMarkers.has(entry.slug))
    .map((entry) => ({
      dataset: { guide: `hunt-${entry.slug}` },
      click() {
        visualHuntSlug = entry.slug;
        currentSocket?.send(JSON.stringify({ type: 'enter-hunt', slug: entry.slug }));
      },
    }));
  const mapArea = {
    matches() { return areaSelected; },
    click() { areaSelected = true; },
  };

  const context = {
    console: { log() {}, warn() {} },
    Date: FakeDate,
    JSON,
    Map,
    Math,
    MutationObserver: class {},
    Number,
    Set,
    String,
    WebSocket: FakeWebSocket,
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    document: {
      body: null,
      documentElement: null,
      readyState: 'loading',
      addEventListener() {},
      createElement() { throw new Error('DOM não deve ser criado neste teste'); },
      querySelector(selector) {
        if (selector === 'button[data-guide="dock-map"]') return mapButton;
        if (selector === '.map-window') return mapOpen ? {} : null;
        return null;
      },
      querySelectorAll(selector) {
        if (selector === '[data-guide]') {
          return mapOpen && (!markersVisibleAfterAreaClick || areaSelected) ? markerElements : [];
        }
        if (selector === '.map-area:not(.locked), .map-plate:not(.locked)') return [mapArea];
        return [];
      },
    },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      let data;
      if (url === '/game/creatures.json') data = creatures || [];
      else if (url === '/api/game/map-markers') data = markers || [];
      else if (url === '/api/game/pokedex') data = { species: currentPokedex };
      else if (url === '/api/characters/me') data = { character: { level: currentLevel } };
      else throw new Error(`Request inesperada: ${url}`);
      return { ok: true, status: 200, json: async () => data };
    },
    getComputedStyle() { return { display: 'block' }; },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    setInterval(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: now + Number(delay || 0), interval: Number(delay || 0) });
      return id;
    },
    setTimeout(callback, delay) {
      const id = nextTimerId++;
      timers.set(id, { callback, dueAt: now + Number(delay || 0), interval: 0 });
      return id;
    },
  };
  context.window = context;
  vm.runInNewContext(source, context);

  async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  }

  async function tick(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const pending = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
      if (!pending) break;
      const [id, timer] = pending;
      now = timer.dueAt;
      if (timer.interval) timer.dueAt += timer.interval;
      else timers.delete(id);
      await timer.callback();
      await settle();
    }
    now = target;
    await settle();
  }

  function captureSocket() {
    const socket = new context.WebSocket();
    socket.send(JSON.stringify({ type: 'bootstrap-test' }));
    socket.sent = [];
    return socket;
  }

  return {
    api: context.piwAutoPokedex,
    captureSocket,
    context,
    reinject() { vm.runInContext(source, context); },
    requests,
    setLevel(value) { currentLevel = value; },
    setPokedex(value) { currentPokedex = value; },
    settle,
    tick,
    visualHuntSlug() { return visualHuntSlug; },
  };
}

function creature(pokeId, name, sellValue, huntLevel = 1, priceNpc = 0, captureBase = null) {
  return { pokeId, name, sellValue, huntLevel, priceNpc, captureBase };
}

function marker(slug, name, level = 1) {
  return { slug, name, level };
}

function sentTypes(socket) {
  return socket.sent.map((message) => message.type);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('instala pausado com um subscriber e sem alias global de socket', () => {
  const harness = createHarness();
  const socket = harness.captureSocket();

  assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 1);
  assert.equal(harness.api.status().running, false);
  assert.equal(harness.context.myGameSocket, undefined);
  assert.deepEqual(socket.sent, []);
  harness.reinject();
  assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 1);
});

test('ordena por preço, filtra capturados e nível e ignora quem não tem hunt', async () => {
  const harness = createHarness({
    creatures: [
      creature(10, 'Caterpie', 80),
      creature(16, 'Pidgey', 0, 1, 70),
      creature(46, 'Paras', 60),
      creature(132, 'Ditto', 50),
      creature(149, 'Dragonite', 1_000, 100),
    ],
    markers: [
      marker('caterpie', 'Caterpie'),
      marker('pidgey', 'Pidgey'),
      marker('paras', 'Paras'),
      marker('dragonite', 'Dragonite', 100),
    ],
    pokedex: [{ id: 10, caught: true }],
    level: 20,
  });
  const socket = harness.captureSocket();

  assert.equal(await harness.api.start(), true);
  await harness.settle();
  const status = harness.api.status();
  assert.equal(status.currentGroup.slug, 'paras');
  assert.deepEqual(plain(status.queue.map((group) => group.slug)), ['paras', 'pidgey']);
  assert.deepEqual(plain(status.stats), {
    catchable: 4,
    caught: 1,
    accessible: 2,
    blocked: 1,
    withoutHunt: 1,
    skipped: 0,
  });
  assert.deepEqual(socket.sent, [{ type: 'enter-hunt', slug: 'paras' }]);
  assert.equal(harness.visualHuntSlug(), 'paras');
});

test('confirma a captura pela Pokédex antes de trocar de hunt e nunca envia catch', async () => {
  const harness = createHarness({
    creatures: [creature(46, 'Paras', 60), creature(16, 'Pidgey', 70)],
    markers: [marker('paras', 'Paras'), marker('pidgey', 'Pidgey')],
  });
  const socket = harness.captureSocket();
  await harness.api.start();
  await harness.settle();

  socket.emit('message', { type: 'catch-result', success: true, auto: true });
  await harness.tick(0);
  assert.deepEqual(sentTypes(socket), ['enter-hunt']);

  harness.setPokedex([{ id: 46, caught: true }]);
  socket.emit('message', { type: 'poke-delta', poke: { xp: 0 } });
  await harness.tick(2_500);
  assert.deepEqual(socket.sent, [
    { type: 'enter-hunt', slug: 'paras' },
    { type: 'enter-hunt', slug: 'pidgey' },
  ]);
  assert.equal(harness.visualHuntSlug(), 'pidgey');
  assert.equal(socket.sent.some((message) => message.type === 'catch'), false);
});

test('mantém hunt compartilhada até capturar todas as espécies dela', async () => {
  const harness = createHarness({
    creatures: [
      creature(9101, 'Nightmare Bagon', 100),
      creature(9102, 'Nightmare Shelgon', 120),
      creature(46, 'Paras', 200),
    ],
    markers: [
      marker('nightmare_bagon_e_shelgon', 'Nightmare Bagon e Shelgon', 50),
      marker('paras', 'Paras', 50),
    ],
    level: 50,
  });
  const socket = harness.captureSocket();
  await harness.api.start();
  await harness.settle();
  assert.deepEqual(plain(harness.api.status().currentGroup.targets.map((target) => target.id)), [9101, 9102]);

  harness.setPokedex([{ id: 9101, caught: true }]);
  socket.emit('message', { type: 'catch-result', success: true, auto: true });
  await harness.tick(0);
  assert.deepEqual(sentTypes(socket), ['enter-hunt']);
  assert.deepEqual(plain(harness.api.status().currentGroup.targets.map((target) => target.id)), [9102]);

  harness.setPokedex([{ id: 9101, caught: true }, { id: 9102, caught: true }]);
  socket.emit('message', { type: 'catch-result', success: true, auto: true });
  await harness.tick(0);
  assert.deepEqual(sentTypes(socket), ['enter-hunt', 'enter-hunt']);
  assert.equal(harness.api.status().currentGroup.slug, 'paras');
  assert.equal(harness.visualHuntSlug(), 'paras');
});

test('resolve o catálogo duplicado pelo huntLevel e usa o captureBase na Pokédex', async () => {
  const harness = createHarness({
    creatures: [
      creature(252, 'Treecko', 100, 20),
      creature(13252, 'Treecko', 500, 550, 0, 252),
    ],
    markers: [marker('treecko', 'Treecko', 520)],
    level: 600,
  });
  harness.captureSocket();

  await harness.api.start();
  await harness.settle();
  assert.equal(harness.api.status().currentGroup.targets[0].id, 252);
});

test('variantes de hunt usam captureBase e preferem a hunt normal de menor nível', async () => {
  const harness = createHarness({
    creatures: [
      creature(91, 'Cloyster', 10_200, 60),
      creature(10512, 'Evil Cloyster', 10_200, 150, 0, 91),
    ],
    markers: [
      marker('cloyster', 'Cloyster', 60),
      marker('evil_cloyster', 'Evil Cloyster', 150),
    ],
    level: 150,
  });
  harness.captureSocket();

  await harness.api.start();
  await harness.settle();
  const target = harness.api.status().currentGroup.targets[0];
  assert.equal(target.id, 91);
  assert.equal(target.name, 'Cloyster');
  assert.equal(harness.api.status().currentGroup.slug, 'cloyster');
});

test('captura da espécie base conclui uma hunt variante sem esperar o ID visual', async () => {
  const harness = createHarness({
    creatures: [
      creature(91, 'Cloyster', 10_200, 60),
      creature(10512, 'Evil Cloyster', 10_200, 150, 0, 91),
    ],
    markers: [marker('evil_cloyster', 'Evil Cloyster', 150)],
    level: 150,
  });
  const socket = harness.captureSocket();

  await harness.api.start();
  await harness.settle();
  assert.equal(harness.api.status().currentGroup.targets[0].id, 91);
  assert.equal(harness.api.status().currentGroup.targets[0].name, 'Cloyster');

  harness.setPokedex([{ id: 91, caught: true }]);
  socket.emit('message', {
    type: 'poke-delta',
    poke: { speciesId: 91, xp: 0 },
  });
  await harness.tick(0);
  assert.equal(harness.api.status().completed, true);
  assert.equal(harness.api.status().capturedThisRun.includes(91), true);
});

test('pausar e concluir não abandonam a hunt atual', async () => {
  const harness = createHarness({
    creatures: [creature(46, 'Paras', 60)],
    markers: [marker('paras', 'Paras')],
  });
  const socket = harness.captureSocket();
  await harness.api.start();
  await harness.settle();
  harness.api.pause();
  assert.deepEqual(sentTypes(socket), ['enter-hunt']);

  await harness.api.start();
  harness.setPokedex([{ id: 46, caught: true }]);
  socket.emit('message', { type: 'catch-result', success: true, auto: true });
  await harness.tick(0);
  const status = harness.api.status();
  assert.equal(status.running, false);
  assert.equal(status.completed, true);
  assert.deepEqual(sentTypes(socket), ['enter-hunt']);
});

test('pular remove o grupo da execução e segue para o próximo alvo', async () => {
  const harness = createHarness({
    creatures: [creature(46, 'Paras', 60), creature(16, 'Pidgey', 70)],
    markers: [marker('paras', 'Paras'), marker('pidgey', 'Pidgey')],
  });
  const socket = harness.captureSocket();
  await harness.api.start();
  await harness.settle();

  assert.equal(harness.api.skipCurrent(), true);
  await harness.settle();
  assert.deepEqual(sentTypes(socket), ['enter-hunt', 'enter-hunt']);
  assert.equal(harness.api.status().currentGroup.slug, 'pidgey');
  assert.equal(harness.visualHuntSlug(), 'pidgey');
  assert.deepEqual(plain(harness.api.status().skippedIds), [46]);
});

test('reentra no alvo depois de reconectar e uninstall remove somente seu subscriber', async () => {
  const harness = createHarness({
    creatures: [creature(46, 'Paras', 60)],
    markers: [marker('paras', 'Paras')],
  });
  const firstSocket = harness.captureSocket();
  await harness.api.start();
  await harness.settle();
  firstSocket.readyState = harness.context.WebSocket.CLOSED;
  firstSocket.emit('close');

  const secondSocket = harness.captureSocket();
  secondSocket.emit('open');
  await harness.settle();
  assert.deepEqual(secondSocket.sent, [{ type: 'enter-hunt', slug: 'paras' }]);

  harness.api.uninstall();
  assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 0);
  assert.deepEqual(sentTypes(secondSocket), ['enter-hunt']);
});

test('pausa sem enviar enter-hunt direto quando o marcador visual não existe', async () => {
  const harness = createHarness({
    creatures: [creature(46, 'Paras', 60)],
    markers: [marker('paras', 'Paras')],
    availableMarkerSlugs: [],
  });
  const socket = harness.captureSocket();

  assert.equal(await harness.api.start(), true);
  await harness.tick(3_500);
  assert.equal(harness.api.status().running, false);
  assert.match(harness.api.status().lastMessage, /localizar paras no mapa/i);
  assert.deepEqual(socket.sent, []);
  assert.equal(harness.visualHuntSlug(), null);
});

test('percorre as áreas do mapa até o marcador da hunt ser renderizado', async () => {
  const harness = createHarness({
    creatures: [creature(46, 'Paras', 60)],
    markers: [marker('paras', 'Paras')],
    markersVisibleAfterAreaClick: true,
  });
  const socket = harness.captureSocket();

  assert.equal(await harness.api.start(), true);
  await harness.tick(2_000);
  assert.equal(harness.api.status().running, true);
  assert.equal(harness.api.status().currentGroup.slug, 'paras');
  assert.equal(harness.visualHuntSlug(), 'paras');
  assert.deepEqual(socket.sent, [{ type: 'enter-hunt', slug: 'paras' }]);
});
