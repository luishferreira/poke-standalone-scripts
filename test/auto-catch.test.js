const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auto-catch.user.js'), 'utf8');

function createHarness(savedSettings = null, { beforeInstall = null } = {}) {
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const storage = new Map();
  if (savedSettings) {
    storage.set('piw-auto-catch-settings-v1', JSON.stringify(savedSettings));
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
      this.sent = [];
      this.listeners = new Map();
      this.sendError = null;
    }

    send(data) {
      if (this.sendError) throw this.sendError;
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

  const fakeMath = Object.create(Math);
  fakeMath.random = () => 0;
  const setTimer = (callback, delay) => {
    const id = nextTimerId++;
    timers.set(id, { callback, dueAt: now + Number(delay || 0) });
    return id;
  };

  const context = {
    console: { log() {}, warn() {} },
    Date: FakeDate,
    JSON,
    Map,
    Math: fakeMath,
    MutationObserver: class {},
    Number,
    Set,
    String,
    WeakSet,
    WebSocket: FakeWebSocket,
    clearTimeout(id) { timers.delete(id); },
    document: {
      body: null,
      documentElement: null,
      addEventListener() {},
      querySelector() { return null; }
    },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); }
    },
    setTimeout(callback, delay) { return setTimer(callback, delay); }
  };
  context.window = context;
  beforeInstall?.(context);
  vm.runInNewContext(source, context);

  function tick(milliseconds) {
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
    }
    now = target;
  }

  function captureSocket(url) {
    const socket = new FakeWebSocket(url);
    socket.send(JSON.stringify({ type: 'bootstrap-test' }));
    socket.sent = [];
    return socket;
  }

  function reinject() {
    vm.runInContext(source, context);
  }

  return { api: context.piwAutoCatch, captureSocket, context, reinject, storage, tick };
}

function catches(socket) {
  return socket.sent.filter(message => message.type === 'catch');
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
    try {
      observedTypes.push(JSON.parse(data)?.type || null);
    } catch {
      observedTypes.push(null);
    }
    return previousSend.apply(this, arguments);
  };
}

test('usa estoques e seletores separados para normal e shiny', () => {
  const normalHarness = createHarness({ enabled: true, normalBallId: 2, shinyBallId: 6 });
  const normalSocket = normalHarness.captureSocket();
  normalSocket.emit('message', { type: 'balls', counts: { 2: 1, 6: 1 } });
  normalSocket.emit('message', { type: 'pending', list: [{ id: 'normal', shiny: false }] });
  assert.deepEqual(catches(normalSocket), [{ type: 'catch', pendingId: 'normal', ballId: 2 }]);

  const shinyHarness = createHarness({ enabled: true, normalBallId: 2, shinyBallId: 6 });
  const shinySocket = shinyHarness.captureSocket();
  shinySocket.emit('message', { type: 'balls', counts: { 2: 1, 6: 1 } });
  shinySocket.emit('message', { type: 'pending', list: [{ id: 'shiny', shiny: true }] });
  assert.deepEqual(catches(shinySocket), [{ type: 'catch', pendingId: 'shiny', ballId: 6 }]);
});

test('Auto Catch usa um único subscriber persistente do bridge', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const bridge = harness.context.piwScripts.wsBridge;
  const socket = harness.captureSocket();

  assert.equal(bridge.apiVersion, 1);
  assert.equal(bridge.getSocket(), socket);
  assert.equal(bridge.status().subscribers, 1);

  harness.api.stop();
  assert.equal(bridge.status().subscribers, 1);
  harness.api.start();
  assert.equal(bridge.status().subscribers, 1);

  socket.emit('message', { type: 'balls', counts: { 4: 1 } });
  socket.emit('message', { type: 'pending', list: [{ id: 'bridge-canary', shiny: false }] });
  assert.deepEqual(catches(socket), [
    { type: 'catch', pendingId: 'bridge-canary', ballId: 4 }
  ]);
});

test('falha de envio não consome nem marca o pendingId', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 5 } });
  socket.sendError = new Error('send failed');
  socket.emit('message', { type: 'pending', list: [{ id: 'not-sent', shiny: false }] });

  assert.equal(harness.api.status().attempted, 0);
  assert.equal(harness.api.status().inFlight, null);
  assert.equal(harness.api.status().sent, 0);
});

test('close do bridge limpa socket, estoque e captura em voo', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 5 } });
  socket.emit('message', { type: 'pending', list: [{ id: 'in-flight', shiny: false }] });
  assert.equal(harness.api.status().inFlight.pendingId, 'in-flight');

  socket.emit('close');
  assert.equal(harness.api.status().socketOpen, false);
  assert.equal(harness.api.status().stockKnown, false);
  assert.equal(harness.api.status().inFlight, null);
});

test('uninstall remove apenas o subscriber do Auto Catch', () => {
  const harness = createHarness({ enabled: false, normalBallId: 4, shinyBallId: 6 });
  const bridge = harness.context.piwScripts.wsBridge;
  const socket = harness.captureSocket();
  assert.equal(bridge.status().subscribers, 1);

  harness.api.uninstall();
  assert.equal(bridge.status().subscribers, 0);
  assert.equal(harness.context.piwScripts.wsBridge, bridge);
  assert.equal(harness.context.piwAutoCatch, undefined);

  let outgoing = 0;
  const unsubscribe = bridge.subscribe({ outgoing: () => { outgoing += 1; } });
  socket.send(JSON.stringify({ type: 'after-uninstall' }));
  assert.equal(outgoing, 1);
  unsubscribe();
});

test('reinjeção não cria um segundo subscriber', () => {
  const harness = createHarness({ enabled: false, normalBallId: 4, shinyBallId: 6 });
  const bridge = harness.context.piwScripts.wsBridge;
  assert.equal(bridge.status().subscribers, 1);
  harness.reinject();
  assert.equal(bridge.status().subscribers, 1);
});

test('não duplica catch com wrapper externo antes ou depois do bundle', () => {
  for (const wrapperOrder of ['before', 'after']) {
    const observedTypes = [];
    const harness = createHarness(
      { enabled: true, normalBallId: 4, shinyBallId: 6 },
      {
        beforeInstall: wrapperOrder === 'before'
          ? (context) => installQolLikeWrapper(context, observedTypes)
          : null,
      },
    );
    if (wrapperOrder === 'after') installQolLikeWrapper(harness.context, observedTypes);

    const socket = harness.captureSocket();
    socket.emit('message', { type: 'balls', counts: { 4: 1 } });
    socket.emit('message', { type: 'pending', list: [{ id: `catch-${wrapperOrder}`, shiny: false }] });

    assert.equal(catches(socket).length, 1, wrapperOrder);
    assert.equal(observedTypes.filter((type) => type === 'catch').length, 1, wrapperOrder);
    assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 1, wrapperOrder);
  }
});

test('não tenta alvo sem estoque e não faz fallback automático', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 0, 6: 0 } });
  socket.emit('message', { type: 'pending', list: [{ id: 'normal', shiny: false }] });

  assert.deepEqual(catches(socket), []);
  assert.match(harness.api.status().blockingMessage, /Ultra Ball/);

  socket.emit('message', { type: 'balls', counts: { 4: 1, 6: 0 } });
  assert.deepEqual(catches(socket), [{ type: 'catch', pendingId: 'normal', ballId: 4 }]);
});

test('alvo com estoque pode passar à frente de categoria sem estoque', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 0, 6: 1 } });
  socket.emit('message', {
    type: 'pending',
    list: [
      { id: 'normal-sem-ball', shiny: false },
      { id: 'shiny-com-ball', shiny: true }
    ]
  });

  assert.deepEqual(catches(socket), [
    { type: 'catch', pendingId: 'shiny-com-ball', ballId: 6 }
  ]);
});

test('cada pendingId é enviado no máximo uma vez mesmo após falha', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 5 } });
  socket.emit('message', { type: 'pending', list: [{ id: 'same-id', shiny: false }] });
  socket.emit('message', {
    type: 'catch-result',
    pendingId: 'same-id',
    success: false
  });
  socket.emit('message', { type: 'pending', list: [{ id: 'same-id', shiny: false }] });
  harness.tick(10_000);

  assert.equal(catches(socket).length, 1);
  assert.equal(harness.api.status().attempted, 1);
  assert.equal(harness.api.status().failures, 1);
});

test('estoque estimado é reduzido e impede segundo envio com a última ball', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 1 } });
  socket.emit('message', { type: 'pending', list: [{ id: 'first', shiny: false }] });
  socket.emit('message', { type: 'catch-result', pendingId: 'first', success: true });
  socket.emit('message', { type: 'pending', list: [{ id: 'second', shiny: false }] });
  harness.tick(10_000);

  assert.equal(catches(socket).length, 1);
  assert.equal(harness.api.status().normalBallStock, 0);
});

test('autohelper VIP bloqueia captura manual e avisa até ser desativado', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 5, 6: 5 } });
  socket.emit('message', { type: 'autohelper', autoCatch: true, autoCatchShiny: false });
  socket.emit('message', { type: 'pending', list: [{ id: 'blocked', shiny: false }] });

  assert.deepEqual(catches(socket), []);
  assert.equal(harness.api.status().vipAutoCatchDetected, true);
  assert.match(harness.api.status().blockingMessage, /VIP/);

  socket.emit('message', { type: 'autohelper', autoCatch: false, autoCatchShiny: false });
  assert.deepEqual(catches(socket), [{ type: 'catch', pendingId: 'blocked', ballId: 4 }]);
});

test('catch-result auto bloqueia VIP sem liberar captura manual em voo', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const socket = harness.captureSocket();
  socket.emit('message', { type: 'balls', counts: { 4: 5 } });
  socket.emit('message', { type: 'pending', list: [{ id: 'manual', shiny: false }] });
  socket.emit('message', { type: 'catch-result', auto: true, success: true });

  assert.equal(harness.api.status().vipAutoCatchDetected, true);
  assert.equal(harness.api.status().inFlight.pendingId, 'manual');
  assert.equal(harness.api.status().successes, 0);

  socket.emit('message', { type: 'catch-result', pendingId: 'manual', success: true });
  assert.equal(harness.api.status().inFlight, null);
  assert.equal(harness.api.status().successes, 1);
});

test('ignora mensagens atrasadas do socket substituído', () => {
  const harness = createHarness({ enabled: true, normalBallId: 4, shinyBallId: 6 });
  const oldSocket = harness.captureSocket();
  const currentSocket = harness.captureSocket();

  oldSocket.emit('message', { type: 'balls', counts: { 4: 5 } });
  oldSocket.emit('message', { type: 'pending', list: [{ id: 'stale', shiny: false }] });
  assert.deepEqual(catches(oldSocket), []);
  assert.equal(harness.api.status().stockKnown, false);

  currentSocket.emit('message', { type: 'balls', counts: { 4: 1 } });
  currentSocket.emit('message', { type: 'pending', list: [{ id: 'current', shiny: false }] });
  assert.deepEqual(catches(currentSocket), [
    { type: 'catch', pendingId: 'current', ballId: 4 }
  ]);
});

test('configuração antiga ballId continua migrando para bola normal', () => {
  const harness = createHarness({ enabled: false, ballId: 3 });
  const status = harness.api.status();
  assert.equal(status.normalBallId, 3);
  assert.equal(status.shinyBallId, 6);
});
