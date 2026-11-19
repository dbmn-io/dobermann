/**
 * <dbmn-map> (shared/dbmn-map.js) in a real browser from the real files: which column in each
 * source is which, a line at a time.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/dbmn-map.css'];

const page = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-focusBorder:#4daafc}
.tone-a{--compare-c:#4daafc}.tone-b{--compare-c:#f0a050}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;width:1000px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
<script>${read('shared/dbmn-map.js')}</script></head><body>
<dbmn-map id="map" label="Map"></dbmn-map>
<script>
  const map = document.getElementById('map');
  window.told = [];
  ['pick', 'mode', 'fn', 'add', 'remove', 'leftover'].forEach(t => map.addEventListener('dbmn-map-' + t, e => window.told.push([t, e.detail])));
  map.modes = [{ id: 'key', label: 'Key' }, { id: 'strict', label: 'Strict' }, { id: 'skip', label: "Don't compare" }];
  map.keyMode = 'key';
  map.sources = [
    { id: 'bl', name: 'BL · GET /items', short: 'BL', tone: 'tone-a', columns: [{ id: 'sku', name: 'sku' }, { id: 'qty', name: 'qty' }, { id: 'uom', name: 'uom' }] },
    { id: 'c1', name: 'C1 · stock.xlsx', short: 'C1', tone: 'tone-b', columns: [{ id: 'SKU', name: 'SKU' }, { id: 'Counted', name: 'Counted' }, { id: 'Notes', name: 'Notes' }] }
  ];
  map.lines = [
    { id: 'k1', mode: 'key', cells: { bl: { column: 'sku', example: 'A-2207' }, c1: { column: 'SKU', example: 'a-2207', fns: [{ id: 'upper', label: 'Upper case' }], title: 'UPPER(SKU)', agree: 0.5 } } },
    { id: 'l1', mode: 'strict', cells: { bl: { column: 'qty', example: 48 }, c1: { column: 'Counted', example: 47, agree: 0.95 } } },
    { id: 'l2', mode: 'strict', cells: { bl: { column: 'uom' }, c1: { column: null } } }
  ];
  map.matched = { bl: { text: '1,198 rows in BL' }, c1: { text: '298 of 312 match BL', tone: 'warn' } };
</script></body></html>`;

const cell = (p, line, source) => p.locator(`#map .dbmn-map-cell[data-line="${line}"][data-source="${source}"]`);

test('the sources across the top; the key\'s lines under Match on with what matched; the rest under the lines\' heading', async ({ page: p }) => {
    await p.setContent(page());
    await expect(p.locator('#map .dbmn-map-source')).toHaveText(['BL · GET /items', 'C1 · stock.xlsx']);
    await expect(p.locator('#map .dbmn-map-section-title')).toHaveText(['Match on', 'Compare']);
    await expect(p.locator('#map .dbmn-map-matched')).toHaveText(['1,198 rows in BL', '298 of 312 match BL']);
    await expect(p.locator('#map .dbmn-map-matched').nth(1)).toHaveClass(/is-warn/);
    // A box: its column, an example, its functions (written out on ƒ's hover), and how many agree
    await expect(cell(p, 'k1', 'c1').locator('select')).toHaveValue('SKU');
    await expect(cell(p, 'k1', 'c1').locator('.dbmn-map-eg')).toHaveText('e.g. a-2207');
    await expect(cell(p, 'k1', 'c1').locator('.dbmn-map-fn')).toHaveText(['Upper case']);
    await expect(cell(p, 'k1', 'c1').locator('.dbmn-map-fxbtn')).toHaveAttribute('title', 'UPPER(SKU)');
    await expect(cell(p, 'k1', 'c1').locator('.dbmn-map-fxbtn')).toHaveText('ƒ 1');
    // The key's lines show no agreement (the key decides which rows meet); the others do
    await expect(cell(p, 'k1', 'c1').locator('.dbmn-map-agree')).toHaveCount(0);
    await expect(cell(p, 'l1', 'c1').locator('.dbmn-map-agree')).toHaveText('95% of values agree');
    await expect(cell(p, 'l1', 'c1').locator('.dbmn-map-agree')).toHaveClass(/is-good/);
    // A column not in a source: an empty box, its picker says so
    await expect(cell(p, 'l2', 'c1')).toHaveClass(/is-empty/);
    await expect(cell(p, 'l2', 'c1').locator('option:checked')).toHaveText('Not in C1');
    // Columns no line uses wait under each source
    await expect(p.locator('#map .dbmn-map-left').nth(1).locator('.dbmn-map-leftover')).toHaveText(['Notes']);
    await expect(p.locator('#map .dbmn-map-left').nth(0)).toHaveText('All mapped');
});

test('it says what was asked: a column picked, a mode, ƒ, a line added, taken out, or started from a leftover', async ({ page: p }) => {
    await p.setContent(page());
    await cell(p, 'l2', 'c1').locator('select').selectOption('Notes');
    await p.locator('#map .dbmn-map-lead[data-line="l1"] button[data-mode="key"]').click();
    await cell(p, 'l1', 'bl').locator('.dbmn-map-fxbtn').click();
    await p.locator('#map .dbmn-map-add').click();
    await p.locator('#map .dbmn-map-lead[data-line="l2"] .dbmn-map-x').click();
    await p.locator('#map .dbmn-map-leftover', { hasText: 'Notes' }).click();
    expect(await p.evaluate(() => window.told)).toEqual([
        ['pick', { line: 'l2', source: 'c1', column: 'Notes' }],
        ['mode', { line: 'l1', mode: 'key' }],
        ['fn', { line: 'l1', source: 'bl' }],
        ['add', { mode: 'key' }],
        ['remove', { line: 'l2' }],
        ['leftover', { source: 'c1', column: 'Notes' }]
    ]);
});

test('the last line of the key can\'t leave it or be taken out', async ({ page: p }) => {
    await p.setContent(page());
    const lead = p.locator('#map .dbmn-map-lead[data-line="k1"]');
    await expect(lead.locator('.dbmn-map-x')).toBeDisabled();
    await lead.locator('button[data-mode="strict"]').click();
    expect(await p.evaluate(() => window.told)).toEqual([]);
});

test('a function whose lookup table is gone shows as broken; a fixed source shows the line\'s own name, with nothing to pick', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => {
        const map = document.getElementById('map');
        map.keyMode = '';
        map.modes = [{ id: 'required', label: 'Required' }, { id: 'optional', label: 'Optional' }];
        map.sources = [{ id: 'tpl', name: 'The template', fixed: true }, { id: 'file', name: 'stock.csv', columns: [{ id: 'SKU', name: 'SKU' }, { id: 'Site', name: 'Site' }] }];
        map.lines = [{ id: 'f1', name: 'itemId', mode: 'required', cells: { file: { column: 'SKU', example: 'A-2207', fns: [{ id: 'translate', label: 'Lookup: Codes', missing: true }] } } }];
        map.matched = null;
    });
    await expect(p.locator('#map .dbmn-map-section-title')).toHaveText(['Compare']);
    await expect(cell(p, 'f1', 'tpl')).toHaveClass(/is-fixed/);
    await expect(cell(p, 'f1', 'tpl').locator('.dbmn-map-name')).toHaveText('itemId');
    await expect(cell(p, 'f1', 'tpl').locator('select, .dbmn-map-fxbtn')).toHaveCount(0);
    await expect(cell(p, 'f1', 'file').locator('.dbmn-map-fn')).toHaveClass(/is-missing/);
    await expect(p.locator('#map .dbmn-map-left').nth(1).locator('.dbmn-map-leftover')).toHaveText(['Site']);
});

test('no-heads and columns: the screen\'s own slots head it, four columns with empty ones after the sources, every row starting in the gutter', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => { const map = document.getElementById('map'); map.setAttribute('no-heads', ''); map.setAttribute('columns', '4'); map.lines = map.lines; });
    await expect(p.locator('#map .dbmn-map-source, #map .dbmn-map-corner')).toHaveCount(0);
    // Each line: its gutter, two boxes, two empty columns; the next line's gutter starts the next row
    const leads = await p.locator('#map .dbmn-map-lead[data-line]').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(leads).size).toBe(1);
    const k1 = await cell(p, 'k1', 'bl').boundingBox();
    const k1c1 = await cell(p, 'k1', 'c1').boundingBox();
    const grid = await p.locator('#map .dbmn-map-grid').boundingBox();
    // Four columns share what is left of the gutter: each a quarter of it, less the gaps
    const quarter = (grid.width - 170 - 4 * 8) / 4;
    expect(Math.abs(k1.width - quarter)).toBeLessThan(2);
    expect(Math.abs(k1c1.x - (k1.x + k1.width + 8))).toBeLessThan(2);
    await expect(p.locator('#map .dbmn-map-blank')).toHaveCount(2 * 3 + 2 + 2);
});
