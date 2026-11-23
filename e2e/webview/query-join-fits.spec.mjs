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
        await expect(notes).toHaveText(['Joins to a view that is left out.', 'Pick the columns this view joins on. Until then it is left out of the report.']);
        expect(await notes.evaluateAll((list, f) => list.map(n => new Function(`return (${f})`)()(n)).filter(Boolean), cutText.toString())).toEqual([]);
    });

    test(`three views at ${width}px: every "Pick a column" is read whole`, async ({ page: p }) => {
        expect(await joinStep(p, width)).toEqual([]);
        const selects = p.locator('.query-join select');
        expect(await selects.count()).toBeGreaterThan(2);
        expect(await selects.evaluateAll((list, f) => list.map(n => new Function(`return (${f})`)()(n)).filter(Boolean), cutSelect.toString())).toEqual([]);
    });
}

test('a note beside the join\'s counts (numbers against text) wraps onto more lines, never cut', async ({ page: p }) => {
    const stats = { leftRows: 3, leftMatched: 0, rowsAfter: 3, rightRows: 3, rightMatched: 0, relationship: 'oneToOne', typeMismatch: true };
    expect(await joinStep(p, 860, { ...STATE, joins: [{ ...STATE.joins[0], stats }, STATE.joins[1]] })).toEqual([]);
    const note = p.locator('.query-made-line .query-warn', { hasText: 'One side is numbers' });
    await expect(note).toHaveText('One side is numbers and the other text, so they never match. Try ƒ: As text.');
    expect(await note.evaluate((n, f) => new Function(`return (${f})`)()(n), cutText.toString())).toBe('');
});
