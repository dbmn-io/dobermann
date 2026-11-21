// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DbmnModal (shared/dbmn-modal.js): one modal at a time, but a value opened in full
 * (cell-detail.js) opens over the dialog it came from and goes back to it.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = rel => readFileSync(join(ROOT, 'src/webviews', rel), 'utf8');
const STYLES = ['shared/atomic.css', 'shared/core.css', 'shared/modals.css', 'shared/console.css'];
const SCRIPTS = ['shared/icons.js', 'shared/value-formatter.js', 'shared/dbmn-modal.js', 'shared/dbmn-clipboard.js', 'shared/cell-detail.js'];
const html = `<!doctype html><html><head>
<style>:root{--vscode-foreground:#ccc;--vscode-editor-background:#1e1e1e;--vscode-panel-border:#444;--vscode-input-background:#2a2a2a}
${STYLES.map(read).join('\n')}
body{margin:0;background:#1e1e1e;color:#ccc;font:13px sans-serif}</style>
${SCRIPTS.map(rel => `<script>${read(rel)}</script>`).join('\n')}</head><body>
<button id="opener" type="button">Open</button>
<script>
  window.answers = [];
  window.openRows = () => {
      const body = document.createElement('div');
      const cell = document.createElement('button');
      cell.type = 'button'; cell.id = 'cell'; cell.textContent = 'a long value';
      cell.addEventListener('click', () => window.CellDetail.open('{"a":1,"b":[1,2,3]}', { title: 'description' }));
      body.append(cell);
      window.DbmnModal.show({ title: 'inventory rows', body, size: 'lg', actions: [{ id: 'close', label: 'Close', variant: 'secondary' }] })
          .then(a => window.answers.push(a.actionId));
  };
  document.getElementById('opener').addEventListener('click', () => window.openRows());
</script></body></html>`;

const rowsDialog = page => page.locator('.dbmn-modal', { hasText: 'inventory rows' });
const valueWindow = page => page.locator('.dbmn-modal-cell-detail');

test('a value opened in full from a dialog opens over it, and closing it goes back to that dialog', async ({ page }) => {
    await page.setContent(html);
    await page.locator('#opener').click();
    await expect(rowsDialog(page)).toBeVisible();
    await page.locator('#cell').click();
    await expect(valueWindow(page)).toBeVisible();
    // The dialog waits behind it, untouched
    await expect(rowsDialog(page)).toHaveCount(1);
    expect(await page.evaluate(() => window.answers)).toEqual([]);
    // Its × closes it alone; focus is back on the cell it came from
    await valueWindow(page).locator('.dbmn-modal-close').click();
    await expect(valueWindow(page)).toHaveCount(0);
    await expect(rowsDialog(page)).toBeVisible();
    await expect(page.locator('#cell')).toBeFocused();
    // Escape too closes only the one on top
    await page.locator('#cell').click();
    await expect(valueWindow(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(valueWindow(page)).toHaveCount(0);
    await expect(rowsDialog(page)).toBeVisible();
    expect(await page.evaluate(() => window.answers)).toEqual([]);
    // Then the dialog's own Close closes it, as before
    await rowsDialog(page).locator('[data-action-id="close"]').click();
    await expect(rowsDialog(page)).toHaveCount(0);
    expect(await page.evaluate(() => window.answers)).toEqual(['close']);
});

test('a dialog shown without `over` still replaces every open one, those under it included', async ({ page }) => {
    await page.setContent(html);
    await page.locator('#opener').click();
    await page.locator('#cell').click();
    await expect(valueWindow(page)).toBeVisible();
    await page.evaluate(() => { window.DbmnModal.show({ title: 'something else', body: 'new' }).then(a => window.answers.push(a.actionId)); });
    await expect(page.locator('.dbmn-modal')).toHaveCount(1);
    await expect(page.locator('.dbmn-modal', { hasText: 'something else' })).toBeVisible();
    expect(await page.evaluate(() => window.answers)).toEqual(['dismiss']);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dbmn-modal')).toHaveCount(0);
});
