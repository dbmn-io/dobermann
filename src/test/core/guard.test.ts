// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #318: proves the `test:core` require guard fires, so a green lane means something.
 */
import { expect } from 'chai';
import { resetVscodeLoadAttempts, vscodeLoadAttempts } from './helpers/no-vscode-guard';

describe('test:core vscode require guard', () => {
    after(() => resetVscodeLoadAttempts());

    it('refuses to load vscode and names the importing module', () => {
        expect(() => require('vscode')).to.throw(/core must not load 'vscode': .*test\/core\/guard\.test\.js → vscode/);
    });

    it('records the attempt even when the caller swallows the error', () => {
        try {
            require('vscode');
        } catch {
            // Modules on the batch path do exactly this (#320); the guard must still see it.
        }
        const last = vscodeLoadAttempts()[vscodeLoadAttempts().length - 1];
        expect(last.chain[last.chain.length - 1]).to.equal('test/core/guard.test.js');
    });
});
