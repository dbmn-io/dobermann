/** Types for core's import of input-row-status.js (shared with the Console page). */
export function rowStatuses(rowCount: number, transactions: unknown[]): { status: string[] };
export function annotate(rows: Record<string, unknown>[], status: string[], filter: string, columnId: string): { records: Record<string, unknown>[] };
export function columnId(row: Record<string, unknown> | undefined): string;
