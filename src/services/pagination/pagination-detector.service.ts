// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Pagination Detection Service
 * GitHub Issue #94 - API Pagination Support
 *
 * Detects pagination template variables in query parameters:
 * - {{A8:PAGE}} - Simple format, defaults to 0-based pagination
 * - {{A8:PAGE:X}} - Explicit start value (0 or 1 based)
 * - {{A8:PAGE:X:path}} - With total count JSON path for auto-detection
 */

import { APIEndpointConfig } from '../../data-loading/types';
import { stripJsonCommentsSafe } from '../../utils/json-comment-stripper';

export interface PaginationConfig {
    enabled: true;
    location: 'query' | 'body';    // GitHub Issue #245: where the page template lives
    paramKey: string;              // The query param / body key containing pagination (e.g., "page")
    startValue: number;            // Starting page number (0 or 1)
    totalCountPath?: string;       // Optional JSON path to total count (e.g., "header.totalCount")
    templateVariable: string;      // Original template (e.g., "{{A8:PAGE:0:header.totalCount}}")
}

export interface SizeConfig {
    enabled: true;
    location: 'query' | 'body';    // GitHub Issue #245: where the size template lives
    paramKey: string;     // e.g., "size"
    value: number;        // e.g., 100
    sizePath?: string;    // Optional response field path for page size (e.g., "header.pageSize")
}

export interface NoSizeConfig {
    enabled: false;
}

export type SizeDetectionResult = SizeConfig | NoSizeConfig;

export interface NoPaginationConfig {
    enabled: false;
}

export type PaginationDetectionResult = PaginationConfig | NoPaginationConfig;

/**
 * Service for detecting pagination configuration in endpoints
 */
export class PaginationDetectorService {

    /**
     * Detect pagination configuration from endpoint query parameters
     * Looks for {{A8:PAGE}}, {{A8:PAGE:startValue}} or {{A8:PAGE:startValue:totalCountPath}} pattern
     *
     * @param endpoint - Endpoint configuration to check
     * @returns Pagination configuration if found, or disabled result
     */
    detectPagination(endpoint: APIEndpointConfig): PaginationDetectionResult {
        // Check each query parameter for A8:PAGE template
        for (const [paramKey, paramValue] of Object.entries(endpoint.queryParams || {})) {
            // Handle both string format and HeaderConfig format
            const valueStr = typeof paramValue === 'string'
                ? paramValue
                : (paramValue && typeof paramValue === 'object' && typeof paramValue.value === 'string')
                    ? paramValue.value
                    : null;

            if (!valueStr) {
                continue;
            }

            // Check if disabled (new format only)
            if (typeof paramValue === 'object' && paramValue.enabled === false) {
                continue; // Skip disabled params
            }

            // Look for {{A8:PAGE}} or {{A8:PAGE:...}} pattern
            // Group 1 captures optional content after A8:PAGE: (may be undefined for simple {{A8:PAGE}})
            const paginationMatch = valueStr.match(/\{\{A8:PAGE(?::([^}]*))?\}\}/);

            if (paginationMatch) {
                // paginationMatch[1] is undefined for {{A8:PAGE}}, or the content for {{A8:PAGE:...}}
                const config = this.parsePaginationTemplate(paramKey, paginationMatch[1], valueStr, 'query');
                if (config) {
                    return config;
                }
            }
        }

        // GitHub Issue #245: Fall back to scanning the request body for {{A8:PAGE...}}
        const bodyConfig = this.detectPaginationInBody(endpoint.body);
        if (bodyConfig) {
            return bodyConfig;
        }

        return { enabled: false };
    }

    /**
     * GitHub Issue #245: Detect a pagination template inside the request body.
     * Page/size are expressed with the same {{A8:PAGE...}} / {{A8:SIZE...}} syntax
     * as query-param pagination, e.g. body `{ "Page": "{{A8:PAGE:0:header.totalCount}}" }`.
     *
     * @param body - Raw request body (JSON, comments allowed)
     * @returns Pagination config (location 'body') or null
     */
    private detectPaginationInBody(body?: string): PaginationConfig | null {
        if (!body) {
            return null;
        }
        const clean = stripJsonCommentsSafe(body);
        const match = clean.match(/\{\{A8:PAGE(?::([^}]*))?\}\}/);
        if (!match) {
            return null;
        }
        // Best-effort: capture the JSON key whose value holds the template (for display)
        const paramKey = this.findBodyKeyForTemplate(clean, match[0]) || 'page';
        return this.parsePaginationTemplate(paramKey, match[1], match[0], 'body');
    }

    /**
     * GitHub Issue #245: Find the JSON key whose string value contains the given
     * template, e.g. `"Page": "{{A8:PAGE:0}}"` → "Page". Best-effort; returns null
     * if the template isn't a quoted object value.
     */
    private findBodyKeyForTemplate(body: string, template: string): string | null {
        const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = body.match(new RegExp('"([^"]+)"\\s*:\\s*"[^"]*' + escaped));
        return match ? match[1] : null;
    }

    /**
     * Parse pagination template string
     * Format: {{A8:PAGE}} (defaults to 0), {{A8:PAGE:startValue}} or {{A8:PAGE:startValue:totalCountPath}}
     *
     * @param paramKey - Query param key (e.g., "page")
     * @param templateContent - Content inside {{A8:PAGE:...}} (e.g., "0:header.totalCount"), or undefined for {{A8:PAGE}}
     * @param fullTemplate - Full template string for storage
     * @returns Parsed pagination config or null if invalid
     */
    private parsePaginationTemplate(
        paramKey: string,
        templateContent: string | undefined | null,
        fullTemplate: string,
        location: 'query' | 'body' = 'query'
    ): PaginationConfig | null {
        // Handle simple {{A8:PAGE}} format - default to 0-based pagination
        // Note: regex match returns null (not undefined) for unmatched capture groups
        if (templateContent === undefined || templateContent === null || templateContent === '') {
            return {
                enabled: true,
                location,
                paramKey,
                startValue: 0,
                totalCountPath: undefined,
                templateVariable: fullTemplate
            };
        }

        // Split by colon to get parts
        // Expected: "0" or "0:header.totalCount"
        const parts = templateContent.split(':');

        if (parts.length === 0) {
            return null; // Invalid format
        }

        // First part is start value
        const startValue = parseInt(parts[0], 10);
        if (isNaN(startValue)) {
            return null; // Invalid start value
        }

        // Second part (if exists) is total count path
        const totalCountPath = parts.length > 1 ? parts.slice(1).join(':') : undefined;

        return {
            enabled: true,
            location,
            paramKey,
            startValue,
            totalCountPath,
            templateVariable: fullTemplate
        };
    }

    /**
     * Detect size configuration from endpoint query parameters.
     * Looks for {{A8:SIZE:value}} pattern.
     *
     * @param endpoint - Endpoint configuration to check
     * @returns Size configuration if found, or disabled result
     */
    detectSize(endpoint: APIEndpointConfig): SizeDetectionResult {
        for (const [paramKey, paramValue] of Object.entries(endpoint.queryParams || {})) {
            const valueStr = typeof paramValue === 'string'
                ? paramValue
                : (paramValue && typeof paramValue === 'object' && typeof paramValue.value === 'string')
                    ? paramValue.value
                    : null;

            if (!valueStr) {
                continue;
            }

            if (typeof paramValue === 'object' && paramValue.enabled === false) {
                continue;
            }

            const sizeMatch = valueStr.match(/\{\{A8:SIZE:(\d+)(?::([^}]+))?\}\}/);
            if (sizeMatch) {
                const value = parseInt(sizeMatch[1], 10);
                if (!isNaN(value) && value > 0) {
                    return { enabled: true, location: 'query', paramKey, value, sizePath: sizeMatch[2] || undefined };
                }
            }
        }

        // GitHub Issue #245: Fall back to scanning the request body for {{A8:SIZE...}}
        if (endpoint.body) {
            const clean = stripJsonCommentsSafe(endpoint.body);
            const sizeMatch = clean.match(/\{\{A8:SIZE:(\d+)(?::([^}]+))?\}\}/);
            if (sizeMatch) {
                const value = parseInt(sizeMatch[1], 10);
                if (!isNaN(value) && value > 0) {
                    const paramKey = this.findBodyKeyForTemplate(clean, sizeMatch[0]) || 'size';
                    return { enabled: true, location: 'body', paramKey, value, sizePath: sizeMatch[2] || undefined };
                }
            }
        }

        return { enabled: false };
    }

    /**
     * Replace pagination templates with actual values.
     * Replaces {{A8:PAGE:...}} with the page number and {{A8:SIZE:X}} with X.
     *
     * @param queryParams - Original query parameters
     * @param paginationConfig - Pagination configuration
     * @param pageNumber - Page number to use
     * @returns Updated query parameters with templates resolved
     */
    replacePaginationTemplate(
        queryParams: Record<string, string | any>,
        paginationConfig: PaginationConfig,
        pageNumber: number,
        size?: number
    ): Record<string, string | any> {
        const updated = { ...queryParams };

        // Replace the pagination template with actual page number
        const paramKey = paginationConfig.paramKey;
        const currentValue = updated[paramKey];
        const paginationRegex = /\{\{A8:PAGE(?::[^}]*)?\}\}/;

        if (typeof currentValue === 'string') {
            updated[paramKey] = currentValue.replace(paginationRegex, String(pageNumber));
        } else if (currentValue && typeof currentValue === 'object' && typeof currentValue.value === 'string') {
            updated[paramKey] = {
                ...currentValue,
                value: currentValue.value.replace(paginationRegex, String(pageNumber))
            };
        }

        // Replace {{A8:SIZE:X}} or {{A8:SIZE:X:path}} → X (or the size given) in all query params
        const sizeRegex = /\{\{A8:SIZE:(\d+)(?::[^}]+)?\}\}/;
        for (const [key, value] of Object.entries(updated)) {
            if (typeof value === 'string') {
                const sizeMatch = value.match(sizeRegex);
                if (sizeMatch) {
                    updated[key] = value.replace(sizeRegex, String(size ?? sizeMatch[1]));
                }
            } else if (value && typeof value === 'object' && typeof value.value === 'string') {
                const sizeMatch = value.value.match(sizeRegex);
                if (sizeMatch) {
                    updated[key] = { ...value, value: value.value.replace(sizeRegex, String(size ?? sizeMatch[1])) };
                }
            }
        }

        return updated;
    }

    /**
     * GitHub Issue #245: Replace {{A8:PAGE...}} and {{A8:SIZE...}} templates inside
     * a request body string with literal page/size values. The body is pre-resolved
     * before transaction creation so the JsonGenerator only ever sees literals.
     *
     * @param body - Original request body string (templates intact)
     * @param pageNumber - Page number to substitute for {{A8:PAGE...}}
     * @param size - Page size to ask for instead of the template's (see sizeToAsk)
     * @returns Body string with pagination templates resolved
     */
    replacePaginationInBody(body: string, pageNumber: number, size?: number): string {
        if (!body) {
            return body;
        }
        // Replace every {{A8:PAGE...}} with the page number
        let updated = body.replace(/\{\{A8:PAGE(?::[^}]*)?\}\}/g, String(pageNumber));
        // Replace every {{A8:SIZE:N...}} with N
        updated = updated.replace(/\{\{A8:SIZE:(\d+)(?::[^}]+)?\}\}/g, (_match, asked: string) => String(size ?? asked));
        return updated;
    }

    /**
     * GitHub Issue #245: Extract the page size from a request body containing a
     * {{A8:SIZE:N}} template, for total-page calculation.
     *
     * @param body - Request body string
     * @returns Page size if found, otherwise undefined
     */
    extractPageSizeFromBody(body?: string): number | undefined {
        if (!body) {
            return undefined;
        }
        const clean = stripJsonCommentsSafe(body);
        const match = clean.match(/\{\{A8:SIZE:(\d+)/);
        if (match) {
            const size = parseInt(match[1], 10);
            if (!isNaN(size) && size > 0) {
                return size;
            }
        }
        return undefined;
    }

    /**
     * Extract page size from query parameters for total page calculation
     * Looks for common param names: size, limit, pageSize, perPage, count
     *
     * @param queryParams - Query parameters to search
     * @returns Page size if found, otherwise undefined
     */
    extractPageSize(queryParams: Record<string, string | any>): number | undefined {
        const sizeParamNames = ['size', 'limit', 'pageSize', 'perPage', 'count'];

        for (const paramName of sizeParamNames) {
            const paramValue = queryParams[paramName];

            if (!paramValue) {
                continue;
            }

            // Handle both string and HeaderConfig format
            const valueStr = typeof paramValue === 'string'
                ? paramValue
                : (paramValue && typeof paramValue === 'object' && typeof paramValue.value === 'string')
                    ? paramValue.value
                    : null;

            if (valueStr) {
                // Try plain number first
                const size = parseInt(valueStr, 10);
                if (!isNaN(size) && size > 0) {
                    return size;
                }
                // Also parse {{A8:SIZE:N}} or {{A8:SIZE:N:path}} template patterns
                const sizeTemplateMatch = valueStr.match(/\{\{A8:SIZE:(\d+)/);
                if (sizeTemplateMatch) {
                    const templateSize = parseInt(sizeTemplateMatch[1], 10);
                    if (!isNaN(templateSize) && templateSize > 0) {
                        return templateSize;
                    }
                }
            }
        }

        return undefined;
    }

    /**
     * Extract page size from API response body
     * GitHub Issue #94 - Phase 1: Fallback when pageSize not in query params
     *
     * Searches common response body paths for pageSize value.
     * This allows pagination to work with APIs that have default page sizes
     * and include the pageSize in their response metadata.
     *
     * @param response - API response body (parsed JSON)
     * @returns Page size if found, otherwise undefined
     */
    extractPageSizeFromResponse(response: any, sizePath?: string): number | undefined {
        if (!response) {
            return undefined;
        }

        // Try explicit sizePath first
        if (sizePath) {
            const value = this.extractValueFromPath(response, sizePath);
            if (value !== null) {
                const size = typeof value === 'number' ? value : parseInt(String(value), 10);
                if (!isNaN(size) && size > 0) {
                    return size;
                }
            }
        }

        // Common paths where APIs include pageSize in response
        const commonPaths = [
            'pageSize',
            'size',
            'limit',
            'header.pageSize',
            'header.size',
            'header.limit',
            'pagination.pageSize',
            'pagination.size',
            'pagination.limit',
            'paging.pageSize',
            'paging.size',
            'response.pageSize',
            'response.size',
            'data.response.pageSize',
            'data.pagination.pageSize',
            'meta.pageSize',
            'meta.size'
        ];

        for (const path of commonPaths) {
            const value = this.extractValueFromPath(response, path);
            if (value !== null) {
                // Validate it's a positive integer
                const size = typeof value === 'number' ? value : parseInt(String(value), 10);
                if (!isNaN(size) && size > 0) {
                    return size;
                }
            }
        }

        return undefined;
    }

    /**
     * #446: how many pages the API itself says there are, when its response gives it
     * (`totalPages`, `header.totalPages`, …). Undefined when it doesn't.
     */
    extractTotalPagesFromResponse(response: unknown): number | undefined {
        if (!response) return undefined;
        const paths = ['totalPages', 'header.totalPages', 'pagination.totalPages', 'paging.totalPages',
            'page.totalPages', 'meta.totalPages', 'response.totalPages', 'data.totalPages', 'data.pagination.totalPages'];
        for (const path of paths) {
            const value = this.extractValueFromPath(response, path);
            const pages = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
            if (Number.isInteger(pages) && pages >= 0) return pages;
        }
        return undefined;
    }

    /**
     * #446: the pages a paginated run has, and the page size the API really sends. An API can send
     * fewer per page than asked (the Training Ground sends at most 500; asked for 2,000, a total of
     * 105,000 counted as 53 pages and Fetch all brought back 26,500 rows). So the API's word wins:
     * the total pages it gives, else the page size it gives when that is smaller than the one
     * asked for, else the one asked for.
     */
    pagesFor(totalCount: number, requestedSize: number | undefined, response: unknown, sizePath?: string, learnSize = true): { totalPages: number; pageSize: number } | undefined {
        // learnSize false: the size is already known (from the first page); a later page's own count
        // (the last page is short) must not shrink it
        const sent = learnSize || !requestedSize ? this.extractPageSizeFromResponse(response, sizePath) : undefined;
        const pageSize = requestedSize && sent ? Math.min(requestedSize, sent) : (requestedSize || sent);
        const stated = this.extractTotalPagesFromResponse(response);
        if (stated !== undefined && totalCount > 0) return { totalPages: stated, pageSize: pageSize || Math.ceil(totalCount / Math.max(1, stated)) };
        if (!pageSize) return undefined;
        return { totalPages: this.calculateTotalPages(totalCount, pageSize), pageSize };
    }

    /**
     * #446: the page size to ask for on the pages after the first. An API can send fewer per page
     * than asked (asked for 2,000, it sends 500). Asking for 2,000 again, an API that works out
     * where page 2 starts from the size asked (page × 2,000) and then sends 500 skips 1,500 rows
     * a page. So once the first page says the API sends fewer, ask for that many. Undefined when
     * the size is not a {{A8:SIZE}} template or the API sends what was asked.
     */
    sizeToAsk(endpoint: APIEndpointConfig, firstPage: unknown): { asked: number; sent: number } | undefined {
        const size = this.detectSize(endpoint);
        if (!size.enabled) return undefined;
        const sent = this.extractPageSizeFromResponse(firstPage, size.sizePath);
        return sent !== undefined && sent < size.value ? { asked: size.value, sent } : undefined;
    }

    /**
     * Extract value from response using JSON path (private helper)
     * @param response - API response body
     * @param path - Dot-separated path (e.g., "data.pagination.pageSize")
     * @returns Extracted value or null if path not found
     */
    private extractValueFromPath(response: any, path: string): any {
        if (!response || !path) {
            return null;
        }

        // Navigate through the path (e.g., "header.totalCount" → response.header.totalCount)
        const pathParts = path.split('.');
        let current = response;

        for (const part of pathParts) {
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
            } else {
                // Path doesn't exist in response
                return null;
            }
        }

        return current;
    }

    /**
     * Extract total count from API response using JSON path
     * GitHub Issue #94: For calculating total pages
     *
     * @param response - API response body (parsed JSON)
     * @param totalCountPath - JSON path to total count (e.g., "header.totalCount")
     * @returns Total count if found, otherwise null
     */
    extractTotalCount(response: any, totalCountPath: string): number | null {
        if (!response || !totalCountPath) {
            return null;
        }

        const value = this.extractValueFromPath(response, totalCountPath);
        if (value === null) {
            return null;
        }

        // Ensure we got a number
        const count = typeof value === 'number' ? value : parseInt(String(value), 10);
        return isNaN(count) ? null : count;
    }

    /**
     * Calculate total pages from total count and page size
     * GitHub Issue #94: For displaying "Page X of Y"
     *
     * @param totalCount - Total number of records
     * @param pageSize - Number of records per page
     * @returns Total number of pages (rounded up)
     */
    calculateTotalPages(totalCount: number, pageSize: number): number {
        if (totalCount <= 0 || pageSize <= 0) {
            return 0;
        }
        return Math.ceil(totalCount / pageSize);
    }

    /**
     * #298: how many pages a paginated endpoint's total needs, from one page's response body.
     * The total is read at the pagination's totalCountPath ("data.…", written from the saved
     * file, is read on the body too); the pages as the API sends them (pagesFor, #446).
     * Undefined when it can't be told (no pagination, no total path, no total, no page size).
     */
    totalPagesFromResponse(endpoint: APIEndpointConfig, body: unknown): number | undefined {
        const config = this.detectPagination(endpoint);
        if (!config.enabled || !config.totalCountPath) return undefined;
        const path = config.totalCountPath;
        let total = this.extractTotalCount(body, path);
        if (total === null && path.startsWith('data.')) total = this.extractTotalCount(body, path.slice(5));
        const size = this.detectSize(endpoint);
        const requested = config.location === 'body'
            ? this.extractPageSizeFromBody(endpoint.body)
            : this.extractPageSize(endpoint.queryParams || {});
        if (total === null) return undefined;
        return this.pagesFor(total, requested, body, size.enabled ? size.sizePath : undefined)?.totalPages;
    }
}

/**
 * Whether a batch runs a paginated endpoint (its pages are its members).
 * Takes the batch's execution metadata; false when it has no endpoint config.
 */
export function isPaginatedBatch(batch: { endpointConfig?: unknown } | null | undefined): boolean {
    if (!batch?.endpointConfig) {
        return false;
    }
    return new PaginationDetectorService().detectPagination(batch.endpointConfig as APIEndpointConfig).enabled;
}
