/**
 * Query's Columns step (src/webviews/query/query-columns.js) in a real browser from the real
 * files, on the lanes grid, with the page's own line() and at() as query-page.js has them and a
 * made-up compare (the mock-up's "runs, plus another endpoint and a file"): Stock's BL and C1,
 * Items and Counts in the compare, Suppliers brought in to show. The host is faked: what is sent
 * comes back as the report's columns.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/buttons.css', 'shared/compare.css', 'shared/dbmn-lanes.css', 'shared/query.css', 'shared/query-columns.css'];
const SCRIPTS = ['shared/icons.js', 'shared/dbmn-context-menu.js', 'shared/relation-glyph.js', 'shared/dbmn-lanes.js', 'query/query-columns.js'];

const VIEWS = [
    { id: 's1', name: 'Stock', run: '', runOf: '', columns: ['sku', 'gtin', 'description', 'quantityOnHand', 'uom', 'status'] },
    { id: 's2', name: 'Stock', run: 'C1', runOf: 's1', columns: ['sku', 'gtin', 'description', 'quantityOnHand', 'uom', 'status'] },
    { id: 'i1', name: 'Items', run: '', runOf: '', columns: ['itemCode', 'itemDesc', 'unitOfMeasure', 'qtyOnHand', 'supplierId'] },
    { id: 'c1', name: 'Counts', run: '', runOf: '', columns: ['SKU', 'Description', 'Qty Counted', 'Bin'] },
    { id: 'p1', name: 'Suppliers', run: '', runOf: '', columns: ['id', 'name', 'leadTimeDays'] }
];
const SAMPLE = {
    s1: { sku: 'WOOF-033', gtin: '00012345600012', description: 'Kibble 10 kg', quantityOnHand: '54', uom: 'EA', status: 'ACTIVE' },
    s2: { sku: 'WOOF-033', gtin: '00012345600012', description: 'Kibble 10 kg', quantityOnHand: '52', uom: 'EA', status: 'ACTIVE' },
    i1: { itemCode: 'WOOF-033', itemDesc: 'Kibble 10kg', unitOfMeasure: 'each', qtyOnHand: '54', supplierId: 'S-118' },
    c1: { SKU: '0WOOF-033', Description: 'Kibble 10 kg', 'Qty Counted': '52', Bin: 'A-01-02' },
    p1: { id: 'S-118', name: 'Acme Pet Supply', leadTimeDays: '14' }
};
const STATE = {
    views: VIEWS.map(v => ({ id: v.id, name: v.name, run: v.run, runOf: v.runOf, columns: v.columns.map(name => ({ name, sample: SAMPLE[v.id][name] })) })),
    compare: { baseline: 's1', views: ['s1', 's2', 'i1', 'c1'] },
    joins: [
        { view: 's2', kind: 'compare', on: [{ left: { view: 's1', column: 'sku' }, right: { view: 's2', column: 'sku' } }] },
        { view: 'i1', kind: 'compare', on: [{ left: { view: 's1', column: 'sku' }, right: { view: 'i1', column: 'itemCode' } }] },
        { view: 'c1', kind: 'compare', on: [{ left: { view: 's1', column: 'sku' }, right: { view: 'c1', column: 'SKU' } }] },
        { view: 'p1', kind: 'left', on: [{ left: { view: 'i1', column: 'supplierId' }, right: { view: 'p1', column: 'id' } }] }
    ],
    keyColumns: [{ view: 'p1', column: 'id', sameView: 'i1', sameColumn: 'supplierId' }],
    columns: [{ view: 's1', column: 'sku' }],
    sampleRow: [],
    columnCells: []
};

const page = (state = STATE) => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#d8dce1;--vscode-editor-background:#1e1f22;--vscode-panel-border:#3a3e44;--vscode-focusBorder:#4f9be0;--vscode-descriptionForeground:#969da6;
--vscode-charts-blue:#4f8fd8;--vscode-charts-green:#57b07a;--vscode-charts-purple:#a77ad6;--vscode-charts-orange:#d9894a;--vscode-charts-yellow:#c2a73f;--vscode-charts-red:#c06a9a;
--vscode-textLink-foreground:#4f9be0;--vscode-input-background:#2a2a2a;--vscode-editor-font-family:monospace}
${STYLES.map(read).join('\n')}
body{margin:0;padding:16px;background:#1e1f22;color:#d8dce1;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<div id="queryColumns" class="dbmn-lanes query-cols"></div>
<script>
(() => {
  window.posted = [];
  const ui = { state: ${JSON.stringify(state)} };
  // The page's own helpers, as query-page.js has them
  function el(tagName, className, content) { const n = document.createElement(tagName); if (className) n.className = className; if (content !== undefined) n.textContent = content; return n; }
  function laneGroups() {
      const all = ui.state.views; const out = []; const seen = new Set();
      all.forEach(v => { const head = v.runOf ? all.find(x => x.id === v.runOf) || v : v; if (seen.has(head.id)) return; const group = [head, ...all.filter(x => x.runOf === head.id && x !== head)]; group.forEach(x => seen.add(x.id)); out.push(group); });
      return out;
  }
  function views() { return laneGroups().flat(); }
  function view(id) { return views().find(v => v.id === id); }
  function viewAt(id) { return views().findIndex(v => v.id === id); }
  function colour(id) { const g = laneGroups(); for (let li = 0; li < g.length; li++) { const ri = g[li].findIndex(v => v.id === id); if (ri >= 0) return 'dbmn-view-' + (li % 6) + ' dbmn-run-' + ri; } return ''; }
  function at(id, className) { return el('div', 'query-at dbmn-lane-run ' + colour(id) + (className ? ' ' + className : '')); }
  function line(className, cells, says, lead) {
      const row = el('div', 'dbmn-lanes-row query-line' + (className ? ' ' + className : ''));
      row.dataset.line = (className || 'line').split(' ')[0].replace(/^query-/, '');
      const start = el('div', 'dbmn-lanes-gutter query-lead'); start.dataset.gutter = '';
      (lead || []).forEach(n => { if (n) start.append(n); }); row.appendChild(start);
      if (cells && cells.__span) { const span = el('div', 'dbmn-lanes-span query-span'); span.append(cells.__span); row.appendChild(span); }
      else laneGroups().forEach((group, li) => {
          const lane = el('div', 'dbmn-lane dbmn-view-' + (li % 6) + ' dbmn-runs-' + group.length); lane.dataset.lane = String(li);
          group.forEach((v, ri) => { const cell = (cells && cells[v.id]) || at(v.id); cell.classList.add('dbmn-lane-run'); cell.dataset.run = String(ri); cell.dataset.view = v.id; lane.appendChild(cell); });
          row.appendChild(lane);
      });
      const end = el('div', 'dbmn-lanes-end query-says'); end.dataset.end = '';
      (says || []).forEach(n => { if (n) end.appendChild(n); }); row.appendChild(end);
      return row;
  }
  // The host, faked: what is picked comes back as the report's columns
  function post(m) {
      window.posted.push(m);
      if (m.type === 'query.setSelect') {
          // As the host works out Columns' cells: each value, amber where it differs from its column's first cell in slot order
          const samples = ${JSON.stringify(SAMPLE)};
          const value = c => (samples[c.view] || {})[c.column] || '';
          const columnCells = m.select.map(c => {
              if (!c.group) return { value: value(c), differs: false };
              const mates = m.select.filter(x => x.group === c.group).sort((a, b) => viewAt(a.view) - viewAt(b.view));
              return { value: value(c), differs: mates.length > 1 && value(c) !== value(mates[0]) };
          });
          ui.state = Object.assign({}, ui.state, { columns: m.select, columnCells });
          setTimeout(() => step.render(), 0);
      }
  }
  DbmnLanes.apply(document.getElementById('queryColumns'), laneGroups().map(g => ({ runs: g.length })));
  const step = QueryColumns.create({
      el, at, line, views, view, viewAt, colour, post, setBusy: () => {}, count: n => String(n), CALC_VIEW: '',
      injectIcons: root => { if (window.Icons) window.Icons.injectIcons(root); },
      state: () => ui.state, openCalc: () => {}, pickFns: () => {}
  });
  step.render();
  window.columnsStep = step;
})();
</script></body></html>`;

const selects = p => p.evaluate(() => window.posted.filter(m => m.type === 'query.setSelect').map(m => m.select));
const rowNamed = (p, text) => p.locator('#queryColumns .dbmn-lanes-row', { has: p.locator('.dbmn-lanes-gutter', { hasText: text }) }).first();

test('the report: its heading, the Key first (its value in every view of the compare, blank where a view only shows), and "Nothing here yet"', async ({ page: p }) => {
    await p.setViewportSize({ width: 1500, height: 950 });
    await p.setContent(page());
    const rows = p.locator('#queryColumns .dbmn-lanes-row');
    await expect(rows.nth(0)).toContainText('In the report');
    await expect(rows.nth(0)).toContainText('In Results’ order');
    const key = rows.nth(1);
    await expect(key.locator('.query-rep-what')).toHaveText('Key');
    await expect(key.locator('.dbmn-lanes-gutter')).toContainText('sku');
    expect(await key.locator('.dbmn-cell-value').allTextContents()).toEqual(['WOOF-033', 'WOOF-033', 'WOOF-033', '0WOOF-033']);
    await expect(key.locator('[data-view="p1"]')).toHaveClass(/is-blank/);
    await expect(rows.nth(2)).toContainText('Nothing here yet. Click a cell below to show it, or the Compare icon beside a row’s name to compare the row.');
});

test('not used: "Not used" in the gutter of the first row; never a key column; a cell per view, blank where a view has none', async ({ page: p }) => {
    await p.setContent(page());
    const free = p.locator('#queryColumns .query-free-row');
    await expect(free.first().locator('.query-free-title')).toHaveText('Not used');
    expect(await p.locator('#queryColumns .query-free-row .query-free-title').count()).toBe(1);
    const names = await free.locator('.query-rep-label').allTextContents();
    for (const key of ['sku', 'itemCode', 'SKU', 'id', 'supplierId']) expect(names).not.toContain(key);
    expect(names).toContain('gtin');
    const gtin = rowNamed(p, 'gtin');
    await expect(gtin.locator('[data-view="i1"]')).toHaveClass(/is-blank/);
    expect(await gtin.locator('button.dbmn-cell .dbmn-cell-value').allTextContents()).toEqual(['00012345600012', '00012345600012']);
});

test('the Compare icon: only beside a row with two or more free cells, one of them in the compare', async ({ page: p }) => {
    await p.setContent(page());
    await expect(rowNamed(p, 'gtin').locator('.query-free-compare')).toHaveCount(1);          // BL and C1
    await expect(rowNamed(p, 'Bin').locator('.query-free-compare')).toHaveCount(0);           // Counts alone
    await expect(rowNamed(p, 'leadTimeDays').locator('.query-free-compare')).toHaveCount(0);  // Suppliers alone, not in the compare
    // One colour, whatever the row
    const colours = await p.locator('#queryColumns .query-free-compare').evaluateAll(bs => [...new Set(bs.map(b => getComputedStyle(b).color))]);
    expect(colours).toHaveLength(1);
});

test('a run\'s cell below, clicked, is shown as "column (C1)"; the key stays first in what is sent; the new row is lit', async ({ page: p }) => {
    await p.setContent(page());
    await rowNamed(p, 'gtin').locator('[data-view="s2"]').click();
    await expect.poll(() => selects(p).then(s => s.length)).toBe(1);
    const [select] = await selects(p);
    expect(select[0]).toEqual({ view: 's1', column: 'sku' });
    expect(select[1]).toEqual({ view: 's2', column: 'gtin', group: 'gtin (C1)' });
    const shown = p.locator('#queryColumns .query-rep-row:not(.query-rep-key)');
    await expect(shown).toHaveCount(1);
    await expect(shown.locator('.query-rep-name')).toHaveValue('gtin (C1)');
    await expect(shown).toHaveClass(/is-new/);
    // BL's gtin is still free below; C1's is not
    await expect(rowNamed(p, 'gtin').locator('[data-view="s2"]')).toHaveClass(/is-blank/);
});

test('+ in an empty place: only in a lane that can take part, listing that view\'s columns but the key and those in the row, under its name', async ({ page: p }) => {
    await p.setContent(page());
    await rowNamed(p, 'description').locator('[data-view="s1"]').click();
    const row = p.locator('#queryColumns .query-rep-row:not(.query-rep-key)').first();
    await expect(row).toBeVisible();
    await expect(row.locator('[data-view="p1"]')).toHaveClass(/is-blank/);   // Suppliers: to show, not in the compare
    await expect(row.locator('button.is-add[data-view="i1"]')).toHaveCount(1);
    await row.locator('button.is-add[data-view="i1"]').click();
    const menu = p.locator('.dbmn-context-menu, [role="menu"]').last();
    await expect(menu).toContainText('Items’ columns');
    await expect(menu).toContainText('itemDesc');
    await expect(menu).not.toContainText('itemCode');      // the key
    await expect(menu).not.toContainText('supplierId');    // Suppliers' join key
    await menu.getByText('itemDesc', { exact: true }).click();
    await expect.poll(() => selects(p).then(s => s.length)).toBe(2);
    const select = (await selects(p))[1];
    expect(select.filter(c => c.group === 'description').map(c => c.view + '.' + c.column)).toEqual(['s1.description', 'i1.itemDesc']);
    await expect(p.locator('#queryColumns .query-rep-row.is-compared')).toHaveClass(/is-new/);
});

test('every line on the same tracks: each view\'s cells under the same edges on every row, at 1100 and 1500px; screenshots beside the mock-up', async ({ page: p }) => {
    const out = join(ROOT, '..', 'audits', 'query-2026-11-21', 'round-columns');
    mkdirSync(out, { recursive: true });
    const errors = [];
    p.on('pageerror', e => errors.push(e.message));
    for (const width of [1100, 1500]) {
        await p.setViewportSize({ width, height: 950 });
        await p.setContent(page());
        expect(errors).toEqual([]);
        await rowNamed(p, 'quantityOnHand').locator('.query-free-compare').click();
        await expect(p.locator('#queryColumns .query-rep-row.is-compared')).toHaveCount(1);
        const edges = await p.evaluate(() => [...document.querySelectorAll('#queryColumns .dbmn-lanes-row')]
            .filter(r => r.querySelector('.dbmn-lane'))
            .map(r => [...r.querySelectorAll('.dbmn-lane-run')].map(c => Math.round(c.getBoundingClientRect().left))));
        edges.forEach(e => e.forEach((x, i) => expect(Math.abs(x - edges[0][i])).toBeLessThanOrEqual(1)));
        await p.waitForTimeout(1300);   // (the lit row fades)
        await p.screenshot({ path: join(out, `columns-mixed-${width}.png`), fullPage: true });
    }
});

test('a compared row: a cell that differs from the first cell in slot order is amber (the host\'s flag), the first and the same ones are not', async ({ page: p }) => {
    await p.setContent(page());
    await rowNamed(p, 'quantityOnHand').locator('.query-free-compare').click();
    const row = p.locator('#queryColumns .query-rep-row.is-compared');
    await expect(row).toHaveCount(1);
    await expect(row.locator('[data-view="s2"]')).toHaveClass(/is-diff/);       // C1's 52 against BL's 54
    await expect(row.locator('[data-view="s1"]')).not.toHaveClass(/is-diff/);
    const colours = await row.evaluate(r => ['s1', 's2'].map(v => getComputedStyle(r.querySelector(`[data-view="${v}"] .dbmn-cell-value`)).color));
    expect(colours[1]).not.toBe(colours[0]);
});

test('one view, no join, no key: every column taken out leaves the step empty, sends nothing (never "every column"), and says it is empty; a column put back ends it', async ({ page: p }) => {
    const one = {
        views: [{ id: 's1', name: 'Stock', run: '', runOf: '', columns: [{ name: 'sku', sample: 'WOOF-033' }, { name: 'gtin', sample: '00012345600012' }] }],
        compare: null, joins: [], keyColumns: [], columns: [{ view: 's1', column: 'sku' }], sampleRow: [], columnCells: []
    };
    await p.setContent(page(one));
    expect(await p.evaluate(() => window.columnsStep.isEmpty())).toBe(false);
    await p.locator('#queryColumns .query-rep-row').first().locator('.dbmn-cell').first().click({ button: 'right' });
    await p.locator('.dbmn-context-menu').getByText('Take it out of the report').click();
    await expect(p.locator('#queryColumns')).toContainText('Nothing here yet. Click a cell below to show it.');
    expect(await selects(p)).toEqual([]);
    expect(await p.evaluate(() => window.columnsStep.isEmpty())).toBe(true);
    // Both columns are free below; putting one back sends it alone
    await rowNamed(p, 'gtin').locator('[data-view="s1"]').click();
    await expect.poll(() => selects(p)).toEqual([[{ view: 's1', column: 'gtin' }]]);
    await expect.poll(() => p.evaluate(() => window.columnsStep.isEmpty())).toBe(false);
});
