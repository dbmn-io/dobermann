// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * "New System" in a DbmnModal: validate on submit (inline field errors), create, return it.
 * Core: the endpoint and environment editors and the Hub use it in both hosts. Moved from
 * services/ui/dbmn-prompts.ts promptForNewSystemName, which keeps only VS Code's native
 * fallback for callers with no webview.
 */
import { SystemConfig, validateShortIdentifier } from '../data-loading/system-schema';
import { ModalHost } from './modal.types';

/** Minimal shape of SystemManager this helper needs. */
export interface SystemManagerLike {
    getAllSystems(): Promise<Array<{ name: string }>>;
    addSystem(config: { name: string }): Promise<SystemConfig>;
}

/** @returns the created System, or `undefined` if the user cancelled. */
export async function promptNewSystemInModal(systemManager: SystemManagerLike, host: ModalHost): Promise<SystemConfig | undefined> {
    let created: SystemConfig | undefined;
    const result = await host.showModal({
        title: 'New System',
        body: 'Short lowercase name — letters and digits only (a–z 0–9), max 16 characters.',
        fields: [{
            id: 'name',
            type: 'text',
            label: 'System name',
            placeholder: 'e.g. WMS, ERP, Training Ground',
            autoFocus: true
        }],
        actions: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            {
                id: 'create',
                label: 'Create',
                variant: 'primary',
                onSubmit: async (fields) => {
                    // Re-snapshot every submit so a concurrent create in
                    // another surface can't sneak past validation.
                    const existing = await systemManager.getAllSystems();
                    const existingNames = new Set(existing.map(s => s.name.toLowerCase()));
                    const raw = (fields.name || '').trim();
                    const err = validateShortIdentifier(raw, { kind: 'System', existingNames });
                    if (err) {
                        const e = new Error(err) as Error & { fieldErrors?: Record<string, string> };
                        e.fieldErrors = { name: err };
                        throw e;
                    }
                    created = await systemManager.addSystem({ name: raw.toLowerCase() });
                }
            }
        ],
        dismissible: true,
        size: 'sm'
    });
    if (result.actionId !== 'create') return undefined;
    return created;
}
