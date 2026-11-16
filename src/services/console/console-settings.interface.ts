// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Console Views — type re-exports
 *
 * GitHub Issue #229: Views live on APIEndpointConfig.consoleViews in VS Code
 * globalState. Persist via APIEndpointManager.updateEndpoint; ships with
 * endpoint export/import automatically.
 *
 * Schema is defined by the Zod schemas in src/data-loading/zod-schemas.ts;
 * this file re-exports the inferred TypeScript types for ergonomic imports
 * from service and webview-manager code.
 */

export type {
    ViewColumn,
    ConsoleView,
    TabViewSettings,
    ConsoleViews
} from '../../data-loading/zod-schemas';
