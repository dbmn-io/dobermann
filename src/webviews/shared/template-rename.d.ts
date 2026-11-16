/** Types for core's import of template-rename.js (shared with Run Batch's page). */
export function renameInEndpoint<T extends object>(endpoint: T, renames: Record<string, string>): T;
