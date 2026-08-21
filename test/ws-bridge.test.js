const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'shared', 'ws-bridge.js'),
  'utf8',
);

function createHarness({ install = true } = {}) {
  const warnings = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url, protocols) {
      this.url = url;
      this.protocols = protocols;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.listeners = new Map();
      this.sendError = null;
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

    send(data) {
      if (this.sendError) throw this.sendError;
      this.sent.push(data);
    }

    emit(type, details = {}) {
      if (type === 'open') this.readyState = FakeWebSocket.OPEN;
      if (type === 'close') this.readyState = FakeWebSocket.CLOSED;
      const event = { type, ...details };
      for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
    }
  }

  const context = {
    console: {
      log() {},
      warn(...args) { warnings.push(args); },
    },
    Date,
    JSON,
    Map,
    Object,
    String,
    WebSocket: FakeWebSocket,
  };
  context.window = context;
  vm.createContext(context);
  if (install) vm.runInContext(source, context);

  return {
    BaseWebSocket: FakeWebSocket,
    context,
    installBridge() { vm.runInContext(source, context); },
    warnings,
  };
}

function installQolLikeWrapper(context, counters) {
  const PreviousWebSocket = context.WebSocket;
  const previousSend = PreviousWebSocket.prototype.send;

  function TrackedWebSocket(url, protocols) {
    counters.constructed += 1;
    return protocols === undefined
      ? new PreviousWebSocket(url)
      : new PreviousWebSocket(url, protocols);
  }
  TrackedWebSocket.prototype = PreviousWebSocket.prototype;
  Object.setPrototypeOf(TrackedWebSocket, PreviousWebSocket);
  context.WebSocket = TrackedWebSocket;
  PreviousWebSocket.prototype.send = function trackedSend(data) {
    counters.sent += 1;
    return previousSend.call(this, data);
  };

  return { PreviousWebSocket, TrackedWebSocket };
}

test('instala de forma passiva e reutiliza o singleton por aba', () => {
  const harness = createHarness();
  const firstBridge = harness.context.piwScripts.wsBridge;
  const firstConstructor = harness.context.WebSocket;

  assert.equal(firstBridge.apiVersion, 1);
  assert.equal(firstBridge.getSocket(), null);
  assert.equal(firstBridge.status().trackedSockets, 0);

  harness.installBridge();
  assert.equal(harness.context.piwScripts.wsBridge, firstBridge);
  assert.equal(harness.context.WebSocket, firstConstructor);
  assert.equal(harness.warnings.length, 0);
});

test('publica lifecycle e frames parseados sem alterar o envio', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  const events = [];
  bridge.subscribe((event) => events.push(event));

  const socket = new harness.context.WebSocket('wss://poke.idleworld.online/ws1');
  socket.emit('open');
  socket.send(JSON.stringify({ type: 'enter-hunt', slug: 'route-1' }));
  socket.emit('message', { data: JSON.stringify({ type: 'field', hp: 10 }) });
  socket.emit('message', { data: 'not-json' });
  socket.emit('close', { code: 1000 });

  assert.deepEqual(events.map((event) => event.type), [
    'socket',
    'open',
    'outgoing',
    'incoming',
    'incoming',
    'close',
  ]);
  assert.equal(events[2].message.type, 'enter-hunt');
  assert.equal(events[3].message.type, 'field');
  assert.equal(events[4].message, null);
  assert.deepEqual(socket.sent, [JSON.stringify({ type: 'enter-hunt', slug: 'route-1' })]);
  assert.equal(bridge.getSocket(), null);
  assert.equal(bridge.status().trackedSockets, 0);
});

test('ignora sockets alheios ao jogo', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  const events = [];
  bridge.subscribe((event) => events.push(event));

  const socket = new harness.context.WebSocket('wss://example.com/events');
  socket.emit('open');
  socket.send('hello');
  socket.emit('message', { data: 'world' });

  assert.deepEqual(events, []);
  assert.equal(bridge.getSocket(), null);
  assert.deepEqual(socket.sent, ['hello']);
});

test('troca o socket atual e ignora mensagens atrasadas do anterior', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  const events = [];
  bridge.subscribe((event) => events.push(event));

  const oldSocket = new harness.context.WebSocket('wss://poke.idleworld.online/ws-old');
  const currentSocket = new harness.context.WebSocket('wss://poke.idleworld.online/ws-new');
  oldSocket.send(JSON.stringify({ type: 'stale-outgoing' }));
  oldSocket.emit('message', { data: JSON.stringify({ type: 'stale' }) });
  currentSocket.emit('message', { data: JSON.stringify({ type: 'current' }) });

  assert.equal(bridge.getSocket(), currentSocket);
  assert.equal(bridge.status().trackedSockets, 1);
  assert.deepEqual(
    events.filter((event) => event.type === 'incoming').map((event) => event.message.type),
    ['current'],
  );
  assert.deepEqual(events.filter((event) => event.type === 'outgoing'), []);
  const replacement = events.find((event) => event.type === 'replaced');
  assert.equal(replacement.previousSocket, oldSocket);
  assert.equal(replacement.socket, currentSocket);
});

test('send e sendJson usam o socket atual e preservam a observação de saída', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  const outgoing = [];
  bridge.subscribe({ outgoing: (event) => outgoing.push(event) });

  assert.equal(bridge.send('before-open'), false);
  const socket = new harness.context.WebSocket('wss://poke.idleworld.online/ws1');
  assert.equal(bridge.send('still-connecting'), false);
  socket.emit('open');

  const detachedSend = bridge.send;
  const detachedSendJson = bridge.sendJson;
  assert.equal(detachedSend('raw-data'), true);
  assert.equal(detachedSendJson({ type: 'balls-get' }), true);

  assert.deepEqual(socket.sent, ['raw-data', JSON.stringify({ type: 'balls-get' })]);
  assert.equal(outgoing.length, 2);
  assert.equal(outgoing[0].message, null);
  assert.equal(outgoing[1].message.type, 'balls-get');
});

test('isola falhas de subscribers e cleanup é idempotente', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  let received = 0;
  bridge.subscribe(() => { throw new Error('subscriber failure'); });
  const unsubscribe = bridge.subscribe({ incoming: () => { received += 1; } });
  const socket = new harness.context.WebSocket('wss://poke.idleworld.online/ws1');

  socket.emit('message', { data: JSON.stringify({ type: 'field' }) });
  assert.equal(received, 1);
  assert.equal(harness.warnings.length, 2);
  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  socket.emit('message', { data: JSON.stringify({ type: 'field' }) });
  assert.equal(received, 1);
});

test('convive com wrapper instalado antes do bridge', () => {
  const harness = createHarness({ install: false });
  const counters = { constructed: 0, sent: 0 };
  installQolLikeWrapper(harness.context, counters);
  harness.installBridge();

  const bridge = harness.context.piwScripts.wsBridge;
  let outgoing = 0;
  bridge.subscribe({ outgoing: () => { outgoing += 1; } });
  const socket = new harness.context.WebSocket('wss://poke.idleworld.online/ws1');
  socket.emit('open');
  socket.send('payload');

  assert.equal(counters.constructed, 1);
  assert.equal(counters.sent, 1);
  assert.equal(outgoing, 1);
  assert.deepEqual(socket.sent, ['payload']);
});

test('convive com wrapper instalado depois e não o remove no uninstall', () => {
  const harness = createHarness();
  const bridge = harness.context.piwScripts.wsBridge;
  const counters = { constructed: 0, sent: 0 };
  const { TrackedWebSocket } = installQolLikeWrapper(harness.context, counters);

  let outgoing = 0;
  bridge.subscribe({ outgoing: () => { outgoing += 1; } });
  const socket = new harness.context.WebSocket('wss://poke.idleworld.online/ws1');
  socket.emit('open');
  socket.send('payload');

  assert.equal(counters.constructed, 1);
  assert.equal(counters.sent, 1);
  assert.equal(outgoing, 1);
  assert.equal(bridge.uninstall(), true);
  assert.equal(bridge.uninstall(), false);
  assert.equal(harness.context.WebSocket, TrackedWebSocket);
  assert.equal(harness.context.piwScripts.wsBridge, undefined);

  const laterSocket = new harness.context.WebSocket('wss://poke.idleworld.online/ws2');
  laterSocket.send('after-uninstall');
  assert.equal(counters.constructed, 2);
  assert.equal(counters.sent, 2);
  assert.deepEqual(laterSocket.sent, ['after-uninstall']);
});

test('adota o myGameSocket legado existente sem enviar mensagens', () => {
  const harness = createHarness({ install: false });
  const socket = new harness.BaseWebSocket('wss://poke.idleworld.online/ws-existing');
  socket.readyState = harness.BaseWebSocket.OPEN;
  harness.context.myGameSocket = socket;
  harness.installBridge();

  const bridge = harness.context.piwScripts.wsBridge;
  assert.equal(bridge.getSocket(), socket);
  assert.equal(bridge.isOpen(), true);
  assert.deepEqual(socket.sent, []);
});
