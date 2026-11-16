// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Shared Query Parameter Building Logic (GitHub Issue #108)
 *
 * This module contains the single source of truth for building query strings
 * from CSV data using repeatable query parameter patterns.
 *
 * Used by:
 * - Frontend: Preview in CSV modal Step 4
 * - Backend: Actual transaction preparation and execution
 *
 * Pattern format: "key={{variable}}[ separator ]"
 * Example: "itemId={{item}}[ or ]"
 * Result: "itemId=ITM001 or itemId=ITM002 or itemId=ITM003"
 */

/**
 * Build query string from values by applying pattern to each value
 *
 * @param {string} pattern - Template pattern with variable placeholder (e.g., "itemId={{item}}")
 * @param {string} variableName - Variable name to replace (e.g., "item")
 * @param {string[]} values - Array of values to insert (e.g., ["ITM001", "ITM002"])
 * @param {string} separator - String to join values (e.g., " or ")
 * @returns {string} Computed query string (e.g., "itemId=ITM001 or itemId=ITM002")
 *
 * @example
 * buildQueryString("itemId={{item}}", "item", ["ITM001", "ITM002"], " or ")
 * // Returns: "itemId=ITM001 or itemId=ITM002"
 */
function buildQueryString(pattern, variableName, values, separator) {
    if (!values || values.length === 0) {
        return '';
    }

    // GitHub Issue #170: Pre-compile regex ONCE before loop for O(n) instead of O(n²)
    const regex = new RegExp(`\\{\\{${variableName}\\}\\}`, 'g');

    // Apply pattern to each value
    const queryParts = values.map(value => {
        // Replace {{variableName}} with the actual value
        return pattern.replace(regex, value);
    });

    // Join with separator
    return queryParts.join(separator);
}

// Export for use in both frontend and backend environments
if (typeof module !== 'undefined' && module.exports) {
    // Node.js environment (backend)
    module.exports = { buildQueryString };
} else {
    // Browser environment (frontend)
    window.queryParamBuilder = { buildQueryString };
}
