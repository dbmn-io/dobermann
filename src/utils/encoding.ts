// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Encoding utilities for JSON payload transformation (Issue #127)
 *
 * Provides BASE64 encoding with template marker detection for PubSub/message queue APIs
 */

export interface Base64EncodingResult {
    /** JSON with BASE64 encoding applied to marked fields */
    encodedJson: string;
    /** Original JSON without encoding (for debugging) */
    unencodedJson: string;
    /** List of keys that were encoded (e.g., ["data", "payload"]) */
    keysEncoded: string[];
    /** True if template contains key:BASE64 markers */
    hasEncodingMarkers: boolean;
}

/**
 * Detects and encodes JSON fields marked with key:BASE64 pattern
 *
 * Processing:
 * 1. Parses JSON to detect structure
 * 2. Recursively searches for keys matching pattern keyName:BASE64
 * 3. Extracts the value (must be object or array)
 * 4. BASE64 encodes the stringified value
 * 5. Replaces keyName:BASE64 with keyName and encoded string value
 *
 * Example:
 * Input:  { "data:BASE64": {"ItemId": "TEST1"} }
 * Output: { "data": "eyJJdGVtSWQiOiJURVNUMSJ9" }
 *
 * @param jsonString - JSON string with potential BASE64 markers (fully processed with variables replaced)
 * @returns Encoded and unencoded versions with metadata
 * @throws Error if JSON is invalid or encoding markers are malformed
 */
export function encodeBase64Fields(jsonString: string): Base64EncodingResult {
    const keysEncoded: string[] = [];

    // Parse JSON to detect structure
    let parsed: any;
    try {
        parsed = JSON.parse(jsonString);
    } catch (error) {
        throw new Error(`Invalid JSON for encoding: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Create deep copies for encoded/unencoded versions
    const unencodedObj = JSON.parse(JSON.stringify(parsed));
    const encodedObj = JSON.parse(JSON.stringify(parsed));

    // Recursively process object to find and encode marked fields
    const hasEncodingMarkers = processObjectForBase64(encodedObj, keysEncoded);

    // Serialize results (preserve 2-space indentation for readability)
    const encodedJson = JSON.stringify(encodedObj, null, 2);
    const unencodedJson = JSON.stringify(unencodedObj, null, 2);

    return {
        encodedJson,
        unencodedJson,
        keysEncoded,
        hasEncodingMarkers
    };
}

/**
 * Recursively processes object to encode fields marked with {{key:BASE64}}
 *
 * @param obj - Object to process (mutated in place)
 * @param keysEncoded - Array to collect encoded key names
 * @param path - Current JSON path (for error reporting)
 * @returns True if any encoding markers were found
 */
function processObjectForBase64(
    obj: any,
    keysEncoded: string[],
    path: string = ''
): boolean {
    let foundMarkers = false;

    if (typeof obj !== 'object' || obj === null) {
        return false;
    }

    // Process arrays
    if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            const itemPath = `${path}[${i}]`;
            const found = processObjectForBase64(obj[i], keysEncoded, itemPath);
            foundMarkers = foundMarkers || found;
        }
        return foundMarkers;
    }

    // Process objects - look for encoding markers
    const keysToReplace: Array<{oldKey: string; newKey: string; encodedValue: string}> = [];

    for (const key in obj) {
        const value = obj[key];
        const currentPath = path ? `${path}.${key}` : key;

        // Check if key matches keyName:BASE64 pattern
        const markerMatch = key.match(/^([^:]+):BASE64$/);

        if (markerMatch) {
            // Found encoding marker!
            foundMarkers = true;
            const targetKey = markerMatch[1]; // Extract "data" from "data:BASE64"

            // Validate that value is object or array (not primitive)
            if (typeof value !== 'object' || value === null) {
                throw new Error(
                    `Encoding marker on primitive value at ${currentPath}. ` +
                    `Encoding markers can only be applied to objects or arrays, not: ${typeof value}`
                );
            }

            // BASE64 encode the JSON stringified value
            const jsonToEncode = JSON.stringify(value);
            const encodedValue = utf8ToBase64(jsonToEncode);

            // Mark for replacement (can't modify object while iterating)
            keysToReplace.push({
                oldKey: key,
                newKey: targetKey,
                encodedValue: encodedValue
            });

            keysEncoded.push(targetKey);
        } else {
            // Regular key - recurse into nested structures
            if (typeof value === 'object' && value !== null) {
                const found = processObjectForBase64(value, keysEncoded, currentPath);
                foundMarkers = foundMarkers || found;
            }
        }
    }

    // Apply replacements (replace {{key:BASE64}} with key and encoded value)
    for (const replacement of keysToReplace) {
        delete obj[replacement.oldKey];
        obj[replacement.newKey] = replacement.encodedValue;
    }

    return foundMarkers;
}

/**
 * Decodes BASE64 encoded fields back to original JSON objects
 *
 * Note: This is for debugging/testing purposes. The extension does not
 * decode API responses (as per requirements - Issue #127).
 *
 * @param jsonString - JSON string with BASE64 encoded field values
 * @returns JSON string with decoded values
 */
export function decodeBase64Fields(jsonString: string): string {
    let parsed: any;
    try {
        parsed = JSON.parse(jsonString);
    } catch (error) {
        throw new Error(`Invalid JSON for decoding: ${error instanceof Error ? error.message : String(error)}`);
    }

    decodeObjectBase64(parsed);
    return JSON.stringify(parsed, null, 2);
}

/**
 * Recursively decodes BASE64 encoded string values back to JSON objects
 *
 * @param obj - Object to process (mutated in place)
 */
function decodeObjectBase64(obj: any): void {
    if (typeof obj !== 'object' || obj === null) {
        return;
    }

    if (Array.isArray(obj)) {
        for (const item of obj) {
            decodeObjectBase64(item);
        }
        return;
    }

    for (const key in obj) {
        const value = obj[key];

        if (typeof value === 'string') {
            // Try to decode - if successful and valid JSON, replace
            try {
                const decoded = base64ToUtf8(value);

                // Check if decoded string is valid JSON
                try {
                    const parsedDecoded = JSON.parse(decoded);
                    obj[key] = parsedDecoded; // Replace with decoded object
                } catch {
                    // Not JSON - leave as BASE64 string
                }
            } catch {
                // Not valid BASE64 - leave as is
            }
        } else if (typeof value === 'object' && value !== null) {
            decodeObjectBase64(value);
        }
    }
}

/**
 * Calculates the byte size of a JSON string (for file size display)
 *
 * @param jsonString - JSON string to measure
 * @returns Size in bytes
 */
export function calculateJsonSize(jsonString: string): number {
    return new TextEncoder().encode(jsonString).length;
}

/**
 * Formats byte size for human-readable display
 *
 * @param bytes - Size in bytes
 * @returns Formatted string (e.g., "3.2 KB", "1.5 MB")
 */
export function formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';

    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    const size = bytes / Math.pow(k, i);

    return `${size.toFixed(1)} ${units[i]}`;
}

/** UTF-8 text as base64, in any host (no Node Buffer). */
export function utf8ToBase64(text: string): string {
    let binary = '';
    new TextEncoder().encode(text).forEach(byte => { binary += String.fromCharCode(byte); });
    return btoa(binary);
}

/** Base64 back to UTF-8 text. Throws on input that isn't base64. */
export function base64ToUtf8(value: string): string {
    return new TextDecoder().decode(Uint8Array.from(atob(value), c => c.charCodeAt(0)));
}
