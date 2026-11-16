// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { ExtensionDiagnosticLogger } from '../../../../services/logging/extension-diagnostic-logger.service';

describe('ExtensionDiagnosticLogger', () => {
    let logger: ExtensionDiagnosticLogger;
    let mockOutputChannel: sinon.SinonStubbedInstance<vscode.LogOutputChannel>;
    let createOutputChannelStub: sinon.SinonStub;

    beforeEach(() => {
        // Create mock LogOutputChannel
        mockOutputChannel = {
            info: sinon.stub(),
            warn: sinon.stub(),
            error: sinon.stub(),
            debug: sinon.stub(),
            trace: sinon.stub(),
            show: sinon.stub(),
            clear: sinon.stub(),
            dispose: sinon.stub(),
            name: 'Test Channel',
            append: sinon.stub(),
            appendLine: sinon.stub(),
            replace: sinon.stub(),
            hide: sinon.stub()
        } as any;

        // Stub VS Code's createOutputChannel
        createOutputChannelStub = sinon.stub(vscode.window, 'createOutputChannel')
            .returns(mockOutputChannel);

        logger = new ExtensionDiagnosticLogger('Test Channel');
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('constructor', () => {
        it('should create LogOutputChannel with correct name and log option', () => {
            expect(createOutputChannelStub.calledOnce).to.be.true;
            expect(createOutputChannelStub.calledWith('Test Channel', { log: true })).to.be.true;
        });

        it('should use default channel name when not provided', () => {
            sinon.restore();
            createOutputChannelStub = sinon.stub(vscode.window, 'createOutputChannel')
                .returns(mockOutputChannel);

            new ExtensionDiagnosticLogger();
            
            expect(createOutputChannelStub.calledWith('Dobermann Extension', { log: true })).to.be.true;
        });
    });

    describe('logging methods', () => {
        it('should log info messages correctly', () => {
            logger.info('Test info message');
            
            expect(mockOutputChannel.info.calledOnce).to.be.true;
            expect(mockOutputChannel.info.calledWith('Test info message')).to.be.true;
        });

        it('should log warn messages correctly', () => {
            logger.warn('Test warning message');
            
            expect(mockOutputChannel.warn.calledOnce).to.be.true;
            expect(mockOutputChannel.warn.calledWith('Test warning message')).to.be.true;
        });

        it('should log error messages correctly without Error object', () => {
            logger.error('Test error message');
            
            expect(mockOutputChannel.error.calledOnce).to.be.true;
            expect(mockOutputChannel.error.calledWith('Test error message')).to.be.true;
        });

        it('should log error messages with Error object details', () => {
            const testError = new Error('Test error details');
            testError.stack = 'Error stack trace';
            
            logger.error('Test error message', testError);
            
            expect(mockOutputChannel.error.calledOnce).to.be.true;
            const calledArg = mockOutputChannel.error.getCall(0).args[0];
            expect(calledArg).to.include('Test error message');
            expect(calledArg).to.include('Error: Test error details');
            expect(calledArg).to.include('Stack: Error stack trace');
        });

        it('should log debug messages correctly', () => {
            logger.debug('Test debug message');
            
            expect(mockOutputChannel.debug.calledOnce).to.be.true;
            expect(mockOutputChannel.debug.calledWith('Test debug message')).to.be.true;
        });

        it('should log trace messages correctly', () => {
            logger.trace('Test trace message');
            
            expect(mockOutputChannel.trace.calledOnce).to.be.true;
            expect(mockOutputChannel.trace.calledWith('Test trace message')).to.be.true;
        });
    });

    describe('message formatting with arguments', () => {
        it('should format messages with string arguments', () => {
            logger.info('Test message', 'arg1', 'arg2');
            
            expect(mockOutputChannel.info.calledOnce).to.be.true;
            expect(mockOutputChannel.info.calledWith('Test message arg1 arg2')).to.be.true;
        });

        it('should format messages with object arguments as JSON', () => {
            const testObj = { key: 'value', number: 123 };
            logger.info('Test message', testObj);
            
            expect(mockOutputChannel.info.calledOnce).to.be.true;
            const calledArg = mockOutputChannel.info.getCall(0).args[0];
            expect(calledArg).to.include('Test message');
            expect(calledArg).to.include('"key": "value"');
            expect(calledArg).to.include('"number": 123');
        });

        it('should handle non-serializable arguments gracefully', () => {
            const circularObj: any = { self: null };
            circularObj.self = circularObj;
            
            logger.info('Test message', circularObj);
            
            expect(mockOutputChannel.info.calledOnce).to.be.true;
            const calledArg = mockOutputChannel.info.getCall(0).args[0];
            expect(calledArg).to.include('Test message');
            expect(calledArg).to.include('[object Object]'); // Fallback to String()
        });

        it('should format mixed argument types correctly', () => {
            logger.info('Test message', 'string', 42, { key: 'value' });
            
            expect(mockOutputChannel.info.calledOnce).to.be.true;
            const calledArg = mockOutputChannel.info.getCall(0).args[0];
            expect(calledArg).to.include('Test message');
            expect(calledArg).to.include('string');
            expect(calledArg).to.include('42');
            expect(calledArg).to.include('"key": "value"');
        });
    });

    describe('output channel controls', () => {
        it('should show the output channel', () => {
            logger.show();
            
            expect(mockOutputChannel.show.calledOnce).to.be.true;
        });

        it('should clear the output channel', () => {
            logger.clear();
            
            expect(mockOutputChannel.clear.calledOnce).to.be.true;
        });

        it('should dispose the output channel', () => {
            logger.dispose();
            
            expect(mockOutputChannel.dispose.calledOnce).to.be.true;
        });
    });
});