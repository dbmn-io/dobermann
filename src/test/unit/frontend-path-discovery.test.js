// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Test the frontend path discovery function that runs in the webview
// This will help us understand why data.data is being created

const githubResponse = {
    "executionId": "2025-09-19T06-19-56_61r",
    "duration": 879,
    "httpStatus": 200,
    "httpStatusText": "OK",
    "headers": {
        "access-control-allow-origin": "*",
        "content-type": "application/json; charset=utf-8",
        "x-ratelimit-limit": "5000"
    },
    "data": {
        "login": "JamesForan",
        "id": 34524260,
        "node_id": "MDQ6VXNlcjM0NTI0MjYw",
        "name": "James Foran",
        "company": "Flexion Tech",
        "blog": "http://flexion.tech",
        "email": "alex@example.com",
        "public_repos": 16,
        "followers": 4,
        "following": 17,
        "plan": {
            "name": "free",
            "space": 976562499,
            "collaborators": 0,
            "private_repos": 10000
        }
    },
    "metadata": {
        "requestId": "test-123",
        "timestamp": "2025-09-19T06:19:56Z",
        "version": "1.0"
    }
};

// Copy the frontend functions from report.html
function getDataType(data) {
    if (Array.isArray(data)) return 'array';
    if (data && typeof data === 'object') return 'object';
    return 'primitive';
}

function getItemCount(data) {
    if (Array.isArray(data)) return data.length;
    if (data && typeof data === 'object') return Object.keys(data).length;
    return 1;
}

function isRecommendedPath(key, value, itemCount) {
    // Highest priority: "data" key with array content
    if (key.toLowerCase() === 'data' && Array.isArray(value) && value.length > 0) {
        return true;
    }

    // High priority: Check if key name is in preferred list
    const preferredPathNames = ['data', 'items', 'results', 'records', 'body', 'content', 'response', 'payload'];
    if (preferredPathNames.includes(key.toLowerCase())) {
        return true;
    }

    // Medium priority: Recommend arrays with data
    if (Array.isArray(value) && value.length > 0) {
        return true;
    }

    // Lower priority: Recommend objects with multiple properties
    if (value && typeof value === 'object' && itemCount >= 1) {
        return true;
    }

    return false;
}

function generatePathDescription(key, value, itemCount) {
    if (Array.isArray(value)) {
        return `Array: ${itemCount} items`;
    }

    if (value && typeof value === 'object') {
        return `Object: ${itemCount} properties`;
    }

    return `Value: ${typeof value}`;
}

function collectPaths(obj, currentPath, paths, depth, maxDepth = 5) {
    console.log(`collectPaths called with currentPath: "${currentPath}", depth: ${depth}, obj keys:`, Object.keys(obj || {}));

    if (depth >= maxDepth || !obj || typeof obj !== 'object') {
        console.log(`Stopping recursion at depth ${depth}`);
        return;
    }

    for (const [key, value] of Object.entries(obj)) {
        const path = currentPath ? `${currentPath}.${key}` : key;
        const type = getDataType(value);
        const itemCount = getItemCount(value);

        console.log(`Processing key "${key}" -> path "${path}", type: ${type}, itemCount: ${itemCount}`);

        // Add this path if it's meaningful
        if (type === 'object' || type === 'array') {
            paths.push({
                path,
                type,
                depth: depth + 1,
                recommended: isRecommendedPath(key, value, itemCount),
                description: generatePathDescription(key, value, itemCount)
            });

            console.log(`Added path: ${path}`);

            // Recurse into objects and first array item
            if (type === 'object') {
                console.log(`Recursing into object at path "${path}"`);
                collectPaths(value, path, paths, depth + 1, maxDepth);
            } else if (type === 'array' && Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                console.log(`Recursing into array[0] at path "${path}"`);
                collectPaths(value[0], path, paths, depth + 1, maxDepth);
            }
        }
    }
}

function discoverDataPaths(data, maxDepth = 5) {
    console.log('=== Frontend Path Discovery Test ===');
    console.log('Input data structure:', JSON.stringify(data, null, 2));

    const paths = [];

    // Always include root option
    paths.push({
        path: 'root',
        type: getDataType(data),
        depth: 0,
        recommended: false,
        description: 'Full response (no extraction)'
    });

    if (!data || typeof data !== 'object') {
        return paths;
    }

    // Discover nested paths
    collectPaths(data, '', paths, 0, maxDepth);

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

    console.log('Final discovered paths:');
    deduplicatedPaths.forEach((pathInfo, index) => {
        console.log(`${index}: ${pathInfo.path} (${pathInfo.type}) - ${pathInfo.description}`);
    });

    return deduplicatedPaths;
}

// Run the test
const discoveredPaths = discoverDataPaths(githubResponse);

// Check for data.data
const hasDataDotData = discoveredPaths.some(p => p.path === 'data.data');
console.log('=== RESULT ===');
console.log('Has data.data path:', hasDataDotData);
console.log('All path names:', discoveredPaths.map(p => p.path));