// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * JSON Comment Stripper Utility
 *
 * Removes JSON comments (both single-line and multi-line)
 * while preserving string content and handling edge cases.
 *
 * This enables JSON with Comments (JSONC) support in templates while
 * ensuring clean JSON is sent to APIs.
 */

/**
 * Strips comments from JSON string, handling edge cases like comments in strings
 * @param jsonString - The JSON string potentially containing comments
 * @returns Clean JSON string with comments removed
 */
export function stripJsonComments(jsonString: string): string {
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
 * Strips comments and validates that the result is valid JSON
 * @param jsonString - The JSON string potentially containing comments
 * @returns Clean, validated JSON string
 * @throws Error if the result is not valid JSON
 */
export function stripAndValidateJson(jsonString: string): string {
    const stripped = stripJsonComments(jsonString);

    try {
        // Validate that the stripped result is valid JSON
        JSON.parse(stripped);
        return stripped;
    } catch (error) {
        throw new Error(`Invalid JSON after comment removal: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

/**
 * Safe version that returns the original string if stripping fails
 * @param jsonString - The JSON string potentially containing comments
 * @returns Clean JSON string, or original string if processing fails
 */
export function stripJsonCommentsSafe(jsonString: string): string {
    try {
        return stripAndValidateJson(jsonString);
    } catch (error) {
        console.warn('Failed to strip JSON comments, using original:', error);
        return jsonString;
    }
}