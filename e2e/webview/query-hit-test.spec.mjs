/**
 * Query's controls can be reached as a person reaches them (2026-11-23: the ★ in Results' search box looked fine and
 * could not be clicked, the box's text field over it; "save searches is not working at all"). On the real Query page
 * (query-page.ts's template and query-page.js, the host faked), with four views and with three files, at 900, 1100 and
 * 1280px, on Join and Results: every visible button, select and text box is the element a click at its middle lands
 * on (or holds it). Text cut short where it isn't meant to be (no ellipsis) is listed, and fails too.
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

const view = (id, name, columns, extra = {}) => ({ id, name, run: '', runOf: '', endpointName: `${name}`, request: `/api/${name}`, columns: columns.map(c => ({ name: c, sample: 'x' })), rows: 4, ...extra });
const COLS = ['sku', 'name', 'qty', 'colour'];
/** Four request views, Stock joined to the other three on sku. */
const FOUR = {
    type: 'query.state', name: 'Four views', reached: 4, compare: null,
    views: [view('vA', 'Stock', COLS), view('vB', 'Products', ['sku', 'gtin', 'description']), view('vC', 'Bins', ['sku', 'bin']), view('vD', 'Prices', ['sku', 'price'])],
    joins: ['vB', 'vC', 'vD'].map(v => ({ view: v, kind: 'left', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: v, column: 'sku' } }] })),
    columns: [{ view: 'vA', column: 'sku' }, { view: 'vA', column: 'qty' }, { view: 'vB', column: 'description' }, { view: 'vC', column: 'bin' }, { view: 'vD', column: 'price' }],
    total: 0, searches: [{ name: 'Low stock', text: '@qty<5' }]
};
FOUR.resultColumns = FOUR.columns.map(c => ({ ...c, type: 'text' }));
/** Three files, one compare on sku, qty and name compared. */
const file = (id, name) => view(id, name, COLS, { file: `${name}.xlsx`, endpointName: '' });
const grouped = c => ['vA', 'vB', 'vC'].map(v => ({ view: v, column: c, group: c }));
const THREE = {
    type: 'query.state', name: 'c-pack', reached: 4,
    views: [file('vA', 'c-pack-BL'), file('vB', 'c-pack-C1'), file('vC', 'c-pack-C2')],
    compare: { baseline: 'vA', views: ['vA', 'vB', 'vC'] }, statusPlaces: ['c-pack-BL', 'c-pack-C1', 'c-pack-C2'],
    joins: ['vB', 'vC'].map(v => ({ view: v, kind: 'compare', on: [{ left: { view: 'vA', column: 'sku' }, right: { view: v, column: 'sku' } }] })),
    columns: [{ view: 'vA', column: 'sku' }, ...grouped('name'), ...grouped('qty')],
    total: 0, searches: []
};
THREE.resultColumns = THREE.columns.map(c => ({ ...c, type: 'text' }));

async function open(p, state, width, step, compact) {
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    await p.setViewportSize({ width, height: 800 });
    await p.addInitScript(() => { window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m), getState: () => null, setState: () => {} }); });
    const dir = join(ROOT, '.dev-local', 'query-hit-test');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `page-${width}.html`);
    writeFileSync(f, buildQueryPage(asset, { queryId: 'qry-h', name: state.name }));
    await p.goto(pathToFileURL(f).href);
    // (the theme's font, as the web app gives it)
    await p.addStyleTag({ content: ':root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace} body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}' });
    await p.evaluate(([s, c]) => { window.postMessage({ type: 'query.init', name: s.name, reached: 4, prefs: c ? { resultsView: 'compact' } : {} }, '*'); window.postMessage(s, '*'); }, [state, !!compact]);
    await p.evaluate(where => window.postMessage({ type: 'query.goTo', start: where }, '*'), step === 'results' ? 'results' : 'edit');
    if (step === 'join') await p.getByRole('button', { name: /^Next: Join$/ }).click();
    await p.waitForTimeout(400);
    return errors;
}

/** Every visible control a click can't reach at its middle, and every text cut where no ellipsis is meant. */
const problems = () => {
    const out = [];
    const label = el => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.getAttribute('aria-label') || el.textContent || el.value || '').trim().slice(0, 30)}"`;
    const page = document.querySelector('.query-page') || document.body;
    for (const el of page.querySelectorAll('button, select, input:not([type=file]):not([type=hidden]), dbmn-name')) {
        if (el.disabled || el.closest('.hidden, [hidden]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0 || cs.pointerEvents === 'none') continue;
        // (only what is on screen: a control scrolled out of its box is reached by scrolling)
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
        const hit = document.elementFromPoint(x, y);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) out.push(`covered: ${label(el)} under ${label(hit)}`);
    }
    for (const el of page.querySelectorAll('button, label, .query-warn, .query-lead-text, .compare-result-name, .query-adds-label')) {
        const cs = getComputedStyle(el);
        if (el.closest('.hidden, [hidden]') || cs.display === 'none' || cs.textOverflow === 'ellipsis') continue;
        if ((cs.overflowX === 'hidden' || cs.overflow === 'hidden') && el.scrollWidth > el.clientWidth + 1) out.push(`cut: ${label(el)} (${el.scrollWidth} in ${el.clientWidth})`);
    }
    return out;
};

for (const width of [900, 1100, 1280]) {
    for (const [what, state, step, compact] of [['four views, Join', FOUR, 'join'], ['four views, Results', FOUR, 'results'], ['three files, Join', THREE, 'join'], ['three files, Results, Compact', THREE, 'results', true], ['three files, Results, Side by side', THREE, 'results']]) {
        test(`${what} at ${width}px: every control can be clicked, no text cut`, async ({ page: p }) => {
            const errors = await open(p, state, width, step, compact);
            const found = await p.evaluate(`(${problems.toString()})()`);
            await p.screenshot({ path: join(ROOT, '.dev-local', 'query-hit-test', `${what.replace(/\W+/g, '-')}-${width}.png`) });
            expect(errors).toEqual([]);
            expect(found).toEqual([]);
        });
    }
}
