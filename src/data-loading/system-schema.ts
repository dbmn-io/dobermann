// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { z } from 'zod';

export const SystemConfigSchema = z.object({
    id: z.string().min(1, 'System ID is required'),
    name: z.string()
        .min(1, 'System name is required')
        .refine((name) => {
            const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
            return !invalidChars.test(name);
        }, 'System name contains invalid characters')
        .refine((name) => {
            return name.trim() === name && !name.startsWith('.') && !name.endsWith('.');
        }, 'System name cannot start/end with spaces or dots'),
    description: z.string().optional(),
    treeTrimPrefix: z.string().optional(),
    defaultEnvironmentId: z.string().optional(),
    /**
     * #415: a global System is configured by DBMN in Supabase and every signed-in user sees it;
     * a user's own System (no scope) only its owner sees. One System concept either way.
     */
    scope: z.literal('global').optional(),
    /**
     * #415: System configuration (sign-in, token request, claims, headers, ...), from Supabase.
     * The app applies it; it never knows any particular system's configuration itself.
     */
    config: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.number(),
    updatedAt: z.number().optional()
});

export type SystemConfig = z.infer<typeof SystemConfigSchema>;

export const SystemCollectionSchema = z.object({
    systems: z.array(SystemConfigSchema),
    version: z.string()
});

export type SystemCollection = z.infer<typeof SystemCollectionSchema>;

export function generateSystemId(): string {
    return `system_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Short-identifier rules (used for System names and folder names — same
 * P0.2 cleanup direction):
 *   - lowercase letters and digits only (a–z, 0–9)
 *   - no spaces, underscores, or symbols
 *   - 1–16 characters
 *
 * The aim is slug-like, ergonomic names ("dbmn", "d365", "erp").
 * Existing data from earlier migrations (e.g. "Unknown", "System 1") is
 * grandfathered: validation runs only at the InputBox boundary, so non-
 * conformant names continue to load and display until the user renames them.
 */
export const SHORT_NAME_MAX_LENGTH = 16;
export const SHORT_NAME_PATTERN = /^[a-z0-9]+$/;

/**
 * Validate a short identifier — System or folder name. Pass the *raw* user
 * input; this helper trims and lowercases before checking, so the caller
 * doesn't need to. Returns `undefined` if valid, or a user-facing error
 * string ready for `vscode.window.showInputBox`'s `validateInput`.
 *
 * @param value          What the user typed.
 * @param opts.kind      `'System'` | `'Folder'` — used in error messages only.
 * @param opts.existingNames  Optional set of *lowercased* names already in
 *                            use, so duplicates can be rejected inline.
 */
export function validateShortIdentifier(
    value: string,
    opts: { kind: 'System' | 'Folder'; existingNames?: Set<string> }
): string | undefined {
    const trimmed = value.trim();
    if (trimmed.length === 0) return `${opts.kind} name cannot be empty`;
    const lower = trimmed.toLowerCase();
    if (lower.length > SHORT_NAME_MAX_LENGTH) {
        return `Maximum ${SHORT_NAME_MAX_LENGTH} characters`;
    }
    if (!SHORT_NAME_PATTERN.test(lower)) {
        return 'Lowercase letters and digits only (a–z, 0–9) — no spaces, underscores, or symbols';
    }
    if (opts.existingNames?.has(lower)) {
        return `A ${opts.kind.toLowerCase()} with this name already exists`;
    }
    return undefined;
}

/**
 * Convenience wrapper preserved for callers that only deal with Systems.
 * Internally delegates to {@link validateShortIdentifier}.
 */
export function validateSystemName(
    value: string,
    existingNames?: Set<string>
): string | undefined {
    return validateShortIdentifier(value, { kind: 'System', existingNames });
}

/** #415: configured by DBMN in Supabase: listed for everyone, changed by no one in the app. */
export function isGlobalSystem(system: Pick<SystemConfig, 'scope'> | undefined): boolean {
    return system?.scope === 'global';
}

/**
 * #415: the settings on a System that are the user's own, not the System's: on a global System
 * they're kept for the user (SystemManager), and the rest of it stays DBMN's.
 */
export const SYSTEM_PREFERENCE_FIELDS = ['treeTrimPrefix', 'defaultEnvironmentId'] as const;
export type SystemPreferences = Pick<SystemConfig, typeof SYSTEM_PREFERENCE_FIELDS[number]>;

/**
 * Compare two systems by name for stable alphabetical display. Centralised so
 * the tree, the picker, and any future surface all sort identically.
 */
export function compareSystemsByName(a: SystemConfig, b: SystemConfig): number {
    return a.name.localeCompare(b.name);
}

export function createDefaultSystem(name: string, description?: string): SystemConfig {
    const now = Date.now();
    return {
        id: generateSystemId(),
        name: name.trim(),
        description: description?.trim() || undefined,
        createdAt: now,
        updatedAt: now
    };
}

export function validateSystemConfig(config: unknown): { success: boolean; errors?: string[] } {
    const result = SystemConfigSchema.safeParse(config);
    if (result.success) {
        return { success: true };
    }
    return {
        success: false,
        errors: result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)
    };
}

export function sanitizeSystemConfig(config: Partial<SystemConfig>): SystemConfig {
    const now = Date.now();
    return {
        id: config.id || generateSystemId(),
        name: (config.name || '').trim(),
        description: config.description?.trim() || undefined,
        treeTrimPrefix: normalizeTrimPrefix(config.treeTrimPrefix),
        defaultEnvironmentId: config.defaultEnvironmentId?.trim() || undefined,
        ...(config.scope === 'global' ? { scope: 'global' as const } : {}),
        ...(config.config ? { config: config.config } : {}),
        createdAt: config.createdAt || now,
        updatedAt: now
    };
}

function normalizeTrimPrefix(prefix?: string): string | undefined {
    if (!prefix) return undefined;
    const trimmed = prefix.trim();
    if (!trimmed) return undefined;
    return trimmed;
}

/**
 * Compute the longest common path prefix across the given paths.
 * Returns a prefix that ends with `/`, or empty string if no shared prefix.
 *
 * Example: ['/a/b/c', '/a/b/d', '/a/b/c/e'] -> '/a/b/'
 */
export function longestCommonPathPrefix(paths: string[]): string {
    if (paths.length === 0) return '';
    if (paths.length === 1) {
        const segs = paths[0].split('/').filter(Boolean);
        if (segs.length <= 1) return '';
        return '/' + segs.slice(0, -1).join('/') + '/';
    }

    const splitPaths = paths.map(p => p.split('/').filter(Boolean));
    const minLen = Math.min(...splitPaths.map(p => p.length));

    let commonCount = 0;
    for (let i = 0; i < minLen; i++) {
        const segment = splitPaths[0][i];
        if (splitPaths.every(p => p[i] === segment)) {
            commonCount++;
        } else {
            break;
        }
    }

    if (commonCount === 0) return '';
    return '/' + splitPaths[0].slice(0, commonCount).join('/') + '/';
}
