// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #322: the execution port — send one endpoint request in an environment. `ExecutionService`
 * calls this; it never needs `Dobermann`. `FetchRequestExecutor` is the portable implementation.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { BodyProgressListener, ResponseFormat } from './response-body';

export interface EndpointExecutionOptions {
    /** Batch members never prompt for sign-in; a missing token runs on to a 401 the engine handles. */
    isBatchMember?: boolean;
    /** The execution this request belongs to (#344: its Console shows when it waits for VS Code). */
    executionId?: string;
    /** Hears the body arrive (#115). A function, so it never crosses to the local agent. */
    onBodyProgress?: BodyProgressListener;
    /**
     * #424: the base URL to send to, its variables already filled. A batch member's is the
     * batch's, kept when it started (#160: changing a variable, or the URL's path, mid-batch never
     * moves the batch). Left out, the environment's own, filled from its variables now.
     */
    baseUrl?: string;
}

/** What one request came back with. `success` means "a response arrived", not "2xx". */
export interface EndpointResponse {
    success: boolean;
    status?: number;
    statusText: string;
    data: unknown;
    duration: number;
    headers?: Record<string, string>;
    url: string;
    error?: string;
    /** Set when the body is not plain JSON or text, e.g. JSON Lines (#115). */
    format?: ResponseFormat;
}

export interface IRequestExecutor {
    executeEndpoint(
        endpoint: APIEndpointConfig,
        abortSignal?: AbortSignal,
        environmentId?: string,
        options?: EndpointExecutionOptions
    ): Promise<EndpointResponse>;
}

/** The parts of an environment a request needs. */
export interface RequestEnvironment {
    id: string;
    name: string;
    baseUrl?: string;
    authMethod?: string;
    variables?: Record<string, string>;
}

export interface RequestEnvironmentLookup {
    getEnvironment(id: string): Promise<RequestEnvironment | undefined>;
    getActiveEnvironment(): Promise<RequestEnvironment | undefined>;
}

/**
 * The bearer token for a request, by the environment's auth method; undefined when there is none.
 * May throw to stop the request (sign-in refused, service-account failure). The VS Code shell
 * implements it over the vault and DBMN auth (`Dobermann.acquireRequestToken`); see #327.
 */
export type RequestTokenProvider = (
    environment: RequestEnvironment | undefined,
    environmentId: string | undefined,
    options: EndpointExecutionOptions | undefined
) => Promise<string | undefined>;
