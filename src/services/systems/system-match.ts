// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415: which Standard (global) System a base URL belongs to. A global System's configuration
 * (`config.match`, from its Supabase row) is a pattern for the URL's host, e.g.
 * `^(?<instance>[a-z0-9-]+)\.example\.com$`. The named groups are for the sign-in templates
 * (phase 3); here only whether it matches counts. The app knows no pattern itself.
 */
import { SystemConfig, isGlobalSystem } from '../../data-loading/system-schema';

/** The host of an http(s) URL, lowercased; undefined when it isn't one. */
export function urlHost(url: string): string | undefined {
    try {
        const parsed = new URL(url.trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

/** A global System's host pattern, or undefined when it has none (or one that isn't a valid pattern). */
export function hostPattern(system: SystemConfig): RegExp | undefined {
    const match = system.config?.match;
    if (!isGlobalSystem(system) || typeof match !== 'string' || !match) return undefined;
    try {
        return new RegExp(match, 'i');
    } catch {
        console.warn(`[Systems] issue#415 "${system.name}" has a match that isn't a valid pattern; ignored`);
        return undefined;
    }
}

/** The first global System whose pattern matches the URL's host. Own Systems never match. */
export function globalSystemForUrl(url: string, systems: SystemConfig[]): SystemConfig | undefined {
    const host = urlHost(url);
    if (!host) return undefined;
    return systems.find(system => hostPattern(system)?.test(host));
}

/**
 * A name for a new environment: its System, then the host's first label
 * (`samplewms: acme-dev` from `acme-dev.example.com`). An address or localhost has no label
 * worth taking, so the host and port stand in (`dbmn: 127.0.0.1:54321`).
 */
export function suggestEnvironmentName(url: string, systemName: string): string {
    const host = urlHost(url);
    if (!host) return '';
    const plain = host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':');
    const label = plain ? new URL(url.trim()).host : host.split('.')[0];
    return systemName ? `${systemName}: ${label}` : label;
}
