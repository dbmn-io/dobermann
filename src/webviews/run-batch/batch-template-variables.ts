// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { extractVariablesFromJsonTemplate } from '../../data-loading/json-template-parser';

/**
 * Template variables for Run Batch's Map & Transform step, with where each one is used.
 *
 * Issue #130: the body uses the JSON-aware parser, which supports {{}} and {{:type}}
 * shorthand that infers names from JSON keys.
 */

export interface BatchTemplateVariable {
    name: string;
    mappedTo: string | null;
    dataType: string;
    formatModifier?: string;
    /** Where the variable is used: 'body', 'url', 'query_param:<key>', 'header:<key>' */
    sources: string[];
    /** For body variables, the object/array holding it: '' (top level), 'order.shipTo', 'lines[]' */
    bodyPath?: string;
}

/** "lines[0].sku" -> "lines[]", "buyerGln" -> "": the container a body value sits in, indices dropped */
export function bodyContainerPath(jsonPath: string): string {
    const normalized = (jsonPath || '').replace(/\[\d+\]/g, '[]');
    // A value directly in an array ("lines[].tags[]") belongs to that array
    if (normalized.endsWith('[]')) {
        return normalized;
    }
    const lastDot = normalized.lastIndexOf('.');
    return lastDot >= 0 ? normalized.substring(0, lastDot) : '';
}

export function extractBatchTemplateVariables(endpointConfig: any): BatchTemplateVariable[] {
    // name -> info. `sources` says where the variable is used (body, url, query_param:<key>,
    // header:<key>) and `bodyPath` which object/array of the body holds it ("" = top level,
    // "lines[]"), so Map & Transform can group rows by location.
    const variableNames = new Map<string, { dataType: string; formatModifier?: string; sources: string[]; bodyPath?: string }>();

    const addVariable = (name: string, dataType: string, source: string, extra: { formatModifier?: string; bodyPath?: string } = {}) => {
        const existing = variableNames.get(name);
        if (existing) {
            if (!existing.sources.includes(source)) {
                existing.sources.push(source);
            }
            if (existing.bodyPath === undefined && extra.bodyPath !== undefined) {
                existing.bodyPath = extra.bodyPath;
            }
            return;
        }
        variableNames.set(name, { dataType, formatModifier: extra.formatModifier, sources: [source], bodyPath: extra.bodyPath });
    };

    // URL, header and query values are not JSON, so a regex is enough ({{}} is not valid there)
    const addFromText = (text: string, source: string) => {
        const pattern = /\{\{([^}]+)\}\}/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const varName = match[1].trim();

            // Skip A8 special variables
            if (varName.startsWith('A8:') || varName.startsWith('A8.')) {
                continue;
            }

            // GitHub Issue #165: Skip ENV variables (they come from environment, not CSV)
            if (varName.toUpperCase().startsWith('ENV:')) {
                continue;
            }

            // Parse name:type syntax
            const parts = varName.split(':');
            addVariable(parts[0].trim(), parts.length > 1 ? parts[1].trim() : 'string', source);
        }
    };

    // Headers and query params are { key: "value" } or { key: { value, enabled } }
    const addFromKeyedValues = (values: unknown, sourcePrefix: string) => {
        if (!values || typeof values !== 'object') {
            return;
        }
        Object.entries(values as Record<string, unknown>).forEach(([key, value]) => {
            const text = typeof value === 'string' ? value
                : (value && typeof value === 'object' && typeof (value as { value?: unknown }).value === 'string')
                    ? (value as { value: string }).value
                    : JSON.stringify(value ?? '');
            addFromText(text, `${sourcePrefix}:${key}`);
        });
    };

    // Issue #130: Extract from request body using JSON-aware parser
    // This supports {{}} and {{:type}} shorthand syntax
    if (endpointConfig?.body) {
        const bodyStr = typeof endpointConfig.body === 'string' ? endpointConfig.body : JSON.stringify(endpointConfig.body);
        const jsonResult = extractVariablesFromJsonTemplate(bodyStr);

        for (const v of jsonResult.variables) {
            // Skip A8 special variables (they don't require CSV mapping)
            // GitHub Issue #165: Skip ENV variables (they come from environment, not CSV)
            if (v.isA8Variable || v.isEnvVariable) {
                continue;
            }

            // Use resolved name (which may be inferred from JSON key)
            // GitHub Issue #175: Include formatModifier for warning filtering
            addVariable(v.resolvedName, v.dataType, 'body', {
                formatModifier: v.formatModifier,
                bodyPath: bodyContainerPath(v.jsonPath)
            });
        }
    }

    if (endpointConfig?.path) {
        addFromText(String(endpointConfig.path), 'url');
    }
    addFromKeyedValues(endpointConfig?.queryParams, 'query_param');
    addFromKeyedValues(endpointConfig?.headers, 'header');

    const variables: BatchTemplateVariable[] = [];
    variableNames.forEach((info, name) => {
        variables.push({
            name,
            mappedTo: null,
            dataType: info.dataType,
            formatModifier: info.formatModifier,
            sources: info.sources,
            bodyPath: info.bodyPath
        });
    });

    return variables;
}
