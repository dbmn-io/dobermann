// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #339: the only way catalogue items are made fit to leave the machine. The rule (James,
 * 2026-10-06): endpoints hold templates, never data, and nothing secret is shared.
 *
 * Environments go through #289's export redaction (session tokens, OAuth client secret,
 * service-account private key) without credentials, then lose per-device fields and the values
 * of anything marked secret. Endpoints lose their run counters.
 */
import type { APIEndpointConfig } from '../../apiConfigManager';
import type { EnvironmentConfig } from '../../environmentManager';
import {
    CREDENTIALS_REDACTED_FIELD,
    EnvironmentWithRedaction,
    redactEnvironmentForExport
} from '../import-export/credential-redaction';
import {
    CatalogueEndpoint,
    CatalogueEnvironment,
    DEVICE_LOCAL_ENVIRONMENT_FIELDS
} from './catalogue.types';

/** `currentOrg`: the selected organisation before it was the `org` variable (#424). */
const LEGACY_DEVICE_FIELDS = ['currentOrg'] as const;

/** Header or variable names that usually hold a secret: warn before sharing them unmarked. */
const SECRET_LOOKING_NAME = /(key|token|secret|password|passwd|pwd|auth|credential)/i;

/** A header value marked secret: shared by name, its value stays on the device. */
interface MaybeSecretHeader {
    value: string;
    enabled: boolean;
    secret?: boolean;
}

export function toCatalogueEndpoint(endpoint: APIEndpointConfig): CatalogueEndpoint {
    const { sequenceCounter: _sequence, arraySequenceCounters: _arraySequences, ...template } = endpoint;
    void _sequence;
    void _arraySequences;
    return template;
}

export function toCatalogueEnvironment(environment: EnvironmentConfig & { secretVariables?: string[] }): CatalogueEnvironment {
    const redacted: EnvironmentWithRedaction = redactEnvironmentForExport(environment, false);
    const credentialsRequired = Boolean(redacted[CREDENTIALS_REDACTED_FIELD]);

    const shared = { ...redacted } as Record<string, unknown>;
    delete shared[CREDENTIALS_REDACTED_FIELD];
    for (const field of DEVICE_LOCAL_ENVIRONMENT_FIELDS) {
        delete shared[field];
    }
    // Fields older builds kept on an environment and the account's table refuses
    // (catalog_environments_no_device_state): an environment from a device that ran them
    // still carries them, and must still cross
    for (const field of LEGACY_DEVICE_FIELDS) {
        delete shared[field];
    }

    if (environment.headers) {
        const headers: Record<string, MaybeSecretHeader> = {};
        for (const [name, header] of Object.entries(environment.headers as Record<string, MaybeSecretHeader>)) {
            headers[name] = header.secret ? { ...header, value: '' } : { ...header };
        }
        shared.headers = headers;
    }

    const secretVariables = environment.secretVariables?.filter(name => environment.variables && name in environment.variables);
    if (environment.variables) {
        const variables: Record<string, string> = {};
        for (const [name, value] of Object.entries(environment.variables)) {
            variables[name] = secretVariables?.includes(name) ? '' : value;
        }
        shared.variables = variables;
    }

    const result = shared as CatalogueEnvironment;
    if (secretVariables?.length) {
        result.secretVariables = secretVariables;
    } else {
        delete result.secretVariables;
    }
    if (credentialsRequired) {
        result.credentialsRequired = true;
    }
    return result;
}

/**
 * Header and variable names that look secret but aren't marked secret, so the upload can ask
 * "share these?" first. Empty when nothing looks risky.
 */
export function unmarkedSecretLookingNames(environment: EnvironmentConfig & { secretVariables?: string[] }): string[] {
    const names: string[] = [];
    for (const [name, header] of Object.entries((environment.headers ?? {}) as Record<string, MaybeSecretHeader>)) {
        if (!header.secret && header.value && SECRET_LOOKING_NAME.test(name)) {
            names.push(`header ${name}`);
        }
    }
    for (const [name, value] of Object.entries(environment.variables ?? {})) {
        if (value && !environment.secretVariables?.includes(name) && SECRET_LOOKING_NAME.test(name)) {
            names.push(`variable ${name}`);
        }
    }
    return names;
}

/**
 * #342/#362: an environment's secrets, the parts the safe form blanks or strips: the OAuth client
 * secret, the service-account key, session tokens, and the values of headers and variables marked
 * secret. They stay on the device, in its vault (VS Code SecretStorage); never in the catalogue,
 * never in plain device state. Undefined when the environment has none.
 */
export interface EnvironmentSecrets {
    clientSecret?: string;
    serviceAccountKey?: { private_key?: string; private_key_id?: string };
    tokens?: Partial<Record<'token' | 'accessToken' | 'refreshToken', string>>;
    headers?: Record<string, string>;
    variables?: Record<string, string>;
}

type SecretBearing = EnvironmentConfig & {
    secretVariables?: string[];
    token?: string; accessToken?: string; refreshToken?: string;
    googleServiceAccountConfig?: { private_key?: string; private_key_id?: string };
};

export function environmentSecrets(environment: EnvironmentConfig): EnvironmentSecrets | undefined {
    const env = environment as SecretBearing;
    const secrets: EnvironmentSecrets = {};
    if (env.oauthConfig?.clientSecret) secrets.clientSecret = env.oauthConfig.clientSecret;
    const key = env.googleServiceAccountConfig;
    if (key?.private_key || key?.private_key_id) secrets.serviceAccountKey = { private_key: key.private_key, private_key_id: key.private_key_id };
    for (const field of ['token', 'accessToken', 'refreshToken'] as const) {
        if (env[field]) (secrets.tokens ??= {})[field] = env[field];
    }
    for (const [name, header] of Object.entries((env.headers ?? {}) as Record<string, MaybeSecretHeader>)) {
        if (header.secret && header.value) (secrets.headers ??= {})[name] = header.value;
    }
    for (const name of env.secretVariables ?? []) {
        const value = env.variables?.[name];
        if (value) (secrets.variables ??= {})[name] = value;
    }
    return Object.keys(secrets).length ? secrets : undefined;
}

/**
 * Dobermann issue 7: every secret value an environment holds, as plain strings, so the log can
 * remove them wherever they appear (a header marked secret under any name, a secret variable,
 * the client secret, the service account's key, its tokens).
 */
export function environmentSecretValues(environment: EnvironmentConfig): string[] {
    const secrets = environmentSecrets(environment);
    if (!secrets) return [];
    const values: Array<string | undefined> = [
        secrets.clientSecret,
        secrets.serviceAccountKey?.private_key,
        secrets.serviceAccountKey?.private_key_id,
        ...Object.values(secrets.tokens ?? {}),
        ...Object.values(secrets.headers ?? {}),
        ...Object.values(secrets.variables ?? {})
    ];
    return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** The environment with its device's secrets put back (onto the shared, safe-form item). */
export function withEnvironmentSecrets<T extends EnvironmentConfig>(environment: T, secrets: EnvironmentSecrets | undefined): T {
    if (!secrets) return environment;
    const env = structuredClone(environment) as unknown as SecretBearing;
    if (secrets.clientSecret && env.oauthConfig) env.oauthConfig = { ...env.oauthConfig, clientSecret: secrets.clientSecret };
    if (secrets.serviceAccountKey && env.googleServiceAccountConfig) {
        env.googleServiceAccountConfig = { ...env.googleServiceAccountConfig, ...secrets.serviceAccountKey };
    }
    for (const [field, value] of Object.entries(secrets.tokens ?? {})) (env as unknown as Record<string, unknown>)[field] = value;
    for (const [name, value] of Object.entries(secrets.headers ?? {})) {
        const header = (env.headers as Record<string, MaybeSecretHeader> | undefined)?.[name];
        if (header?.secret) (env.headers as Record<string, MaybeSecretHeader>)[name] = { ...header, value };
    }
    for (const [name, value] of Object.entries(secrets.variables ?? {})) {
        if (env.variables && env.secretVariables?.includes(name)) env.variables[name] = value;
    }
    return env as unknown as T;
}
