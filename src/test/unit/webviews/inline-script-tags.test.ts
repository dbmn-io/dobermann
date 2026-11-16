// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #372: VS Code's embedded tabs get each screen's scripts baked in; a script's own tag attributes
 * (the values its builder filled in) must survive, or the Console and Run Batch lose them in VS Code.
 */
import { expect } from 'chai';
import { inlineScriptTags } from '../../../webviews/shared/inline-script-tags';

const files: Record<string, { name: string; js: string }> = {
    'res://console-page.js': { name: 'console-page.js', js: 'run();' },
    'res://plain.js': { name: 'plain.js', js: 'plain();' }
};
const source = (src: string) => files[src];

describe('inlineScriptTags (Issue #372)', () => {
    it('keeps the tag\'s data attributes, before and after src', () => {
        const html = '<script data-a="1" src="res://console-page.js" data-execution-id="e-1" data-report-type="batch"></script>';
        const out = inlineScriptTags(html, source);
        expect(out).to.match(/^<script data-a="1" data-execution-id="e-1" data-report-type="batch" data-embedded-from="console-page.js">run\(\);/);
        expect(out).to.not.contain('src=');
    });

    it('a tag with only src becomes a plain inline script', () => {
        expect(inlineScriptTags('<script src="res://plain.js"></script>', source)).to.match(/^<script data-embedded-from="plain.js">plain\(\);/);
    });

    it('leaves a script it has no file for (a CDN) alone', () => {
        const cdn = '<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>';
        expect(inlineScriptTags(cdn, source)).to.equal(cdn);
    });
});
