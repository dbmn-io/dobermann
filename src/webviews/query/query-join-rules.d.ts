// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// (the page's script, typed for the core tests that import it)
export function notJoined(state: unknown): string;
export function menu(state: unknown, join: unknown): { remove: { disabled: boolean; detail: string; line: boolean }; reset: { disabled: boolean; detail: string }; hide: boolean };
export function joinLines(state: unknown, shown: Set<string>, touched: boolean): { lines: string[]; next: string };
