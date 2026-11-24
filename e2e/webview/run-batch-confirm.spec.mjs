/**
 * Run Batch's one Execute confirmation (#470), on the REAL Run Batch page, the host faked: Execute asks the host
 * (runBatch.executeAsk), the window says the run in one sentence, offers Error handling and Threads as Review set
 * them, folds the production guard in (<dbmn-guard-line>), and its one button says Execute. Its choices go back
 * with the run (executeBulkLoadCommand.confirm); Cancel runs nothing and gives Execute back.
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
const asset = rel => pathToFileURL(join(ROOT, 'src/webviews', rel)).href;


const SUMMARY = (guard) => ({
    rows: 1000, requests: 100, rowsPerRequest: { label: 'Rows per request', value: 10 }, method: 'POST', url: 'https://api.example.test/inventory',
    environment: { name: guard ? 'Prod' : 'Test', production: !!guard, headers: [{ name: 'ORG', value: 'DM1' }] },
    errorHandling: { value: 'continue', options: [{ value: 'continue', label: 'Continue processing' }, { value: 'stop', label: 'Stop on first error' }] },
    threads: { value: 1, options: [1, 2, 4] },
    guard: guard ? { environment: 'Prod', line: 'Prod is a production environment.', ask: true, frequency: { label: 'Warning frequency', value: '0', options: [{ value: '0', label: 'Warn me every time' }, { value: '15', label: "Don't warn again for 15 minutes" }, { value: '30', label: "Don't warn again for 30 minutes" }, { value: '60', label: "Don't warn again for 60 minutes" }] }, confirmLabel: 'Execute on production' } : null,
    sentence: `1,000 rows as 100 requests to ${guard ? 'Prod' : 'Test'} (ORG DM1): POST https://api.example.test/inventory`
});

async function open(p, guard) {
    await p.setViewportSize({ width: 1280, height: 800 });
    await p.addInitScript(summary => {
        window.posted = [];
        window.acquireVsCodeApi = () => ({ postMessage: m => {
            window.posted.push(m);
            if (m.type === 'runBatch.executeAsk') { window.asked = m; setTimeout(() => window.postMessage({ type: 'runBatch.executeConfirm', summary }, '*'), 10); }
        }, getState: () => null, setState: () => {} });
    }, SUMMARY(guard));
    const dir = join(ROOT, '.dev-local', 'run-batch-confirm');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'page.html');
    writeFileSync(file, buildRunBatchPage(asset, { endpointId: 'ep-1', endpointName: 'Inventory' }));
    await p.goto(pathToFileURL(file).href);
    await p.waitForTimeout(300);
    // (Review's own Error Handling and Threads, as the window starts from them; its Summary: 1,000 rows, Rows per request
    // 10, 100 API calls; and its Execute button spinning, as Execute leaves it while the window is open)
    await p.evaluate(() => {
        const put = (id, tag, text) => { let el = document.getElementById(id); if (!el) { el = document.createElement(tag); el.id = id; document.body.appendChild(el); } if (tag === 'input') el.value = text; else el.textContent = text; };
        put('batchRowsDisplay', 'span', '1,000'); put('totalApiCallsDisplay', 'span', '100'); put('elementsInput', 'input', '10');
        put('csvExecuteBtn', 'button', '');
        document.getElementById('csvExecuteBtn').innerHTML = '<span class="btn-spinner"></span> Processing...';
        const mode = document.getElementById('batchErrorModeSelect'); if (mode) mode.value = 'continue';
        const t = document.getElementById('processingModeDropdown');
        if (t) { t.innerHTML = '<option value="1">1</option><option value="2">2</option><option value="4">4</option>'; t.value = '2'; }
    });
    // Execute, as the page sends it (data-transformer / dt-type-coercion), through the confirmation
    await p.evaluate(() => window.RunBatchConfirm.send({ type: 'executeBulkLoadCommand', endpointId: 'ep-1', jsonData: [{ a: 1 }] }, m => window.acquireVsCodeApi().postMessage(m)));
    return p.locator('.dbmn-modal');
}
const runs = p => p.evaluate(() => window.posted.filter(m => m.type === 'executeBulkLoadCommand'));

test('the window says the run in one sentence; Error handling and Threads from Review; one Execute; its choices go with the run', async ({ page: p }) => {
    const modal = await open(p, false);
    await expect(modal).toBeVisible();
    // The host's sentence, as it planned the run (the count is the host's: run-batch.controller.test's "as it will be sent")
    await expect(modal).toContainText('1,000 rows as 100 requests to Test (ORG DM1): POST https://api.example.test/inventory');
    expect(await p.evaluate(() => window.asked)).toEqual({ type: 'runBatch.executeAsk' });
    await expect(modal.getByText('Continue processing')).toBeVisible();
    await expect(modal.getByText('Keep going')).toHaveCount(0);
    await expect(modal.locator('dbmn-guard-line')).toHaveCount(0);
    await expect(modal.locator('.dbmn-modal-footer button, [data-action-id]').filter({ hasText: /Execute/ })).toHaveText(['Execute']);
    await expect(modal.locator('select')).toHaveValue('2');
    await modal.getByLabel('Stop on first error').check();
    await p.screenshot({ path: join(ROOT, '.dev-local', 'run-batch-confirm', 'confirm.png') });
    await modal.locator('[data-action-id="execute"]').click();
    await expect.poll(() => runs(p)).toHaveLength(1);
    expect((await runs(p))[0]).toMatchObject({ endpointId: 'ep-1', confirm: { errorHandling: 'stop', threads: 2 } });
    expect((await runs(p))[0].confirm.production).toBeUndefined();
});

test('production: the guard\'s line and Warning frequency in the same window; its choice goes with the run', async ({ page: p }) => {
    const modal = await open(p, true);
    await expect(modal.locator('dbmn-guard-line')).toBeVisible();
    await expect(modal.locator('dbmn-guard-line')).toContainText('Prod is a production environment.');
    await expect(modal.locator('[data-action-id="execute"]')).toHaveText('Execute');
    await modal.locator('dbmn-guard-line select').selectOption('15');
    await p.screenshot({ path: join(ROOT, '.dev-local', 'run-batch-confirm', 'confirm-production.png') });
    await modal.locator('[data-action-id="execute"]').click();
    await expect.poll(() => runs(p)).toHaveLength(1);
    expect((await runs(p))[0].confirm).toMatchObject({ errorHandling: 'continue', threads: 2, production: { minutes: 15 } });
});

test('Cancel: nothing runs, Execute comes back', async ({ page: p }) => {
    const modal = await open(p, true);
    await expect(modal).toBeVisible();
    const reset = p.evaluate(() => new Promise(done => window.addEventListener('message', e => { if (e.data && e.data.type === 'resetExecuteButton') done(true); })));
    await modal.locator('[data-action-id="cancel"]').click();
    expect(await reset).toBe(true);
    expect(await runs(p)).toHaveLength(0);
    // (the page's own handler gives the button back: "Execute", no spinner)
    await expect(p.locator('#csvExecuteBtn')).toHaveText('Execute');
    await expect(p.locator('#csvExecuteBtn')).toBeEnabled();
});
