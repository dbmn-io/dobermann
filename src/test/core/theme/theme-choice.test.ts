// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #373: which theme the app wears outside VS Code: Follow system (the desktop's theme on Omarchy,
 * the computer's light or dark setting anywhere else), the standard Light and Dark, the bundled
 * themes; and the computer's accent colour on the standard ones.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { contrast } from '../../../services/theme/colour';
import { OMARCHY_THEMES } from '../../../services/theme/omarchy-themes.generated';
import { STANDARD_DARK_TOKENS } from '../../../services/theme/standard-dark';
import { STANDARD_LIGHT_TOKENS } from '../../../services/theme/standard-light';
import { accentTokens, normaliseAccent } from '../../../services/theme/system-accent';
import {
    DARK_THEME_ID, LIGHT_THEME_ID, SYSTEM_THEME_ID, chosenThemeId, darkThemes, lightThemes, normaliseThemeChoice, resolveTheme, themeMenu,
    type ThemeHost
} from '../../../services/theme/theme-choice';

const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');
/** Every colour the page's own sheet pins (the standard Dark), by token. */
function sheet(): Record<string, string> {
    const text = fs.readFileSync(path.join(SRC, 'test', 'ui', 'harness', 'vscode-theme.css'), 'utf8');
    return Object.fromEntries([...text.matchAll(/^\s*(--vscode-[A-Za-z0-9-]+):\s*([^;]+);/gm)].filter(match => !/font/i.test(match[1])).map(match => [match[1], match[2].trim()]));
}

const omarchy = { name: 'tokyo-night', palette: OMARCHY_THEMES.find(theme => theme.slug === 'tokyo-night')!.palette };
const windows: ThemeHost = { systemDark: true };
const BG = '--vscode-editor-background';

describe('The theme choice (#373)', () => {
    it('offers Follow system, then the light themes and the dark ones, the standard one first in each', () => {
        const menu = themeMenu(normaliseThemeChoice({}), windows);
        expect(menu.options).to.deep.equal([{ id: SYSTEM_THEME_ID, label: 'Follow system' }]);
        expect(menu.groups.map(group => group.label)).to.deep.equal(['Light', 'Dark']);
        expect(menu.groups[0].options[0]).to.deep.equal({ id: LIGHT_THEME_ID, label: 'Light' });
        expect(menu.groups[1].options[0]).to.deep.equal({ id: DARK_THEME_ID, label: 'Dark' });
        expect(menu.groups[0].options.map(option => option.label)).to.include.members(['Catppuccin Latte', 'Flexoki Light']);
        expect(menu.groups[1].options.map(option => option.label)).to.include.members(['Tokyo Night', 'Nord']);
        expect(menu.groups[0].options.length + menu.groups[1].options.length, 'every bundled theme, once').to.equal(2 + OMARCHY_THEMES.length);
        for (const option of lightThemes().slice(1)) expect(OMARCHY_THEMES.find(theme => `theme:${theme.slug}` === option.id)?.palette.mode, option.id).to.equal('light');
        for (const option of darkThemes().slice(1)) expect(OMARCHY_THEMES.find(theme => `theme:${theme.slug}` === option.id)?.palette.mode, option.id).to.equal('dark');
        // Nothing here names another product: not the editor the colours came from, not a desktop
        const words = JSON.stringify([menu.options, menu.groups.map(group => [group.label, group.options.slice(0, 1)]), menu.help]);
        expect(words).not.to.match(/VS ?Code|Omarchy/i);
    });

    it('follows the system until a theme is chosen; a stored choice that means nothing any more does too', () => {
        expect(normaliseThemeChoice({})).to.deep.equal({ theme: SYSTEM_THEME_ID, light: LIGHT_THEME_ID, dark: DARK_THEME_ID });
        expect(normaliseThemeChoice({ theme: 'theme:nord' }).theme).to.equal('theme:nord');
        expect(normaliseThemeChoice({ theme: 'theme:gone' }).theme).to.equal(SYSTEM_THEME_ID);
        expect(normaliseThemeChoice({ theme: DARK_THEME_ID }).theme, 'the standard Dark stays chosen').to.equal(DARK_THEME_ID);
        expect(normaliseThemeChoice({ theme: LIGHT_THEME_ID }).theme).to.equal(LIGHT_THEME_ID);
        expect(normaliseThemeChoice({ theme: 'omarchy' }).theme, 'what following the desktop was stored as').to.equal(SYSTEM_THEME_ID);
        // The light pick is a light theme and the dark pick a dark one, or the standard ones
        expect(normaliseThemeChoice({ light: 'theme:flexoki-light', dark: 'theme:nord' })).to.deep.include({ light: 'theme:flexoki-light', dark: 'theme:nord' });
        expect(normaliseThemeChoice({ light: 'theme:nord', dark: 'theme:flexoki-light' })).to.deep.include({ light: LIGHT_THEME_ID, dark: DARK_THEME_ID });
    });

    it('Follow system on Omarchy is the desktop\'s theme, whatever the light or dark setting says', () => {
        const choice = normaliseThemeChoice({ light: 'theme:flexoki-light', dark: 'theme:nord' });
        for (const systemDark of [true, false]) {
            const host: ThemeHost = { omarchy, systemDark, accent: '#ff0000' };
            expect(chosenThemeId(choice, host)).to.equal(SYSTEM_THEME_ID);
            const theme = resolveTheme(choice, host);
            expect(theme?.tokens[BG]).to.equal(omarchy.palette.background);
            expect(theme?.tokens['--vscode-button-background'], 'the desktop\'s theme keeps its own accent').not.to.equal('#ff0000');
        }
        const menu = themeMenu(choice, { omarchy, systemDark: true });
        expect(menu.system, 'nothing to pick: the desktop says which theme').to.equal(null);
        expect(menu.help).to.equal('This device\'s theme. Follow system keeps up with your desktop\'s theme (Tokyo Night).');
        // The desktop's own rendering wins over the bundled template: a user's template override counts
        const theirs = { ...omarchy, vscodeTheme: { type: 'light' as const, colors: { 'editor.background': '#abcdef' } } };
        expect(resolveTheme(choice, { omarchy: theirs, systemDark: true })).to.deep.include({ kind: 'vscode-light' });
        expect(resolveTheme(choice, { omarchy: theirs, systemDark: true })?.tokens[BG]).to.equal('#abcdef');
    });

    it('Follow system anywhere else switches between the light theme and the dark one with the computer', () => {
        const standard = normaliseThemeChoice({});
        expect(resolveTheme(standard, { systemDark: true }), 'the standard Dark is the page\'s own sheet').to.equal(undefined);
        expect(resolveTheme(standard, { systemDark: false })).to.deep.equal({ tokens: STANDARD_LIGHT_TOKENS, kind: 'vscode-light' });

        const picked = normaliseThemeChoice({ light: 'theme:flexoki-light', dark: 'theme:nord' });
        expect(chosenThemeId(picked, { systemDark: false })).to.equal('theme:flexoki-light');
        expect(chosenThemeId(picked, { systemDark: true })).to.equal('theme:nord');
        expect(resolveTheme(picked, { systemDark: false })?.kind).to.equal('vscode-light');
        expect(resolveTheme(picked, { systemDark: true })?.tokens[BG]).to.equal(OMARCHY_THEMES.find(theme => theme.slug === 'nord')!.palette.background);

        const menu = themeMenu(picked, { systemDark: true });
        expect(menu.current).to.equal(SYSTEM_THEME_ID);
        expect(menu.system?.light).to.deep.equal({ options: lightThemes(), current: 'theme:flexoki-light' });
        expect(menu.system?.dark).to.deep.equal({ options: darkThemes(), current: 'theme:nord' });
        expect(menu.help).to.equal('This device\'s theme. Follow system switches between your light and dark themes when your computer does.');
    });

    it('a chosen theme stays, whatever the computer does', () => {
        const nord = normaliseThemeChoice({ theme: 'theme:nord', light: 'theme:flexoki-light' });
        for (const host of [{ systemDark: false }, { systemDark: true }, { omarchy, systemDark: false }]) {
            expect(resolveTheme(nord, host)?.tokens[BG]).to.equal(OMARCHY_THEMES.find(theme => theme.slug === 'nord')!.palette.background);
            expect(themeMenu(nord, host).system, 'only Follow system has a light and a dark to pick').to.equal(null);
        }
        expect(resolveTheme(normaliseThemeChoice({ theme: LIGHT_THEME_ID }), { omarchy, systemDark: true })?.tokens[BG]).to.equal('#ffffff');
        expect(resolveTheme(normaliseThemeChoice({ theme: DARK_THEME_ID }), { omarchy, systemDark: false })).to.equal(undefined);
    });
});

describe('The standard Light theme (#373)', () => {
    it('has a colour for every colour the page\'s own sheet pins, and no others', () => {
        expect(Object.keys(STANDARD_LIGHT_TOKENS).sort()).to.deep.equal(Object.keys(sheet()).sort());
        for (const [name, value] of Object.entries(STANDARD_LIGHT_TOKENS)) expect(value, name).to.match(/^(#[0-9a-f]{6}([0-9a-f]{2})?|transparent)$/);
    });

    it('reads: text on its surfaces, buttons, links', () => {
        const t = STANDARD_LIGHT_TOKENS;
        const check = (token: string, against: string, minimum: number) => expect(contrast(t[token].slice(0, 7), t[against].slice(0, 7)), `${token} on ${against}`).to.be.at.least(minimum);
        check('--vscode-foreground', BG, 4.5);
        check('--vscode-descriptionForeground', BG, 4.5);
        check('--vscode-input-foreground', '--vscode-input-background', 4.5);
        check('--vscode-foreground', '--vscode-sideBar-background', 4.5);
        check('--vscode-button-foreground', '--vscode-button-background', 4.5);
        check('--vscode-button-secondaryForeground', '--vscode-button-secondaryBackground', 4.5);
        check('--vscode-textLink-foreground', BG, 4.5);
    });
});

describe('The computer\'s accent colour (#373)', () => {
    it('is a colour as Windows and macOS give it, or nothing', () => {
        expect(normaliseAccent('0078d4ff')).to.equal('#0078d4');
        expect(normaliseAccent('#F7630C')).to.equal('#f7630c');
        expect(normaliseAccent(' aabbcc ')).to.equal('#aabbcc');
        for (const not of [undefined, null, 7, '', 'red', '#abc', '0078d4f', 'url(x)', '#0078d4; color: red']) expect(normaliseAccent(not), String(not)).to.equal(undefined);
    });

    it('goes on the standard themes where their own blue was, and nowhere on a named theme', () => {
        const accent = '#8e44ad';
        const dark = resolveTheme(normaliseThemeChoice({ theme: DARK_THEME_ID }), { systemDark: true, accent });
        expect(dark?.kind).to.equal('vscode-dark');
        expect(dark?.tokens['--vscode-button-background']).to.equal(accent);
        expect(dark?.tokens['--vscode-focusBorder']).to.equal(accent);
        expect(dark?.tokens['--vscode-progressBar-background']).to.equal(accent);
        expect(dark?.tokens[BG], 'the rest is the page\'s own sheet').to.equal(undefined);
        for (const token of Object.keys(dark!.tokens)) expect(sheet(), `${token} is a colour the sheet pins`).to.have.property(token);

        const light = resolveTheme(normaliseThemeChoice({}), { systemDark: false, accent });
        expect(light?.kind).to.equal('vscode-light');
        expect(light?.tokens['--vscode-button-background']).to.equal(accent);
        expect(light?.tokens[BG]).to.equal('#ffffff');
        expect(light?.tokens['--vscode-list-activeSelectionBackground'], 'Light keeps its grey selected row').to.equal(STANDARD_LIGHT_TOKENS['--vscode-list-activeSelectionBackground']);

        const nord = resolveTheme(normaliseThemeChoice({ theme: 'theme:nord' }), { systemDark: true, accent });
        expect(nord?.tokens['--vscode-button-background']).not.to.equal(accent);
    });

    it('stays readable whatever the accent: button text, the selected row, and links only where they read', () => {
        const darkBg = sheet()[BG];
        const lightBg = STANDARD_LIGHT_TOKENS[BG];
        for (const accent of ['#0078d4', '#ffb900', '#e81123', '#107c10', '#ffffff', '#000000', '#767676', '#f7630c', '#00b7c3', '#e3008c']) {
            for (const [kind, background] of [['dark', darkBg], ['light', lightBg]] as const) {
                const tokens = accentTokens(accent, kind, background);
                expect(contrast(tokens['--vscode-button-foreground'], tokens['--vscode-button-background']), `${accent} ${kind}: button text`).to.be.at.least(3);
                expect(tokens['--vscode-button-hoverBackground'], `${accent} ${kind}: hover is a colour`).to.match(/^#[0-9a-f]{6}$/);
                const link = tokens['--vscode-textLink-foreground'];
                if (link) expect(contrast(link, background), `${accent} ${kind}: link`).to.be.at.least(4.5);
                if (kind === 'dark') expect(contrast('#ffffff', tokens['--vscode-list-activeSelectionBackground']), `${accent}: selected row text`).to.be.at.least(4.5);
                else expect(tokens).not.to.have.property('--vscode-list-activeSelectionBackground');
            }
        }
        // An accent the page can't carry as text leaves the theme's own link colour alone
        expect(accentTokens('#ffb900', 'light', lightBg)).not.to.have.property('--vscode-textLink-foreground');
        expect(accentTokens('#ffb900', 'dark', darkBg)['--vscode-textLink-foreground']).to.equal('#ffb900');
    });
});

describe('The theme choice in VS Code', () => {
    const vscodeDark: ThemeHost = { systemDark: true, editor: { tokens: { '--vscode-editor-background': '#1e1e1e', '--vscode-button-background': '#0e639c' }, dark: true } };

    it('the standard Dark has every colour the page\'s own sheet pins, as it pins them', () => {
        expect(STANDARD_DARK_TOKENS).to.deep.equal(sheet());
    });

    it('Follow system is VS Code\'s theme: nothing goes over it, and there is no light or dark to pick', () => {
        const choice = normaliseThemeChoice({});
        expect(resolveTheme(choice, vscodeDark)).to.equal(undefined);
        expect(resolveTheme(choice, { ...vscodeDark, systemDark: false })).to.equal(undefined);
        const menu = themeMenu(choice, vscodeDark);
        expect(menu.system).to.equal(null);
        expect(menu.help).to.contain('VS Code');
        // Its card is drawn in VS Code's colours, as the Hub read them
        expect(menu.previews.system.background).to.equal('#1e1e1e');
        expect(menu.previews.system.button).to.equal('#0e639c');
    });

    it('any other theme goes over VS Code\'s in full, the standard Dark included', () => {
        expect(resolveTheme(normaliseThemeChoice({ theme: DARK_THEME_ID }), vscodeDark)).to.deep.equal({ tokens: STANDARD_DARK_TOKENS, kind: 'vscode-dark' });
        expect(resolveTheme(normaliseThemeChoice({ theme: LIGHT_THEME_ID }), vscodeDark)?.kind).to.equal('vscode-light');
        expect(resolveTheme(normaliseThemeChoice({ theme: 'theme:nord' }), vscodeDark)?.tokens[BG]).to.equal('#2e3440');
        // Outside VS Code the standard Dark is still the page's own sheet
        expect(resolveTheme(normaliseThemeChoice({ theme: DARK_THEME_ID }), windows)).to.equal(undefined);
    });
});

