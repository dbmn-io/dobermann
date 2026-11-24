// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { linkDifferences, describeDifferences, headerDifferences, chainHeaderWarnings } from '../../../../services/chain/link-differences';

// GitHub Issue #247: traceability — show where a linked run differs. A warning, not a block.
describe('Chain — link differences (#247)', () => {
    it('environment and shared request headers with different values', () => {
        const diffs = linkDifferences(
            { environment: 'DEV', headers: { Location: 'DC-01', 'Content-Type': 'application/json', Facility: 'F1' } },
            { environment: 'UAT', headers: { location: 'DC-02', 'Content-Type': 'application/json' } }
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

// James, 2026-11-24: "it should just be whatever headings exist on the environment that we've run
// against": runs differ by their header values, each by its own name, never a fixed Organization.
describe('Chain — header values by name', () => {
    it('the same headers: no difference, no warning', () => {
        expect(headerDifferences({ org: 'vic', version: 'v2' }, { version: 'v2', org: 'vic' })).to.deep.equal([]);
        expect(linkDifferences({ headerValues: { org: 'vic' } }, { headerValues: { org: 'vic' } })).to.deep.equal([]);
    });

    it('one differs: said by its own name', () => {
        const diffs = headerDifferences({ org: 'vic', version: 'v2' }, { org: 'nz', version: 'v2' });
        expect(diffs).to.deep.equal([{ field: 'org', from: 'vic', to: 'nz' }]);
        expect(chainHeaderWarnings(diffs)).to.deep.equal(['Rows came from org vic. The active environment sends org nz.']);
        expect(linkDifferences({ headerValues: { org: 'vic' } }, { headerValues: { org: 'nz' } })).to.deep.equal([{ field: 'org', from: 'vic', to: 'nz' }]);
    });

    it('one on one side only: a difference, said in words', () => {
        const diffs = headerDifferences({ org: 'vic', version: 'v2' }, { org: 'vic', region: 'east' });
        expect(diffs).to.deep.equal([{ field: 'version', from: 'v2', to: '' }, { field: 'region', from: '', to: 'east' }]);
        expect(chainHeaderWarnings(diffs)).to.deep.equal([
            'Rows came from version v2. The active environment sends no version.',
            'Rows came from a run without region. The active environment sends region east.'
        ]);
        expect(describeDifferences(linkDifferences({ headerValues: { org: 'vic', version: 'v2' } }, { headerValues: { org: 'vic' } })))
            .to.equal('version v2 → not sent');
    });

    it('a name in another case is the same header', () => {
        expect(headerDifferences({ Org: 'vic' }, { org: 'vic' })).to.deep.equal([]);
    });

    it('a run that kept no header values is not compared', () => {
        expect(headerDifferences(undefined, { org: 'nz' })).to.deep.equal([]);
        expect(headerDifferences({}, { org: 'nz' })).to.deep.equal([]);
        expect(linkDifferences({ environment: 'DEV' }, { headerValues: { org: 'nz' } })).to.deep.equal([]);
    });

    it('never a fixed Organization field', () => {
        const diffs = linkDifferences({ headerValues: { org: 'vic' } }, { headerValues: { org: 'nz' } });
        expect(diffs.map(d => d.field)).to.not.include('Organization');
    });
});
