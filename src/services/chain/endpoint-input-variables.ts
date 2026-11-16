// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The input variables of an endpoint: every `{{name}}` in its body, path, headers and query
 * parameters that a batch's rows have to supply. `A8:` (generated) and `ENV:` (environment)
 * variables are not input. Optional ones (`|opt`, `|null`) are input, but a row may leave
 * them out.
 *
 * GitHub Issue #248 first needed the names (the Console's "Mapped Columns" Input view).
 * GitHub Issue #247 needs them to rank which endpoint a View's rows can feed.
 */
import { APIEndpointConfig } from '../../data-loading/types';
import { extractVariablesFromJsonTemplate } from '../../data-loading/json-template-parser';

export interface EndpointInputVariable {
    name: string;
    optional: boolean;
}

const isSpecial = (raw: string): boolean =>
    raw.startsWith('A8:') || raw.startsWith('A8.') || raw.toUpperCase().startsWith('ENV:');

/** `|opt` drops an empty value, `|null` sends null: neither needs a column. */
export function isOptionalModifier(modifier: string | undefined): boolean {
    if (!modifier) return false;
    return modifier.split('|').some(part => {
        const token = part.trim().toLowerCase();
        return token === 'opt' || token === 'null';
    });
}

export function endpointInputVariables(endpoint: APIEndpointConfig | undefined): EndpointInputVariable[] {
    if (!endpoint) return [];
    const byName = new Map<string, EndpointInputVariable>();
    const add = (name: string, optional: boolean): void => {
        if (!name) return;
        const seen = byName.get(name);
        // Required anywhere means required.
        byName.set(name, { name, optional: seen ? seen.optional && optional : optional });
    };

    // Body: JSON-aware, so {{}} and {{:type}} shorthand resolve to the key's name.
    if (endpoint.body) {
        const bodyStr = typeof endpoint.body === 'string' ? endpoint.body : JSON.stringify(endpoint.body);
        try {
            for (const v of extractVariablesFromJsonTemplate(bodyStr).variables) {
                if (v.isA8Variable || v.isEnvVariable) continue;
                if (v.resolvedName) add(v.resolvedName, isOptionalModifier(v.formatModifier));
            }
        } catch {
            // A body the parser cannot read still has its path/header/query variables.
        }
    }

    // Path, headers, query parameters: plain {{name}}, {{name:type}}, {{name:type|opt}}.
    const sweep = (haystack: string | undefined): void => {
        if (!haystack) return;
        const regex = /\{\{([^}]+)\}\}/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(haystack)) !== null) {
            const raw = m[1].trim();
            if (isSpecial(raw)) continue;
            const [head, ...modifiers] = raw.split('|');
            const name = head.split(':')[0].trim();
            add(name, isOptionalModifier(modifiers.join('|')));
        }
    };
    sweep(endpoint.path);
    sweep(endpoint.headers ? JSON.stringify(endpoint.headers) : undefined);
    sweep((endpoint as any).queryParams ? JSON.stringify((endpoint as any).queryParams) : undefined);

    return Array.from(byName.values());
}

/** Names only — what the Console's Input tab "Mapped Columns" view shows. */
export function endpointInputVariableNames(endpoint: APIEndpointConfig | undefined): string[] {
    return endpointInputVariables(endpoint).map(v => v.name);
}
