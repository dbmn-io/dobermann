/**
 * Query's Results, a compare in Compact with hidden characters shown (¶): a DIFF cell is its values,
 * the Baseline's plain and the others in pills, with no "blank" mark unless a value really is empty.
 * (Found by James, 2026-11-23, on the b-pills demo: every DIFF cell read "blank5 (6)".)
 * The real <dbmn-table> and query-compare-results.js, a column built as query-page.js builds a Compact one.
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/tables.css', 'shared/search.css', 'shared/column-head.css', 'shared/dbmn-table.css', 'shared/compare.css'];
const SCRIPTS = ['shared/icons.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js',
    'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-table.js', 'query/query-compare-results.js'];

const page = () => `<!doctype html><html><head>
<style>${STYLES.map(read).join('\n')} body{margin:0;padding:16px;width:900px}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<!-- (the toolbar query-compare-results.js wires up) -->
<div id="queryStatusTools"><button id="queryViewSide"></button><button id="queryViewCompact"></button><button id="queryColsAll"></button><button id="queryColsChanged"></button><button id="queryClearFilters"></button></div>
<dbmn-table id="t" label="Results"></dbmn-table>
<script>
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const ui = { filter: { kinds: [], columns: [], relations: [], hidden: [] }, state: { statusPlaces: ['BL', 'C1'] } };
  const results = window.QueryCompareResults.create({ el, ui, views: () => [], colour: () => 'dbmn-run-0', count: n => String(n), specialOn: () => true });
  // (as query-page.js builds a Compact column: the cell drawn by compactCell)
  const cells = ['BL', 'C1'];
  const compact = group => ({ id: 'compact:' + group, name: group, render: () => '', cell: (td, _v, row) => results.compactCell(td, row, cells, c => c, c => c + '.' + group) });
  const t = document.getElementById('t');
  t.columns = [{ id: 'sku', name: 'sku' }, compact('qty'), compact('colour')];
  const st = { missing: [] };
  t.rows = [
    { sku: 'A', 'BL.qty': 5, 'C1.qty': 6, 'BL.colour': 'black', 'C1.colour': 'grey', __status: st },
    { sku: 'B', 'BL.qty': 3, 'C1.qty': 3, 'BL.colour': 'gold', 'C1.colour': 'gold', __status: st },
    { sku: 'C', 'BL.qty': '', 'C1.qty': 7, 'BL.colour': 'tan ', 'C1.colour': 'tan', __status: st },
    { sku: 'D', 'BL.qty': 1, 'C1.qty': 1, 'BL.colour': 'bouncy', 'C1.colour': 'bouncy\\n', __status: st }
  ];
  t.specialCharacters = true;
</script></body></html>`;

const cell = (p, row, col) => p.locator('#t .dbmn-table-body tr').nth(row).locator('td').nth(col);

test('Compact with ¶ on: a DIFF cell is its two values, no "blank" in front', async ({ page: p }) => {
    await p.setContent(page());
    await expect(cell(p, 0, 1)).toHaveText('56');
    await expect(cell(p, 0, 2)).toHaveText('blackgrey');
    await expect(cell(p, 0, 1).locator('.is-blank')).toHaveCount(0);
    await expect(cell(p, 0, 2).locator('.is-blank')).toHaveCount(0);
    // (a SAME cell: its one value)
    await expect(cell(p, 1, 1)).toHaveText('3');
    await expect(cell(p, 1, 1).locator('.is-blank')).toHaveCount(0);
});

test('Compact with ¶ on: a value that really is empty is "blank", once; a trailing space is marked', async ({ page: p }) => {
    await p.setContent(page());
    await expect(cell(p, 2, 1).locator('.is-blank')).toHaveCount(1);
    await expect(cell(p, 2, 1)).toContainText('7');
    await expect(cell(p, 2, 2).locator('.dbmn-sc')).not.toHaveCount(0);
    await expect(cell(p, 2, 2).locator('.is-blank')).toHaveCount(0);
});

test('Compact with ¶ on: a line break at the end of a pill has its ↵ inside the pill, not over its edge', async ({ page: p }) => {
    // James, 2026-11-23 evening test: "bouncy↵" (kennel demo) had its mark hanging over the pill's right edge
    await p.setContent(page());
    const pill = cell(p, 3, 2).locator('.compare-pill').last();
    await expect(pill.locator('.dbmn-sc.is-break')).toHaveCount(1);
    const fits = await pill.evaluate(el => {
        const mark = el.querySelector('.dbmn-sc.is-break');
        const probe = document.createElement('span');
        probe.textContent = '\u21b5';
        mark.parentElement.appendChild(probe);
        const glyph = probe.getBoundingClientRect().width;
        probe.remove();
        const box = el.getBoundingClientRect(), at = mark.getBoundingClientRect();
        return { markEnd: Math.round(at.left + glyph), room: Math.round(box.right - 2) };
    });
    expect(fits.markEnd).toBeLessThanOrEqual(fits.room);
});
