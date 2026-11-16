// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { APIEndpointManager } from '../../apiEndpointManager';
import { APIEndpointConfig } from '../../apiConfigManager';
import { EnvironmentConfig, EnvironmentManager } from '../../environmentManager';
import { SystemManager } from '../../systemManager';
import { IExecutionStorage } from '../storage/execution-storage.interface';
import { SystemConfig, longestCommonPathPrefix } from '../../data-loading/system-schema';

/**
 * One-off migration that assigns every existing Endpoint and Environment to a
 * System. Runs when {@link MIGRATION_FLAG_KEY} is absent from globalState. After a
 * successful run the flag is set so it never runs again.
 *
 * Strategy
 * --------
 *  - Read all execution records to discover which (endpointId, environmentId)
 *    pairs have actually been used together.
 *  - Treat endpoints and environments as nodes of a bipartite graph and the
 *    co-occurrence pairs as edges. Connected components of that graph become
 *    Systems — endpoints used against the same environments naturally cluster.
 *  - Anything with no execution history (or any leftovers after clustering)
 *    lands in a single "Default" System.
 *  - Each cluster is named heuristically from its endpoints' longest common
 *    path prefix; falls back to "System N" when there is no useful prefix.
 *  - Each cluster's trim prefix is the same longest-common-prefix value,
 *    which the user can later edit on the System config page.
 */
export const MIGRATION_FLAG_KEY = 'dbmn.systemMigration.v1.completed';

export interface MigrationSummary {
    ran: boolean;
    systemsCreated: number;
    endpointsAssigned: number;
    environmentsAssigned: number;
    reason?: string;
}

export class SystemMigrationService {
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly endpointManager: APIEndpointManager,
        private readonly environmentManager: EnvironmentManager,
        private readonly systemManager: SystemManager,
        private readonly executionStorage: IExecutionStorage
    ) {}

    async migrateIfNeeded(): Promise<MigrationSummary> {
        const alreadyRan = this.context.globalState.get<boolean>(MIGRATION_FLAG_KEY);
        if (alreadyRan) {
            return { ran: false, systemsCreated: 0, endpointsAssigned: 0, environmentsAssigned: 0, reason: 'already-completed' };
        }

        const summary = await this.run();
        await this.context.globalState.update(MIGRATION_FLAG_KEY, true);
        return summary;
    }

    /**
     * Force a re-run regardless of the migration flag. Intended for tests and
     * for a future "reset Systems" command.
     */
    async runForced(): Promise<MigrationSummary> {
        return this.run();
    }

    private async run(): Promise<MigrationSummary> {
        const endpoints = await this.endpointManager.getAllEndpoints();
        const environments = await this.environmentManager.getAllEnvironments();

        if (endpoints.length === 0 && environments.length === 0) {
            return { ran: true, systemsCreated: 0, endpointsAssigned: 0, environmentsAssigned: 0, reason: 'no-data' };
        }

        const pairs = await this.collectExecutionPairs(endpoints, environments);
        const components = clusterByExecutionPairs(endpoints, environments, pairs);

        // Persist Systems
        const createdSystems: SystemConfig[] = [];
        let endpointsAssigned = 0;
        let environmentsAssigned = 0;
        let fallbackCounter = 1;

        for (const component of components) {
            const name = component.isOrphanBucket
                ? 'Unsorted'
                : pickSystemNameFromCluster(component.endpoints, component.environments, fallbackCounter);
            if (name.startsWith('sys')) fallbackCounter++;

            // Orphans don't share a meaningful prefix — skip the trim suggestion
            // so the user isn't stuck with a half-right path to override.
            const trim = component.isOrphanBucket
                ? undefined
                : longestCommonPathPrefix(component.endpoints.map(e => e.path));
            const description = component.isOrphanBucket
                ? 'Catch-all for endpoints and environments the migration could not link via execution history. Rename and reassign as needed.'
                : (component.endpoints.length === 0
                    ? 'Auto-created during System migration (no endpoints — environments only).'
                    : undefined);

            const system = await this.systemManager.addSystem({
                name,
                description,
                treeTrimPrefix: trim || undefined,
                createdAt: Date.now()
            });
            createdSystems.push(system);

            for (const endpoint of component.endpoints) {
                await this.endpointManager.updateEndpoint(endpoint.id, { systemId: system.id }, true);
                endpointsAssigned++;
            }
            for (const env of component.environments) {
                await this.environmentManager.updateEnvironment(env.id, { systemId: system.id });
                environmentsAssigned++;
            }
        }

        return {
            ran: true,
            systemsCreated: createdSystems.length,
            endpointsAssigned,
            environmentsAssigned
        };
    }

    private async collectExecutionPairs(
        endpoints: APIEndpointConfig[],
        environments: EnvironmentConfig[]
    ): Promise<ExecutionPair[]> {
        const validEndpointIds = new Set(endpoints.map(e => e.id));
        const validEnvironmentIds = new Set(environments.map(e => e.id));
        const envIdByName = new Map(environments.map(e => [e.name, e.id]));

        const pairs: ExecutionPair[] = [];
        try {
            const all = await this.executionStorage.getAllTransactions();
            for (const exec of all) {
                if (!validEndpointIds.has(exec.endpointId)) continue;

                // environmentId is the authoritative pointer, but older records may only carry environment name.
                let envId = exec.environmentId;
                if (!envId || !validEnvironmentIds.has(envId)) {
                    envId = envIdByName.get(exec.environment);
                }
                if (!envId || !validEnvironmentIds.has(envId)) continue;

                pairs.push({ endpointId: exec.endpointId, environmentId: envId });
            }
        } catch {
            // Execution storage may not be available (fresh install with no DB yet) — that's fine.
        }
        return pairs;
    }
}

interface ExecutionPair {
    endpointId: string;
    environmentId: string;
}

export interface SystemCluster {
    endpoints: APIEndpointConfig[];
    environments: EnvironmentConfig[];
    /**
     * True when this cluster is the catch-all for nodes the execution history
     * couldn't connect (fresh endpoints, unused environments, etc.). Always
     * named "Unknown" instead of the path-prefix heuristic.
     */
    isOrphanBucket?: boolean;
}

/**
 * Pure clustering algorithm. Exposed for tests.
 */
export function clusterByExecutionPairs(
    endpoints: APIEndpointConfig[],
    environments: EnvironmentConfig[],
    pairs: ExecutionPair[]
): SystemCluster[] {
    // Union-Find over a combined key space: endpoints prefixed "e:", environments prefixed "v:".
    const parent = new Map<string, string>();
    const rank = new Map<string, number>();

    const key = (kind: 'e' | 'v', id: string) => `${kind}:${id}`;

    const make = (k: string) => {
        if (!parent.has(k)) {
            parent.set(k, k);
            rank.set(k, 0);
        }
    };
    const find = (k: string): string => {
        let root = k;
        while (parent.get(root) !== root) root = parent.get(root)!;
        // path compression
        let cur = k;
        while (parent.get(cur) !== root) {
            const next = parent.get(cur)!;
            parent.set(cur, root);
            cur = next;
        }
        return root;
    };
    const union = (a: string, b: string) => {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        const rankA = rank.get(ra)!;
        const rankB = rank.get(rb)!;
        if (rankA < rankB) parent.set(ra, rb);
        else if (rankA > rankB) parent.set(rb, ra);
        else {
            parent.set(rb, ra);
            rank.set(ra, rankA + 1);
        }
    };

    for (const e of endpoints) make(key('e', e.id));
    for (const v of environments) make(key('v', v.id));
    for (const p of pairs) {
        const ek = key('e', p.endpointId);
        const vk = key('v', p.environmentId);
        if (parent.has(ek) && parent.has(vk)) union(ek, vk);
    }

    // Group nodes by root.
    const groups = new Map<string, SystemCluster>();
    const ensure = (root: string): SystemCluster => {
        let g = groups.get(root);
        if (!g) {
            g = { endpoints: [], environments: [] };
            groups.set(root, g);
        }
        return g;
    };

    for (const e of endpoints) ensure(find(key('e', e.id))).endpoints.push(e);
    for (const v of environments) ensure(find(key('v', v.id))).environments.push(v);

    // A cluster is "significant" if execution history connected at least one endpoint and one
    // environment — i.e. real usage. Everything else (fresh endpoints, unused environments,
    // singletons that never met each other) lands in one "Unknown" bucket. This avoids a
    // graveyard of one-node Systems on first migration AND gives the catch-all a clear,
    // honest label rather than yet another numbered System.
    const significant: SystemCluster[] = [];
    const orphans: SystemCluster = { endpoints: [], environments: [], isOrphanBucket: true };
    for (const cluster of groups.values()) {
        if (cluster.endpoints.length > 0 && cluster.environments.length > 0) {
            significant.push(cluster);
        } else {
            orphans.endpoints.push(...cluster.endpoints);
            orphans.environments.push(...cluster.environments);
        }
    }

    // If no significant clusters were found, everything lands in one bucket.
    if (significant.length === 0) {
        return [orphans];
    }

    if (orphans.endpoints.length > 0 || orphans.environments.length > 0) {
        significant.push(orphans);
    }
    return significant;
}

/**
 * Derive a humanish System name from a cluster.
 *
 * Tries three signals in order of how reliably they encode "what platform is this":
 *   1. **Environment hostnames** — apex domain from each `baseUrl`. If most envs in the
 *      cluster share the same apex (e.g. `example.com`), use the second-level
 *      label ("example"). Strongest signal — domains rarely lie about identity.
 *   2. **Environment name tokens** — split each name on whitespace/dash/underscore,
 *      drop stopwords ("prod", "staging", "cust", numbers, etc.), find the most
 *      common surviving token. Catches cases like "ACMEWMS Cust1 Staging" → "ACMEWMS".
 *   3. **Endpoint path prefix** — original heuristic. The first non-generic
 *      segment of the longest common path prefix (skip `api`, `v1` etc.).
 *
 * Falls back to "System N" only when all three signals come back empty.
 *
 * Exported for direct unit testing.
 */
export function pickSystemNameFromCluster(
    endpoints: APIEndpointConfig[],
    environments: EnvironmentConfig[],
    fallbackIndex: number
): string {
    const fromHost = pickFromEnvironmentHosts(environments);
    if (fromHost) return normaliseToShortName(fromHost);

    const fromName = pickFromEnvironmentNames(environments);
    if (fromName) return normaliseToShortName(fromName);

    const fromPath = pickFromPathPrefix(endpoints);
    if (fromPath) return normaliseToShortName(fromPath);

    // No usable signal — produce a conforming fallback like "sysa", "sysb"…
    return `sys${indexToLetterCode(fallbackIndex - 1)}`;
}

/**
 * Strip everything that wouldn't pass `validateShortIdentifier` so the
 * migration's auto-generated names conform to the user-facing rules:
 * lowercase, letters+digits only, max 16 chars.
 *
 * If everything is stripped (e.g. a host like "127.0.0.1" after we drop
 * the dots), the empty result is replaced with a single-letter placeholder
 * so the caller never sees `""`.
 */
function normaliseToShortName(raw: string): string {
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (cleaned.length === 0) return 'a';
    return cleaned.slice(0, 16);
}

/**
 * Encode a non-negative integer as a base-26 lowercase string:
 *   0 → "a", 1 → "b", … 25 → "z", 26 → "aa", 27 → "ab", …
 */
function indexToLetterCode(n: number): string {
    let out = '';
    let i = n + 1; // 1-based so the wrap-around works cleanly
    while (i > 0) {
        i--;
        out = String.fromCharCode(97 + (i % 26)) + out;
        i = Math.floor(i / 26);
    }
    return out;
}

const ENV_NAME_STOPWORDS = new Set([
    'prod', 'production', 'staging', 'stage', 'dev', 'development',
    'test', 'testing', 'qa', 'uat', 'sandbox', 'local', 'integration',
    'int', 'perf', 'performance', 'training', 'train', 'cust', 'customer',
    'env', 'environment', 'api', 'system', 'the', 'and', 'of', 'for',
    'demo', 'preview'
]);

const PATH_STOPWORDS = new Set([
    'api', 'rest', 'http', 'https', 'gateway', 'service', 'services',
    'v1', 'v2', 'v3', 'v4'
]);

function pickFromEnvironmentHosts(environments: EnvironmentConfig[]): string | undefined {
    const labels = environments
        .map(e => apexLabelFromBaseUrl(e.baseUrl))
        .filter((s): s is string => !!s);
    if (labels.length === 0) return undefined;
    return mostCommonValue(labels, strictMajority(environments.length));
}

function pickFromEnvironmentNames(environments: EnvironmentConfig[]): string | undefined {
    if (environments.length === 0) return undefined;

    // For each env, tokenise once and dedupe so a single env can't dominate by repetition.
    const perEnvTokens: string[][] = environments.map(e =>
        Array.from(new Set(tokeniseEnvName(e.name)))
    );

    const counts = new Map<string, number>();
    for (const tokens of perEnvTokens) {
        for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    }

    const threshold = strictMajority(environments.length);
    let bestToken: string | undefined;
    let bestCount = 0;
    for (const [token, count] of counts) {
        if (count >= threshold && count > bestCount) {
            bestToken = token;
            bestCount = count;
        }
    }
    return bestToken;
}

/**
 * Threshold for "enough envs in the cluster agree on a signal to trust it".
 * Strict majority — for 2 envs both must agree; for 3+ envs more than half.
 * For a single env the value is itself the consensus.
 */
function strictMajority(n: number): number {
    if (n <= 1) return 1;
    return Math.floor(n / 2) + 1;
}

function pickFromPathPrefix(endpoints: APIEndpointConfig[]): string | undefined {
    if (endpoints.length === 0) return undefined;

    // First attempt: longest common prefix — preferred because it represents
    // shared truth across the cluster (e.g. all endpoints under /dcinventory/).
    const prefix = longestCommonPathPrefix(endpoints.map(e => e.path));
    if (prefix) {
        const segs = prefix.split('/').filter(Boolean);
        for (const seg of segs) {
            if (isMeaningfulPathSegment(seg)) return seg;
        }
    }

    // Fallback: tally every meaningful segment across every path and return
    // the most common. Catches the single-endpoint case (where the LCP
    // helpfully strips the trailing segment so we lose the only signal) and
    // also rescues clusters whose paths share nothing at the front.
    const counts = new Map<string, number>();
    for (const endpoint of endpoints) {
        const segs = endpoint.path.split('/').filter(Boolean);
        for (const seg of segs) {
            if (isMeaningfulPathSegment(seg)) {
                counts.set(seg, (counts.get(seg) ?? 0) + 1);
            }
        }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [seg, count] of counts) {
        if (count > bestCount) {
            best = seg;
            bestCount = count;
        }
    }
    return best;
}

function isMeaningfulPathSegment(seg: string): boolean {
    const lower = seg.toLowerCase();
    if (PATH_STOPWORDS.has(lower)) return false;
    if (/^v\d+(\.\d+)*$/i.test(seg)) return false;       // v1, v2, v1.1, etc.
    if (/^\d+$/.test(seg)) return false;                 // pure numbers
    return true;
}

/**
 * Extract the second-level label of the hostname (e.g. "example" from
 * "cust1-staging.example.com", "dbmn" from "api.dbmn.io"). Returns undefined
 * for IPs, localhost, and unparseable inputs.
 */
function apexLabelFromBaseUrl(baseUrl?: string): string | undefined {
    if (!baseUrl) return undefined;
    let host: string;
    try {
        const u = new URL(baseUrl.includes('://') ? baseUrl : `https://${baseUrl}`);
        host = u.hostname;
    } catch {
        return undefined;
    }
    if (!host) return undefined;
    if (host === 'localhost') return undefined;
    if (/^[\d.]+$/.test(host)) return undefined; // IPv4

    const parts = host.split('.').filter(Boolean);
    if (parts.length === 0) return undefined;
    if (parts.length === 1) return parts[0];
    return parts[parts.length - 2];
}

function tokeniseEnvName(name: string): string[] {
    return name
        .split(/[\s\-_/]+/)
        .map(t => t.trim())
        .filter(t => t.length > 1)
        .filter(t => !/^\d+$/.test(t))
        .filter(t => !ENV_NAME_STOPWORDS.has(t.toLowerCase()));
}

function mostCommonValue(values: string[], minCount: number): string | undefined {
    if (values.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: string | undefined;
    let bestCount = 0;
    for (const [v, count] of counts) {
        if (count >= minCount && count > bestCount) {
            best = v;
            bestCount = count;
        }
    }
    return best;
}

