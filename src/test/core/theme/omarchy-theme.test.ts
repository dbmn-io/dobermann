// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #373: an Omarchy theme as the screens' tokens (Omarchy's own VS Code theme, rendered here), and
 * the choice of theme outside VS Code.
 */
import { expect } from 'chai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { contrast } from '../../../services/theme/colour';
import { omarchyThemeName, parseColorsToml, parseColorsValues, resolvePalette } from '../../../services/theme/omarchy-palette';
import { OMARCHY_THEMES } from '../../../services/theme/omarchy-themes.generated';
import { OMARCHY_VSCODE_TEMPLATE } from '../../../services/theme/omarchy-vscode-template.generated';
import { omarchyMix, renderVscodeTheme, tokensFromVscodeTheme } from '../../../services/theme/omarchy-vscode-theme';

const TOKYO = `mode = "dark"

accent = "#7aa2f7"
selection = "#292e42"
muted = "#414868"
background = "#1a1b26"
dark_background = "#13141c"
darker_background = "#0e0e14"
lighter_background = "#24283b"
foreground = "#a9b1d6"
dark_foreground = "#565f89"
light_foreground = "#b4bee6"
bright_foreground = "#c0caf5"
red = "#f7768e"
yellow = "#e0af68"
orange = "#eb927b"
green = "#9ece6a"
cyan = "#449dab"
blue = "#7aa2f7"
magenta = "#ad8ee6"
brown = "#75493d"
bright_red = "#ff7a93"
bright_yellow = "#ff9e64"
bright_green = "#b9f27c"
bright_cyan = "#0db9d7"
bright_blue = "#7da6ff"
bright_magenta = "#bb9af7"
`;

const SRC = path.resolve(__dirname, '../../../../src');
/** Omarchy, where the tests run on it: its themes and its resolver, to hold ours to. */
const OMARCHY_THEMES_DIR = '/usr/share/omarchy/themes';
const OMARCHY_CURRENT = path.join(os.homedir(), '.local', 'state', 'omarchy', 'current', 'theme');
const hasOmarchy = (): boolean => {
    try {
        execFileSync('omarchy-theme-color', ['--help'], { stdio: 'ignore' });
        return fs.existsSync(OMARCHY_THEMES_DIR);
    } catch {
        return false;
    }
};

/** Every --vscode-* token the sheet pins outside VS Code (src/test/ui/harness/vscode-theme.css). */
function sheetTokens(): string[] {
    const sheet = fs.readFileSync(path.join(SRC, 'test', 'ui', 'harness', 'vscode-theme.css'), 'utf8');
    return [...new Set([...sheet.matchAll(/(--vscode-[a-zA-Z-]+):/g)].map(match => match[1]))];
}

const COLOUR = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;

describe('An Omarchy theme as the screens\' tokens (#373)', () => {
    it('reads a colors.toml, and names what is wrong with one that isn\'t a palette', () => {
        const parsed = parseColorsToml(TOKYO);
        expect(parsed.ok).to.equal(true);
        if (!parsed.ok) return;
        expect(parsed.palette.mode).to.equal('dark');
        expect(parsed.palette.accent).to.equal('#7aa2f7');
        expect(parsed.palette.orange).to.equal('#eb927b');
        // Extra keys some themes carry (hyprland borders, kitty tabs) come along, as Omarchy keeps them
        expect(parseColorsToml(TOKYO + 'hyprland_active_border = "rgba(26a269ee) rgba(2ec27eee) 45deg"\n').ok).to.equal(true);
        // Unquoted values and inline comments, as Omarchy reads them
        expect(parseColorsValues('accent = #7aa2f7\nred = "#f7768e" # rose\n')).to.deep.equal({ accent: '#7aa2f7', red: '#f7768e' });

        const broken = parseColorsToml(TOKYO.replace('background = "#1a1b26"', 'background = "night"'));
        expect(broken.ok).to.equal(false);
        if (!broken.ok) expect(broken.error).to.match(/^background: /);
        expect(parseColorsToml('mode = "dark"\n').ok).to.equal(false);
        expect(parseColorsToml('').ok).to.equal(false);
    });

    it('resolves a palette as Omarchy does: legacy names, derived shades, the mode from the background', () => {
        // A theme from before the semantic palette: ANSI names and short names only
        const legacy = resolvePalette(parseColorsValues(`bg = "#1a1b26"
fg = "#a9b1d6"
accent = "#7aa2f7"
color1 = "#f7768e"
color2 = "#9ece6a"
color3 = "#e0af68"
color4 = "#7aa2f7"
color5 = "#ad8ee6"
color6 = "#449dab"
color8 = "#414868"
color15 = "#c0caf5"
`));
        expect(legacy.background).to.equal('#1a1b26');
        expect(legacy.red).to.equal('#f7768e');
        expect(legacy.magenta).to.equal('#ad8ee6');
        expect(legacy.purple, 'purple is magenta').to.equal('#ad8ee6');
        expect(legacy.muted).to.equal('#414868');
        expect(legacy.dark_foreground, 'from color8').to.equal('#414868');
        expect(legacy.bright_foreground, 'from color15').to.equal('#c0caf5');
        expect(legacy.selection, 'from color8').to.equal('#414868');
        expect(legacy.selection_foreground).to.equal('#c0caf5');
        expect(legacy.orange, 'orange is yellow').to.equal('#e0af68');
        expect(legacy.brown, 'orange, half way to black').to.equal('#705834');
        expect(legacy.dark_background, 'a quarter to black').to.equal('#14141d');
        expect(legacy.darker_background).to.equal('#0d0e13');
        expect(legacy.bright_red, 'a fifth to white').to.equal('#f991a5');
        expect(legacy.color0).to.equal('#1a1b26');
        expect(legacy.color7).to.equal('#a9b1d6');
        expect(legacy.mode, 'a dark background').to.equal('dark');
        expect(legacy.theme_type).to.equal('dark');
        expect(resolvePalette({ background: '#eff1f5', foreground: '#4c4f69' }).mode, 'a light one').to.equal('light');
        expect(resolvePalette({ theme_type: 'light', background: '#000000' }).mode, 'said, not guessed').to.equal('light');
        expect(resolvePalette({ purple: '#ad8ee6' }).magenta).to.equal('#ad8ee6');
        expect(resolvePalette({ blue: '#7aa2f7' }).accent, 'ours: an accent for a theme without one').to.equal('#7aa2f7');
        // The schema is happy with what the cascade fills in
        expect(parseColorsToml('mode = "dark"\nbackground = "#1a1b26"\nforeground = "#a9b1d6"\naccent = "#7aa2f7"\nred = "#f7768e"\ngreen = "#9ece6a"\nyellow = "#e0af68"\nblue = "#7aa2f7"\nmagenta = "#ad8ee6"\ncyan = "#449dab"\n').ok).to.equal(true);
    });

    it('resolves every stock theme exactly as omarchy-theme-color does (on Omarchy)', function () {
        if (!hasOmarchy()) return this.skip();
        let compared = 0;
        for (const slug of fs.readdirSync(OMARCHY_THEMES_DIR)) {
            const file = path.join(OMARCHY_THEMES_DIR, slug, 'colors.toml');
            if (!fs.existsSync(file)) continue;
            const theirs: Record<string, string> = {};
            for (const line of execFileSync('omarchy-theme-color', ['--file', file, '--all'], { encoding: 'utf8' }).split('\n')) {
                const [key, value] = line.split('\t');
                if (key) theirs[key] = value;
            }
            const ours = resolvePalette(parseColorsValues(fs.readFileSync(file, 'utf8')));
            for (const key of Object.keys(theirs)) expect(ours[key], `${slug}: ${key}`).to.equal(theirs[key]);
            compared++;
        }
        expect(compared).to.be.greaterThan(15);
    });

    it('mixes two palette colours as Omarchy 4.5\'s templates do ({{ mix background foreground 6% }})', () => {
        const values = { background: '#121212', foreground: '#bebebe', named: 'not a colour' };
        // Omarchy's own rendering of the current line on its default theme (vscode-theme.json)
        expect(omarchyMix(values, 'mix', 'background', 'foreground', '6%')).to.equal('#1c1c1c');
        expect(omarchyMix(values, 'mix', 'background', 'foreground', '30%')).to.equal('#464646');
        expect(omarchyMix(values, 'mix', 'background', 'foreground', '0.3'), 'a fraction').to.equal('#464646');
        expect(omarchyMix(values, 'mix', 'background', 'foreground', '30'), 'above 1 is a percentage').to.equal('#464646');
        expect(omarchyMix(values, 'mix', 'background', 'foreground', '150%'), 'held to 1').to.equal('#bebebe');
        expect(omarchyMix(values, 'mix_strip', 'background', 'foreground', '30%')).to.equal('464646');
        expect(omarchyMix(values, 'mix_rgb', 'background', 'foreground', '30%')).to.equal('70,70,70');
        expect(omarchyMix(values, 'mix', 'background', 'named', '30%'), 'not a colour: left unfilled').to.equal(undefined);
        expect(omarchyMix(values, 'mix', 'background', 'missing', '30%')).to.equal(undefined);
    });

    it('renders the template over a palette: every colour filled, light or dark by the palette', () => {
        const parsed = parseColorsToml(TOKYO);
        if (!parsed.ok) throw new Error(parsed.error);
        expect(Object.keys(OMARCHY_VSCODE_TEMPLATE.colors).length).to.be.greaterThan(600);
        const theme = renderVscodeTheme(parsed.palette);
        expect(theme.type).to.equal('dark');
        expect(Object.keys(theme.colors).length).to.equal(Object.keys(OMARCHY_VSCODE_TEMPLATE.colors).length);
        for (const [name, value] of Object.entries(theme.colors)) expect(value, name).to.match(COLOUR);
        expect(theme.colors['editor.background']).to.equal('#1a1b26');
        expect(theme.colors['focusBorder'], 'the accent, half transparent').to.equal('#7aa2f780');
        expect(renderVscodeTheme(OMARCHY_THEMES.find(candidate => candidate.slug === 'catppuccin-latte')!.palette).type).to.equal('light');
    });

    it('renders what Omarchy rendered for the desktop\'s current theme (on Omarchy)', function () {
        const rendered = path.join(OMARCHY_CURRENT, 'vscode-theme.json');
        const colors = path.join(OMARCHY_CURRENT, 'colors.toml');
        const override = path.join(os.homedir(), '.config', 'omarchy', 'themed', 'vscode-theme.json.tpl');
        if (!fs.existsSync(rendered) || !fs.existsSync(colors) || fs.existsSync(override)) return this.skip();
        const parsed = parseColorsToml(fs.readFileSync(colors, 'utf8'));
        if (!parsed.ok) throw new Error(parsed.error);
        const theirs = JSON.parse(fs.readFileSync(rendered, 'utf8')) as { type: string; colors: Record<string, string> };
        const ours = renderVscodeTheme(parsed.palette);
        expect(ours.type).to.equal(theirs.type);
        expect(ours.colors).to.deep.equal(theirs.colors);
    });

    it('fills every token the screens use, by VS Code\'s names', () => {
        const parsed = parseColorsToml(TOKYO);
        if (!parsed.ok) throw new Error(parsed.error);
        const { tokens, kind } = tokensFromVscodeTheme(renderVscodeTheme(parsed.palette));
        expect(kind).to.equal('vscode-dark');
        const expected = sheetTokens().filter(token => !/font/i.test(token));
        const missing = expected.filter(token => !(token in tokens));
        expect(missing, 'tokens the sheet pins but the theme leaves out').to.deep.equal([]);
        for (const [name, value] of Object.entries(tokens)) expect(value, name).to.match(/^(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?|transparent)$/);
        expect(tokens['--vscode-editor-background']).to.equal('#1a1b26');
        expect(tokens['--vscode-list-activeSelectionBackground'], 'the accent, mostly transparent').to.equal('#7aa2f730');
        // What no VS Code theme names comes from the nearest colour it does
        expect(tokens['--vscode-list-headerBackground']).to.equal(tokens['--vscode-sideBarSectionHeader-background']);
        expect(tokens['--vscode-widget-border']).to.equal(tokens['--vscode-editorWidget-border']);
        expect(tokens['--vscode-contrastBorder']).to.equal('transparent');
    });

    it('reads on every bundled theme, light or dark', () => {
        expect(OMARCHY_THEMES.length).to.be.greaterThan(15);
        expect(OMARCHY_THEMES.some(theme => theme.palette.mode === 'light'), 'light themes among them').to.equal(true);
        for (const { slug, palette } of OMARCHY_THEMES) {
            const { tokens, kind } = tokensFromVscodeTheme(renderVscodeTheme(palette));
            expect(kind).to.equal(palette.mode === 'light' ? 'vscode-light' : 'vscode-dark');
            const bg = tokens['--vscode-editor-background'];
            const check = (token: string, against: string, minimum: number) => {
                const ratio = contrast(tokens[token].slice(0, 7), against.slice(0, 7));
                expect(ratio, `${slug}: ${token} on ${against}`).to.be.at.least(minimum);
            };
            // What must read: text on its surfaces, buttons, links. Omarchy mutes the rest
            // (descriptions are the palette's `muted`) and that is its call, not ours.
            check('--vscode-foreground', bg, 4.5);
            check('--vscode-input-foreground', tokens['--vscode-input-background'], 4.5);
            check('--vscode-foreground', tokens['--vscode-sideBar-background'], 4.5);
            check('--vscode-button-foreground', tokens['--vscode-button-background'], 3);
            check('--vscode-textLink-foreground', bg, 3);
        }
    });
});
