/**
 * A <dbmn-table> gone from the page is gone from memory (2026-11-25): every table a screen makes again kept, through the
 * column drag's listeners on `window` (column-drag.js), itself and all its rows: each closed transaction window's Input
 * rows, Query's Add a view (all of History) and a view's rows, a cell's rows. Counted in a heap snapshot, which collects
 * thoroughly first: one forced GC over-counts (it called 20 freed windows "held").
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css', 'shared/column-drag.css', 'shared/dbmn-table.css'];
const SCRIPTS = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-table.js'];

const page = () => `<!doctype html><html><head>
<style>${STYLES.map(read).join('\n')} body{margin:0;padding:16px;width:1000px;height:700px}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body><div id="screen"></div>
<script>
  const columns = ['id', 'endpoint', 'environment', 'status', 'started'].map(n => ({ id: n, name: n }));
  const rows = Array.from({ length: 2000 }, (_, i) => ({ id: 'run-' + i, endpoint: 'POST /inventory', environment: 'UAT', status: i % 7 ? 'completed' : 'error', started: '2026-11-25T10:' + String(i % 60).padStart(2, '0') }));
  /** A screen drawing its table again: the old one out, a new one in, filled (as Query's views and the Console's tabs) */
  window.redraw = () => {
      const t = document.createElement('dbmn-table');
      t.setAttribute('label', 'Results'); t.setAttribute('searchable', ''); t.setAttribute('selectable', '');
      t.style.height = '400px';
      document.getElementById('screen').replaceChildren(t);
      t.columns = columns; t.rows = rows;
  };
  /** A table in a window, opened and closed (as Query's Add a view and a cell's rows) */
  window.dialog = async () => {
      window.CellDetail.openRows({ columns: columns.map(c => c.name), rows: rows.slice(0, 500).map(r => columns.map(c => r[c.id])) }, { title: 'Rows' });
      await new Promise(r => setTimeout(r, 60));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(r => setTimeout(r, 60));
  };
</script></body></html>`;

/** Detached nodes in a heap snapshot, by tag. */
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

test('a table a screen draws again 20 times: only the one on the page is kept', async ({ page: p }) => {
    await p.setContent(page());
    for (let i = 0; i < 20; i++) { await p.evaluate(() => redraw()); await p.waitForTimeout(30); }
    await expect(p.locator('#screen dbmn-table')).toHaveCount(1);
    expect(await detached(p, ['dbmn-table']), 'tables drawn over, still in memory').toEqual({ 'dbmn-table': 0 });
});

test('a window with a table, opened and closed 20 times: none of its tables kept', async ({ page: p }) => {
    await p.setContent(page());
    for (let i = 0; i < 20; i++) await p.evaluate(() => dialog());
    await expect(p.locator('dbmn-table')).toHaveCount(0);
    expect(await detached(p, ['dbmn-table']), 'closed windows\' tables, still in memory').toEqual({ 'dbmn-table': 0 });
});

test('dragging a heading still moves its column with the page\'s listeners there only while it is pressed', async ({ page: p }) => {
    await p.setContent(page());
    await p.evaluate(() => redraw());
    const names = () => p.locator('#screen thead th .column-name').evaluateAll(list => list.map(n => n.textContent.trim()));
    const before = await names();
    const from = p.locator('#screen thead th .column-name.is-movable').nth(1);
    const to = p.locator('#screen thead th').nth(4);
    const a = await from.boundingBox(), b = await to.boundingBox();
    await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await p.mouse.down();
    await p.mouse.move(a.x + 40, a.y + a.height / 2, { steps: 4 });
    await p.mouse.move(b.x + b.width - 4, b.y + b.height / 2, { steps: 8 });
    await p.mouse.up();
    await expect.poll(names).not.toEqual(before);
});
