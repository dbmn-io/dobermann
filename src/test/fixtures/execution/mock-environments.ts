// Mock environment configurations for testing

export interface MockEnvironment {
    id: string;
    name: string;
    baseUrl: string;
    active: boolean;
    description?: string;
}

export const mockEnvironmentDev: MockEnvironment = {
    id: 'env-dev-001',
    name: 'Development',
    baseUrl: 'https://dev-api.example.com',
    active: true,
    description: 'Development environment'
};

export const mockEnvironmentTest: MockEnvironment = {
    id: 'env-test-001',
    name: 'Testing',
    baseUrl: 'https://test-api.example.com',
    active: false,
    description: 'Testing environment'
};

export const mockEnvironmentMock: MockEnvironment = {
    id: 'env-mock-001',
    name: 'Mock',
    baseUrl: 'https://mock-api.example.com',
    active: false,
    description: 'Mock environment for testing'
};

export const mockEnvironmentProd: MockEnvironment = {
    id: 'env-prod-001',
    name: 'Production',
    baseUrl: 'https://api.example.com',
    active: false,
    description: 'Production environment'
};

export const mockEnvironments = [
    mockEnvironmentDev,
    mockEnvironmentTest,
    mockEnvironmentMock,
    mockEnvironmentProd
];

export const mockActiveEnvironment = mockEnvironmentDev;