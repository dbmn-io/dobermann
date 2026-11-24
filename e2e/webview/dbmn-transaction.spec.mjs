/**
 * <dbmn-transaction> (design system, the Console / Run Batch epic #467): one request in full, in a real browser from the
 * real files.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css'];
const SCRIPTS0 = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-table.js'];

const page = () => `<!doctype html><html><head>
<style>:root{--dbmn-foreground:#ccc;--dbmn-editor-background:#1e1e1e;--dbmn-panel-border:#444}
${STYLES.concat(['shared/transaction-card.css', 'shared/buttons.css']).map(read).join('\n')}
body{margin:0;padding:16px;width:1200px;background:#1e1e1e;color:#ccc;font:13px sans-serif} #t{height:520px}</style>
${SCRIPTS0.concat(['shared/dbmn-transaction.js']).map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<dbmn-transaction id="t"></dbmn-transaction>
<script>
  window.heard = [];
  ['dbmn-transaction-move', 'dbmn-transaction-close', 'dbmn-transaction-logs', 'dbmn-transaction-reprocess', 'dbmn-transaction-copied'].forEach(type =>
      document.addEventListener(type, e => window.heard.push([type, e.detail])));
  const items = [{ gtin: '00012345600201', uom: 'EA' }, { gtin: '00012345600202', uom: 'BOX' }];
  window.sent = { id: 'tx-2', n: 2, status: 'error', http: 422, timeMs: 96, sent: '20:14:02', rowStart: 201, rowEnd: 202,
      reason: 'violates check constraint "uom_check"', method: 'POST', url: 'http://127.0.0.1/inventory', query: [{ name: 'upsert', value: 'true' }],
      requestHeaders: [{ name: 'org', value: 'WOOF' }], responseHeaders: [{ name: 'x-request-id', value: '9e3779b1' }],
      requestBody: JSON.stringify(items), responseBody: JSON.stringify({ code: '23514', error: 'uom_check' }),
      reprocess: true, logs: true, previous: false, next: true };
  window.ready = { id: 'rq-3', n: 3, status: 'ready', rowStart: 401, rowEnd: 402, method: 'POST', url: '/inventory', requestHeaders: [], requestBody: JSON.stringify(items), previous: true, next: true };
  window.input = { columns: ['gtin', 'uom'], rows: [['00012345600201', 'EA'], ['00012345600202', 'BOX']] };
  const t = document.getElementById('t');
  t.transaction = sent; t.input = input;
</script></body></html>`;
const heard = p => p.evaluate(() => window.heard.splice(0));
const panes = p => p.locator('#t .dbmn-tx-pane:not([hidden])').evaluateAll(list => list.map(el => el.dataset.part));

test('a sent transaction: its figures, the reason, Request and Response shown (Input off), JSON indented; Body / Details and Body / Headers', async ({ page: p }) => {
    await p.setContent(page());
    await expect(p.locator('#t .dbmn-tx-title')).toHaveText('Transaction #002');
    await expect(p.locator('#t .raw-status-badge')).toHaveText('ERROR');
    await expect(p.locator('#t .raw-http-status')).toHaveText('422');
    await expect(p.locator('#t .dbmn-tx-facts')).toHaveText('96ms · 20:14:02 · input rows 201–202');
    await expect(p.locator('#t .dbmn-tx-reason')).toContainText('uom_check');
    expect(await panes(p)).toEqual(['request', 'response']);
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre')).toContainText('"gtin": "00012345600201"');
    await p.locator('#t .dbmn-tx-pane[data-part="request"] .raw-view-mode-btn[data-mode="details"]').click();
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre')).toContainText('POST http://127.0.0.1/inventory');
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre')).toContainText('upsert = true');
    await p.locator('#t .dbmn-tx-pane[data-part="response"] .raw-view-mode-btn[data-mode="headers"]').click();
    await expect(p.locator('#t .dbmn-tx-pane[data-part="response"] pre')).toHaveText('x-request-id: 9e3779b1');
    // The two panes side by side
    const [a, b] = await p.locator('#t .dbmn-tx-pane').evaluateAll(l => l.map(e => e.getBoundingClientRect().top));
    expect(Math.abs(a - b)).toBeLessThan(2);
});

test('Show: Input on gives its rows in a dbmn-table; the choices and modes stay when it moves to another; a Ready request greys Response', async ({ page: p }) => {
    await p.setContent(page());
    await p.locator('#t .dbmn-tx-seg-btn[data-part="input"]').click();
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
    await expect(p.locator('#t .dbmn-tx-pane[data-part="input"] dbmn-table tbody tr')).toHaveCount(2);
    await p.locator('#t .dbmn-tx-pane[data-part="request"] .raw-view-mode-btn[data-mode="details"]').click();
    await p.evaluate(() => { t.transaction = { ...sent, n: 3, id: 'tx-3' }; t.input = input; });
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] .raw-view-mode-btn.active')).toHaveText('Details');
    await p.evaluate(() => { t.transaction = ready; t.input = input; });
    await expect(p.locator('#t .dbmn-tx-title')).toHaveText('Request #003');
    await expect(p.locator('#t .raw-status-badge')).toHaveText('READY');
    await expect(p.locator('#t .dbmn-tx-seg-btn[data-part="response"]')).toBeDisabled();
    expect(await panes(p)).toEqual(['input', 'request']);
    await expect(p.locator('#t .dbmn-tx-reprocess')).toHaveCount(0);
});

test('search marks what it finds in every pane and says how many; ⤢ fills the window with one pane, Esc puts it back', async ({ page: p }) => {
    await p.setContent(page());
    await p.locator('#t .dbmn-tx-search').fill('0001234560020');
    await expect(p.locator('#t mark.dbmn-tx-hit')).toHaveCount(2);
    await expect(p.locator('#t .dbmn-tx-found')).toHaveText('2 found');
    await p.locator('#t .dbmn-tx-pane[data-part="response"] .dbmn-tx-max').click();
    expect(await panes(p)).toEqual(['response']);
    await p.locator('#t .dbmn-tx-pane[data-part="response"] pre').click();
    await p.keyboard.press('Escape');
    expect(await panes(p)).toEqual(['request', 'response']);
    expect(await heard(p)).toEqual([]);   // Esc put the pane back; it did not close (not a window)
});

test('the buttons and keys say what was asked: ↓ (↑ off at the first), Logs, Reprocess, Copy All; as a window ✕ and Esc close', async ({ page: p }) => {
    await p.setContent(page());
    await expect(p.locator('#t .dbmn-tx-prev')).toBeDisabled();
    await p.locator('#t .dbmn-tx-next').click();
    await p.locator('#t .dbmn-tx-logs').click();
    await p.locator('#t .dbmn-tx-reprocess').click();
    await p.locator('#t .dbmn-tx-title').click();
    await p.keyboard.press('ArrowDown');
    await p.keyboard.press('ArrowUp');   // (off: the first)
    expect(await heard(p)).toEqual([['dbmn-transaction-move', { by: 1 }], ['dbmn-transaction-logs', { id: 'tx-2' }],
        ['dbmn-transaction-reprocess', { id: 'tx-2' }], ['dbmn-transaction-move', { by: 1 }]]);
    await p.evaluate(() => { t.setAttribute('window', ''); t.connectedCallback(); t.focus(); });
    await p.keyboard.press('Escape');
    await p.locator('#t .dbmn-tx-close').click();
    expect((await heard(p)).map(x => x[0])).toEqual(['dbmn-transaction-close', 'dbmn-transaction-close']);
});

test('reads as Raw\'s card did: JSON Lines as Lines or Pretty with its record count; HTML as Raw, Render or Text; a GET starts with Request off', async ({ page: p }) => {
    await p.setContent(page());
    // JSON Lines
    await p.evaluate(() => { t.transaction = { ...sent, responseBody: '{"a":1}\n{"a":2}\nnot json\n{"a":3}', responseHeaders: [] }; });
    await expect(p.locator('#t .dbmn-tx-pane[data-part="response"] .dbmn-tx-pane-title')).toHaveText('RESPONSE (JSONL · 3 records · 1 line not JSON)');
    await expect(p.locator('#t .dbmn-tx-pane[data-part="response"] pre')).toContainText('{"a":2}');
    await p.locator('#t .dbmn-tx-formats [data-format="pretty"]').click();
    await expect(p.locator('#t .dbmn-tx-pane[data-part="response"] pre')).toContainText('"a": 3');
    // HTML
    await p.evaluate(() => { t.transaction = { ...sent, responseBody: '<html><body><h1>Down</h1><script>window.ran = 1</script></body></html>', contentType: 'text/html', responseHeaders: [] }; });
    await expect(p.locator('#t .dbmn-tx-formats [data-format]')).toHaveText(['Raw', 'Render', 'Text']);
    await p.locator('#t .dbmn-tx-formats [data-format="render"]').click();
    expect(await p.evaluate(() => document.querySelector('#t .dbmn-tx-render').shadowRoot.querySelector('h1').textContent)).toBe('Down');
    expect(await p.evaluate(() => window.ran)).toBeUndefined();
    await p.locator('#t .dbmn-tx-formats [data-format="text"]').click();
    await expect(p.locator('#t .dbmn-tx-pane[data-part="response"] pre')).toHaveText('Down');
    // A GET: no body, Request off at the start; Details still there when shown
    await p.evaluate(() => { const fresh = document.createElement('dbmn-transaction'); fresh.id = 't2'; document.body.append(fresh); fresh.transaction = { ...sent, method: 'GET', requestBody: '' }; });
    await expect(p.locator('#t2 .dbmn-tx-seg-btn[data-part="request"]')).toHaveAttribute('aria-pressed', 'false');
    await expect(p.locator('#t2 .dbmn-tx-pane[data-part="request"]')).toHaveCount(0);
});
