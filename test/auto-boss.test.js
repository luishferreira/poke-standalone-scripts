const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auto-boss.user.js'), 'utf8');

function createHarness(savedState = null) {
    let now = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const storage = new Map();
    if (savedState) storage.set('piw_boss_farm_v1', JSON.stringify(savedState));

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
            this.listeners.set(type, handlers.filter(item => item !== handler));
        }

        emit(type, payload = null) {
            const event = type === 'message' ? { data: JSON.stringify(payload) } : {};
            for (const handler of [...(this.listeners.get(type) || [])]) handler(event);
        }
    }

    const setTimer = (callback, delay, interval) => {
        const id = nextTimerId++;
        timers.set(id, { callback, dueAt: now + Number(delay || 0), interval });
        return id;
    };

    const context = {
        console: { log() {}, warn() {} },
        Date: FakeDate,
        JSON,
        Map,
        Math,
        MutationObserver: class {},
        Number,
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
            querySelector() { return null; }
        },
        sessionStorage: {
            getItem(key) { return storage.get(key) ?? null; },
            setItem(key, value) { storage.set(key, String(value)); }
        },
        setInterval(callback, delay) { return setTimer(callback, delay, Number(delay)); },
        setTimeout(callback, delay) { return setTimer(callback, delay, 0); }
    };
    context.window = context;
    vm.runInNewContext(source, context);

    function tick(milliseconds) {
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

    return { api: context.piwBossFarm, captureSocket, context, storage, tick };
}

function sentTypes(socket) {
    return socket.sent.map(message => message.type);
}

test('ignora fainted individual e finaliza vitória com leave, heal e nova entrada', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    assert.equal(harness.api.start(), true);

    socket.emit('message', { type: 'field', fainted: true, mobs: [{ hp: 50, maxHp: 100 }] });
    assert.deepEqual(sentTypes(socket), ['enter-hunt']);

    socket.emit('message', {
        type: 'field',
        bossOutcome: 'won',
        bossLoot: [{ qty: 2, name: '<Rare Candy>' }]
    });
    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt']);
    harness.tick(1500);
    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal']);
    harness.tick(1500);
    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal', 'enter-hunt']);
    assert.equal(harness.api.status().wins, 1);
    assert.equal(harness.api.status().losses, 0);
    assert.match(harness.api.status().lootHistory[0], /<Rare Candy>/);
});

test('qualquer bossOutcome diferente de won conta derrota e também cura', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    harness.api.start();
    socket.emit('message', { type: 'field', bossOutcome: 'lost' });
    harness.tick(3000);

    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal', 'enter-hunt']);
    assert.equal(harness.api.status().wins, 0);
    assert.equal(harness.api.status().losses, 1);
});

test('parada agendada espera resultado, cura e não reentra', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    harness.api.start();
    harness.api.stop();
    socket.emit('message', { type: 'field', bossOutcome: 'won', bossLoot: [] });
    harness.tick(3000);

    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal']);
    assert.equal(harness.api.status().running, false);
    assert.equal(harness.api.status().stopping, false);
});

test('parada forçada interrompe somente a automação e não abandona a luta', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    harness.api.start();
    harness.api.stop();
    harness.api.stop();
    socket.emit('message', { type: 'field', bossOutcome: 'won' });
    harness.tick(5000);

    assert.deepEqual(sentTypes(socket), ['enter-hunt']);
    assert.equal(harness.api.status().running, false);
});

test('parada forçada durante limpeza conclui cura mas bloqueia reentrada', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    harness.api.start();
    socket.emit('message', { type: 'field', bossOutcome: 'won' });
    harness.api.stop();
    harness.api.stop();
    harness.tick(3000);

    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal']);
    assert.equal(harness.api.status().running, false);
    assert.equal(harness.api.status().transitioning, false);
});

test('socket substituto pausa sem iniciar outro boss automaticamente', () => {
    const harness = createHarness();
    const firstSocket = harness.captureSocket('wss://poke.idleworld.online/ws1');
    harness.api.start();
    const secondSocket = harness.captureSocket('wss://poke.idleworld.online/ws2');

    firstSocket.emit('message', { type: 'field', bossOutcome: 'won' });
    harness.tick(5000);
    assert.equal(harness.api.status().running, false);
    assert.equal(harness.api.status().socketOpen, true);
    assert.deepEqual(sentTypes(secondSocket), []);
});

test('não inicia com socket fechado', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    socket.readyState = harness.context.WebSocket.CLOSED;

    assert.equal(harness.api.start(), false);
    assert.equal(harness.api.status().running, false);
    assert.deepEqual(sentTypes(socket), []);
});

test('socket fechado durante limpeza cancela cura e reentrada', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    harness.api.start();
    socket.emit('message', { type: 'field', bossOutcome: 'won' });
    socket.readyState = harness.context.WebSocket.CLOSED;
    socket.emit('close');
    harness.tick(5000);

    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt']);
    assert.equal(harness.api.status().running, false);
    assert.equal(harness.api.status().transitioning, false);
});

test('watchdog ignora tráfego não field e pausa sem enviar ações', () => {
    const harness = createHarness();
    const socket = harness.captureSocket();
    harness.api.start();
    socket.emit('message', { type: 'chat', message: 'socket vivo' });
    harness.tick(50000);

    assert.equal(harness.api.status().running, false);
    assert.deepEqual(sentTypes(socket), ['enter-hunt']);
});

test('estado inválido do sessionStorage é normalizado', () => {
    const harness = createHarness({
        slug: '  ',
        wins: -10,
        losses: '3.8',
        lootHistory: ['ok', null, 12]
    });
    const status = harness.api.status();
    assert.equal(status.slug, 'cruel_boss');
    assert.equal(status.wins, 0);
    assert.equal(status.losses, 3);
    assert.deepEqual([...status.lootHistory], ['ok']);
});
