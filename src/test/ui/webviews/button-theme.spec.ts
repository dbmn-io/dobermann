// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect, openList } from '../harness/fixtures';

// The button system (shared/buttons.css): four kinds of button and the pill, the same on every
// screen and in every theme. These check the real Hub in a browser, under the palette that
// started this (pale text paired with a muted fill, hover the colour of the page) and under
// VS Code's own theme.
const OMARCHY: Record<string, string> = {
    '--vscode-foreground': '#ffcead',
    '--vscode-editor-background': '#060B1E',
    '--vscode-sideBar-background': '#060B1E',
    '--vscode-list-activeSelectionBackground': '#7d82d930',
    '--vscode-list-activeSelectionForeground': '#ffcead',
    '--vscode-list-hoverBackground': '#060B1E',
    '--vscode-toolbar-hoverBackground': '#060B1E',
    '--vscode-charts-green': '#92a593',
    '--vscode-charts-blue': '#7d82d9',
    '--vscode-button-background': '#7d82d9',
    '--vscode-button-hoverBackground': '#7d82d9',
    '--vscode-button-foreground': '#060B1E',
    '--vscode-button-secondaryBackground': '#6d7db6',
    '--vscode-button-secondaryHoverBackground': '#060B1E',
    '--vscode-button-secondaryForeground': '#ffcead'
};
const PAGE = 'rgb(6, 11, 30)';
const TEXT = 'rgb(255, 206, 173)';
const ACCENT = 'rgb(125, 130, 217)';

const PREVIOUS_TABS = [
    { type: 'endpoint' as const, refId: 'test-endpoint-001', name: 'Test API Endpoint' },
    { type: 'page' as const, refId: 'settings', name: 'Settings' }
];

type Page = import('@playwright/test').Page;
const style = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate(el => {
        const s = getComputedStyle(el);
        return { color: s.color, background: s.backgroundColor };
    });
const background = (page: Page, selector: string) => async () => (await style(page, selector)).background;
const colour = (page: Page, selector: string) => async () => (await style(page, selector)).color;

async function openWith(page: Page, dbmn: { seed: Record<string, unknown>; openHub(): Promise<void> }, theme?: Record<string, string>) {
    if (theme) {
        // The theme is on <html> before the page's own scripts run, as VS Code puts it there
        await page.addInitScript(properties => {
            const put = () => { for (const [name, value] of Object.entries(properties)) { document.documentElement.style.setProperty(name, value); } };
            if (document.documentElement) { put(); } else { document.addEventListener('readystatechange', put, { once: true }); }
        }, theme);
    }
    dbmn.seed.isSignedIn = true;
    dbmn.seed.previousTabs = PREVIOUS_TABS;
    await dbmn.openHub();
    await expect(page.locator('#hubHomeReopenBtn')).toBeVisible();
}

test.describe('The button system', () => {
    test('an ordinary action and the main action', async ({ dbmn, page }) => {
        await openWith(page, dbmn as never, OMARCHY);

        // Ordinary: the page's text colour on a faint tile — not the theme's muted fill
        await expect.poll(colour(page, '#hubHomeReopenBtn')).toBe(TEXT);
        const tile = (await style(page, '#hubHomeReopenBtn')).background;
        expect(tile).not.toBe('rgba(0, 0, 0, 0)');
        expect(tile).not.toBe('rgb(109, 125, 182)');

        // Main: solid, in the accent, with the text that reads on it
        await expect.poll(background(page, '#hubHomePuppyBtn')).toBe(ACCENT);
        await expect.poll(colour(page, '#hubHomePuppyBtn')).toBe(PAGE);
    });

    test('hover is the Hub menu\'s active background on a button, and half of it on a menu item', async ({ dbmn, page }) => {
        await openWith(page, dbmn as never, OMARCHY);
        await openList(page, 'catalogue');
        // Polled: controls ease between colours, so a value read mid-change is in between
        const selected = 'rgba(125, 130, 217, 0.19)';       // the theme's list.activeSelectionBackground
        await expect.poll(background(page, '.hub-nav-item.is-active'), { message: 'the open list\'s menu item: the selected tint, also while hovered' }).toBe(selected);

        // Run API: the same tile as any other action at rest
        const runApi = '.catalogue-row-run-api';
        await expect.poll(background(page, runApi)).toBe((await style(page, '#hubHomeReopenBtn')).background);
        await page.locator(runApi).first().hover();
        await expect.poll(background(page, runApi), { message: 'under the pointer: the menu\'s active background' }).toBe(selected);

        // A menu item that is not the chosen one: a lighter tint, never the page colour
        const other = '.hub-nav-item[data-section="transactions"]';
        await page.locator(other).hover();
        await expect.poll(background(page, other)).not.toBe('rgba(0, 0, 0, 0)');
        const hovered = (await style(page, other)).background;
        expect(hovered).not.toBe(selected);
        expect(hovered, 'the theme\'s own hover is the page colour').not.toBe(PAGE);
    });

    test('a pill takes the theme\'s palette, with the page\'s background as its text', async ({ dbmn, page }) => {
        await openWith(page, dbmn as never, OMARCHY);
        await openList(page, 'catalogue');
        const get = '.catalogue-row.method-GET .catalogue-method-badge';
        const post = '.catalogue-row.method-POST .catalogue-method-badge';
        await expect.poll(background(page, get)).toBe('rgb(146, 165, 147)');
        await expect.poll(background(page, post)).toBe(ACCENT);
        expect((await style(page, get)).color).toBe(PAGE);
        expect((await style(page, post)).color).toBe(PAGE);
        expect(await page.locator(get).first().evaluate(el => getComputedStyle(el).cursor)).toBe('default');
    });

    test('VS Code\'s own theme: the same system, and its button pair is left as the theme has it', async ({ dbmn, page }) => {
        await openWith(page, dbmn as never);
        expect(await page.evaluate(() => document.body.style.getPropertyValue('--vscode-button-foreground'))).toBe('');
        await expect.poll(colour(page, '#hubHomeReopenBtn'), { message: 'an ordinary action: the page\'s text colour' }).toBe('rgb(204, 204, 204)');
        await expect.poll(background(page, '#hubHomePuppyBtn')).toBe('rgb(0, 120, 212)');
        await expect.poll(colour(page, '#hubHomePuppyBtn')).toBe('rgb(255, 255, 255)');
    });
});
