// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: what the desktop app's window may load, open and be granted.
 */
import { expect } from 'chai';
import { BUNDLED_APP_ORIGIN, bundledPagePath, devAppOrigin, fillBackendPill, isAppPage, opensInBrowser, permissionAllowed } from '../../../services/desktop/desktop-window-policy';
import { DESKTOP_APP_PROTOCOL, LOCAL_DEMO_ANON_KEY, desktopDevBackend, resolveDesktopBackend } from '../../../services/dbmn-backend/backend-config';

const APP = 'http://127.0.0.1:5180';

describe('The desktop app\'s window (#392)', () => {
    it('a dev build loads a dev server on this computer, and nothing else', () => {
        expect(devAppOrigin(undefined)).to.equal('http://127.0.0.1:5180');
        expect(devAppOrigin('http://127.0.0.1:5321/')).to.equal('http://127.0.0.1:5321');
        for (const refused of ['https://app.dbmn.io', 'http://localhost:5180', 'http://127.0.0.1.evil.example:5180', 'http://127.0.0.1:5180/x', 'http://192.168.1.10:5180', 'file:///index.html', '']) {
            expect(() => devAppOrigin(refused), refused).to.throw(/only loads a dev server on http:\/\/127\.0\.0\.1/);
        }
    });

    it('the window goes to the app\'s own pages only', () => {
        expect(isAppPage(`${APP}/`, APP)).to.equal(true);
        expect(isAppPage(`${APP}/signin.html?next=1#x`, APP)).to.equal(true);
        expect(isAppPage('http://127.0.0.1:5181/', APP), 'another port is another app').to.equal(false);
        expect(isAppPage('https://127.0.0.1:5180/', APP)).to.equal(false);
        expect(isAppPage(`http://127.0.0.1:5180@evil.example/`, APP)).to.equal(false);
        expect(isAppPage('https://example.com/', APP)).to.equal(false);
        expect(isAppPage('file:///etc/passwd', APP)).to.equal(false);
        expect(isAppPage('javascript:alert(1)', APP)).to.equal(false);
        expect(isAppPage('not a url', APP)).to.equal(false);
    });

    it('a link out opens in the user\'s browser only for DBMN\'s sites', () => {
        expect(opensInBrowser('https://dbmn.io/docs/environments#authentication')).to.equal(true);
        expect(opensInBrowser('https://www.dbmn.io/pricing')).to.equal(true);
        expect(opensInBrowser('https://app.dbmn.io/')).to.equal(true);
        expect(opensInBrowser('http://dbmn.io/', undefined), 'never plain http').to.equal(false);
        expect(opensInBrowser('https://dbmn.io.evil.example/')).to.equal(false);
        expect(opensInBrowser('https://evil.example/?https://dbmn.io/')).to.equal(false);
        expect(opensInBrowser('file:///etc/passwd')).to.equal(false);
        expect(opensInBrowser('javascript:alert(1)')).to.equal(false);
        expect(opensInBrowser('ms-msdt:/id')).to.equal(false);
    });

    it('a dev build\'s local site opens too, and only that one', () => {
        expect(opensInBrowser('http://127.0.0.1:4000/docs/', 'http://127.0.0.1:4000')).to.equal(true);
        expect(opensInBrowser('http://127.0.0.1:4001/docs/', 'http://127.0.0.1:4000')).to.equal(false);
        expect(opensInBrowser('http://127.0.0.1:4000/docs/')).to.equal(false);
    });

    it('the app\'s pages get the clipboard; nobody gets anything else', () => {
        expect(permissionAllowed('clipboard-read', `${APP}/`, APP)).to.equal(true);
        expect(permissionAllowed('clipboard-sanitized-write', `${APP}/`, APP)).to.equal(true);
        for (const permission of ['media', 'geolocation', 'notifications', 'openExternal', 'fileSystem', 'hid', 'serial', 'usb', 'display-capture', 'local-network-access']) {
            expect(permissionAllowed(permission, `${APP}/`, APP), permission).to.equal(false);
        }
        expect(permissionAllowed('clipboard-read', 'https://example.com/', APP)).to.equal(false);
        expect(permissionAllowed('clipboard-read', undefined, APP)).to.equal(false);
    });

    describe('a packaged build: bundled pages on the app\'s own scheme', () => {
        it('the scheme the pages check is the one the window serves', () => {
            expect(new URL(`${BUNDLED_APP_ORIGIN}/`).protocol).to.equal(DESKTOP_APP_PROTOCOL);
        });

        it('its pages are the app\'s, and nothing else is', () => {
            expect(isAppPage('dbmn-app://app/', BUNDLED_APP_ORIGIN)).to.equal(true);
            expect(isAppPage('dbmn-app://app/signin.html', BUNDLED_APP_ORIGIN)).to.equal(true);
            expect(isAppPage('dbmn-app://other/', BUNDLED_APP_ORIGIN)).to.equal(false);
            expect(isAppPage('http://127.0.0.1:5180/', BUNDLED_APP_ORIGIN)).to.equal(false);
            expect(isAppPage('file:///index.html', BUNDLED_APP_ORIGIN)).to.equal(false);
            expect(opensInBrowser('dbmn-app://app/'), 'never handed to the browser').to.equal(false);
            expect(permissionAllowed('clipboard-read', 'dbmn-app://app/', BUNDLED_APP_ORIGIN)).to.equal(true);
        });

        it('a page names a bundled file, and never one outside the bundle', () => {
            expect(bundledPagePath('dbmn-app://app/')).to.equal('index.html');
            expect(bundledPagePath('dbmn-app://app/signin.html?x=1#y')).to.equal('signin.html');
            expect(bundledPagePath('dbmn-app://app/webviews/hub/hub.js')).to.equal('webviews/hub/hub.js');
            expect(bundledPagePath('dbmn-app://app/a%20b.css')).to.equal('a b.css');
            expect(bundledPagePath('dbmn-app://app/../../etc/passwd'), 'folded by the URL parser: still inside').to.equal('etc/passwd');
            for (const refused of ['dbmn-app://app/%2e%2e/%2e%2e/etc/passwd', 'dbmn-app://app/a/..%2f..%2fetc/passwd', 'dbmn-app://app/a%5c..%5cb', 'dbmn-app://app/C:%5cWindows', 'dbmn-app://app/a%00b', 'dbmn-app://app/%E0%A4%A', 'dbmn-app://other/index.html', 'file:///etc/passwd', 'http://127.0.0.1/x', 'nope']) {
                const file = bundledPagePath(refused);
                expect(file === undefined || (!file.includes('..') && !file.startsWith('/')), refused).to.equal(true);
            }
            expect(bundledPagePath('dbmn-app://app/a/..%2f..%2fetc/passwd')).to.equal(undefined);
            expect(bundledPagePath('dbmn-app://app/a%5c..%5cb')).to.equal(undefined);
            expect(bundledPagePath('dbmn-app://other/index.html')).to.equal(undefined);
        });

        it('the Hub page says which backend the build is on, from what the app hands the page', () => {
            const html = fillBackendPill('<header>{{DEV_BACKEND_PILL}}</header><main>{{DEV_BACKEND_NOTE}}</main>', { profile: 'test', apiUrl: 'http://127.0.0.1:54421' });
            expect(html).to.contain('<header><span class="hub-dev-backend is-local" title="DBMN desktop app (dev build). Backend: http://127.0.0.1:54421">DESKTOP · TEST</span></header>');
            expect(html).to.contain('Backend <code>http://127.0.0.1:54421</code>. This build only talks to a local stack.</p></main>');
            expect(html).to.not.contain('{{');
            expect(fillBackendPill('{{DEV_BACKEND_PILL}}', { profile: 'local', apiUrl: 'http://x/"><script>' })).to.not.contain('<script>');
        });

        it('a dev-channel build runs on the local stack, or the test stack by name; never an address from the environment', () => {
            expect(desktopDevBackend({})).to.deep.equal({ profile: 'local', apiUrl: 'http://127.0.0.1:54321', anonKey: LOCAL_DEMO_ANON_KEY, siteUrl: 'http://127.0.0.1:4000' });
            expect(desktopDevBackend({ DBMN_BACKEND: 'test' }).apiUrl).to.equal('http://127.0.0.1:54421');
            expect(desktopDevBackend({ DBMN_BACKEND: 'local', DBMN_BACKEND_URL: 'https://api.dbmn.io', DBMN_BACKEND_ANON_KEY: 'x' }).apiUrl, 'an address in the environment is not read').to.equal('http://127.0.0.1:54321');
            expect(() => desktopDevBackend({ DBMN_BACKEND: 'production' })).to.throw(/runs on "local" or "test"/);
        });

        it('the page checks what it was handed: a local stack, or it doesn\'t start', () => {
            expect(resolveDesktopBackend(desktopDevBackend({}))).to.include({ profile: 'local', apiUrl: 'http://127.0.0.1:54321', isDevBuild: true, storageSuffix: '__local' });
            expect(() => resolveDesktopBackend(undefined)).to.throw(/gave this page no backend/);
            expect(() => resolveDesktopBackend({ profile: 'local', apiUrl: 'https://api.dbmn.io', anonKey: 'x' })).to.throw(/only talks to a local stack/);
            expect(() => resolveDesktopBackend({ profile: 'production', apiUrl: 'https://api.dbmn.io', anonKey: 'x' })).to.throw(/"local" or "test"/);
        });
    });
});
