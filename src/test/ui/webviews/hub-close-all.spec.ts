// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect, openList } from '../harness/fixtures';
import type { Page } from '@playwright/test';

// GitHub Issue #348: Close all tabs never loses work. It keeps an edited
// endpoint or environment and a Run Batch holding data it hasn't run; it
// closes everything else, Consoles included (a running batch carries on, and
// History reopens its Console).
test.describe('Close all tabs', () => {
    /** A stand-in Run Batch tab. The Hub's iframe shim gives every tab
     *  `dbmnSetTabDirty`; the real Run Batch calls it from its step bar
     *  (batch-stepper.js) with whether it holds data that hasn't run. */
    function runBatchHtml(holdsData: boolean): string {
        return '<!DOCTYPE html><html><head><title>Run Batch</title></head><body><p>Run Batch</p>' +
            `<script>window.dbmnSetTabDirty(${holdsData});</script></body></html>`;
    }

    async function mount(dbmn: { push(m: Record<string, unknown>): Promise<void> }, tabId: string, tabType: string, name: string, html: string) {
        await dbmn.push({ type: 'mountEmbeddedTab', tabId, tabType, refId: tabId.split(':')[1], name, preview: false, html });
    }

    const tab = (page: Page, id: string) => page.locator(`.hub-tab[data-tab-id="${id}"]`);

    test('keeps unsaved editors and Run Batch data; closes clean tabs and Consoles, running or not', async ({ dbmn, page }) => {
        await dbmn.openHub();

        // A clean environment first: the fake host still closes editor tabs
        // when an environment row is picked (the old standalone-editor swap,
        // #351), which the real host no longer does to Hub tabs.
        await openList(page, 'environments');
        await page.locator('#hubEnvironmentList [data-env-id="env-prod-001"]').first().click();
        await dbmn.waitForTab('environment:env-prod-001');

        // An endpoint with an unsaved edit, and the Settings page.
        await openList(page, 'catalogue');
        // One click, one mount: a double-click can mount the editor twice
        // in the fake host, and the second mount would drop the edit.
        await page.locator('.catalogue-row[data-endpoint-id="test-endpoint-001"]').click();
        const editor = await dbmn.waitForTab('endpoint:test-endpoint-001');
        // Edit only once the editor has loaded, or the load overwrites the edit.
        await expect(editor.locator('#endpointName')).toHaveValue('Test API Endpoint');
        // ...and tracks changes: its footer says "Saved" only from then on
        await expect(editor.locator('#endpointStatus')).toHaveText('Saved');
        await editor.locator('#endpointName').fill('Test API Endpoint (edited)');
        await expect(tab(page, 'endpoint:test-endpoint-001')).toHaveClass(/is-dirty/);
        await page.locator('.hub-nav-item[data-section="settings"]').click();

        // Run Batch: one holding data, one not started.
        await mount(dbmn, 'batch:test-endpoint-002', 'batch', 'Run Batch: Minimal', runBatchHtml(true));
        await mount(dbmn, 'batch:test-endpoint-003', 'batch', 'Run Batch: Validation', runBatchHtml(false));
        await expect(tab(page, 'batch:test-endpoint-002')).toHaveClass(/is-dirty/);
        await expect(tab(page, 'batch:test-endpoint-003')).not.toHaveClass(/is-dirty/);

        // A Console whose batch is still running.
        await mount(dbmn, 'batchConsole:exec-1', 'batchConsole', 'Batch #412',
            '<!DOCTYPE html><html><head></head><body>Console</body></html>');
        await dbmn.push({ type: 'setTabStatus', tabId: 'batchConsole:exec-1', status: 'running', progress: { done: 10, total: 400 } });
        await expect(tab(page, 'batchConsole:exec-1')).toHaveClass(/is-running/);

        await expect(page.locator('.hub-tab')).toHaveCount(6);
        await page.locator('.hub-tab-strip-close-all').click();
        const modal = page.locator('.dbmn-modal');
        await expect(modal).toContainText('4 tabs will be closed.');
        await expect(modal).toContainText('2 tabs with unsaved work will stay open');
        await expect(modal).toContainText('"Test API Endpoint');
        await expect(modal).toContainText('"Run Batch: Minimal"');
        await page.locator('.dbmn-modal-footer button', { hasText: 'Close' }).click();

        const remaining = await page.locator('.hub-tab').evaluateAll(els => els.map(e => (e as HTMLElement).dataset.tabId));
        expect(remaining.sort()).toEqual(['batch:test-endpoint-002', 'endpoint:test-endpoint-001']);
    });

    test('Cancel closes nothing', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await page.locator('.hub-nav-item[data-section="settings"]').click();
        await page.locator('.hub-nav-item[data-section="import"]').click();
        await page.locator('.hub-tab-strip-close-all').click();
        await page.locator('.dbmn-modal-footer button', { hasText: 'Cancel' }).click();
        await expect(page.locator('.hub-tab')).toHaveCount(2);
    });

    test('closing a Run Batch that holds data asks first, and Keep open keeps it', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await mount(dbmn, 'batch:test-endpoint-002', 'batch', 'Run Batch: Minimal', runBatchHtml(true));
        await expect(tab(page, 'batch:test-endpoint-002')).toHaveClass(/is-dirty/);

        await tab(page, 'batch:test-endpoint-002').locator('.hub-tab-close').click();
        const modal = page.locator('.dbmn-modal');
        await expect(modal).toContainText('has data that hasn\'t been run');
        await expect(page.locator('.dbmn-modal-footer button', { hasText: 'Save' })).toHaveCount(0);
        await page.locator('.dbmn-modal-footer button', { hasText: 'Keep open' }).click();
        await expect(tab(page, 'batch:test-endpoint-002')).toHaveCount(1);

        await tab(page, 'batch:test-endpoint-002').locator('.hub-tab-close').click();
        await page.locator('.dbmn-modal-footer button', { hasText: 'Close and lose it' }).click();
        await expect(tab(page, 'batch:test-endpoint-002')).toHaveCount(0);
    });
});
