const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'ui-menu.js'), 'utf8');

function createDomHarness({ withQolSidebar = false } = {}) {
  const timers = [];
  const observers = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const storage = new Map();

  class FakeElement {
    constructor(tagName) {
      this.tagName = String(tagName).toUpperCase();
      this.id = '';
      this.className = '';
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.hidden = false;
      this.textContent = '';
      this.attributes = new Map();
      this.listeners = new Map();
      this.style = {};
      this.offsetWidth = 0;
      this.offsetHeight = 0;
      this.title = '';
    }

    get childElementCount() { return this.children.length; }

    appendChild(child) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    append(...children) {
      children.forEach((child) => this.appendChild(child));
    }

    replaceChildren(...children) {
      this.children.forEach((child) => { child.parentElement = null; });
      this.children = [];
      this.append(...children);
    }

    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      this.parentElement = null;
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }

    addEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      handlers.push(handler);
      this.listeners.set(type, handlers);
    }

    removeEventListener(type, handler) {
      const handlers = this.listeners.get(type) || [];
      this.listeners.set(type, handlers.filter((item) => item !== handler));
    }

    dispatch(type, values = {}) {
      const event = { target: this, stopPropagation() {}, preventDefault() {}, ...values };
      for (const handler of this.listeners.get(type) || []) handler(event);
    }

    getBoundingClientRect() {
      const left = Number.parseFloat(this.style.left) || 0;
      const top = Number.parseFloat(this.style.top) || 0;
      return {
        left,
        top,
        width: this.offsetWidth,
        height: this.offsetHeight,
        right: left + this.offsetWidth,
        bottom: top + this.offsetHeight,
      };
    }

    contains(target) {
      return this === target || this.children.some((child) => child.contains(target));
    }

    matches(selector) {
      if (selector.split(',').some((part) => part.trim().toUpperCase() === this.tagName)) return true;
      if (selector.startsWith('#')) return this.id === selector.slice(1);
      if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
      return false;
    }

    querySelector(selector) {
      return walk(this).find((element) => element !== this && element.matches(selector)) || null;
    }
  }

  function walk(root) {
    return [root, ...root.children.flatMap(walk)];
  }

  const documentElement = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  documentElement.append(head, body);

  const document = {
    documentElement,
    head,
    body,
    createElement(tagName) { return new FakeElement(tagName); },
    getElementById(id) { return walk(documentElement).find((element) => element.id === id) || null; },
    querySelectorAll(selector) { return walk(documentElement).filter((element) => element.matches(selector)); },
    addEventListener(type, handler) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
  };

  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.connected = false;
      observers.push(this);
    }

    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }

  const context = {
    console: { warn() {} },
    document,
    getComputedStyle(element) {
      return { width: `${element.offsetWidth}px`, height: `${element.offsetHeight}px` };
    },
    innerHeight: 768,
    innerWidth: 1024,
    MutationObserver: FakeMutationObserver,
    Number,
    String,
    Map,
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    sessionStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    addEventListener(type, handler) {
      const handlers = windowListeners.get(type) || [];
      handlers.push(handler);
      windowListeners.set(type, handlers);
    },
    removeEventListener(type, handler) {
      const handlers = windowListeners.get(type) || [];
      windowListeners.set(type, handlers.filter((item) => item !== handler));
    },
  };
  context.window = context;

  if (withQolSidebar) {
    const sidebar = document.createElement('div');
    sidebar.id = 'script-sidebar';
    const qolButton = document.createElement('button');
    qolButton.id = 'dock-btn-shops';
    sidebar.appendChild(qolButton);
    body.appendChild(sidebar);
  }

  vm.runInNewContext(source, context);

  function flush() {
    while (timers.length) timers.shift()();
  }

  function mutate() {
    observers.filter((observer) => observer.connected).forEach((observer) => observer.callback([]));
    flush();
  }

  function dispatchWindow(type, values = {}) {
    const event = { preventDefault() {}, ...values };
    for (const handler of [...(windowListeners.get(type) || [])]) handler(event);
  }

  return {
    context,
    document,
    dispatchWindow,
    flush,
    mutate,
    storage,
    runAgain: () => vm.runInNewContext(source, context),
  };
}

test('cria a própria sidebar quando o PIW-QOL não existe', () => {
  const harness = createDomHarness();
  let clicks = 0;
  harness.context.piwScripts.uiMenu.register({
    id: 'test-auto-catch', label: 'Auto Catch', icon: '🎯', order: 10, onClick() { clicks += 1; },
  });
  harness.flush();

  const sidebar = harness.document.getElementById('script-sidebar');
  assert.ok(sidebar);
  assert.equal(sidebar.dataset.piwToolsHost, 'true');
  assert.ok(harness.document.getElementById('piw-tools-sidebar-group'));
  assert.equal(harness.document.getElementById('test-auto-catch').textContent, '🎯');

  harness.document.getElementById('test-auto-catch').dispatch('click');
  assert.equal(clicks, 1);
});

test('reutiliza a sidebar do PIW-QOL sem mover nem remover os controles dele', () => {
  const harness = createDomHarness({ withQolSidebar: true });
  const sidebar = harness.document.getElementById('script-sidebar');
  harness.context.piwScripts.uiMenu.register({
    id: 'test-watchdog', label: 'Auto Reconnect', icon: '📡', onClick() {},
  });
  harness.flush();

  assert.equal(harness.document.getElementById('script-sidebar'), sidebar);
  assert.ok(harness.document.getElementById('dock-btn-shops'));
  assert.ok(harness.document.getElementById('test-watchdog'));
  assert.equal(sidebar.dataset.piwToolsHost, undefined);
});

test('aceita o PIW-QOL depois e preserva um único menu compartilhado', () => {
  const harness = createDomHarness();
  harness.context.piwScripts.uiMenu.register({
    id: 'test-boss', label: 'Auto Boss', icon: '☠️', onClick() {},
  });
  harness.flush();
  const sidebar = harness.document.getElementById('script-sidebar');

  const qolButton = harness.document.createElement('button');
  qolButton.id = 'dock-btn-depot';
  sidebar.appendChild(qolButton);
  harness.runAgain();
  harness.mutate();

  assert.equal(harness.document.querySelectorAll('#script-sidebar').length, 1);
  assert.ok(harness.document.getElementById('dock-btn-depot'));
  assert.deepEqual(Array.from(harness.context.piwScripts.uiMenu.status().entries), ['test-boss']);
});

test('consolida registros e remove somente os próprios controles', () => {
  const harness = createDomHarness({ withQolSidebar: true });
  let catchMounts = 0;
  const removeCatch = harness.context.piwScripts.uiMenu.register({
    id: 'test-catch', label: 'Auto Catch', onClick() {}, order: 10,
    onMount() { catchMounts += 1; },
  });
  harness.flush();
  const removeRefill = harness.context.piwScripts.uiMenu.register({
    id: 'test-refill', label: 'Auto Refill', onClick() {}, order: 40,
  });
  harness.flush();

  assert.deepEqual(
    Array.from(harness.context.piwScripts.uiMenu.status().entries),
    ['test-catch', 'test-refill'],
  );
  assert.equal(catchMounts, 2);
  assert.equal(removeCatch(), true);
  assert.equal(removeCatch(), false);
  assert.ok(harness.document.getElementById('test-refill'));
  assert.equal(removeRefill(), true);
  assert.equal(harness.document.getElementById('piw-tools-sidebar-group'), null);
  assert.ok(harness.document.getElementById('dock-btn-shops'));
});

test('recria o menu quando a SPA remove a sidebar', () => {
  const harness = createDomHarness();
  harness.context.piwScripts.uiMenu.register({
    id: 'test-refill', label: 'Auto Refill', onClick() {},
  });
  harness.flush();
  harness.document.getElementById('script-sidebar').remove();
  harness.mutate();

  assert.ok(harness.document.getElementById('script-sidebar'));
  assert.ok(harness.document.getElementById('test-refill'));
});

test('move painel, salva por aba, limita à tela e restaura no duplo clique', () => {
  const harness = createDomHarness();
  const panel = harness.document.createElement('section');
  panel.offsetWidth = 300;
  panel.offsetHeight = 200;
  const header = harness.document.createElement('header');
  const close = harness.document.createElement('button');
  header.appendChild(close);
  panel.appendChild(header);
  harness.document.body.appendChild(panel);

  const cleanup = harness.context.piwScripts.uiMenu.makePanelDraggable(panel, {
    storageKey: 'test-panel-position',
  });
  header.dispatch('pointerdown', {
    button: 0,
    isPrimary: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
  });
  harness.dispatchWindow('pointermove', { pointerId: 1, clientX: 110, clientY: 90 });
  harness.dispatchWindow('pointerup', { pointerId: 1 });

  assert.equal(panel.style.left, '100px');
  assert.equal(panel.style.top, '80px');
  assert.deepEqual(JSON.parse(harness.storage.get('test-panel-position')), { left: 100, top: 80 });

  harness.context.innerWidth = 250;
  harness.dispatchWindow('resize');
  assert.equal(panel.style.left, '0px');
  assert.deepEqual(JSON.parse(harness.storage.get('test-panel-position')), { left: 0, top: 80 });

  header.dispatch('dblclick');
  assert.equal(panel.style.left, '');
  assert.equal(panel.style.top, '');
  assert.equal(harness.storage.has('test-panel-position'), false);

  close.dispatch('pointerdown', {
    button: 0,
    isPrimary: true,
    pointerId: 2,
    clientX: 10,
    clientY: 10,
  });
  harness.dispatchWindow('pointermove', { pointerId: 2, clientX: 150, clientY: 150 });
  assert.equal(panel.style.left, '');
  assert.equal(cleanup(), true);
  assert.equal(cleanup(), false);
});
