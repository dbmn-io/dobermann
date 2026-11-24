/** Types for core's import of console-error-reason.js (#428, shared with the Console page). */
export const REASON_COLUMN_ID: string;
export function isError(tx: unknown): boolean;
export function isTestFailure(tx: unknown): boolean;
export function reasonFor(tx: unknown): string;
/** The Error tab's columns with Reason first; each row gains its `__reason` from its `__response`. */
export function withReasonColumn<C extends { id: string }>(rows: Array<Record<string, unknown>>, columns: C[]): Array<C | { id: string; name: string; type: string; sortable: boolean; filterable: boolean; parent: null }>;
