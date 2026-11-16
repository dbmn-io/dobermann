// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: a Standard System's configuration, version 1: the data a `global_systems` row carries
 * in `item.config`, checked here before the app applies any of it. The app knows the shape and
 * how to apply it; it never knows any particular System's values.
 *
 * Unknown keys are dropped, not refused, so a row written for a newer app still loads in an
 * older one. A value of the wrong type fails the whole configuration: the System is still
 * listed, with no configuration, and the row is reported (globalSystemFromRow).
 *
 * Templates (`authorizeUrl`, `tokenUrl`, `defaultHeaders` values) use `{{name}}` placeholders:
 * the named groups of `match` (e.g. `{{instance}}`) and the environment's variables.
 */
import { z } from 'zod';
import type { SystemConfig } from '../../data-loading/system-schema';

const template = z.string().min(1);
const headerMap = z.record(z.string().min(1), z.string());

export const SystemConfigurationSchema = z.object({
    /** Host pattern, with named groups for the templates: `^(?<instance>[a-z0-9-]+)\.example\.com$`. */
    match: z.string().min(1).optional(),
    oauth: z.object({
        authorizeUrl: template.optional(),
        tokenUrl: template.optional(),
        scopes: z.array(z.string().min(1)).optional(),
        pkce: z.boolean().optional(),
        flow: z.enum(['authorization_code', 'client_credentials']).optional(),
        realm: z.string().min(1).optional(),
        /** What the sign-in and token URLs must contain, checked when the user edits them. */
        requiredPaths: z.object({ authorize: z.string().min(1).optional(), token: z.string().min(1).optional() }).optional(),
        tokenRequest: z.object({
            clientAuth: z.enum(['basic', 'body']).optional(),
            /** Sent with every token request; the environment's own setting wins (phase 4). */
            headers: headerMap.optional()
        }).optional()
    }).optional(),
    /** Which token claims carry the account. (Organisations and locations are environment variables the user keeps.) */
    claims: z.object({
        name: z.string().min(1).optional(),
        email: z.string().min(1).optional(),
        username: z.string().min(1).optional()
    }).optional(),
    /** Headers a new environment starts with: header name to template, e.g. `{{org}}`. */
    defaultHeaders: headerMap.optional(),
    /**
     * Variables a new environment starts with, so its headers' templates have something to fill
     * them: `{ "org": { "showInHeader": true } }` puts `pick org` in the Hub header from the start.
     */
    defaultVariables: z.record(z.string().min(1), z.object({
        value: z.string().optional(),
        options: z.array(z.string().min(1)).optional(),
        showInHeader: z.boolean().optional()
    })).optional(),
    /** Reserved: a 200 whose body holds an error. Not read in v1. */
    responseRules: z.unknown().optional()
});

export type SystemConfiguration = z.infer<typeof SystemConfigurationSchema>;

/** The configuration a row carries, or the reason it can't be used. */
export function parseSystemConfiguration(config: unknown): { ok: true; config: SystemConfiguration } | { ok: false; error: string } {
    const parsed = SystemConfigurationSchema.safeParse(config);
    if (parsed.success) return { ok: true, config: parsed.data };
    const first = parsed.error.issues[0];
    return { ok: false, error: `${first.path.join('.') || 'config'}: ${first.message}` };
}

/** A System's configuration as the app reads it: a Standard System's, checked; an own System has none. */
export function systemConfiguration(system: Pick<SystemConfig, 'scope' | 'config'> | undefined): SystemConfiguration | undefined {
    if (!system || system.scope !== 'global' || !system.config) return undefined;
    const parsed = parseSystemConfiguration(system.config);
    return parsed.ok ? parsed.config : undefined;
}
