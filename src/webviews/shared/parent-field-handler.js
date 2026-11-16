// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Parent Field Handler
 *
 * Pure JavaScript utility for handling parent-child relationships in nested data structures.
 * Used by both frontend (webviews) and backend (services) for consistent parent field population.
 *
 * GitHub Issue #110: Parent field population for denormalized exports
 */

/**
 * Create a parent field handler instance
 * @returns {Object} Handler with methods for tracking and denormalizing parent fields
 */
function createParentFieldHandler() {
    // WeakMap to track parent-child relationships without mutating data
    const parentChildMap = new WeakMap();

    return {
        /**
         * Clear the parent-child map (call at start of extraction)
         */
        clear() {
            // WeakMap doesn't have a clear method, so create a new one
            // This is handled by creating a new handler instance
        },

        /**
         * Track parent-child relationship
         * @param {Object} child - Child object
         * @param {Object} parent - Parent object
         */
        trackParent(child, parent) {
            if (typeof child === 'object' && child !== null &&
                typeof parent === 'object' && parent !== null) {
                parentChildMap.set(child, parent);
            }
        },

        /**
         * Extract data at path with parent tracking
         * @param {Array} data - Array of data objects
         * @param {String} path - Dot-notation path (e.g., "data.ItemPackage")
         * @returns {Array} Extracted data with parent relationships tracked
         */
        extractAtPath(data, path) {
            if (path === 'root' || !path) {
                return data;
            }

            let extracted = [];
            for (let index = 0; index < data.length; index++) {
                const row = data[index];
                const result = this._extractSingleAtPath(row, path);
                if (result !== null) {
                    if (Array.isArray(result)) {
                        // For large arrays, use concat to avoid stack overflow
                        if (result.length > 100000) {
                            extracted = extracted.concat(result);
                        } else {
                            extracted.push(...result);
                        }
                    } else {
                        extracted.push(result);
                    }
                }
            }

            return extracted;
        },

        /**
         * Extract from single object with parent tracking (internal method)
         * @private
         */
        _extractSingleAtPath(obj, path) {
            const parts = path.split('.');
            let current = obj;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];

                if (current && typeof current === 'object' && part in current) {
                    current = current[part];

                    // Handle intermediate arrays - track parent relationships
                    if (Array.isArray(current) && i < parts.length - 1) {
                        const remainingPath = parts.slice(i + 1).join('.');
                        const extracted = [];

                        current.forEach((item) => {
                            const result = this._extractSingleAtPath(item, remainingPath);
                            if (result !== null) {
                                if (Array.isArray(result)) {
                                    result.forEach(child => {
                                        if (typeof child === 'object' && child !== null) {
                                            this.trackParent(child, item);
                                        }
                                    });
                                    extracted.push(...result);
                                } else {
                                    if (typeof result === 'object' && result !== null) {
                                        this.trackParent(result, item);
                                    }
                                    extracted.push(result);
                                }
                            }
                        });

                        return extracted.length > 0 ? extracted : null;
                    }
                } else {
                    return null;
                }
            }

            return current;
        },

        /**
         * Denormalize data with parent fields
         * @param {Object} childData - Child data object
         * @param {Function} inferDataType - Function to infer data type (string, number, object, array, etc.)
         * @param {String} levelPrefix - Level prefix (default: "parent_L1")
         * @returns {Object} Denormalized object with parent fields
         */
        denormalizeWithParentFields(childData, inferDataType, levelPrefix = 'parent_L1') {
            // If childData is not an object, return as-is
            if (typeof childData !== 'object' || childData === null) {
                return childData;
            }

            // Create a copy to avoid mutation
            const denormalized = { ...childData };

            // Look up parent in WeakMap
            const parentData = parentChildMap.get(childData);

            if (parentData && typeof parentData === 'object' && !Array.isArray(parentData)) {
                Object.keys(parentData).forEach(key => {
                    const value = parentData[key];
                    const fieldType = inferDataType(value);

                    // Only include simple fields (no nested objects/arrays)
                    if (fieldType !== 'object' && fieldType !== 'array') {
                        const parentFieldKey = `${levelPrefix}.${key}`;
                        denormalized[parentFieldKey] = value;
                    }
                });
            }

            return denormalized;
        }
    };
}

// Export for use in both browser and Node.js environments
if (typeof module !== 'undefined' && module.exports) {
    // Node.js/CommonJS
    module.exports = { createParentFieldHandler };
} else {
    // Browser/Global
    window.ParentFieldHandler = { createParentFieldHandler };
}
