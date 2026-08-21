const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auto-reconnect.user.js'), 'utf8');

function createHarness(savedState = null, { beforeInstall = null } = {}) {
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const storage = new Map();
  if (savedState !== null) {
    storage.set(
      'piw_hunt_watchdog_v1',
      typeof savedState === 'string' ? savedState : JSON.stringify(savedState),
    );
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
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;

    constructor(url = 'wss://poke.idleworld.online/ws1') {
      this.url = url;
      this.readyState = FakeWebSocket.OPEN;
      this.sent = [];
      this.listeners = new Map();
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

  function setTimer(callback, delay, interval = false) {
    const normalizedDelay = Number(delay || 0);
    const id = nextTimerId++;
    timers.set(id, {
      callback,
      dueAt: now + normalizedDelay,
      intervalDelay: interval ? normalizedDelay : null,
    });
    return id;
  }

  const context = {
    console: { log() {}, warn() {} },
    Date: FakeDate,
    JSON,
    Map,
    MutationObserver: class {},
    Object,
    Set,
    String,
    WeakSet,
    WebSocket: FakeWebSocket,
    clearInterval(id) { timers.delete(id); },
    clearTimeout(id) { timers.delete(id); },
    document: {
      body: null,
      documentElement: null,
      querySelector() { return null; },
    },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
    },
    setInterval(callback, delay) { return setTimer(callback, delay, true); },
    setTimeout(callback, delay) { return setTimer(callback, delay, false); },
  };
  context.window = context;
  beforeInstall?.(context);
  vm.runInNewContext(source, context);

  async function tick(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const pending = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= target)
        .sort((a, b) => a[1].dueAt - b[1].dueAt || a[0] - b[0])[0];
      if (!pending) break;

      const [id, timer] = pending;
      if (timer.intervalDelay === null) {
        timers.delete(id);
      } else {
        timer.dueAt += timer.intervalDelay;
      }
      now = timer.dueAt - (timer.intervalDelay || 0);
      timer.callback();
      await Promise.resolve();
    }
    now = target;
    await Promise.resolve();
  }

  function captureSocket(url = 'wss://poke.idleworld.online/ws1') {
    return new context.WebSocket(url);
  }

  function reinject() {
    vm.runInContext(source, context);
  }

  return {
    api: context.piwHuntWatchdog,
    captureSocket,
    context,
    reinject,
    storage,
    tick,
  };
}

function installQolLikeWrapper(context, observedTypes) {
  const PreviousWebSocket = context.WebSocket;
  const previousSend = PreviousWebSocket.prototype.send;

  function TrackedWebSocket(url, protocols) {
    return protocols === undefined
      ? new PreviousWebSocket(url)
      : new PreviousWebSocket(url, protocols);
  }
  TrackedWebSocket.prototype = PreviousWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, PreviousWebSocket);
  context.WebSocket = TrackedWebSocket;
  PreviousWebSocket.prototype.send = function trackedSend(data) {
    observedTypes.push(JSON.parse(data)?.type || null);
    return previousSend.apply(this, arguments);
  };
}

test('usa um único subscriber persistente ao pausar, retomar e reinjetar', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;

  assert.equal(bridge.status().subscribers, 1);
  harness.api.stop();
  assert.equal(bridge.status().subscribers, 1);
  harness.api.start();
  assert.equal(bridge.status().subscribers, 1);
  harness.reinject();
  assert.equal(bridge.status().subscribers, 1);
});

test('acompanha enter-hunt pelo bridge e persiste o slug por aba', () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'ancient_pinsir' }));

  assert.equal(harness.api.status().huntSlug, 'ancient_pinsir');
  assert.equal(harness.api.status().huntActive, true);
  assert.equal(
    JSON.parse(harness.storage.get('piw_hunt_watchdog_v1')).huntSlug,
    'ancient_pinsir',
  );
});

test('recupera uma vez após 10 segundos de silêncio e reentra após 500 ms', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'route-1' }));
  socket.sent = [];

  await harness.tick(9_999);
  assert.deepEqual(socket.sent, []);
  await harness.tick(1);
  assert.deepEqual(socket.sent, [{ type: 'leave-hunt' }]);
  assert.equal(harness.api.status().transitioning, true);

  await harness.tick(500);
  assert.deepEqual(socket.sent, [
    { type: 'leave-hunt' },
    { type: 'enter-hunt', slug: 'route-1' },
  ]);
  assert.equal(harness.api.status().transitioning, false);
  assert.equal(harness.api.status().recoveries, 1);
});

test('mensagem de hunt reinicia a contagem de silêncio', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'route-2' }));
  socket.sent = [];

  await harness.tick(9_000);
  socket.emit('message', { type: 'pending', list: [] });
  await harness.tick(9_000);

  assert.deepEqual(socket.sent, []);
  assert.equal(harness.api.status().recoveries, 0);
});

test('saída manual desativa a hunt e não causa reentrada automática', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'route-3' }));
  socket.send(JSON.stringify({ type: 'leave-hunt' }));
  socket.sent = [];

  await harness.tick(20_000);
  assert.equal(harness.api.status().huntActive, false);
  assert.equal(harness.api.status().huntSlug, null);
  assert.equal(
    JSON.parse(harness.storage.get('piw_hunt_watchdog_v1')).huntSlug,
    null,
  );
  assert.deepEqual(socket.sent, []);
});

test('pausar preserva a hunt e retomar reativa o watchdog mesmo sem mensagens', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'stuck-route' }));
  socket.sent = [];

  harness.api.stop();
  await harness.tick(20_000);
  assert.equal(harness.api.status().huntActive, true);
  assert.deepEqual(socket.sent, []);

  harness.api.start();
  await harness.tick(10_500);
  assert.deepEqual(socket.sent, [
    { type: 'leave-hunt' },
    { type: 'enter-hunt', slug: 'stuck-route' },
  ]);
});

test('leave-hunt manual durante a pausa limpa o contexto antes de retomar', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'paused-route' }));
  harness.api.stop();
  socket.send(JSON.stringify({ type: 'leave-hunt' }));
  socket.sent = [];

  harness.api.start();
  await harness.tick(20_000);
  assert.equal(harness.api.status().huntActive, false);
  assert.equal(harness.api.status().huntSlug, null);
  assert.deepEqual(socket.sent, []);
});

test('Mega Sableye dispara uma única saída e reentrada', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'route-4' }));
  socket.sent = [];

  socket.emit('message', { type: 'field', mobs: [{ name: 'Mega Sableye' }] });
  socket.emit('message', { type: 'field', mobs: [{ name: 'Mega Sableye' }] });
  await harness.tick(500);

  assert.deepEqual(socket.sent, [
    { type: 'leave-hunt' },
    { type: 'enter-hunt', slug: 'route-4' },
  ]);
  assert.equal(harness.api.status().megaSableyeEscapes, 1);
});

test('permite desativar e reativar a fuga do Mega Sableye por aba', async () => {
  const harness = createHarness();
  const socket = harness.captureSocket();
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'route-toggle' }));
  socket.sent = [];

  harness.api.setMegaSableyeSkip(false);
  socket.emit('message', { type: 'field', mobs: [{ name: 'Mega Sableye' }] });
  await harness.tick(500);
  assert.deepEqual(socket.sent, []);
  assert.equal(harness.api.status().skipMegaSableye, false);
  assert.equal(
    JSON.parse(harness.storage.get('piw_hunt_watchdog_v1')).skipMegaSableye,
    false,
  );

  harness.api.setMegaSableyeSkip(true);
  socket.emit('message', { type: 'field', mobs: [{ name: 'Mega Sableye' }] });
  await harness.tick(500);
  assert.deepEqual(socket.sent, [
    { type: 'leave-hunt' },
    { type: 'enter-hunt', slug: 'route-toggle' },
  ]);
  assert.equal(harness.api.status().skipMegaSableye, true);
});

test('configuração antiga mantém a fuga do Mega Sableye ativada', () => {
  const harness = createHarness({ huntSlug: 'legacy-route' });
  assert.equal(harness.api.status().skipMegaSableye, true);
});

test('troca de socket ignora mensagens atrasadas do anterior', () => {
  const harness = createHarness({ huntSlug: 'saved-route' });
  const oldSocket = harness.captureSocket('wss://poke.idleworld.online/ws-old');
  const currentSocket = harness.captureSocket('wss://poke.idleworld.online/ws-current');

  oldSocket.emit('message', { type: 'field', mobs: [] });
  assert.equal(harness.api.status().huntActive, false);
  currentSocket.emit('message', { type: 'field', mobs: [] });
  assert.equal(harness.api.status().huntActive, true);

  currentSocket.emit('close');
  assert.equal(harness.api.status().socketOpen, false);
});

test('uninstall remove somente o subscriber do Auto Reconnect', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  assert.equal(bridge.status().subscribers, 1);

  harness.api.uninstall();
  assert.equal(bridge.status().subscribers, 0);
  assert.equal(harness.context.piwScripts.wsBridge, bridge);
  assert.equal(harness.context.piwHuntWatchdog, undefined);
});

test('não duplica recovery com wrapper externo antes ou depois do bundle', async () => {
  for (const wrapperOrder of ['before', 'after']) {
    const observedTypes = [];
    const harness = createHarness(null, {
      beforeInstall: wrapperOrder === 'before'
        ? (context) => installQolLikeWrapper(context, observedTypes)
        : null,
    });
    if (wrapperOrder === 'after') installQolLikeWrapper(harness.context, observedTypes);

    const socket = harness.captureSocket();
    socket.send(JSON.stringify({ type: 'enter-hunt', slug: `route-${wrapperOrder}` }));
    observedTypes.length = 0;
    socket.sent = [];
    await harness.tick(10_500);

    assert.deepEqual(
      socket.sent.map((message) => message.type),
      ['leave-hunt', 'enter-hunt'],
      wrapperOrder,
    );
    assert.deepEqual(observedTypes, ['leave-hunt', 'enter-hunt'], wrapperOrder);
    assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 1, wrapperOrder);
  }
});

test('storage inválido cai no estado seguro sem impedir a instalação', () => {
  const harness = createHarness('{invalid-json');
  assert.equal(harness.api.installed, true);
  assert.equal(harness.api.status().huntSlug, null);
  assert.equal(harness.api.status().huntActive, false);
});
