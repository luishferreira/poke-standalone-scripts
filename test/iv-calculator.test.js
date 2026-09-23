const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'iv-calculator.user.js'), 'utf8');

function createHarness({ creatures = [] } = {}) {
  let currentSocket = null;
  const requests = [];

  class FakeWebSocket {
    static OPEN = 1;

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

  const context = {
    console: { log() {}, warn() {} },
    document: {
      body: null,
      documentElement: null,
      readyState: 'loading',
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
    },
    fetch: async (url) => {
      requests.push(url);
      if (url !== '/game/creatures.json') throw new Error(`Request inesperada: ${url}`);
      return { ok: true, status: 200, json: async () => ({ creatures }) };
    },
    MutationObserver: class {},
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    setTimeout,
    clearTimeout,
    WebSocket: FakeWebSocket,
  };
  context.window = context;
  vm.runInNewContext(source, context);

  function captureSocket() {
    const socket = new context.WebSocket();
    socket.send(JSON.stringify({ type: 'bootstrap-test' }));
    socket.sent = [];
    return socket;
  }

  return { api: context.piwIvCalculator, captureSocket, currentSocket: () => currentSocket, requests };
}

function baseCreature(overrides = {}) {
  return {
    pokeId: 147,
    name: 'Dratini',
    baseHp: 41,
    baseAtk: 64,
    baseDef: 45,
    baseSpAtk: 50,
    baseSpDef: 50,
    baseSpeed: 50,
    ...overrides,
  };
}

function pokemonWithIvs({ ivs, level = 100, quality = 1, ...overrides }) {
  const base = baseCreature();
  const stat = (baseValue, iv, exponent) => (
    (level / 100) * Math.pow(quality, exponent) * (baseValue + 2 * iv)
  );
  return {
    speciesId: 147,
    name: 'Dratini',
    level,
    quality,
    team: true,
    slot: 0,
    stats: {
      hp: stat(base.baseHp, ivs.hp, 0.95),
      atk: stat(base.baseAtk, ivs.atk, 0.8),
      def: stat(base.baseDef, ivs.def, 0.8),
      spAtk: stat(base.baseSpAtk, ivs.spAtk, 0.8),
      spDef: stat(base.baseSpDef, ivs.spDef, 0.8),
      speed: stat(base.baseSpeed, ivs.speed, 0.95),
    },
    ...overrides,
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('calcula os seis IVs com expoentes próprios de HP e Speed', () => {
  const harness = createHarness();
  const expected = { hp: 32, atk: 27, def: 19, spAtk: 11, spDef: 3, speed: 25 };
  const pokemon = pokemonWithIvs({ ivs: expected, level: 57, quality: 2.35 });
  const result = harness.api.calculatePokemon(pokemon, [baseCreature()]);

  assert.deepEqual(plain(result.ivs), expected);
  assert.equal(result.total, 117);
  assert.equal(result.totalMax, 192);
  assert.ok(Math.abs(result.percent - 60.9375) < 1e-9);
});

test('preserva a primeira casa decimal dos IVs e do total', () => {
  const harness = createHarness();
  const expected = { hp: 31.7, atk: 26.4, def: 18.9, spAtk: 10.2, spDef: 3.5, speed: 24.6 };
  const pokemon = pokemonWithIvs({ ivs: expected, level: 43, quality: 1.87 });
  const result = harness.api.calculatePokemon(pokemon, [baseCreature()]);

  assert.deepEqual(plain(result.ivs), expected);
  assert.equal(result.total, 115.3);
});

test('limita cada IV à faixa de 0 a 32', () => {
  const harness = createHarness();
  const result = harness.api.calculateIndividualIVs(100, 1, {
    hp: 1_000,
    atk: 0,
    def: 1_000,
    spAtk: 0,
    spDef: 1_000,
    speed: 0,
  }, baseCreature());

  assert.deepEqual(plain(result), { hp: 32, atk: 0, def: 32, spAtk: 0, spDef: 32, speed: 0 });
});

test('considera somente a equipe e seleciona o líder ao atualizar', async () => {
  const creature = baseCreature();
  const ivs = { hp: 10, atk: 11, def: 12, spAtk: 13, spDef: 14, speed: 15 };
  const harness = createHarness({ creatures: [creature] });
  const socket = harness.captureSocket();
  const refresh = harness.api.refresh();

  assert.deepEqual(socket.sent, [{ type: 'pokes-get' }]);
  socket.emit('message', {
    type: 'pokes',
    list: [
      pokemonWithIvs({ ivs, slot: 0 }),
      pokemonWithIvs({ ivs, slot: 1, leader: true, name: 'Shiny Dratini' }),
      pokemonWithIvs({ ivs, team: false, slot: null, name: 'Dratini guardado' }),
    ],
  });

  assert.equal(await refresh, true);
  assert.deepEqual(harness.requests, ['/game/creatures.json']);
  const status = harness.api.status();
  assert.equal(status.teamSize, 2);
  assert.equal(status.selectedIndex, 1);
  assert.equal(status.selected.pokemon.name, 'Shiny Dratini');
  assert.deepEqual(socket.sent, [{ type: 'pokes-get' }]);
});

test('troca a seleção sem fazer uma nova request', async () => {
  const creature = baseCreature();
  const harness = createHarness({ creatures: [creature] });
  const socket = harness.captureSocket();
  const refresh = harness.api.refresh();
  socket.emit('message', {
    type: 'pokes',
    list: [
      pokemonWithIvs({ ivs: { hp: 1, atk: 2, def: 3, spAtk: 4, spDef: 5, speed: 6 }, leader: true }),
      pokemonWithIvs({ ivs: { hp: 31, atk: 30, def: 29, spAtk: 28, spDef: 27, speed: 26 }, slot: 1 }),
    ],
  });
  await refresh;

  assert.equal(harness.api.select(1), true);
  assert.equal(harness.api.status().selected.ivs.hp, 31);
  assert.deepEqual(socket.sent, [{ type: 'pokes-get' }]);
  assert.deepEqual(harness.requests, ['/game/creatures.json']);
});

test('falha de forma clara quando faltam quality ou atributos', () => {
  const harness = createHarness();
  assert.throws(() => harness.api.calculatePokemon({
    speciesId: 147,
    name: 'Dratini',
    level: 20,
    quality: 0,
    stats: {},
  }, [baseCreature()]), /Dados de IV incompletos/);
});
