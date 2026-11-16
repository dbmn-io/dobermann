// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Badge service — reads the user's badge collection and Puppy School progress from the
 * server, caches it so the Account section renders offline, and reports badges earned since
 * the last look.
 *
 * READ-ONLY. Lessons live on dbmn.io and the server records every pass; nothing here tracks
 * or writes progress. No licence check either: badges are independent of licence tier.
 *
 * PORTABLE. No `vscode` import: the session, the HTTP call, the store and the clock are all
 * injected (see extension.ts for the VS Code wiring), so this moves with the product.
 *
 * WHEN IT SYNCS. On activation, when the Account section is shown, and when the window
 * regains focus — that last one is the moment a learner comes back from "Check my homework"
 * in the browser. Throttled, so focus flapping costs nothing.
 */
import {
    DbmnBadge, DbmnBadgeResponse, DbmnBadgeResponseSchema, DbmnBadgeState, DbmnBadgeStateMessage
} from '../../types/dbmn-badges';

export const BADGE_CACHE_KEY = 'dbmn_badge_state';
export const BADGE_REFRESH_THROTTLE_MS = 60_000;
/** Production website. A dev build passes its own site URL (see backend-config.ts). */
export const DEFAULT_SITE_URL = 'https://dbmn.io';

export interface BadgeStore {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): PromiseLike<void>;
}

export interface BadgeServiceDeps {
    /** The signed-in user's id and a VALID access token, or null when signed out / offline. */
    getSession(): Promise<{ userId: string; accessToken: string } | null>;
    /** Calls `get_my_badges()` and returns the raw JSON. Throws on a failed request. */
    fetchBadges(accessToken: string): Promise<unknown>;
    store: BadgeStore;
    now?: () => number;
}

interface CachedBadgeState extends DbmnBadgeState {
    userId: string;
}

export type BadgeListener = (state: DbmnBadgeState | null, newlyEarned: DbmnBadge[]) => void;

// ---------------------------------------------------------------------------
// Pure helpers — everything the UI says is decided here, not in the webview.
// ---------------------------------------------------------------------------

/**
 * Badges earned in `next` that were not earned in `prev`.
 * `prev === null` is the FIRST sync: it sets the baseline and reports nothing, so installing
 * the extension (or signing in on a new machine) never replays old achievements as news.
 */
export function diffNewlyEarned(prev: DbmnBadgeResponse | null, next: DbmnBadgeResponse): DbmnBadge[] {
    if (!prev) { return []; }
    const had = new Set(prev.badges.filter(b => b.earnedAt).map(b => b.id));
    return next.badges.filter(b => b.earnedAt && !had.has(b.id));
}

export function progressLabel(state: DbmnBadgeResponse | null): string {
    if (!state) { return ''; }
    const ps = state.puppySchool;
    if (ps.graduatedAt) { return 'Graduate'; }
    return `${ps.completed.length} of ${ps.total} lessons`;
}

export function actionLabel(state: DbmnBadgeResponse | null): string {
    if (!state || state.puppySchool.completed.length === 0) { return 'Start Puppy School'; }
    return state.puppySchool.graduatedAt ? 'Revisit Puppy School' : 'Continue Puppy School';
}

/**
 * The caption under a badge. A lesson badge is named after the trick it teaches ("Shake"),
 * which means nothing until you have done the lesson — so the card says the lesson, and the
 * trick stays on the picture. The catalogue's description carries it as
 * "Puppy School Lesson 1 — First Contact" (20260917000007_badges.sql).
 */
export function badgeCaption(badge: DbmnBadge): string {
    const lesson = /^Puppy School (Lesson \d+) — (.+)$/.exec(badge.description);
    return lesson ? `${lesson[1]}: ${lesson[2]}` : badge.name;
}

/** One toast, however many arrived: "Badge earned: X" / "3 badges earned: X, Y and Z". */
export function earnedMessage(badges: DbmnBadge[]): string {
    const names = badges.map(b => b.name);
    if (names.length === 0) { return ''; }
    if (names.length === 1) { return `Badge earned: ${names[0]}`; }
    return `${names.length} badges earned: ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The course lives on dbmn.io, where the learner signs in separately (the extension cannot
 * hand over its session, and tokens never travel in a URL). Their email rides in the
 * FRAGMENT so the sign-in form is one click: a fragment is never sent to a server, so it
 * reaches no access log. The page reads it and strips it.
 */
export function buildPuppySchoolUrl(email?: string | null, siteUrl: string = DEFAULT_SITE_URL): string {
    const base = `${siteUrl.replace(/\/+$/, '')}/puppy-school/`;
    const trimmed = (email ?? '').trim();
    return trimmed ? `${base}#email=${encodeURIComponent(trimmed)}` : base;
}

// ---------------------------------------------------------------------------

export class BadgeService {
    private state: CachedBadgeState | null;
    private lastAttemptAt = 0;
    private inFlight: Promise<DbmnBadgeState | null> | null = null;
    private readonly listeners = new Set<BadgeListener>();
    private readonly now: () => number;

    constructor(private readonly deps: BadgeServiceDeps) {
        this.now = deps.now ?? (() => Date.now());
        this.state = deps.store.get<CachedBadgeState>(BADGE_CACHE_KEY) ?? null;
    }

    getState(): DbmnBadgeState | null {
        return this.state;
    }

    /** Everything the Account section needs, labels included. */
    buildMessage(): DbmnBadgeStateMessage {
        return {
            type: 'badgeStateUpdate',
            state: this.state,
            progressLabel: progressLabel(this.state),
            actionLabel: actionLabel(this.state),
            captions: Object.fromEntries((this.state?.badges ?? []).map(b => [b.id, badgeCaption(b)]))
        };
    }

    onChange(listener: BadgeListener): { dispose: () => void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    /**
     * Sync with the server. Never throws: offline or signed out simply leaves the cache as
     * it is. `force` skips the throttle (the user opened the Account section).
     */
    refresh(opts: { force?: boolean } = {}): Promise<DbmnBadgeState | null> {
        if (this.inFlight) { return this.inFlight; }
        if (!opts.force && this.now() - this.lastAttemptAt < BADGE_REFRESH_THROTTLE_MS) {
            return Promise.resolve(this.state);
        }
        this.lastAttemptAt = this.now();
        this.inFlight = this.doRefresh().finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    private async doRefresh(): Promise<DbmnBadgeState | null> {
        try {
            const session = await this.deps.getSession();
            if (!session) { return this.state; }

            const parsed = DbmnBadgeResponseSchema.safeParse(await this.deps.fetchBadges(session.accessToken));
            if (!parsed.success) {
                console.error('[Badges] Unexpected get_my_badges response:', parsed.error.message);
                return this.state;
            }

            // A different user on this machine starts from a clean baseline.
            const prev = this.state && this.state.userId === session.userId ? this.state : null;
            const newlyEarned = diffNewlyEarned(prev, parsed.data);
            const stillUnseen = (prev?.unseen ?? []).filter(id => parsed.data.badges.some(b => b.id === id && b.earnedAt));

            this.state = {
                ...parsed.data,
                userId: session.userId,
                syncedAt: this.now(),
                unseen: [...new Set([...stillUnseen, ...newlyEarned.map(b => b.id)])]
            };
            await this.deps.store.update(BADGE_CACHE_KEY, this.state);
            this.emit(newlyEarned);
            return this.state;
        } catch (error) {
            console.warn('[Badges] Sync failed; showing cached badges:', error instanceof Error ? error.message : error);
            return this.state;
        }
    }

    /** The user is looking at the Account section: clear the dot on its nav icon. */
    async markSeen(): Promise<void> {
        if (!this.state || this.state.unseen.length === 0) { return; }
        this.state = { ...this.state, unseen: [] };
        await this.deps.store.update(BADGE_CACHE_KEY, this.state);
        this.emit([]);
    }

    /** Sign-out: the collection belongs to the account, not the machine. */
    async clear(): Promise<void> {
        this.state = null;
        this.lastAttemptAt = 0;
        await this.deps.store.update(BADGE_CACHE_KEY, undefined);
        this.emit([]);
    }

    private emit(newlyEarned: DbmnBadge[]): void {
        for (const listener of this.listeners) {
            try { listener(this.state, newlyEarned); } catch (error) { console.error('[Badges] Listener failed:', error); }
        }
    }
}
