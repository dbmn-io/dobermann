/**
 * Results' totals in a compare, Side by side (James, 2026-11-24: "the cells that are different should get a standard
 * background for a DIFF… the cell gets a diff colour, and the pop up also gives the coloured background"): a total
 * unlike the Baseline's wears the DIFF class in the totals row and on its line in the totals card; the Baseline's and
 * an alike one don't. The real Query page, the host faked.
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

const view = (id, name) => ({ id, name, run: '', runOf: '', endpointName: `${name}.xlsx`, file: `${name}.xlsx`, columns: ['sku', 'qty', 'uom'].map(c => ({ name: c, sample: '' })) });
const compared = (c, type) => [{ view: 'vA', column: c, group: c, type }, { view: 'vB', column: c, group: c, type }, { view: 'vC', column: c, group: c, type }];
const STATE = {
    type: 'query.state', name: 'stock', reached: 4,
    views: [view('vA', 'stockBL'), view('vB', 'stockC1'), view('vC', 'stockC2')],
    compare: { baseline: 'vA', views: ['vA', 'vB', 'vC'] }, statusPlaces: ['stockBL', 'stockC1', 'stockC2'],
    joins: [{ view: 'vB', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] },
        { view: 'vC', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vC', column: 'sku' } }] }],
    columns: [{ view: 'vA', column: 'sku' }, ...compared('qty', 'number').map(({ view, column, group }) => ({ view, column, group }))],
    resultColumns: [{ view: 'vA', column: 'sku', type: 'text' }, ...compared('qty', 'number')], total: 3
};
// qty: BL and C1 alike in total (one row moves 5 between them), C2 short by 30
const ROWS = [['A1', 100, 105, 100], ['A2', 200, 195, 170], ['A3', 300, 300, 300]];
const STATUS = [{ diff: ['stockC1'], missing: [] }, { diff: ['stockC1', 'stockC2'], missing: [] }, { diff: [], missing: [] }];
const TOTALS = [null, 600, 600, 570];

test('Side by side with Totals: the total unlike the Baseline\'s wears the DIFF colour, in the row and in its card', async ({ page: p }) => {
    await p.setViewportSize({ width: 1600, height: 700 });
    await p.addInitScript(({ rows, status, totals }) => {
        window.acquireVsCodeApi = () => ({ postMessage: m => {
            if (m.type === 'query.rows') setTimeout(() => window.postMessage({ type: 'query.rowsData', seq: m.seq, offset: m.offset, rows, status, index: rows.map((_, i) => i), shown: rows.length, total: rows.length, ...(m.totals ? { totals } : {}) }, '*'), 10);
        }, getState: () => null, setState: () => {} });
    }, { rows: ROWS, status: STATUS, totals: TOTALS });
    const dir = join(ROOT, '.dev-local', 'query-totals-diff');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-t', name: 'stock' }));
    await p.goto(pathToFileURL(file).href);
    await p.addStyleTag({ content: ':root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-background:#1e1e1e;--vscode-foreground:#ccc;--vscode-panel-border:#444} body{background:#1e1e1e;color:#ccc;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}' });
    await p.evaluate(s => { window.postMessage({ type: 'query.init', name: s.name, reached: 4, prefs: {} }, '*'); window.postMessage(s, '*'); window.postMessage({ type: 'query.goTo', start: 'results' }, '*'); }, STATE);
    await expect(p.locator('#queryTable tbody tr:not(.dbmn-table-spacer)').first()).toBeVisible();
    await p.locator('#queryTotals').click();
    const feet = p.locator('#queryTable tfoot td');
    await expect(feet.filter({ hasText: '570' })).toHaveCount(1);
    // the totals row: C2's 570 marked; BL's 600 and C1's alike 600 not
    const marks = await feet.evaluateAll(tds => tds.map(td => [td.textContent.trim(), td.classList.contains('compare-differs')]));
    expect(marks.filter(([, m]) => m).map(([t]) => t)).toEqual(['570']);
    // (tinted as a differing cell is, over a solid background: the totals stay at the box's foot over the rows, and a
    // see-through tint showed the row scrolled under it through the figure; James, 2026-11-25)
    const bg = await feet.filter({ hasText: '570' }).evaluate(td => { const s = getComputedStyle(td); return { color: s.backgroundColor, image: s.backgroundImage }; });
    expect(bg.color, 'a solid background under the tint').toMatch(/^rgb\(/);
    expect(bg.image, 'the DIFF tint').toContain('gradient');
    // the card: hovering a qty total opens it; C2's line (name and value) marked and tinted, the others not
    await feet.filter({ hasText: '570' }).hover();
    const card = p.locator('.dbmn-total-card');
    await expect(card).toBeVisible();
    const lines = await card.locator('.dbmn-total-card-value').evaluateAll(vs => vs.map(v => [v.textContent.trim(), v.classList.contains('compare-differs'), getComputedStyle(v).backgroundColor]));
    expect(lines.map(([t, m]) => [t, m])).toEqual([['600', false], ['600', false], ['570', true]]);
    expect(lines[2][2]).not.toBe('rgba(0, 0, 0, 0)');
    await p.screenshot({ path: join(dir, 'totals-card.png') });
});
