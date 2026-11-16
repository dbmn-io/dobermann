// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    BadgeService, BadgeStore, BADGE_CACHE_KEY, BADGE_REFRESH_THROTTLE_MS,
    actionLabel, badgeCaption, buildPuppySchoolUrl, diffNewlyEarned, earnedMessage, progressLabel
} from '../../../../services/badges/badge.service';
import { DbmnBadge, DbmnBadgeResponse } from '../../../../types/dbmn-badges';

const IDS = ['ps_lesson_1', 'ps_lesson_2', 'ps_lesson_3', 'ps_lesson_4', 'ps_lesson_5', 'ps_graduate'];

function response(earned: string[]): DbmnBadgeResponse {
    const lessons = earned.filter(id => id !== 'ps_graduate').map(id => id.replace('ps_', ''));
    const graduated = earned.includes('ps_graduate');
    return {
        badges: IDS.map(id => ({
            id, name: `Name ${id}`, description: 'd', category: 'puppy_school',
            earnedAt: earned.includes(id) ? '2026-09-17T10:00:00Z' : null
        })),
        puppySchool: {
            completed: lessons, total: 5,
            nextLesson: graduated ? null : 'lesson_x',
            graduatedAt: graduated ? '2026-09-17T10:00:00Z' : null
        }
    };
}

function memoryStore(): BadgeStore & { data: Map<string, unknown> } {
    const data = new Map<string, unknown>();
    return {
        data,
        get: <T>(key: string) => data.get(key) as T | undefined,
        update: async (key: string, value: unknown) => { if (value === undefined) { data.delete(key); } else { data.set(key, value); } }
    };
}

describe('badges — pure helpers', () => {
    it('the first sync is a baseline: nothing already earned is reported as new', () => {
        expect(diffNewlyEarned(null, response(['ps_lesson_1', 'ps_lesson_2']))).to.deep.equal([]);
    });

    it('reports exactly the badges earned since the previous sync', () => {
        const fresh = diffNewlyEarned(response(['ps_lesson_1']), response(['ps_lesson_1', 'ps_lesson_3']));
        expect(fresh.map(b => b.id)).to.deep.equal(['ps_lesson_3']);
    });

    it('reports nothing when nothing changed', () => {
        expect(diffNewlyEarned(response(['ps_lesson_1']), response(['ps_lesson_1']))).to.deep.equal([]);
    });

    it('says how far along the learner is, and "Graduate" at the end', () => {
        expect(badgeCaption({ id: 'ps_lesson_1', name: 'Shake', description: 'Puppy School Lesson 1 — First Contact', category: 'puppy_school', earnedAt: null }))
            .to.equal('Lesson 1: First Contact');
        expect(badgeCaption({ id: 'ps_graduate', name: 'Puppy School Graduate', description: 'Complete all five Puppy School lessons', category: 'puppy_school', earnedAt: null }))
            .to.equal('Puppy School Graduate');
        expect(progressLabel(null)).to.equal('');
        expect(progressLabel(response([]))).to.equal('0 of 5 lessons');
        expect(progressLabel(response(['ps_lesson_1', 'ps_lesson_3']))).to.equal('2 of 5 lessons');
        expect(progressLabel(response(IDS))).to.equal('Graduate');
    });

    it('labels the button Start, Continue or Revisit', () => {
        expect(actionLabel(null)).to.equal('Start Puppy School');
        expect(actionLabel(response([]))).to.equal('Start Puppy School');
        expect(actionLabel(response(['ps_lesson_1']))).to.equal('Continue Puppy School');
        expect(actionLabel(response(IDS))).to.equal('Revisit Puppy School');
    });

    it('writes one toast however many badges arrived', () => {
        const b = (name: string): DbmnBadge => ({ id: name, name, description: '', category: '', earnedAt: 'x' });
        expect(earnedMessage([])).to.equal('');
        expect(earnedMessage([b('Reporting')])).to.equal('Badge earned: Reporting');
        expect(earnedMessage([b('A'), b('B')])).to.equal('2 badges earned: A and B');
        expect(earnedMessage([b('A'), b('B'), b('C')])).to.equal('3 badges earned: A, B and C');
    });

    it('carries the email in the URL fragment only — never the query string, never a token', () => {
        expect(buildPuppySchoolUrl()).to.equal('https://dbmn.io/puppy-school/');
        expect(buildPuppySchoolUrl('  ')).to.equal('https://dbmn.io/puppy-school/');
        const url = buildPuppySchoolUrl('a+b@example.com');
        expect(url).to.equal('https://dbmn.io/puppy-school/#email=a%2Bb%40example.com');
        expect(url).to.not.contain('?');
    });
});

describe('BadgeService', () => {
    function build(opts: { user?: string | null; responses: unknown[] }) {
        const store = memoryStore();
        let clock = 1_000_000;
        let calls = 0;
        let user: string | null = opts.user === undefined ? 'user-a' : opts.user;
        const service = new BadgeService({
            store,
            now: () => clock,
            getSession: async () => (user ? { userId: user, accessToken: 't' } : null),
            fetchBadges: async () => {
                const next = opts.responses[Math.min(calls, opts.responses.length - 1)];
                calls++;
                if (next instanceof Error) { throw next; }
                return next;
            }
        });
        const earnedEvents: string[][] = [];
        service.onChange((_state, fresh) => { if (fresh.length) { earnedEvents.push(fresh.map(b => b.id)); } });
        return {
            service, store, earnedEvents,
            calls: () => calls,
            advance: (ms: number) => { clock += ms; },
            setUser: (next: string | null) => { user = next; }
        };
    }

    it('first sync caches the collection and announces nothing', async () => {
        const t = build({ responses: [response(['ps_lesson_1'])] });
        const state = await t.service.refresh();
        expect(state?.puppySchool.completed).to.deep.equal(['lesson_1']);
        expect(state?.unseen).to.deep.equal([]);
        expect(t.earnedEvents).to.deep.equal([]);
        expect(t.store.data.has(BADGE_CACHE_KEY)).to.equal(true);
    });

    it('a badge earned between syncs is announced once and marked unseen until the user looks', async () => {
        const t = build({ responses: [response([]), response(['ps_lesson_1']), response(['ps_lesson_1'])] });
        await t.service.refresh();
        t.advance(BADGE_REFRESH_THROTTLE_MS + 1);
        await t.service.refresh();
        expect(t.earnedEvents).to.deep.equal([['ps_lesson_1']]);
        expect(t.service.getState()?.unseen).to.deep.equal(['ps_lesson_1']);

        t.advance(BADGE_REFRESH_THROTTLE_MS + 1);
        await t.service.refresh();
        expect(t.earnedEvents, 'not announced twice').to.deep.equal([['ps_lesson_1']]);
        expect(t.service.getState()?.unseen, 'still unseen after another sync').to.deep.equal(['ps_lesson_1']);

        await t.service.markSeen();
        expect(t.service.getState()?.unseen).to.deep.equal([]);
    });

    it('is throttled, unless forced', async () => {
        const t = build({ responses: [response([])] });
        await t.service.refresh();
        await t.service.refresh();
        expect(t.calls(), 'second call inside the window is skipped').to.equal(1);
        await t.service.refresh({ force: true });
        expect(t.calls()).to.equal(2);
    });

    it('shares one request between concurrent callers', async () => {
        const t = build({ responses: [response([])] });
        await Promise.all([t.service.refresh({ force: true }), t.service.refresh({ force: true })]);
        expect(t.calls()).to.equal(1);
    });

    it('offline, signed out or a malformed answer: keeps the cache and never throws', async () => {
        const t = build({ responses: [response(['ps_lesson_1']), new Error('offline'), { nonsense: true }] });
        await t.service.refresh();
        t.advance(BADGE_REFRESH_THROTTLE_MS + 1);
        expect((await t.service.refresh())?.puppySchool.completed).to.deep.equal(['lesson_1']);
        t.advance(BADGE_REFRESH_THROTTLE_MS + 1);
        expect((await t.service.refresh())?.puppySchool.completed).to.deep.equal(['lesson_1']);
        t.setUser(null);
        t.advance(BADGE_REFRESH_THROTTLE_MS + 1);
        expect((await t.service.refresh())?.puppySchool.completed).to.deep.equal(['lesson_1']);
    });

    it('renders from the cache on the next start, before any network call', async () => {
        const t = build({ responses: [response(['ps_lesson_1'])] });
        await t.service.refresh();
        const restarted = new BadgeService({
            store: t.store, getSession: async () => null, fetchBadges: async () => { throw new Error('no network'); }
        });
        expect(restarted.buildMessage().progressLabel).to.equal('1 of 5 lessons');
    });

    it("a different user on the same machine starts from a clean baseline — no one else's news", async () => {
        const t = build({ responses: [response([]), response(IDS)] });
        await t.service.refresh();
        t.setUser('user-b');
        t.advance(BADGE_REFRESH_THROTTLE_MS + 1);
        await t.service.refresh();
        expect(t.earnedEvents).to.deep.equal([]);
        expect(t.service.getState()?.unseen).to.deep.equal([]);
    });

    it('clear() forgets the collection (sign-out)', async () => {
        const t = build({ responses: [response(['ps_lesson_1'])] });
        await t.service.refresh();
        await t.service.clear();
        expect(t.service.getState()).to.equal(null);
        expect(t.store.data.has(BADGE_CACHE_KEY)).to.equal(false);
    });
});
