// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';

test.describe('Endpoint editor (standalone)', () => {
    test('populates the form for an existing endpoint', async ({ dbmn, page }) => {
        await dbmn.openEndpointEditor('test-endpoint-001');

        await expect(page.locator('#pageHeading')).toHaveText('POST: Test API Endpoint');
        await expect(page.locator('#endpointName')).toHaveValue('Test API Endpoint');
        await expect(page.locator('#endpointPath')).toHaveValue('/api/test');
        await expect(page.locator('#endpointMethod')).toHaveValue('POST');
        await expect(page.locator('#endpointDescription')).toHaveValue('Test endpoint for unit testing');

        // Boot handshake: ready → systemsList + populateEndpointData, then the
        // inherited-headers lookup.
        expect((await dbmn.sent('ready')).length).toBe(1);
        expect((await dbmn.sent('getCurrentEnvironment')).length).toBe(1);
        await dbmn.waitForReceived('populateEndpointData');
        await dbmn.waitForReceived('currentEnvironmentData');

        await expect(page).toHaveScreenshot('existing-endpoint.png', {
            mask: [page.locator('#monacoEditorContainer')]
        });
    });

    test('starts empty for a new endpoint', async ({ dbmn, page }) => {
        await dbmn.openEndpointEditor();

        await expect(page.locator('#endpointName')).toHaveValue('');
        await expect(page.locator('#endpointPath')).toHaveValue('');
        await expect(page.locator('body')).toHaveAttribute('data-endpoint-id', 'NEW');
        await dbmn.waitForReceived('systemsList');

        await expect(page).toHaveScreenshot('new-endpoint.png', {
            mask: [page.locator('#monacoEditorContainer')]
        });
    });

    test('saves edits through the host and reflects them in the store', async ({ dbmn, page }) => {
        await dbmn.openEndpointEditor('test-endpoint-002');
        await dbmn.waitForReceived('populateEndpointData');

        const name = page.locator('#endpointName');
        await name.fill('Minimal Test Endpoint (renamed)');
        await name.dispatchEvent('input');
        await page.locator('#endpointPath').fill('/api/minimal-v2');

        const before = await dbmn.sentCount();
        await page.getByRole('button', { name: 'Save Endpoint' }).click();
        const save = await dbmn.waitForSent('saveEndpoint', { after: before });
        expect(save.message.endpoint).toMatchObject({
            id: 'test-endpoint-002',
            name: 'Minimal Test Endpoint (renamed)',
            path: '/api/minimal-v2',
            method: 'GET'
        });

        await dbmn.waitForReceived('endpointSaved');
        const state = await dbmn.state();
        expect(state.endpoints.find(e => e.id === 'test-endpoint-002')).toMatchObject({
            name: 'Minimal Test Endpoint (renamed)',
            path: '/api/minimal-v2'
        });
    });

    // #432: suggestions from the tags in use (the seed: 'smoke' on two endpoints, 'orders' on one)
    test('suggests tags in use as one is typed; Enter adds the highlighted one, "New tag" adds what was typed', async ({ dbmn, page }) => {
        await dbmn.openEndpointEditor('test-endpoint-002');
        await dbmn.waitForReceived('tagsList');
        const input = page.locator('#endpointTagsInput');
        const options = page.locator('.tag-suggest .tag-suggest-option');

        await input.click();
        await input.pressSequentially('or');
        await expect(options).toHaveText(['orders', 'New tag or']);
        await expect(page.locator('.tag-suggest-option.active')).toHaveText('orders');
        await page.keyboard.press('Enter');
        await expect(page.locator('#endpointTagsChips .tag-chip')).toHaveText(['smoke×', 'orders×']);
        await expect(page.locator('.tag-suggest')).toBeHidden();

        // Already on it: not offered again. A new one through "New tag".
        await input.pressSequentially('or');
        await expect(options).toHaveText(['New tag or']);
        await page.keyboard.press('Tab');
        await expect(page.locator('#endpointTagsChips .tag-chip')).toHaveText(['smoke×', 'orders×', 'or×']);
        await expect(input, 'focus stays for the next tag').toBeFocused();
    });
});

test.describe('Endpoint editor before its code editor is ready', () => {
    // Found by the full VS Code e2e run, 2026-11-13: on a busy machine the name and path were typed
    // before Monaco loaded; Monaco then re-took the "nothing changed" snapshot, typing included, and
    // Save Endpoint stayed disabled. A slow laptop does the same to a quick typist.
    test('what was typed before the code editor loaded is still unsaved, and Save is on', async ({ dbmn, page }) => {
        const release = dbmn.holdMonaco();
        await dbmn.openEndpointEditor();
        expect(await page.evaluate(() => Boolean((window as unknown as { monacoEditor?: unknown }).monacoEditor)), 'Monaco held back').toBe(false);
        await page.locator('#endpointName').fill('Get Carriers');
        await page.locator('#endpointPath').fill('/reference/carriers');
        release();
        await page.waitForFunction(() => Boolean((window as unknown as { monacoEditor?: unknown }).monacoEditor), undefined, { timeout: 30_000 });
        await page.waitForTimeout(500);
        await expect(page.locator('#save-endpoint-btn')).toBeEnabled();
        await expect(page.locator('#run-api-btn'), 'not runnable until saved').toBeDisabled();
    });

    test('an untouched new endpoint still starts with Save off once the code editor loads', async ({ dbmn, page }) => {
        const release = dbmn.holdMonaco();
        await dbmn.openEndpointEditor();
        release();
        await page.waitForFunction(() => Boolean((window as unknown as { monacoEditor?: unknown }).monacoEditor), undefined, { timeout: 30_000 });
        await page.waitForTimeout(500);
        await expect(page.locator('#save-endpoint-btn')).toBeDisabled();
    });
});
