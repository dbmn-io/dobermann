// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import type { EnvironmentConfig } from '../../../environmentManager';
import { describeEnvironmentChanges, sameEnvironment } from '../../../services/environment/environment-changes';

const env = (extra: Partial<EnvironmentConfig> = {}): Partial<EnvironmentConfig> =>
    ({ id: 'e', name: 'Staging', baseUrl: 'https://s.example', environmentType: 'development', variables: { org: 'aus' }, headers: { Accept: { value: 'application/json', enabled: true } }, ...extra });

describe('environment changes, in words', () => {
    it('names a variable\'s new value first, then headers, then the named fields', () => {
        const changes = describeEnvironmentChanges(env(), env({ variables: { org: 'nz' }, headers: { Accept: { value: 'text/csv', enabled: true } }, name: 'Staging 2', environmentType: 'production' }));
        expect(changes).to.deep.equal(['org is now nz', 'header Accept changed', 'name is now Staging 2', 'type is now production']);
    });

    it('says when a variable went, or was emptied, or options changed', () => {
        expect(describeEnvironmentChanges(env(), env({ variables: {} }))).to.deep.equal(['org removed']);
        expect(describeEnvironmentChanges(env(), env({ variables: { org: '' } }))).to.deep.equal(['org is now (empty)']);
        expect(describeEnvironmentChanges(env(), env({ variableSettings: { org: { options: ['aus'] } } }))).to.deep.equal(['variable options changed']);
    });

    it('a difference it has no words for is still a difference', () => {
        const before = env();
        const after = env({ description: undefined, targetTimezone: undefined, ...({ somethingNew: 1 } as object) });
        expect(sameEnvironment(before, after)).to.equal(false);
        expect(describeEnvironmentChanges(before, after)).to.deep.equal(['settings changed']);
        expect(describeEnvironmentChanges(before, env())).to.deep.equal([]);
        expect(sameEnvironment(before, env())).to.equal(true);
    });

    // Stored in Postgres (jsonb), an environment comes back with its keys in another order: the
    // editor's own save, echoed, read as "changed elsewhere: sign-in settings changed" (2026-11-06)
    it('the same settings with their keys in another order are the same environment', () => {
        const oauth = { provider: 'custom', clientId: 'c', clientSecret: 's', tokenUrl: 'https://t', scopes: [] as string[], usePKCE: false };
        const reordered = { usePKCE: false, scopes: [] as string[], tokenUrl: 'https://t', clientSecret: 's', clientId: 'c', provider: 'custom' };
        const before = env({ oauthConfig: oauth as EnvironmentConfig['oauthConfig'] });
        const after = { ...Object.fromEntries(Object.entries(env({ oauthConfig: reordered as EnvironmentConfig['oauthConfig'] })).reverse()) };
        expect(sameEnvironment(before, after)).to.equal(true);
        expect(describeEnvironmentChanges(before, after)).to.deep.equal([]);
        // ...but the order of a list is a change
        expect(sameEnvironment(env({ oauthConfig: { ...oauth, scopes: ['a', 'b'] } as EnvironmentConfig['oauthConfig'] }), env({ oauthConfig: { ...oauth, scopes: ['b', 'a'] } as EnvironmentConfig['oauthConfig'] }))).to.equal(false);
    });
});
