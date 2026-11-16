// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { PathGeneratorHelper, batchMemberFileName } from '../../../services/transaction-preparation/helpers/path-generator.helper';

/**
 * Fetch all pages lost a page (2026-10-04, Lesson 4: Console 300 rows, Excel 295).
 * The first new page was named by PathGeneratorHelper (1-based: index 1 → transaction-002),
 * the rest by a hand-built `transaction-${index}` (0-based: index 2 → transaction-002).
 * Two pages wrote one file; the History database pointed both members at it, so a reopened
 * run (and every export, which reads from disk) had one page twice and the other not at all.
 * Member file names now come from one rule.
 */
describe('batch member file names — one rule (Fetch all pages lost a page)', () => {
    it('batchMemberFileName is the rule PathGeneratorHelper uses, and never repeats', () => {
        const helper = new PathGeneratorHelper();
        const names = Array.from({ length: 200 }, (_, i) => batchMemberFileName(i));
        names.forEach((name, i) => {
            expect(name).to.equal(helper.generateFileName({ executionType: 'batch_member', transactionIndex: i } as never));
        });
        expect(new Set(names).size).to.equal(200);
        expect(batchMemberFileName(1)).to.equal('transaction-002.json');
    });

    it('the Console does not build member file names by hand', () => {
        const source = fs.readFileSync(path.resolve(__dirname, '../../../../src/webviews/console/console-webview-manager.ts'), 'utf8');
        expect(source, 'use batchMemberFileName()').to.not.match(/`transaction-\$\{/);
    });
});
