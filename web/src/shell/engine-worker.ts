// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's engine in a worker of its own (src/services/engine/engine-host.ts serveEngine): a long run
 * never holds the page. Made by the web host for each Query tab (tabs.ts), stopped when the tab's
 * engine is closed.
 */
import { serveEngine } from '../../../src/services/engine/engine-host';

const scope = self as unknown as { postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void };
serveEngine({ post: message => scope.postMessage(message), listen: handler => scope.addEventListener('message', event => handler(event.data)) });
