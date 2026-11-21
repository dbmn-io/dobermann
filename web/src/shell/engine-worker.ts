// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Query's engine in a worker of its own (src/services/engine/engine-host.ts serveEngine): a long run
 * never holds the page. Made by the web host for each Query tab (tabs.ts), stopped when the tab's
 * engine is closed.
 */
import './worker-window';
import { QueryEngine } from '../../../src/services/engine/engine';
import { serveEngine } from '../../../src/services/engine/engine-host';
import { QUERY_ROW_TESTS } from '../../../src/screens/query/query-search';
import { resultWorkbook } from '../../../src/services/query/query-export';
import type { StatusLayout } from '../../../src/services/query/query-new-engine';

const scope = self as unknown as { postMessage(message: unknown): void; addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void };
serveEngine({ post: message => scope.postMessage(message), listen: handler => scope.addEventListener('message', event => handler(event.data)) }, new QueryEngine(undefined, QUERY_ROW_TESTS), {
    // Query's export made here, where Results' rows are: the page receives only the workbook's bytes
    workbook: (engine, args) => resultWorkbook(engine, args[0] as string, args[1] as number[], args[2] as string[], args[3] as [string, string][], args[4] as StatusLayout | undefined)
});
