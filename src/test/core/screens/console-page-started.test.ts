// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's Started stat. The host once handed the page a locale string ("1/11/2026,
 * 21:50:38"), which the page parsed as 11 January; it is an ISO instant now, and the page
 * shows the time alone for today and a short date otherwise.
 */
import { expect } from 'chai';
import { buildConsolePage } from '../../../screens/console/console-page';

function started(executedAt: string): string {
    const html = buildConsolePage('<span id="info-started">{{EXECUTED_AT}}</span>', () => '', { type: 'api', responseFiles: [], executionSummary: { executedAt, status: 'completed' } } as never);
    return /<span id="info-started">([^<]*)<\/span>/.exec(html)![1];
}

describe('Console: the Started stat', () => {
    it('shows the day and month of an earlier run the right way round', () => {
        const nov1 = new Date(2026, 10, 1, 21, 50);   // 1 November, local time
        const shown = started(nov1.toISOString());
        if (nov1.toDateString() === new Date().toDateString()) {
            expect(shown).to.match(/^21:50:00$/);
        } else {
            expect(shown).to.match(/^Nov 1 21:50$/).and.not.contain('Jan');
        }
    });

    it('shows the time alone for a run today', () => {
        const today = new Date(); today.setHours(9, 5, 7, 0);
        expect(started(today.toISOString())).to.equal('09:05:07');
    });

    it('would have read a locale string the wrong way round, which is why the host sends ISO', () => {
        const parsed = new Date('1/11/2026, 21:50:38');
        expect(parsed.getMonth()).to.equal(0);   // January: the trap
    });
});
