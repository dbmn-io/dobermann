// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * "New in vX.Y.Z" for the Hub's Home (GitHub Issue #348).
 *
 * Reads the bundled CHANGELOG.md — the single source of truth the release
 * scripts also publish to dbmn.io — and boils the versions since the one
 * this install last ran down to counts per heading plus the first few Added
 * titles. Pure: no file system, no VS Code API; the Hub host reads the file,
 * keeps the baseline (whatsNewBaseline) and passes both in.
 *
 * Section shape (see scripts/release-lib.js):
 *   ## [0.3.1] - 2026-10-09        or  ## [Unreleased]
 *   ### Added / Changed / Improved / Fixed / Removed / Security
 *   - **Bold title** — description …
 */
import { z } from 'zod';

export interface WhatsNewCounts {
    added: number;
    changed: number;
    fixed: number;
    security: number;
}

export interface WhatsNew {
    /** The newest version shown, or null when it fell back to [Unreleased]. */
    version: string | null;
    /** Versions after this one are included; null = only `version`. */
    since: string | null;
    /** How many version sections were summed. */
    versions: number;
    counts: WhatsNewCounts;
    /** Bold titles of the first Added entries, newest version first. */
    highlights: string[];
}

/** Home appeared in 0.3.1. Someone who has never seen it gets everything
 *  since 0.2.1, so 0.3.0's features are announced too (Issue #348). */
export const FIRST_HOME_BASELINE = '0.2.1';

export interface WhatsNewBaseline {
    /** The version this install last ran. */
    current: string;
    /** What "new" is measured from while `current` is installed. */
    since: string;
}

/**
 * Where "new" starts for the version now running. Stays put while the same
 * version runs; moves to the old version on an upgrade. Returns the value to
 * store back.
 */
export function whatsNewBaseline(stored: WhatsNewBaseline | undefined, current: string): WhatsNewBaseline {
    if (!stored || !stored.current) return { current, since: FIRST_HOME_BASELINE };
    if (stored.current === current) return stored;
    return { current, since: stored.current };
}

const HIGHLIGHT_LIMIT = 3;

/** `### Improved` and `### Removed` count as changes: the line reads
 *  "3 new features · 21 fixes · 4 changes". */
const HEADING_TO_COUNT: Record<string, keyof WhatsNewCounts> = {
    added: 'added',
    changed: 'changed',
    improved: 'changed',
    removed: 'changed',
    fixed: 'fixed',
    security: 'security'
};

interface Section { version: string | null; body: string }

function sections(markdown: string): Section[] {
    const lines = markdown.split(/\r?\n/);
    const out: Section[] = [];
    let current: Section | null = null;
    for (const line of lines) {
        if (/^##\s/.test(line)) {
            const v = line.match(/^##\s*\[?v?(\d+\.\d+\.\d+)\]?(\s|$)/);
            const unreleased = /^##\s*\[?Unreleased\]?\s*$/i.test(line);
            current = v || unreleased ? { version: v ? v[1] : null, body: '' } : null;
            if (current) out.push(current);
            continue;
        }
        if (current) current.body += line + '\n';
    }
    return out;
}

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
}

/**
 * Summarise the changelog for `version`, or for every version after `since`
 * up to `version` when `since` is given. Returns null when nothing matches or
 * the sections have no entries — Home then leaves the card out.
 */
export function summariseChangelog(markdown: string, version: string, since?: string): WhatsNew | null {
    const all = sections(markdown);
    let picked = all.filter(sec => sec.version !== null && (since
        ? compareVersions(sec.version, since) > 0 && compareVersions(sec.version, version) <= 0
        : sec.version === version));
    let shownVersion: string | null = version;
    if (!all.some(sec => sec.version === version)) {
        // Before release:prepare cuts the heading, the next version's notes
        // live under [Unreleased] — what a dev build is about to ship.
        const unreleased = all.find(sec => sec.version === null);
        if (!unreleased) return null;
        picked = [unreleased, ...picked];
        shownVersion = null;
    }
    // Newest first: the changelog lists versions newest first already.
    const counts: WhatsNewCounts = { added: 0, changed: 0, fixed: 0, security: 0 };
    const highlights: string[] = [];
    for (const sec of picked) {
        let current: keyof WhatsNewCounts | null = null;
        let currentHeading = '';
        for (const line of sec.body.split(/\r?\n/)) {
            const heading = line.match(/^###\s+(.+?)\s*$/);
            if (heading) {
                currentHeading = heading[1].toLowerCase();
                current = HEADING_TO_COUNT[currentHeading] ?? null;
                continue;
            }
            if (!current || !/^- /.test(line)) continue;
            counts[current]++;
            if (currentHeading === 'added' && highlights.length < HIGHLIGHT_LIMIT) {
                const title = line.match(/^- \*\*(.+?)\*\*/);
                if (title) highlights.push(title[1]);
            }
        }
    }

    const total = counts.added + counts.changed + counts.fixed + counts.security;
    if (total === 0) return null;
    return { version: shownVersion, since: since ?? null, versions: picked.length, counts, highlights };
}

/** A build's release notes as a host outside VS Code is handed them: its version and its changelog. */
export const releaseNotesSchema = z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    changelog: z.string()
});
const baselineSchema = z.object({ current: z.string().min(1), since: z.string().min(1) });

/**
 * A host's whole step, for one that is handed its release notes as data (the web and desktop
 * apps): Home's card, and the baseline to keep for next time. `notes` and `stored` are checked
 * here; notes that aren't release notes give no card and leave the baseline as it is.
 */
export function whatsNewFromReleaseNotes(notes: unknown, stored: unknown): { whatsNew: WhatsNew | null; baseline?: WhatsNewBaseline } {
    const parsed = releaseNotesSchema.safeParse(notes);
    if (!parsed.success) return { whatsNew: null };
    const kept = baselineSchema.safeParse(stored);
    const baseline = whatsNewBaseline(kept.success ? kept.data : undefined, parsed.data.version);
    return { whatsNew: summariseChangelog(parsed.data.changelog, parsed.data.version, baseline.since), baseline };
}
