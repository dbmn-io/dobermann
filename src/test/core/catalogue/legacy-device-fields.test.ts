// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * An environment from a device that ran an older build still carries `currentOrg`. The
 * account's table refuses it (catalog_environments_no_device_state), so moving this device's
 * catalogue to the account failed on the first such environment (2026-10-31, the dev host).
 */
import { expect } from 'chai';
import type { EnvironmentConfig } from '../../../environmentManager';
import { toCatalogueEnvironment } from '../../../services/catalogue/catalogue-safe-form';

describe('an older device environment crossing to the account', () => {
    it('leaves currentOrg behind with the other device-only fields', () => {
        const old = { id: 'env-1', name: 'Old', baseUrl: 'https://old.example', environmentType: 'development', authMethod: 'none',
            isActive: true, lastUsed: '2026-01-01', currentOrg: 'ACM-APAC-DEV', variables: { org: 'ACM-APAC-DEV' } } as unknown as EnvironmentConfig;
        const shared = toCatalogueEnvironment(old) as unknown as Record<string, unknown>;
        expect(shared).to.not.have.any.keys('isActive', 'lastUsed', 'currentOrg');
        expect(shared.variables).to.deep.equal({ org: 'ACM-APAC-DEV' });
        expect(shared.name).to.equal('Old');
    });
});
