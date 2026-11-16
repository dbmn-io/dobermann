// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Root Path Analyzer Service for Report Generation
 * Discovers and validates paths within response data structures
 * Part of Phase 6: Advanced Features - Root Node Selection
 */

export interface PathInfo {
    path: string;
    type: 'object' | 'array' | 'primitive';
    depth: number;
    itemCount?: number;
    recommended: boolean;
    description: string;
}

export interface RootPathAnalyzerConfig {
    maxDepth: number;
    minItemsForRecommendation: number;
    preferredPathNames: string[];
}

export class RootPathAnalyzerService {
    private config: RootPathAnalyzerConfig = {
        maxDepth: 5,
        minItemsForRecommendation: 1, // Lower threshold to catch single data arrays
        preferredPathNames: ['data', 'items', 'results', 'records', 'body', 'content', 'response', 'payload']
    };

    constructor(config?: Partial<RootPathAnalyzerConfig>) {
        if (config) {
            this.config = { ...this.config, ...config };
        }
    }

    /**
     * Discover all valid paths in the data structure
     */
    discoverPaths(data: any): PathInfo[] {
        const paths: PathInfo[] = [];
        
        // Always include root option
        paths.push({
            path: 'root',
            type: this.getDataType(data),
            depth: 0,
            itemCount: this.getItemCount(data),
            recommended: false,
            description: 'Full response (no extraction)'
        });

        if (!data || typeof data !== 'object') {
            return paths;
        }

        // Discover nested paths
        this.collectPaths(data, '', paths, 0);
        
        // Sort by recommendation priority, with "data" paths first
        return paths.sort((a, b) => {
            // Highest priority: "data" paths that are arrays
            const aIsDataArray = a.path.endsWith('.data') || a.path === 'data' && a.type === 'array';
            const bIsDataArray = b.path.endsWith('.data') || b.path === 'data' && b.type === 'array';
            
            if (aIsDataArray && !bIsDataArray) return -1;
            if (!aIsDataArray && bIsDataArray) return 1;
            
            // Next priority: recommended vs non-recommended
            if (a.recommended && !b.recommended) return -1;
            if (!a.recommended && b.recommended) return 1;
            
            // Finally by depth (closer to root first)
            return a.depth - b.depth;
        });
    }

    /**
     * Extract data at the specified path
     */
    extractAtPath(data: any, path: string): any {
        if (!data || path === 'root' || !path) {
            return data;
        }

        // Handle array of responses (common in batch scenarios)
        if (Array.isArray(data)) {
            return data.map(item => this.extractSingleAtPath(item, path))
                      .filter(result => result !== null);
        }

        return this.extractSingleAtPath(data, path);
    }

    /**
     * Validate if a path exists in the data
     */
    isValidPath(data: any, path: string): boolean {
        if (path === 'root' || !path) return true;
        
        try {
            const result = this.extractAtPath(data, path);
            return result !== null && result !== undefined;
        } catch {
            return false;
        }
    }

    /**
     * Get recommended root paths based on data analysis
     */
    getRecommendedPaths(data: any): string[] {
        const paths = this.discoverPaths(data);
        return paths.filter(p => p.recommended).map(p => p.path);
    }

    /**
     * Generate description for a path
     */
    getPathDescription(data: any, path: string): string {
        if (path === 'root') {
            return 'Full response (no extraction)';
        }

        const extractedData = this.extractAtPath(data, path);
        if (!extractedData) {
            return 'Path not found';
        }

        const type = this.getDataType(extractedData);
        const itemCount = this.getItemCount(extractedData);
        
        switch (type) {
            case 'array':
                return `Array with ${itemCount} items`;
            case 'object':
                return `Object with ${itemCount} properties`;
            case 'primitive':
                return `${typeof extractedData} value`;
            default:
                return 'Unknown structure';
        }
    }

    /**
     * Collect all valid paths recursively
     */
    private collectPaths(
        obj: any, 
        currentPath: string, 
        paths: PathInfo[], 
        depth: number
    ): void {
        if (depth >= this.config.maxDepth || !obj || typeof obj !== 'object') {
            return;
        }

        for (const [key, value] of Object.entries(obj)) {
            const path = currentPath ? `${currentPath}.${key}` : key;
            const type = this.getDataType(value);
            const itemCount = this.getItemCount(value);

            // Add this path if it's meaningful
            if (type === 'object' || type === 'array') {
                paths.push({
                    path,
                    type,
                    depth: depth + 1,
                    itemCount,
                    recommended: this.isRecommendedPath(key, value, itemCount),
                    description: this.generatePathDescription(key, value, itemCount)
                });

                // Recurse into objects and first array item
                if (type === 'object') {
                    this.collectPaths(value, path, paths, depth + 1);
                } else if (type === 'array' && Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                    this.collectPaths(value[0], path, paths, depth + 1);
                }
            }
        }
    }

    /**
     * Extract data from a single item at the specified path
     */
    private extractSingleAtPath(data: any, path: string): any {
        const parts = path.split('.');
        let current = data;

        for (const part of parts) {
            if (current && typeof current === 'object' && part in current) {
                current = current[part];
            } else {
                return null;
            }
        }

        return current;
    }

    /**
     * Determine data type
     */
    private getDataType(data: any): 'object' | 'array' | 'primitive' {
        if (Array.isArray(data)) return 'array';
        if (data && typeof data === 'object') return 'object';
        return 'primitive';
    }

    /**
     * Get item count for data
     */
    private getItemCount(data: any): number {
        if (Array.isArray(data)) return data.length;
        if (data && typeof data === 'object') return Object.keys(data).length;
        return 1;
    }

    /**
     * Determine if a path should be recommended
     */
    private isRecommendedPath(key: string, value: any, itemCount: number): boolean {
        // Highest priority: "data" key with array content (addresses issue #66)
        if (key.toLowerCase() === 'data' && Array.isArray(value) && value.length > 0) {
            return true;
        }

        // High priority: Check if key name is in preferred list
        if (this.config.preferredPathNames.includes(key.toLowerCase())) {
            return true;
        }

        // Medium priority: Recommend arrays with data
        if (Array.isArray(value) && value.length > 0) {
            return true;
        }

        // Lower priority: Recommend objects with multiple properties
        if (value && typeof value === 'object' && 
            itemCount >= this.config.minItemsForRecommendation) {
            return true;
        }

        return false;
    }

    /**
     * Generate description for a path
     */
    private generatePathDescription(key: string, value: any, itemCount: number): string {
        if (Array.isArray(value)) {
            return `Array: ${itemCount} items`;
        }
        
        if (value && typeof value === 'object') {
            return `Object: ${itemCount} properties`;
        }
        
        return `Value: ${typeof value}`;
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<RootPathAnalyzerConfig>): void {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Get current configuration
     */
    getConfig(): RootPathAnalyzerConfig {
        return { ...this.config };
    }
}