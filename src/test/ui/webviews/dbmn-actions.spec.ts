// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';

/**
 * #372: markup names an action (data-click, data-change) instead of an inline handler, which the
 * web app's Content Security Policy refuses. Only what a screen registers runs.
 */
test.describe('DbmnActions', () => {
    test('the Hub\'s buttons run their registered actions, with no inline handler left', async ({ dbmn, page }) => {
        await dbmn.openHub();
        expect(await page.locator('[onclick], [onchange]').count(), 'inline handlers on the Hub').toBe(0);

        await page.evaluate(() => {
            const button = document.getElementById('puppy-school-btn') as HTMLButtonElement;
            button.classList.remove('hidden');
            button.closest('.hidden')?.classList.remove('hidden');
        });
        const before = await dbmn.sentCount();
        await page.locator('#puppy-school-btn').dispatchEvent('click');
        await dbmn.waitForSent('openPuppySchool', { after: before });
    });

    test('an action gets its argument, the event and the element; an unregistered name runs nothing and says so', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const errors: string[] = [];
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        const seen = await page.evaluate(() => {
            const calls: string[] = [];
            const actions = (window as unknown as { DbmnActions: { register(map: Record<string, (arg: string | undefined, event: Event, element: Element) => void>): void } }).DbmnActions;
            actions.register({ probe(arg, event, element) { calls.push(`${arg}|${event.type}|${element.id}|${(this as unknown as Element).id}`); } });
            const known = Object.assign(document.createElement('button'), { id: 'probe-known' });
            known.setAttribute('data-click', 'probe');
            known.setAttribute('data-arg', 'authentication');
            const unknown = Object.assign(document.createElement('button'), { id: 'probe-unknown' });
            unknown.setAttribute('data-click', 'notRegistered');
            document.body.append(known, unknown);
            known.click();
            unknown.click();
            return calls;
        });
        expect(seen).toEqual(['authentication|click|probe-known|probe-known']);
        expect(errors.some(e => e.includes('nothing registered as "notRegistered"'))).toBe(true);
    });
});
