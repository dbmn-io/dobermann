/**
 * Saved searches on the real Query page (query-page.ts's template and query-page.js, the host faked), James 2026-11-23,
 * issue 16. The ★ drop-down is the design system's <dbmn-saved-searches> (its own spec); here the page's part, through
 * the element's events: picking one fills the box and searches as typing does, an `@name` for a column not in the report
 * adding it (never taking one away); a save, rename or delete goes to the host; the list and the box's text reach the ★.
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

const view = (id, name, columns) => ({ id, name, run: '', runOf: '', endpointName: `${name}.csv`, columns: columns.map(c => ({ name: c, sample: '' })) });
/** Stock and Bins joined on sku; the report shows sku and bin; two saved searches. */
const STATE = {
    type: 'query.state', name: 'Stock', reached: 4, compare: null,
    views: [view('vS', 'Stock', ['sku', 'qty', 'city']), view('vB', 'Bins', ['sku', 'bin'])],
    joins: [{ view: 'vB', kind: 'left', on: [{ left: { view: 'vS', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] }],
    columns: [{ view: 'vS', column: 'sku' }, { view: 'vB', column: 'bin' }],
    resultColumns: [{ view: 'vS', column: 'sku', type: 'text' }, { view: 'vB', column: 'bin', type: 'text' }], total: 0,
    searches: [{ name: 'Low stock', text: '@qty<5' }, { name: 'Sydney', text: 'sydney' }]
};

async function open(p) {
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript(() => { window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m), getState: () => null, setState: () => {} }); });
    const dir = join(ROOT, '.dev-local', 'query-saved-searches');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-s', name: 'Stock' }));
    await p.goto(pathToFileURL(file).href);
    await p.evaluate(s => { window.postMessage({ type: 'query.init', name: s.name, reached: 4, prefs: {} }, '*'); window.postMessage(s, '*'); }, STATE);
    await expect.poll(() => p.evaluate(() => (document.getElementById('querySaved').searches || []).length)).toBe(2);
    return errors;
}
const posted = (p, type) => p.evaluate(t => window.posted.filter(m => m.type === t), type);

test('the ★ is given the query\'s saved searches, and the box\'s text as it changes', async ({ page: p }) => {
    expect(await open(p)).toEqual([]);
    expect(await p.evaluate(() => document.getElementById('querySaved').searches)).toEqual(STATE.searches);
    // (typed: the box is on Results, hidden on this step, so its own input event)
    await p.evaluate(() => { const box = document.getElementById('querySearch'); box.value = 'sydney'; box.dispatchEvent(new Event('input', { bubbles: true })); });
    expect(await p.evaluate(() => document.getElementById('querySaved').current)).toBe('sydney');
    // (the host's list after a save comes back as query.searches)
    await p.evaluate(() => window.postMessage({ type: 'query.searches', searches: [{ name: 'Only', text: 'x' }] }, '*'));
    await expect.poll(() => p.evaluate(() => document.getElementById('querySaved').searches)).toEqual([{ name: 'Only', text: 'x' }]);
});

test('picking "Low stock" (@qty<5): the box holds it, and qty, not in the report, is added; nothing is taken away', async ({ page: p }) => {
    expect(await open(p)).toEqual([]);
    await p.evaluate(() => document.getElementById('querySaved').dispatchEvent(new CustomEvent('dbmn-saved-pick', { bubbles: true, detail: { name: 'Low stock', text: '@qty<5' } })));
    await expect(p.locator('#querySearch')).toHaveValue('@qty<5');
    await expect.poll(async () => (await posted(p, 'query.setSelect')).length).toBe(1);
    const [sent] = await posted(p, 'query.setSelect');
    expect(sent.select.map(c => `${c.view}.${c.column}`)).toEqual(['vS.sku', 'vB.bin', 'vS.qty']);
    expect(await p.evaluate(() => document.getElementById('querySaved').current)).toBe('@qty<5');
});

test('a saved search that ends on a column\'s name (@city) still adds it: a saved one is finished as it stands', async ({ page: p }) => {
    expect(await open(p)).toEqual([]);
    await p.evaluate(() => document.getElementById('querySaved').dispatchEvent(new CustomEvent('dbmn-saved-pick', { bubbles: true, detail: { name: 'Cities', text: '@city' } })));
    await expect.poll(async () => (await posted(p, 'query.setSelect')).length).toBe(1);
    expect((await posted(p, 'query.setSelect'))[0].select.map(c => c.column)).toContain('city');
});

test('a save, rename or delete in the ★: the whole list goes to the host', async ({ page: p }) => {
    expect(await open(p)).toEqual([]);
    const list = [{ name: 'Low stock', text: '@qty<5' }];
    await p.evaluate(l => document.getElementById('querySaved').dispatchEvent(new CustomEvent('dbmn-saved-change', { bubbles: true, detail: { searches: l } })), list);
    expect(await posted(p, 'query.saveSearches')).toEqual([{ type: 'query.saveSearches', searches: list }]);
});

for (const width of [900, 1280]) {
    test(`Results at ${width}px: the ★ inside the box; the box centred between the filter and Chain; Chain whole`, async ({ page: p }) => {
        // (round 19, 2026-11-23: beside the box, the ★ pushed Chain past the toolbar at 900 and took the box off centre)
        await p.setViewportSize({ width, height: 700 });
        expect(await open(p)).toEqual([]);
        await p.evaluate(() => window.postMessage({ type: 'query.goTo', start: 'results' }, '*'));
        await expect(p.locator('#queryResultsControls')).toBeVisible();
        const box = sel => p.locator(sel).boundingBox();
        const [filter, search, chain, star, bar] = await Promise.all(['#queryClearFilters', '#querySearch', '#queryChainBtn', '#querySaved', '#queryResultsControls'].map(box));
        // the ★ within the box
        expect(star.x).toBeGreaterThan(search.x);
        expect(star.x + star.width).toBeLessThanOrEqual(search.x + search.width + 1);
        // centred in the room between the controls and Chain (query-compare.spec's measure)
        expect(Math.abs((search.x - (filter.x + filter.width)) - (chain.x - (search.x + search.width)))).toBeLessThanOrEqual(40);
        // Chain whole, inside the toolbar
        expect(chain.x + chain.width).toBeLessThanOrEqual(bar.x + bar.width + 1);
        // typed text stops short of the ★
        const pad = await p.locator('#querySearch').evaluate(el => parseFloat(getComputedStyle(el).paddingRight));
        expect(pad).toBeGreaterThanOrEqual(star.width);
        await p.locator('#queryResultsControls').screenshot({ path: join(ROOT, '.dev-local', 'query-saved-searches', `toolbar-${width}.png`) });
    });
}

test('Results: a real click on the ★ opens its menu (nothing over it takes the click), over the table below', async ({ page: p }) => {
    // (James, 2026-11-23: "I cannot save it though… Clicking this does nothing": the box's text field was on top)
    await p.setViewportSize({ width: 1280, height: 700 });
    expect(await open(p)).toEqual([]);
    await p.evaluate(() => window.postMessage({ type: 'query.goTo', start: 'results' }, '*'));
    await expect(p.locator('#queryResultsControls')).toBeVisible();
    await p.locator('#querySearch').fill('@qty<5');
    // (Playwright clicks where a user would, and refuses if another element would receive it)
    await p.locator('#querySaved button').first().click();
    const menu = p.locator('#querySaved .dbmn-saved-menu');
    await expect(menu).toBeVisible();
    // the menu is on top where it shows: the point at its middle is in it
    const onTop = await menu.evaluate(m => { const r = m.getBoundingClientRect(); const at = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(20, r.height / 2)); return !!at && m.contains(at); });
    expect(onTop).toBe(true);
    await p.locator('#querySaved').screenshot({ path: join(ROOT, '.dev-local', 'query-saved-searches', 'menu-open.png') }).catch(() => {});
});
