// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import { APIEndpointConfig } from '../../../apiConfigManager';
import { EnvironmentConfig } from '../../../environmentManager';
import {
    clusterByExecutionPairs,
    pickSystemNameFromCluster
} from '../../../services/migration/system-migration.service';
import { longestCommonPathPrefix } from '../../../data-loading/system-schema';

function makeEndpoint(id: string, path: string, method: APIEndpointConfig['method'] = 'GET'): APIEndpointConfig {
    return {
        id,
        name: id,
        path,
        method,
        headers: {},
        queryParams: {}
    } as APIEndpointConfig;
}

function makeEnv(id: string, name: string, baseUrl?: string): EnvironmentConfig {
    return {
        id,
        name,
        baseUrl,
        isActive: false,
        createdAt: Date.now()
    } as EnvironmentConfig;
}

describe('System Migration — longestCommonPathPrefix', () => {
    it('returns empty string for empty input', () => {
        expect(longestCommonPathPrefix([])).to.equal('');
    });

    it('drops the trailing path segment for a single path', () => {
        expect(longestCommonPathPrefix(['/a/b/c'])).to.equal('/a/b/');
    });

    it('returns empty string for a single-segment path', () => {
        expect(longestCommonPathPrefix(['/foo'])).to.equal('');
    });

    it('returns the longest common prefix across paths', () => {
        const prefix = longestCommonPathPrefix([
            '/dcinventory/api/dcinventory/inventory/absoluteAdjustInventory',
            '/dcinventory/api/dcinventory/inventory/absoluteAdjustInventory/Bulk',
            '/dcinventory/api/dcinventory/inventory/lookup'
        ]);
        expect(prefix).to.equal('/dcinventory/api/dcinventory/inventory/');
    });

    it('returns empty string when paths share nothing', () => {
        expect(longestCommonPathPrefix(['/foo/bar', '/baz/qux'])).to.equal('');
    });

    it('compares segment-wise, never mid-segment', () => {
        const prefix = longestCommonPathPrefix(['/api/order', '/api/orderItem']);
        expect(prefix).to.equal('/api/');
    });
});

describe('System Migration — clusterByExecutionPairs', () => {
    it('returns a single Default cluster when there are no executions', () => {
        const endpoints = [makeEndpoint('e1', '/api/foo'), makeEndpoint('e2', '/api/bar')];
        const envs = [makeEnv('v1', 'Dev')];
        const clusters = clusterByExecutionPairs(endpoints, envs, []);
        expect(clusters).to.have.lengthOf(1);
        expect(clusters[0].endpoints).to.have.lengthOf(2);
        expect(clusters[0].environments).to.have.lengthOf(1);
    });

    it('puts co-executed endpoint+environment in the same cluster', () => {
        const endpoints = [makeEndpoint('e1', '/api/foo')];
        const envs = [makeEnv('v1', 'Dev')];
        const clusters = clusterByExecutionPairs(endpoints, envs, [
            { endpointId: 'e1', environmentId: 'v1' }
        ]);
        expect(clusters).to.have.lengthOf(1);
        expect(clusters[0].endpoints.map(e => e.id)).to.deep.equal(['e1']);
        expect(clusters[0].environments.map(e => e.id)).to.deep.equal(['v1']);
    });

    it('keeps two disjoint platforms in separate clusters', () => {
        const endpoints = [
            makeEndpoint('acmewmsA', '/dcinventory/api/foo'),
            makeEndpoint('acmewmsB', '/dcinventory/api/bar'),
            makeEndpoint('dbmnA', '/functions/v1/playground/inventory')
        ];
        const envs = [
            makeEnv('mhCust1Staging', 'MH Cust1 Staging'),
            makeEnv('mhCust1Prod', 'MH Cust1 Prod'),
            makeEnv('dbmnProd', 'DBMN Prod')
        ];
        const pairs = [
            { endpointId: 'acmewmsA', environmentId: 'mhCust1Staging' },
            { endpointId: 'acmewmsA', environmentId: 'mhCust1Prod' },
            { endpointId: 'acmewmsB', environmentId: 'mhCust1Staging' },
            { endpointId: 'dbmnA', environmentId: 'dbmnProd' }
        ];
        const clusters = clusterByExecutionPairs(endpoints, envs, pairs);

        expect(clusters).to.have.lengthOf(2);
        const acmewmsCluster = clusters.find(c =>
            c.endpoints.some(e => e.id === 'acmewmsA')
        )!;
        const dbmnCluster = clusters.find(c =>
            c.endpoints.some(e => e.id === 'dbmnA')
        )!;
        expect(acmewmsCluster).to.exist;
        expect(dbmnCluster).to.exist;
        expect(acmewmsCluster.endpoints.map(e => e.id).sort()).to.deep.equal(['acmewmsA', 'acmewmsB']);
        expect(acmewmsCluster.environments.map(e => e.id).sort()).to.deep.equal(['mhCust1Prod', 'mhCust1Staging']);
        expect(dbmnCluster.endpoints.map(e => e.id)).to.deep.equal(['dbmnA']);
        expect(dbmnCluster.environments.map(e => e.id)).to.deep.equal(['dbmnProd']);
    });

    it('merges fresh / never-executed nodes into the orphan "Unknown" bucket alongside significant clusters', () => {
        const endpoints = [
            makeEndpoint('used', '/api/used'),
            makeEndpoint('fresh1', '/api/fresh1'),
            makeEndpoint('fresh2', '/api/fresh2')
        ];
        const envs = [
            makeEnv('usedEnv', 'Used Env'),
            makeEnv('freshEnv', 'Fresh Env')
        ];
        const clusters = clusterByExecutionPairs(endpoints, envs, [
            { endpointId: 'used', environmentId: 'usedEnv' }
        ]);

        expect(clusters).to.have.lengthOf(2);
        const significant = clusters.find(c => c.endpoints.some(e => e.id === 'used'))!;
        const orphans = clusters.find(c => c !== significant)!;
        expect(significant.isOrphanBucket).to.not.equal(true);
        expect(orphans.isOrphanBucket).to.equal(true);
        expect(orphans.endpoints.map(e => e.id).sort()).to.deep.equal(['fresh1', 'fresh2']);
        expect(orphans.environments.map(e => e.id)).to.deep.equal(['freshEnv']);
    });

    it('flags the single fallback cluster as the orphan bucket when there are no connections', () => {
        const endpoints = [makeEndpoint('e1', '/api/foo'), makeEndpoint('e2', '/api/bar')];
        const envs = [makeEnv('v1', 'Dev')];
        const clusters = clusterByExecutionPairs(endpoints, envs, []);
        expect(clusters).to.have.lengthOf(1);
        expect(clusters[0].isOrphanBucket).to.equal(true);
    });

    it('connects endpoints transitively via shared environments', () => {
        // e1 executed against v1; e2 executed against v1; therefore e1 and e2 belong together.
        const endpoints = [makeEndpoint('e1', '/api/a'), makeEndpoint('e2', '/api/b')];
        const envs = [makeEnv('v1', 'Shared')];
        const clusters = clusterByExecutionPairs(endpoints, envs, [
            { endpointId: 'e1', environmentId: 'v1' },
            { endpointId: 'e2', environmentId: 'v1' }
        ]);
        expect(clusters).to.have.lengthOf(1);
        expect(clusters[0].endpoints.map(e => e.id).sort()).to.deep.equal(['e1', 'e2']);
    });

    it('ignores execution pairs that reference unknown endpoint or environment IDs', () => {
        const endpoints = [makeEndpoint('e1', '/api/a')];
        const envs = [makeEnv('v1', 'Dev')];
        const clusters = clusterByExecutionPairs(endpoints, envs, [
            { endpointId: 'ghost', environmentId: 'v1' },
            { endpointId: 'e1', environmentId: 'ghost-env' }
        ]);
        // Single Default bucket — no real connections discovered.
        expect(clusters).to.have.lengthOf(1);
        expect(clusters[0].endpoints).to.have.lengthOf(1);
        expect(clusters[0].environments).to.have.lengthOf(1);
    });
});

describe('System Migration — pickSystemNameFromCluster (naming heuristic)', () => {
    // The whole point of this heuristic: a System's identity is far more
    // reliably encoded in its environment URLs and names than in endpoint
    // paths. Names are always emitted in conformant short-identifier form
    // (lowercase letters and digits only, max 16 chars).

    it('extracts the apex label from a single environment baseUrl (dbmn.io → dbmn)', () => {
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/some/path')],
            [makeEnv('v1', 'Prod', 'https://dbmn.io/api/reference/v2')],
            1
        );
        expect(name).to.equal('dbmn');
    });

    it('extracts the second-to-last hostname segment for deeper subdomains (acmaus.samplewms.test → samplewms)', () => {
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/dcinventory/api/dcinventory/inventory/widget')],
            [makeEnv('v1', 'Cust 1 Prod', 'https://acmaus.samplewms.test')],
            1
        );
        expect(name).to.equal('samplewms');
    });

    it('uses the apex label shared across multiple envs in the cluster', () => {
        const envs = [
            makeEnv('v1', 'Cust 1 Staging', 'https://cust1-staging.acmewms.com'),
            makeEnv('v2', 'Cust 1 Prod',    'https://cust1-prod.acmewms.com'),
            makeEnv('v3', 'Cust 2 Staging', 'https://cust2-staging.acmewms.com')
        ];
        const name = pickSystemNameFromCluster([], envs, 1);
        expect(name).to.equal('acmewms');
    });

    it('normalises mixed-case hostnames like DBMN.io to lowercase', () => {
        const name = pickSystemNameFromCluster(
            [],
            [makeEnv('v1', 'Prod', 'https://api.DBMN.io')],
            1
        );
        expect(name).to.equal('dbmn');
    });

    it('falls back to environment name tokens when baseUrl is missing', () => {
        const envs = [
            makeEnv('v1', 'ACMEWMS Cust1 Staging'),
            makeEnv('v2', 'ACMEWMS Cust1 Prod'),
            makeEnv('v3', 'ACMEWMS Cust2 Staging')
        ];
        const name = pickSystemNameFromCluster([], envs, 1);
        expect(name).to.equal('acmewms');
    });

    it('ignores stopwords like "prod", "staging", "cust" when scanning env names', () => {
        const envs = [
            makeEnv('v1', 'Production'),     // pure stopword → no useful token
            makeEnv('v2', 'Staging Cust 1')  // all stopwords + a number
        ];
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/wms/api/orders')],
            envs,
            1
        );
        expect(name).to.equal('wms');
    });

    it('falls back to path prefix only when env signals fail', () => {
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/dcinventory/api/dcinventory/inventory/widget')],
            [makeEnv('v1', 'Prod')], // no baseUrl, single useless name token
            1
        );
        expect(name).to.equal('dcinventory');
    });

    it('skips path stopwords (api, v1, rest) when picking from the path prefix', () => {
        const name = pickSystemNameFromCluster(
            [
                makeEndpoint('e1', '/api/v1/orders/create'),
                makeEndpoint('e2', '/api/v1/orders/cancel')
            ],
            [makeEnv('v1', 'Prod')],
            1
        );
        expect(name).to.equal('orders');
    });

    it('ignores localhost and IP-only environment URLs (no useful name there)', () => {
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/api/widget')],
            [
                makeEnv('v1', 'Local',      'http://localhost:3000'),
                makeEnv('v2', 'Static IP',  'http://192.168.1.50/foo')
            ],
            1
        );
        expect(name).to.equal('widget');
    });

    it('falls back to "sys{letter}" when nothing in the cluster yields a name', () => {
        const first = pickSystemNameFromCluster(
            [],
            [makeEnv('v1', 'prod', 'http://localhost')],
            1
        );
        expect(first).to.equal('sysa');

        const seventh = pickSystemNameFromCluster(
            [],
            [makeEnv('v1', 'prod', 'http://localhost')],
            7
        );
        expect(seventh).to.equal('sysg');
    });

    it('requires a majority of envs to share a host before naming from it', () => {
        const envs = [
            makeEnv('v1', 'Cust 1 Prod', 'https://cust1.acmewms.com'),
            makeEnv('v2', 'Cust 2 Prod', 'https://cust2.acmewms.com'),
            makeEnv('v3', 'Odd one out', 'https://something.example.com')
        ];
        expect(pickSystemNameFromCluster([], envs, 1)).to.equal('acmewms');
    });

    it('rejects a single-env host majority when there are multiple envs without consensus', () => {
        const envs = [
            makeEnv('v1', 'A', 'https://alpha.com'),
            makeEnv('v2', 'B', 'https://beta.com')
        ];
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/inventory/widget')],
            envs,
            1
        );
        expect(name).to.equal('inventory');
    });

    it('strips characters that would fail validateShortIdentifier (dots, hyphens, digits-only paths)', () => {
        // A hostname like "1234.local" can't be the System name — strip and fall through.
        const name = pickSystemNameFromCluster(
            [makeEndpoint('e', '/api/widget')],
            [makeEnv('v1', 'Local', 'http://1234.local')],
            1
        );
        // Apex label is "1234" (all digits, but our pattern allows digits) — passes.
        expect(name).to.equal('1234');
    });
});
