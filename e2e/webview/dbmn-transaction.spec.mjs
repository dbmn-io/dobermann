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

test('a sent transaction: its figures, the reason, once answered the input rows across the top and the request and response side by side below (before, input and request side by side), JSON indented and coloured; Body / Details and Body / Headers', async ({ page: p }) => {
    await p.setContent(page());
    await expect(p.locator('#t .dbmn-tx-title')).toHaveText('Transaction #002');
    await expect(p.locator('#t .raw-status-badge')).toHaveText('Error');
    await expect(p.locator('#t .raw-http-status')).toHaveText('422');
    await expect(p.locator('#t .dbmn-tx-facts')).toHaveText('96ms · 20:14:02 · input rows 201–202');
    await expect(p.locator('#t .dbmn-tx-reason')).toContainText('uom_check');
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre')).toContainText('"gtin": "00012345600201"');
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre .dbmn-tok-key').first()).toHaveText('"gtin"');
    // One line across the top: the search on it, no Show row, no Copy All
    await expect(p.locator('#t .dbmn-tx-head .dbmn-tx-search')).toHaveCount(1);
    await expect(p.locator('#t .dbmn-tx-copy-all, #t .dbmn-tx-seg-btn')).toHaveCount(0);
    await p.locator('#t .dbmn-tx-pane[data-part="request"] .raw-view-mode-btn[data-mode="details"]').click();
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre')).toContainText('POST http://127.0.0.1/inventory');
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] pre')).toContainText('upsert = true');
    await p.locator('#t .dbmn-tx-pane[data-part="response"] .raw-view-mode-btn[data-mode="headers"]').click();
    await expect(p.locator('#t .dbmn-tx-pane[data-part="response"] pre')).toHaveText('x-request-id: 9e3779b1');
    // The input rows across the top, the request and the response side by side below (James, 2026-11-25)
    const box = part => p.locator(`#t .dbmn-tx-pane[data-part="${part}"]`).evaluate(e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, bottom: r.bottom }; });
    const [inp, req, res] = [await box('input'), await box('request'), await box('response')];
    expect(req.y, 'request below the input rows').toBeGreaterThanOrEqual(inp.bottom);
    expect(Math.abs(req.y - res.y), 'request and response side by side').toBeLessThan(2);
    expect(res.x, 'response right of request').toBeGreaterThan(req.x);
    expect(inp.w, 'input rows the whole width').toBeGreaterThan(req.w + res.w);
    // Before a response (a Ready request): the input rows and the request side by side
    await p.evaluate(() => { t.transaction = ready; t.input = input; });
    const [inp2, req2] = [await box('input'), await box('request')];
    expect(Math.abs(inp2.y - req2.y), 'input and request side by side').toBeLessThan(2);
    expect(req2.x, 'request right of the input rows').toBeGreaterThan(inp2.x);
    await p.evaluate(() => { t.transaction = sent; t.input = input; });
});

test('the input rows in a dbmn-table filling their pane; the modes stay when it moves to another; a Ready request has no Response', async ({ page: p }) => {
    await p.setContent(page());
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
    await expect(p.locator('#t .dbmn-tx-pane[data-part="input"] dbmn-table tbody tr')).toHaveCount(2);
    await p.locator('#t .dbmn-tx-pane[data-part="request"] .raw-view-mode-btn[data-mode="details"]').click();
    await p.evaluate(() => { t.transaction = { ...sent, n: 3, id: 'tx-3' }; t.input = input; });
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
    await expect(p.locator('#t .dbmn-tx-pane[data-part="request"] .raw-view-mode-btn.active')).toHaveText('Details');
    await p.evaluate(() => { t.transaction = ready; t.input = input; });
    await expect(p.locator('#t .dbmn-tx-title')).toHaveText('Request #003');
    await expect(p.locator('#t .raw-status-badge')).toHaveText('Ready');
    expect(await panes(p)).toEqual(['input', 'request']);
    // (the table as tall as its pane)
    const [pane, table] = await p.locator('#t .dbmn-tx-pane[data-part="input"]').evaluate(e => [e.getBoundingClientRect().bottom, e.querySelector('dbmn-table').getBoundingClientRect().bottom]);
    expect(pane - table).toBeLessThan(4);
    await expect(p.locator('#t .dbmn-tx-reprocess')).toHaveCount(0);
});

test('no input rows (a GET from Run API): no Input pane at all, the request and response taking the height', async ({ page: p }) => {
    await p.setContent(page());
    // (James, 2026-11-25: "When there's no input we've got to hide the input section. So for a get, this is showing.")
    const get = { id: 'tx-9', n: 1, status: 'completed', http: 200, timeMs: 40, sent: '21:02:11', rowStart: 1, rowEnd: 1, method: 'GET',
        url: 'http://127.0.0.1/reference/carriers', requestHeaders: [], responseHeaders: [], responseBody: JSON.stringify([{ scac: 'WOOF' }]), previous: false, next: false };
    await p.evaluate(g => { t.transaction = g; t.input = { columns: [], rows: [] }; }, get);
    expect(await panes(p)).toEqual(['request', 'response']);
    await expect(p.locator('#t')).not.toContainText('No rows');
    // (the two panes from the top of the window's body to its bottom: no strip left where Input was)
    const [box, request, response] = await p.locator('#t').evaluate(el => [el, el.querySelector('.dbmn-tx-pane[data-part="request"]'), el.querySelector('.dbmn-tx-pane[data-part="response"]')]
        .map(e => { const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }));
    expect(Math.abs(request.bottom - response.bottom)).toBeLessThan(2);
    expect(box.bottom - request.bottom).toBeLessThan(24);
    // ...and an input known to have rows still shows them; before the input has come, a request with rows keeps its place
    await p.evaluate(() => { t.transaction = sent; t.input = input; });
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
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
    expect(await panes(p)).toEqual(['input', 'request', 'response']);
    expect(await heard(p)).toEqual([]);   // Esc put the pane back; it did not close (not a window)
});

test('the buttons and keys say what was asked: ↓ (↑ off at the first), Logs, Reprocess; as a window ✕ and Esc close', async ({ page: p }) => {
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

test('as a window it is the app\'s one modal (DbmnModal, headerless): the footer covered, a click outside closes it, Tab stays in, nothing left after', async ({ page: p }) => {
    await p.setContent(page());
    // (opened as the Requests table opens it: dbmn-requests.js windowFor)
    await p.evaluate(() => {
        const w = document.createElement('dbmn-transaction');
        w.id = 'w';
        w.setAttribute('window', '');
        w.addEventListener('dbmn-transaction-close', () => window.DbmnModal.requestDismiss());
        window.txClosed = 0;
        window.DbmnModal.show({ title: 'Transaction', headerless: true, body: w, size: 'transaction', actions: [], dismissible: true }).then(() => { window.txClosed++; w.remove(); });
        w.transaction = sent;
        w.focus();
    });
    const modal = p.locator('.dbmn-modal.dbmn-modal-transaction');
    await expect(modal).toHaveCount(1);
    await expect(modal.locator('.dbmn-modal-header'), 'its own top line, not the modal\'s').toHaveCount(0);
    await expect(modal.locator('#w .dbmn-tx-title')).toHaveText('Transaction #002');
    // (over the screen's footer: a fixed footer at its usual level, 1000, is under the modal's backdrop)
    const covered = await p.evaluate(() => {
        const f = document.createElement('div');
        Object.assign(f.style, { position: 'fixed', left: '0', right: '0', bottom: '0', height: '40px', zIndex: '1002' });
        document.body.append(f);
        const hit = document.elementFromPoint(10, window.innerHeight - 10);
        f.remove();
        return hit && hit.className;
    });
    expect(covered, 'the footer is under the backdrop').toBe('dbmn-modal-backdrop');
    // Tab never leaves it; Enter in its search does not close it
    await p.locator('#w .dbmn-tx-close').focus();
    for (let i = 0; i < 12; i++) await p.keyboard.press('Tab');
    expect(await p.evaluate(() => document.querySelector('.dbmn-modal').contains(document.activeElement)), 'Tab stays in the window').toBe(true);
    await p.locator('#w .dbmn-tx-search').fill('SKU');
    await p.locator('#w .dbmn-tx-search').press('Enter');
    await expect(modal).toHaveCount(1);
    // a click outside closes it, and nothing of it is left
    await p.mouse.click(4, 4);
    await expect(modal).toHaveCount(0);
    expect(await p.evaluate(() => [window.txClosed, document.querySelectorAll('dbmn-transaction#w, .dbmn-modal-backdrop').length])).toEqual([1, 0]);
    // its ✕ closes it the same way
    await p.evaluate(() => {
        const w = document.createElement('dbmn-transaction');
        w.id = 'w2'; w.setAttribute('window', '');
        w.addEventListener('dbmn-transaction-close', () => window.DbmnModal.requestDismiss());
        window.DbmnModal.show({ title: 'Transaction', headerless: true, body: w, size: 'transaction', actions: [], dismissible: true }).then(() => w.remove());
        w.transaction = sent;
    });
    await p.locator('#w2 .dbmn-tx-close').click();
    await expect(p.locator('.dbmn-modal-backdrop')).toHaveCount(0);
});

test('reads as Raw\'s card did: JSON Lines as Lines or Pretty with its record count; HTML as Raw, Render or Text; a GET\'s request as its Details', async ({ page: p }) => {
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
    // A GET: no body, its request shown as its Details
    await p.evaluate(() => { const fresh = document.createElement('dbmn-transaction'); fresh.id = 't2'; document.body.append(fresh); fresh.transaction = { ...sent, method: 'GET', requestBody: '' }; });
    await expect(p.locator('#t2 .dbmn-tx-pane[data-part="request"] pre')).toContainText('GET http://127.0.0.1/inventory');
});

// ── As the screens open it (dbmn-requests windowFor), in the page's real Monaco (the CDN copy, served from node_modules) ──
const MONACO = join(ROOT, 'node_modules/monaco-editor/min/');
const CDN = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/';
const opener = () => `<!doctype html><html><head>
<style>${STYLES.concat(['shared/transaction-card.css', 'shared/buttons.css']).map(read).join('\n')}
body{margin:0;padding:16px;width:1200px;height:700px;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS0.concat(['shared/dbmn-transaction.js', 'shared/dbmn-code-pane.js']).map(rel => `<script>${read(rel)}</script>`).join('\n')}
<script src="${CDN}vs/loader.js"></script><script>${read('shared/monaco-loader-config.js')}</script></head><body>
<button id="row">#002 · error</button><input id="pageSearch" placeholder="the table's search">
<script>
  const body = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ gtin: '000123456' + String(i).padStart(5, '0'), uom: 'EA', qty: i })), null, 2);
  window.full = { id: 'tx-2', n: 2, status: 'error', http: 422, timeMs: 96, sent: '20:14:02', rowStart: 1, rowEnd: 40, method: 'POST', url: 'http://127.0.0.1/inventory',
      query: [], requestHeaders: [{ name: 'org', value: 'WOOF' }], responseHeaders: [{ name: 'x-request-id', value: '9e3779b1' }],
      requestBody: body, responseBody: JSON.stringify({ code: '23514', error: 'uom_check' }), previous: false, next: true };
  window.closes = 0;
  /** Open as dbmn-requests does: the window, its editor hook, focus a moment later, the row's figures then its bodies. */
  window.openTx = async () => {
      const tx = document.createElement('dbmn-transaction');
      tx.setAttribute('window', '');
      tx.addEventListener('dbmn-transaction-close', () => { tx.remove(); window.closes++; });
      tx.editor = window.DbmnCodePane.make;
      window.DbmnCodePane.whenReady(() => { if (tx.isConnected) tx.refreshEditors(); });
      document.body.appendChild(tx);
      setTimeout(() => tx.focus(), 0);
      tx.transaction = Object.assign({}, full, { requestBody: undefined, responseBody: undefined });
      tx.input = { columns: ['gtin', 'uom'], rows: [['00012345600001', 'EA']] };
      await new Promise(r => setTimeout(r, 30));
      tx.transaction = full;
      return true;
  };
  window.live = () => ({ windows: document.querySelectorAll('dbmn-transaction').length, backdrops: document.querySelectorAll('.dbmn-modal-backdrop').length,
      editors: window.monaco ? monaco.editor.getEditors().length : -1, models: window.monaco ? monaco.editor.getModels().length : -1 });
</script></body></html>`;

async function withMonaco(p) {
    await p.route(`${CDN}**`, route => route.fulfill({ path: join(MONACO, new URL(route.request().url()).pathname.replace('/npm/monaco-editor@0.45.0/min/', '')) }));
    await p.setContent(opener());
    await p.waitForFunction(() => new Promise(done => window.DbmnCodePane.whenReady(() => done(true))));
}
const open = async p => { await p.evaluate(() => openTx()); await expect(p.locator('dbmn-transaction .dbmn-tx-pane[data-part="request"] [data-editor="monaco"]')).toHaveCount(1); };

test('Esc closes the window from wherever focus is: the page under it, the window, its search, its editor; ⤢ first puts a pane back, then Esc closes', async ({ page: p }) => {
    await withMonaco(p);
    const tries = [
        ['the row clicked to open it (focus left on the page)', async () => { await p.locator('#row').focus(); }],
        ['the window itself', async () => { await p.locator('dbmn-transaction').focus(); }],
        ['its search box', async () => { await p.locator('dbmn-transaction input.dbmn-tx-search').focus(); }],
        ['its editor', async () => { await p.locator('dbmn-transaction .dbmn-tx-pane[data-part="request"] .monaco-editor textarea').focus(); }],
        ['the page\'s own search box', async () => { await p.locator('#pageSearch').focus(); }]
    ];
    for (let round = 0; round < 4; round++) {
        for (const [where, focus] of tries) {
            await open(p);
            await focus();
            await p.keyboard.press('Escape');
            await expect(p.locator('dbmn-transaction'), `round ${round + 1}, Esc from ${where}`).toHaveCount(0);
        }
    }
    // ⤢: Esc puts the pane back first (the docs promise it), the next closes
    await open(p);
    await p.locator('dbmn-transaction .dbmn-tx-pane[data-part="request"] .dbmn-tx-max').click();
    await expect(p.locator('dbmn-transaction .dbmn-tx-panes.has-max')).toHaveCount(1);
    await p.locator('dbmn-transaction .dbmn-tx-pane[data-part="request"] .monaco-editor textarea').focus();
    await p.keyboard.press('Escape');
    await expect(p.locator('dbmn-transaction .dbmn-tx-panes.has-max'), 'the pane back in its place').toHaveCount(0);
    await expect(p.locator('dbmn-transaction'), 'still open').toHaveCount(1);
    await p.keyboard.press('Escape');
    await expect(p.locator('dbmn-transaction')).toHaveCount(0);
});

/** Detached nodes in a heap snapshot (it collects thoroughly first: one forced GC over-counts, 2026-11-25), by tag. */
async function detached(p, tags) {
    const cdp = await p.context().newCDPSession(p);
    await cdp.send('HeapProfiler.enable');
    const chunks = [];
    cdp.on('HeapProfiler.addHeapSnapshotChunk', e => chunks.push(e.chunk));
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
    const snap = JSON.parse(chunks.join(''));
    const m = snap.snapshot.meta, nf = m.node_fields.length, iName = m.node_fields.indexOf('name'), iDet = m.node_fields.indexOf('detachedness');
    const counts = Object.fromEntries(tags.map(t => [t, 0]));
    for (let i = 0; i < snap.nodes.length; i += nf) {
        if (snap.nodes[i + iDet] !== 2) continue;
        const name = snap.strings[snap.nodes[i + iName]];
        for (const t of tags) if (name.startsWith(`<${t}`)) counts[t]++;
    }
    return counts;
}

test('opened and closed 20 times, nothing is kept: no window, backdrop, editor or model left, and none of them held in memory', async ({ page: p }) => {
    await withMonaco(p);
    const before = await p.evaluate(() => live());
    for (let i = 0; i < 20; i++) {
        await open(p);
        if (i % 2) await p.locator('dbmn-transaction .dbmn-tx-close').click();
        else await p.keyboard.press('Escape');
        await expect(p.locator('dbmn-transaction')).toHaveCount(0);
    }
    expect(await p.evaluate(() => live()), 'the page as before the first open').toEqual(before);
    // Each window's Input table was kept by the column drag's listeners on window (column-drag.js), and the window with it
    expect(await detached(p, ['dbmn-transaction', 'dbmn-table']), 'closed windows and their tables held in memory').toEqual({ 'dbmn-transaction': 0, 'dbmn-table': 0 });
});
