// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The toggle button (`.dbmn-toggle`, shared/buttons.css): an icon that is on or off. The page sets
 * aria-pressed, the button draws it; square, as tall as the two-row toggles beside it, so a row of
 * controls lines up (James, 2026-11-22: "the same height as the other components").
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const THEMES = {
    dark: ':root{--vscode-foreground:#ccc;--vscode-descriptionForeground:#8a8a8a;--vscode-editor-background:#1e1e1e;--vscode-input-background:#3c3c3c;--vscode-input-border:#555;--vscode-list-activeSelectionBackground:#04395e;--vscode-list-activeSelectionForeground:#fff;--vscode-focusBorder:#007fd4} body{background:#1e1e1e;color:#ccc}',
    light: ':root{--vscode-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-editor-background:#fff;--vscode-input-background:#fff;--vscode-input-border:#cecece;--vscode-list-activeSelectionBackground:#e8e8e8;--vscode-list-activeSelectionForeground:#000;--vscode-focusBorder:#005fb8} body{background:#fff;color:#3b3b3b}'
};
const html = theme => `<!doctype html><html><head>
<style>${THEMES[theme]}
${['atomic', 'core', 'buttons', 'modals', 'tables', 'console', 'compare', 'query'].map(n => read(`shared/${n}.css`)).join('\n')}
body{margin:0;padding:24px;font:13px sans-serif}
#row{display:flex;align-items:center;gap:12px}</style>
<script>${read('shared/icons.js')}</script></head><body>
<div id="row">
  <span class="query-status-tools"><div class="toggle-group compare-view-toggle" role="group" aria-label="Columns shown">
    <button type="button" class="toggle-btn active" aria-pressed="true">All columns</button>
    <button type="button" class="toggle-btn" aria-pressed="false">Only diffs</button>
  </div></span>
  <button type="button" class="dbmn-toggle" id="totals" aria-pressed="true" data-icon="square-sigma" title="Totals: a total under each column of numbers" aria-label="Totals"></button>
  <button type="button" class="dbmn-toggle" id="hidden" aria-pressed="false" data-icon="pilcrow" title="Hidden characters" aria-label="Hidden characters"></button>
  <button type="button" class="dbmn-toggle" id="filter" aria-pressed="false" data-icon="funnel" title="No filters on" aria-label="Clear all filters" disabled></button>
</div>
<script>
  window.Icons.injectIcons(document.body);
  window.clicks = [];
  for (const b of document.querySelectorAll('.dbmn-toggle')) b.addEventListener('click', () => window.clicks.push(b.id));
</script></body></html>`;

const box = (page, sel) => page.locator(sel).evaluate(e => { const r = e.getBoundingClientRect(); return { top: r.top, height: r.height, width: r.width, mid: r.top + r.height / 2 }; });
const look = (page, sel) => page.locator(sel).evaluate(e => { const s = getComputedStyle(e); return { bg: s.backgroundColor, color: s.color, opacity: s.opacity }; });

for (const theme of ['dark', 'light']) {
    test(`${theme}: square, 34px (the two-row toggles' height), centred in the row; on and off read apart; disabled is dimmed and inert`, async ({ page }) => {
        await page.setContent(html(theme));
        const group = await box(page, '.compare-view-toggle');
        for (const id of ['#totals', '#hidden', '#filter']) {
            const b = await box(page, id);
            // 34px: Query's two-row toggles (All columns over Only diffs) measured 34 in its Results toolbar
            expect(b.height, `${id} 34px tall`).toBeCloseTo(34, 0);
            expect(b.width).toBeCloseTo(b.height, 0);
            expect(Math.abs(b.mid - group.mid)).toBeLessThanOrEqual(0.5);
            // The icon is drawn, 18px
            const svg = page.locator(`${id} svg`);
            await expect(svg).toHaveCount(1);
            expect((await svg.boundingBox()).width).toBeCloseTo(18, 0);
        }
        const on = await look(page, '#totals');
        const off = await look(page, '#hidden');
        expect(on.bg).not.toBe(off.bg);
        expect(on.color).not.toBe(off.color);
        // Under the pointer, off takes the hover tint (not the on look); on stays on
        await page.locator('#hidden').hover();
        await page.waitForTimeout(200);
        const hovered = await look(page, '#hidden');
        expect(hovered.bg).not.toBe(off.bg);
        expect(hovered.bg).not.toBe(on.bg);
        // The page sets the state; the button only draws it
        await page.locator('#hidden').click();
        expect(await page.locator('#hidden').getAttribute('aria-pressed')).toBe('false');
        await page.locator('#hidden').evaluate(b => b.setAttribute('aria-pressed', 'true'));
        await page.mouse.move(0, 0);
        await expect.poll(async () => (await look(page, '#hidden')).bg).toBe(on.bg);
        // Disabled: dimmed, and a click does nothing
        expect(Number((await look(page, '#filter')).opacity)).toBeCloseTo(0.4, 2);
        await page.locator('#filter').click({ force: true });
        expect(await page.evaluate(() => window.clicks)).toEqual(['hidden']);
        if (process.env.TOGGLE_SHOT) await page.locator('#row').screenshot({ path: `${process.env.TOGGLE_SHOT}-${theme}.png` });
    });
}
