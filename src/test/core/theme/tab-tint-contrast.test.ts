// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { contrast, mix } from '../../../services/theme/colour';
import { OMARCHY_THEMES } from '../../../services/theme/omarchy-themes.generated';
import { renderVscodeTheme, tokensFromVscodeTheme } from '../../../services/theme/omarchy-vscode-theme';
import { STANDARD_DARK_TOKENS } from '../../../services/theme/standard-dark';
import { STANDARD_LIGHT_TOKENS } from '../../../services/theme/standard-light';

/**
 * #438: a Console's tab is tinted in its status colour (hub.css .hub-tab-progress), and the open
 * tab and the Console's heading share one tint (console.css .report-title). James, 2026-11-12:
 * the text on them must read. Everforest's yellow was the worst: the inactive tabs' muted text on
 * its tint was close to 1:1, and the footer panel's count and time left (also muted) vanished.
 * The amounts here are hub.css's, console.css's and core.css's.
 */
const INACTIVE_TINT = 0.22;
const OPEN_TAB = 0.12;           // the open tab all the way across, and the heading
const OPEN_TAB_RUNNING = 0.10;   // over that while a run goes, as far as it has got
const FOOTER_PANEL = 0.22;       // core.css: the footer's progress panel
const STATUS_TOKENS = ['charts-blue', 'charts-yellow', 'charts-green', 'charts-red', 'descriptionForeground'];

const themes: Array<[string, Readonly<Record<string, string>>]> = [
    ['Dark', STANDARD_DARK_TOKENS],
    ['Light', STANDARD_LIGHT_TOKENS],
    ...OMARCHY_THEMES.map(t => [t.slug, tokensFromVscodeTheme(renderVscodeTheme(t.palette)).tokens] as [string, Record<string, string>])
];
const hex = (value: string | undefined) => (value || '').slice(0, 7);

describe('Console tab tints read on every theme (#438)', () => {
    for (const [name, tokens] of themes) {
        const token = (n: string, fallback?: string) => hex(tokens[`--vscode-${n}`]) || (fallback ? hex(tokens[`--vscode-${fallback}`]) : '');
        it(name, () => {
            const editor = token('editor-background');
            const inactive = token('tab-inactiveBackground', 'editorGroupHeader-tabsBackground') || editor;
            const tabText = token('tab-activeForeground', 'editor-foreground');
            const headingText = token('foreground');
            expect(editor && tabText && headingText, 'the tokens are there').to.be.ok;
            for (const status of STATUS_TOKENS) {
                const colour = token(status);
                if (!colour) continue;
                const check = (what: string, text: string, back: string) =>
                    expect(contrast(text, back), `${name}, ${status}: ${what}`).to.be.at.least(4.5);
                check('a tab\'s text on its tint', tabText, mix(inactive, colour, INACTIVE_TINT));
                check('the open tab\'s text', tabText, mix(editor, colour, OPEN_TAB));
                check('the heading on the open tab\'s tint', headingText, mix(editor, colour, OPEN_TAB));
                check('the open tab\'s text where a running batch has got', tabText, mix(mix(editor, colour, OPEN_TAB), colour, OPEN_TAB_RUNNING));
                check('the footer panel\'s text on its tint', headingText, mix(token('input-background') || editor, colour, FOOTER_PANEL));
            }
        });
    }
});
