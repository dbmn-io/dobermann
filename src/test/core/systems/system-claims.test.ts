// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: who a token says the person is, read by the Standard System's claim names.
 * Organisations and locations are not read from tokens (#424): they are environment variables.
 */
import { expect } from 'chai';
import { identityOf } from '../../../services/systems/system-claims';

const configuration = { claims: { name: 'name', email: 'email', username: 'preferred_username' } };
const payload = {
    name: 'Alex Example', email: 'alex@example.com', preferred_username: 'alex', sub: 'u-1',
    userOrgs: ['ACM-APAC-DEV', 'Store-123-DEV']
};

describe('#415 token claims are the Standard System\'s', () => {
    it('reads the account by the System\'s claim names, and nothing else', () => {
        expect(identityOf(payload, configuration)).to.deep.equal({ name: 'Alex Example', email: 'alex@example.com', username: 'alex' });
    });

    it('without a System, the OpenID names; without a token, nothing', () => {
        expect(identityOf(payload)).to.deep.equal({ name: 'Alex Example', email: 'alex@example.com', username: 'alex' });
        expect(identityOf(null, configuration)).to.deep.equal({});
    });

    it('a System may name other claims for the account itself', () => {
        expect(identityOf({ display: 'A', mail: 'a@x', uid: 'a' }, { claims: { name: 'display', email: 'mail', username: 'uid' } })).to.include({ name: 'A', email: 'a@x', username: 'a' });
    });
});
