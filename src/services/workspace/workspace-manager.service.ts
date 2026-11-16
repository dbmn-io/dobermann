// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import * as vscode from 'vscode';
import { getToast } from '../notifications/get-toast';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import { DATA_DIR, parseWorkspaceMarker, WORKSPACE_MARKER, type WorkspaceMarker } from './workspace-layout';
import { moveLegacyDataDir } from './move-data-dir';

/**
 * Manages Dobermann's dedicated workspace folder, independent of VS Code's workspace
 * Following Architecture.md - Service interface patterns with proper DI support
 */
export interface IWorkspaceManagerService {
    /**
     * Initialize the workspace manager and ensure Dobermann workspace exists
     */
    initialize(): Promise<void>;

    /**
     * Get the Dobermann workspace folder URI
     */
    getWorkspaceUri(): vscode.Uri | null;

    /**
     * Get the Dobermann workspace folder path as string
     */
    getWorkspacePath(): string | null;

    /**
     * Check if Dobermann workspace is configured and accessible
     */
    isWorkspaceAvailable(): boolean;

    /**
     * Prompt user to select/create Dobermann workspace folder
     */
    selectWorkspaceFolder(): Promise<boolean>;

    /**
     * Open the Dobermann workspace in VS Code
     */
    openWorkspace(): Promise<void>;

    /**
     * Get a subdirectory within the Dobermann workspace (creates if needed)
     */
    getSubDirectory(subPath: string): Promise<vscode.Uri>;

    /**
     * Reset the workspace selection (for troubleshooting)
     */
    resetWorkspace(): Promise<void>;
}

export class WorkspaceManagerService implements IWorkspaceManagerService {
    private static readonly STORAGE_KEY = 'dbmn.workspacePath';
    private static readonly DEFAULT_FOLDER_NAME = 'Dobermann-Workspace';
    private static readonly LEGACY_FOLDER_NAME = 'Active8-Workspace';

    private workspaceUri: vscode.Uri | null = null;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    async initialize(): Promise<void> {
        // Try to load previously selected workspace
        const savedPath = this.context.globalState.get<string>(WorkspaceManagerService.STORAGE_KEY);
        
        if (savedPath) {
            try {
                this.workspaceUri = vscode.Uri.file(savedPath);
                
                // Verify the workspace still exists and is accessible
                await vscode.workspace.fs.stat(this.workspaceUri);
                
                // DBMN's own folder (.dbmn: moved from .active8, #344) and the workspace marker
                await this.ensureDobermannDirectory();
                
                return;
            } catch (error) {
                // Saved workspace no longer accessible, clear it
                await this.context.globalState.update(WorkspaceManagerService.STORAGE_KEY, undefined);
                this.workspaceUri = null;
            }
        }

        // Try to auto-migrate from legacy Active8 workspace
        const migrated = await this.migrateFromActive8();
        if (migrated) {
            return;
        }

        // No valid workspace configured - this is first run, prompt user
        const userSelected = await this.promptForWorkspaceSetup();
        
        if (!userSelected) {
            // User cancelled or dismissed - proceed with default and inform them
            await this.createDefaultWorkspace();
            getToast()?.info('Dobermann workspace created at ~/Dobermann-Workspace. You can change this anytime by right-clicking the status bar.');
        }
    }

    getWorkspaceUri(): vscode.Uri | null {
        return this.workspaceUri;
    }

    getWorkspacePath(): string | null {
        return this.workspaceUri?.fsPath || null;
    }

    isWorkspaceAvailable(): boolean {
        return this.workspaceUri !== null;
    }

    async selectWorkspaceFolder(): Promise<boolean> {
        const options: vscode.OpenDialogOptions = {
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: 'Select Dobermann Workspace Folder',
            title: 'Choose where Dobermann should store files',
            defaultUri: vscode.Uri.file(os.homedir())
        };

        const result = await vscode.window.showOpenDialog(options);
        
        if (result && result.length > 0) {
            const selectedUri = result[0];
            
            try {
                // Test write access
                const testFile = vscode.Uri.joinPath(selectedUri, '.dbmn-test');
                await vscode.workspace.fs.writeFile(testFile, Buffer.from('test'));
                await vscode.workspace.fs.delete(testFile);
                
                // Save the workspace selection
                this.workspaceUri = selectedUri;
                await this.context.globalState.update(WorkspaceManagerService.STORAGE_KEY, selectedUri.fsPath);
                
                // DBMN's own folder (.dbmn: moved from .active8, #344) and the workspace marker
                await this.ensureDobermannDirectory();
                
                getToast()?.info(`✅ Dobermann workspace set to: ${selectedUri.fsPath}`);
                return true;
                
            } catch (error) {
                getToast()?.error(`Cannot write to selected folder: ${error instanceof Error ? error.message : 'Unknown error'}`);
                return false;
            }
        }
        
        return false;
    }

    async openWorkspace(): Promise<void> {
        if (!this.workspaceUri) {
            const selected = await this.selectWorkspaceFolder();
            if (!selected) {
                throw new Error('No workspace folder selected');
            }
        }

        // Open the Dobermann workspace in VS Code
        await vscode.commands.executeCommand('vscode.openFolder', this.workspaceUri, false);
    }

    async getSubDirectory(subPath: string): Promise<vscode.Uri> {
        if (!this.workspaceUri) {
            throw new Error('Dobermann workspace not configured');
        }

        const subUri = vscode.Uri.joinPath(this.workspaceUri, DATA_DIR, subPath);
        
        try {
            await vscode.workspace.fs.createDirectory(subUri);
        } catch (error) {
            // Directory might already exist, which is fine
        }
        
        return subUri;
    }

    async resetWorkspace(): Promise<void> {
        await this.context.globalState.update(WorkspaceManagerService.STORAGE_KEY, undefined);
        this.workspaceUri = null;
        
        getToast()?.info('Dobermann workspace selection has been reset. Please select a new workspace folder.');
    }

    /**
     * Auto-detect and adopt legacy Active8 workspace if it exists
     */
    private async migrateFromActive8(): Promise<boolean> {
        try {
            const homeDir = os.homedir();
            const legacyWorkspaceUri = vscode.Uri.file(
                path.join(homeDir, WorkspaceManagerService.LEGACY_FOLDER_NAME)
            );
            const legacyDobermannDir = vscode.Uri.joinPath(legacyWorkspaceUri, '.active8');

            // Check if legacy workspace with .active8 directory exists
            await vscode.workspace.fs.stat(legacyDobermannDir);

            // Legacy workspace found - adopt it
            this.workspaceUri = legacyWorkspaceUri;
            await this.context.globalState.update(WorkspaceManagerService.STORAGE_KEY, legacyWorkspaceUri.fsPath);

            getToast()?.info(`Dobermann detected your existing Active8 workspace at ~/${WorkspaceManagerService.LEGACY_FOLDER_NAME} and will use it automatically.`);

            return true;
        } catch {
            // Legacy workspace not found - that's fine
            return false;
        }
    }

    private async promptForWorkspaceSetup(): Promise<boolean> {
        const choice = await vscode.window.showQuickPick([
            {
                label: '$(folder-opened) Use default location',
                description: `${os.homedir()}/${WorkspaceManagerService.DEFAULT_FOLDER_NAME}`,
                detail: 'Recommended - Creates a dedicated Dobermann folder in your home directory',
                id: 'default'
            },
            {
                label: '$(folder) Choose custom location...',
                description: 'Browse and select where to store Dobermann files',
                detail: 'You can select any folder you have write access to',
                id: 'custom'
            },
            {
                label: '$(folder-library) Use existing Active8 workspace...',
                description: 'Browse for your previous Active8 workspace folder',
                detail: 'Select your existing Active8-Workspace folder to keep all your data',
                id: 'legacy'
            }
        ], {
            title: 'Select Dobermann Workspace Location',
            placeHolder: 'Dobermann needs a dedicated folder to store API execution results, logs, and temporary files. This keeps your project folders clean.',
            ignoreFocusOut: true
        });

        if (!choice) {
            return false; // User cancelled
        }

        if (choice.id === 'default') {
            return await this.createDefaultWorkspace();
        } else if (choice.id === 'legacy') {
            return await this.selectWorkspaceFolder();
        } else {
            return await this.selectWorkspaceFolder();
        }
    }

    private async createDefaultWorkspace(): Promise<boolean> {
        try {
            const homeDir = os.homedir();
            const defaultWorkspaceUri = vscode.Uri.file(path.join(homeDir, WorkspaceManagerService.DEFAULT_FOLDER_NAME));
            
            // Try to create the default workspace folder
            await vscode.workspace.fs.createDirectory(defaultWorkspaceUri);
            
            // Test write access
            const testFile = vscode.Uri.joinPath(defaultWorkspaceUri, '.dbmn-test');
            await vscode.workspace.fs.writeFile(testFile, Buffer.from('test'));
            await vscode.workspace.fs.delete(testFile);
            
            // Auto-configure this as the workspace
            this.workspaceUri = defaultWorkspaceUri;
            await this.context.globalState.update(WorkspaceManagerService.STORAGE_KEY, defaultWorkspaceUri.fsPath);
            
            // DBMN's own folder (.dbmn: moved from .active8, #344) and the workspace marker
            await this.ensureDobermannDirectory();
            
            return true;
            
        } catch (error) {
            getToast()?.error(`Failed to create default workspace: ${error instanceof Error ? error.message : 'Unknown error'}`);
            return false;
        }
    }

    /**
     * DBMN's own folder in the workspace (#344): `.dbmn`, moved from `.active8` the first time,
     * with `.active8` left as a link so older versions share the same history (move-data-dir.ts).
     * Then the marker that tells the web app this is the right folder.
     */
    private async ensureDobermannDirectory(): Promise<void> {
        if (!this.workspaceUri) return;
        const root = this.workspaceUri.fsPath;
        try {
            const outcome = moveLegacyDataDir(root);
            if (outcome === 'moved') console.log(`[Workspace] moved ${root}/.active8 to .dbmn (older versions use it through the .active8 link)`);
            if (outcome === 'linked-back') console.warn(`[Workspace] could not rename ${root}/.active8 yet (in use?): .dbmn links to it; the move finishes on a later start`);
            if (outcome === 'both-exist') console.warn(`[Workspace] ${root} has both .active8 and .dbmn as folders: left alone, using .dbmn`);
        } catch (error) {
            console.error('[Workspace] could not prepare .dbmn', error);
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.workspaceUri, DATA_DIR)).then(undefined, () => undefined);
        }
        this.marker = this.readOrWriteMarker(root);
    }

    private marker: WorkspaceMarker | undefined;

    /** `.dbmn/workspace.json`: which DBMN workspace this folder is (#344). */
    getWorkspaceMarker(): WorkspaceMarker | undefined {
        return this.marker;
    }

    private readOrWriteMarker(root: string): WorkspaceMarker | undefined {
        const file = path.join(root, DATA_DIR, WORKSPACE_MARKER);
        try {
            const existing = fs.existsSync(file) ? parseWorkspaceMarker(fs.readFileSync(file, 'utf8')) : undefined;
            if (existing) return existing;
            const marker: WorkspaceMarker = { id: randomUUID(), name: path.basename(root), createdAt: new Date().toISOString(), createdOn: vscode.env.machineId };
            fs.writeFileSync(file, JSON.stringify(marker, null, 2));
            return marker;
        } catch (error) {
            console.warn('[Workspace] could not read or write the workspace marker', error);
            return undefined;
        }
    }
}
