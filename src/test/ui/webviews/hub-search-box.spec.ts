// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Hub's search box (#444): the query is coloured by a copy of it behind the box's own
 * (transparent) text. James, 2026-11-12: selecting text showed it "off centre... moved up out
 * of the text box". The copy must sit on the box's text letter for letter, one line high, and
 * grow with it when a long query wraps. Ctrl+A then Delete clears it, like any text box.
 * Since 2026-11-21 the box is the tables' (search-matcher.js): a field the list shows in the
 * link colour, one it doesn't purple; `@` lists the fields, shown then not.
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
        await box.pressSequentially('bulk @method=get @tag=inventory');
        const one = await measure(page);
        expect(one.boxHeight, 'one line').toBeLessThanOrEqual(32);
        expect(one.mirrorHeight, 'the copy as high as the box').toBe(one.boxHeight);
        expect(one.copy, 'the copy is drawn').not.toBeNull();
        expect(Math.abs(one.copy!.x - one.text.x), `across: copy ${one.copy!.x}, text ${one.text.x}`).toBeLessThanOrEqual(1);
        expect(Math.abs(one.copy!.y - one.text.y), `down: copy ${one.copy!.y}, text ${one.text.y}`).toBeLessThanOrEqual(1);
        // A field the row shows (method), and one it doesn't (tag, unless grouped by it): told apart
        await expect(page.locator('.search-box-mirror .search-tok-col-name')).toHaveText('@method');
        await expect(page.locator('.search-box-mirror .search-tok-col-hidden')).toHaveText('@tag');

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

    test('@ lists the fields, shown then not, @@ first; Esc closes the list, a second Esc clears the box', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await openList(page, 'catalogue');
        const box = page.locator('#catalogueSearch');
        await box.click();
        await box.pressSequentially('@');
        const list = page.locator('.catalogue-search:has(#catalogueSearch) .column-suggest');
        await expect(list).toBeVisible();
        const texts = await list.locator('.column-suggest-text').allTextContents();
        expect(texts[0]).toBe('@@');
        expect(texts).toContain('@name');
        expect(texts).toContain('@body');
        await expect(list.locator('.column-suggest-option.is-hidden', { hasText: '@body' })).toHaveCount(1);
        await box.press('Escape');
        await expect(list).toBeHidden();
        await expect(box).toHaveValue('@');
        await box.press('Escape');
        await expect(box).toHaveValue('');
    });

    test('History is searched by each header variable by its own name: @org=vic, and an old run\'s org; never @organization', async ({ dbmn, page }) => {
        // James, 2026-11-23: "if environment header is org, or version, or env, or host… it should come up as a search. not organisation"
        dbmn.seed.environments[0] = { ...dbmn.seed.environments[0], headerVariables: [{ name: 'org', value: 'vic', options: ['vic', 'nsw'] }, { name: 'env', value: 'uat', options: [] }] } as typeof dbmn.seed.environments[0];
        const run = (id: string, more: Record<string, unknown>) => ({ id, endpointId: 'test-endpoint-002', endpointName: 'Minimal Test Endpoint', status: 'completed', createdAt: '2026-11-23T10:00:00Z', completedAt: '2026-11-23T10:00:05Z', ...more });
        dbmn.seed.transactions = [
            run('tx-vic', { environmentVariables: { org: 'vic', env: 'uat' } }),
            run('tx-nsw', { environmentVariables: { org: 'nsw' } }),
            // From before: only its org was kept, as organization
            run('tx-old', { organization: 'qld' })
        ];
        await dbmn.openHub();
        await openList(page, 'transactions');
        const box = page.locator('#transactionsSearch');
        await box.click();
        await box.pressSequentially('@');
        const texts = await page.locator('.column-suggest-option .column-suggest-text').allTextContents();
        expect(texts).toContain('@org');
        // A header named as one of the run's own fields keeps out of its way
        expect(texts).toContain('@header.env');
        expect(texts).not.toContain('@organization');
        const shown = () => page.locator('#transactionsList .tx-row').count();
        await box.fill('@org=vic');
        await expect.poll(shown).toBe(1);
        await box.fill('@org=qld');
        await expect.poll(shown).toBe(1);
        await box.fill('@header.env=uat');
        await expect.poll(shown).toBe(1);
        await box.fill('');
        await expect.poll(shown).toBe(3);
    });
});

