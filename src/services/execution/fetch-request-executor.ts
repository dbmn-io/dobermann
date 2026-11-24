// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #322: sends an endpoint request with the global `fetch`. Lifted unchanged from
 * `Dobermann.executeEndpoint`, which now delegates here; everything host-specific (environment
 * lookup, tokens) comes in as a dependency.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import { flattenHeaders, flattenQueryParams } from '../../utils/jwt-validation';
import { stripJsonCommentsSafe } from '../../utils/json-comment-stripper';
import { parseResponseBody, readResponseText } from './response-body';
import { fillBaseUrl } from '../../utils/environment-url';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import {
    EndpointExecutionOptions,
    EndpointResponse,
    IRequestExecutor,
    RequestEnvironmentLookup,
    RequestTokenProvider
} from './request-executor.interface';

export interface FetchRequestExecutorDependencies {
    environments: RequestEnvironmentLookup;
    getToken: RequestTokenProvider;
    /**
     * Dobermann issue 7: the token each request is sent with, whatever the sign-in (OAuth, the
     * DBMN account, a service account, a pasted token), told to the app's log so it is never written.
     */
    secretSink?: (value: string) => void;
    logger: IExtensionDiagnosticLogger;
    /** #392: how the request is sent, when not by the global `fetch` (the desktop app: its main process, no CORS). */
    fetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export class FetchRequestExecutor implements IRequestExecutor {
    constructor(private readonly dependencies: FetchRequestExecutorDependencies) {}

    async executeEndpoint(
        endpointConfig: APIEndpointConfig,
        abortSignal?: AbortSignal,
        environmentId?: string,
        options?: EndpointExecutionOptions
    ): Promise<EndpointResponse> {
        const { environments, logger } = this.dependencies;

        // Use provided environmentId or fall back to active environment
        const activeEnvironment = environmentId
            ? await environments.getEnvironment(environmentId)
            : await environments.getActiveEnvironment();

        // GitHub Issue #160: CRITICAL - If environmentId was provided but lookup failed,
        // DO NOT fall back to active environment. Stop execution immediately.
        if (environmentId && !activeEnvironment) {
            const errorMessage = `CRITICAL: Environment '${environmentId}' not found. Execution STOPPED.`;
            logger.error(`[Dobermann.executeEndpoint] issue#160 ${errorMessage}`);
            throw new Error(errorMessage);
        }

        // Issue #126: Handle different authentication methods
        const token = await this.dependencies.getToken(activeEnvironment, environmentId, options);
        if (token) this.dependencies.secretSink?.(token);

        // Issue #113/#126: Check if authentication is required
        const requiresAuth = activeEnvironment?.authMethod !== 'none';

        if (requiresAuth && !token && !options?.isBatchMember) {
            throw new Error('No authentication token available. Please authenticate first.');
        }

        if (!activeEnvironment?.baseUrl) {
            throw new Error('No base URL configured for environment. Please set base URL in environment settings.');
        }
        // #424: a batch member goes to its batch's base URL; otherwise the environment's, a variable
        // in its path filled (a name with no value stays as typed)
        const baseUrl = options?.baseUrl || fillBaseUrl(activeEnvironment.baseUrl, activeEnvironment.variables);

        const fullUrl = `${baseUrl}${endpointConfig.path}`;
        const startTime = Date.now();

        try {
            // Flatten headers to simple key-value pairs, filtering out disabled headers
            const flatHeaders = flattenHeaders(endpointConfig.headers);

            // Flatten query params to simple key-value pairs, filtering out disabled params (GitHub Issue #101)
            const flatQueryParams = flattenQueryParams(endpointConfig.queryParams || {});

            // Every method sends its enabled query parameters (a POST's too: an API may page a POST
            // search by its query, and the run's record has always said they were sent): after a `?`,
            // or after an `&` when the path already has a query of its own (`/orders?status=open`);
            // none, and the URL is left as it is. (Only GET sent them, so a POST's were quietly dropped.)
            const query = new URLSearchParams(flatQueryParams).toString();
            const url = query ? `${fullUrl}${fullUrl.includes('?') ? '&' : '?'}${query}` : fullUrl;

            // Issue #113/#126: Only include Authorization header if auth is required
            const headers: Record<string, string> = {
                'Content-Type': 'application/json',
                ...flatHeaders
            };

            // Add Authorization header only when authentication is required
            if (requiresAuth && token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            // #323: Cancel aborts the request in flight (the Fetch standard's AbortSignal): fetch,
            // and reading the body, reject with an AbortError
            const requestInit: RequestInit = {
                method: endpointConfig.method,
                headers: headers,
                signal: abortSignal
            };

            if ((endpointConfig.method === 'POST' || endpointConfig.method === 'PUT' || endpointConfig.method === 'PATCH') && endpointConfig.body) {
                // Strip comments before parsing to support JSONC in templates
                const cleanBody = stripJsonCommentsSafe(endpointConfig.body);
                requestInit.body = JSON.stringify(JSON.parse(cleanBody));
            }

            const response = await (this.dependencies.fetch ?? fetch)(url, requestInit);
            const endTime = Date.now();
            const duration = endTime - startTime;

            // Read once as text, then decide what it is: JSON, JSON Lines (#115) or text.
            // A JSON content type with a body that isn't JSON keeps the body instead of throwing.
            const { data, format } = parseResponseBody(await readResponseText(response, options?.onBodyProgress), response.headers.get('content-type'), url);
            if (format?.invalidCount) {
                logger.warn(`[FetchRequestExecutor] JSONL response: ${format.invalidCount} line(s) are not JSON (first: line ${format.invalid[0]?.line})`);
            }

            return {
                success: true,
                status: response.status,
                statusText: response.statusText,
                data: data,
                duration,
                headers: Object.fromEntries(response.headers.entries()),
                url,
                ...(format ? { format } : {})
            };

        } catch (error) {
            // #335: Cancel aborted it: the caller records it as cancelled, not as a failed request
            if (error instanceof Error && error.name === 'AbortError') throw error;
            const endTime = Date.now();
            const duration = endTime - startTime;
            let errorMessage = 'Unknown error';
            let errorData: unknown = null;
            let statusCode: number | undefined;

            if (error instanceof TypeError && error.message.includes('fetch')) {
                // Network error
                errorMessage = `Network error: ${error.message}`;
            } else if (error instanceof Error) {
                errorMessage = error.message;
                // If it's a Response object (failed HTTP status)
                if ('status' in error) {
                    const failed = error as Error & { status: number; statusText: string; json(): Promise<unknown>; text(): Promise<string> };
                    statusCode = failed.status;
                    errorMessage = `${statusCode} ${failed.statusText}`;
                    try {
                        errorData = await failed.json();
                    } catch {
                        errorData = await failed.text();
                    }
                }
            }

            return {
                success: false,
                status: statusCode,
                statusText: errorMessage,
                data: errorData,
                duration,
                error: errorMessage,
                url: `${baseUrl}${endpointConfig.path}`
            };
        }
    }
}
