// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Enter in a dialog's field is its main button (dbmn-modal.js). James, 2026-11-13, on the
 * header's Add (Value and Label): "if I do press add and I enter in a value and press enter, I'm
 * expecting it to trigger the add". It did with one field and not with two: a browser submits a
 * form on Enter only if the form has a submit button once it holds two or more fields, and the
 * dialog's buttons are in its footer, outside the form.
 *
 * Enter goes through the button's own click, so validation and the busy spinner run as for a
 * click. It never presses a danger button, and in a text area it is still a new line.
 */
import type { Page } from '@playwright/test';
import { test, expect } from '../harness/fixtures';

type Result = { actionId: string; fields: Record<string, string> };
type Field = { id: string; type: string; label: string; value?: string; validate?: { required?: boolean }; autoFocus?: boolean };
type Action = { id: string; label: string; variant?: string; awaitsHostSubmit?: boolean };

/** Opens a dialog in the Hub; its result lands on window.__result, host submits on window.__submitted. */
async function open(page: Page, fields: Field[], actions: Action[], hostSubmit = false) {
    await page.evaluate(({ fields, actions, hostSubmit }) => {
        const w = window as unknown as {
            DbmnModal: { show(spec: unknown): Promise<Result> };
            __result?: Result; __submitted?: Array<{ actionId: string; fields: Record<string, string> }>;
        };
        w.__result = undefined;
        w.__submitted = [];
        void w.DbmnModal.show({
            title: 'Add org', fields, actions,
            onHostSubmit: hostSubmit
                ? (actionId: string, values: Record<string, string>) => { w.__submitted!.push({ actionId, fields: values }); return new Promise(() => undefined); }
                : undefined
        }).then(r => { w.__result = r; });
    }, { fields, actions, hostSubmit });
    await expect(page.locator('.dbmn-modal input, .dbmn-modal textarea').first()).toBeFocused();
}
const result = (page: Page) => page.evaluate(() => (window as unknown as { __result?: Result }).__result);
const ADD: Action[] = [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: 'Add', variant: 'primary' }];
const text = (n: number, extra: Partial<Field> = {}): Field[] =>
    Array.from({ length: n }, (_, i) => ({ id: `f${i}`, type: 'text', label: `Field ${i}`, value: '', autoFocus: i === 0, ...extra }));

for (const count of [1, 2, 3]) {
    test(`Enter in a field is the main button, with ${count} field${count > 1 ? 's' : ''}`, async ({ dbmn, page }) => {
        await dbmn.openHub();
        await open(page, text(count), ADD);
        const first = page.locator('.dbmn-modal input').first();
        await first.fill('880-DEV');
        await first.press('Enter');
        await expect(page.locator('.dbmn-modal')).toHaveCount(0);
        expect(await result(page)).toEqual({ actionId: 'add', fields: Object.fromEntries(text(count).map((f, i) => [f.id, i === 0 ? '880-DEV' : ''])) });
    });
}

test('Enter never presses a danger button', async ({ dbmn, page }) => {
    await dbmn.openHub();
    for (const variant of ['danger', 'destructive']) {
        await open(page, text(2), [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'delete', label: 'Delete', variant }]);
        await page.locator('.dbmn-modal input').first().fill('DELETE');
        await page.locator('.dbmn-modal input').first().press('Enter');
        await expect(page.locator('.dbmn-modal'), `${variant}: still open`).toHaveCount(1);
        expect(await result(page), variant).toBeUndefined();
        await page.keyboard.press('Escape');
        await expect(page.locator('.dbmn-modal')).toHaveCount(0);
    }
});

test('Enter runs the same checks as a click: an empty required field says so, and nothing is sent', async ({ dbmn, page }) => {
    await dbmn.openHub();
    await open(page, text(2, { validate: { required: true } }), ADD);
    await page.locator('.dbmn-modal input').first().press('Enter');
    await expect(page.locator('.dbmn-modal')).toHaveCount(1);
    await expect(page.locator('.dbmn-modal-field.is-invalid').first()).toBeVisible();
    expect(await result(page)).toBeUndefined();
});

test('Enter shows the busy spinner and hands the fields to the host, as a click does', async ({ dbmn, page }) => {
    await dbmn.openHub();
    await open(page, text(2), [{ id: 'cancel', label: 'Cancel', variant: 'secondary' }, { id: 'add', label: 'Add', variant: 'primary', awaitsHostSubmit: true }], true);
    await page.locator('.dbmn-modal input').nth(1).fill('Brisbane');
    await page.locator('.dbmn-modal input').nth(1).press('Enter');
    await expect(page.locator('.dbmn-modal [data-action-id="add"]')).toHaveClass(/is-busy/);
    expect(await page.evaluate(() => (window as unknown as { __submitted: unknown[] }).__submitted)).toEqual([{ actionId: 'add', fields: { f0: '', f1: 'Brisbane' } }]);
});

test('Enter in a text area is a new line; the dialog stays', async ({ dbmn, page }) => {
    await dbmn.openHub();
    await open(page, [{ id: 'notes', type: 'textarea', label: 'Notes', autoFocus: true }, ...text(1).map(f => ({ ...f, autoFocus: false }))], ADD);
    const area = page.locator('.dbmn-modal textarea');
    await area.pressSequentially('one');
    await area.press('Enter');
    await area.pressSequentially('two');
    await expect(area).toHaveValue('one\ntwo');
    await expect(page.locator('.dbmn-modal')).toHaveCount(1);
});

test('the submit button that makes it work is out of the tab order and draws nothing', async ({ dbmn, page }) => {
    await dbmn.openHub();
    await open(page, text(2), ADD);
    const hidden = page.locator('.dbmn-modal-implicit-submit');
    await expect(hidden).toHaveAttribute('tabindex', '-1');
    expect((await hidden.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
});
