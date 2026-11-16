// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: a new environment's default headers come from the Standard System's row;
 * without one there are none. `{{org}}` in them is the environment's `org` variable (#424).
 */
import { expect } from 'chai';
import { defaultHeadersFor, defaultVariablesFor } from '../../../services/systems/system-headers';
import { parseSystemConfiguration } from '../../../services/systems/system-configuration';

const configuration = {
    defaultHeaders: { Organization: '{{org}}', Location: '{{org}}', 'Content-Type': 'application/json' }
};

describe('#415 headers are the Standard System\'s', () => {
    it('a new environment starts with the System\'s default headers, enabled, templates kept for the request', () => {
        expect(defaultHeadersFor(configuration)).to.deep.equal({
            Organization: { value: '{{org}}', enabled: true }, Location: { value: '{{org}}', enabled: true }, 'Content-Type': { value: 'application/json', enabled: true }
        });
        expect(defaultHeadersFor()).to.equal(undefined);
        expect(defaultHeadersFor({ defaultHeaders: {} })).to.equal(undefined);
    });

    it('#424 a new environment starts with the System\'s default variables: org empty and in the header, so the header reads pick org', () => {
        expect(defaultVariablesFor({ defaultVariables: { org: { showInHeader: true }, region: { value: 'eu', options: ['eu', 'us'] }, tenant: {} } })).to.deep.equal({
            variables: { org: '', region: 'eu', tenant: '' },
            variableSettings: { org: { showInHeader: true }, region: { options: ['eu', 'us'] } }
        });
        expect(defaultVariablesFor()).to.equal(undefined);
        expect(defaultVariablesFor({ defaultVariables: {} })).to.equal(undefined);
        const parsed = parseSystemConfiguration({ defaultVariables: { org: { showInHeader: 'yes' } } });
        expect(parsed.ok, 'a wrong type fails the row like any other key').to.equal(false);
    });

    it('a row that still names organisation headers, claims or a sort order loads: those keys are dropped', () => {
        const parsed = parseSystemConfiguration({
            ...configuration,
            claims: { name: 'name', orgs: 'userOrgs', locations: 'userLocations' },
            orgHeaders: { organization: ['Organization'] },
            orgSort: { l1Pattern: '^A$' }
        });
        expect(parsed.ok).to.equal(true);
        expect(parsed.ok && parsed.config).to.deep.equal({ ...configuration, claims: { name: 'name' } });
    });
});
