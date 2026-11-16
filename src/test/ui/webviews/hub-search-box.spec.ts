// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's search box (#444): the query is coloured by a copy of it behind the box's own
 * (transparent) text. James, 2026-11-12: selecting text showed it "off centre... moved up out
 * of the text box". The copy must sit on the box's text letter for letter, one line high, and
 * grow with it when a long query wraps. Ctrl+A then Delete clears it, like any text box.
 */
import { test, expect, openList } from '../harness/fixtures';

/** Where the box's first letter is, and the copy's, and the box's height. */
async function measure(page: import('@playwright/test').Page) {
    return page.evaluate(() => {
        const box = document.getElementById('catalogueSearch') as HTMLTextAreaElement;
        const mirror = box.parentElement!.querySelector('.search-box-mirror') as HTMLElement;
        // The box's text: a span measured in a clone of it at the same place
        const probe = document.createElement('div');
        const cs = getComputedStyle(box);
        ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderTopWidth', 'borderLeftWidth', 'boxSizing', 'whiteSpace', 'wordBreak', 'width']
            .forEach(k => { (probe.style as unknown as Record<string, string>)[k] = (cs as unknown as Record<string, string>)[k]; });
        probe.style.position = 'absolute';
        probe.style.borderStyle = 'solid';
        probe.style.borderColor = 'transparent';
        const r = box.getBoundingClientRect();
        probe.style.left = r.left + 'px';
        probe.style.top = r.top + 'px';
        const span = document.createElement('span');
        span.textContent = box.value || 'x';
        probe.appendChild(span);
        document.body.appendChild(probe);
        const text = span.getBoundingClientRect();
        probe.remove();
        const first = mirror.firstChild;
        const range = document.createRange();
        range.selectNodeContents(mirror);
        const copy = range.getClientRects()[0];
        return {
            boxHeight: Math.round(r.height),
            mirrorHeight: Math.round(mirror.getBoundingClientRect().height),
            text: { x: Math.round(text.left), y: Math.round(text.top) },
            copy: copy ? { x: Math.round(copy.left), y: Math.round(copy.top) } : null,
            hasCopy: !!first
        };
    });
}

test.describe('Hub search box (#444)', () => {
    test('the coloured copy sits on the text, one line high, and grows with a long query', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        const box = page.locator('#catalogueSearch');
        await box.click();
        await box.pressSequentially('@ get #inventory bulk');
        const one = await measure(page);
        expect(one.boxHeight, 'one line').toBeLessThanOrEqual(32);
        expect(one.mirrorHeight, 'the copy as high as the box').toBe(one.boxHeight);
        expect(one.copy, 'the copy is drawn').not.toBeNull();
        expect(Math.abs(one.copy!.x - one.text.x), `across: copy ${one.copy!.x}, text ${one.text.x}`).toBeLessThanOrEqual(1);
        expect(Math.abs(one.copy!.y - one.text.y), `down: copy ${one.copy!.y}, text ${one.text.y}`).toBeLessThanOrEqual(1);
        await expect(page.locator('.search-box-mirror .search-tok-method')).toHaveText('get');
        await expect(page.locator('.search-box-mirror .search-tok-tag')).toHaveText('#inventory');

        // A long query wraps: the box grows, the copy with it
        await box.pressSequentially(' and some more words to make it wrap onto a second line in the list panel');
        const two = await measure(page);
        expect(two.boxHeight, 'two lines or more').toBeGreaterThan(one.boxHeight + 10);
        expect(two.mirrorHeight).toBe(two.boxHeight);

        // Ctrl+A, Delete: empty, one line again
        await box.press('ControlOrMeta+a');
        await box.press('Delete');
        await expect(box).toHaveValue('');
        expect((await measure(page)).boxHeight).toBeLessThanOrEqual(32);
    });
});
