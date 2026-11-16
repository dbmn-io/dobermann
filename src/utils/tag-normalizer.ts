// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Tag normalisation rules:
 *   - Trim leading/trailing whitespace.
 *   - Lowercase the whole string.
 *   - Preserve `/` so users can express hierarchy (`domain/inventory`).
 *   - Empty results yield null so callers can drop them.
 *
 * Intentionally simpler than System ID rules (which strip all non-alphanumerics).
 * Tags carry user intent — we collapse case / whitespace duplicates without
 * deleting characters the user meant to type.
 */
export function normaliseTag(raw: string): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length === 0) return null;
    return trimmed;
}

/**
 * Normalise every entry and drop nulls + duplicates. Preserves first-seen order
 * so the UI doesn't reshuffle the user's choices.
 */
export function normaliseTags(input: readonly string[] | undefined | null): string[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of input) {
        const tag = normaliseTag(raw);
        if (tag === null) continue;
        if (seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
    }
    return out;
}
