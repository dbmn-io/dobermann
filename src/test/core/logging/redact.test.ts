// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { Redactor, REMOVED, isSecretName } from '../../../services/logging/redact';

/** Dobermann issue 7: secrets are removed where a log line is written. */
describe('Redactor: secrets never reach a log line', () => {
    const r = new Redactor();

    it('removes a header written out, to the end of its line', () => {
        expect(r.text('Authorization: Basic ZGJtbi1sb2FkZXI6czNjcjN0')).to.equal(`Authorization: ${REMOVED}`);
        expect(r.text('Cookie: sid=abc123; theme=dark')).to.equal(`Cookie: ${REMOVED}`);
        expect(r.text('POST https://auth.example.test/token\nAuthorization: Bearer abcdefghijklmnop\nContent-Type: x'))
            .to.equal(`POST https://auth.example.test/token\nAuthorization: ${REMOVED}\nContent-Type: x`);
    });

    it('removes quoted secret fields in JSON, and keeps the rest', () => {
        const body = '{"access_token":"eyJhbGciOi.xyz","token_type":"Bearer","expires_in":3600,"refresh_token":"r-123456"}';
        expect(r.text(body)).to.equal(`{"access_token":"${REMOVED}","token_type":"Bearer","expires_in":3600,"refresh_token":"${REMOVED}"}`);
        expect(r.text("{'client_secret': 'shh-very-secret'}")).to.equal(`{'client_secret': '${REMOVED}'}`);
    });

    it('removes unquoted values: form bodies and name=value', () => {
        expect(r.text('grant_type=client_credentials&client_id=dbmn&client_secret=s3cr3t-value&scope=openid'))
            .to.equal(`grant_type=client_credentials&client_id=dbmn&client_secret=${REMOVED}&scope=openid`);
        expect(r.text('password: hunter22 then more')).to.equal(`password: ${REMOVED} then more`);
    });

    it('removes the one-time code and tokens in a URL, and keeps the rest of it', () => {
        expect(r.text('https://app.example.test/callback?state=xyz&code=4/0AbCdEf123'))
            .to.equal(`https://app.example.test/callback?state=xyz&code=${REMOVED}`);
        expect(r.text('https://x.test/#access_token=abc.def&expires_in=60'))
            .to.equal(`https://x.test/#access_token=${REMOVED}&expires_in=60`);
    });

    it('removes a scheme with its credential, and a JWT on its own', () => {
        expect(r.text('sent with Bearer abcdefghijklmnopqrstu to the System')).to.equal(`sent with Bearer ${REMOVED} to the System`);
        const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl';
        expect(r.text(`token was ${jwt}.`)).to.equal(`token was ${REMOVED}.`);
    });

    it('keeps ordinary sentences that mention these words', () => {
        const lines = [
            'Token refreshed (client credentials, expires in 3600 s)',
            'Client authentication: Basic header',
            'Sign-in started for Prod (OAuth, client credentials)',
            '{"errors":[{"code":"ITEM_NOT_FOUND","field":"itemId"}]}',
            'Request 23: 400 Bad Request. 3 rows refused: itemId must not be empty'
        ];
        for (const line of lines) expect(r.text(line), line).to.equal(line);
    });

    it('removes a known secret wherever it appears, longest first', () => {
        const known = new Redactor();
        known.addSecret('abc'); // too short to be taken: it would match ordinary text
        known.addSecret('sk_live_1234');
        known.addSecret('sk_live_1234_and_more');
        expect(known.text('value sk_live_1234_and_more and sk_live_1234, abc')).to.equal(`value ${REMOVED} and ${REMOVED}, abc`);
    });

    it('copies a value with secret-named fields removed, at any depth, never changing the original', () => {
        const original = {
            url: 'https://x.test/token',
            headers: { Authorization: 'Basic xyz', 'Content-Type': 'application/json', 'x-api-key': 'k' },
            body: { client_id: 'dbmn', clientSecret: 'shh', tokenUrl: 'https://x.test/token', nested: [{ accessToken: 'a' }] },
            empty: { password: '' }
        };
        const copy = r.value(original);
        expect(copy.headers.Authorization).to.equal(REMOVED);
        expect(copy.headers['x-api-key']).to.equal(REMOVED);
        expect(copy.headers['Content-Type']).to.equal('application/json');
        expect(copy.body.clientSecret).to.equal(REMOVED);
        expect(copy.body.tokenUrl).to.equal('https://x.test/token');
        expect(copy.body.nested[0].accessToken).to.equal(REMOVED);
        expect(copy.empty.password).to.equal('');
        expect(original.headers.Authorization).to.equal('Basic xyz');
    });

    it('names: secrets by name, without case, dashes or underscores', () => {
        for (const n of ['Authorization', 'set-cookie', 'client_secret', 'csrfToken', 'X-API-Key', 'private_key']) {
            expect(isSecretName(n), n).to.equal(true);
        }
        for (const n of ['tokenUrl', 'token_type', 'Content-Type', 'clientId', 'expires_in']) {
            expect(isSecretName(n), n).to.equal(false);
        }
    });
});
