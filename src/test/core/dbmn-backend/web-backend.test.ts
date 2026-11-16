// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #377 (Architecture-v2.md 2.2): one backend config for every host. The web app's backend comes
 * from core: a production bundle is production only, a dev server hands over a local stack, and
 * the page refuses to run unless "it is app.dbmn.io" and "its backend is production" agree.
 */
import { expect } from 'chai';
import {
    LOCAL_DEFAULTS, PRODUCTION_BACKEND, WEB_APP_HOST, backendLabel, devStackBackend, getBackend, initBackend, resolveWebBackend
} from '../../../services/dbmn-backend/backend-config';

const local = { profile: 'local', apiUrl: 'http://127.0.0.1:54321', anonKey: 'anon-local', siteUrl: 'http://127.0.0.1:4000/' };
const test = { profile: 'test', apiUrl: 'http://127.0.0.1:54421/', anonKey: ' anon-test ' };

/** Issue #396: how long the last known licence is trusted; every profile carries it. */
const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;

describe('The web app\'s backend (#377)', () => {
    afterEach(() => initBackend(PRODUCTION_BACKEND));

    it('the three profiles: a dev server\'s local or test stack, and production with no dev server', () => {
        expect(resolveWebBackend({ hostname: '127.0.0.1', devServer: local })).to.deep.equal({
            profile: 'local', apiUrl: 'http://127.0.0.1:54321', anonKey: 'anon-local', siteUrl: 'http://127.0.0.1:4000', storageSuffix: '__local', isDevBuild: true, licenseGraceMs: FOUR_WEEKS_MS
        });
        expect(resolveWebBackend({ hostname: '127.0.0.1', devServer: test })).to.deep.equal({
            profile: 'test', apiUrl: 'http://127.0.0.1:54421', anonKey: 'anon-test', siteUrl: LOCAL_DEFAULTS.siteUrl, storageSuffix: '__test', isDevBuild: true, licenseGraceMs: FOUR_WEEKS_MS
        });
        expect(resolveWebBackend({ hostname: WEB_APP_HOST })).to.equal(PRODUCTION_BACKEND);
    });

    it('a production bundle anywhere but app.dbmn.io refuses to run', () => {
        for (const hostname of ['127.0.0.1', 'localhost', 'app.dbmn.io.evil.example', 'dbmn.io', 'preview.pages.dev', '']) {
            expect(() => resolveWebBackend({ hostname }), hostname).to.throw(/will not use the production backend/);
        }
    });

    it('app.dbmn.io never runs on anything but production', () => {
        expect(() => resolveWebBackend({ hostname: WEB_APP_HOST, devServer: local })).to.throw('app.dbmn.io only runs on the production backend, not http://127.0.0.1:54321.');
    });

    it('a dev server only ever hands over a local stack: production, a remote host, or nothing at all is refused', () => {
        const refused = (devServer: Record<string, unknown>) => expect(() => resolveWebBackend({ hostname: '127.0.0.1', devServer }), JSON.stringify(devServer));
        refused({ ...local, apiUrl: PRODUCTION_BACKEND.apiUrl }).to.throw(/only talks to a local stack/);
        refused({ ...local, apiUrl: 'http://127.0.0.1.evil.example:54321' }).to.throw(/only talks to a local stack/);
        refused({ ...local, apiUrl: 'https://127.0.0.1:54321' }).to.throw(/only talks to a local stack/);
        refused({ ...local, apiUrl: 'http://devbox:54321' }).to.throw(/only talks to a local stack/);
        refused({ ...local, apiUrl: undefined }).to.throw(/a missing API URL/);
        refused({ ...local, profile: 'production' }).to.throw(/"local" or "test", not "production"/);
        refused({ ...local, anonKey: '' }).to.throw(/no anon key/);
        // /backend.js didn't load: a dev page never falls back to production
        refused({}).to.throw(/"local" or "test", not "undefined"/);
    });

    it('the web root initialises core\'s backend: what a core service reads is the page\'s, not production', () => {
        expect(getBackend(), 'before a host decides').to.equal(PRODUCTION_BACKEND);
        initBackend(resolveWebBackend({ hostname: '127.0.0.1', devServer: test }));
        expect(getBackend().apiUrl).to.equal('http://127.0.0.1:54421');
        expect(getBackend().profile).to.equal('test');
    });

    it('a dev page says which stack it is on; a production page says nothing', () => {
        expect(backendLabel(devStackBackend(local), 'WEB')).to.equal('WEB · LOCAL');
        expect(backendLabel(devStackBackend(test), 'WEB')).to.equal('WEB · TEST');
        expect(backendLabel(PRODUCTION_BACKEND, 'WEB')).to.equal('');
    });
});
