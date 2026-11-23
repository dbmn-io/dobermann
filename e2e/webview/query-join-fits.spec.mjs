/**
 * Query's Join step in a real browser, the real page (query-page.ts's template and query-page.js, the host faked),
 * three file views before Compare is picked (James, 2026-11-23, the c-pack demo: "there is something cut off, I
 * don't know what this is meant to say"): the join's note is read whole, never cut; a lane's "Pick a column" whole.
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

/** A TypeScript file of the app, run here (only the page's template: no app code beyond it). */
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
/** The c-pack demo at the Join step: three files, the second joined, the third not yet. */
const STATE = {
    type: 'query.state', name: 'c-pack', reached: 2, compare: null,
    views: [view('vA', 'c-pack-a', ['sku', 'qty', 'colour']), view('vB', 'c-pack-b', ['sku', 'qty', 'colour']), view('vC', 'c-pack-c', ['sku', 'qty', 'colour'])],
    joins: [
        { view: 'vB', kind: 'left', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] },
        { view: 'vC', kind: 'left', on: [{ left: { view: 'vA', column: '' }, right: { view: 'vC', column: '' } }] }
    ],
    columns: [{ view: 'vA', column: 'sku' }], resultColumns: [], total: 0
};

async function joinStep(p, width, state = STATE) {
    await p.setViewportSize({ width, height: 800 });
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.addInitScript(() => { window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m), getState: () => null, setState: () => {} }); });
    // (the page as a file beside the app's, so its scripts and styles load from src/webviews)
    const dir = join(ROOT, '.dev-local', 'query-join-fits');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `page-${width}.html`);
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-c', name: 'c-pack' }));
    await p.goto(pathToFileURL(file).href);
    await p.evaluate(s => {
        window.postMessage({ type: 'query.init', name: s.name, reached: 2, prefs: {} }, '*');
        window.postMessage(s, '*');
    }, state);
    // (the theme's font, as the web app gives it)
    await p.addStyleTag({ content: ':root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace} body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}' });
    await p.getByRole('button', { name: 'Next: Join' }).click();
    await expect(p.locator('.query-made-line').first()).toBeVisible();
    // (every view's line on show: + Add join until none is left, as a user brings each up)
    for (let i = 0; i < 5 && await p.locator('#queryJoins .query-add-join').count(); i++) await p.locator('#queryJoins .query-add-join').click();
    return errors;
}

/** Text cut: its text reaches past a box that clips it (overflow not visible), or it is shortened with an ellipsis. */
const cutText = node => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    for (let a = node.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const box = a.getBoundingClientRect();
        if (r.right > box.right + 1 || r.left < box.left - 1 || r.bottom > box.bottom + 1) return `${node.textContent} cut by ${a.className}`;
    }
    return '';
};
/** A select's chosen text wider than the room inside it (its padding and arrow taken off). */
const cutSelect = sel => {
    const cs = getComputedStyle(sel);
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const text = sel.options[sel.selectedIndex].text;
    const room = sel.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 16;
    return ctx.measureText(text).width > room ? `"${text}" in ${Math.round(room)}px` : '';
};

for (const width of [1280, 860]) {
    test(`three views at ${width}px: each join's note is read whole`, async ({ page: p }) => {
        expect(await joinStep(p, width)).toEqual([]);
        const notes = p.locator('.query-made-line .query-warn');
        await expect(notes).toHaveText(['Joins to a view that is left out.', 'Not joined yet: pick the columns it joins on, or hide it.']);
        expect(await notes.evaluateAll((list, f) => list.map(n => new Function(`return (${f})`)()(n)).filter(Boolean), cutText.toString())).toEqual([]);
    });

    test(`three views at ${width}px: every "Pick a column" is read whole`, async ({ page: p }) => {
        expect(await joinStep(p, width)).toEqual([]);
        const selects = p.locator('.query-join select');
        expect(await selects.count()).toBeGreaterThan(2);
        expect(await selects.evaluateAll((list, f) => list.map(n => new Function(`return (${f})`)()(n)).filter(Boolean), cutSelect.toString())).toEqual([]);
    });
}

/** Four views: the c-pack three and a fourth file, joined to the first on sku. */
const FOUR = {
    ...STATE,
    views: [...STATE.views, view('vD', 'c-pack-d', ['sku', 'qty', 'colour'])],
    joins: [...STATE.joins, { view: 'vD', kind: 'left', on: [{ left: { view: 'vA', column: '' }, right: { view: 'vD', column: '' } }] }]
};
for (const width of [1280, 1024]) {
    test(`four views at ${width}px: notes and every "Pick a column" read whole`, async ({ page: p }) => {
        expect(await joinStep(p, width, FOUR)).toEqual([]);
        const notes = p.locator('.query-made-line .query-warn');
        // (each view's line brought up: B's made, C's and D's not joined, each with boxes under every other view)
        expect(await notes.count()).toBe(3);
        expect(await p.locator('.query-join select').count()).toBe(10);
        expect(await notes.evaluateAll((list, f) => list.map(n => new Function(`return (${f})`)()(n)).filter(Boolean), cutText.toString())).toEqual([]);
        expect(await p.locator('.query-join select').evaluateAll((list, f) => list.map(n => new Function(`return (${f})`)()(n)).filter(Boolean), cutSelect.toString())).toEqual([]);
    });
}

test('a compare of two files with a third of other columns left out: its "Not compared" box sits as the others do, the lanes even', async ({ page: p }) => {
    // (James, 2026-11-23: "the cell widths are different": the box filled its lane and said "joins below, to show")
    const state = {
        ...STATE,
        views: [STATE.views[0], STATE.views[1], view('vC', 'c-pack-c', ['code', 'dog', 'count'])],
        compare: { baseline: 'vA', views: ['vA', 'vB'] },
        joins: [{ view: 'vB', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] }, { view: 'vC', kind: 'left', on: [] }]
    };
    expect(await joinStep(p, 1280, state)).toEqual([]);
    const boxes = await p.locator('.query-compare .query-line').first().locator('.dbmn-lane-run').evaluateAll(cells => cells.map(c => {
        const pick = c.querySelector('.query-pick');
        return { lane: Math.round(c.getBoundingClientRect().width), pick: pick ? Math.round(pick.getBoundingClientRect().width) : 0, text: c.textContent };
    }));
    expect(boxes.length).toBe(3);
    // (the lanes the same width; no box filling its lane while the others don't)
    expect(new Set(boxes.map(b => b.lane)).size).toBe(1);
    expect(boxes.every(b => b.pick < b.lane - 8)).toBe(true);
    expect(boxes.map(b => b.text).join(' ')).not.toContain('joins below');
    await p.screenshot({ path: join(ROOT, '.dev-local', 'query-join-fits', 'compare-left-out.png') });
});

test('a note beside the join\'s counts (numbers against text) wraps onto more lines, never cut', async ({ page: p }) => {
    const stats = { leftRows: 3, leftMatched: 0, rowsAfter: 3, rightRows: 3, rightMatched: 0, relationship: 'oneToOne', typeMismatch: true };
    expect(await joinStep(p, 860, { ...STATE, joins: [{ ...STATE.joins[0], stats }, STATE.joins[1]] })).toEqual([]);
    const note = p.locator('.query-made-line .query-warn', { hasText: 'One side is numbers' });
    await expect(note).toHaveText('One side is numbers and the other text, so they never match. Try ƒ: As text.');
    expect(await note.evaluate((n, f) => new Function(`return (${f})`)()(n), cutText.toString())).toBe('');
});
