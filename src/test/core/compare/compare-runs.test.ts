// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #298: the Compare dialog's results carry their environment's header values (org 880,
 * org 840), so one environment run for two companies reads as two places.
 */
import { expect } from 'chai';
import { comparableRuns, headerValuesOf, valuesFromTemplate } from '../../../services/compare/compare-runs';

const environment = {
    variables: { org: '999', token: 'secret' },
    variableSettings: { org: { showInHeader: true, options: ['880', '840'], labels: { '840': 'Brisbane' } }, token: {} },
};

describe('Compare runs: header values', () => {
    it('reads the header variables as the run kept them, with the option label, and nothing else', () => {
        expect(headerValuesOf({ environmentVariables: { org: '840', token: 'x' } }, environment))
            .to.deep.equal([{ name: 'org', value: '840', label: 'Brisbane' }]);
    });

    it('falls back to the run organization (older single runs), and shows nothing when none was kept', () => {
        expect(headerValuesOf({ organization: '880' }, environment)).to.deep.equal([{ name: 'org', value: '880' }]);
        expect(headerValuesOf({ organization: '880' }, undefined)).to.deep.equal([{ name: 'org', value: '880' }]);
        expect(headerValuesOf({}, environment)).to.deep.equal([]);
        // An environment from before header variables: org is a plain variable, the run's org still shows
        expect(headerValuesOf({ organization: '840' }, { variables: { org: '880' } })).to.deep.equal([{ name: 'org', value: '840' }]);
    });

    it('lists finished runs newest first, each with its header values, looking each environment up once', async () => {
        let lookups = 0;
        let asked: unknown;
        const runs = await comparableRuns(
            {
                getExecutionsByEndpoint: async (_id: string, options?: unknown) => { asked = options; return [
                    { id: 'a', executionType: 'individual', status: 'completed', environment: 'DEV', environmentId: 'e1', organization: '880', createdAt: new Date('2026-11-01') },
                    { id: 'b', executionType: 'batch', status: 'completed', environment: 'DEV', environmentId: 'e1', environmentVariables: { org: '840' }, createdAt: new Date('2026-11-02') },
                    { id: 'c', executionType: 'batch', status: 'running', environment: 'DEV', environmentId: 'e1', createdAt: new Date('2026-11-03') },
                ] as never; },
            },
            { getEnvironment: async () => { lookups++; return environment; } },
            'ep1'
        );
        expect(runs.map(r => [r.id, r.header?.map(h => h.value)])).to.deep.equal([['b', ['840']], ['a', ['880']]]);
        expect(lookups).to.equal(1);
        // Runs only: a batch's requests are never read (a big batch has tens of thousands)
        expect(asked).to.deep.equal({ runsOnly: true });
    });

    it('reads a value off what was sent, as a person would from the first request', () => {
        expect(valuesFromTemplate('{{ENV:org}}', '880')).to.deep.equal({ org: '880' });
        expect(valuesFromTemplate('Bearer {{token}}', 'Bearer abc')).to.deep.equal({ token: 'abc' });
        expect(valuesFromTemplate('/orgs/{{ENV:org}}/items/{{A8:date}}', '/orgs/840/items/2026-11-09')).to.deep.equal({ org: '840' });
        expect(valuesFromTemplate('{{org}}-x', '880-y')).to.deep.equal({});        // does not fit: nothing
        expect(valuesFromTemplate('{{ENV:org}}', '{{ENV:org}}')).to.deep.equal({}); // never filled: nothing
        expect(valuesFromTemplate('plain', 'plain')).to.deep.equal({});
    });

    it('works out an older single run\'s header values from its headers, query parameters or path', () => {
        const env = { ...environment, variableSettings: { ...environment.variableSettings, site: { showInHeader: true } }, headers: { Organization: { value: '{{org}}' } } };
        const endpoint = { path: '/sites/{{ENV:site}}/stock', queryParams: {} };
        // An environment header, matched whatever its case
        expect(headerValuesOf({ requestHeaders: { organization: '840' }, endpointPath: '/sites/S1/stock' }, env, endpoint))
            .to.deep.equal([{ name: 'org', value: '840', label: 'Brisbane' }, { name: 'site', value: 'S1' }]);
        // What the run kept wins over what is read off the request
        expect(headerValuesOf({ organization: '880', requestHeaders: { Organization: '840' } }, env, endpoint).map(h => h.value)).to.deep.equal(['880']);
        // An endpoint query parameter
        expect(headerValuesOf({ requestQueryParams: { company: '880' } }, env, { queryParams: { company: { value: '{{ENV:org}}' } } }).map(h => h.value))
            .to.deep.equal(['880']);
    });
});
