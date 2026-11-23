/**
 * Results in Compact, the real Query page (query-page.ts's template and query-page.js, the host faked): × on a compared
 * column's heading takes the column out of the report, every cell of it, and a search naming it again adds it at the end
 * (James, 2026-11-23, kennels: "it added it back in its original spot. I think we should always add it to the end").
 * Before, × on a Compact column only hid it in the table, so the search showed it again where it had been.
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

const COLS = ['sku', 'name', 'breed', 'note'];
const view = (id, name) => ({ id, name, run: '', runOf: '', endpointName: `${name}.xlsx`, columns: COLS.map(c => ({ name: c, sample: '' })) });
const compared = column => [{ view: 'vA', column, group: column }, { view: 'vB', column, group: column }];
const report = [{ view: 'vA', column: 'sku' }, ...compared('name'), ...compared('breed'), ...compared('note')];
const state = columns => ({
    type: 'query.state', name: 'Kennels', reached: 4,
    views: [view('vA', 'kennelA'), view('vB', 'kennelB')],
    compare: { baseline: 'vA', views: ['vA', 'vB'] }, statusPlaces: ['kennelA', 'kennelB'],
    joins: [{ view: 'vB', kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: 'vB', column: 'sku' } }] }],
    columns, resultColumns: columns.map(c => ({ ...c, type: 'text' })), total: 0, searches: []
});

test('Compact: × on breed takes it out of the report; @breed=Beagle adds it back at the end, after note', async ({ page: p }) => {
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.setViewportSize({ width: 1280, height: 700 });
    await p.addInitScript(() => { window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m), getState: () => null, setState: () => {} }); });
    const dir = join(ROOT, '.dev-local', 'query-compact-remove');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildQueryPage(asset, { queryId: 'qry-k', name: 'Kennels' }));
    await p.goto(pathToFileURL(file).href);
    await p.evaluate(s => { window.postMessage({ type: 'query.init', name: s.name, reached: 4, prefs: { resultsView: 'compact' } }, '*'); window.postMessage(s, '*'); window.postMessage({ type: 'query.goTo', start: 'results' }, '*'); }, state(report));
    await expect(p.locator('#queryResultsControls')).toBeVisible();
    const sent = () => p.evaluate(() => window.posted.filter(m => m.type === 'query.setSelect').map(m => m.select.map(c => `${c.view}.${c.column}`)));

    // × on breed's heading, clicked
    await p.getByRole('button', { name: 'Remove breed' }).click();
    await expect.poll(sent).toEqual([['vA.sku', 'vA.name', 'vB.name', 'vA.note', 'vB.note']]);
    // (the host's answer: the report without breed)
    const without = report.filter(c => c.column !== 'breed');
    await p.evaluate(s => window.postMessage(s, '*'), state(without));

    // @breed=Beagle: breed added again, at the end, both cells
    await p.locator('#querySearch').fill('@breed=Beagle');
    await expect.poll(async () => (await sent()).length).toBe(2);
    expect((await sent())[1]).toEqual(['vA.sku', 'vA.name', 'vB.name', 'vA.note', 'vB.note', 'vA.breed', 'vB.breed']);
    expect(errors).toEqual([]);
});
