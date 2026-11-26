// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { headerValuesOf } from '../../../services/compare/compare-runs';
import { runHeaderSearch, withRunHeaderSearch } from '../../../services/compare/run-header-values';

/**
 * The Hub's History finds a run by its header values as Query does (platform #477: "the search ONLY works in
 * Query builder… if we can get @org=xxx in Hub history").
 */
describe('A run\'s header values for History\'s search', () => {
    const environment = {
        id: 'env-1', variables: { org: '840-SIT', version: '2' },
        variableSettings: { org: { showInHeader: true, labels: { '840-SIT': 'Brisbane' } }, version: { showInHeader: true } },
        headers: { 'X-Org': '{{ENV:org}}', 'X-Version': 'v{{ENV:version}}' }
    } as never;
    const endpoint = { id: 'ep-1', path: '/stock', headers: { Accept: 'application/json' } };

    it('a run that kept its values: each by its name, the option\'s label with it', () => {
        const run = { environmentId: 'env-1', endpointId: 'ep-1', environmentVariables: { org: '840-SIT', version: '2' } };
        const names = headerValuesOf(run, environment, endpoint).map(h => h.name);
        const found = runHeaderSearch(run, environment, endpoint);
        expect(Object.keys(found.headerValues)).to.deep.equal(names);
        expect(names).to.deep.equal(['org', 'version']);
        expect(found.headerValues).to.deep.equal({ org: '840-SIT · Brisbane', version: '2' });
    });

    it('a run that kept none (an older run, a batch): read from the request it sent, as Query reads it', () => {
        const run = { environmentId: 'env-1', endpointId: 'ep-1', requestHeaders: { 'X-Org': '840-SIT', 'X-Version': 'v2', Authorization: 'Bearer secret' } };
        const query = headerValuesOf(run, environment, endpoint);
        const found = runHeaderSearch(run, environment, endpoint);
        // (whatever Query's Add a view shows for the run, History has)
        expect(Object.keys(found.headerValues)).to.deep.equal(query.map(h => h.name));
        for (const h of query) expect(found.headerValues[h.name]).to.contain(h.value);
        expect(found.headerValues).to.deep.equal({ org: '840-SIT · Brisbane', version: '2' });
    });

    it('@headers: everything the run was sent with, as text; a secret header is never in it', () => {
        const run = { environmentId: 'env-1', endpointId: 'ep-1', requestHeaders: { 'X-Org': '840-SIT', Authorization: 'Bearer secret', Cookie: 'session=1' } };
        const found = runHeaderSearch(run, environment, endpoint);
        expect(found.headersText).to.contain('X-Org: 840-SIT');
        expect(found.headersText).not.to.contain('secret');
        expect(found.headersText).not.to.contain('session=1');
    });

    it('an old run with only its organization answers to org; with nothing known, nothing is said', () => {
        expect(runHeaderSearch({ organization: 'vic' }, undefined, undefined).headerValues).to.deep.equal({ org: 'vic' });
        expect(runHeaderSearch({}, undefined, undefined)).to.deep.equal({ headerValues: {}, headersText: '' });
    });

    it('a list of runs: each with its own, by its environment and endpoint; the runs given are not written', () => {
        const runs = [{ id: 'a', environmentId: 'env-1', endpointId: 'ep-1', environmentVariables: { org: '840-SIT' } }, { id: 'b', organization: 'vic' }];
        const out = withRunHeaderSearch(runs, [environment], [endpoint]);
        expect(out.map(r => r.headerValues.org)).to.have.length(2);
        expect(out[1].headerValues).to.deep.equal({ org: 'vic' });
        expect(runs[0]).not.to.have.property('headerValues');
    });
});
