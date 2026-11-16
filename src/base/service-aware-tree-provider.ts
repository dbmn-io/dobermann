// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Service-Aware Tree Provider Base Class
 * 
 * Following Architecture.md - Service Integration patterns
 * Provides base functionality for tree providers that need access to the service container
 */

import * as vscode from 'vscode';
import { getToast } from '../services/notifications/get-toast';
import { ServiceAwareConfig } from './service-aware-base';
import { IServiceContainer } from '../container/service-container.interface';

export abstract class ServiceAwareTreeProvider<T extends vscode.TreeItem> implements vscode.TreeDataProvider<T> {
    private _onDidChangeTreeData: vscode.EventEmitter<T | undefined | null | void> = new vscode.EventEmitter<T | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<T | undefined | null | void> = this._onDidChangeTreeData.event;

    protected refreshCallCount: number = 0;
    protected getChildrenCallCount: number = 0;
    protected static readonly MAX_CALL_DEPTH = 50;
    private static readonly REFRESH_DEBOUNCE_MS = 200;
    private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    protected serviceContainer: IServiceContainer;
    protected extensionContext: vscode.ExtensionContext;
    protected componentName: string;
    protected enableLogging: boolean;

    constructor(config: ServiceAwareConfig) {
        this.serviceContainer = config.serviceContainer;
        this.extensionContext = config.extensionContext;
        this.componentName = config.componentName;
        this.enableLogging = config.enableLogging ?? false;
        this.log('Service-aware tree provider initialized');
    }

    /**
     * Log message with component name using professional logger
     */
    protected log(message: string): void {
        if (this.enableLogging) {
            import('../utils/logger-registry').then(({ LoggerRegistry }) => {
                const logger = LoggerRegistry.getDiagnosticLogger();
                logger.info(`[${this.componentName}] ${message}`);
            }).catch(() => {
                console.log(`[${this.componentName}] ${message}`);
            });
        }
    }

    /**
     * Log error with component name using professional logger
     */
    protected logError(message: string, error: Error): void {
        import('../utils/logger-registry').then(({ LoggerRegistry }) => {
            const logger = LoggerRegistry.getDiagnosticLogger();
            logger.error(`[${this.componentName}] ${message}`, error);
        }).catch(() => {
            console.error(`[${this.componentName}] ${message}`, error);
        });
    }

    /**
     * Refresh the tree data
     */
    refresh(): void {
        this.refreshCallCount++;
        this.log(`refresh() called (count: ${this.refreshCallCount})`);

        if (this.refreshCallCount > ServiceAwareTreeProvider.MAX_CALL_DEPTH) {
            this.logError(`CRITICAL: Refresh call count exceeded ${ServiceAwareTreeProvider.MAX_CALL_DEPTH}! Possible infinite recursion detected.`, new Error('Infinite recursion'));
            return; // Circuit breaker
        }

        // Reset counter after a brief delay to allow legitimate refreshes
        setTimeout(() => {
            if (this.refreshCallCount > 0) {
                this.refreshCallCount = Math.max(0, this.refreshCallCount - 1);
            }
        }, 1000);

        // Debounce: coalesce rapid-fire refresh calls into a single tree update
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
        }
        this.refreshDebounceTimer = setTimeout(() => {
            this.refreshDebounceTimer = null;
            this._onDidChangeTreeData.fire();
            this.log(`refresh() fire() completed (debounced)`);
        }, ServiceAwareTreeProvider.REFRESH_DEBOUNCE_MS);
    }

    /**
     * Get tree item representation
     */
    abstract getTreeItem(element: T): vscode.TreeItem;

    /**
     * Get children of tree item
     */
    abstract getChildren(element?: T): Promise<T[]>;

    /**
     * Protected method to safely get children with circuit breaker
     */
    protected async safeGetChildren(element?: T): Promise<T[]> {
        this.getChildrenCallCount++;
        const callId = `getChildren-${this.getChildrenCallCount}-${Date.now()}`;

        if (this.getChildrenCallCount > ServiceAwareTreeProvider.MAX_CALL_DEPTH) {
            this.logError(`CRITICAL: getChildren call count exceeded ${ServiceAwareTreeProvider.MAX_CALL_DEPTH}! Possible infinite recursion detected.`, new Error('Infinite recursion'));
            return this.createErrorItems('Too many calls detected');
        }

        // Reset counter after a brief delay
        setTimeout(() => {
            if (this.getChildrenCallCount > 0) {
                this.getChildrenCallCount = Math.max(0, this.getChildrenCallCount - 1);
            }
        }, 2000);

        try {
            return await this.getChildrenImplementation(element);
        } catch (error) {
            this.logError(`Critical error in getChildren`, error instanceof Error ? error : new Error(String(error)));
            
            // Show user-friendly error message
            getToast()?.error(
                `Dobermann: Tree provider error - ${error instanceof Error ? error.message : error}`
            );

            return this.createErrorItems('Error loading tree data');
        }
    }

    /**
     * Implementation of getChildren that subclasses must provide
     */
    protected abstract getChildrenImplementation(element?: T): Promise<T[]>;

    /**
     * Create error items for display in tree
     */
    protected abstract createErrorItems(message: string): T[];

    /**
     * Fire tree data change event
     */
    protected fireTreeDataChanged(element?: T): void {
        this._onDidChangeTreeData.fire(element);
    }

    /**
     * Dispose of resources
     */
    dispose(): void {
        if (this.refreshDebounceTimer) {
            clearTimeout(this.refreshDebounceTimer);
            this.refreshDebounceTimer = null;
        }
        this._onDidChangeTreeData.dispose();
    }
}