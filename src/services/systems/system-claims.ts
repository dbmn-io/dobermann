// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: who a token says the person is, read through the Standard System's
 * configuration (`claims`), with the OpenID names (`name`, `email`, `preferred_username`) as
 * defaults. Organisations and locations are not read from tokens: they are environment
 * variables the user keeps, with options of their own (#424).
 */
import type { SystemConfiguration } from './system-configuration';

export interface TokenIdentity {
    name?: string;
    email?: string;
    username?: string;
}

export type ClaimsConfiguration = Pick<SystemConfiguration, 'claims'>;

const OPENID = { name: 'name', email: 'email', username: 'preferred_username' } as const;

const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** The identity a token carries, by the System's claim names; nothing without a token. */
export function identityOf(payload: Record<string, unknown> | null | undefined, configuration?: ClaimsConfiguration): TokenIdentity {
    if (!payload || typeof payload !== 'object') return {};
    const claims = configuration?.claims ?? {};
    return {
        name: text(payload[claims.name ?? OPENID.name]),
        email: text(payload[claims.email ?? OPENID.email]),
        username: text(payload[claims.username ?? OPENID.username])
    };
}
