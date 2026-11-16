// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * VS Code Test Environment Setup
 * 
 * Provides abstraction for @vscode/test-electron to ensure consistent
 * test environment setup across all integration tests.
 */

import * as vscode from 'vscode';
import { runTests } from '@vscode/test-electron';
import * as path from 'path';

export interface VSCodeTestConfig {
    /** Path to VS Code executable (optional - will download if not provided) */
    vscodeExecutablePath?: string;
    /** VS Code version to test against */
    version?: string;
    /** Additional extensions to install */
    extensions?: string[];
    /** Test workspace path */
    workspacePath?: string;
    /** Launch arguments for VS Code */
    launchArgs?: string[];
}

export class VSCodeTestEnvironment {
    private config: VSCodeTestConfig;
    private extensionDevelopmentPath: string;
    private extensionTestsPath: string;

    constructor(config: VSCodeTestConfig = {}) {
        this.config = {
            version: 'stable',
            extensions: [],
            launchArgs: ['--disable-extensions'],
            ...config
        };
        
        // Set paths relative to project root
        this.extensionDevelopmentPath = path.resolve(__dirname, '../../../');
        this.extensionTestsPath = path.resolve(__dirname, '../integration');
    }

    /**
     * Run integration tests in VS Code environment
     */
    async runIntegrationTests(): Promise<void> {
        try {
            // Download and run VS Code with our extension loaded
            await runTests({
                vscodeExecutablePath: this.config.vscodeExecutablePath,
                version: this.config.version,
                extensionDevelopmentPath: this.extensionDevelopmentPath,
                extensionTestsPath: this.extensionTestsPath,
                launchArgs: [
                    ...(this.config.launchArgs || []),
                    ...(this.config.workspacePath ? [this.config.workspacePath] : [])
                ]
            });
        } catch (err) {
            console.error('Failed to run tests:', err);
            process.exit(1);
        }
    }

    /**
     * Setup test workspace with sample files
     */
    async setupTestWorkspace(workspacePath: string): Promise<void> {
        const fs = require('fs').promises;
        const workspaceDir = path.resolve(__dirname, '../fixtures/test-workspaces', workspacePath);
        
        // Ensure workspace directory exists
        await fs.mkdir(workspaceDir, { recursive: true });
        
        // Create sample CSV file for testing
        const csvContent = `name,email,age
John Doe,john@example.com,30
Jane Smith,jane@example.com,25
Bob Wilson,bob@example.com,35`;
        
        await fs.writeFile(path.join(workspaceDir, 'test-data.csv'), csvContent);
        
        // Create VS Code workspace file
        const workspaceConfig = {
            folders: [{ path: '.' }],
            settings: {
                'dbmn.autoSave': false,
                'dbmn.debugMode': true
            }
        };
        
        await fs.writeFile(
            path.join(workspaceDir, 'test-workspace.code-workspace'),
            JSON.stringify(workspaceConfig, null, 2)
        );
    }

    /**
     * Cleanup test workspace
     */
    async cleanupTestWorkspace(workspacePath: string): Promise<void> {
        const fs = require('fs').promises;
        const workspaceDir = path.resolve(__dirname, '../fixtures/test-workspaces', workspacePath);
        
        try {
            await fs.rmdir(workspaceDir, { recursive: true });
        } catch (err) {
            // Ignore cleanup errors
            console.warn('Failed to cleanup test workspace:', err);
        }
    }

    /**
     * Wait for extension to be activated
     */
    async waitForExtensionActivation(extensionId: string = 'dobermann', timeout: number = 10000): Promise<vscode.Extension<any>> {
        const start = Date.now();
        
        while (Date.now() - start < timeout) {
            const extension = vscode.extensions.getExtension(extensionId);
            if (extension?.isActive) {
                return extension;
            }
            
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        throw new Error(`Extension ${extensionId} not activated within ${timeout}ms`);
    }

    /**
     * Get extension API for testing
     */
    async getExtensionAPI(): Promise<any> {
        const extension = await this.waitForExtensionActivation();
        return extension.exports;
    }

    /**
     * Setup test environment before running tests
     */
    static async setupBeforeAll(): Promise<void> {
        // Ensure test directories exist
        const fs = require('fs').promises;
        const fixturesDir = path.resolve(__dirname, '../fixtures/test-workspaces');
        await fs.mkdir(fixturesDir, { recursive: true });
    }

    /**
     * Cleanup test environment after running tests
     */
    static async teardownAfterAll(): Promise<void> {
        // Cleanup any global test state
        const fs = require('fs').promises;
        const fixturesDir = path.resolve(__dirname, '../fixtures/test-workspaces');
        
        try {
            await fs.rmdir(fixturesDir, { recursive: true });
        } catch (err) {
            // Ignore cleanup errors
            console.warn('Failed to cleanup test fixtures:', err);
        }
    }
}

/**
 * Test runner configuration for different test suites
 */
export class TestSuiteRunner {
    /**
     * Run user journey tests
     */
    static async runUserJourneyTests(): Promise<void> {
        const testEnv = new VSCodeTestEnvironment({
            version: 'stable',
            workspacePath: path.resolve(__dirname, '../fixtures/test-workspaces/user-journey'),
            launchArgs: ['--disable-extensions', '--disable-workspace-trust']
        });

        await testEnv.setupTestWorkspace('user-journey');
        await testEnv.runIntegrationTests();
        await testEnv.cleanupTestWorkspace('user-journey');
    }

    /**
     * Run webview interaction tests
     */
    static async runWebviewTests(): Promise<void> {
        const testEnv = new VSCodeTestEnvironment({
            version: 'stable',
            workspacePath: path.resolve(__dirname, '../fixtures/test-workspaces/webview-tests'),
            launchArgs: ['--disable-extensions', '--disable-workspace-trust']
        });

        await testEnv.setupTestWorkspace('webview-tests');
        await testEnv.runIntegrationTests();
        await testEnv.cleanupTestWorkspace('webview-tests');
    }

    /**
     * Run command execution tests
     */
    static async runCommandTests(): Promise<void> {
        const testEnv = new VSCodeTestEnvironment({
            version: 'stable',
            workspacePath: path.resolve(__dirname, '../fixtures/test-workspaces/command-tests'),
            launchArgs: ['--disable-extensions', '--disable-workspace-trust']
        });

        await testEnv.setupTestWorkspace('command-tests');
        await testEnv.runIntegrationTests();
        await testEnv.cleanupTestWorkspace('command-tests');
    }
}