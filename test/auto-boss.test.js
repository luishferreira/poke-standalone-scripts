const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'auto-boss.user.js'), 'utf8');

// Os testes de lifecycle existentes exercitam explicitamente o modo WebSocket.
function createHarness(savedState = { useWebSocket: true }, {
    beforeInstall = null,
    bossAvailable = true,
    selectionDelayMs = 0,
    confirmEntry = true,
    challengeThrows = false,
    bossesButtonAvailable = true,
    challengeDisabled = false,
    mismatchedDetail = false,
    bossSoon = false,
    windowInitiallyOpen = false,
    altarInitiallySelected = false,
    entrySlug = 'cruel_boss',
    selectedBossName = null,
} = {}) {
    let now = 0;
    let nextTimerId = 1;
    const timers = new Map();
    const storage = new Map();
    let currentSocket = null;
    let bossWindowOpen = windowInitiallyOpen;
    let selectedBoss = 'Ancient Aero';
    let altarSelected = altarInitiallySelected;
    const clicks = [];
    const clickedSlugs = [];
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

    // Seletores/nome/classes vêm do HTML da janela Bosses fornecido pelo usuário.
    const bossesButton = { click() { clicks.push('Bosses'); bossWindowOpen = true; } };
    const challenge = {
        disabled: challengeDisabled,
        click() {
            if (challengeThrows) throw new Error('Desafio indisponível');
            clicks.push('Challenge Boss');
            clickedSlugs.push(entrySlug);
            bossWindowOpen = false;
            if (confirmEntry) currentSocket?.send(JSON.stringify({ type: 'enter-hunt', slug: entrySlug }));
        },
    };
    const rows = ['Ancient Aero', 'Giant Cruel'].map(name => ({
        querySelector(selector) {
            return selector === '.boss-lname' ? { textContent: `⚔️ ${name}` } : null;
        },
        matches(selector) {
            if (selector === '.on') return selectedBoss === name;
            if (selector === '.soon') return bossSoon && name === 'Giant Cruel';
            return false;
        },
        click() {
            clicks.push(name);
            if (selectionDelayMs) setTimer(() => { selectedBoss = name; }, selectionDelayMs, 0);
            else selectedBoss = name;
        },
    }));
    const bossWindow = {
        querySelectorAll(selector) {
            if (selector === 'button.mk-tab') return [{
                textContent: ' Bosses',
                matches() { return !altarSelected; },
                click() { clicks.push('Aba Bosses'); altarSelected = false; },
            }];
            return selector === 'button.boss-litem' && bossAvailable && !altarSelected ? rows : [];
        },
        querySelector(selector) {
            if (selector === '.boss-hname') return { textContent: mismatchedDetail ? 'Outro Boss' : selectedBoss };
            if (selector === 'button.boss-challenge') return challenge;
            return null;
        },
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
            querySelector(selector) {
                if (selector === 'button[data-guide="dock-bosses"]') return bossesButtonAvailable ? bossesButton : null;
                if (selector === '.boss-window') return bossWindowOpen ? bossWindow : null;
                if (selector === '#pba-boss-name' && selectedBossName !== null) return { value: selectedBossName };
                if (selector.includes('dock-map') || selector.includes('map-window')) throw new Error('Boss não usa mapa');
                return null;
            },
            querySelectorAll(selector) {
                return [];
            },
        },
        getComputedStyle() { return { display: 'block' }; },
        sessionStorage: {
            getItem(key) { return storage.get(key) ?? null; },
            setItem(key, value) { storage.set(key, String(value)); }
        },
        setInterval(callback, delay) { return setTimer(callback, delay, Number(delay)); },
        setTimeout(callback, delay) { return setTimer(callback, delay, 0); }
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
            now = timer.dueAt;
            if (timer.interval) timer.dueAt += timer.interval;
            else timers.delete(id);
            timer.callback();
        }
        now = target;
    }

    function captureSocket(url) {
        const socket = new context.WebSocket(url);
        socket.send(JSON.stringify({ type: 'bootstrap-test' }));
        socket.sent = [];
        return socket;
    }

    async function settle() {
        for (let index = 0; index < 12; index += 1) await Promise.resolve();
    }

    async function tickAsync(milliseconds) {
        const target = now + milliseconds;
        await settle();
        while (true) {
            const pending = [...timers.values()]
                .filter(timer => timer.dueAt <= target)
                .sort((a, b) => a.dueAt - b.dueAt)[0];
            if (!pending) break;
            tick(pending.dueAt - now);
            await settle();
        }
        tick(target - now);
        await settle();
    }

    function reinject() {
        vm.runInContext(source, context);
    }

    return {
        api: context.piwBossFarm, captureSocket, clicks, clickedSlugs, context, reinject, storage,
        settle, tick, tickAsync,
    };
}

function sentTypes(socket) {
    return socket.sent.map(message => message.type);
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

test('Auto Boss usa um único subscriber persistente e não cria myGameSocket', () => {
    const harness = createHarness();
    const bridge = harness.context.piwScripts.wsBridge;
    const socket = harness.captureSocket();

    assert.equal(bridge.status().subscribers, 1);
    assert.equal(bridge.getSocket(), socket);
    assert.equal(harness.context.myGameSocket, undefined);
    harness.reinject();
    assert.equal(bridge.status().subscribers, 1);
});

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

test('uninstall remove somente o subscriber do Auto Boss', () => {
    const harness = createHarness();
    const bridge = harness.context.piwScripts.wsBridge;
    harness.captureSocket();
    assert.equal(bridge.status().subscribers, 1);

    harness.api.uninstall();
    assert.equal(bridge.status().subscribers, 0);
    assert.equal(harness.context.piwScripts.wsBridge, bridge);
    assert.equal(harness.context.piwBossFarm, undefined);
    assert.equal(harness.context.piwBossFarmInjected, undefined);
});

test('não duplica o ciclo do Boss com wrapper externo antes ou depois do bundle', () => {
    for (const wrapperOrder of ['before', 'after']) {
        const observedTypes = [];
        const harness = createHarness({ useWebSocket: true }, {
            beforeInstall: wrapperOrder === 'before'
                ? context => installQolLikeWrapper(context, observedTypes)
                : null
        });
        if (wrapperOrder === 'after') installQolLikeWrapper(harness.context, observedTypes);

        const socket = harness.captureSocket();
        observedTypes.length = 0;
        socket.sent = [];
        assert.equal(harness.api.start(), true, wrapperOrder);
        socket.emit('message', { type: 'field', bossOutcome: 'won', bossLoot: [] });
        harness.tick(3000);

        assert.deepEqual(
            sentTypes(socket),
            ['enter-hunt', 'leave-hunt', 'joy-heal', 'enter-hunt'],
            wrapperOrder
        );
        assert.deepEqual(
            observedTypes,
            ['enter-hunt', 'leave-hunt', 'joy-heal', 'enter-hunt'],
            wrapperOrder
        );
        assert.equal(harness.context.piwScripts.wsBridge.status().subscribers, 1, wrapperOrder);
    }
});

test('entrada padrão e reentrada abrem Bosses, selecionam Giant Cruel e desafiam uma vez', async () => {
    const harness = createHarness(null);
    const socket = harness.captureSocket();
    assert.equal(harness.api.status().useWebSocket, false);
    assert.equal(harness.api.start(), true);
    assert.equal(harness.api.start(), false);
    assert.equal(harness.api.status().transitioning, true);
    assert.deepEqual(socket.sent, []);
    await harness.settle();
    assert.deepEqual(harness.clickedSlugs, ['cruel_boss']);
    assert.deepEqual(harness.clicks, ['Bosses', 'Giant Cruel', 'Challenge Boss']);
    assert.deepEqual(sentTypes(socket), ['enter-hunt']);
    assert.equal(harness.api.status().transitioning, false);

    socket.emit('message', { type: 'field', bossOutcome: 'won', bossLoot: [] });
    await harness.tickAsync(3000);
    assert.deepEqual(harness.clickedSlugs, ['cruel_boss', 'cruel_boss']);
    assert.deepEqual(harness.clicks, ['Bosses', 'Giant Cruel', 'Challenge Boss', 'Bosses', 'Giant Cruel', 'Challenge Boss']);
    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal', 'enter-hunt']);
    assert.equal(harness.api.status().wins, 1);
    assert.equal(harness.api.status().running, true);
});

test('WebSocket opt-in persiste por aba e não abre Bosses', () => {
    const harness = createHarness({ useWebSocket: true, slug: 'cruel_boss' });
    const socket = harness.captureSocket();
    assert.equal(harness.api.start(), true);
    assert.equal(harness.api.status().transitioning, false);
    assert.deepEqual(harness.clickedSlugs, []);
    assert.deepEqual(harness.clicks, []);
    assert.deepEqual(socket.sent, [{ type: 'enter-hunt', slug: 'cruel_boss' }]);
    assert.equal(JSON.parse(harness.storage.get('piw_boss_farm_v1')).useWebSocket, true);
});

test('configuração antiga ou inválida usa janela Bosses e inicia pausada', () => {
    for (const savedState of [null, {}, { useWebSocket: 'true', running: true }, { useWebSocket: 1 }]) {
        const harness = createHarness(savedState);
        assert.equal(harness.api.status().useWebSocket, false);
        assert.equal(harness.api.status().bossName, 'Giant Cruel');
        assert.equal(harness.api.status().running, false);
    }
});

test('aguarda o detalhe da seleção antes de desafiar, sem reabrir janela já aberta', async () => {
    const harness = createHarness(null, { selectionDelayMs: 500, windowInitiallyOpen: true });
    const socket = harness.captureSocket();
    harness.api.start();
    await harness.settle();
    assert.deepEqual(harness.clicks, ['Giant Cruel']);
    assert.deepEqual(socket.sent, []);
    await harness.tickAsync(600);
    assert.deepEqual(harness.clickedSlugs, ['cruel_boss']);
    assert.deepEqual(sentTypes(socket), ['enter-hunt']);
    assert.equal(harness.api.status().transitioning, false);
});

test('boss ou botão Bosses ausente pausa sem fallback WebSocket', async () => {
    for (const options of [{ bossAvailable: false }, { bossesButtonAvailable: false }]) {
        const harness = createHarness(null, options);
        const socket = harness.captureSocket();
        harness.api.start();
        await harness.tickAsync(3500);
        assert.equal(harness.api.status().running, false);
        assert.equal(harness.api.status().transitioning, false);
        assert.match(harness.api.status().lastMessage, /preparar o desafio|Botão Bosses indisponível/);
        assert.deepEqual(socket.sent, []);
    }
});

test('desafio com erro ou sem confirmação pausa sem repetir entrada', async () => {
    for (const options of [{ challengeThrows: true }, { confirmEntry: false }]) {
        const harness = createHarness(null, options);
        const socket = harness.captureSocket();
        harness.api.start();
        await harness.tickAsync(5000);
        assert.equal(harness.api.status().running, false);
        assert.equal(harness.api.status().transitioning, false);
        assert.match(harness.api.status().lastMessage, /Desafio indisponível|não confirmou/);
        assert.deepEqual(socket.sent, []);
        assert.ok(harness.clickedSlugs.length <= 1);
    }
});

test('obtém o slug opaco emitido pelo jogo, sem derivar ID de Ancient Aero', async () => {
    const harness = createHarness({ bossName: 'Ancient Aero', slug: 'outro-slug' }, { entrySlug: 'opaque-fixture' });
    const socket = harness.captureSocket();
    harness.api.start();
    await harness.settle();
    assert.deepEqual(harness.clicks, ['Bosses', 'Ancient Aero', 'Challenge Boss']);
    assert.equal(harness.api.status().transitioning, false);
    assert.equal(harness.api.status().slug, 'opaque-fixture');
    assert.deepEqual(socket.sent, [{ type: 'enter-hunt', slug: 'opaque-fixture' }]);
    const saved = JSON.parse(harness.storage.get('piw_boss_farm_v1'));
    assert.equal(saved.bossName, 'Ancient Aero');
    assert.equal(saved.slug, 'opaque-fixture');
    assert.equal(saved.bossSlugs['Ancient Aero'], 'opaque-fixture');
});

test('parada, desconexão, troca de socket e uninstall cancelam navegação pendente', async () => {
    for (const action of ['stop', 'close', 'replace', 'uninstall']) {
        const harness = createHarness(null, { selectionDelayMs: 500 });
        const socket = harness.captureSocket();
        harness.api.start();
        await harness.settle();
        if (action === 'stop') harness.api.stop();
        if (action === 'close') {
            socket.readyState = harness.context.WebSocket.CLOSED;
            socket.emit('close');
        }
        if (action === 'replace') harness.captureSocket('wss://poke.idleworld.online/ws2');
        if (action === 'uninstall') harness.api.uninstall();
        await harness.tickAsync(10000);
        assert.equal(harness.api.status().running, false, action);
        assert.equal(harness.api.status().transitioning, false, action);
        assert.deepEqual(harness.clickedSlugs, [], action);
        assert.deepEqual(socket.sent, [], action);
    }
});

test('parada agendada no modo clique conclui saída e cura sem desafiar novamente', async () => {
    const harness = createHarness(null);
    const socket = harness.captureSocket();
    harness.api.start();
    await harness.settle();
    harness.api.stop();
    socket.emit('message', { type: 'field', bossOutcome: 'lost' });
    await harness.tickAsync(3000);
    assert.deepEqual(harness.clickedSlugs, ['cruel_boss']);
    assert.deepEqual(sentTypes(socket), ['enter-hunt', 'leave-hunt', 'joy-heal']);
    assert.equal(harness.api.status().running, false);
});

test('detalhe diferente, desafio desabilitado ou boss em breve impedem consumir entrada', async () => {
    for (const options of [{ mismatchedDetail: true }, { challengeDisabled: true }, { bossSoon: true }]) {
        const harness = createHarness(null, options);
        const socket = harness.captureSocket();
        harness.api.start();
        await harness.tickAsync(2000);
        assert.equal(harness.api.status().running, false);
        assert.deepEqual(harness.clickedSlugs, []);
        assert.deepEqual(socket.sent, []);
        assert.match(harness.api.status().lastMessage, /preparar o desafio|desabilitado|indisponível/);
    }
});

test('não aceita tráfego recebido ou envios não relacionados como entrada do desafio', async () => {
    const harness = createHarness(null, { confirmEntry: false });
    const socket = harness.captureSocket();
    harness.api.start();
    await harness.settle();
    socket.emit('message', { type: 'enter-hunt', slug: 'cruel_boss' });
    socket.send(JSON.stringify({ type: 'chat', text: 'teste' }));
    socket.send(JSON.stringify({ type: 'enter-hunt', slug: null }));
    await harness.settle();
    assert.equal(harness.api.status().transitioning, true);
    await harness.tickAsync(5000);
    assert.equal(harness.api.status().running, false);
    assert.equal(harness.clickedSlugs.length, 1);
});

test('modo clique convive com wrapper externo antes e depois sem duplicar desafio', async () => {
    for (const wrapperOrder of ['before', 'after']) {
        const observedTypes = [];
        const harness = createHarness(null, {
            beforeInstall: wrapperOrder === 'before' ? context => installQolLikeWrapper(context, observedTypes) : null,
        });
        if (wrapperOrder === 'after') installQolLikeWrapper(harness.context, observedTypes);
        const socket = harness.captureSocket();
        observedTypes.length = 0;
        harness.api.start();
        await harness.settle();
        assert.deepEqual(observedTypes, ['enter-hunt']);
        assert.deepEqual(sentTypes(socket), ['enter-hunt']);
        assert.equal(harness.clickedSlugs.length, 1);
    }
});

test('janela aberta no Altar troca para aba Bosses antes de selecionar', async () => {
    const harness = createHarness(null, { windowInitiallyOpen: true, altarInitiallySelected: true });
    harness.captureSocket();
    harness.api.start();
    await harness.settle();
    assert.deepEqual(harness.clicks, ['Aba Bosses', 'Giant Cruel', 'Challenge Boss']);
    assert.equal(harness.api.status().transitioning, false);
});

test('select em modo WebSocket usa o slug do boss escolhido, sem reutilizar o anterior', () => {
    const harness = createHarness({
        bossName: 'Giant Cruel',
        useWebSocket: true,
        bossSlugs: { 'Giant Cruel': 'cruel_boss', 'Ancient Aero': 'opaque-fixture' },
    }, { selectedBossName: 'Ancient Aero' });
    const socket = harness.captureSocket();
    assert.equal(harness.api.start(), true);
    assert.deepEqual(socket.sent, [{ type: 'enter-hunt', slug: 'opaque-fixture' }]);
    assert.equal(harness.api.status().bossName, 'Ancient Aero');
    assert.deepEqual(harness.clicks, []);
});

test('Aero sem slug observado bloqueia WebSocket sem enviar entrada de Giant Cruel', () => {
    for (const saved of [
        { bossName: 'Ancient Aero', useWebSocket: true, slug: 'cruel_boss' },
        { bossName: 'Ancient Aero', useWebSocket: true, bossSlugs: { 'Ancient Aero': 123 } },
    ]) {
        const harness = createHarness(saved);
        const socket = harness.captureSocket();
        assert.equal(harness.api.status().webSocketAvailable, false);
        assert.equal(harness.api.start(), false);
        assert.match(harness.api.status().lastMessage, /uma vez pelo modo de clique/);
        assert.deepEqual(socket.sent, []);
    }
});

test('slug aprendido por clique é salvo por boss e funciona no modo WebSocket após reload', async () => {
    const harness = createHarness({ bossName: 'Ancient Aero' }, { entrySlug: 'opaque-fixture' });
    harness.captureSocket();
    harness.api.start();
    await harness.settle();
    const saved = JSON.parse(harness.storage.get('piw_boss_farm_v1'));
    saved.useWebSocket = true;
    const restored = createHarness(saved);
    const socket = restored.captureSocket();
    assert.equal(restored.api.status().webSocketAvailable, true);
    assert.equal(restored.api.start(), true);
    assert.deepEqual(socket.sent, [{ type: 'enter-hunt', slug: 'opaque-fixture' }]);
});

test('select inválido falha fechado sem clique nem WebSocket', () => {
    const harness = createHarness({ useWebSocket: true }, { selectedBossName: 'Ghost' });
    const socket = harness.captureSocket();
    assert.equal(harness.api.start(), false);
    assert.deepEqual(socket.sent, []);
    assert.deepEqual(harness.clicks, []);
});
