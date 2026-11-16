// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #424: environment variables with options and a place in the header. The organisation picker
 * was one instance of something every System has: a value the user switches often, from a
 * known list, that requests carry as a header, a path segment or a query parameter. It is a
 * property of a variable now, and nothing about it is special to organisations:
 *
 * - `options`: the values it may take, as the user typed them; the header offers them and a
 *   run checks the value is one.
 * - `showInHeader`: shown beside the environment name in the Hub header, options as the dropdown.
 * - `labels`: what an option is called where people pick it (`840` is "Brisbane"); requests
 *   always carry the value. Typed in the editor as `840 = Brisbane`.
 *
 * Settings live beside the values (`variableSettings`), so everything that reads
 * `variables.<name>` as a string (templates, headers, paths, bodies) is untouched.
 */

export interface VariableSettings {
    options?: string[];
    showInHeader?: boolean;
    /** An option's label, by its value. */
    labels?: Record<string, string>;
}

export type VariableSettingsMap = Record<string, VariableSettings>;

/** A variable the header shows: its current value and what it may be. */
export interface HeaderVariable {
    name: string;
    value: string;
    options: string[];
    /** An option's label, by its value (#424): shown in its place, the value beside it. */
    labels?: Record<string, string>;
}

export type VariableBearer = { variables?: Record<string, string>; variableSettings?: VariableSettingsMap };

export function variableSettingsFor(environment: VariableBearer, name: string): VariableSettings {
    return environment.variableSettings?.[name] ?? {};
}

/** The variables shown in the header, in the order they were declared. */
export function headerVariableNames(environment: VariableBearer): string[] {
    return Object.entries(environment.variableSettings ?? {}).filter(([, s]) => s.showInHeader).map(([name]) => name);
}

/** The options the user typed for a variable; none when they typed none. */
export function variableOptions(environment: VariableBearer, name: string): string[] {
    return [...(variableSettingsFor(environment, name).options ?? [])];
}

/** What the header shows for an environment: each header variable with its value, options and labels. */
export function headerVariablesOf(environment: VariableBearer): HeaderVariable[] {
    return headerVariableNames(environment).map(name => {
        const variable: HeaderVariable = { name, value: environment.variables?.[name] ?? '', options: variableOptions(environment, name) };
        const labels = environment.variableSettings?.[name]?.labels;
        if (labels && Object.keys(labels).length) variable.labels = { ...labels };
        return variable;
    });
}

/**
 * The header's variables once `name` is `value` (and, from Add, `value` is a new option with its
 * label): what the Hub draws the moment the user picks, before the save lands.
 */
export function headerVariablesPicking(environment: VariableBearer, name: string, value: string, add?: { label?: string }): HeaderVariable[] {
    return headerVariablesOf(environment).map(variable => {
        if (variable.name !== name) return variable;
        const options = add && !variable.options.includes(value) ? [...variable.options, value] : variable.options;
        const next: HeaderVariable = { ...variable, value, options };
        const label = add?.label?.trim();
        if (label && label !== value) next.labels = { ...(variable.labels ?? {}), [value]: label };
        return next;
    });
}

/** An option's label, or the value itself when it has none. */
export function optionLabel(variable: Pick<HeaderVariable, 'labels'>, value: string): string {
    return variable.labels?.[value] || value;
}

/** True when a variable holds a value a run can use: one of its options, or with none, anything but empty. */
export function hasUsableValue(variable: Pick<HeaderVariable, 'value' | 'options'>): boolean {
    return variable.options.length > 0 ? variable.options.includes(variable.value) : variable.value.trim() !== '';
}

/**
 * The variables a run can't go without, missing a value: every header variable, and every
 * variable the base URL names (`requiredNames`), whose value is empty or not one of its options.
 * A header variable nobody needs is unticked from the header.
 */
export function variablesMissingAValue(environment: VariableBearer, optionsOf: (name: string) => string[], requiredNames: string[] = []): HeaderVariable[] {
    const missing: HeaderVariable[] = [];
    for (const name of [...new Set([...headerVariableNames(environment), ...requiredNames])]) {
        const variable: HeaderVariable = { name, value: environment.variables?.[name] ?? '', options: optionsOf(name) };
        const labels = variableSettingsFor(environment, name).labels;
        if (labels && Object.keys(labels).length) variable.labels = labels;
        if (!hasUsableValue(variable)) missing.push(variable);
    }
    return missing;
}

/**
 * Options as typed in the editor: comma or line separated, `value = label` for one with a label.
 * Trimmed and unique by value.
 */
export function parseOptions(text: string): { options: string[]; labels: Record<string, string> } {
    const options: string[] = [];
    const labels: Record<string, string> = {};
    for (const part of text.split(/[,\n]/)) {
        const at = part.indexOf('=');
        const value = (at < 0 ? part : part.slice(0, at)).trim();
        const label = at < 0 ? '' : part.slice(at + 1).trim();
        if (!value || options.includes(value)) continue;
        options.push(value);
        if (label && label !== value) labels[value] = label;
    }
    return { options, labels };
}

/** Options back as the editor shows them: `840 = Brisbane, 880 = Melbourne`. */
export function formatOptions(settings: VariableSettings): string {
    return (settings.options ?? []).map(value => settings.labels?.[value] ? `${value} = ${settings.labels[value]}` : value).join(', ');
}
