/** Types for core's import of search-matcher.js (shared with the Console page). */
export function parseSearchExpression(expression: string): unknown;
export function matchesValue(terms: unknown, value: unknown): boolean;
export function matchesRow(terms: unknown, row: Record<string, unknown>, columns: unknown[], getValue: (row: Record<string, unknown>, columnId: string) => unknown): boolean;
export function tokenizeForDisplay(expression: string): unknown[];
export function columnSuggestions(typed: string, headings: string[]): Array<{ text: string; label?: string; start: number; end: number; op?: boolean }>;
export const COLUMN_OPS: string[];
