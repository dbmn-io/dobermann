// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { test, expect } from '../harness/fixtures';

// #373: Settings › UI › Theme and the palette button are the host's to offer: a host that offers
// nothing shows neither. The web and desktop apps send a menu; so does VS Code, where Follow
// system is VS Code's theme and any other goes over it on DBMN's panels (`editorTheme`).
test.describe('Settings › UI › Theme', () => {
    const MENU = {
        type: 'themeOptions',
        options: [{ id: 'system', label: 'Follow system' }],
        groups: [
            { label: 'Light', options: [{ id: 'light', label: 'Light' }, { id: 'theme:flexoki-light', label: 'Flexoki Light' }] },
            { label: 'Dark', options: [{ id: 'default', label: 'Dark' }, { id: 'theme:nord', label: 'Nord' }] }
        ],
        current: 'system',
        system: {
            light: { options: [{ id: 'light', label: 'Light' }, { id: 'theme:flexoki-light', label: 'Flexoki Light' }], current: 'theme:flexoki-light' },
            dark: { options: [{ id: 'default', label: 'Dark' }, { id: 'theme:nord', label: 'Nord' }], current: 'default' }
        },
        help: 'This device\'s theme. Follow system switches between your light and dark themes when your computer does.',
        previews: Object.fromEntries(['system', 'light', 'theme:flexoki-light', 'default', 'theme:nord'].map((id, index) => [id, {
            mode: index < 3 ? 'light' : 'dark',
            background: index < 3 ? '#fffcf0' : '#2e3440', sidebar: '#202020', text: '#cccccc', muted: '#9d9d9d', border: '#2b2b2b',
            accent: '#81a1c1', button: '#81a1c1', buttonText: '#2e3440',
            methods: { get: '#a3be8c', post: '#81a1c1', put: '#d08770', patch: '#b48ead', delete: '#bf616a' }
        }]))
    };

    test('a host that offers no themes shows no theme rows', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await page.locator('.hub-nav-item[data-section="settings"]').click();
        await expect(page.locator('#maxCsvRows')).toBeVisible();
        for (const row of ['#uiThemeRow', '#uiThemeLightRow', '#uiThemeDarkRow']) await expect(page.locator(row)).toBeHidden();
        // Nor the theme picker: no button, no dialog
        await expect(page.locator('#hubThemeBtn')).toBeHidden();
        await expect(page.locator('dialog.theme-picker')).toHaveCount(0);
    });

    test('the palette button opens the themes one at a time, each the Hub in its own colours; Use sends the pick', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await dbmn.push(MENU);
        const button = page.locator('#hubThemeBtn');
        await expect(button).toBeVisible();
        // The help button's twin
        await expect(button).toHaveClass(/hub-help-toggle/);
        await expect(page.locator('.theme-hint'), 'no hint unless the host says it is due').toHaveCount(0);
        await button.click();
        const picker = page.locator('dialog.theme-picker');
        await expect(picker).toBeVisible();
        // Opens on the theme in use: Follow system, first; its neighbour waits on the right
        await expect(picker.locator('.theme-slide')).toHaveCount(5);
        await expect(picker.locator('.theme-picker-name')).toHaveText('Follow system');
        await expect(picker.locator('.theme-picker-kind')).toHaveText('Light or dark, with your computer');
        await expect(picker.locator('.theme-slide[data-offset="0"]')).toHaveAttribute('data-theme-id', 'system');
        await expect(picker.locator('.theme-slide[data-offset="1"]')).toHaveAttribute('data-theme-id', 'light');
        await expect(picker.locator('.theme-picker-use')).toHaveText('In use');
        await expect(picker.locator('.theme-picker-use')).toBeDisabled();
        await expect(picker.locator('.theme-picker-step.is-prev')).toBeDisabled();

        // Each screen is the Hub with a Console open, in its theme: the page, the rail, Completed,
        // the Raw count, Re-run
        const nord = picker.locator('.theme-slide[data-theme-id="theme:nord"]');
        await expect(nord.locator('.tm-console-name')).toHaveText('DBMN Puppy School: Get Carriers');
        await expect(nord.locator('.tm-view.is-active')).toContainText('Completed');
        await expect(nord.locator('.tm-tr:not(.is-head)')).toHaveCount(6);
        const colour = (selector: string) => nord.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);
        expect(await colour('.tm-screen')).toBe('rgb(46, 52, 64)');
        expect(await colour('.tm-rail')).toBe('rgb(32, 32, 32)');
        expect(await colour('.tm-badge.is-done')).toBe('rgb(163, 190, 140)');
        expect(await colour('.tm-count.is-raw')).toBe('rgb(180, 142, 173)');
        expect(await colour('.tm-btn:not(.is-secondary):not(.is-danger)')).toBe('rgb(129, 161, 193)');

        // Along by the arrow, and by clicking a neighbour; browsing sends nothing
        await picker.locator('.theme-picker-step.is-next').click();
        await expect(picker.locator('.theme-picker-name')).toHaveText('Light');
        await expect(picker.locator('.theme-picker-kind')).toHaveText('Light theme');
        await picker.locator('.theme-slide[data-offset="2"]').click();
        await expect(picker.locator('.theme-picker-name')).toHaveText('Dark');
        // The arrow keys too
        await page.keyboard.press('ArrowRight');
        await expect(picker.locator('.theme-picker-name')).toHaveText('Nord');
        await expect(picker.locator('.theme-picker-step.is-next')).toBeDisabled();
        await page.keyboard.press('ArrowLeft');
        await expect(picker.locator('.theme-picker-name')).toHaveText('Dark');
        await page.keyboard.press('ArrowRight');
        expect(await dbmn.sent('setTheme')).toHaveLength(0);

        // Enter uses it: the pick goes to the host and the stage closes
        await expect(picker.locator('.theme-picker-use')).toHaveText('Use Nord');
        await page.keyboard.press('Enter');
        expect((await dbmn.sent('setTheme')).at(-1)?.message).toMatchObject({ id: 'theme:nord' });
        await expect(picker).toBeHidden();

        // Opened on the theme in use, straight to the keys: Enter uses where the arrows got to
        await dbmn.push({ ...MENU, current: 'theme:nord', system: null });
        await button.click();
        await page.keyboard.press('ArrowLeft');
        await expect(picker.locator('.theme-picker-name')).toHaveText('Dark');
        await page.keyboard.press('Enter');
        expect((await dbmn.sent('setTheme')).at(-1)?.message).toMatchObject({ id: 'default' });
        await expect(picker).toBeHidden();

        // Opened again: on Nord, in use; closing changes nothing
        await dbmn.push({ ...MENU, current: 'theme:nord', system: null });
        await button.click();
        await expect(picker.locator('.theme-picker-name')).toHaveText('Nord');
        await expect(picker.locator('.theme-picker-use')).toHaveText('In use');
        await expect(picker.locator('.theme-slide[data-offset="0"] .theme-slide-badge')).toHaveText('In use');
        await picker.locator('.theme-picker-step.is-prev').click();
        await picker.locator('.theme-picker-close').click();
        await expect(picker).toBeHidden();
        expect(await dbmn.sent('setTheme')).toHaveLength(2);
    });

    test('a first visit gets the hint; closing it tells the host', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await dbmn.push({ ...MENU, hint: true });
        const hint = page.locator('.theme-hint');
        await expect(hint).toBeVisible();
        await expect(hint).toContainText('Change the theme');
        await hint.locator('.theme-hint-close').click();
        await expect(hint).toHaveCount(0);
        expect(await dbmn.sent('themeHintDone')).toHaveLength(1);
    });

    test('the hint is never in the way: a click anywhere else ends it, and so do 15 seconds', async ({ dbmn, page }) => {
        await page.clock.install();
        await dbmn.openHub();
        await dbmn.push({ ...MENU, hint: true });
        const hint = page.locator('.theme-hint');
        await expect(hint).toBeVisible();
        await page.locator('.hub-nav-item[data-section="settings"]').click();
        await expect(hint).toHaveCount(0);
        expect(await dbmn.sent('themeHintDone')).toHaveLength(1);

        await dbmn.push({ ...MENU, hint: true });
        await expect(hint).toBeVisible();
        await page.clock.runFor(15_000);
        await expect(hint).toHaveCount(0);
        expect(await dbmn.sent('themeHintDone')).toHaveLength(2);
    });

    test('following the hint opens the picker', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await dbmn.push({ ...MENU, hint: true });
        await page.locator('.theme-hint-open').click();
        await expect(page.locator('dialog.theme-picker')).toBeVisible();
        await expect(page.locator('.theme-hint')).toHaveCount(0);
        expect(await dbmn.sent('themeHintDone')).toHaveLength(1);
    });

    test('Follow system first, then the light themes and the dark ones; the picks go to the host', async ({ dbmn, page }) => {
        await dbmn.openHub();
        await page.locator('.hub-nav-item[data-section="settings"]').click();
        await dbmn.push(MENU);
        const theme = page.locator('#uiTheme');
        await expect(theme).toBeVisible();
        await expect(theme).toHaveValue('system');
        await expect(theme.locator('> option')).toHaveText(['Follow system']);
        await expect(theme.locator('optgroup')).toHaveCount(2);
        await expect(theme.locator('optgroup[label="Light"] option')).toHaveText(['Light', 'Flexoki Light']);
        await expect(theme.locator('optgroup[label="Dark"] option')).toHaveText(['Dark', 'Nord']);
        await expect(page.locator('#uiThemeHelp')).toHaveText(MENU.help);

        // Follow system, on a computer that only says light or dark: which theme each means
        await expect(page.locator('#uiThemeLight')).toHaveValue('theme:flexoki-light');
        await expect(page.locator('#uiThemeDark')).toHaveValue('default');
        await page.locator('#uiThemeDark').selectOption('theme:nord');
        expect((await dbmn.sent('setSystemTheme')).at(-1)?.message).toMatchObject({ mode: 'dark', id: 'theme:nord' });
        await page.locator('#uiThemeLight').selectOption('light');
        expect((await dbmn.sent('setSystemTheme')).at(-1)?.message).toMatchObject({ mode: 'light', id: 'light' });

        await theme.selectOption('theme:nord');
        expect((await dbmn.sent('setTheme')).at(-1)?.message).toMatchObject({ id: 'theme:nord' });
        // A named theme (or a desktop whose own theme is followed) has no light and dark to pick
        await dbmn.push({ ...MENU, current: 'theme:nord', system: null });
        await expect(theme).toHaveValue('theme:nord');
        await expect(page.locator('#uiThemeLightRow')).toBeHidden();
        await expect(page.locator('#uiThemeDarkRow')).toBeHidden();
    });

    test('in VS Code another theme goes over VS Code\'s on the Hub, and Follow system takes it off again', async ({ dbmn, page }) => {
        await dbmn.openHub();
        const background = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim().toLowerCase());
        expect(await background()).toBe('#1f1f1f');
        const nord = { tokens: { '--vscode-editor-background': '#2e3440', '--vscode-foreground': '#d8dee9' }, kind: 'vscode-dark' };
        await dbmn.push({ ...MENU, system: null, current: 'theme:nord', editorTheme: true, applied: nord });
        await expect.poll(background).toBe('#2e3440');
        await expect(page.locator('html')).toHaveAttribute('data-dbmn-theme', /\d+/);
        // The Hub tells the host VS Code's own colours, for Follow system's card
        await expect.poll(async () => (await dbmn.sent('editorTheme')).length).toBeGreaterThan(0);
        expect((await dbmn.sent('editorTheme')).at(-1)?.message).toMatchObject({ dark: true });

        // A light theme: the panels are light whatever VS Code is
        await dbmn.push({ ...MENU, system: null, current: 'light', editorTheme: true, applied: { tokens: { '--vscode-editor-background': '#ffffff' }, kind: 'vscode-light' } });
        await expect.poll(background).toBe('#ffffff');
        await expect(page.locator('body')).toHaveAttribute('data-vscode-theme-kind', 'vscode-light');

        // Follow system: VS Code's own colours and kind again
        await dbmn.push({ ...MENU, system: null, current: 'system', editorTheme: true, applied: null });
        await expect.poll(background).toBe('#1f1f1f');
        await expect(page.locator('body')).toHaveAttribute('data-vscode-theme-kind', 'vscode-dark');
        await expect(page.locator('#dbmnThemeOverride')).toHaveCount(0);
    });
});

