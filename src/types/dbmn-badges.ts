// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * DBMN badges — a collection every user has, greyed out until earned.
 *
 * The server is the only source of truth (`get_my_badges()` in
 * supabase/migrations/20260917000007_badges.sql). Nothing here is ever written back: the
 * extension shows the collection, links to Puppy School on dbmn.io, and says so when a new
 * badge arrives. Artwork is keyed by badge id in src/webviews/shared/badges.js.
 */
import { z } from 'zod';

export const DbmnBadgeSchema = z.object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    category: z.string(),
    /** ISO timestamp, or null while the badge is still locked. */
    earnedAt: z.string().nullable()
});
export type DbmnBadge = z.infer<typeof DbmnBadgeSchema>;

export const DbmnPuppySchoolProgressSchema = z.object({
    completed: z.array(z.string()),
    total: z.number().int().positive(),
    nextLesson: z.string().nullable(),
    graduatedAt: z.string().nullable()
});
export type DbmnPuppySchoolProgress = z.infer<typeof DbmnPuppySchoolProgressSchema>;

export const DbmnBadgeResponseSchema = z.object({
    badges: z.array(DbmnBadgeSchema),
    puppySchool: DbmnPuppySchoolProgressSchema
});
export type DbmnBadgeResponse = z.infer<typeof DbmnBadgeResponseSchema>;

/** What is cached and what the Account section renders. */
export interface DbmnBadgeState extends DbmnBadgeResponse {
    /** Epoch ms of the last successful sync. */
    syncedAt: number;
    /** Badge ids earned since the user last looked at the Account section. */
    unseen: string[];
}

/** Message pushed to the Hub's Account section. `state` is null until the first sync. */
export interface DbmnBadgeStateMessage {
    type: 'badgeStateUpdate';
    state: DbmnBadgeState | null;
    /** e.g. "2 of 5 lessons" / "Graduate" — worked out host-side, not in the webview. */
    progressLabel: string;
    /** "Start Puppy School" / "Continue Puppy School" / "Revisit Puppy School" */
    actionLabel: string;
    /** What to print under each badge, by id: the lesson for a lesson badge, else its name. */
    captions: Record<string, string>;
}
