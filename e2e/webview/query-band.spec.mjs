/**
 * The screen band on a wide window (James, 2026-11-24: "restricting the width of the controls… it's got to hit every
 * single step in every single footer"), on the REAL Query page at 2560 wide: on Views, Join, Columns and Results the
 * footer's contents sit in the centred --dbmn-band (1280), the area above the table sits in the same band, and there is
 * one rule line above the footer, not two.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */

import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clippedText } from './clipped-text.mjs';

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

async function open(p, state = STATE) {
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript(() => { window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m), getState: () => null, setState: () => {} }); });
    const dir = join(ROOT, '.dev-local', 'query-saved-searches');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-s', name: 'Stock' }));
    await p.goto(pathToFileURL(file).href);
    await p.evaluate(s => { window.postMessage({ type: 'query.init', name: s.name, reached: 4, prefs: {} }, '*'); window.postMessage(s, '*'); }, state);
    await expect.poll(() => p.evaluate(() => (document.getElementById('querySaved').searches || []).length)).toBe((state.searches || []).length);
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


const BAND = 1280, W = 2560;
/** The footer's contents' left and right edges, the band area's edges, and the rule lines just above the footer. */
const measure = p => p.evaluate(() => {
    const foot = document.querySelector('dbmn-footer');
    const fb = foot.getBoundingClientRect();
    const kids = [...foot.children].filter(k => k.getBoundingClientRect().width > 0).map(k => k.getBoundingClientRect());
    const left = Math.min(...kids.map(k => k.left)), right = Math.max(...kids.map(k => k.right));
    // rule lines: a visible horizontal border, over 200px long, on the footer's top edge or within 8px above it
    const lines = [];
    document.querySelectorAll('body *').forEach(el => {
        const b = el.getBoundingClientRect(); if (b.width < 200 || b.height === 0) return;
        const cs = getComputedStyle(el);
        const top = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none' ? b.top : null;
        const bottom = parseFloat(cs.borderBottomWidth) > 0 && cs.borderBottomStyle !== 'none' ? b.bottom : null;
        if (top !== null && top <= fb.top + 1 && top >= fb.top - 8) lines.push(Math.round(top));
        if (bottom !== null && bottom <= fb.top + 1 && bottom >= fb.top - 8) lines.push(Math.round(bottom));
    });
    const band = document.querySelector('.query-page .dbmn-band:not(.hidden)');
    const bb = band && band.getBoundingClientRect();
    return { left, right, lines: [...new Set(lines)], band: bb && bb.width ? { left: bb.left, right: bb.right } : null };
});

for (const step of ['Views', 'Join', 'Columns', 'Results']) {
    test(`${step} at 2560: the footer and the area above the table in the centred 1280 band, one rule above the footer`, async ({ page: p }) => {
        await p.setViewportSize({ width: W, height: 900 });
        await open(p);
        if (step === 'Results') await p.evaluate(() => window.postMessage({ type: 'query.goTo', start: 'results' }, '*'));
        else {
            // (a step already current is not clicked: it is where the page is)
            const stepEl = p.locator('dbmn-steps .dbmn-step', { hasText: step }).first();
            if (!(await stepEl.evaluate(e => e.classList.contains('is-current')))) await stepEl.click();
        }
        await p.waitForTimeout(400);
        const m = await measure(p);
        const lo = (W - BAND) / 2, hi = (W + BAND) / 2;
        expect(m.left, 'footer contents start inside the band').toBeGreaterThanOrEqual(lo - 1);
        expect(m.right, 'footer contents end inside the band').toBeLessThanOrEqual(hi + 1);
        expect(m.left, 'and near its left edge, not centred as a lump').toBeLessThan(lo + 40);
        if (m.band) {
            expect(m.band.left).toBeGreaterThanOrEqual(lo - 1);
            expect(m.band.right).toBeLessThanOrEqual(hi + 1);
        }
        expect(m.lines.length, `rule lines above the footer at ${m.lines.join(', ')}`).toBeLessThanOrEqual(1);
    });
}


/**
 * The name line itself (the manager, 2026-11-24, after James: "the query name views must be centred in results like
 * they are on all other screens!"): the band's box was measured above, never what sits in it. On every step and at
 * 1280, 1920 and 2560: the query's name to its last view sits inside the band, centred in it (within half the empty
 * place after the views, which keeps its room so nothing moves between steps), and on Results under the toolbar's
 * centre the same way.
 */
const nameLine = p => p.evaluate(() => {
    const r = el => el.getBoundingClientRect();
    const lanes = [...document.querySelectorAll('#queryViews .query-slot-lane')];
    const band = r(document.querySelector('.query-page > .dbmn-band'));
    const tools = document.getElementById('queryResultsControls');
    const parts = [...tools.children].filter(k => getComputedStyle(k).position !== 'absolute' && r(k).width > 0);
    return {
        line: [r(document.getElementById('queryName')).left, r(lanes[lanes.length - 1]).right],
        band: [band.left, band.right],
        tools: parts.length ? [Math.min(...parts.map(k => r(k).left)), Math.max(...parts.map(k => r(k).right))] : null
    };
});
const mid = ([a, b]) => (a + b) / 2;
const SLACK = 110;   // half the empty place (one slot, 200px + its gap) after the views

for (const width of [1280, 1920, 2560]) {
    for (const step of ['Views', 'Join', 'Columns', 'Results']) {
        test(`${step} at ${width}: the name line inside the band and centred in it${step === 'Results' ? ', under the toolbar' : ''}`, async ({ page: p }) => {
            await p.setViewportSize({ width, height: 900 });
            await open(p);
            if (step === 'Results') await p.evaluate(() => window.postMessage({ type: 'query.goTo', start: 'results' }, '*'));
            else {
                const stepEl = p.locator('dbmn-steps .dbmn-step', { hasText: step }).first();
                if (!(await stepEl.evaluate(e => e.classList.contains('is-current')))) await stepEl.click();
            }
            await p.waitForTimeout(400);
            const m = await nameLine(p);
            expect(m.line[0], 'starts inside the band').toBeGreaterThanOrEqual(m.band[0] - 1);
            expect(m.line[1], 'ends inside the band').toBeLessThanOrEqual(m.band[1] + 1);
            expect(Math.abs(mid(m.line) - mid(m.band)), `centred in the band (${m.line.map(Math.round)} in ${m.band.map(Math.round)})`).toBeLessThanOrEqual(SLACK);
            if (step === 'Results') expect(Math.abs(mid(m.line) - mid(m.tools)), `under the toolbar (${m.tools.map(Math.round)})`).toBeLessThanOrEqual(SLACK);
        });
    }
}


/**
 * Never cut at the left (the manager, 2026-11-24, after query-looks at 1100: "Not used" at -34 and the column names at
 * -16, once the band was 1280): on every step at 900, 1100 and 1280, nothing above the table starts left of the
 * window, for two views and for four runs with a joined view; and that wide query, at 1500, fits without scrolling
 * sideways (the band grows to its lanes while the window has room: core.css --band-fit).
 */
const runView = (id, run, runOf) => ({ id, name: 'inventory', run, runOf, endpointName: 'inventory.csv', columns: ['sku', 'quantityAllocated', 'quantityAvailable', 'locationGln'].map(c => ({ name: c, sample: '' })) });
const WIDE = {
    type: 'query.state', name: 'Stock', reached: 4, compare: { baseline: 'vA', views: ['vA', 'vB', 'vC', 'vD'] }, statusPlaces: ['BL', 'C1', 'C2', 'C3'],
    views: [runView('vA', 'BL', ''), runView('vB', 'C1', 'vA'), runView('vC', 'C2', 'vA'), runView('vD', 'C3', 'vA'), view('vE', 'products', ['sku', 'name'])],
    joins: [...['vB', 'vC', 'vD'].map(v => ({ view: v, kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: v, column: 'sku' } }] })),
        { view: 'vE', kind: 'left', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vE', column: 'sku' } }] }],
    columns: [{ view: 'vA', column: 'sku' }, ...['quantityAllocated', 'quantityAvailable'].flatMap(c => ['vA', 'vB', 'vC', 'vD'].map(v => ({ view: v, column: c, group: c }))), { view: 'vE', column: 'name' }],
    resultColumns: [], total: 0
};
const goStep = async (p, step) => {
    if (step === 'Results') { await p.evaluate(() => window.postMessage({ type: 'query.goTo', start: 'results' }, '*')); return; }
    const stepEl = p.locator('dbmn-steps .dbmn-step', { hasText: step }).first();
    if (!(await stepEl.evaluate(e => e.classList.contains('is-current')))) await stepEl.click();
};
const leftOfWindow = p => p.evaluate(() => [...document.querySelectorAll('.query-page > .dbmn-band *')]
    .filter(el => { const b = el.getBoundingClientRect(); return b.width > 0 && b.height > 0 && b.left < -0.5 && getComputedStyle(el).visibility !== 'hidden'; })
    .slice(0, 5).map(el => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${(el.textContent || '').trim().slice(0, 20)}" at ${Math.round(el.getBoundingClientRect().left)}`));

for (const [kind, state] of [['two views', STATE], ['four runs and a joined view', WIDE]]) {
    for (const width of [900, 1100, 1280, 1500]) {
        test(`${kind} at ${width}: nothing above the table starts left of the window or is cut, on any step`, async ({ page: p }) => {
            // (as query-looks does: built at 1500 a view at a time, as Add a view brings them in, then the window narrowed)
            await p.setViewportSize({ width: 1500, height: 900 });
            await open(p, { ...state, views: state.views.slice(0, 1), joins: [] });
            for (let n = 2; n <= state.views.length; n++) {
                await p.evaluate(([s, k]) => window.postMessage({ ...s, views: s.views.slice(0, k), joins: s.joins.filter(j => s.views.slice(0, k).some(v => v.id === j.view)) }, '*'), [state, n]);
                await p.waitForTimeout(400);
            }
            for (const step of ['Views', 'Join', 'Columns', 'Results']) {
                await p.setViewportSize({ width: 1500, height: 900 });
                await goStep(p, step);
                await p.waitForTimeout(300);
                await p.setViewportSize({ width, height: 900 });
                await p.waitForTimeout(300);
                expect(await leftOfWindow(p), `${step} at ${width}`).toEqual([]);
                expect(await clippedText(p, '.query-page > .dbmn-band'), `${step} at ${width}: text cut`).toEqual([]);
            }
        });
    }
}

test('four runs and a joined view at 1500: the lanes fit, nothing scrolls sideways', async ({ page: p }) => {
    await p.setViewportSize({ width: 1500, height: 900 });
    await open(p, WIDE);
    for (const step of ['Views', 'Join', 'Columns']) {
        await goStep(p, step);
        await p.waitForTimeout(300);
        const over = await p.evaluate(() => ['queryTop', 'queryViewRows', 'queryJoins', 'queryColumns'].map(id => document.getElementById(id)).filter(el => el && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1).map(el => `${el.id} by ${el.scrollWidth - el.clientWidth}px`));
        expect(over, step).toEqual([]);
    }
});
