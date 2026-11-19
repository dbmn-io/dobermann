// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** A sign-in link asked for again too soon: the wait, read from the backend's refusal. */
import { expect } from 'chai';
import { signInLinkWaitSeconds } from '../../../services/dbmn-auth/sign-in-link-wait';

describe('Asking for another sign-in link too soon', () => {
    it('reads the seconds from the refusal', () => {
        expect(signInLinkWaitSeconds(429, 'For security purposes, you can only request this after 47 seconds.')).to.equal(47);
        expect(signInLinkWaitSeconds(429, 'For security purposes, you can only request this after 1 second.')).to.equal(1);
    });

    it('anything else is not a wait: another status, no seconds, a number out of reason', () => {
        expect(signInLinkWaitSeconds(400, 'For security purposes, you can only request this after 47 seconds.')).to.equal(undefined);
        expect(signInLinkWaitSeconds(429, 'Email rate limit exceeded')).to.equal(undefined);
        expect(signInLinkWaitSeconds(429, 'only request this after 0 seconds')).to.equal(undefined);
        expect(signInLinkWaitSeconds(429, 'only request this after 99999 seconds')).to.equal(undefined);
        expect(signInLinkWaitSeconds(429, undefined)).to.equal(undefined);
    });
});
