// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Endpoint Quick Access Service
 * Implements QuickPick-based endpoint search with action buttons
 */

import * as vscode from 'vscode';
import { getToast } from '../notifications/get-toast';
import { APIEndpointManager } from '../../apiEndpointManager';
import { IExtensionDiagnosticLogger } from '../logging/extension-diagnostic-logger.interface';
import {
    IEndpointQuickAccessService,
    EndpointQuickPickItem,
    QuickAccessResult,
    QuickAccessAction
} from './endpoint-quick-access.interface';
import { APIEndpointConfig } from '../../data-loading/types';

export class EndpointQuickAccessService implements IEndpointQuickAccessService {
    constructor(
        private endpointManager: APIEndpointManager,
        private logger: IExtensionDiagnosticLogger
    ) {}

    async showQuickPick(): Promise<QuickAccessResult> {
        try {
            // Step 1: Select endpoint
            const selectedEndpoint = await this.showEndpointPicker();

            if (!selectedEndpoint) {
                return { action: 'cancelled' };
            }

            // Step 2: Select action
            const selectedAction = await this.showActionPicker(selectedEndpoint);

            this.logger.info(`[QuickAccess] Selected ${selectedAction} for endpoint: ${selectedEndpoint.name}`);

            return {
                endpoint: selectedEndpoint,
                action: selectedAction
            };

        } catch (error) {
            this.logger.error('[QuickAccess] Error showing QuickPick', error instanceof Error ? error : undefined);
            getToast()?.error(`Failed to show endpoint search: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return { action: 'cancelled' };
        }
    }

    /**
     * Show endpoint selection QuickPick
     * @returns Selected endpoint or undefined if cancelled
     */
    private async showEndpointPicker(): Promise<APIEndpointConfig | undefined> {
        const endpoints = await this.endpointManager.getAllEndpoints();

        if (endpoints.length === 0) {
            getToast()?.info('No endpoints available. Create an endpoint first.');
            return undefined;
        }

        const quickPick = vscode.window.createQuickPick<EndpointQuickPickItem>();
        quickPick.title = 'Search Endpoints';
        quickPick.placeholder = 'Type to search endpoints...';
        quickPick.matchOnDescription = true;
        quickPick.matchOnDetail = true;
        quickPick.canSelectMany = false;
        quickPick.items = this.createQuickPickItems(endpoints);

        return new Promise<APIEndpointConfig | undefined>(resolve => {
            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0];
                if (selected) {
                    this.logger.info(`[QuickAccess] Endpoint selected: ${selected.endpoint.name}`);
                    resolve(selected.endpoint);
                    quickPick.hide();
                }
            });

            quickPick.onDidHide(() => {
                resolve(undefined);
                setTimeout(() => quickPick.dispose(), 10);
            });

            quickPick.show();
        });
    }

    /**
     * Show action selection QuickPick
     * @param endpoint The selected endpoint
     * @returns Selected action
     */
    private async showActionPicker(endpoint: APIEndpointConfig): Promise<QuickAccessAction> {
        const quickPick = vscode.window.createQuickPick();
        quickPick.title = `What would you like to do with "${endpoint.name}"?`;
        quickPick.placeholder = 'Select an action...';
        quickPick.canSelectMany = false;

        // GitHub Issue #232: Simplified to Run (smart) + Edit
        quickPick.items = [
            {
                label: '$(play) Run',
                description: 'Execute this endpoint',
                detail: 'Auto-detects batch vs single execution'
            },
            {
                label: '$(edit) Edit Endpoint',
                description: 'Open endpoint configuration',
                detail: 'Modify endpoint settings and template'
            }
        ];

        return new Promise<QuickAccessAction>(resolve => {
            quickPick.onDidAccept(() => {
                const selected = quickPick.selectedItems[0];
                if (selected) {
                    let action: QuickAccessAction = 'cancelled';

                    if (selected.label.includes('Run')) {
                        action = 'run';
                    } else if (selected.label.includes('Edit')) {
                        action = 'edit';
                    }

                    this.logger.info(`[QuickAccess] Action selected: ${action}`);
                    resolve(action);
                    quickPick.hide();
                }
            });

            quickPick.onDidHide(() => {
                resolve('cancelled');
                setTimeout(() => quickPick.dispose(), 10);
            });

            quickPick.show();
        });
    }

    /**
     * Create QuickPick items for each endpoint
     */
    private createQuickPickItems(endpoints: APIEndpointConfig[]): EndpointQuickPickItem[] {
        return endpoints.map(endpoint => {
            const methodIcon = this.getMethodIcon(endpoint.method);

            return {
                label: `$(${methodIcon}) ${endpoint.name}`,
                description: `${endpoint.method} ${endpoint.path}`,
                detail: endpoint.folder ? `Folder: ${endpoint.folder}` : undefined,
                endpointId: endpoint.id,
                endpoint: endpoint,
                folderName: endpoint.folder
            };
        });
    }

    /**
     * Get VS Code icon name for HTTP method
     */
    private getMethodIcon(method: string): string {
        switch (method.toUpperCase()) {
            case 'GET':
                return 'arrow-down';
            case 'POST':
                return 'arrow-up';
            case 'PUT':
                return 'arrow-both';
            case 'DELETE':
                return 'trash';
            default:
                return 'globe';
        }
    }
}
