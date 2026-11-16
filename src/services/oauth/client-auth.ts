// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: client authentication at the token endpoint is a plain OAuth setting, so it lives in
 * the core, on the environment: `basic` (client_secret_basic, an Authorization header) or
 * `body` (client_secret_post, client_id and client_secret in the form). A Standard System's
 * configuration only supplies the default for a new environment (`oauth.tokenRequest.clientAuth`).
 *
 * Environments saved before the setting existed carry none. Until #415 phase 3 moves the
 * System's rules into its configuration row, the choice for those is the rule the code used
 * to apply; the migration service stamps it on each environment once, so phase 3 can delete
 * the rule without signing anyone out.
 */
import type { OAuthClientAuth, OAuthConfig } from '../../types/oauth';
import type { SystemConfig } from '../../data-loading/system-schema';
import { systemConfiguration } from '../systems/system-configuration';

export const CLIENT_AUTH_OPTIONS: readonly OAuthClientAuth[] = ['body', 'basic'];

export function isClientAuth(value: unknown): value is OAuthClientAuth {
    return value === 'basic' || value === 'body';
}

/**
 * The rule the code applied before the setting existed. Deleted by #415 phase 3: by then every
 * stored environment names its own choice and a Standard System's row names the default.
 */
export function legacyClientAuth(config: Pick<OAuthConfig, 'tokenUrl'>): OAuthClientAuth {
    return config.tokenUrl?.includes('manh.com') ? 'basic' : 'body';
}

/** The environment's own choice, or the legacy rule for one saved before the setting existed. */
export function clientAuthFor(config: Pick<OAuthConfig, 'clientAuth' | 'tokenUrl' | 'clientId'>): OAuthClientAuth {
    return isClientAuth(config.clientAuth) ? config.clientAuth : legacyClientAuth(config);
}

/** A Standard System's default for new environments, when its configuration names one. */
export function systemClientAuth(system: Pick<SystemConfig, 'scope' | 'config'> | undefined): OAuthClientAuth | undefined {
    return systemConfiguration(system)?.oauth?.tokenRequest?.clientAuth;
}
