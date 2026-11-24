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

test('a view added: its lane opens from nothing where it goes, and the pair moves right with it, on its line', async ({ page: p }) => {
    // James, 2026-11-23: "these views are flying in from the right, not moving across from the left… The view needs to
    // expand… These buttons need to move across as the view comes in"; before that, "they look flying from the top"
    await p.setViewportSize({ width: 1280, height: 800 });
    await open(p);
    await p.evaluate(s => window.postMessage(s, '*'), state([view('vA', 'Stock')]));
    await expect(p.locator('#queryViews > .dbmn-lane')).toHaveCount(1);
    await p.waitForTimeout(400);
    const before = await p.locator('#queryAdds').boundingBox();
    // The second view comes in: sample the new lane and the pair every frame while it opens
    const frames = await p.evaluate(s => new Promise(done => {
        const out = [];
        window.postMessage(s, '*');
        const t0 = performance.now();
        const tick = () => {
            const lanes = document.querySelectorAll('#queryViews > .dbmn-lane'), lane = lanes[1];
            const adds = document.getElementById('queryAdds').getBoundingClientRect();
            if (lane) out.push({ t: performance.now() - t0, laneX: lane.getBoundingClientRect().left, laneW: lane.getBoundingClientRect().width,
                x: adds.left, y: adds.top, firstX: lanes[0].getBoundingClientRect().left, firstRight: lanes[0].getBoundingClientRect().right });
            if (performance.now() - t0 < 600) requestAnimationFrame(tick); else done(out);
        };
        requestAnimationFrame(tick);
    }), state([view('vA', 'Stock'), view('vB', 'Bins')]));
    expect(frames.length).toBeGreaterThan(5);
    const first = frames[0], last = frames[frames.length - 1];
    // Opens from (near) nothing to a slot's width, where it ends up: never coming in from elsewhere. The lanes are
    // centred (.dbmn-lanes.is-centred, the screen band), so the row grows from the middle: the first lane steps left by
    // half as the new one opens, and the new lane opens right beside it, never apart from it
    expect(first.laneW).toBeLessThan(60);
    expect(Math.round(last.laneW)).toBe(200);
    for (const f of frames) expect(Math.abs(f.laneX - f.firstRight - (last.laneX - last.firstRight))).toBeLessThan(1);
    for (let i = 1; i < frames.length; i++) expect(frames[i].firstX).toBeLessThanOrEqual(frames[i - 1].firstX + 0.5);
    // Some frames part-way open: it is seen opening
    expect(frames.filter(f => f.laneW > 20 && f.laneW < 180).length).toBeGreaterThan(1);
    // The pair: right of the opening lane at every frame, moving only right, never up or down
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        expect(f.x).toBeGreaterThanOrEqual(f.laneX + f.laneW);
        expect(Math.abs(f.y - before.y)).toBeLessThan(1);
        if (i) expect(f.x).toBeGreaterThanOrEqual(frames[i - 1].x - 0.5);
    }
    // Across by a slot from the first lane (half of it from the screen's middle, the row being centred)
    expect(last.x - last.firstX - (before.x - frames[0].firstX)).toBeGreaterThanOrEqual(199);
    expect(last.x - before.x).toBeGreaterThanOrEqual(99);
    // Mid-way, part of the way across: it moves, it doesn't jump
    expect(frames.some(f => f.x > before.x + 20 && f.x < last.x - 20)).toBe(true);
});

test('lanes are a slot wide each, never stretched across the screen; the rows beneath line up with them', async ({ page: p }) => {
    // James, 2026-11-23: "These are also way too wide on this screen. They're all ridiculously wide. I've got no room"
    await p.setViewportSize({ width: 1280, height: 800 });
    await open(p);
    await p.evaluate(s => window.postMessage(s, '*'), state([view('vA', 'Stock'), view('vB', 'Bins')]));
    await expect(p.locator('#queryViews > .dbmn-lane')).toHaveCount(2);
    await p.waitForTimeout(400);
    const widths = await p.locator('#queryViews > .dbmn-lane').evaluateAll(ls => ls.map(l => Math.round(l.getBoundingClientRect().width)));
    expect(widths).toEqual([200, 200]);
    // (the Views step's lines below: their lanes start and end where the slots do)
    const top = await p.locator('#queryViews > .dbmn-lane').evaluateAll(ls => ls.map(l => Math.round(l.getBoundingClientRect().left)));
    const row = p.locator('#queryViewRows .dbmn-lanes-row').first();
    if (await row.count()) {
        const below = await row.locator(':scope > .dbmn-lane').evaluateAll(ls => ls.map(l => Math.round(l.getBoundingClientRect().left)));
        expect(below).toEqual(top);
    }
});
