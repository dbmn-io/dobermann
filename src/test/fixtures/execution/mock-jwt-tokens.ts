import { JWTPayload } from '../../../utils/jwt-validation';

// Mock JWT tokens for testing validation scenarios

export const mockValidJWTPayload: JWTPayload = {
    iss: 'test-issuer',
    sub: 'test-user-123',
    aud: 'test-audience',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    iat: Math.floor(Date.now() / 1000),
    userOrgs: ['ORG001', 'ORG002'],
    userLocations: [
        { locationId: 'LOC001', locationType: 'warehouse' },
        { locationId: 'LOC002', locationType: 'store' }
    ],
    roles: ['user', 'admin'],
    username: 'testuser@example.com'
};

export const mockValidJWTPayloadSingleOrg: JWTPayload = {
    iss: 'test-issuer',
    sub: 'test-user-124',
    aud: 'test-audience',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    userOrgs: ['ORG001'],
    userLocations: [{ locationId: 'LOC001', locationType: 'warehouse' }],
    roles: ['user'],
    username: 'singleorg@example.com'
};

export const mockExpiredJWTPayload: JWTPayload = {
    iss: 'test-issuer',
    sub: 'test-user-125',
    aud: 'test-audience',
    exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    iat: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
    userOrgs: ['ORG001'],
    userLocations: [{ locationId: 'LOC001', locationType: 'warehouse' }],
    roles: ['user'],
    username: 'expired@example.com'
};

export const mockJWTPayloadNoOrg: JWTPayload = {
    iss: 'test-issuer',
    sub: 'test-user-126',
    aud: 'test-audience',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    userOrgs: [], // No organizations
    userLocations: [{ locationId: 'LOC001', locationType: 'warehouse' }],
    roles: ['user'],
    username: 'noorg@example.com'
};

export const mockJWTPayloadNoLocation: JWTPayload = {
    iss: 'test-issuer',
    sub: 'test-user-127',
    aud: 'test-audience',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    userOrgs: ['ORG001'],
    userLocations: [], // No locations
    roles: ['user'],
    username: 'noloc@example.com'
};

export const mockJWTPayloadNoOrgNoLocation: JWTPayload = {
    iss: 'test-issuer',
    sub: 'test-user-128',
    aud: 'test-audience',
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    userOrgs: [], // No organizations
    userLocations: [], // No locations
    roles: ['user'],
    username: 'noorgnoorg@example.com'
};

// Mock token status responses
export const mockTokenStatusValid = {
    isValid: true,
    userInfo: 'Token is valid'
};

export const mockTokenStatusInvalid = {
    isValid: false,
    userInfo: 'Token is invalid or expired'
};

export const mockTokenStatusMissing = {
    isValid: false,
    userInfo: 'No token provided'
};

export const mockTokenStatusExpired = {
    isValid: false,
    isExpired: true,
    userInfo: 'Token is expired'
};

export const mockJWTTokens = {
    valid: mockValidJWTPayload,
    validSingleOrg: mockValidJWTPayloadSingleOrg,
    expired: mockExpiredJWTPayload,
    noOrg: mockJWTPayloadNoOrg,
    noLocation: mockJWTPayloadNoLocation,
    noOrgNoLocation: mockJWTPayloadNoOrgNoLocation
};