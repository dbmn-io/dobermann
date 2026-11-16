// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #415 phase 3: `defaultHeaders`, what a new environment on a Standard System starts with,
 * header name to template (`{{org}}`, filled from the environment's variables). The core names
 * no header itself: without a Standard System there are no defaults.
 *
 * #424: `defaultVariables`, the variables those templates read, so a new environment's header
 * shows `pick org` from the start instead of sending `{{org}}` unfilled.
 */
import type { SystemConfiguration } from './system-configuration';
import type { VariableSettings } from '../environment/variable-options';

/** The headers a new environment on the System starts with, as the environment stores them. */
export function defaultHeadersFor(configuration?: Pick<SystemConfiguration, 'defaultHeaders'>): Record<string, { value: string; enabled: boolean }> | undefined {
    const rule = configuration?.defaultHeaders;
    if (!rule || Object.keys(rule).length === 0) return undefined;
    const headers: Record<string, { value: string; enabled: boolean }> = {};
    for (const [name, value] of Object.entries(rule)) headers[name] = { value, enabled: true };
    return headers;
}

/** The variables a new environment on the System starts with, and their options and header ticks. */
export function defaultVariablesFor(configuration?: Pick<SystemConfiguration, 'defaultVariables'>): { variables: Record<string, string>; variableSettings: Record<string, VariableSettings> } | undefined {
    const rule = configuration?.defaultVariables;
    if (!rule || Object.keys(rule).length === 0) return undefined;
    const variables: Record<string, string> = {};
    const variableSettings: Record<string, VariableSettings> = {};
    for (const [name, { value, options, showInHeader }] of Object.entries(rule)) {
        variables[name] = value ?? '';
        const settings: VariableSettings = {};
        if (options?.length) settings.options = [...options];
        if (showInHeader) settings.showInHeader = true;
        if (Object.keys(settings).length) variableSettings[name] = settings;
    }
    return { variables, variableSettings };
}
