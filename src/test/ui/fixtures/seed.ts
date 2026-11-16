// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Default in-memory state for the fake VS Code host used by the webview UI
 * tests. Built from the existing vscode-free mocha fixtures so the two test
 * layers describe the same world, then augmented with the fields the Hub
 * renders that the older fixtures never needed (Systems, organisations,
 * environment types).
 *
 * Every value is fixed — no Date.now() — so screenshots are reproducible.
 */
import type { APIEndpointConfig } from '../../../data-loading/types';
import {
    mockEndpointConfig,
    mockEndpointConfigMinimal,
    mockEndpointConfigWithValidation
} from '../../fixtures/execution/mock-endpoints';
import {
    mockEnvironmentDev,
    mockEnvironmentTest,
    mockEnvironmentMock,
    mockEnvironmentProd
} from '../../fixtures/execution/mock-environments';

export interface SeedSystem {
    id: string;
    name: string;
    description?: string;
    createdAt: number;
}

/** Mirrors EnvironmentConfig (src/environmentManager.ts). Declared here
 *  rather than imported because environmentManager.ts imports `vscode`. */
export interface SeedEnvironment {
    id: string;
    name: string;
    description?: string;
    baseUrl?: string;
    isActive: boolean;
    createdAt: number;
    lastUsed?: number;
    folder?: string;
    systemId?: string;
    environmentType?: 'production' | 'staging' | 'development' | 'test' | 'other';
    /** #424: set to override what the fake host derives from variableSettings for the header. */
    headerVariables?: Array<{ name: string; value: string; options: string[] }>;
    headers?: Record<string, unknown>;
    variables?: Record<string, string>;
    variableSettings?: Record<string, { options?: string[]; showInHeader?: boolean }>;
    parallelProcessing?: { enabled: boolean; maxConcurrency: 1 | 2 | 4 | 8 | 16 };
    authMethod?: string;
}

export type SeedEndpoint = APIEndpointConfig & { systemId?: string; tags?: string[] };

export interface SeedDbmnSettings {
    autoOpenConsoleOnCompletion: boolean;
    treatNetworkErrorsAsCritical: boolean;
    criticalErrorCodes: number[];
    maxCsvRows: number;
    confirmTransactionDeletion: boolean;
}

export interface Seed {
    endpoints: SeedEndpoint[];
    systems: SeedSystem[];
    environments: SeedEnvironment[];
    transactions: unknown[];
    /** MRU touches for the catalogue's Recent section ({ id, touchedAt }). */
    recentEndpoints: { id: string; touchedAt: number }[];
    /** Host-side mirror of the Hub webview's UI preferences (globalState). */
    hubPreferences: Record<string, unknown>;
    dbmnSettings: SeedDbmnSettings;
    workspaceInfo: { workspacePath?: string; executionsDbPath?: string };
    isSignedIn: boolean;
    /** Signed in, but the DBMN session can no longer refresh (Issue #396). */
    dbmnSessionExpired?: boolean;
    /** The previous session's tabs, which Home offers to re-open (Issue #348). */
    previousTabs: { type: 'endpoint' | 'environment' | 'page'; refId: string; name: string }[];
    /** hub-manager's summariseChangelog() result for Home's "New in" card. */
    whatsNew: unknown;
}

/** 2026-01-15T09:00:00Z — a fixed "creation" instant for every record. */
export const SEED_T0 = Date.UTC(2026, 0, 15, 9, 0, 0);

export const SYSTEM_ACMEWMS: SeedSystem = { id: 'sys-acmewms', name: 'acmewms', description: 'Warehouse', createdAt: SEED_T0 };
export const SYSTEM_DBMN: SeedSystem = { id: 'sys-dbmn', name: 'dbmn', description: 'Internal', createdAt: SEED_T0 };

const WORKSPACE = '/home/tester/dbmn-workspace';

function environment(
    base: { id: string; name: string; baseUrl: string; active: boolean; description?: string },
    extra: Partial<SeedEnvironment>
): SeedEnvironment {
    return {
        id: base.id,
        name: base.name,
        description: base.description,
        baseUrl: base.baseUrl,
        isActive: base.active,
        createdAt: SEED_T0,
        ...extra
    };
}

export const defaultSeed: Seed = {
    systems: [SYSTEM_ACMEWMS, SYSTEM_DBMN],
    endpoints: [
        { ...mockEndpointConfig, systemId: SYSTEM_ACMEWMS.id, tags: ['orders', 'smoke'] },
        { ...mockEndpointConfigMinimal, systemId: SYSTEM_ACMEWMS.id, tags: ['smoke'] },
        { ...mockEndpointConfigWithValidation, systemId: SYSTEM_DBMN.id, tags: [] }
    ],
    environments: [
        environment(mockEnvironmentDev, {
            systemId: SYSTEM_ACMEWMS.id,
            environmentType: 'development',
            // #424: the org is an ordinary variable, with options and a place in the header
            variables: { org: 'acme' },
            variableSettings: { org: { options: ['acme', 'globex'], showInHeader: true } }
        }),
        environment(mockEnvironmentTest, {
            systemId: SYSTEM_ACMEWMS.id,
            environmentType: 'test',
            variableSettings: { org: { options: ['acme'], showInHeader: true } }
        }),
        environment(mockEnvironmentMock, {
            systemId: SYSTEM_DBMN.id,
            environmentType: 'other'
        }),
        environment(mockEnvironmentProd, {
            systemId: SYSTEM_ACMEWMS.id,
            environmentType: 'production',
            variableSettings: { org: { options: ['acme', 'globex', 'initech'], showInHeader: true } }
        })
    ],
    transactions: [],
    recentEndpoints: [],
    hubPreferences: {},
    dbmnSettings: {
        autoOpenConsoleOnCompletion: true,
        treatNetworkErrorsAsCritical: true,
        criticalErrorCodes: [401, 403],
        maxCsvRows: 100000,
        confirmTransactionDeletion: true
    },
    workspaceInfo: {
        workspacePath: WORKSPACE,
        executionsDbPath: `${WORKSPACE}/.dbmn/executions.db`
    },
    isSignedIn: false,
    previousTabs: [],
    whatsNew: null
};

/** Deep-copies the default seed so a test can mutate it freely. */
export function makeSeed(overrides: Partial<Seed> = {}): Seed {
    return { ...JSON.parse(JSON.stringify(defaultSeed)) as Seed, ...overrides };
}
