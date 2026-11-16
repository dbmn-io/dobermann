// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { bundledCommit, versionLabel } from '../../../utils/version-label';
import { buildHubPage } from '../../../screens/pages';

/**
 * #447: every app shows the version with the commit it was built from, releases included, so two
 * web app builds of the same version can be told apart.
 */
describe('The version every app shows (#447)', () => {
    it('is the version and the commit', () => {
        expect(versionLabel('0.4.0', '64ca0bc')).to.equal('v0.4.0 · 64ca0bc');
    });

    it('is the version alone without a commit, and nothing without a version', () => {
        expect(versionLabel('0.4.0')).to.equal('v0.4.0');
        expect(versionLabel('0.4.0', '')).to.equal('v0.4.0');
        expect(versionLabel(undefined, '64ca0bc')).to.equal('');
    });

    it('has no bundled commit when run from tsc output (webpack bakes one into the extension)', () => {
        expect(bundledCommit()).to.equal('');
    });

    it('is what Home shows', () => {
        const html = buildHubPage('<span class="hub-home-version">{{HUB_VERSION}}</span>', rel => rel, undefined,
            { DEV_BACKEND_PILL: '', DEV_BACKEND_NOTE: '' }, '0.4.0', '64ca0bc');
        expect(html).to.contain('<span class="hub-home-version">v0.4.0 · 64ca0bc</span>');
    });
});
