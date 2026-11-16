// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issues #319 / #321: user settings as core reads them. The VS Code shell reads
 * `workspace.getConfiguration(section)` (`platform/vscode/vscode-configuration.ts`); `test:core`
 * scripts values (`platform/memory/memory-configuration.ts`).
 */
export interface IConfiguration {
    /** The setting `section.key`, or `defaultValue` when it is not set. */
    get<T>(section: string, key: string, defaultValue: T): T;
}

/** Settings a screen can also change (the Hub's Settings). */
export interface IWritableConfiguration extends IConfiguration {
    update(section: string, key: string, value: unknown): Promise<void>;
    /** #281: settings changed (here, on another device, sign-in or out): screens showing them re-read. */
    onDidChange?(listener: () => void): { dispose(): void };
}

/** For core constructed without settings: every setting at its default. */
export const DEFAULT_CONFIGURATION: IConfiguration = {
    get: <T>(_section: string, _key: string, defaultValue: T): T => defaultValue
};
