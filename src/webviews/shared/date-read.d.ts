/** Types for core's import of date-read.js (the one date reader, shared with Run Batch's page). */
/** A date written in `format` ('dd-mm-yyyy', 'mm-dd-yyyy', 'yyyy-mm-dd', 'iso_8601', 'unix_timestamp', 'excel_serial') as YYYY-MM-DD, or null. */
export function readDate(text: unknown, format: string): string | null;
/** YYYY-MM-DD for a real calendar day, else null. */
export function calendarDay(y: number | string, m: number | string, d: number | string): string | null;
export function pad2(n: number): string;
export const ISO_DAY: RegExp;
export const ISO_ANY: RegExp;
export const SLASHED: RegExp;
