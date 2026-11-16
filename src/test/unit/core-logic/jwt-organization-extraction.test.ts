// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

describe('JWT Organization Extraction - Unit Test', () => {
    
    describe('extractOrganizationsFromJWT', () => {
        // This simulates the logic from refreshEnvironmentOrganizations
        function extractOrganizationsFromJWT(token: string): string[] {
            try {
                const parts = token.split('.');
                if (parts.length !== 3) {
                    return [];
                }
                
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
                const availableOrgs = payload.userOrgs || [];
                
                // Sort organizations (L1 first, then L2, alphabetically within each group)
                const sortedOrgs = availableOrgs.sort((a: string, b: string) => {
                    // Simple heuristic for L1 vs L2
                    const aIsL1 = a.match(/^[A-Z]{2,4}-[A-Z]{2,6}-[A-Z]{2,4}$/) || a.includes('-L1-') || a.includes('_L1_');
                    const bIsL1 = b.match(/^[A-Z]{2,4}-[A-Z]{2,6}-[A-Z]{2,4}$/) || b.includes('-L1-') || b.includes('_L1_');
                    
                    if (aIsL1 && !bIsL1) return -1;
                    if (!aIsL1 && bIsL1) return 1;
                    return a.localeCompare(b);
                });
                
                return sortedOrgs;
            } catch (error) {
                return [];
            }
        }

        it('should extract and sort organizations from JWT token', () => {
            // Arrange
            const mockOrgs = ['Store-123-DEV', 'ORG-APAC-DEV', 'ORG-US-PROD', 'Store-456-PROD'];
            const mockPayload = {
                userOrgs: mockOrgs,
                exp: Math.floor(Date.now() / 1000) + 3600
            };
            const encodedPayload = Buffer.from(JSON.stringify(mockPayload)).toString('base64');
            const mockJwtToken = `header.${encodedPayload}.signature`;

            // Act
            const organizations = extractOrganizationsFromJWT(mockJwtToken);

            // Assert
            expect(organizations).to.have.lengthOf(4);
            // L1 organizations should come first
            expect(organizations[0]).to.equal('ORG-APAC-DEV');
            expect(organizations[1]).to.equal('ORG-US-PROD');
            // L2 organizations should come after
            expect(organizations[2]).to.equal('Store-123-DEV');
            expect(organizations[3]).to.equal('Store-456-PROD');
        });

        it('should return empty array for invalid JWT format', () => {
            // Arrange
            const invalidToken = 'not-a-jwt-token';

            // Act
            const organizations = extractOrganizationsFromJWT(invalidToken);

            // Assert
            expect(organizations).to.be.an('array').that.is.empty;
        });

        it('should return empty array for JWT without userOrgs', () => {
            // Arrange
            const mockPayload = {
                exp: Math.floor(Date.now() / 1000) + 3600,
                // No userOrgs field
            };
            const encodedPayload = Buffer.from(JSON.stringify(mockPayload)).toString('base64');
            const mockJwtToken = `header.${encodedPayload}.signature`;

            // Act
            const organizations = extractOrganizationsFromJWT(mockJwtToken);

            // Assert
            expect(organizations).to.be.an('array').that.is.empty;
        });

        it('should handle OAuth tokens gracefully', () => {
            // Arrange - OAuth tokens are not JWT format
            const oauthToken = 'gho_abc123def456'; // gitleaks:allow (made-up fixture)

            // Act
            const organizations = extractOrganizationsFromJWT(oauthToken);

            // Assert
            expect(organizations).to.be.an('array').that.is.empty;
        });
    });
});