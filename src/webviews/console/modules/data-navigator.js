// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * GitHub Issue #197: Data Navigator Module
 *
 * Handles data path discovery and navigation for the execution report webview.
 * These functions analyze API response data to find navigable paths
 * (e.g., "data", "data.items") and recommend optimal viewing paths.
 *
 * Architecture Compliance:
 * - Extracted from inline JavaScript in report.html
 * - Follows same pattern as raw-tab-handler.js
 * - Pure functions with no dependencies on report.html globals
 */

class DataNavigator {
    /**
     * Discover all navigable data paths in a response object
     * @param {object} data - The response data to analyze
     * @param {number} maxDepth - Maximum depth to traverse (default 5)
     * @returns {Array} Array of path descriptors sorted by recommendation priority
     */
    discoverDataPaths(data, maxDepth = 5) {
        const paths = [];

        // Always include root option
        paths.push({
            path: 'root',
            type: this.getDataType(data),
            depth: 0,
            recommended: false,
            description: 'Full response (no extraction)'
        });

        if (!data || typeof data !== 'object') {
            return paths;
        }

        // Discover nested paths
        this._collectPaths(data, '', paths, 0, maxDepth);

        // Deduplicate paths to prevent invalid duplicates like "data.data"
        const seenPaths = new Set();
        const deduplicatedPaths = paths.filter(pathInfo => {
            if (seenPaths.has(pathInfo.path)) {
                console.warn(`Duplicate path found and removed: "${pathInfo.path}"`);
                return false;
            }
            seenPaths.add(pathInfo.path);
            return true;
        });

        // Sort by recommendation priority, with "data" paths first
        return deduplicatedPaths.sort((a, b) => {
            // Highest priority: "data" paths that are arrays
            const aIsDataArray = (a.path.endsWith('.data') || a.path === 'data') && a.type === 'array';
            const bIsDataArray = (b.path.endsWith('.data') || b.path === 'data') && b.type === 'array';

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
     * Recursively collect paths from an object
     */
    _collectPaths(obj, currentPath, paths, depth, maxDepth) {
        if (depth >= maxDepth || !obj || typeof obj !== 'object') {
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
                    recommended: this.isRecommendedPath(key, value, itemCount),
                    description: this._generatePathDescription(key, value, itemCount)
                });

                // Recurse into objects and first array item
                if (type === 'object') {
                    this._collectPaths(value, path, paths, depth + 1, maxDepth);
                } else if (type === 'array' && Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                    this._collectPaths(value[0], path, paths, depth + 1, maxDepth);
                }
            }
        }
    }

    /**
     * Get the data type of a value
     */
    getDataType(data) {
        if (Array.isArray(data)) return 'array';
        if (data === null || data === undefined) return 'primitive';
        if (typeof data === 'object') return 'object';
        return 'primitive';
    }

    /**
     * Get the item count of a value
     */
    getItemCount(data) {
        if (Array.isArray(data)) return data.length;
        if (data && typeof data === 'object') return Object.keys(data).length;
        return 0;
    }

    /**
     * Check if a path is recommended for viewing
     */
    isRecommendedPath(key, value, itemCount) {
        // Recommend array paths with reasonable size
        if (Array.isArray(value) && itemCount > 0 && itemCount < 10000) {
            return true;
        }

        // Recommend common data containers
        const commonContainers = ['data', 'items', 'results', 'records', 'rows'];
        return commonContainers.includes(key.toLowerCase());
    }

    /**
     * Generate a human-readable description for a path
     */
    _generatePathDescription(key, value, itemCount) {
        const type = this.getDataType(value);
        switch (type) {
            case 'array':
                return `Array with ${itemCount} items`;
            case 'object':
                return `Object with ${itemCount} properties`;
            default:
                return `${typeof value} value`;
        }
    }
}
