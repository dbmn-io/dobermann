// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Logs screen in VS Code (Dobermann issue 7): a Hub tab running the shared LogsController
 * (src/screens/logs) over the app's log. Save asks where, as the Console's exports do.
 */
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewMessage } from '../shared/types';
import { LogsController, LogsMessage } from '../../screens/logs/logs.controller';
import { buildLogsPage } from '../../screens/logs/logs-page';
import { runHistory } from '../../screens/logs/run-history';
import type { AppLog } from '../../services/logging/app-log';
import { LogReader } from '../../services/logging/log-reader';
import type { IExecutionMetadataService } from '../../services/execution/execution-metadata.interface';
import type { IExecutionLoggingService } from '../../services/logging/execution-logging.interface';

export class LogsWebview extends WebviewBase {
    private readonly controller: LogsController;

    constructor(context: vscode.ExtensionContext, log: AppLog, metadata: IExecutionMetadataService | undefined, executionLogging: IExecutionLoggingService | undefined, config: { search?: string } = {}) {
        super(context);
        this.controller = new LogsController(this.session, {
            reader: new LogReader(log.store(), runHistory(metadata), () => log.recent()),
            requests: executionLogging ? { events: id => executionLogging.getExecutionLogs(id) } : undefined,
            redact: text => log.redactor.text(text),
            files: {
                save: async (name, text) => {
                    const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(name), filters: { 'Text': ['txt', 'log'] }, title: 'Save the log lines' });
                    if (!uri) return false;
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
                    return true;
                }
            },
            prefs: context.globalState,
            // A line's run, opened in the Console as History opens it
            runs: metadata ? { get: async id => (await metadata.getExecution(id)) ?? undefined } : undefined,
            openConsole: async (executionId, isBatch) => {
                await vscode.commands.executeCommand('dbmn.viewTransactionReport', { id: executionId, executionId, isBatch });
            },
            toast: {
                info: m => this.toast?.info(m),
                warn: m => this.toast?.warn(m),
                error: m => this.toast?.error(m)
            }
        }, config);
    }

    /** Already open, asked for again with a search. */
    search(text: string): void {
        this.controller.showSearch(text);
    }

    getWebviewType(): string {
        return 'logs';
    }

    protected getWebviewTitle(): string {
        return 'Logs';
    }

    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(): Promise<string> {
        return buildLogsPage(rel => this.getWebviewUri(rel).toString());
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        await this.controller.handleMessage(message as unknown as LogsMessage);
    }

    dispose(): void {
        this.controller.dispose();
        super.dispose();
    }
}
