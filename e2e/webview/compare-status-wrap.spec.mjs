/**
 * Compare's Status column, in a real browser with the real stylesheets: the column is as wide as
 * one line of Status (DIFF and its letters, or Missing and its letters), and a rare row with both
 * wraps to a second line rather than widening the column for every row. The page sets
 * --compare-status-width on the table from that one-line width (sizeStatus in compare-page.js).
 *
 *   npm run test:e2e:webview      (no backend needed — the files are read from src/)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const css = ['core.css', 'tables.css', 'compare.css'].map(f => readFileSync(join(ROOT, 'src/webviews/shared', f), 'utf8')).join('\n');

const tag = p => `<span class="compare-tag compare-r${p}">${p ? `C${p}` : 'BL'}</span>`;
const group = (kind, word, places) => `<span class="compare-status-group"><span class="status-pill-generic compare-${kind}">${word}</span>${places.map(tag).join('')}</span>`;
const row = groups => `<tr><td><span class="compare-status">${groups.join('')}</span></td><td>00012345600012</td></tr>`;

test('a row with DIFF and Missing wraps to two lines; one-line rows keep one line', async ({ page }) => {
    await page.setContent(`<!doctype html><html><head><style>body{margin:0;font:13px sans-serif}${css}</style></head><body>
        <table class="data-table" id="t"><tbody>
            ${row([group('missing', 'Missing', [0, 1, 2])])}
            ${row([group('diff', 'Diff', [2]), group('missing', 'Missing', [3])])}
        </tbody></table></body></html>`);
    // As sizeStatus does: the widest one line
    const oneLine = await page.locator('tr').first().locator('.compare-status').evaluate(el => Math.ceil(el.getBoundingClientRect().width));
    await page.locator('#t').evaluate((t, w) => t.style.setProperty('--compare-status-width', `${w}px`), oneLine);

    const both = page.locator('tr').nth(1);
    const [diff, missing] = [await both.locator('.compare-status-group').nth(0).boundingBox(), await both.locator('.compare-status-group').nth(1).boundingBox()];
    expect(missing.y, 'Missing under DIFF').toBeGreaterThan(diff.y + diff.height - 2);
    expect(await both.locator('.compare-status').evaluate(el => Math.ceil(el.getBoundingClientRect().width)), 'no wider than one line').toBeLessThanOrEqual(oneLine);

    const single = page.locator('tr').first().locator('.compare-status-group');
    const pills = await single.locator('> *').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(pills).size, 'Missing and its letters on one line').toBe(1);
});
