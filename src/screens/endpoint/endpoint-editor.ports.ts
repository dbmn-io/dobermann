// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * What the endpoint editor needs from its host. VS Code supplies APIEndpointManager,
 * EnvironmentManager, the execution engine and the file system; the web app supplies the
 * Supabase catalogue and the browser.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { TestConfig } from '../../data-loading/javascript-test-runner';
import type { EnvironmentConfig } from '../../environmentManager';
import type { SystemRecords } from '../environment/environment-editor.ports';

export interface EndpointRecords {
    getEndpoint(id: string): Promise<APIEndpointConfig | undefined>;
    addEndpoint(config: Partial<APIEndpointConfig>): Promise<APIEndpointConfig>;
    updateEndpoint(id: string, updates: Partial<APIEndpointConfig>): Promise<APIEndpointConfig>;
    deleteEndpoint(id: string): Promise<boolean>;
    /** #432: every endpoint, for the tags already in use (suggested as a tag is typed). */
    getAllEndpoints?(): Promise<APIEndpointConfig[]>;
}

/** The active environment, as the endpoint editor sees it. */
export interface ActiveEnvironment {
    getActiveEnvironment(): Promise<EnvironmentConfig | undefined>;
    getEnvironmentToken(id: string): Promise<string | undefined>;
    /** The selected environment, or one of them, changed: an open editor re-reads it. */
    onEnvironmentsChanged?(listener: () => void): { dispose(): void };
}

export interface TestPreviewSample {
    response: { status: number; headers: Record<string, string>; body: string };
    request: { method: string; url: string; headers: Record<string, string>; body: string };
    csvRow: Record<string, string>;
}

/** Response test scripts run in a sandbox only some hosts have. */
export interface TestScripts {
    validate(script: string): { isValid: boolean; error?: string };
    preview(tests: TestConfig[], sample: TestPreviewSample): Promise<Array<{ testName: string; success: boolean; error?: string }>>;
}

export interface EndpointEditorPorts {
    endpoints: EndpointRecords;
    environments: ActiveEnvironment;
    systems?: SystemRecords;
    confirmDestructive(opts: { title?: string; body: string; confirmLabel?: string }): Promise<boolean>;
    toast: { info(message: string): void; warn(message: string): void; error(message: string): void };
    readClipboard(): Promise<string>;
    /** Run API: one call, results in the Console. */
    runApi(endpoint: APIEndpointConfig): Promise<void>;
    openRunBatch(endpoint: APIEndpointConfig): Promise<void>;
    /** GitHub Issue #165: open the environment editor with these variables to fill in. */
    openEnvironmentWithVariables(environmentId: string, variables: string[]): Promise<void>;
    countTransactions?(endpointId: string): Promise<number>;
    tests?: TestScripts;
    /** Save bytes as a file the user picks; the saved file's name, or undefined if cancelled. */
    saveFile(suggestedName: string, bytes: Uint8Array, filters: Record<string, string[]>): Promise<string | undefined>;
    host: {
        maximize?(): void;
        close(): void;
        saved?(endpoint: APIEndpointConfig, wasNew: boolean): void;
        saveFailed?(): void;
    };
}
