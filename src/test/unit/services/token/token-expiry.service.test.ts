// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { TokenExpiryService, TokenExpiryInfo } from '../../../../services/token/token-expiry.service';

describe('TokenExpiryService', () => {
    let tokenExpiryService: TokenExpiryService;

    beforeEach(() => {
        tokenExpiryService = new TokenExpiryService();
    });

    afterEach(() => {
        tokenExpiryService.stopMonitoring();
    });

    describe('getExpiryInfo', () => {
        it('should return expired status for token without exp field', () => {
            const tokenWithoutExp = createTestToken({});
            
            const result = tokenExpiryService.getExpiryInfo(tokenWithoutExp);
            
            expect(result.isExpired).to.be.true;
            expect(result.remainingMinutes).to.equal(0);
            expect(result.warningLevel).to.equal('error');
        });

        it('should return expired status for already expired token', () => {
            const expiredTime = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
            const expiredToken = createTestToken({ exp: expiredTime });
            
            const result = tokenExpiryService.getExpiryInfo(expiredToken);
            
            expect(result.isExpired).to.be.true;
            expect(result.remainingMinutes).to.equal(0);
            expect(result.warningLevel).to.equal('error');
        });

        it('should return warning status for token expiring within 30 minutes', () => {
            const soonExpiryTime = Math.floor(Date.now() / 1000) + (15 * 60); // 15 minutes from now
            const soonExpiringToken = createTestToken({ exp: soonExpiryTime });
            
            const result = tokenExpiryService.getExpiryInfo(soonExpiringToken);
            
            expect(result.isExpired).to.be.false;
            expect(result.remainingMinutes).to.be.lessThan(30);
            expect(result.remainingMinutes).to.be.greaterThan(0);
            expect(result.warningLevel).to.equal('warning');
        });

        it('should return normal status for token with plenty of time remaining', () => {
            const futureExpiryTime = Math.floor(Date.now() / 1000) + (2 * 3600); // 2 hours from now
            const validToken = createTestToken({ exp: futureExpiryTime });
            
            const result = tokenExpiryService.getExpiryInfo(validToken);
            
            expect(result.isExpired).to.be.false;
            expect(result.remainingMinutes).to.be.greaterThan(30);
            expect(result.warningLevel).to.equal('none');
        });

        it('should return error status for invalid token format', () => {
            const invalidToken = 'invalid.jwt.token';
            
            const result = tokenExpiryService.getExpiryInfo(invalidToken);
            
            expect(result.isExpired).to.be.true;
            expect(result.remainingMinutes).to.equal(0);
            expect(result.warningLevel).to.equal('error');
        });

        it('should handle malformed JWT token', () => {
            const malformedToken = 'not-a-jwt-token';
            
            const result = tokenExpiryService.getExpiryInfo(malformedToken);
            
            expect(result.isExpired).to.be.true;
            expect(result.remainingMinutes).to.equal(0);
            expect(result.warningLevel).to.equal('error');
        });

        it('should return correct expiry date', () => {
            const futureTime = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
            const token = createTestToken({ exp: futureTime });
            
            const result = tokenExpiryService.getExpiryInfo(token);
            
            expect(result.expiresAt.getTime()).to.equal(futureTime * 1000);
        });
    });

    describe('isTokenExpired', () => {
        it('should return true for expired token', () => {
            const expiredTime = Math.floor(Date.now() / 1000) - 3600;
            const expiredToken = createTestToken({ exp: expiredTime });
            
            const result = tokenExpiryService.isTokenExpired(expiredToken);
            
            expect(result).to.be.true;
        });

        it('should return false for valid token', () => {
            const futureTime = Math.floor(Date.now() / 1000) + 3600;
            const validToken = createTestToken({ exp: futureTime });
            
            const result = tokenExpiryService.isTokenExpired(validToken);
            
            expect(result).to.be.false;
        });

        it('should return true for invalid token', () => {
            const invalidToken = 'invalid.token';
            
            const result = tokenExpiryService.isTokenExpired(invalidToken);
            
            expect(result).to.be.true;
        });
    });

    describe('getTimeUntilExpiry', () => {
        it('should return correct remaining seconds', () => {
            const futureTime = Math.floor(Date.now() / 1000) + 1800; // 30 minutes from now
            const token = createTestToken({ exp: futureTime });
            
            const result = tokenExpiryService.getTimeUntilExpiry(token);
            
            expect(result).to.be.approximately(1800, 5); // Allow 5 second tolerance
        });

        it('should return 0 for expired token', () => {
            const expiredTime = Math.floor(Date.now() / 1000) - 3600;
            const expiredToken = createTestToken({ exp: expiredTime });
            
            const result = tokenExpiryService.getTimeUntilExpiry(expiredToken);
            
            expect(result).to.equal(0);
        });

        it('should return 0 for token without exp field', () => {
            const tokenWithoutExp = createTestToken({});
            
            const result = tokenExpiryService.getTimeUntilExpiry(tokenWithoutExp);
            
            expect(result).to.equal(0);
        });

        it('should return 0 for invalid token', () => {
            const invalidToken = 'invalid.token';
            
            const result = tokenExpiryService.getTimeUntilExpiry(invalidToken);
            
            expect(result).to.equal(0);
        });
    });

    describe('monitoring', () => {
        it('should start monitoring and call callback for warning tokens', (done) => {
            const soonExpiryTime = Math.floor(Date.now() / 1000) + (15 * 60); // 15 minutes
            const soonExpiringToken = createTestToken({ exp: soonExpiryTime });
            
            let callbackCalled = false;
            
            tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                expect(info.warningLevel).to.equal('warning');
                callbackCalled = true;
                done();
            });
            
            tokenExpiryService.setCurrentToken(soonExpiringToken);
            
            // If callback wasn't called immediately, fail the test
            setTimeout(() => {
                if (!callbackCalled) {
                    done(new Error('Callback was not called for warning token'));
                }
            }, 100);
        });

        it('should not call callback for normal tokens', (done) => {
            const futureTime = Math.floor(Date.now() / 1000) + (2 * 3600); // 2 hours
            const validToken = createTestToken({ exp: futureTime });
            
            let callbackCalled = false;
            
            tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                callbackCalled = true;
            });
            
            tokenExpiryService.setCurrentToken(validToken);
            
            setTimeout(() => {
                expect(callbackCalled).to.be.false;
                done();
            }, 100);
        });

        it('should stop monitoring when requested', () => {
            tokenExpiryService.startMonitoring(() => {});
            
            tokenExpiryService.stopMonitoring();
            
            // Should not throw any errors and monitoring should be stopped
            expect(() => tokenExpiryService.stopMonitoring()).to.not.throw();
        });

        it('should handle multiple start/stop cycles', () => {
            expect(() => {
                tokenExpiryService.startMonitoring(() => {});
                tokenExpiryService.stopMonitoring();
                tokenExpiryService.startMonitoring(() => {});
                tokenExpiryService.stopMonitoring();
            }).to.not.throw();
        });
    });

    describe('setCurrentToken and clearCurrentToken', () => {
        it('should set and clear current token', () => {
            const token = createTestToken({ exp: Math.floor(Date.now() / 1000) + 3600 });
            
            // Should not throw when setting token
            expect(() => tokenExpiryService.setCurrentToken(token)).to.not.throw();
            
            // Should not throw when clearing token
            expect(() => tokenExpiryService.clearCurrentToken()).to.not.throw();
        });

        it('should immediately check expiry when setting warning token', (done) => {
            const soonExpiryTime = Math.floor(Date.now() / 1000) + (15 * 60);
            const soonExpiringToken = createTestToken({ exp: soonExpiryTime });
            
            tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                expect(info.warningLevel).to.equal('warning');
                done();
            });
            
            tokenExpiryService.setCurrentToken(soonExpiringToken);
        });
    });

    describe('Critical threshold handling', () => {
        it('should return error level for tokens expiring within 10 minutes', () => {
            const criticalExpiryTime = Math.floor(Date.now() / 1000) + (5 * 60); // 5 minutes from now
            const criticalToken = createTestToken({ exp: criticalExpiryTime });
            
            const result = tokenExpiryService.getExpiryInfo(criticalToken);
            
            expect(result.isExpired).to.be.false;
            expect(result.remainingMinutes).to.be.lessThan(10);
            expect(result.remainingMinutes).to.be.greaterThan(0);
            expect(result.warningLevel).to.equal('error'); // Critical = error level
        });

        it('should differentiate between warning and critical levels', () => {
            const warningTime = Math.floor(Date.now() / 1000) + (20 * 60); // 20 minutes from now
            const criticalTime = Math.floor(Date.now() / 1000) + (5 * 60); // 5 minutes from now
            
            const warningToken = createTestToken({ exp: warningTime });
            const criticalToken = createTestToken({ exp: criticalTime });
            
            const warningResult = tokenExpiryService.getExpiryInfo(warningToken);
            const criticalResult = tokenExpiryService.getExpiryInfo(criticalToken);
            
            expect(warningResult.warningLevel).to.equal('warning');
            expect(criticalResult.warningLevel).to.equal('error');
        });
    });

    describe('Progressive monitoring intervals', () => {
        it('should handle token expiry during monitoring without infinite loops', (done) => {
            const expiredToken = createTestToken({ exp: Math.floor(Date.now() / 1000) - 10 }); // Already expired
            
            let callCount = 0;
            tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                callCount++;
                if (info.isExpired) {
                    // Wait a bit to ensure no more calls happen
                    setTimeout(() => {
                        expect(callCount).to.equal(1); // Should only be called once for expired token
                        done();
                    }, 100);
                }
            });
            
            tokenExpiryService.setCurrentToken(expiredToken);
        });

        it('should restart monitoring when new token is set', (done) => {
            const firstToken = createTestToken({ exp: Math.floor(Date.now() / 1000) + 300 });
            const secondToken = createTestToken({ exp: Math.floor(Date.now() / 1000) + 600 });
            
            let firstTokenCalled = false;
            let secondTokenCalled = false;
            
            tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                if (info.remainingMinutes < 6) {
                    firstTokenCalled = true;
                } else if (info.remainingMinutes < 11) {
                    secondTokenCalled = true;
                }
                
                if (firstTokenCalled && secondTokenCalled) {
                    done();
                }
            });
            
            // Set first token
            tokenExpiryService.setCurrentToken(firstToken);
            
            // Set second token after a short delay
            setTimeout(() => {
                tokenExpiryService.setCurrentToken(secondToken);
            }, 50);
        });
    });

    describe('Integration with EnvironmentStatusService scenarios', () => {
        it('should properly clear token when clearCurrentToken is called', () => {
            const token = createTestToken({ exp: Math.floor(Date.now() / 1000) + 1800 });
            tokenExpiryService.setCurrentToken(token);
            
            // Verify token is set
            expect(tokenExpiryService.isTokenExpired(token)).to.be.false;
            
            // Clear token
            tokenExpiryService.clearCurrentToken();
            
            // Verify monitoring handles missing token gracefully
            let callbackCalled = false;
            tokenExpiryService.startMonitoring((info: TokenExpiryInfo) => {
                callbackCalled = true;
            });
            
            // Should not crash and callback should not be called for missing token
            setTimeout(() => {
                expect(callbackCalled).to.be.false;
            }, 100);
        });

        it('should handle invalid token formats gracefully', () => {
            expect(() => {
                tokenExpiryService.setCurrentToken('invalid-token');
            }).to.not.throw();
            
            const result = tokenExpiryService.getExpiryInfo('invalid-token');
            expect(result.isExpired).to.be.true;
            expect(result.warningLevel).to.equal('error');
        });
    });

});

/**
 * Helper function to create test JWT tokens
 */
function createTestToken(payload: any): string {
    const header = { alg: 'HS256', typ: 'JWT' };
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64');
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64');
    const signature = 'test-signature';
    
    return `${encodedHeader}.${encodedPayload}.${signature}`;
}