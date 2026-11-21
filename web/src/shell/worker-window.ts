// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The screen scripts a worker reads (search-matcher.js) put their API on `window`, which a worker
 * hasn't: it is the worker's own scope here, imported first (engine-worker.ts).
 */
(globalThis as Record<string, unknown>).window ??= globalThis;
export {};
