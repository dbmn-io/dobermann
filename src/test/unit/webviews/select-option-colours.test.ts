// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { contrast } from '../../../services/theme/colour';
import { STANDARD_DARK_TOKENS } from '../../../services/theme/standard-dark';
import { STANDARD_LIGHT_TOKENS } from '../../../services/theme/standard-light';
import { OMARCHY_THEMES } from '../../../services/theme/omarchy-themes.generated';
import { renderVscodeTheme, tokensFromVscodeTheme } from '../../../services/theme/omarchy-vscode-theme';

/**
 * An open drop-down's rows are readable (James, 2026-11-24: the Environment editor's Environment
 * Type list opened as blank rows in the web app, though a row could still be picked). A browser
 * draws a native <select>'s open list from its options' own colours, and nothing gave them any: the
 * select's colours reached the closed box only. VS Code's webviews draw the list themselves.
 *
 * The rule is once, in core.css, which every screen loads; its colours are exactly the select's own
 * (agreed with the design system: the open list never differs from the closed box), and each theme
 * the app ships (dark, light, every Omarchy one) keeps them readable.
 */
const ROOT = path.resolve(__dirname, '../../../..');
const SHARED = path.join(ROOT, 'src/webviews/shared');

/** The declarations of the rule whose selectors are exactly these, in a stylesheet. */
function ruleFor(css: string, selectors: string[]): Record<string, string> | undefined {
    const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
        const listed = m[1].split(',').map(s => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
        if (selectors.every(s => listed.includes(s))) {
            return Object.fromEntries(m[2].split(';').map(d => d.split(':')).filter(p => p.length >= 2).map(([k, ...v]) => [k.trim(), v.join(':').trim()]));
        }
    }
    return undefined;
}

/** A token's value, through its fallback when the theme lacks the first name. */
function resolve(value: string, tokens: Readonly<Record<string, string>>): string | undefined {
    const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
    if (!m) return value;
    return tokens[m[1]] ?? (m[2] ? resolve(m[2].trim(), tokens) : undefined);
}

const THEMES: Array<[string, Readonly<Record<string, string>>]> = [
    ['standard dark', STANDARD_DARK_TOKENS],
    ['standard light', STANDARD_LIGHT_TOKENS],
    ...OMARCHY_THEMES.map(t => [`Omarchy ${t.slug}`, tokensFromVscodeTheme(renderVscodeTheme(t.palette)).tokens] as [string, Readonly<Record<string, string>>])
];

describe('Drop-downs: an open list\'s rows are readable in every theme', () => {
    const css = fs.readFileSync(path.join(SHARED, 'core.css'), 'utf8');

    it('core.css gives every select\'s options and option groups exactly the select\'s own colours', () => {
        const rule = ruleFor(css, ['select option', 'select optgroup']);
        expect(rule, 'a rule for select option, select optgroup').to.not.equal(undefined);
        const select = ruleFor(css, ['input', 'select', 'textarea']);
        expect(select, 'the select\'s own rule').to.not.equal(undefined);
        expect(rule!['background-color']).to.equal(select!['background-color']);
        expect(rule!.color).to.equal(select!.color);
    });

    for (const [name, tokens] of THEMES) {
        it(`${name}: the rows' text stands out from their background`, () => {
            const rule = ruleFor(css, ['select option', 'select optgroup']);
            expect(rule, 'the rule').to.not.equal(undefined);
            const background = resolve(rule!['background-color'], tokens);
            const text = resolve(rule!.color, tokens);
            expect(background, 'a background').to.be.a('string');
            expect(text, 'a text colour').to.be.a('string');
            expect(contrast(text!, background!), `${text} on ${background}`).to.be.at.least(4.5);
        });
    }

    it('every screen with a drop-down loads core.css', () => {
        const pages = ['src/webviews/hub/hub.html', 'src/screens/run-batch/run-batch-page.ts', 'src/screens/query/query-page.ts',
            'src/screens/logs/logs-page.ts', 'src/screens/lookup/lookup-page.ts'];
        for (const page of pages) {
            const text = fs.readFileSync(path.join(ROOT, page), 'utf8');
            expect(/core\.css|CORE_CSS_URI|'core'/.test(text), page).to.equal(true);
        }
        // The rest take {{SHARED_STYLES}}, whose list starts with core (pages.ts SHARED_CSS)
        for (const page of ['src/webviews/console/console.html', 'src/webviews/environment/environment.html', 'src/webviews/endpoint/endpoint.html']) {
            expect(fs.readFileSync(path.join(ROOT, page), 'utf8'), page).to.include('{{SHARED_STYLES}}');
        }
        expect(fs.readFileSync(path.join(ROOT, 'src/screens/pages.ts'), 'utf8')).to.match(/SHARED_CSS = \[[^\]]*'core'/);
    });
});
