// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Every DBMN editor tab carries the paw.
 *
 * Without `iconPath` VS Code draws a generic glyph, which is what the Hub tab showed
 * until 2026-09-21. The interesting test is the last one: a webview panel added later
 * should not quietly go back to the generic icon.
 */
import '../../../setup';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { applyPanelIcon } from '../../../../services/ui/panel-icon';

const ROOT = path.resolve(__dirname, '../../../../..');

describe('editor-tab icon', () => {
    it('points the panel at the tab icon that ships with the extension', () => {
        const panel = {} as vscode.WebviewPanel;

        applyPanelIcon(panel, vscode.Uri.file('/ext'));

        expect(String((panel.iconPath as vscode.Uri).path)).to.equal('/ext/images/tab-icon.svg');
    });

    it('ships that file', () => {
        const icon = fs.readFileSync(path.join(ROOT, 'images/tab-icon.svg'), 'utf8');

        // An explicit colour: a tab icon renders as an image, so `currentColor` has
        // nothing to inherit, and the near-black original vanishes on a dark tab bar.
        expect(icon).to.match(/(fill|stroke)[:=]"?#[0-9a-f]{6}/);
        expect(icon).to.not.include('currentColor');
        expect(icon).to.not.include('rgb(39,34,38)');
    });

    it('is applied wherever a webview panel is created', () => {
        const sources = ['src/base/service-aware-base.ts',
            'src/webviews/shared/webview-base.ts',
            'src/webviews/confirmation/confirmation-manager.ts'];
        const missing = sources.filter((file) => {
            const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
            return text.includes('vscode.window.createWebviewPanel') && !text.includes('applyPanelIcon');
        });

        expect(missing).to.deep.equal([]);
    });

    it('has no other panel-creating file that was missed', () => {
        // Cheap guard against a fourth creation site appearing without an icon.
        const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true })
            .flatMap((e) => {
                const full = path.join(dir, e.name);
                if (e.isDirectory()) return e.name === 'test' ? [] : walk(full);
                return e.name.endsWith('.ts') ? [full] : [];
            });
        const creators = walk(path.join(ROOT, 'src'))
            .filter((f) => fs.readFileSync(f, 'utf8').includes('vscode.window.createWebviewPanel'))
            .filter((f) => !fs.readFileSync(f, 'utf8').includes('applyPanelIcon'))
            .map((f) => path.relative(ROOT, f));

        expect(creators).to.deep.equal([]);
    });
});
