// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { catalogueStorageInfo, savingCatalogueStorageInfo } from '../../../services/catalogue/catalogue-location';

/**
 * While this computer's endpoints and environments go to the account (James, 2026-11-13: after
 * the copy was picked, "it just sort of doesn't say anything" until the toast at the end).
 */
describe('Where the endpoints are, while they are saved to the account', () => {
    const saving = savingCatalogueStorageInfo('67 endpoints and 8 environments');

    it('Home says they are being saved, and how many, with no button to save them again', () => {
        expect(saving.home?.title).to.equal('Saving your endpoints to your DBMN account…');
        expect(saving.home?.text).to.contain('67 endpoints and 8 environments');
        expect(saving.home?.button).to.equal(undefined);
    });

    it('Settings says so too, and offers neither Save nor Remove meanwhile', () => {
        expect(saving.label).to.equal('Saving to your DBMN account…');
        expect(saving.help).to.contain('Keep VS Code open');
        expect(saving.saveLabel).to.equal(undefined);
        expect(saving.removeLabel).to.equal(undefined);
    });

    it('is still the device\'s catalogue until the move is done', () => {
        expect(saving.where).to.equal(catalogueStorageInfo('device').where);
    });
});
