// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The DbmnModal contract between a screen's host and its webview (shared/dbmn-modal.js).
 * Core: used by ScreenSession in VS Code and the web app alike. Moved from
 * services/ui/dbmn-prompts.ts, which re-exports it.
 */
export interface DbmnModalSpec {
    title?: string;
    body?: string;
    fields?: Array<{
        id: string;
        type?: 'text' | 'email' | 'password' | 'number' | 'textarea' | 'select' | 'radio';
        label?: string;
        value?: string;
        placeholder?: string;
        autoFocus?: boolean;
        // For 'select' and 'radio': the choices. `description` (radio only)
        // renders a muted sub-line under the option label; `group` (select
        // only) puts the option under that heading.
        options?: Array<{ value: string; label: string; description?: string; group?: string }>;
    }>;
    actions: Array<{
        id: string;
        label: string;
        variant?: 'primary' | 'secondary' | 'danger';
        /** Optional async callback. When present, the modal stays open while
         *  this runs (spinner on the clicked button, all buttons disabled).
         *  Resolves → modal dismisses with this action's `id`. Rejects →
         *  modal dismisses and the bridge promise rejects with the error,
         *  so the caller can surface it (typically in a follow-up modal). */
        onSubmit?: (fields: Record<string, string>) => Promise<void>;
    }>;
    dismissible?: boolean;
    size?: 'sm' | 'md' | 'lg';
    /** Two-column field layout for modals with many inputs. */
    columns?: 1 | 2;
    /** Issue #302: footer Paste button (and Ctrl+V in any field) fills every
     *  matching field from a copied spreadsheet row, header + data row.
     *  Handled in shared/dbmn-modal.js. */
    rowPaste?: boolean;
    /** In help mode the modal title opens https://dbmn.io/docs/<doc>/#<section>. */
    help?: { doc: string; section?: string; title?: string };
}

export interface DbmnModalResult {
    actionId: string;
    fields: Record<string, string>;
}

/** Anything that can host a DbmnModal — typically a `WebviewBase` instance
 *  so the modal opens in its own panel rather than the Hub. */
export interface ModalHost {
    showModal(spec: DbmnModalSpec): Promise<DbmnModalResult>;
}
