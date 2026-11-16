// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: the shape of a Standard System's configuration (version 1), and what the app does with
 * a row whose configuration doesn't fit.
 */
import { expect } from 'chai';
import { parseSystemConfiguration, systemConfiguration } from '../../../services/systems/system-configuration';
import { globalSystemFromRow } from '../../../services/systems/global-systems.service';
import { systemClientAuth } from '../../../services/oauth/client-auth';

const full = {
    match: '^(?<instance>[a-z0-9-]+)\\.samplewms\\.test$',
    oauth: {
        authorizeUrl: 'https://{{instance}}-auth.samplewms.test/oauth/authorize',
        tokenUrl: 'https://{{instance}}-auth.samplewms.test/oauth/token',
        scopes: ['openid', 'profile', 'email'], pkce: false, flow: 'authorization_code',
        requiredPaths: { authorize: '/oauth/authorize', token: '/oauth/token' },
        tokenRequest: { clientAuth: 'basic', headers: { Accept: '*/*' } }
    },
    claims: { name: 'name', email: 'email', username: 'preferred_username' },
    defaultHeaders: { Organization: '{{org}}', 'Content-Type': 'application/json' }
};

describe('#415 a Standard System\'s configuration', () => {
    it('accepts the whole version 1 shape, and a bare match alone', () => {
        const parsed = parseSystemConfiguration(full);
        expect(parsed.ok && parsed.config).to.deep.equal(full);
        expect(parseSystemConfiguration({ match: '\\.x$' })).to.deep.equal({ ok: true, config: { match: '\\.x$' } });
        expect(parseSystemConfiguration({})).to.deep.equal({ ok: true, config: {} });
    });

    it('drops keys it does not know (a row written for a newer app), and keeps responseRules unread', () => {
        const parsed = parseSystemConfiguration({ ...full, laterIdea: true, responseRules: [{ path: 'status', is: 'ERROR' }] });
        expect(parsed.ok && parsed.config).to.not.have.property('laterIdea');
        expect(parsed.ok && parsed.config.responseRules).to.deep.equal([{ path: 'status', is: 'ERROR' }]);
    });

    it('refuses a value of the wrong type, naming where', () => {
        expect(parseSystemConfiguration({ oauth: { tokenRequest: { clientAuth: 'header' } } })).to.include({ ok: false });
        const bad = parseSystemConfiguration({ defaultHeaders: { Organization: 7 } });
        expect(!bad.ok && bad.error).to.match(/^defaultHeaders\.Organization: /);
        expect(parseSystemConfiguration('match me')).to.include({ ok: false });
    });

    it('a row whose configuration does not fit is still listed, without it', () => {
        const good = globalSystemFromRow({ id: 'samplewms', item: { name: 'samplewms', config: full } });
        expect(good?.config).to.deep.equal(full);
        const bad = globalSystemFromRow({ id: 'oddwms', item: { name: 'oddwms', config: { match: 42 } } });
        expect(bad).to.include({ id: 'oddwms', scope: 'global' });
        expect(bad?.config).to.equal(undefined);
    });

    it('is read only from a Standard System: an own System\'s config, if any, is nobody\'s configuration', () => {
        expect(systemConfiguration({ scope: 'global', config: full })?.oauth?.tokenRequest?.clientAuth).to.equal('basic');
        expect(systemConfiguration({ config: full })).to.equal(undefined);
        expect(systemClientAuth({ scope: 'global', config: full })).to.equal('basic');
        expect(systemClientAuth({ scope: 'global', config: {} })).to.equal(undefined);
    });
});
