// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Issue #321: `IConfiguration` over VS Code settings, read fresh on every call as before. */
import * as vscode from 'vscode';
import { IConfiguration } from '../interfaces/configuration.interface';

export class VsCodeConfiguration implements IConfiguration {
    get<T>(section: string, key: string, defaultValue: T): T {
        return vscode.workspace.getConfiguration(section).get<T>(key, defaultValue);
    }
}
