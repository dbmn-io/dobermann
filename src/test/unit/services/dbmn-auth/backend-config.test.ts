// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import {
    LOCAL_DEMO_ANON_KEY, PRODUCTION_BACKEND, backendLabel, backendUnreachableMessage, dbmnStorageKeys,
    devBackendMarkup, getBackend, initBackend, isAllowedExternalUrl, isBackendReachable, resolveDocsUrl,
    reportedExtensionVersion, resolveBackend
} from '../../../../services/dbmn-backend/backend-config';
import { DBMN_CACHE_TTL, DBMN_STORAGE_KEYS } from '../../../../types/dbmn-auth';

describe('backend-config — which DBMN backend a build talks to', () => {
    afterEach(() => initBackend(PRODUCTION_BACKEND));

    describe('a packaged build', () => {
        it('is always production, whatever the environment says', () => {
            const config = resolveBackend({
                isDevelopment: false,
                env: { DBMN_BACKEND: 'local', DBMN_BACKEND_URL: 'http://evil.example', DBMN_SITE_URL: 'http://evil.example' }
            });
            expect(config).to.deep.equal(PRODUCTION_BACKEND);
            expect(config.isDevBuild).to.equal(false);
        });

        it('does not even validate DBMN_BACKEND — it never reads it', () => {
            expect(() => resolveBackend({ isDevelopment: false, env: { DBMN_BACKEND: 'nonsense' } })).to.not.throw();
        });
    });

    describe('the Extension Development Host', () => {
        it('defaults to the LOCAL stack', () => {
            const config = resolveBackend({ isDevelopment: true, env: {} });
            expect(config.profile).to.equal('local');
            expect(config.apiUrl).to.equal('http://127.0.0.1:54321');
            expect(config.siteUrl).to.equal('http://127.0.0.1:4000');
            expect(config.anonKey).to.equal(LOCAL_DEMO_ANON_KEY);
            expect(config.isDevBuild).to.equal(true);
        });

        it('reaches production only when asked to, and still knows it is a dev build', () => {
            const config = resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: ' Production ' } });
            expect(config.profile).to.equal('production');
            expect(config.apiUrl).to.equal(PRODUCTION_BACKEND.apiUrl);
            expect(config.isDevBuild).to.equal(true);
        });

        it('lets the local profile point at a stack on another machine', () => {
            const config = resolveBackend({
                isDevelopment: true,
                env: { DBMN_BACKEND: 'local', DBMN_BACKEND_URL: 'http://devbox:54321/', DBMN_BACKEND_ANON_KEY: ' key ', DBMN_SITE_URL: 'http://devbox:4000//' }
            });
            expect(config.apiUrl).to.equal('http://devbox:54321');
            expect(config.anonKey).to.equal('key');
            expect(config.siteUrl).to.equal('http://devbox:4000');
        });

        it('#377: the test profile is the disposable test stack, with its own stored sessions', () => {
            const config = resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'test' } });
            expect(config.profile).to.equal('test');
            expect(config.apiUrl).to.equal('http://127.0.0.1:54421');
            expect(config.anonKey).to.equal(LOCAL_DEMO_ANON_KEY);
            expect(config.storageSuffix).to.equal('__test');
            expect(config.isDevBuild).to.equal(true);
            expect(backendLabel(config)).to.equal('DEV · TEST');
        });

        it('refuses an unknown profile instead of guessing', () => {
            expect(() => resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'staging' } }))
                .to.throw(/must be "local", "test" or "production"/);
        });
    });

    describe('how long the last known licence is trusted (issue #396)', () => {
        const FOUR_WEEKS_MS = 28 * 24 * 60 * 60 * 1000;

        it('is four weeks, in a packaged build and in a dev build that does not say otherwise', () => {
            expect(DBMN_CACHE_TTL.offlineGracePeriodMs).to.equal(FOUR_WEEKS_MS);
            expect(PRODUCTION_BACKEND.licenseGraceMs).to.equal(FOUR_WEEKS_MS);
            expect(resolveBackend({ isDevelopment: true, env: {} }).licenseGraceMs).to.equal(FOUR_WEEKS_MS);
            expect(resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production' } }).licenseGraceMs).to.equal(FOUR_WEEKS_MS);
        });

        it('a packaged build never reads DBMN_LICENSE_GRACE_MINUTES', () => {
            expect(resolveBackend({ isDevelopment: false, env: { DBMN_LICENSE_GRACE_MINUTES: '10' } }).licenseGraceMs).to.equal(FOUR_WEEKS_MS);
            expect(() => resolveBackend({ isDevelopment: false, env: { DBMN_LICENSE_GRACE_MINUTES: 'nonsense' } })).to.not.throw();
        });

        it('a dev build can shorten it to test the lapse, on either profile', () => {
            expect(resolveBackend({ isDevelopment: true, env: { DBMN_LICENSE_GRACE_MINUTES: '10' } }).licenseGraceMs).to.equal(10 * 60 * 1000);
            expect(resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production', DBMN_LICENSE_GRACE_MINUTES: ' 0.5 ' } }).licenseGraceMs).to.equal(30 * 1000);
        });

        it('refuses a value that is not a number of minutes greater than 0', () => {
            for (const bad of ['ten', '0', '-5', 'Infinity']) {
                expect(() => resolveBackend({ isDevelopment: true, env: { DBMN_LICENSE_GRACE_MINUTES: bad } }), bad)
                    .to.throw(/DBMN_LICENSE_GRACE_MINUTES must be a number of minutes greater than 0/);
            }
        });

        it('a shortened grace is named in the dev note; the default is not', () => {
            const short = devBackendMarkup(resolveBackend({ isDevelopment: true, env: { DBMN_LICENSE_GRACE_MINUTES: '10' } }));
            expect(short.DEV_BACKEND_NOTE).to.contain('Licence grace shortened to 10 min.');
            expect(devBackendMarkup(resolveBackend({ isDevelopment: true, env: {} })).DEV_BACKEND_NOTE).to.not.contain('Licence grace');
        });
    });

    describe('stored sessions are separated per profile', () => {
        it('production keeps the historical key names, so users see no change', () => {
            initBackend(PRODUCTION_BACKEND);
            expect(dbmnStorageKeys()).to.deep.equal(DBMN_STORAGE_KEYS);
        });

        it('a dev build on PRODUCTION shares the real session on purpose', () => {
            initBackend(resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production' } }));
            expect(dbmnStorageKeys().session).to.equal(DBMN_STORAGE_KEYS.session);
        });

        it('the local profile never touches a production key', () => {
            initBackend(resolveBackend({ isDevelopment: true, env: {} }));
            const local = dbmnStorageKeys();
            const production = new Set<string>(Object.values(DBMN_STORAGE_KEYS));
            for (const key of Object.values(local)) {
                expect(production.has(key), key).to.equal(false);
            }
            expect(getBackend().profile).to.equal('local');
        });
    });

    describe('always visible in a dev build, invisible in a packaged one', () => {
        it('labels the two dev profiles and nothing else', () => {
            expect(backendLabel(PRODUCTION_BACKEND)).to.equal('');
            expect(backendLabel(resolveBackend({ isDevelopment: true, env: {} }))).to.equal('DEV · LOCAL');
            expect(backendLabel(resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production' } }))).to.equal('DEV · PRODUCTION');
        });

        it('a packaged build renders no pill and no note', () => {
            expect(devBackendMarkup(PRODUCTION_BACKEND)).to.deep.equal({ DEV_BACKEND_PILL: '', DEV_BACKEND_NOTE: '' });
        });

        it('the pill carries the profile class and escapes anything that came from the environment', () => {
            const config = resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND_URL: 'http://x"><script>alert(1)</script>' } });
            const markup = devBackendMarkup(config);
            expect(markup.DEV_BACKEND_PILL).to.contain('hub-dev-backend is-local').and.to.contain('DEV · LOCAL');
            expect(markup.DEV_BACKEND_PILL + markup.DEV_BACKEND_NOTE).to.not.contain('<script>');
            const prod = devBackendMarkup(resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production' } }));
            expect(prod.DEV_BACKEND_PILL).to.contain('is-production');
        });

        it('hub.html has a slot for both, and hub.css styles the warning variant', () => {
            const webviews = path.resolve(__dirname, '../../../../../src/webviews');
            const html = fs.readFileSync(path.join(webviews, 'hub/hub.html'), 'utf8');
            expect(html).to.contain('{{DEV_BACKEND_PILL}}').and.to.contain('{{DEV_BACKEND_NOTE}}');
            // The badge reads with the logo ("DBMN · DEV · LOCAL"), on the left; state is on the right.
            expect(html).to.match(/hub-logo-wordmark[\s\S]*?\{\{DEV_BACKEND_PILL\}\}[\s\S]*?hub-env-selector-wrap[\s\S]*?hubSessionExpiredBtn[\s\S]*?hubActivityChip/);
            const css = fs.readFileSync(path.join(webviews, 'shared/hub.css'), 'utf8');
            expect(css).to.contain('.hub-dev-backend.is-production');
            // LOCAL is the same yellow as the website's LOCAL ribbon: one signal, two places.
            expect(css).to.match(/\.hub-dev-backend\.is-local\s*\{[^}]*background:\s*#f2b632/);
        });
    });

    describe('help links open the docs of the site the build talks to', () => {
        const url = 'https://dbmn.io/docs/hub/#help-mode';
        it('a dev build on the local profile opens the local site (next-release docs)', () => {
            expect(resolveDocsUrl(url, resolveBackend({ isDevelopment: true, env: {} }))).to.equal('http://127.0.0.1:4000/docs/hub/#help-mode');
        });
        it('a packaged build and the production profile keep dbmn.io', () => {
            expect(resolveDocsUrl(url, resolveBackend({ isDevelopment: false, env: {} }))).to.equal(url);
            expect(resolveDocsUrl(url, resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production' } }))).to.equal(url);
        });
        it('anything that is not a docs link is left alone', () => {
            expect(resolveDocsUrl('https://dbmn.io/pricing.html', resolveBackend({ isDevelopment: true, env: {} }))).to.equal('https://dbmn.io/pricing.html');
        });
    });

    describe('dev telemetry is tagged', () => {
        it('appends -dev in a dev build only', () => {
            expect(reportedExtensionVersion('1.2.3', PRODUCTION_BACKEND)).to.equal('1.2.3');
            expect(reportedExtensionVersion('1.2.3', resolveBackend({ isDevelopment: true, env: { DBMN_BACKEND: 'production' } }))).to.equal('1.2.3-dev');
        });
    });

    describe('no silent fallback', () => {
        const local = resolveBackend({ isDevelopment: true, env: {} });

        it('reports an unreachable stack as unreachable — and leaves the profile alone', async () => {
            initBackend(local);
            const reachable = await isBackendReachable(local, async () => { throw new Error('ECONNREFUSED'); });
            expect(reachable).to.equal(false);
            expect(getBackend().profile, 'still local; nothing switched to production').to.equal('local');
            expect(getBackend().apiUrl).to.equal('http://127.0.0.1:54321');
        });

        it('asks the health endpoint of the ACTIVE backend only', async () => {
            const asked: string[] = [];
            const ok = await isBackendReachable(local, async (url) => { asked.push(url); return { status: 200 }; });
            expect(ok).to.equal(true);
            expect(asked).to.deep.equal(['http://127.0.0.1:54321/auth/v1/health']);
        });

        it('treats a 5xx as down', async () => {
            expect(await isBackendReachable(local, async () => ({ status: 503 }))).to.equal(false);
        });

        it('the message names the fix; production has no such message', () => {
            expect(backendUnreachableMessage(local)).to.contain('npm run dev:local').and.to.contain('PRODUCTION backend');
            expect(backendUnreachableMessage(PRODUCTION_BACKEND)).to.equal('');
        });
    });

    describe('links the extension may open', () => {
        it('published docs always; the local site only on the local profile', () => {
            const local = resolveBackend({ isDevelopment: true, env: {} });
            expect(isAllowedExternalUrl('https://dbmn.io/docs/run-api#paste-a-row', PRODUCTION_BACKEND)).to.equal(true);
            expect(isAllowedExternalUrl('https://dbmn.io/docs/run-api', local)).to.equal(true);
            expect(isAllowedExternalUrl('http://127.0.0.1:4000/puppy-school/', local)).to.equal(true);
            expect(isAllowedExternalUrl('http://127.0.0.1:4000/puppy-school/', PRODUCTION_BACKEND)).to.equal(false);
            expect(isAllowedExternalUrl('https://dbmn.io.evil.example/', PRODUCTION_BACKEND)).to.equal(false);
            expect(isAllowedExternalUrl('https://evil.example/?https://dbmn.io/', local)).to.equal(false);
        });
    });

    describe('the launch configurations say what they do', () => {
        it('both set DBMN_BACKEND explicitly, and the names match', () => {
            const raw = fs.readFileSync(path.resolve(__dirname, '../../../../../.vscode/launch.json'), 'utf8');
            const json = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '')) as { configurations: Array<{ name: string; env?: Record<string, string> }> };
            const byBackend = Object.fromEntries(json.configurations.map(c => [c.env?.DBMN_BACKEND, c.name]));
            expect(byBackend.local).to.equal('Run Extension (LOCAL backend)');
            expect(byBackend.production).to.equal('Run Extension (PRODUCTION backend)');
            expect(json.configurations.every(c => !!c.env?.DBMN_BACKEND), 'no configuration leaves it implicit').to.equal(true);
        });
    });
});
