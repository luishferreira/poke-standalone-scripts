const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'hunt-recommender.user.js'), 'utf8');

function creature({
  pokeId,
  name,
  type1,
  type2 = null,
  baseHp = 60,
  baseAtk = 60,
  baseDef = 60,
  baseSpAtk = 60,
  baseSpDef = 60,
  experience = 100,
  attacks = [],
}) {
  return {
    pokeId,
    name,
    type1,
    type2,
    baseHp,
    baseAtk,
    baseDef,
    baseSpAtk,
    baseSpDef,
    experience,
    attacks,
  };
}

function move(name, power, type, category = 'SPECIAL', learnLevel = 1, tm = null) {
  return { name, power, type, category, learnLevel, ...(tm ? { tm } : {}) };
}

function marker(slug, name, level, area = 'kanto', range = [0, 0, 49, 49, 7]) {
  return { slug, name, level, area, range };
}

function createHarness({ creatures = [], markers = [], character = { level: 100 } } = {}) {
  let currentSocket = null;
  const storage = new Map();
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
      let data;
      if (url === '/game/creatures.json') data = { creatures };
      else if (url === '/api/game/map-markers') data = { hunts: markers };
      else if (url === '/api/characters/me') data = { character };
      else throw new Error(`Request inesperada: ${url}`);
      return { ok: true, status: 200, json: async () => data };
    },
    MutationObserver: class {},
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    setInterval,
    clearInterval,
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

  return {
    api: context.piwHuntRecommender,
    captureSocket,
    context,
    currentSocket: () => currentSocket,
    requests,
  };
}

function fixtures() {
  const leaderSpecies = creature({
    pokeId: 1,
    name: 'Flaremon',
    type1: 'FIRE',
    baseSpAtk: 90,
    attacks: [
      move('Ember', 40, 'FIRE'),
      move('Scratch', 50, 'NORMAL', 'PHYSICAL'),
      move('Future Flame', 200, 'FIRE', 'SPECIAL', 200),
      move('TM Blast', 600, 'FIRE', 'SPECIAL', 1, 'FIRE'),
    ],
  });
  const grass = creature({
    pokeId: 2,
    name: 'Leafling',
    type1: 'GRASS',
    experience: 200,
    attacks: [move('Tackle', 40, 'NORMAL', 'PHYSICAL')],
  });
  const water = creature({
    pokeId: 3,
    name: 'Aquabeast',
    type1: 'WATER',
    baseHp: 120,
    experience: 400,
    attacks: [move('Water Pulse', 60, 'WATER')],
  });
  const orre = creature({
    pokeId: 4,
    name: 'Orre Beast',
    type1: 'GROUND',
    experience: 10_000,
    attacks: [move('Tackle', 40, 'NORMAL', 'PHYSICAL')],
  });
  return {
    creatures: [leaderSpecies, grass, water, orre],
    markers: [
      marker('leafling', 'Leafling', 20),
      marker('aquabeast', 'Aquabeast', 80),
      marker('locked', 'Aquabeast', 120),
      marker('orre_beast', 'Orre Beast', 80, 'orre'),
    ],
    leader: {
      speciesId: 1,
      name: 'Flaremon',
      level: 100,
      leader: true,
      maxHp: 1_000,
      stats: { hp: 1_000, atk: 100, def: 100, spAtk: 150, spDef: 100, speed: 80 },
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('calcula somente hunts acessíveis de Kanto e Outland e ignora TM e golpe bloqueado', () => {
  const data = fixtures();
  const harness = createHarness();
  const result = harness.api.calculate({
    leader: data.leader,
    profile: { character: { level: 100 } },
    creatures: data.creatures,
    markers: data.markers,
  });

  assert.deepEqual(plain(result.recommendations.map((entry) => entry.slug).sort()), ['aquabeast', 'leafling']);
  const leafling = result.recommendations.find((entry) => entry.slug === 'leafling');
  assert.equal(leafling.attack, 'Ember');
  assert.equal(leafling.effectiveness, 2.5);
  assert.ok(leafling.hits >= 1);
  assert.ok(leafling.kosPerHour > 0);
  assert.ok(leafling.xpPerHour > 0);
});

test('aplica bônus de clã rank 5 aos atributos do Pokémon elegível', () => {
  const data = fixtures();
  const harness = createHarness();
  const withoutClan = harness.api.calculate({
    leader: data.leader,
    profile: { character: { level: 100 } },
    creatures: data.creatures,
    markers: data.markers,
  });
  const withClan = harness.api.calculate({
    leader: data.leader,
    profile: { character: { level: 100, clan: 'Volcanic', clanRank: 5 } },
    creatures: data.creatures,
    markers: data.markers,
  });
  const baseDamage = withoutClan.recommendations.find((entry) => entry.slug === 'leafling').damagePerHit;
  const clanDamage = withClan.recommendations.find((entry) => entry.slug === 'leafling').damagePerHit;

  assert.ok(Math.abs(clanDamage / baseDamage - 1.3) < 1e-9);
  assert.equal(withClan.clanMultiplier, 1.3);
});

test('análise solicita pokes-get, usa respostas oficiais e permanece somente leitura', async () => {
  const data = fixtures();
  const harness = createHarness({
    creatures: data.creatures,
    markers: data.markers,
    character: { level: 100 },
  });
  const socket = harness.captureSocket();
  const analysis = harness.api.analyze();

  assert.deepEqual(socket.sent, [{ type: 'pokes-get' }]);
  socket.emit('message', { type: 'pokes', list: [data.leader] });
  assert.equal(await analysis, true);
  assert.deepEqual(socket.sent, [{ type: 'pokes-get' }]);
  assert.deepEqual(harness.requests.sort(), [
    '/api/characters/me',
    '/api/game/map-markers',
    '/game/creatures.json',
  ].sort());
  assert.equal(harness.api.status().results.length, 2);
});

test('recusa Ditto nesta primeira versão', () => {
  const ditto = creature({
    pokeId: 132,
    name: 'Ditto',
    type1: 'NORMAL',
    attacks: [move('Transform Hit', 40, 'NORMAL', 'PHYSICAL')],
  });
  const harness = createHarness();

  assert.throws(() => harness.api.calculate({
    leader: {
      speciesId: 132,
      name: 'Ditto',
      level: 100,
      stats: { hp: 100, atk: 100, def: 100, spAtk: 100, spDef: 100, speed: 100 },
    },
    profile: { character: { level: 100 } },
    creatures: [ditto],
    markers: [],
  }), /Ditto/);
});
