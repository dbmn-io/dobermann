// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: a Standard System's sign-in, read live. An environment on a Standard System
 * gets its OAuth defaults from the System's configuration every time they are needed, and
 * stores only what the user changed; so one edit to the System's row reaches every user's
 * environments, with no release. The user's own values always win.
 *
 * Templates: `{{name}}` in `authorizeUrl` / `tokenUrl` is filled from the named groups of the
 * System's `match` applied to the environment's host (`{{instance}}`), plus `{{host}}` and
 * `{{origin}}`. A template with a name nothing fills gives no default.
 */
import type { SystemConfig } from '../../data-loading/system-schema';
import type { OAuthClientAuth, OAuthConfig, OAuthFlowType } from '../../types/oauth';
import { urlHost } from './system-match';
import { systemConfiguration, type SystemConfiguration } from './system-configuration';

/** What a Standard System says about signing in to an environment at this address. */
export interface SystemOAuthDefaults {
    systemName: string;
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    flowType?: OAuthFlowType;
    usePKCE?: boolean;
    clientAuth?: OAuthClientAuth;
    realm?: string;
    tokenRequestHeaders?: Record<string, string>;
    requiredPaths?: { authorize?: string; token?: string };
    claims?: SystemConfiguration['claims'];
}

/** The fields of an environment's OAuth settings a Standard System can supply. */
export const SYSTEM_OAUTH_FIELDS = ['authorizationUrl', 'tokenUrl', 'scopes', 'flowType', 'usePKCE', 'clientAuth'] as const;

/** The values the templates may name, from the environment's address and the System's pattern. */
export function templateValues(baseUrl: string, configuration: Pick<SystemConfiguration, 'match'>): Record<string, string> | undefined {
    const host = urlHost(baseUrl);
    if (!host) return undefined;
    const values: Record<string, string> = { host, origin: new URL(baseUrl.trim()).origin };
    if (configuration.match) {
        try {
            const groups = new RegExp(configuration.match, 'i').exec(host)?.groups ?? {};
            // An optional group that took no part (`(?<sce>\\.sce)?`) fills as nothing, so its template still resolves
            for (const [name, value] of Object.entries(groups)) values[name] = value ?? '';
        } catch {
            // Not a valid pattern: reported where the System is loaded; no groups here
        }
    }
    return values;
}

/** `{{name}}` placeholders filled; undefined when one names a value that isn't there. */
export function fillTemplate(template: string, values: Record<string, string>): string | undefined {
    let missing = false;
    const filled = template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => {
        if (values[name] === undefined) missing = true;
        return values[name] ?? '';
    });
    return missing ? undefined : filled;
}

/** The System's defaults for an environment at this address; undefined when it is not a Standard System or says nothing about sign-in. */
export function systemOAuthDefaults(environment: Pick<{ baseUrl?: string }, 'baseUrl'>, system: SystemConfig | undefined): SystemOAuthDefaults | undefined {
    const configuration = systemConfiguration(system);
    const oauth = configuration?.oauth;
    if (!system || !configuration || !oauth) return undefined;
    const values = templateValues(environment.baseUrl ?? '', configuration) ?? {};
    const defaults: SystemOAuthDefaults = { systemName: system.name };
    if (oauth.authorizeUrl) defaults.authorizationUrl = fillTemplate(oauth.authorizeUrl, values);
    if (oauth.tokenUrl) defaults.tokenUrl = fillTemplate(oauth.tokenUrl, values);
    if (oauth.scopes) defaults.scopes = [...oauth.scopes];
    if (oauth.flow) defaults.flowType = (oauth.flow === 'client_credentials' ? 'client_credentials' : oauth.pkce ? 'authorization_code_pkce' : 'authorization_code') as OAuthFlowType;
    if (oauth.pkce !== undefined) defaults.usePKCE = oauth.pkce;
    if (oauth.tokenRequest?.clientAuth) defaults.clientAuth = oauth.tokenRequest.clientAuth;
    if (oauth.realm) defaults.realm = oauth.realm;
    if (oauth.tokenRequest?.headers) defaults.tokenRequestHeaders = { ...oauth.tokenRequest.headers };
    if (oauth.requiredPaths) defaults.requiredPaths = { ...oauth.requiredPaths };
    if (configuration.claims) defaults.claims = { ...configuration.claims };
    return defaults;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const empty = (v: unknown): boolean => v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * The settings a token request or the editor works with: the System's defaults, the user's own
 * values on top (an empty own value counts as not set), and `system` for what only the request
 * needs (never stored). Without a Standard System it is the environment's own config, as saved.
 */
export function resolveOAuthConfig(own: OAuthConfig | undefined, defaults: SystemOAuthDefaults | undefined): OAuthConfig | undefined {
    if (!defaults) return own;
    const resolved: OAuthConfig = { ...(own ?? { provider: 'custom', clientId: '' } as OAuthConfig) };
    for (const field of SYSTEM_OAUTH_FIELDS) {
        if (empty(resolved[field]) && defaults[field] !== undefined) (resolved as unknown as Record<string, unknown>)[field] = defaults[field];
    }
    if (empty(resolved.providerConfig?.realm) && defaults.realm) resolved.providerConfig = { ...resolved.providerConfig, realm: defaults.realm };
    resolved.system = { name: defaults.systemName };
    for (const part of ['tokenRequestHeaders', 'requiredPaths', 'claims'] as const) {
        if (defaults[part] !== undefined) (resolved.system as Record<string, unknown>)[part] = defaults[part];
    }
    return resolved;
}

/** What to store: the user's own values only. A value equal to the System's default is the System's, and goes. */
export function ownOAuthValues(config: OAuthConfig, defaults: SystemOAuthDefaults | undefined): OAuthConfig {
    const { system: _runtimeOnly, ...own } = config;
    if (!defaults) return own as OAuthConfig;
    for (const field of SYSTEM_OAUTH_FIELDS) {
        if (defaults[field] !== undefined && same(own[field], defaults[field])) delete (own as unknown as Record<string, unknown>)[field];
    }
    return own as OAuthConfig;
}
