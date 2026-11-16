// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JSON Comment Stripper Utility - Frontend Version
 *
 * Removes JSON comments (both single-line and multi-line)
 * while preserving string content and handling edge cases.
 *
 * This is a simplified JavaScript version for use in webviews.
 */

/**
 * Strips comments from JSON string, handling edge cases like comments in strings
 * @param {string} jsonString - The JSON string potentially containing comments
 * @returns {string} Clean JSON string with comments removed
 */
function stripJsonComments(jsonString) {
    if (!jsonString || typeof jsonString !== 'string') {
        return jsonString;
    }

    let result = '';
    let i = 0;
    let inString = false;
    let stringChar = '';
    let inSingleLineComment = false;
    let inMultiLineComment = false;

    while (i < jsonString.length) {
        const char = jsonString[i];
        const nextChar = i + 1 < jsonString.length ? jsonString[i + 1] : '';

        // Handle string boundaries
        if (!inSingleLineComment && !inMultiLineComment) {
            if (!inString && (char === '"' || char === "'")) {
                inString = true;
                stringChar = char;
                result += char;
                i++;
                continue;
            } else if (inString && char === stringChar) {
                // Check if it's escaped
                let backslashCount = 0;
                let j = i - 1;
                while (j >= 0 && jsonString[j] === '\\') {
                    backslashCount++;
                    j--;
                }
                // If even number of backslashes (including 0), the quote is not escaped
                if (backslashCount % 2 === 0) {
                    inString = false;
                    stringChar = '';
                }
                result += char;
                i++;
                continue;
            }
        }

        // If we're in a string, just copy the character
        if (inString) {
            result += char;
            i++;
            continue;
        }

        // Handle comment start/end
        if (!inSingleLineComment && !inMultiLineComment) {
            // Start of single-line comment
            if (char === '/' && nextChar === '/') {
                inSingleLineComment = true;
                i += 2; // Skip both characters
                continue;
            }
            // Start of multi-line comment
            if (char === '/' && nextChar === '*') {
                inMultiLineComment = true;
                i += 2; // Skip both characters
                continue;
            }
        }

        // Handle comment endings
        if (inSingleLineComment) {
            if (char === '\n' || char === '\r') {
                inSingleLineComment = false;
                // Preserve newline for formatting
                result += char;
            }
            i++;
            continue;
        }

        if (inMultiLineComment) {
            if (char === '*' && nextChar === '/') {
                inMultiLineComment = false;
                i += 2; // Skip both characters
                continue;
            }
            i++;
            continue;
        }

        // Normal character outside comments
        result += char;
        i++;
    }

    return result;
}

/**
 * Safe version that returns the original string if stripping fails
 * @param {string} jsonString - The JSON string potentially containing comments
 * @returns {string} Clean JSON string, or original string if processing fails
 */
function stripJsonCommentsSafe(jsonString) {
    // Handle empty or invalid inputs
    if (!jsonString || typeof jsonString !== 'string') {
        return jsonString || '';
    }

    const trimmed = jsonString.trim();
    if (trimmed === '') {
        return '';
    }

    try {
        const stripped = stripJsonComments(jsonString);
        const trimmedStripped = stripped.trim();

        // Don't validate empty strings as JSON
        if (trimmedStripped === '') {
            return trimmedStripped;
        }

        // Validate that the stripped result is valid JSON
        JSON.parse(stripped);
        return stripped;
    } catch {
        // Silently return original - invalid JSON is expected during editing
        return jsonString;
    }
}

// Export for module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { stripJsonComments, stripJsonCommentsSafe };
}

// Make available globally for webview usage
if (typeof window !== 'undefined') {
    window.stripJsonComments = stripJsonComments;
    window.stripJsonCommentsSafe = stripJsonCommentsSafe;
}