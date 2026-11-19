// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A sign-in link asked for again too soon. The backend sends one link per address a minute and
 * refuses another before then (HTTP 429, "For security purposes, you can only request this after
 * 47 seconds."). The sign-in dialog counts that wait down rather than showing the sentence.
 */

/** The seconds to wait, from a refused request for a link; undefined for any other failure. */
export function signInLinkWaitSeconds(status: number, message: unknown): number | undefined {
    if (status !== 429 || typeof message !== 'string') return undefined;
    const match = /after (\d+) seconds?/i.exec(message);
    if (!match) return undefined;
    const seconds = Number(match[1]);
    return seconds > 0 && seconds <= 3600 ? seconds : undefined;
}

export class SignInLinkTooSoonError extends Error {
    constructor(readonly seconds: number) {
        super(`You can ask for another link in ${seconds} seconds.`);
        this.name = 'SignInLinkTooSoonError';
    }
}
