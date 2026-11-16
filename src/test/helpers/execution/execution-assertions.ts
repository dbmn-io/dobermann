// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as sinon from 'sinon';
import { ExecutionMetadata } from '../../../storage/execution-metadata';
import { APIEndpointConfig } from '../../../data-loading/types';
import { JWTPayload } from '../../../utils/jwt-validation';

// Custom assertion helpers for execution tests

export class ExecutionAssertions {
    
    // Assert execution metadata structure and content
    static assertExecutionMetadata(metadata: ExecutionMetadata) {
        expect(metadata).to.be.an('object');
        expect(metadata.id).to.be.a('string').that.is.not.empty;
        expect(metadata.environment).to.be.a('string').that.is.not.empty;
        expect(metadata.endpointId).to.be.a('string').that.is.not.empty;
        expect(metadata.endpointName).to.be.a('string').that.is.not.empty;
        expect(metadata.endpointMethod).to.be.a('string').that.is.not.empty;
        expect(metadata.endpointPath).to.be.a('string').that.is.not.empty;
        expect(metadata.status).to.be.oneOf(['pending', 'running', 'completed', 'cancelled', 'error']);
        expect(metadata.createdAt).to.be.instanceOf(Date);
    }

    // Assert execution result structure
    static assertExecutionResult(result: any) {
        expect(result).to.be.an('object');
        expect(result.success).to.be.a('boolean');
        expect(result.executionId).to.be.a('string').that.is.not.empty;
        
        if (result.success) {
            expect(result.duration).to.be.a('number').that.is.at.least(0);
            expect(result.httpStatus).to.be.a('number').that.is.greaterThan(0);
            expect(result.httpStatusText).to.be.a('string').that.is.not.empty;
        }
        
        if (result.requestFile) {
            expect(result.requestFile).to.be.a('string').that.is.not.empty;
        }
        
        if (result.responseFile) {
            expect(result.responseFile).to.be.a('string').that.is.not.empty;
        }
        
        if (result.errorMessage) {
            expect(result.errorMessage).to.be.a('string').that.is.not.empty;
        }
    }

    // Assert validation result structure
    static assertValidationResult(result: any) {
        expect(result).to.be.an('object');
        expect(result.jwtValid).to.be.a('boolean');
        expect(result.orgValid).to.be.a('boolean');
        expect(result.locValid).to.be.a('boolean');
        expect(result.canExecute).to.be.a('boolean');
        
        if (result.error) {
            expect(result.error).to.be.a('string').that.is.not.empty;
        }
    }

    // Assert file operation result structure
    static assertFileResult(result: any) {
        expect(result).to.be.an('object');
        expect(result.success).to.be.a('boolean');
        
        if (result.success) {
            expect(result.filePath).to.be.a('string').that.is.not.empty;
            expect(result.filename).to.be.a('string').that.is.not.empty;
        }
        
        if (result.error) {
            expect(result.error).to.be.a('string').that.is.not.empty;
        }
    }

    // Assert API endpoint configuration structure
    static assertEndpointConfig(config: APIEndpointConfig) {
        expect(config).to.be.an('object');
        expect(config.id).to.be.a('string').that.is.not.empty;
        expect(config.name).to.be.a('string').that.is.not.empty;
        expect(config.path).to.be.a('string').that.is.not.empty;
        expect(config.method).to.be.a('string').that.is.not.empty;
        expect(config.headers).to.be.an('object');
        expect(config.queryParams).to.be.an('object');
        expect(config.dataLoadingConfig).to.be.an('object');
    }

    // Assert JWT payload structure
    static assertJWTPayload(payload: JWTPayload) {
        expect(payload).to.be.an('object');
        expect(payload.iss).to.be.a('string').that.is.not.empty;
        expect(payload.sub).to.be.a('string').that.is.not.empty;
        expect(payload.aud).to.be.a('string').that.is.not.empty;
        expect(payload.exp).to.be.a('number').that.is.greaterThan(0);
        expect(payload.iat).to.be.a('number').that.is.greaterThan(0);
        expect(payload.userOrgs).to.be.an('array');
        expect(payload.userLocations).to.be.an('array');
        expect(payload.username).to.be.a('string').that.is.not.empty;
    }

    // Assert message structure for webview communication
    static assertMessage(message: any, expectedType: string) {
        expect(message).to.be.an('object');
        expect(message.type).to.equal(expectedType);
        expect(message.timestamp).to.be.a('number').that.is.greaterThan(0);
        
        if (message.correlationId) {
            expect(message.correlationId).to.be.a('string').that.is.not.empty;
        }
        
        if (message.payload) {
            expect(message.payload).to.be.an('object');
        }
    }

    // Assert service method was called correctly
    static assertServiceMethodCalled(mockService: any, methodName: string, expectedArgs?: any[]) {
        sinon.assert.called(mockService[methodName]);
        
        if (expectedArgs) {
            sinon.assert.calledWith(mockService[methodName], ...expectedArgs);
        }
    }

    // Assert service method was called with specific number of times
    static assertServiceMethodCalledTimes(mockService: any, methodName: string, expectedTimes: number) {
        sinon.assert.callCount(mockService[methodName], expectedTimes);
    }

    // Assert async service method resolved correctly
    static async assertAsyncServiceMethodResolved(mockService: any, methodName: string, expectedResult: any, ...args: any[]) {
        const result = await mockService[methodName](...args);
        expect(result).to.deep.equal(expectedResult);
    }

    // Assert async service method rejected correctly
    static async assertAsyncServiceMethodRejected(mockService: any, methodName: string, expectedError: string, ...args: any[]) {
        try {
            await mockService[methodName](...args);
            expect.fail('Expected method to reject');
        } catch (error: any) {
            expect(error).to.be.instanceOf(Error);
            expect((error as Error).message).to.equal(expectedError);
        }
    }

    // Assert timeout behavior
    static assertTimeout(duration: number, expectedMin: number, expectedMax: number) {
        expect(duration).to.be.at.least(expectedMin);
        expect(duration).to.be.at.most(expectedMax);
    }

    // Assert execution status transitions
    static assertStatusTransition(fromStatus: string, toStatus: string) {
        const validTransitions: Record<string, string[]> = {
            'pending': ['running', 'cancelled'],
            'running': ['completed', 'cancelled', 'error'],
            'completed': [],
            'cancelled': [],
            'error': []
        };
        
        expect(validTransitions[fromStatus]).to.include(toStatus);
    }

    // Assert correlation ID format
    static assertCorrelationId(correlationId: string) {
        expect(correlationId).to.be.a('string').that.is.not.empty;
        expect(correlationId).to.match(/^[a-zA-Z0-9-_]+$/);
    }

    // Assert file path format
    static assertFilePath(filePath: string) {
        expect(filePath).to.be.a('string').that.is.not.empty;
        expect(filePath).to.match(/^\/.*\.(json|txt|csv)$/);
    }

    // Assert execution duration is reasonable
    static assertExecutionDuration(duration: number) {
        expect(duration).to.be.a('number');
        expect(duration).to.be.at.least(0);
        expect(duration).to.be.at.most(300000); // 5 minutes max
    }

    // Assert HTTP status codes
    static assertHTTPStatus(status: number) {
        expect(status).to.be.a('number');
        expect(status).to.be.at.least(100);
        expect(status).to.be.at.most(599);
    }

    // Assert environment information
    static assertEnvironment(environment: any) {
        expect(environment).to.be.an('object');
        expect(environment.name).to.be.a('string').that.is.not.empty;
    }
}