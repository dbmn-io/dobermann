// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * VS Code's side of the usage counter (dbmn-telemetry.service.ts, which every host shares):
 * the switch (#419: `dbmn.telemetry.enabled`, and VS Code's own telemetry setting) and what
 * each row says about the client (the extension's version, VS Code's, the platform).
 */
import * as vscode from 'vscode';
import { reportedExtensionVersion } from '../dbmn-backend/backend-config';
import type { TelemetryOptions } from './dbmn-telemetry.service';

export function vscodeTelemetryOptions(): TelemetryOptions {
    return {
        enabled: () => {
            if (vscode.env?.isTelemetryEnabled === false) return false;
            return vscode.workspace.getConfiguration('dbmn.telemetry').get<boolean>('enabled', true) !== false;
        },
        client: () => ({
            extensionVersion: reportedExtensionVersion(
                vscode.extensions.getExtension('dbmn.dobermann')?.packageJSON?.version || 'unknown'),
            vscodeVersion: vscode.version,
            osPlatform: process.platform
        })
    };
}
