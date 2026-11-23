/**
 * A lookup table's page and its New lookup table dialog at the widths James works at (900 to 1280 px),
 * light and dark: every control can be clicked (nothing laid over its middle) and none is cut off at the
 * window's or the dialog's edge (the manager for James, 2026-11-23: "hunt for anything like the dead ★").
 * The page as lookup-page.ts builds it, the host faked (as lookup-page.spec.mjs).
 *
 *   npm run test:e2e:webview      (no backend needed)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/buttons.css', 'shared/tables.css', 'shared/console.css', 'shared/search.css', 'shared/modals.css', 'shared/column-head.css',
    'shared/column-drag.css', 'shared/dbmn-footer.css', 'shared/dbmn-table.css', 'lookup/lookup.css'];
const SCRIPTS = ['shared/dbmn-actions.js', 'shared/icons.js', 'shared/search-words.js', 'shared/search-matcher.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js',
    'shared/cell-detail.js', 'shared/virtual-window.js', 'shared/dbmn-context-menu.js', 'shared/column-drag.js', 'shared/column-head.js', 'shared/dbmn-footer.js', 'shared/dbmn-saved-searches.js', 'shared/dbmn-table.js', 'shared/lookup-new.js'];

const TABLE = {
    id: 'lkp-1', name: 'Units', updatedAt: '2026-11-20T10:00:00Z',
    // (a key from before every column was equal: read, and no longer kept)
    columns: [{ id: 'c1', name: 'ERP unit', key: true }, { id: 'c2', name: 'WMS unit' }],
    rows: [{ c1: 'EA', c2: 'EACH' }, { c1: 'CS', c2: 'CASE' }]
};

// The page as lookup-page.ts builds it (its main and footer), with the host faked
const page = () => `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a;--vscode-focusBorder:#4daafc}
${STYLES.map(read).join('\n')} body{width:900px}</style>
<script>window.posted = []; window.acquireVsCodeApi = () => ({ postMessage: m => window.posted.push(m) });</script>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body class="lookup-body">
<main class="lookup-page">
    <dbmn-table id="lookupTable" label="Units" editable add-row row-delete row-move edit-columns searchable saved-searches></dbmn-table>
    <p class="lookup-gone" id="lookupGone" hidden>This lookup table has been deleted.</p>
</main>
<dbmn-footer class="lookup-footer">
    <dbmn-actions></dbmn-actions>
    <dbmn-status id="lookupStatus"></dbmn-status>
</dbmn-footer>
<script>${read('lookup/lookup-page.js')}</script>
</body></html>`;

const send = (p, message) => p.evaluate(m => window.postMessage(m, '*'), message);
const saves = p => p.evaluate(() => window.posted.filter(m => m.type === 'lookup.save'));
const td = (p, row, col) => p.locator('#lookupTable .dbmn-table-body tr').nth(row).locator('td').nth(col);

async function open(p) {
    await p.setContent(page());
    await expect.poll(() => p.evaluate(() => window.posted.map(m => m.type))).toEqual(['lookup.ready']);
    await send(p, { type: 'lookup.load', table: TABLE, limits: { columns: 5, rows: 1000 } });
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(2);
}

/** Each visible control in `scope`: can it be clicked, and is it inside `edge` (the window, or a dialog)? */
const reach = (p, scope, edge) => p.evaluate(([sel, edgeSel]) => {
    const out = [];
    const bound = edgeSel ? document.querySelector(edgeSel).getBoundingClientRect() : { left: 0, right: window.innerWidth };
    document.querySelectorAll(`${sel} button, ${sel} select, ${sel} input:not([type=hidden])`).forEach(c => {
        const r = c.getBoundingClientRect();
        if (!r.width || !r.height || getComputedStyle(c).visibility === 'hidden' || c.closest('[hidden]')) return;
        // (a control kept out of reach on purpose: the dialog's hidden Enter button, anything aria-hidden or untabbable)
        if (c.tabIndex < 0 || c.closest('[aria-hidden="true"]')) return;
        const name = (c.id || c.getAttribute('aria-label') || c.textContent || c.className).trim().slice(0, 30);
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!hit || !(hit === c || c.contains(hit) || hit.contains(c))) out.push(`${name}: covered by ${hit ? (hit.id || hit.className || hit.tagName) : 'nothing'}`);
        if (r.right > bound.right + 0.5 || r.left < bound.left - 0.5) out.push(`${name}: cut off at the edge`);
    });
    return out;
}, [scope, edge || null]);

for (const width of [900, 1280]) {
    for (const dark of [false, true]) {
        test(`at ${width}px (${dark ? 'dark' : 'light'}): the table's controls and the New lookup table dialog can all be clicked, none cut off`, async ({ page: p }) => {
            await p.setViewportSize({ width, height: 800 });
            await p.emulateMedia({ colorScheme: dark ? 'dark' : 'light' });
            await open(p);
            expect(await reach(p, '#lookupTable')).toEqual([]);
            await p.evaluate(() => { window.LookupNew.ask({ taken: [] }); });
            const dialog = p.locator('.dbmn-modal');
            await expect(dialog).toBeVisible();
            expect(await reach(p, '.dbmn-modal', '.dbmn-modal')).toEqual([]);
        });
    }
}

test('the table\'s ★: its saved searches come with the table, and a change is saved with it', async ({ page: p }) => {
    // James, 2026-11-23: "that saved search should be everywhere where we have a search box"; kept in the table's own file
    await p.setContent(page());
    await expect.poll(() => p.evaluate(() => window.posted.map(m => m.type))).toEqual(['lookup.ready']);
    await send(p, { type: 'lookup.load', table: { ...TABLE, searches: [{ name: 'Each', text: 'EA' }] }, limits: { columns: 5, rows: 1000 } });
    const star = p.locator('#lookupTable dbmn-saved-searches');
    await star.locator('.dbmn-saved-btn').click();
    await star.locator('.dbmn-saved-pick', { hasText: 'Each' }).click();
    await expect(p.locator('#lookupTable .search-input')).toHaveValue('EA');
    await expect(p.locator('#lookupTable .dbmn-table-body tr')).toHaveCount(1);
    // A second one saved: kept with the table
    await p.locator('#lookupTable .search-input').fill('CS');
    await star.locator('.dbmn-saved-btn').click();
    await star.locator('.dbmn-saved-add').click();
    await star.locator('.dbmn-saved-name-input').fill('Case');
    await star.locator('.dbmn-saved-name-input').press('Enter');
    await expect.poll(async () => { const s = await saves(p); return s.length ? s[s.length - 1].table.searches : null; })
        .toEqual([{ name: 'Each', text: 'EA' }, { name: 'Case', text: 'CS' }]);
});
