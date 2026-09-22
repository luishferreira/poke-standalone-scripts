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

    dispatch(type) {
      const event = { target: this, stopPropagation() {} };
      for (const handler of this.listeners.get(type) || []) handler(event);
    }

    contains(target) {
      return this === target || this.children.some((child) => child.contains(target));
    }

    matches(selector) {
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
    MutationObserver: FakeMutationObserver,
    Number,
    String,
    Map,
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
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

  return { context, document, flush, mutate, runAgain: () => vm.runInNewContext(source, context) };
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
