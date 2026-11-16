// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Latest status update per execution that arrived while no Console was
 * registered to receive it. An embedded Console only registers once its iframe
 * signals ready, and a fast run (an immediate 4xx/5xx) can finish before that —
 * without this the Console sat on PENDING for a run that had already ended.
 * Bounded, because a run whose Console never opens would never be taken.
 */
export class MissedStatusBuffer<T> {
    private readonly latest = new Map<string, T>();

    constructor(private readonly limit = 50) {}

    record(executionId: string, update: T): void {
        this.latest.delete(executionId);
        this.latest.set(executionId, update);
        while (this.latest.size > this.limit) {
            const oldest = this.latest.keys().next().value;
            if (oldest === undefined) break;
            this.latest.delete(oldest);
        }
    }

    take(executionId: string): T | undefined {
        const update = this.latest.get(executionId);
        this.latest.delete(executionId);
        return update;
    }
}
