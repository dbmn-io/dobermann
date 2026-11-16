// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { normaliseEnvironmentUrl, isSameEnvironmentUrl, fillBaseUrl, baseUrlVariableNames, baseUrlProblem } from '../../../utils/environment-url';

/**
 * Environment URL identity.
 *
 * An environment is known by this string, so a mismatch here means one
 * environment reads as another. Pure logic — no VS Code involved.
 */
describe('normaliseEnvironmentUrl', () => {
    it('reduces a URL to protocol//hostname', () => {
        expect(normaliseEnvironmentUrl('https://acmaus.samplewms.test')).to.equal('https://acmaus.samplewms.test');
    });

    it('drops path, query and hash', () => {
        expect(normaliseEnvironmentUrl('https://acmaus.samplewms.test/dcinventory/api?x=1#frag'))
            .to.equal('https://acmaus.samplewms.test');
    });

    it('drops a trailing slash', () => {
        expect(normaliseEnvironmentUrl('https://acmaus.samplewms.test/')).to.equal('https://acmaus.samplewms.test');
    });

    it('drops the port', () => {
        expect(normaliseEnvironmentUrl('https://acmaus.samplewms.test:8443/api')).to.equal('https://acmaus.samplewms.test');
    });

    it('lowercases the hostname and protocol', () => {
        expect(normaliseEnvironmentUrl('HTTPS://ACMAUS.SAMPLEWMS.TEST/API')).to.equal('https://acmaus.samplewms.test');
    });

    it('trims surrounding whitespace', () => {
        expect(normaliseEnvironmentUrl('  https://acmaus.samplewms.test  ')).to.equal('https://acmaus.samplewms.test');
    });

    it('preserves the scheme rather than coercing to https', () => {
        expect(normaliseEnvironmentUrl('http://localhost:3000/api')).to.equal('http://localhost');
    });

    it('returns empty string for unparseable input', () => {
        expect(normaliseEnvironmentUrl('acmaus.samplewms.test')).to.equal('');
        expect(normaliseEnvironmentUrl('not a url')).to.equal('');
        expect(normaliseEnvironmentUrl('')).to.equal('');
        expect(normaliseEnvironmentUrl(undefined)).to.equal('');
        expect(normaliseEnvironmentUrl(null)).to.equal('');
    });
});

describe('isSameEnvironmentUrl', () => {
    it('matches URLs that differ only in case, port, path or trailing slash', () => {
        expect(isSameEnvironmentUrl(
            'https://acmaus.samplewms.test/',
            'HTTPS://acmaus.samplewms.test:443/dcinventory/api'
        )).to.equal(true);
    });

    it('does not match different hosts', () => {
        expect(isSameEnvironmentUrl('https://prod.samplewms.test', 'https://dev.samplewms.test')).to.equal(false);
    });

    it('does not match different schemes on the same host', () => {
        expect(isSameEnvironmentUrl('http://acmaus.samplewms.test', 'https://acmaus.samplewms.test')).to.equal(false);
    });

    it('never matches two unparseable URLs to each other', () => {
        expect(isSameEnvironmentUrl('nonsense', 'nonsense')).to.equal(false);
        expect(isSameEnvironmentUrl(undefined, undefined)).to.equal(false);
        expect(isSameEnvironmentUrl('', '')).to.equal(false);
    });
});

/**
 * #424: a base URL may hold variables in its path, filled when a request goes; never in its
 * host, which is the environment's identity (and its System).
 */
describe('base URL variables (#424)', () => {
    it('fills {{name}} and {{ENV:name}} in the path; a name with no value stays as typed', () => {
        const url = 'https://api.example.com/v2.0/{{tenant}}/{{ ENV:company }}/{{missing}}';
        expect(fillBaseUrl(url, { tenant: 'acme', company: 'CRONUS', missing: '' })).to.equal('https://api.example.com/v2.0/acme/CRONUS/{{missing}}');
        expect(fillBaseUrl('https://api.example.com', undefined)).to.equal('https://api.example.com');
    });

    it('names the variables a base URL uses, each once', () => {
        expect(baseUrlVariableNames('https://h.test/{{version}}/{{ENV:tenant}}/{{version}}')).to.deep.equal(['version', 'tenant']);
        expect(baseUrlVariableNames(undefined)).to.deep.equal([]);
    });

    it('a variable in the path saves; in the host it never does', () => {
        expect(baseUrlProblem('https://api.example.com/functions/{{version}}/playground')).to.equal(undefined);
        expect(baseUrlProblem('https://{{env}}.operations.example.com')).to.contain('only be part of the path');
        expect(baseUrlProblem('not a url')).to.contain('not a valid URL');
    });

    it('an existing environment\'s path may change; its host, port or protocol may not', () => {
        const before = 'http://127.0.0.1:54321/functions/v1/playground';
        expect(baseUrlProblem('http://127.0.0.1:54321/functions/{{version}}/playground', before)).to.equal(undefined);
        expect(baseUrlProblem('http://127.0.0.1:54322/functions/v1/playground', before)).to.contain("host can't change");
        expect(baseUrlProblem('https://other.example.com/functions/v1/playground', before)).to.contain('Make a new environment');
    });
});
