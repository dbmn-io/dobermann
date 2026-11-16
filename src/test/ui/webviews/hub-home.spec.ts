// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';

// GitHub Issue #348: every launch opens on Home: Puppy School first, the
// previous session's tabs one click away, Quick start, what's new in this
// version, this week's usage and a tip. Home shows whenever no tab is open.
test.describe('Hub Home', () => {
    const home = '#hubHome';
    const tip = '#hubHomeTipText';

    const WHATS_NEW = {
        version: '0.3.1',
        counts: { added: 3, changed: 4, fixed: 21, security: 0 },
        highlights: ['A new Home', 'Lists slide in from the rail', 'Re-open tabs']
    };

    test('launch opens on Home, with Puppy School first; a tab hides it, closing the last brings it back', async ({ dbmn, page }) => {
        dbmn.seed.whatsNew = WHATS_NEW;
        await dbmn.openHub();
        await expect(page.locator(home)).toBeVisible();
        await expect(page.locator('#hubHomePuppy .hub-settings-panel-title')).toHaveText('Puppy School');
        // Before the badge state arrives: five lessons to do and a way in.
        await expect(page.locator('#hubHomeBadges .hub-home-badge.dbmn-badge-locked')).toHaveCount(5);
        await expect(page.locator('#hubHomePuppyBtn')).toHaveText('Start Puppy School');
        await dbmn.settle();
        await expect(page).toHaveScreenshot('home.png', { mask: [page.locator(tip)] });

        await page.locator('#hubHome [data-home-action="import"]').click();
        await expect(page.locator('#hubTabStrip')).toContainText('Import');
        await expect(page.locator(home)).toBeHidden();

        await page.locator('.hub-tab .hub-tab-close').first().click();
        await expect(page.locator('.hub-tab')).toHaveCount(0);
        await expect(page.locator(home)).toBeVisible();
    });

    test('Re-open brings back the previous session\'s tabs, then the offer goes', async ({ dbmn, page }) => {
        dbmn.seed.previousTabs = [
            { type: 'endpoint', refId: 'test-endpoint-001', name: 'Test API Endpoint' },
            { type: 'page', refId: 'settings', name: 'Settings' }
        ];
        await dbmn.openHub();
        const card = page.locator('#hubHomeReopen');
        await expect(card).toBeVisible();
        await expect(page.locator('#hubHomeReopenNames')).toHaveText('Test API Endpoint · Settings');
        await expect(page.locator('#hubHomeReopenBtn')).toHaveText('Re-open 2 tabs');

        await page.locator('#hubHomeReopenBtn').click();
        await dbmn.waitForSent('reopenTabs');
        await dbmn.waitForTab('endpoint:test-endpoint-001');
        await expect(page.locator('#hubTabStrip')).toContainText('Settings');
        await expect(page.locator(home)).toBeHidden();

        await page.locator('.hub-tab-strip-close-all').click();
        await page.locator('.dbmn-modal-footer button', { hasText: 'Close' }).click();
        await expect(page.locator('.hub-tab')).toHaveCount(0);
        await expect(card).toBeHidden();
    });

    test('with nothing to re-open there is no offer', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await dbmn.waitForReceived('hubHomeInfo');
        await expect(page.locator('#hubHomeReopen')).toBeHidden();
    });

    // A name beside the rail is the rail item's name, not a button of its own: under the
    // pointer it has no box, and its rail item lights up as if the icon were hovered.
    test('hovering a name on Home highlights its rail item; the name gets no box of its own', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const name = page.locator('.hub-home-guide-item[data-home-section="environments"]');
        const item = page.locator('.hub-nav-item[data-section="environments"]');
        const background = (el: Element) => getComputedStyle(el).backgroundColor;
        const clear = 'rgba(0, 0, 0, 0)';
        expect(await name.evaluate(background)).toBe(clear);
        expect(await item.evaluate(background)).toBe(clear);

        await page.locator('#hubHomePuppy').hover();
        const restingColour = await name.evaluate(el => getComputedStyle(el).color);
        await item.hover();
        await page.waitForTimeout(250);   // the rail item's background fades in
        const hoveredItem = await item.evaluate(background);
        expect(hoveredItem, 'the rail item under the pointer').not.toBe(clear);
        await expect.poll(() => name.evaluate(el => getComputedStyle(el).color), 'its name reads as the item\'s').not.toBe(restingColour);

        await name.hover();
        await expect.poll(() => item.evaluate(background), 'the rail item lights up for its name').toBe(hoveredItem);
        expect(await name.evaluate(background), 'no box round the name').toBe(clear);
        expect(await name.evaluate(el => getComputedStyle(el).color)).not.toBe(restingColour);
        expect(await page.locator('.hub-nav-item[data-section="catalogue"]').evaluate(background), 'only its own item').toBe(clear);

        await page.locator('#hubHomePuppy').hover();
        await expect.poll(() => item.evaluate(background)).toBe(clear);
        expect(await name.evaluate(el => getComputedStyle(el).color)).toBe(restingColour);
    });

    test('New in vX.Y.Z: counts, the first features, and the changelog', async ({ dbmn, page }) => {
        dbmn.seed.whatsNew = WHATS_NEW;
        await dbmn.openHub();
        const card = page.locator('#hubHomeWhatsNew');
        await expect(card).toBeVisible();
        await expect(page.locator('#hubHomeWhatsNewTitle')).toHaveText('New in v0.3.1');
        await expect(page.locator('#hubHomeWhatsNewCounts')).toHaveText('3 new features · 21 fixes · 4 changes');
        await expect(page.locator('#hubHomeWhatsNewList li')).toHaveText(WHATS_NEW.highlights);

        const before = await dbmn.sentCount();
        await card.locator('[data-home-link]').click();
        const msg = await dbmn.waitForSent('openExternalUrl', { after: before });
        expect(msg.message).toMatchObject({ payload: { url: 'https://dbmn.io/docs/changelog/' } });
    });

    test('before a version is cut its notes read Coming next; with none the card stays out', async ({ dbmn, page }) => {
        dbmn.seed.whatsNew = { version: null, counts: { added: 0, changed: 0, fixed: 1, security: 0 }, highlights: [] };
        await dbmn.openHub();
        await expect(page.locator('#hubHomeWhatsNewTitle')).toHaveText('Coming next');
        await expect(page.locator('#hubHomeWhatsNewCounts')).toHaveText('1 fix');

        await dbmn.push({ type: 'hubHomeInfo', reopen: null, whatsNew: null });
        await expect(page.locator('#hubHomeWhatsNew')).toBeHidden();
    });

    test('Quick start reuses the Hub\'s own actions', async ({ dbmn, page }) => {
        await dbmn.openHub();
        // Every action opens a tab, which hides Home, so after the first real
        // click the rest are clicked in the DOM and checked in the host's log.
        const press = (name: string) => page.evaluate(n =>
            (document.querySelector(`#hubHome [data-home-action="${n}"]`) as HTMLElement).click(), name);

        await page.locator('#hubHome [data-home-action="import"]').click();
        await expect(page.locator('#hubTabStrip')).toContainText('Import');

        const expected: Array<[string, string, Record<string, unknown>]> = [
            ['addEndpoint', 'addEndpoint', {}],
            ['addEndpointFromClipboard', 'addEndpoint', { fromClipboard: true }],
            ['addEnvironment', 'addEnvironment', {}],
            ['puppySchool', 'openPuppySchool', {}]
        ];
        for (const [action, type, fields] of expected) {
            const before = await dbmn.sentCount();
            await press(action);
            const msg = await dbmn.waitForSent(type, { after: before });
            expect(msg.message, action).toMatchObject(fields);
        }
    });

    test('the tip steps through the list both ways', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const text = page.locator(tip);
        const first = await text.textContent();
        await page.locator('#hubHomeTipNext').click();
        await expect(text).not.toHaveText(first || '');
        await page.locator('#hubHomeTipPrev').click();
        await expect(text).toHaveText(first || '');
    });

    test('the tip\'s arrows stack like its scroll, and a longer tip grows the card smoothly', async ({ dbmn, page }) => {
        await page.setViewportSize({ width: 520, height: 900 });
        await dbmn.openHub();
        const prev = await page.locator('#hubHomeTipPrev').boundingBox();
        const next = await page.locator('#hubHomeTipNext').boundingBox();
        expect(Math.abs(prev!.x - next!.x), 'one above the other').toBeLessThan(2);
        expect(prev!.y + prev!.height, 'previous on top').toBeLessThanOrEqual(next!.y + 1);

        // Step to the shortest tip, then on to the longest, watching the card's height every frame
        const tips = await page.evaluate(() => (window as unknown as { HubHome: { TIPS: string[] } }).HubHome.TIPS);
        const short = tips.indexOf('Alt+W closes the active tab.');
        while (await page.locator(tip).textContent() !== tips[short]) {
            await page.locator('#hubHomeTipNext').click();
            await page.waitForTimeout(400);
        }
        await page.waitForTimeout(400);
        const heights = await page.evaluate(() => new Promise<number[]>(resolve => {
            const card = document.querySelector('.hub-home-tip') as HTMLElement;
            const seen = [card.getBoundingClientRect().height];
            const at = performance.now();
            (document.getElementById('hubHomeTipNext') as HTMLElement).click();
            const sample = () => {
                seen.push(card.getBoundingClientRect().height);
                if (performance.now() - at < 600) requestAnimationFrame(sample); else resolve(seen);
            };
            requestAnimationFrame(sample);
        }));
        const start = heights[0];
        const end = heights[heights.length - 1];
        expect(end, 'the next tip runs to more lines').toBeGreaterThan(start + 10);
        expect(heights.some(h => h > start + 1 && h < end - 1), `the card grows through the heights between, not in one jump: ${heights.join(', ')}`).toBe(true);
    });

    const lessons = (earned: number) => Array.from({ length: 5 }, (_, i) => ({
        id: `ps_lesson_${i + 1}`, name: `Lesson ${i + 1}`, description: `Finish lesson ${i + 1}`,
        earnedAt: i < earned ? '2026-10-0' + (i + 1) + 'T00:00:00Z' : null
    }));

    test('Puppy School shows a badge per lesson until graduation, then the graduate badge', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const card = page.locator('#hubHomePuppy');

        await dbmn.push({ type: 'badgeStateUpdate', progressLabel: '3 of 5', actionLabel: 'Continue Puppy School',
            state: { puppySchool: {}, badges: [...lessons(3), { id: 'ps_graduate', name: 'Graduate', earnedAt: null }], unseen: [] },
            captions: { ps_lesson_1: 'Lesson 1', ps_lesson_2: 'Lesson 2', ps_lesson_3: 'Lesson 3', ps_lesson_4: 'Lesson 4', ps_lesson_5: 'Lesson 5' } });
        await expect(page.locator('#hubHomePuppyProgress')).toHaveText('3 of 5');
        await expect(page.locator('#hubHomePuppyBtn')).toHaveText('Continue Puppy School');
        await expect(page.locator('#hubHomeBadges .hub-home-badge')).toHaveCount(5);
        await expect(page.locator('#hubHomeBadges .hub-home-badge:not(.dbmn-badge-locked)')).toHaveCount(3);
        await expect(page.locator('#hubHomeGraduate')).toBeHidden();
        await dbmn.settle();
        await expect(card).toHaveScreenshot('home-puppy-school.png');

        await dbmn.push({ type: 'badgeStateUpdate', progressLabel: 'Graduate', actionLabel: 'Revisit Puppy School',
            state: { puppySchool: { graduatedAt: '2026-10-05T00:00:00Z' },
                badges: [...lessons(5), { id: 'ps_graduate', name: 'Graduate', earnedAt: '2026-10-05T00:00:00Z' }], unseen: [] } });
        await expect(card).toHaveClass(/is-graduated/);
        await expect(page.locator('#hubHomeBadges')).toBeHidden();
        await expect(page.locator('#hubHomeGraduate')).toBeVisible();
        await expect(page.locator('#hubHomeGraduateText')).toContainText('Graduated');
        await expect(page.locator('#hubHomeGraduateArt svg')).toHaveCount(1);
        await expect(page.locator('#hubHomePuppyBtn')).toHaveText('Revisit Puppy School');
    });

    test('This week shows the weekly usage while signed in', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const card = page.locator('#hubHomeWeek');
        await expect(card).toBeHidden();

        const weekly = { apiCalls: 142, batchRuns: 3, rowsProcessed: 12480, totalExecutionTimeMs: 252_000 };
        await dbmn.push({ type: 'authStateUpdate', isAuthenticated: true, usage: { weekStart: '2026-10-05' },
            userLicense: { accessLevel: 'limited' }, telemetryStats: { weekly, alltime: weekly } });
        // 0.4.0: no weekly limit, so no "/ 5", whatever an older account record says
        await expect(card).toBeVisible();
        await expect(page.locator('#hubHomeWeekLabel')).toHaveText('Week of 2026-10-05');
        await expect(page.locator('#hubHomeApiCalls')).toHaveText('142');
        await expect(page.locator('#hubHomeBatchRuns')).toHaveText('3');
        await expect(page.locator('#hubHomeRowsProcessed')).toHaveText((12480).toLocaleString());
        await expect(page.locator('#hubHomeRunTime')).toHaveText('4m 12s');
        await dbmn.settle();
        await expect(card).toHaveScreenshot('home-this-week.png');

        await dbmn.push({ type: 'authStateUpdate', isAuthenticated: false, telemetryStats: null });
        await expect(card).toBeHidden();
    });
});
