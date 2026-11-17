// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { browserPlatform } from '../../../../services/dbmn-auth/browser-platform';

/** 0.4.1: web and desktop usage rows name the platform in the words VS Code's rows use. */
describe('Web usage counter: the platform', () => {
    it('Windows, macOS and Linux browsers', () => {
        expect(browserPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).to.equal('win32');
        expect(browserPlatform({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' })).to.equal('darwin');
        expect(browserPlatform({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).to.equal('linux');
    });

    it('anything else is unknown, never a guess', () => {
        expect(browserPlatform({ platform: '', userAgent: '' })).to.equal('unknown');
    });
});
