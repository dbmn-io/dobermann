// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { linkDifferences, describeDifferences } from '../../../../services/chain/link-differences';

// GitHub Issue #247: traceability — show where a linked run differs. A warning, not a block.
describe('Chain — link differences (#247)', () => {
    it('environment, organization and shared headers with different values', () => {
        const diffs = linkDifferences(
            { environment: 'DEV', organization: 'ACME', headers: { Location: 'DC-01', 'Content-Type': 'application/json', Facility: 'F1' } },
            { environment: 'UAT', organization: 'ACME', headers: { location: 'DC-02', 'Content-Type': 'application/json' } }
        );
        expect(diffs).to.deep.equal([
            { field: 'Environment', from: 'DEV', to: 'UAT' },
            { field: 'Location', from: 'DC-01', to: 'DC-02' }
        ]);
        expect(describeDifferences(diffs)).to.equal('Environment DEV → UAT · Location DC-01 → DC-02');
    });

    it('never compares secrets or per-request headers', () => {
        expect(linkDifferences(
            { headers: { Authorization: 'Bearer a', 'X-Request-Id': '1', 'Content-Length': '10' } },
            { headers: { Authorization: 'Bearer b', 'X-Request-Id': '2', 'Content-Length': '99' } }
        )).to.deep.equal([]);
    });

    it('nothing known on one side is not a difference', () => {
        expect(linkDifferences({ environment: 'DEV' }, {})).to.deep.equal([]);
    });
});
