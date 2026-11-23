/**
 * Query's Views step, the page's part (James, 2026-11-23, the Views slots mock, "ok. build it"), on the real page
 * (query-page.ts's template and query-page.js, the host faked): a new query opens with its name ready to type, and Enter
 * moves on to Add a view; the pair is in the slots row's next slot from the start, with empty places after it so there
 * are three, then always the pair alone after the last view. The slots' look and slide are the design system's (its spec).
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
function load(rel, stubs) {
    const out = ts.transpileModule(readFileSync(join(ROOT, rel), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
    const module = { exports: {} };
    new Function('require', 'module', 'exports', out)(name => stubs[name], module, module.exports);
    return module.exports;
}
const pages = load('src/screens/pages.ts', { '../utils/version-label': { versionLabel: () => '' } });
const { buildQueryPage } = load('src/screens/query/query-page.ts', { '../pages': pages });
const asset = rel => pathToFileURL(join(ROOT, 'src/webviews', rel)).href;
const view = (id, name) => ({ id, name, run: '', runOf: '', endpointName: `${name}.csv`, columns: [{ name: 'sku', sample: '' }] });
const state = views => ({ type: 'query.state', name: 'New query', reached: 1, compare: null, views, joins: views.slice(1).map(v => ({ view: v.id, kind: 'left', on: [] })), columns: [], resultColumns: [], total: 0, searches: [] });

async function open(p, name = 'New query', reached = 1) {
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript(() => { window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m), getState: () => null, setState: () => {} }); });
    const dir = join(ROOT, '.dev-local', 'query-views-slots-page');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-n', name }));
    await p.goto(pathToFileURL(file).href);
    await p.evaluate(([n, r]) => window.postMessage({ type: 'query.init', name: n, reached: r, prefs: {} }, '*'), [name, reached]);
    return errors;
}
const slots = p => p.locator('#queryViews [data-adds="slots"]');

test('a new query: the name ready to type; named and Enter, on to Add a view', async ({ page: p }) => {
    const errors = await open(p);
    await p.evaluate(s => window.postMessage(s, '*'), state([]));
    await expect.poll(() => p.locator('#queryName').evaluate(n => n.contains(document.activeElement))).toBe(true);
    await p.keyboard.type('Stock check');
    await p.keyboard.press('Enter');
    await expect.poll(() => p.evaluate(() => window.posted.filter(m => m.type === 'query.rename').map(m => m.name))).toEqual(['Stock check']);
    await expect(p.locator('#queryAddBtn')).toBeFocused();
    expect(errors).toEqual([]);
});

test('a saved query, named, opens with nothing taking the focus', async ({ page: p }) => {
    await open(p, 'Stock check', 4);
    await p.evaluate(s => window.postMessage({ ...s, name: 'Stock check', reached: 4 }, '*'), state([view('vA', 'Stock')]));
    await p.waitForTimeout(200);
    expect(await p.locator('#queryName').evaluate(n => n.contains(document.activeElement))).toBe(false);
});

test('the pair in the next slot from the start, places to make three, then the pair alone after the last view', async ({ page: p }) => {
    await open(p);
    const empty = slots(p).locator('.query-slot-empty');
    await p.evaluate(s => window.postMessage(s, '*'), state([]));
    await expect(slots(p).locator('#queryAdds')).toHaveCount(1);
    await expect(empty).toHaveCount(2);
    await expect(empty.first()).toHaveText('then the next');
    await expect(p.locator('#queryAdds button')).toHaveText(['Add a view', 'Add a file']);
    await p.evaluate(s => window.postMessage(s, '*'), state([view('vA', 'Stock')]));
    await expect(empty).toHaveCount(1);
    await p.evaluate(s => window.postMessage(s, '*'), state([view('vA', 'Stock'), view('vB', 'Bins')]));
    await expect(empty).toHaveCount(0);
    await expect(slots(p).locator('#queryAdds')).toHaveCount(1);
    // (the pair first in its slot, the empty places after it)
    await p.evaluate(s => window.postMessage(s, '*'), state([]));
    expect(await slots(p).evaluate(e => e.firstElementChild && e.firstElementChild.id)).toBe('queryAdds');
});
