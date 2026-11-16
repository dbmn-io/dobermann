// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * `{{ENV:name}}` in a path, a query parameter or a header: the environment's variable by that
 * name (the `org`, a `region`, a `client`). Resolved before a run's own values are asked for and
 * before anything checks for templates left behind. A name the environment lacks stays as typed,
 * so the missing-variable check can name it.
 */
const ENV_TEMPLATE = /\{\{\s*ENV:([^}:]+?)\s*\}\}/gi;

/** `{{ENV:name}}` replaced by the environment's value, everything else untouched. */
export function substituteEnvVariables(text: string, variables: Record<string, string> | undefined): string {
    if (!variables || !text.includes('{{')) return text;
    return text.replace(ENV_TEMPLATE, (match, name: string) => {
        const key = name.trim();
        return key in variables ? String(variables[key]) : match;
    });
}

/** The same through every string in a structure (header and query maps, old or new shape). */
export function substituteEnvDeep<T>(value: T, variables: Record<string, string> | undefined): T {
    if (!variables) return value;
    if (typeof value === 'string') return substituteEnvVariables(value, variables) as unknown as T;
    if (Array.isArray(value)) return value.map(item => substituteEnvDeep(item, variables)) as unknown as T;
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = substituteEnvDeep(item, variables);
        return out as T;
    }
    return value;
}
