/**
 * The screen band on Run Batch and Logs (James, 2026-11-24: not left full width above their footers until the epic
 * lands): on the REAL pages at 2560 wide the footer's contents and the area above the table sit in the centred
 * --dbmn-band (1280); at 1280 nothing is squeezed (the band is the window).
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
const { buildRunBatchPage } = load('src/screens/run-batch/run-batch-page.ts', { '../pages': pages });
const { buildLogsPage } = load('src/screens/logs/logs-page.ts', { '../pages': pages });
const asset = rel => pathToFileURL(join(ROOT, 'src/webviews', rel)).href;

const SCREENS = {
    'Run Batch': { html: () => buildRunBatchPage(asset, { endpointId: 'ep-1', endpointName: 'Items' }), band: '#csvUploadStep' },
    Logs: { html: () => buildLogsPage(asset), band: '#logsList' }
};

async function open(p, name, width) {
    await p.setViewportSize({ width, height: 900 });
    await p.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => null, setState: () => {} }); });
    const dir = join(ROOT, '.dev-local', 'screens-band');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name.replace(/\W+/g, '-')}.html`);
    writeFileSync(file, SCREENS[name].html());
    await p.goto(pathToFileURL(file).href);
    await p.waitForTimeout(300);
}

/** Where the footer's contents and the banded area's contents sit (the content box: a padded band keeps its padding). */
const measure = (p, sel) => p.evaluate(s => {
    const content = el => { const b = el.getBoundingClientRect(), cs = getComputedStyle(el); return { left: b.left + parseFloat(cs.paddingLeft), right: b.right - parseFloat(cs.paddingRight), width: b.width }; };
    const foot = document.querySelector('dbmn-footer');
    const kids = [...foot.children].filter(k => k.getBoundingClientRect().width > 0).map(k => k.getBoundingClientRect());
    return { foot: { left: Math.min(...kids.map(k => k.left)), right: Math.max(...kids.map(k => k.right)) }, band: content(document.querySelector(s)), page: document.documentElement.scrollWidth };
}, sel);

for (const name of Object.keys(SCREENS)) {
    test(`${name} at 2560: the footer and the area above the table in the centred 1280 band`, async ({ page: p }) => {
        await open(p, name, 2560);
        const m = await measure(p, SCREENS[name].band);
        const lo = (2560 - 1280) / 2, hi = (2560 + 1280) / 2;
        for (const [what, box] of [['footer', m.foot], ['band', m.band]]) {
            expect(box.left, `${what} starts inside the band`).toBeGreaterThanOrEqual(lo - 1);
            expect(box.right, `${what} ends inside the band`).toBeLessThanOrEqual(hi + 1);
            expect(box.left, `${what} near the band's left edge`).toBeLessThan(lo + 40);
        }
        await p.screenshot({ path: join(ROOT, '.dev-local', 'screens-band', `${name.replace(/\W+/g, '-')}-2560.png`) });
    });

    test(`${name} at 1280: nothing squeezed, no sideways scroll`, async ({ page: p }) => {
        await open(p, name, 1280);
        const m = await measure(p, SCREENS[name].band);
        expect(m.page).toBeLessThanOrEqual(1280);
        expect(m.band.left, 'the screen\'s own side room only').toBeLessThan(40);
        expect(m.band.right).toBeGreaterThan(1280 - 40);
        await p.screenshot({ path: join(ROOT, '.dev-local', 'screens-band', `${name.replace(/\W+/g, '-')}-1280.png`) });
    });
}
