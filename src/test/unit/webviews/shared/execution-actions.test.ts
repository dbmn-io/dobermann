// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #314: the ONE rule set for which actions an execution offers — read by the
 * Console footer (batch-actions.js) and the History list's right-click menu.
 */
import { expect } from 'chai';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { visibleActions, LABELS } = require('../../../../webviews/shared/execution-actions');

describe('ExecutionActions.visibleActions (Issue #314)', () => {
    const cases: Array<[string, boolean, string[]]> = [
        ['running', true, ['pause', 'cancel']],   // #335: Pause lets requests finish; Cancel aborts them
        ['executing', true, ['pause', 'cancel']],
        ['running', false, ['cancel']],
        ['pending', true, ['cancel', 'delete']],
        ['queued', true, ['cancel', 'delete']],
        ['preparing', true, ['cancel', 'delete']],
        ['paused', true, ['resume', 'cancel', 'delete']],    // #335: Cancel ends it (out of the activity bar), results kept
        ['stopped', true, ['resume', 'cancel', 'delete']],
        ['cancelled', true, ['resume', 'delete']],   // #335: resumes from the next row; Reprocess is for finished batches
        ['cancelled', false, ['delete', 'rerun']],
        ['completed', true, ['delete', 'reprocess']],
        ['error', true, ['delete', 'reprocess']],
        ['completed', false, ['delete', 'rerun']],
        ['', true, ['delete', 'reprocess']],
        ['RUNNING', true, ['pause', 'cancel']],
        ['split', true, []]
    ];
    for (const [status, isBatch, expected] of cases) {
        it(`${isBatch ? 'batch' : 'individual'} ${status || '(none)'} → ${expected.join(', ') || 'nothing'}`, () => {
            expect(visibleActions(status, isBatch)).to.deep.equal(expected);
        });
    }

    it('every action has a label and an icon for the menu', () => {
        const all = new Set(cases.flatMap(([, , a]) => a));
        for (const id of all) {
            expect(LABELS[id], id).to.include.keys('label', 'icon');
        }
    });
});
