// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Path resolver utility for handling different build environments
 * 
 * Development/Testing: Uses 'out' directory (TypeScript compilation)
 * Production: Uses 'dist' directory (webpack bundling)
 */

import * as path from 'path';
import * as fs from 'fs';

export class PathResolver {
    private static buildDir: string | null = null;

    /**
     * Get the correct build directory (out or dist) based on which contains webview files
     */
    private static getBuildDirectory(extensionPath: string): string {
        if (this.buildDir !== null) {
            return this.buildDir;
        }

        // Check which directory actually contains webview HTML files
        const distWebviewPath = path.join(extensionPath, 'dist', 'webviews', 'environment', 'environment.html');
        const outWebviewPath = path.join(extensionPath, 'out', 'webviews', 'environment', 'environment.html');

        console.log(`PathResolver: Checking for webview files:`);
        console.log(`  - dist: ${fs.existsSync(distWebviewPath)}`);
        console.log(`  - out: ${fs.existsSync(outWebviewPath)}`);

        if (fs.existsSync(distWebviewPath)) {
            this.buildDir = 'dist';
            console.log(`PathResolver: Using 'dist' directory (has webview files)`);
            return 'dist';
        } else if (fs.existsSync(outWebviewPath)) {
            this.buildDir = 'out';
            console.log(`PathResolver: Using 'out' directory (has webview files)`);
            return 'out';
        }

        // Fallback to 'out' for development
        this.buildDir = 'out';
        console.log(`PathResolver: Defaulting to 'out' directory (fallback)`);
        return 'out';
    }

    /**
     * Get the webviews path for the current environment
     */
    static getWebviewsPath(extensionPath: string, ...pathSegments: string[]): string {
        const buildDir = this.getBuildDirectory(extensionPath);
        return path.join(extensionPath, buildDir, 'webviews', ...pathSegments);
    }

    /**
     * Reset the cached build directory (useful for testing)
     */
    static resetCache(): void {
        this.buildDir = null;
    }
}