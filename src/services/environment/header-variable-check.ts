// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #424: before a run, every variable it can't go without must hold a value: each header
 * variable (the org among them) and each variable the base URL names. One with options must hold
 * one of them; one without must not be empty. The missing ones are asked for in one modal naming
 * them: a pick list for a variable with options, a text box for one without (what is typed joins
 * a header variable's options, as the header's Add does). The answers are saved on the
 * environment and the run goes on; Cancel stops it. A header variable a run doesn't need is
 * unticked from the header.
 *
 * Core: the host hands in the modal (the Hub or the screen the run starts from) and the toast.
 */
import type { DbmnModalSpec, ModalHost } from '../../screens/modal.types';
import { baseUrlVariableNames } from '../../utils/environment-url';
import { type HeaderVariable, type VariableBearer, headerVariableNames, optionLabel, variablesMissingAValue } from './variable-options';

export interface HeaderVariableEnvironments {
    getVariableOptions(environmentId: string, name: string): Promise<string[]>;
    setVariable(environmentId: string, name: string, value: string): Promise<unknown>;
    addVariableOption(environmentId: string, name: string, value: string): Promise<unknown>;
}

export interface HeaderVariableHost {
    modal(): ModalHost | undefined;
    toast: { error(message: string): void };
}

/** The modal that asks for the missing values: a select for a variable with options, a text box for one without. */
export function headerVariableSpec(environmentName: string, missing: HeaderVariable[]): DbmnModalSpec {
    const names = missing.map(v => v.name);
    const verb = missing.every(v => v.options.length > 0) ? 'Pick' : 'Set';
    return {
        title: `${verb} ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`}`,
        body: `${environmentName} needs ${names.length === 1 ? 'a value' : 'values'} for this run.`,
        fields: missing.map((variable, index) => variable.options.length > 0
            ? {
                id: variable.name,
                type: 'select' as const,
                label: variable.name,
                value: variable.options.includes(variable.value) ? variable.value : variable.options[0],
                autoFocus: index === 0,
                options: variable.options.map(value => ({ value, label: optionLabel(variable, value) === value ? value : `${optionLabel(variable, value)} · ${value}` }))
            }
            : {
                id: variable.name,
                type: 'text' as const,
                label: variable.name,
                value: '',
                autoFocus: index === 0
            }),
        actions: [
            { id: 'cancel', label: 'Cancel', variant: 'secondary' },
            { id: 'use', label: 'Use', variant: 'primary' }
        ],
        size: 'sm'
    };
}

/**
 * True when every variable the run needs holds a value, after asking for the ones that don't.
 * False when the user cancelled, left one empty, or when there is nowhere to ask.
 */
export async function ensureHeaderVariables(
    environment: VariableBearer & { id: string; name: string; baseUrl?: string },
    environments: HeaderVariableEnvironments,
    host: HeaderVariableHost
): Promise<boolean> {
    const required = baseUrlVariableNames(environment.baseUrl);
    const options = new Map<string, string[]>();
    for (const name of new Set([...headerVariableNames(environment), ...required])) {
        options.set(name, await environments.getVariableOptions(environment.id, name));
    }
    const missing = variablesMissingAValue(environment, name => options.get(name) ?? [], required);
    if (missing.length === 0) return true;

    const modal = host.modal();
    if (!modal) {
        host.toast.error(`${environment.name}: set ${missing.map(v => v.name).join(', ')} before running (the Hub header, or the environment's Variables).`);
        return false;
    }
    const result = await modal.showModal(headerVariableSpec(environment.name, missing));
    if (result.actionId !== 'use') return false;
    const inHeader = headerVariableNames(environment);
    for (const variable of missing) {
        const value = (result.fields[variable.name] ?? '').trim();
        if (variable.options.length > 0 ? !variable.options.includes(value) : !value) {
            host.toast.error(`${environment.name}: ${variable.name} needs a value. The run didn't start.`);
            return false;
        }
        if (variable.options.length === 0 && inHeader.includes(variable.name)) {
            await environments.addVariableOption(environment.id, variable.name, value);
        } else {
            await environments.setVariable(environment.id, variable.name, value);
        }
    }
    return true;
}
