// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A lookup table's screen in VS Code: a Hub tab running the shared LookupController
 * (src/screens/lookup) over the lookup tables, one JSON file each in DBMN's data folder.
 */
import * as vscode from 'vscode';
import { WebviewBase } from '../shared/webview-base';
import { WebviewMessage } from '../shared/types';
import { LookupController, type LookupMessage } from '../../screens/lookup/lookup.controller';
import { buildLookupPage } from '../../screens/lookup/lookup-page';
import { LookupTablesStore } from '../../services/lookup-tables/lookup-tables';
import type { LookupFolder } from '../../services/lookup-tables/lookup-tables';

export interface LookupWebviewConfig {
    id: string;
    name: string;
    /** The tab follows a rename. */
    onRenamed?(name: string): void;
}

export class LookupWebview extends WebviewBase {
    private readonly controller: LookupController;

    constructor(context: vscode.ExtensionContext, folder: LookupFolder, private readonly config: LookupWebviewConfig) {
        super(context);
        this.controller = new LookupController(this.session, {
            store: new LookupTablesStore(folder),
            toast: {
                info: m => this.toast?.info(m),
                warn: m => this.toast?.warn(m),
                error: m => this.toast?.error(m)
            },
            host: { renamed: name => config.onRenamed?.(name) }
        }, { id: config.id });
    }

    /** Renamed from the Hub's list while open. */
    rename(name: string): Promise<void> {
        return this.controller.handleMessage({ type: 'lookup.rename', name });
    }

    getWebviewType(): string {
        return 'lookup';
    }

    protected getWebviewTitle(): string {
        return this.config.name || 'Lookup table';
    }

    protected getViewColumn(): vscode.ViewColumn {
        return vscode.ViewColumn.Two;
    }

    async getHtmlContent(): Promise<string> {
        return buildLookupPage(rel => this.getWebviewUri(rel).toString(), { name: this.config.name });
    }

    async handleMessage(message: WebviewMessage): Promise<void> {
        await this.controller.handleMessage(message as unknown as LookupMessage);
    }

    dispose(): void {
        this.controller.dispose();
        super.dispose();
    }
}
