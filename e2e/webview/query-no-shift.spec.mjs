/**
 * Query from Columns to Results on the REAL page (James, 2026-11-24: "they must NOT SHIFT. they can shrink… but their
 * position left/right must not move"): the query's name, every view's slot and Back keep their left and right edges;
 * Results' controls are one centred line (the design system's .dbmn-toolbar). At 2560, 1920 and 1280 wide.
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

const view = (id, name, columns) => ({ id, name, run: '', runOf: '', endpointName: `${name}.xlsx`, file: `${name}.xlsx`, columns: columns.map(c => ({ name: c, sample: '' })) });
const cols = ['sku', 'name', 'breed', 'note'];
const STATE = {
    type: 'query.state', name: 'boo hoo', reached: 4, compare: null,
    views: [view('vA', 'akennelA', cols), view('vB', 'akennelB', cols)],
    joins: [{ view: 'vB', kind: 'left', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] }],
    columns: cols.map(c => ({ view: 'vA', column: c })),
    resultColumns: cols.map(c => ({ view: 'vA', column: c, type: 'text' })), total: 10
};
// The same query as a compare (two files alike: James's "boo hoo"), as Results shows it with Side by side
const COMPARE = {
    ...STATE, compare: { baseline: 'vA', views: ['vA', 'vB'] }, statusPlaces: ['akennelA', 'akennelB'],
    joins: [{ view: 'vB', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] }],
    columns: [{ view: 'vA', column: 'sku' }, ...['name', 'breed', 'note'].flatMap(c => [{ view: 'vA', column: c, group: c }, { view: 'vB', column: c, group: c }])],
    resultColumns: [{ view: 'vA', column: 'sku', type: 'text' }, ...['name', 'breed', 'note'].flatMap(c => [{ view: 'vA', column: c, group: c, type: 'text' }, { view: 'vB', column: c, group: c, type: 'text' }])]
};
const ROWS = Array.from({ length: 10 }, (_, i) => [`WOOF-00${i}`, ['Biscuit', 'Pepper', 'Rex'][i % 3], ['Beagle', 'Poodle', 'Rottweiler'][i % 3], ['good boy', 'loves walks', 'tiny'][i % 3]]);

async function open(p, width, state = STATE) {
    await p.setViewportSize({ width, height: 900 });
    await p.addInitScript(rows => {
        window.acquireVsCodeApi = () => ({ postMessage: m => {
            if (m.type === 'query.rows') setTimeout(() => window.postMessage({ type: 'query.rowsData', seq: m.seq, offset: m.offset, rows: rows.slice(m.offset, m.offset + m.limit), shown: rows.length, total: rows.length }, '*'), 10);
        }, getState: () => null, setState: () => {} });
    }, ROWS);
    const dir = join(ROOT, '.dev-local', 'query-no-shift');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-c', name: 'boo hoo' }));
    await p.goto(pathToFileURL(file).href);
    await p.addStyleTag({ content: ':root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-background:#1e1e1e;--vscode-foreground:#ccc;--vscode-panel-border:#444} body{background:#1e1e1e;color:#ccc;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}' });
    await p.evaluate(s => { window.postMessage({ type: 'query.init', name: s.name, reached: 4, prefs: {} }, '*'); window.postMessage(s, '*'); window.postMessage({ type: 'query.goTo', start: 'columns' }, '*'); }, state);
    await p.waitForTimeout(600);
}

/** The header's pieces (the name, each slot), Back, and the controls' group, by their left and right edges. */
const where = p => p.evaluate(() => {
    const box = el => { if (!el) return null; const b = el.getBoundingClientRect(); return b.width ? [Math.round(b.left), Math.round(b.right)] : null; };
    const tools = document.getElementById('queryResultsControls');
    const line = [...tools.children].filter(k => getComputedStyle(k).position !== 'absolute');
    const kids = line.map(box).filter(Boolean);
    return {
        name: box(document.getElementById('queryName')),
        slots: [...document.querySelectorAll('#queryViews .query-slot-lane')].map(box),
        back: box(document.getElementById('queryBackBtn')),
        controls: kids.length ? [Math.min(...kids.map(k => k[0])), Math.max(...kids.map(k => k[1]))] : null,
        controlsTop: line.map(k => Math.round(k.getBoundingClientRect().top)),
        page: document.documentElement.scrollWidth
    };
});

for (const [kind, state] of [['a join', STATE], ['a compare', COMPARE]]) for (const width of [2560, 1920, 1280]) {
    test(`${kind} at ${width}: Columns to Results moves nothing sideways; the controls one centred line`, async ({ page: p }) => {
        await open(p, width, state);
        const columns = await where(p);
        await p.screenshot({ path: join(ROOT, '.dev-local', 'query-no-shift', `columns-${kind.replace(/ /g, '-')}-${width}.png`) });
        await p.evaluate(() => window.postMessage({ type: 'query.goTo', start: 'results' }, '*'));
        await expect(p.locator('#queryTable tbody tr:not(.dbmn-table-spacer)').first()).toBeVisible();
        await p.waitForTimeout(600);
        const results = await where(p);
        await p.screenshot({ path: join(ROOT, '.dev-local', 'query-no-shift', `results-${kind.replace(/ /g, '-')}-${width}.png`) });
        console.log(width, JSON.stringify({ columns, results }));
        expect(results.name, 'the name stays where it was').toEqual(columns.name);
        expect(results.slots, 'every slot keeps its left and right edges').toEqual(columns.slots);
        expect(results.back, 'Back stays where it was').toEqual(columns.back);
        // the name line (the name to the last slot) centred in the window, as on every step
        const line = [results.name[0], results.slots[results.slots.length - 1][1]];
        expect(Math.abs((line[0] + line[1]) / 2 - width / 2), `the name line centred (${line})`).toBeLessThanOrEqual(110);
        // the controls: one line, centred in the window, inside it
        expect(new Set(results.controlsTop).size, `one line (tops ${results.controlsTop})`).toBe(1);
        expect(Math.abs((results.controls[0] + results.controls[1]) / 2 - width / 2), 'centred').toBeLessThanOrEqual(12);
        expect(results.page).toBeLessThanOrEqual(width);
    });
}
