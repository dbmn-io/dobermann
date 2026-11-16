// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A run that stopped before it started because the user closed a prompt, or has to finish
 * signing in first (GitHub Issue #396). Not a failure: nothing is reported as an error, the
 * screen that asked for the run just becomes usable again.
 */
export class RunCancelledError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RunCancelledError';
    }
}
