// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The web app's black box (src/services/diagnostics/black-box.ts): its notes in this browser's storage, its
 * lines in the app's log. The screens' host runs in this page, so work that takes long freezes it; this is how a
 * frozen page says, after the fact, what it was doing.
 */
import { BlackBox, type BlackBoxStore } from '../../../src/services/diagnostics/black-box';
import { appLog } from './app-log';

const BEAT_MS = 1000;

/** The browser's storage, or nothing when it is refused (a private window): the box then keeps no notes. */
function browserStore(): BlackBoxStore {
    const none: BlackBoxStore = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, keys: () => [] };
    try {
        const store = window.localStorage;
        store.getItem('dbmn.blackbox.');
        return {
            getItem: key => store.getItem(key),
            setItem: (key, value) => store.setItem(key, value),
            removeItem: key => store.removeItem(key),
            keys: () => Array.from({ length: store.length }, (_, i) => store.key(i) ?? '')
        };
    } catch {
        return none;
    }
}

export const blackBox = new BlackBox({
    store: browserStore(),
    log: (level, message) => { appLog.write({ level, source: 'app', message }); }
});

/** Once the log is kept: say what an earlier page left unfinished, and listen for this one stopping. */
export function startBlackBox(): void {
    blackBox.recover();
    setInterval(() => blackBox.beat(BEAT_MS, document.visibilityState === 'visible'), BEAT_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') blackBox.awake(); });
    // (the browser waking a tab it had put to sleep)
    document.addEventListener('resume', () => blackBox.awake());
    window.addEventListener('pagehide', () => blackBox.closing());
    // A page shown again from the browser's back/forward store carries on: its note is kept again at the next beat
}

/** A message handled with its note kept: `await noted('Hub', message, () => hub.handle(message))`. */
export async function noted<T>(where: string, message: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
    const done = blackBox.handling(where, message);
    try { return await work(); } finally { done(); }
}
