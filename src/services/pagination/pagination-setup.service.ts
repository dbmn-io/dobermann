// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Pagination Setup Service (GitHub Issue #198)
 *
 * Provides guided pagination configuration from Console:
 * 1. Auto-detect total count candidates from API response
 * 2. Auto-detect page size from query params or response
 * 3. Save pagination config ({{A8:PAGE:X:path}}) to endpoint
 */

import { APIEndpointConfig } from '../../data-loading/types';
import { PaginationDetectorService } from './pagination-detector.service';

export interface PaginationCandidate {
    path: string;       // e.g. "header.totalCount"
    value: number;      // e.g. 7000
    label: string;      // e.g. "header.totalCount = 7000"
}

export interface PaginationSetupConfig {
    location?: 'query' | 'body'; // GitHub Issue #245: where the templates live (default 'query')
    paramKey: string;       // Query param name for page number (e.g. "page")
    startValue: number;     // 0 or 1
    totalCountPath?: string; // Optional JSON path to total count
    pageSize?: number;       // Detected or user-entered page size
    sizeParamKey?: string;   // Query param name for page size (e.g. "size")
    sizeValue?: number;      // Page size value (e.g. 100)
    sizePath?: string;       // Optional response field path for page size (e.g. "header.pageSize")
}

export class PaginationSetupService {

    /**
     * Walk response recursively and find fields that look like total count values.
     * Matches common field names: totalCount, total, totalRecords, recordCount, count,
     * totalElements, totalItems, numberOfElements
     */
    detectPaginationCandidates(response: object): PaginationCandidate[] {
        const candidates: PaginationCandidate[] = [];
        const targetNames = new Set([
            'totalcount', 'total', 'totalrecords', 'recordcount',
            'count', 'totalelements', 'totalitems', 'numberofelements',
            'totalpages', 'numberofpages'
        ]);

        const walk = (obj: Record<string, unknown>, prefix: string) => {
            if (!obj || typeof obj !== 'object') {
                return;
            }

            for (const [key, value] of Object.entries(obj)) {
                const currentPath = prefix ? `${prefix}.${key}` : key;

                // Detect numeric values — including string numbers (some APIs return totalCount as "25")
                let numericValue: number | undefined;
                if (typeof value === 'number' && !isNaN(value)) {
                    numericValue = value;
                } else if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
                    numericValue = Number(value);
                }

                if (numericValue !== undefined && numericValue >= 0 && targetNames.has(key.toLowerCase())) {
                    candidates.push({
                        path: currentPath,
                        value: numericValue,
                        label: `${currentPath} = ${numericValue}`
                    });
                } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                    walk(value as Record<string, unknown>, currentPath);
                }
            }
        };

        walk(response as Record<string, unknown>, '');
        return candidates;
    }

    /**
     * Walk response recursively (skipping arrays) and return ALL numeric fields,
     * partitioned into suggested (known pagination field names) and other.
     * Used by the JSON tree selector to highlight likely total count fields.
     */
    findAllNumericPaths(response: object): {
        suggestedFields: PaginationCandidate[];
        otherNumericFields: PaginationCandidate[];
    } {
        const suggestedFields: PaginationCandidate[] = [];
        const otherNumericFields: PaginationCandidate[] = [];
        const targetNames = new Set([
            'totalcount', 'total', 'totalrecords', 'recordcount',
            'count', 'totalelements', 'totalitems', 'numberofelements',
            'totalpages', 'numberofpages'
        ]);

        const walk = (obj: Record<string, unknown>, prefix: string) => {
            if (!obj || typeof obj !== 'object') {
                return;
            }

            for (const [key, value] of Object.entries(obj)) {
                const currentPath = prefix ? `${prefix}.${key}` : key;

                // Detect numeric values — including string numbers (some APIs return totalCount as "25")
                let numericValue: number | undefined;
                if (typeof value === 'number' && !isNaN(value)) {
                    numericValue = value;
                } else if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) {
                    numericValue = Number(value);
                }

                if (numericValue !== undefined) {
                    const candidate: PaginationCandidate = {
                        path: currentPath,
                        value: numericValue,
                        label: `${currentPath} = ${numericValue}`
                    };
                    if (numericValue >= 0 && targetNames.has(key.toLowerCase())) {
                        suggestedFields.push(candidate);
                    } else {
                        otherNumericFields.push(candidate);
                    }
                } else if (value && typeof value === 'object' && !Array.isArray(value)) {
                    walk(value as Record<string, unknown>, currentPath);
                }
            }
        };

        walk(response as Record<string, unknown>, '');
        return { suggestedFields, otherNumericFields };
    }

    /**
     * Detect page size from query params or response body.
     * Reuses the same logic as PaginationDetectorService.
     */
    detectPageSize(queryParams: Record<string, string | { value?: string; enabled?: boolean }>, response?: object): number | undefined {
        const detector = new PaginationDetectorService();

        // Try query params first
        const fromParams = detector.extractPageSize(queryParams || {});
        if (fromParams) {
            return fromParams;
        }

        // Fall back to response body
        if (response) {
            return detector.extractPageSizeFromResponse(response);
        }

        return undefined;
    }

    /**
     * Build the {{A8:PAGE:startValue:totalCountPath}} template string
     */
    buildPaginationTemplate(startValue: number, totalCountPath?: string): string {
        if (totalCountPath) {
            return `{{A8:PAGE:${startValue}:${totalCountPath}}}`;
        }
        return `{{A8:PAGE:${startValue}}}`;
    }

    /**
     * Build the {{A8:SIZE:value}} or {{A8:SIZE:value:sizePath}} template string
     */
    buildSizeTemplate(value: number, sizePath?: string): string {
        if (sizePath) {
            return `{{A8:SIZE:${value}:${sizePath}}}`;
        }
        return `{{A8:SIZE:${value}}}`;
    }

    /**
     * Save pagination config to an endpoint's query params.
     * Updates the specified paramKey's value to the {{A8:PAGE:...}} template.
     *
     * @param endpointManager - The APIEndpointManager instance
     * @param endpointId - Endpoint to update
     * @param config - Pagination configuration
     */
    async savePaginationConfig(
        endpointManager: { updateEndpoint: (id: string, updates: Partial<APIEndpointConfig>) => Promise<APIEndpointConfig>; getEndpoint?: (id: string) => Promise<APIEndpointConfig | undefined> },
        endpointId: string,
        config: PaginationSetupConfig
    ): Promise<void> {
        // Get current endpoint to preserve existing query params
        let currentEndpoint: APIEndpointConfig | undefined;
        if (endpointManager.getEndpoint) {
            currentEndpoint = await endpointManager.getEndpoint(endpointId);
        }

        // GitHub Issue #245: pagination templates live in the body — rewrite the
        // body's {{A8:PAGE...}} / {{A8:SIZE...}} in place (adds the total-count
        // path the user picked) instead of touching query params.
        if (config.location === 'body') {
            return this.savePaginationConfigToBody(endpointManager, currentEndpoint, endpointId, config);
        }

        const template = this.buildPaginationTemplate(config.startValue, config.totalCountPath);

        // Build updated query params - set the page param to the template string value
        // Use Record<string, string> (legacy format) which is always accepted
        const existingParams = currentEndpoint?.queryParams || {};
        const updatedQueryParams: Record<string, string> = {};

        // Flatten existing params to string format
        for (const [key, value] of Object.entries(existingParams)) {
            if (typeof value === 'string') {
                updatedQueryParams[key] = value;
            } else if (value && typeof value === 'object' && 'value' in value) {
                updatedQueryParams[key] = (value as { value: string }).value;
            }
        }

        updatedQueryParams[config.paramKey] = template;

        // Save size template if provided
        if (config.sizeParamKey && config.sizeValue && config.sizeValue > 0) {
            const sizeTemplate = this.buildSizeTemplate(config.sizeValue, config.sizePath);
            updatedQueryParams[config.sizeParamKey] = sizeTemplate;
        }

        await endpointManager.updateEndpoint(endpointId, {
            queryParams: updatedQueryParams
        });
    }

    /**
     * GitHub Issue #245: Save pagination config into the request body.
     * Rewrites the existing {{A8:PAGE...}} / {{A8:SIZE...}} templates in place so
     * the user's body shape is preserved — typically adding the chosen
     * total-count path to a basic {{A8:PAGE:0}} so Fetch All becomes available.
     * Both `body` and `bodyWithComments` are updated so the editor stays in sync.
     */
    private async savePaginationConfigToBody(
        endpointManager: { updateEndpoint: (id: string, updates: Partial<APIEndpointConfig>) => Promise<APIEndpointConfig> },
        currentEndpoint: APIEndpointConfig | undefined,
        endpointId: string,
        config: PaginationSetupConfig
    ): Promise<void> {
        const pageTemplate = this.buildPaginationTemplate(config.startValue, config.totalCountPath);
        const sizeTemplate = (config.sizeValue && config.sizeValue > 0)
            ? this.buildSizeTemplate(config.sizeValue, config.sizePath)
            : null;

        const rewrite = (text: string | undefined): string | undefined => {
            if (typeof text !== 'string' || text === '') {
                return text;
            }
            let out = text.replace(/\{\{A8:PAGE(?::[^}]*)?\}\}/g, pageTemplate);
            if (sizeTemplate) {
                out = out.replace(/\{\{A8:SIZE:\d+(?::[^}]+)?\}\}/g, sizeTemplate);
            }
            return out;
        };

        const updates: Partial<APIEndpointConfig> = {};
        const rewrittenBody = rewrite(currentEndpoint?.body);
        if (rewrittenBody !== undefined) {
            updates.body = rewrittenBody;
        }
        const endpointWithComments = currentEndpoint as (APIEndpointConfig & { bodyWithComments?: string }) | undefined;
        if (typeof endpointWithComments?.bodyWithComments === 'string') {
            (updates as { bodyWithComments?: string }).bodyWithComments = rewrite(endpointWithComments.bodyWithComments);
        }

        await endpointManager.updateEndpoint(endpointId, updates);
    }
}
