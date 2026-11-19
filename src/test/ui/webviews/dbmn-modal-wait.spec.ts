// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * "Not yet: try again in N seconds" (ModalWait, dbmn-modal.js). Asking for a second sign-in link
 * within the minute was refused with a sentence holding a number that never moved. James,
 * 2026-11-19: "If we're gonna show this timer, … have it countdown". The dialog stays open, the
 * button that was refused stays off, and the field's line counts down, then both clear.
 */
import { test, expect } from '../harness/fixtures';

type Result = { actionId: string; fields: Record<string, string> };

test('a wait from the host keeps the dialog open and counts down, then the button works again', async ({ dbmn, page }) => {
    await dbmn.openHub();
    await page.evaluate(() => {
        const w = window as unknown as {
            DbmnModal: { show(spec: unknown): Promise<Result> };
            __result?: Result; __asked: number;
        };
        w.__asked = 0;
        void w.DbmnModal.show({
            title: 'Sign in to DBMN',
            fields: [{ id: 'email', type: 'email', label: 'Email', value: 'me@example.com', autoFocus: true }],
            actions: [
                { id: 'cancel', label: 'Cancel', variant: 'secondary' },
                { id: 'magic', label: 'Email me a link', variant: 'secondary', awaitsHostSubmit: true },
                { id: 'password', label: 'Sign In', variant: 'primary', awaitsHostSubmit: true }
            ],
            onHostSubmit: async () => {
                w.__asked++;
                if (w.__asked === 1) return { wait: { actionId: 'magic', field: 'email', seconds: 2, text: 'You can ask for another in {seconds}.' } };
                return undefined;
            }
        }).then(r => { w.__result = r; });
    });

    const magic = page.locator('.dbmn-modal [data-action-id="magic"]');
    const line = page.locator('.dbmn-modal-field-error').first();
    await magic.click();

    await expect(page.locator('.dbmn-modal')).toHaveCount(1);
    await expect(line).toHaveText('You can ask for another in 2 seconds.');
    await expect(magic).toBeDisabled();
    await expect(magic).toHaveText('Email me a link');
    await expect(page.locator('.dbmn-modal [data-action-id="password"]')).toBeEnabled();
    await expect(line).toHaveText('You can ask for another in 1 second.');

    await expect(magic).toBeEnabled({ timeout: 3000 });
    await expect(line).toHaveText('');
    await magic.click();
    await expect(page.locator('.dbmn-modal')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __result?: Result }).__result?.actionId)).toBe('magic');
});
