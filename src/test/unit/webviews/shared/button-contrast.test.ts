// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { JSDOM } from 'jsdom';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Readable buttons in every theme (src/webviews/shared/button-contrast.js).
 *
 * DBMN's buttons take fill and text from the theme's two button pairs. Omarchy's VS Code
 * theme pairs the secondary button's muted fill with the theme's text colour: on the palette
 * below that is pale peach on lavender, 2.8:1, next to a main-action button of nearly the
 * same lavender with dark text. Same-looking buttons, different text, one of them hard to read.
 */
const SCRIPT = path.resolve(__dirname, '../../../../../src/webviews/shared/button-contrast.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const contrastModule = require(SCRIPT) as {
    MIN_TEXT_CONTRAST: number;
    parseColor(value: string): { r: number; g: number; b: number; a: number } | null;
    contrast(a: object, b: object): number;
    correctButton(theme: { pageBackground: string; pageText: string; fill: string; hoverFill: string; text: string }): { text: string | null; hoverFill: string | null };
    correctPrimaryFill(theme: { pageBackground: string; pageText: string; fill: string; accents: string[] }): { fill: string; text: string; hoverFill: string } | null;
};
const { parseColor, contrast, correctButton, correctPrimaryFill, MIN_TEXT_CONTRAST } = contrastModule;
const ratio = (a: string, b: string) => contrast(parseColor(a)!, parseColor(b)!);

/** The theme properties a page is given, per theme. */
const THEMES = {
    omarchy: {
        '--vscode-foreground': '#ffcead', '--vscode-editor-background': '#060B1E',
        '--vscode-button-background': '#7d82d9', '--vscode-button-hoverBackground': '#7d82d9', '--vscode-button-foreground': '#060B1E',
        '--vscode-button-secondaryBackground': '#6d7db6', '--vscode-button-secondaryHoverBackground': '#060B1E', '--vscode-button-secondaryForeground': '#ffcead'
    },
    darkModern: {
        '--vscode-foreground': '#cccccc', '--vscode-editor-background': '#1f1f1f',
        '--vscode-button-background': '#0078d4', '--vscode-button-hoverBackground': '#026ec1', '--vscode-button-foreground': '#ffffff',
        '--vscode-button-secondaryBackground': '#313131', '--vscode-button-secondaryHoverBackground': '#3c3c3c', '--vscode-button-secondaryForeground': '#cccccc'
    },
    lightModern: {
        '--vscode-foreground': '#3b3b3b', '--vscode-editor-background': '#ffffff',
        '--vscode-button-background': '#005fb8', '--vscode-button-hoverBackground': '#0258a8', '--vscode-button-foreground': '#ffffff',
        '--vscode-button-secondaryBackground': '#e5e5e5', '--vscode-button-secondaryHoverBackground': '#cccccc', '--vscode-button-secondaryForeground': '#3b3b3b'
    }
} as const;
type Theme = Record<string, string>;

const pair = (theme: Theme, kind: 'primary' | 'secondary') => correctButton({
    pageBackground: theme['--vscode-editor-background'], pageText: theme['--vscode-foreground'],
    fill: theme[kind === 'primary' ? '--vscode-button-background' : '--vscode-button-secondaryBackground'],
    hoverFill: theme[kind === 'primary' ? '--vscode-button-hoverBackground' : '--vscode-button-secondaryHoverBackground'],
    text: theme[kind === 'primary' ? '--vscode-button-foreground' : '--vscode-button-secondaryForeground']
});

describe('Readable buttons in every theme', () => {
    describe('the rule', () => {
        it('the case that started this: pale text on the secondary fill is replaced by the one that reads', () => {
            const theme = THEMES.omarchy;
            expect(ratio(theme['--vscode-button-secondaryForeground'], theme['--vscode-button-secondaryBackground']), 'the theme\'s own pair').to.be.lessThan(3);
            const corrected = pair(theme, 'secondary');
            expect(corrected.text, 'the page\'s background colour: dark text').to.equal('#060b1e');
            expect(ratio(corrected.text!, theme['--vscode-button-secondaryBackground'])).to.be.at.least(MIN_TEXT_CONTRAST);
        });

        it('so both kinds of button now carry the same text colour on that theme', () => {
            const primary = pair(THEMES.omarchy, 'primary');
            expect(primary.text, 'the main action already read well: left as the theme has it').to.equal(null);
            expect(pair(THEMES.omarchy, 'secondary').text).to.equal(THEMES.omarchy['--vscode-button-foreground'].toLowerCase());
        });

        it('a hover fill the new text cannot be read on becomes a shade of the button\'s own fill', () => {
            const theme = THEMES.omarchy;
            const corrected = pair(theme, 'secondary');
            expect(corrected.hoverFill, 'the theme\'s hover is the page background: dark text would vanish').to.be.a('string');
            expect(ratio(corrected.text!, corrected.hoverFill!), 'reads at least as well as at rest')
                .to.be.at.least(ratio(corrected.text!, theme['--vscode-button-secondaryBackground']));
            expect(ratio(corrected.hoverFill!, theme['--vscode-button-secondaryBackground']), 'still the same button, a little lighter').to.be.within(1.05, 1.6);
        });

        it('themes whose pairs already read are left exactly as they are', () => {
            for (const theme of [THEMES.darkModern, THEMES.lightModern]) {
                expect(pair(theme, 'primary')).to.deep.equal({ text: null, hoverFill: null });
                expect(pair(theme, 'secondary')).to.deep.equal({ text: null, hoverFill: null });
            }
        });

        it('a replacement is used only when it is better than what the theme had', () => {
            // Nothing reads on mid-grey; the theme's own (the best of a bad lot) stays
            const corrected = correctButton({ pageBackground: '#808080', pageText: '#8a8a8a', fill: '#7a7a7a', hoverFill: '#7a7a7a', text: '#9a9a9a' });
            expect(corrected.text).to.equal(null);
        });

        it('a colour it cannot read leaves the theme alone', () => {
            expect(correctButton({ pageBackground: '', pageText: '#fff', fill: 'var(--x)', hoverFill: '', text: '#000' })).to.deep.equal({ text: null, hoverFill: null });
        });

        it('reads the colour forms a theme uses, and see-through fills over the page', () => {
            expect(parseColor('#fff')).to.deep.equal({ r: 255, g: 255, b: 255, a: 1 });
            expect(parseColor('#06 0B1E'.replace(' ', ''))).to.deep.equal({ r: 6, g: 11, b: 30, a: 1 });
            expect(parseColor('#7d82d920')!.a).to.be.closeTo(0.125, 0.001);
            expect(parseColor('rgba(125, 130, 217, 0.5)')).to.deep.equal({ r: 125, g: 130, b: 217, a: 0.5 });
            expect(parseColor('rgb(6 11 30)')).to.deep.equal({ r: 6, g: 11, b: 30, a: 1 });
            expect(parseColor('transparent')).to.equal(null);
            // A 50% white fill on a dark page is mid-grey: the pale text does not read on it, dark does
            const corrected = correctButton({ pageBackground: '#101010', pageText: '#eeeeee', fill: 'rgba(255,255,255,0.5)', hoverFill: 'rgba(255,255,255,0.6)', text: '#eeeeee' });
            expect(corrected.text).to.equal('#101010');
        });
    });

    describe('the main action always stands apart', () => {
        // Retro '82's colours, as a DBMN tab got them with no button colours (Run Batch's Next drew as plain text)
        const retro = { pageBackground: '#00172E', pageText: '#A7C9C6' };
        it('a theme with no fill for it: the first accent that stands out, with the text that reads on it', () => {
            const fixed = correctPrimaryFill({ ...retro, fill: '', accents: ['', '#FAA968'] })!;
            expect(fixed.fill).to.equal('#faa968');
            expect(ratio(fixed.text, fixed.fill)).to.be.at.least(MIN_TEXT_CONTRAST);
            expect(fixed.hoverFill).to.match(/^#[0-9a-f]{6}$/);
        });
        it('a fill that is the page\'s own colour counts as none; an accent that is the page\'s too is passed over', () => {
            const fixed = correctPrimaryFill({ ...retro, fill: '#00172E', accents: ['#01182f', '#FAA968'] })!;
            expect(fixed.fill).to.equal('#faa968');
        });
        it('a theme whose main action stands out already is left alone, and so is one with no accent to use', () => {
            expect(correctPrimaryFill({ ...retro, fill: '#FAA968', accents: ['#3F8F8A'] })).to.equal(null);
            expect(correctPrimaryFill({ ...retro, fill: '', accents: ['', 'var(--x)'] })).to.equal(null);
        });
    });

    describe('in a page', () => {
        function page(theme: Theme) {
            const dom = new JSDOM('<!DOCTYPE html><html><body><button class="btn btn-secondary">Use a folder…</button></body></html>', { runScripts: 'outside-only' });
            const root = dom.window.document.documentElement;
            const setTheme = (next: Theme) => { for (const [name, value] of Object.entries(next)) { root.style.setProperty(name, value); } };
            setTheme(theme);
            dom.window.eval(fs.readFileSync(SCRIPT, 'utf8'));
            const body = dom.window.document.body;
            const corrected = (name: string) => body.style.getPropertyValue(name);
            const settle = () => new Promise(resolve => setTimeout(resolve, 20));
            return { dom, root, setTheme, corrected, settle };
        }

        it('the correction goes on <body>; the theme\'s own values stay on <html>', () => {
            const { root, corrected } = page({ ...THEMES.omarchy });
            expect(corrected('--vscode-button-secondaryForeground')).to.equal('#060b1e');
            expect(corrected('--vscode-button-secondaryHoverBackground')).to.match(/^#[0-9a-f]{6}$/);
            expect(corrected('--vscode-button-foreground'), 'the main action is left alone').to.equal('');
            expect(root.style.getPropertyValue('--vscode-button-secondaryForeground'), 'the theme is not rewritten').to.equal('#ffcead');
        });

        it('the main action with no fill of its own gets the accent on <body>, with its text', () => {
            const { corrected } = page({ '--vscode-editor-background': '#00172E', '--vscode-foreground': '#A7C9C6', '--vscode-focusBorder': '#FAA968' } as unknown as Theme);
            expect(corrected('--vscode-button-background')).to.equal('#faa968');
            expect(corrected('--vscode-button-foreground')).to.equal('#00172e');
        });

        it('a theme that already reads gets nothing added', () => {
            const { dom } = page({ ...THEMES.darkModern });
            expect(dom.window.document.body.getAttribute('style') || '').to.equal('');
        });

        it('follows a theme change: corrected when the new theme needs it, and taken off when it does not', async () => {
            const { setTheme, corrected, settle } = page({ ...THEMES.darkModern });
            setTheme({ ...THEMES.omarchy });
            await settle();
            expect(corrected('--vscode-button-secondaryForeground')).to.equal('#060b1e');

            setTheme({ ...THEMES.lightModern });
            await settle();
            expect(corrected('--vscode-button-secondaryForeground')).to.equal('');
            expect(corrected('--vscode-button-secondaryHoverBackground')).to.equal('');
        });
    });

    // One rule for every screen: a screen that does not load the script keeps the theme's
    // own (possibly unreadable) pair. A new screen is added here.
    describe('every screen loads it, first in the body', () => {
        const ROOT = path.resolve(__dirname, '../../../../..');
        const SCREENS: Array<[string, RegExp]> = [
            ['src/webviews/hub/hub.html', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\{\{BUTTON_CONTRAST_JS_URI\}\}">/],
            ['src/webviews/endpoint/endpoint.html', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\{\{BUTTON_CONTRAST_SCRIPT\}\}">/],
            ['src/webviews/environment/environment.html', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\{\{BUTTON_CONTRAST_SCRIPT\}\}">/],
            ['src/webviews/console/console.html', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\{\{BUTTON_CONTRAST_URI\}\}">/],
            ['src/webviews/import-export/import-export.html', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\{\{BUTTON_CONTRAST_SCRIPT\}\}">/],
            ['src/screens/run-batch/run-batch-page.ts', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\$\{asset\('shared\/button-contrast\.js'\)\}">/],
            ['web/signin.html', /<body[^>]*>\s*(<!--[\s\S]*?-->\s*)?<script src="\/webviews\/shared\/button-contrast\.js">/]
        ];
        for (const [file, pattern] of SCREENS) {
            it(file, () => {
                expect(fs.readFileSync(path.join(ROOT, file), 'utf8')).to.match(pattern);
            });
        }

        it('and the builders give each template its address', () => {
            const pages = fs.readFileSync(path.join(ROOT, 'src/screens/pages.ts'), 'utf8');
            expect(pages.match(/BUTTON_CONTRAST_SCRIPT: asset\('shared\/button-contrast\.js'\)/g), 'endpoint and environment').to.have.length(2);
            expect(pages).to.contain("BUTTON_CONTRAST_JS_URI: asset('shared/button-contrast.js')");
            expect(fs.readFileSync(path.join(ROOT, 'src/screens/console/console-page.ts'), 'utf8')).to.contain("BUTTON_CONTRAST_URI: 'shared/button-contrast.js'");
            expect(fs.readFileSync(path.join(ROOT, 'src/webviews/import-export/import-export-manager.ts'), 'utf8')).to.contain("BUTTON_CONTRAST_SCRIPT: this.getWebviewUri('shared/button-contrast.js')");
        });
    });

    // The button system (buttons.css): four kinds of button and the pill, decided in one place.
    describe('the button system', () => {
        const SHARED = path.resolve(__dirname, '../../../../../src/webviews/shared');
        const system = fs.readFileSync(path.join(SHARED, 'buttons.css'), 'utf8');
        const core = fs.readFileSync(path.join(SHARED, 'core.css'), 'utf8');
        /** The declarations of the rule whose selector list contains `selector`. */
        const ruleWith = (selector: string) => {
            const at = system.indexOf(selector);
            expect(at, `${selector} is named in buttons.css`).to.be.greaterThan(-1);
            const open = system.indexOf('{', at);
            return system.slice(open, system.indexOf('}', open));
        };

        it('reaches every screen: core.css imports it before anything else', () => {
            const firstRule = core.replace(/\/\*[\s\S]*?\*\//g, '').trim();
            expect(firstRule.startsWith('@import url("buttons.css");')).to.equal(true);
        });

        it('an ordinary action is a faint tile, and takes the selected tint under the pointer', () => {
            expect(ruleWith('body .btn-secondary,')).to.contain('background: var(--dbmn-tile)');
            expect(ruleWith('body .btn-secondary:hover:not(:disabled),')).to.contain('background: var(--dbmn-selected)');
        });

        it('the selected tint is the Hub menu\'s active background; hover is half of it', () => {
            expect(system).to.match(/--dbmn-selected:\s*var\(--vscode-list-activeSelectionBackground/);
            expect(system).to.match(/--dbmn-hover:\s*color-mix\(in srgb, var\(--dbmn-selected\) 50%, transparent\)/);
            expect(ruleWith('body .hub-nav-item:hover:not(:disabled):not(.is-active)')).to.contain('background: var(--dbmn-hover)');
        });

        it('hover is never the theme\'s own list or toolbar hover, which is often the page colour', () => {
            expect(system).to.match(/body \{\s*--vscode-list-hoverBackground: var\(--dbmn-hover\);\s*--vscode-toolbar-hoverBackground: var\(--dbmn-hover\);/);
        });

        it('the main action is the only solid button, in the theme\'s accent', () => {
            const main = ruleWith('body .btn-primary,\nbody .primary-btn,');
            expect(main).to.contain('background: var(--vscode-button-background)').and.to.contain('color: var(--vscode-button-foreground)');
            expect(ruleWith('body .btn-secondary,')).to.not.contain('--vscode-button-background');
        });

        it('Run API and Run Batch are icon buttons: the tile at rest, the selected tint under the pointer', () => {
            expect(ruleWith('body .catalogue-row-run-btn,\nbody button.btn-icon,')).to.contain('background: var(--dbmn-tile)');
            expect(ruleWith('body .catalogue-row-run-btn:hover,')).to.contain('background: var(--dbmn-selected)');
            const hub = fs.readFileSync(path.join(SHARED, 'hub.css'), 'utf8');
            const own = hub.slice(hub.indexOf('.catalogue-row-run-btn {'), hub.indexOf('}', hub.indexOf('.catalogue-row-run-btn {')));
            expect(own, 'their own rule keeps size only').to.not.match(/background|(?<!-)color:/);
        });

        it('Home has one main action at a time: a to-do below a visible one waits as an ordinary action', () => {
            expect(ruleWith('body .hub-home-card:not(.hidden):not(#hubHomeReopen) ~ .hub-home-card .btn-primary {')).to.contain('background: var(--dbmn-tile)');
        });

        it('a pill is a label: the theme\'s palette as its fill, the page\'s background as its text', () => {
            expect(system).to.match(/--dbmn-pill-text:\s*var\(--vscode-editor-background/);
            expect(ruleWith('body .catalogue-method-badge,\nbody .status-badge.success,')).to.contain('color: var(--dbmn-pill-text)');
            for (const [method, colour] of [['GET', 'green'], ['POST', 'blue'], ['PUT', 'orange'], ['PATCH', 'purple'], ['DELETE', 'red']]) {
                expect(system).to.contain(`body .catalogue-row.method-${method} .catalogue-method-badge { background: var(--vscode-charts-${colour}`);
            }
            const hub = fs.readFileSync(path.join(SHARED, 'hub.css'), 'utf8');
            expect(hub, 'no fixed method colours left').to.not.match(/catalogue-method-badge \{ background: #/);
        });

        it('no button variant in core.css sets its own colours any more', () => {
            expect(core).to.not.match(/\.btn-(primary|secondary|danger)\s*\{/);
            expect(core).to.not.match(/vscode-button-(secondary)?(Background|Foreground)\)\s*!important/);
        });
    });
});
