// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issues #318 / #326: modules declared as core (scripts/core-modules.json) must load without
 * `vscode`, directly or through anything they import. The list only grows; removing an entry
 * needs a reason in the commit.
 *
 * Type-only `import * as vscode` lines are erased by tsc and do not count here; the lint rule
 * in #326 catches those.
 */
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { resetVscodeLoadAttempts, vscodeLoadAttempts } from './helpers/no-vscode-guard';

// Issue #326: one list, shared with eslint.config.core.js
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const CORE_MODULES: readonly string[] = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'scripts', 'core-modules.json'), 'utf8')
).modules;

const outRoot = path.resolve(__dirname, '..', '..');

describe('core module graph loads no vscode', () => {
    beforeEach(() => resetVscodeLoadAttempts());

    for (const modulePath of CORE_MODULES) {
        it(modulePath, () => {
            let loadError: unknown;
            try {
                require(path.join(outRoot, modulePath));
            } catch (error) {
                loadError = error;
            }
            const chains = vscodeLoadAttempts().map(attempt => [...attempt.chain, 'vscode'].join(' → '));
            expect(chains, 'vscode load attempts').to.deep.equal([]);
            expect(loadError).to.equal(undefined);
        });
    }
});
