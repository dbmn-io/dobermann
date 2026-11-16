// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The theme picker's mock screens, and dbmn.io's colours in each theme: both from the tokens the
 * app wears, so a card is the app in that theme and the website follows the app.
 */
import { expect } from 'chai';
import { contrast } from '../../../services/theme/colour';
import { OMARCHY_THEMES } from '../../../services/theme/omarchy-themes.generated';
import { STANDARD_LIGHT_TOKENS } from '../../../services/theme/standard-light';
import { darkThemes, lightThemes, normaliseThemeChoice, resolveTheme, themeMenu, type ThemeHost } from '../../../services/theme/theme-choice';
import { previewOf, siteTokens } from '../../../services/theme/theme-preview';

const browser: ThemeHost = { systemDark: true };
const every = () => [...lightThemes(), ...darkThemes()];
const previewFor = (id: string, host: ThemeHost = browser) => previewOf(resolveTheme(normaliseThemeChoice({ theme: id }), host));

describe('Theme previews (the theme picker)', () => {
    it('come with the menu: one for every theme, and Follow system as it is now', () => {
        const menu = themeMenu(normaliseThemeChoice({}), browser);
        expect(Object.keys(menu.previews).sort()).to.deep.equal(['system', ...every().map(option => option.id)].sort());
        expect(menu.previews.system, 'a dark computer: the standard Dark').to.deep.equal(menu.previews.default);
        const light = themeMenu(normaliseThemeChoice({ light: 'theme:flexoki-light' }), { systemDark: false });
        expect(light.previews.system, 'a light computer: the light pick').to.deep.equal(light.previews['theme:flexoki-light']);
    });

    it('draw the standard Dark as the page\'s own sheet, the standard Light as Light Modern', () => {
        expect(previewFor('default')).to.deep.include({ mode: 'dark', background: '#1f1f1f', sidebar: '#181818', text: '#cccccc', button: '#0078d4' });
        expect(previewFor('light')).to.deep.include({
            mode: 'light',
            background: STANDARD_LIGHT_TOKENS['--vscode-editor-background'],
            button: STANDARD_LIGHT_TOKENS['--vscode-button-background']
        });
        // Light Modern's orange carries alpha; a preview is solid colours
        expect(previewFor('light').methods.put).to.match(/^#[0-9a-f]{6}$/);
    });

    it('draw a named theme in its palette: page, pills and mode', () => {
        const nord = OMARCHY_THEMES.find(theme => theme.slug === 'nord')!.palette;
        const preview = previewFor('theme:nord');
        expect(preview.mode).to.equal('dark');
        expect(preview.background).to.equal('#2e3440');
        expect(preview.methods).to.deep.equal({ get: nord.green.toLowerCase(), post: nord.blue.toLowerCase(), put: nord.orange.toLowerCase(), patch: nord.magenta.toLowerCase(), delete: nord.red.toLowerCase() });
        for (const option of lightThemes()) expect(previewFor(option.id).mode, option.id).to.equal('light');
        for (const option of darkThemes()) expect(previewFor(option.id).mode, option.id).to.equal('dark');
    });

    it('wear the computer\'s accent on the standard themes, as the app does', () => {
        expect(previewFor('default', { systemDark: true, accent: '#e81123' }).button).to.not.equal(previewFor('default').button);
        expect(previewFor('theme:nord', { systemDark: true, accent: '#e81123' })).to.deep.equal(previewFor('theme:nord'));
    });
});

describe('dbmn.io in each theme', () => {
    it('sets every colour the site reads, as solid colours', () => {
        for (const option of every()) {
            const site = siteTokens(previewFor(option.id));
            expect(Object.keys(site), option.id).to.include.members(['--brand-bg-start', '--brand-bg-end', '--brand-accent', '--brand-accent-text', '--brand-text', '--brand-text-body', '--brand-text-muted', '--brand-surface', '--brand-border', '--brand-link']);
            for (const [name, value] of Object.entries(site)) expect(value, `${option.id} ${name}`).to.match(/^#[0-9a-f]{6}$/);
        }
    });

    it('reads in every theme: body text on the page and on its surfaces', () => {
        for (const option of every()) {
            const site = siteTokens(previewFor(option.id));
            expect(contrast(site['--brand-text-body'], site['--brand-bg-start']), `${option.id} text`).to.be.at.least(4.5);
            expect(contrast(site['--brand-text-body'], site['--brand-surface']), `${option.id} text on a card`).to.be.at.least(4.5);
            expect(contrast(site['--brand-text-muted'], site['--brand-bg-start']), `${option.id} muted text`).to.be.at.least(4.5);
            expect(contrast(site['--brand-text-muted'], site['--brand-surface']), `${option.id} muted text on a card`).to.be.at.least(4.5);
            expect(contrast(site['--brand-accent-text'], site['--brand-accent']), `${option.id} a button's label`).to.be.at.least(3);
        }
    });
});
