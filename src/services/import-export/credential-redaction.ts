// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #289 — credential handling for environment exports.
 *
 * Exports used to carry `oauthConfig.clientSecret` and the whole
 * `googleServiceAccountConfig` (including `private_key`) in plaintext, while
 * the docs promised they were stripped and called export files "safe to commit
 * to git". Credentials are now removed by default; including them is an
 * explicit per-export choice.
 *
 * Session tokens (`token`, `accessToken`, `refreshToken`) are removed either
 * way — they expire and are useless to a recipient.
 */

import { EnvironmentConfig } from '../../environmentManager';

/** Marks an exported environment whose credentials were stripped, so import can flag it. */
export const CREDENTIALS_REDACTED_FIELD = 'credentialsRedacted';

/** Session tokens — never exported, regardless of the credential choice. */
const SESSION_TOKEN_FIELDS = ['token', 'accessToken', 'refreshToken'] as const;

/**
 * Service-account fields that are actually secret. The rest of the config
 * (`project_id`, `client_email`, the URIs) is identifying, not sensitive, and
 * is kept so the recipient can see which account to re-key.
 */
const SERVICE_ACCOUNT_SECRET_FIELDS = ['private_key', 'private_key_id'] as const;

export interface EnvironmentWithRedaction extends EnvironmentConfig {
    [CREDENTIALS_REDACTED_FIELD]?: boolean;
}

/** True when this environment carries a credential that redaction would remove. */
export function hasExportableCredentials(env: EnvironmentConfig): boolean {
    const oauthSecret = Boolean(env.oauthConfig?.clientSecret);
    const serviceAccount = env.googleServiceAccountConfig as Record<string, unknown> | undefined;
    const serviceAccountSecret = Boolean(
        serviceAccount && SERVICE_ACCOUNT_SECRET_FIELDS.some(field => serviceAccount[field])
    );
    return oauthSecret || serviceAccountSecret;
}

/**
 * Copy an environment for export.
 *
 * Always drops session tokens. When `includeCredentials` is false, also drops
 * the OAuth client secret and the service-account private key, and marks the
 * environment so import can tell the user what to re-enter.
 *
 * Never mutates the stored environment — the nested config objects are copied
 * before any field is deleted.
 */
export function redactEnvironmentForExport(
    env: EnvironmentConfig,
    includeCredentials: boolean
): EnvironmentWithRedaction {
    const exported: EnvironmentWithRedaction = { ...env };

    // Session tokens aren't on EnvironmentConfig, so delete through a plain view
    const mutable = exported as unknown as Record<string, unknown>;
    for (const field of SESSION_TOKEN_FIELDS) {
        delete mutable[field];
    }

    if (includeCredentials) {
        return exported;
    }

    const redacted = hasExportableCredentials(env);

    if (exported.oauthConfig) {
        const oauthConfig = { ...exported.oauthConfig };
        delete oauthConfig.clientSecret;
        exported.oauthConfig = oauthConfig;
    }

    if (exported.googleServiceAccountConfig) {
        // Copy keeps its type; the secret fields are deleted through a plain view
        const serviceAccount = { ...exported.googleServiceAccountConfig };
        const mutableAccount = serviceAccount as unknown as Record<string, unknown>;
        for (const field of SERVICE_ACCOUNT_SECRET_FIELDS) {
            delete mutableAccount[field];
        }
        exported.googleServiceAccountConfig = serviceAccount;
    }

    if (redacted) {
        exported[CREDENTIALS_REDACTED_FIELD] = true;
    }

    return exported;
}

/**
 * Names of the environments that lost credentials, for the export-time notice.
 * Empty when nothing was stripped.
 */
export function redactedEnvironmentNames(environments: EnvironmentWithRedaction[]): string[] {
    return environments
        .filter(env => env[CREDENTIALS_REDACTED_FIELD])
        .map(env => env.name);
}

/**
 * Strip the redaction marker off an environment about to be written locally,
 * reporting whether it was there. The marker describes the file, not the
 * environment, so it must not reach the store.
 */
export function takeRedactionMarker(env: EnvironmentWithRedaction): boolean {
    const wasRedacted = Boolean(env[CREDENTIALS_REDACTED_FIELD]);
    delete env[CREDENTIALS_REDACTED_FIELD];
    return wasRedacted;
}

/** The import-side warning naming environments that need credentials re-entered. */
export function describeCredentialsNeeded(names: string[]): string | undefined {
    if (!names.length) {
        return undefined;
    }
    const list = names.join(', ');
    return names.length === 1
        ? `Environment "${list}" was exported without its credentials — re-enter them before running against it.`
        : `${names.length} environments were exported without their credentials (${list}) — re-enter them before running against them.`;
}
