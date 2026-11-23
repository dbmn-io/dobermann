// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * One look for saved searches in every screen (James, 2026-11-23: "Just give me consistent saved across the
 * system, please"): every <dbmn-saved-searches> in a page's markup sits inside its search box (a child of the box's
 * wrapper: .search-input-wrapper, or the Hub's .catalogue-search), never beside it; and a table with its own box
 * puts its star in that box's wrapper too. Read from the source, so a new screen can't add one beside its box.
 *   npm run test:core
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const BOX = /\b(search-input-wrapper|catalogue-search)\b/;

function files(dir: string, out: string[] = []): string[] {
    for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) files(full, out);
        else if (/\.(html|ts)$/.test(name) && !name.endsWith('.d.ts')) out.push(full);
    }
    return out;
}

/** The class of each element open where `at` is, innermost last (div and span tags only: what boxes are made of). */
function openAt(text: string, at: number): string[] {
    const stack: string[] = [];
    const tag = /<(\/?)(div|span)\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = tag.exec(text)) && m.index < at) {
        if (m[1]) stack.pop();
        else if (!/\/\s*$/.test(m[3])) stack.push((/class="([^"]*)"/.exec(m[3]) || [])[1] || '');
    }
    return stack;
}

describe('Saved searches: inside the search box, in every screen', () => {
    const sources = [...files(path.join(ROOT, 'src/webviews')), ...files(path.join(ROOT, 'src/screens'))];

    it('every <dbmn-saved-searches> in markup is a child of its search box\'s wrapper', () => {
        const found: string[] = [];
        for (const file of sources) {
            const text = fs.readFileSync(file, 'utf8');
            const tag = /<dbmn-saved-searches\b/g;
            let m: RegExpExecArray | null;
            while ((m = tag.exec(text))) {
                // (a code sample on the design system page, escaped as &lt;, is not markup)
                if (text.slice(Math.max(0, m.index - 4), m.index).endsWith('&lt;')) continue;
                const where = path.relative(ROOT, file);
                found.push(where);
                const parent = openAt(text, m.index).pop() || '';
                assert.ok(BOX.test(parent), `${where}: a <dbmn-saved-searches> sits in "${parent}", not inside its search box`);
            }
        }
        // (the screens that have one in their markup: if this list shrinks, a screen lost its star)
        assert.ok(found.length >= 5, `found only ${found.length}: ${found.join(', ')}`);
    });

    it('a table with its own box puts its star in that box\'s wrapper', () => {
        const table = fs.readFileSync(path.join(ROOT, 'src/webviews/shared/dbmn-table.js'), 'utf8');
        assert.match(table, /this\._saved = document\.createElement\('dbmn-saved-searches'\)[\s\S]{0,200}wrapper\.append\(this\._saved\)/);
    });
});
