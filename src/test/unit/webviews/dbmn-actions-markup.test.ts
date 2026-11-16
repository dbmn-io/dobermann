// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #372: the screens the web app shows run under a Content Security Policy that refuses inline
 * script and inline event handlers. Their markup names actions instead (src/webviews/shared/
 * dbmn-actions.js), and each screen registers what its markup may call.
 *
 * Read from the source, so a forgotten registration or a new inline handler fails here, before
 * any browser runs: a missed name only logs at click time, and only on the screen clicked.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '..', '..', '..', '..', 'src');

/** What the web app and the desktop app show: the Hub and the screens it opens in tabs. */
const WEB_SCREENS = [
    'webviews/hub', 'webviews/endpoint', 'webviews/environment', 'webviews/console', 'webviews/run-batch', 'webviews/compare',
    'webviews/shared', 'screens'
];

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return files(full);
        return /\.(html|js|ts)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
    });
}

const sources = WEB_SCREENS.flatMap(dir => files(path.join(SRC, dir))).map(file => ({ file: path.relative(SRC, file), text: fs.readFileSync(file, 'utf8') }));

describe('DbmnActions markup (Issue #372)', () => {
    it('every action named in markup is registered by some screen', () => {
        const used = new Map<string, string>();
        for (const { file, text } of sources) {
            for (const match of text.matchAll(/data-(?:click|change|input|keydown|dragover|dragleave|drop)="([^"$]+)"/g)) used.set(match[1], file);
            // Set from script: setAttribute('data-click', 'name')
            for (const match of text.matchAll(/setAttribute\('data-(?:click|change|input)', '([^']+)'\)/g)) used.set(match[1], file);
        }
        const registered = new Set<string>();
        for (const { text } of sources) {
            for (const block of text.matchAll(/DbmnActions\??\.register\(\{([\s\S]*?)\n\s*\}\);/g)) {
                for (const key of block[1].matchAll(/^\s*'?([A-Za-z][\w:]*)'?\s*:/gm)) registered.add(key[1]);
            }
        }
        const missing = [...used].filter(([name]) => !registered.has(name)).map(([name, file]) => `${name} (${file})`);
        expect(used.size, 'actions found in markup').to.be.greaterThan(50);
        expect(missing).to.deep.equal([]);
    });

    it('no inline event handler is left in what the web app shows', () => {
        const inline = sources
            .filter(({ file }) => !file.endsWith('dbmn-actions.js'))
            .flatMap(({ file, text }) => [...text.matchAll(/\son[a-z]{4,12}\s*=\s*["\\]/g)].map(match => `${file}: ${text.slice(match.index ?? 0, (match.index ?? 0) + 40).trim()}`));
        expect(inline).to.deep.equal([]);
    });

    it('no inline <script> in the screens\' templates (VS Code-only places are named)', () => {
        // The Hub's initial state (VS Code only: the web app passes none) and webview-base's
        // inlining (VS Code's embedded tabs) are VS Code's, which runs no CSP.
        const allowed = ['screens/pages.ts', 'webviews/shared/webview-base.ts'];
        const inline = sources
            .filter(({ file }) => !allowed.includes(file))
            .filter(({ text }) => text.split('\n').some(line => /<script>/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)))
            .map(({ file }) => file);
        expect(inline).to.deep.equal([]);
    });

    it('the web app\'s own pages have no inline script or handler either', () => {
        const web = path.resolve(SRC, '..', 'web');
        const pages = fs.readdirSync(web).filter(name => name.endsWith('.html'));
        expect(pages, 'the pages').to.include.members(['signin.html', 'oauth-callback.html']);
        const inline = pages.flatMap(name => {
            const text = fs.readFileSync(path.join(web, name), 'utf8');
            return [...(/<script>/.test(text) ? ['<script>'] : []), ...[...text.matchAll(/\son[a-z]{4,12}\s*=\s*"/g)].map(m => m[0].trim())].map(found => `${name}: ${found}`);
        });
        expect(inline).to.deep.equal([]);
    });
});
