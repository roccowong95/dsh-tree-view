import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Better Sidebar is optional, supports late activation and disposes its registration', async t => {
  let plugin;
  runInNewContext(bundle, { window: { __ModuleLoader__: { load: ({ factory }) => { plugin = factory(() => React); } } }, console });
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  const views = [];
  ctx.provide('slots', { inject: (_slot, f) => f(), register: spec => { views.push(spec.name); return () => {}; } });
  const fiber = ctx.plugin(plugin);
  await fiber;
  assert.equal(fiber.state, 2);
  assert.ok(views.includes('conversation.view'));
  const tabs = new Map();
  let disposals = 0;
  const sidebarPlugin = ctx.plugin({ apply(scope) {
    scope.provide('betterSidebar', { registerTab(tab) {
      assert.equal(tabs.size, 0);
      tabs.set(tab.id, tab);
      return () => { tabs.delete(tab.id); disposals++; };
    } });
  } });
  await sidebarPlugin;
  await tick();
  assert.equal(tabs.size, 1);
  assert.equal(tabs.get('dsh-tree-view:tree').single, true);
  await sidebarPlugin.dispose();
  await tick();
  assert.equal(tabs.size, 0);
  assert.equal(disposals, 1);
  assert.equal(fiber.state, 2, 'disabling Better Sidebar does not disable standalone Tree');
});

async function mount(t, { archived = false, holdNavigation = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><button role="tab" aria-selected="true">Chat</button><div id="root"></div></body></html>', { url: 'https://tree.test/', pretendToBeVisual: true });
  let current = 'root';
  let requests = 0;
  const opened = [], restored = [], sidebarOpened = [], posts = [], disposers = [];
  const versions = [
    { sessionId: 'root', current: true, createdAt: 1, turns: [{ turn: 1, text: 'Root', time: 1 }] },
    { sessionId: 'branch', parentSessionId: 'root', operation: 'edit', targetTurn: 1, createdAt: 2, archived, turns: [{ turn: 1, text: 'Branch', time: 2 }] },
  ];
  dom.window.fetch = async (_url, options) => {
    if (options?.method === 'POST') { posts.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ ok: true }) }; }
    requests++;
    return { ok: true, json: async () => ({ versions }) };
  };
  const old = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true })) {
    old.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root'));
  let plugin, tab, fullView;
  dom.window.__ModuleLoader__ = { load: ({ factory }) => { plugin = factory(() => React); } };
  runInNewContext(bundle, { window: dom.window, document: dom.window.document, console, setTimeout: dom.window.setTimeout.bind(dom.window), clearTimeout: dom.window.clearTimeout.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const services = {
    slots: { inject: (_name, f) => f(), register: (spec, component) => { if (spec.name === 'conversation.view') fullView = component; return () => {}; } },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: Object.fromEntries(versions.map(v => [v.sessionId, { id: v.sessionId, retainedBy: v.sessionId === current ? ['main'] : [] }])) }) } },
    uiWorkspace: { unarchiveSession: async id => { restored.push(id); }, openSession: id => { opened.push(id); if (!holdNavigation) current = id; } },
    betterSidebar: { registerTab: value => { tab = value; return () => { tab = null; }; }, openTab: (seed, scope) => sidebarOpened.push({ seed, scope }) },
  };
  const ctx = { get: name => services[name], inject: (_deps, f) => f(ctx), effect: f => { const d = f(); if (typeof d === 'function') disposers.push(d); } };
  plugin.apply(ctx);
  t.after(async () => {
    await act(async () => root.unmount());
    disposers.reverse().forEach(f => f());
    dom.window.close();
    for (const [key, desc] of old) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; }
  });
  const render = async (visible, sessionId = 'root') => act(async () => { root.render(React.createElement(tab.component, { visible, scope: { sessionId } })); await tick(); });
  const click = async id => {
    const card = dom.window.document.querySelector('.mtx-card[data-id="' + id + '#t1"]');
    assert.ok(card);
    await act(async () => {
      card.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      card.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
      await tick();
    });
  };
  const renderFull = async () => act(async () => { root.render(React.createElement(fullView, { sessionId: 'root' })); await tick(); });
  return { dom, render, renderFull, click, setMain: id => { current = id; }, opened, restored, sidebarOpened, posts, requests: () => requests };
}

test('sidebar reuses the graph, stays dormant while hidden and remounts on session change', async t => {
  const h = await mount(t);
  await h.render(false);
  assert.equal(h.requests(), 0);
  await h.render(true);
  assert.ok(h.dom.window.document.querySelector('.mtx-graph[data-compact]'));
  assert.ok(h.dom.window.document.querySelector('.mtx-card[data-id="root#t1"]'));
  assert.ok(h.dom.window.document.querySelector('.mtx-card[data-id="branch#t1"]'));
  const requests = h.requests();
  await h.render(false);
  assert.equal(h.dom.window.document.querySelector('.mtx-graph'), null);
  assert.equal(h.requests(), requests);
  await h.render(true, 'branch');
  assert.ok(h.dom.window.document.querySelector('.mtx-graph'));
});

test('selecting another version opens its chat and carries the tree to its sidebar', async t => {
  const h = await mount(t);
  await h.render(true);
  await h.click('branch');
  assert.equal(h.opened[0], 'branch');
  assert.equal(h.sidebarOpened.length, 1);
  assert.equal(h.sidebarOpened[0].seed.type, 'dsh-tree-view:tree');
  assert.equal(h.sidebarOpened[0].scope.sessionId, 'branch');
  assert.equal(h.posts.filter(p => p.action === 'demote').length, 0);
});

test('selecting the current version does not reopen the session or sidebar', async t => {
  const h = await mount(t);
  await h.render(true);
  await h.click('root');
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.sidebarOpened, []);
});

test('archived selection preserves the existing client unarchive flow', async t => {
  const h = await mount(t, { archived: true });
  await h.render(true);
  await h.click('branch');
  assert.deepEqual(h.restored, ['branch']);
  assert.equal(h.opened[0], 'branch');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
  assert.equal(h.sidebarOpened[0].scope.sessionId, 'branch');
});


test('sidebar and full-page canvases remember independent viewports', async t => {
  const h = await mount(t);
  await h.renderFull();
  const graph = h.dom.window.document.querySelector('.mtx-graph');
  await act(async () => {
    graph.dispatchEvent(new h.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    graph.dispatchEvent(new h.dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 900, clientY: 600 }));
    graph.dispatchEvent(new h.dom.window.MouseEvent('pointerup', { bubbles: true, button: 0 }));
  });
  const fullTransform = h.dom.window.document.querySelector('.mtx-world').style.transform;
  await h.render(true);
  const sidebarTransform = h.dom.window.document.querySelector('.mtx-world').style.transform;
  assert.notEqual(sidebarTransform, fullTransform, 'a sidebar must not inherit a full-page pan');
  await h.renderFull();
  assert.equal(h.dom.window.document.querySelector('.mtx-world').style.transform, fullTransform);
});


test('an unfinished or superseded navigation cannot reveal the destination sidebar', async t => {
  const h = await mount(t, { holdNavigation: true });
  await h.render(true);
  await h.click('branch');
  assert.equal(h.opened[0], 'branch');
  assert.deepEqual(h.sidebarOpened, [], 'navigation has not landed yet');
  // The host keeps the previous session retained (e.g. the user went Back),
  // even after whenMain exhausts its bounded retry window.
  h.setMain('root');
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 3200)); });
  assert.deepEqual(h.sidebarOpened, [], 'timeout must not open Tree for an inactive target');
});
