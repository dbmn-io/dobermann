// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { describe, it, beforeEach } from 'mocha';
import { expect } from 'chai';
import { RootPathAnalyzerService } from '../../../../services/console/root-path-analyzer.service';

describe('Path Discovery Bug - GitHub Response Structure', () => {
    let pathAnalyzer: RootPathAnalyzerService;
    let githubResponse: any;

    beforeEach(() => {
        pathAnalyzer = new RootPathAnalyzerService();

        // The EXACT response structure from the user's logs
        githubResponse = {
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
    });

    it('should discover correct paths from GitHub response structure (after fix)', () => {
        const discoveredPaths = pathAnalyzer.discoverPaths(githubResponse);

        console.log('Discovered paths after double-wrapping fix:');
        discoveredPaths.forEach((path, index) => {
            console.log(`${index}: ${path.path} (${path.type}) - ${path.description}`);
        });

        // Extract just the path names for easier testing
        const pathNames = discoveredPaths.map(p => p.path);

        // EXPECTED paths based on the actual JSON structure (NO double-wrapping)
        const expectedPaths = [
            'root',           // Full response object
            'data',           // GitHub user data object (NOT data.data!)
            'headers',        // Headers object
            'data.plan'       // Plan object inside data
        ];

        // CRITICAL: Should NOT contain 'data.data' - that was the bug!
        expect(pathNames).to.not.include('data.data', 'data.data path should not exist after fixing double-wrapping');

        // Should contain the expected paths
        expectedPaths.forEach(expectedPath => {
            expect(pathNames).to.include(expectedPath, `Should discover path: ${expectedPath}`);
        });

        // Verify data path points to GitHub user data, not wrapper
        const dataExtraction = pathAnalyzer.extractAtPath(githubResponse, 'data');
        expect(dataExtraction).to.have.property('login', 'JamesForan');
        expect(dataExtraction).to.have.property('company', 'Flexion Tech');

        // Verify specific path properties
        const rootPath = discoveredPaths.find(p => p.path === 'root');
        expect(rootPath).to.exist;
        expect(rootPath!.type).to.equal('object');
        expect(rootPath!.description).to.equal('Full response (no extraction)');

        const dataPath = discoveredPaths.find(p => p.path === 'data');
        expect(dataPath).to.exist;
        expect(dataPath!.type).to.equal('object');
        expect(dataPath!.recommended).to.be.true;
    });

    it('should extract data correctly at each discovered path', () => {
        const discoveredPaths = pathAnalyzer.discoverPaths(githubResponse);

        // Test root extraction
        const rootData = pathAnalyzer.extractAtPath(githubResponse, 'root');
        expect(rootData).to.deep.equal(githubResponse);

        // Test data extraction
        const dataExtraction = pathAnalyzer.extractAtPath(githubResponse, 'data');
        expect(dataExtraction).to.deep.equal(githubResponse.data);
        expect(dataExtraction.login).to.equal('JamesForan');

        // Test metadata extraction
        const metadataExtraction = pathAnalyzer.extractAtPath(githubResponse, 'metadata');
        expect(metadataExtraction).to.deep.equal(githubResponse.metadata);

        // Test headers extraction
        const headersExtraction = pathAnalyzer.extractAtPath(githubResponse, 'headers');
        expect(headersExtraction).to.deep.equal(githubResponse.headers);

        // Verify data.data path DOESN'T work (should return null)
        const dataDataExtraction = pathAnalyzer.extractAtPath(githubResponse, 'data.data');
        expect(dataDataExtraction).to.be.null;
    });

    it('should validate paths correctly', () => {
        // Valid paths should return true
        expect(pathAnalyzer.isValidPath(githubResponse, 'root')).to.be.true;
        expect(pathAnalyzer.isValidPath(githubResponse, 'data')).to.be.true;
        expect(pathAnalyzer.isValidPath(githubResponse, 'metadata')).to.be.true;
        expect(pathAnalyzer.isValidPath(githubResponse, 'headers')).to.be.true;
        expect(pathAnalyzer.isValidPath(githubResponse, 'data.plan')).to.be.true;

        // Invalid paths should return false
        expect(pathAnalyzer.isValidPath(githubResponse, 'data.data')).to.be.false;
        expect(pathAnalyzer.isValidPath(githubResponse, 'nonexistent')).to.be.false;
        expect(pathAnalyzer.isValidPath(githubResponse, 'data.nonexistent')).to.be.false;
    });
});