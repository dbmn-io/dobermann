// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Unit Tests for Endpoint Quick Access Service
 * Tests QuickPick item creation, icon mapping, and formatting
 */

import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';
import { EndpointQuickAccessService } from '../../../services/quick-access/endpoint-quick-access.service';
import { APIEndpointManager } from '../../../apiEndpointManager';
import { IExtensionDiagnosticLogger } from '../../../services/logging/extension-diagnostic-logger.interface';
import { APIEndpointConfig } from '../../../data-loading/types';

describe('EndpointQuickAccessService - Unit Tests', () => {
    let service: EndpointQuickAccessService;
    let mockEndpointManager: sinon.SinonStubbedInstance<APIEndpointManager>;
    let mockLogger: sinon.SinonStubbedInstance<IExtensionDiagnosticLogger>;
    let mockQuickPick: any;

    beforeEach(() => {
        // Create mock endpoint manager
        mockEndpointManager = {
            getAllEndpoints: sinon.stub()
        } as any;

        // Create mock logger
        mockLogger = {
            info: sinon.stub(),
            error: sinon.stub(),
            warn: sinon.stub(),
            debug: sinon.stub()
        } as any;

        // Create mock QuickPick
        mockQuickPick = {
            title: '',
            placeholder: '',
            matchOnDescription: false,
            matchOnDetail: false,
            canSelectMany: false,
            items: [],
            selectedItems: [],
            onDidTriggerItemButton: sinon.stub(),
            onDidAccept: sinon.stub(),
            onDidHide: sinon.stub(),
            show: sinon.stub(),
            hide: sinon.stub(),
            dispose: sinon.stub()
        };

        // Create service instance
        service = new EndpointQuickAccessService(
            mockEndpointManager as any,
            mockLogger as any
        );
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('Icon Mapping', () => {
        it('should return correct icon for GET method', () => {
            const icon = (service as any).getMethodIcon('GET');
            expect(icon).to.equal('arrow-down');
        });

        it('should return correct icon for POST method', () => {
            const icon = (service as any).getMethodIcon('POST');
            expect(icon).to.equal('arrow-up');
        });

        it('should return correct icon for PUT method', () => {
            const icon = (service as any).getMethodIcon('PUT');
            expect(icon).to.equal('arrow-both');
        });

        it('should return correct icon for DELETE method', () => {
            const icon = (service as any).getMethodIcon('DELETE');
            expect(icon).to.equal('trash');
        });

        it('should return default icon for unknown method', () => {
            const icon = (service as any).getMethodIcon('PATCH');
            expect(icon).to.equal('globe');
        });

        it('should handle case-insensitive method names', () => {
            expect((service as any).getMethodIcon('get')).to.equal('arrow-down');
            expect((service as any).getMethodIcon('GeT')).to.equal('arrow-down');
            expect((service as any).getMethodIcon('post')).to.equal('arrow-up');
        });
    });

    describe('QuickPick Item Creation', () => {
        it('should create QuickPick items with correct label format', () => {
            const endpoints: APIEndpointConfig[] = [
                {
                    id: 'ep1',
                    name: 'Get Orders',
                    method: 'GET',
                    path: '/v1/orders',
                    folder: undefined,
                    headers: {},
                    queryParams: {}
                } as any
            ];

            const items = (service as any).createQuickPickItems(endpoints);

            expect(items).to.have.length(1);
            expect(items[0].label).to.equal('$(arrow-down) Get Orders');
        });

        it('should create QuickPick items with correct description format', () => {
            const endpoints: APIEndpointConfig[] = [
                {
                    id: 'ep1',
                    name: 'Create Order',
                    method: 'POST',
                    path: '/v1/orders',
                    folder: undefined,
                    headers: {},
                    queryParams: {}
                } as any
            ];

            const items = (service as any).createQuickPickItems(endpoints);

            expect(items[0].description).to.equal('POST /v1/orders');
        });

        it('should include folder information in detail when folder exists', () => {
            const endpoints: APIEndpointConfig[] = [
                {
                    id: 'ep1',
                    name: 'Update Inventory',
                    method: 'PUT',
                    path: '/v1/inventory',
                    folder: 'Inventory',
                    headers: {},
                    queryParams: {}
                } as any
            ];

            const items = (service as any).createQuickPickItems(endpoints);

            expect(items[0].detail).to.equal('Folder: Inventory');
            expect(items[0].folderName).to.equal('Inventory');
        });

        it('should have undefined detail when no folder exists', () => {
            const endpoints: APIEndpointConfig[] = [
                {
                    id: 'ep1',
                    name: 'Get Status',
                    method: 'GET',
                    path: '/v1/status',
                    folder: undefined,
                    headers: {},
                    queryParams: {}
                } as any
            ];

            const items = (service as any).createQuickPickItems(endpoints);

            expect(items[0].detail).to.be.undefined;
            expect(items[0].folderName).to.be.undefined;
        });

        it('should include endpoint metadata in QuickPick item', () => {
            const endpoint: APIEndpointConfig = {
                id: 'ep-123',
                name: 'Test Endpoint',
                method: 'DELETE',
                path: '/v1/test',
                folder: 'Testing',
                headers: {},
                queryParams: {}
            } as any;

            const items = (service as any).createQuickPickItems([endpoint]);

            expect(items[0].endpointId).to.equal('ep-123');
            expect(items[0].endpoint).to.deep.equal(endpoint);
        });

        it('should not include buttons in QuickPick items', () => {
            const endpoints: APIEndpointConfig[] = [
                {
                    id: 'ep1',
                    name: 'Test',
                    method: 'GET',
                    path: '/test',
                    headers: {},
                    queryParams: {}
                } as any
            ];

            const items = (service as any).createQuickPickItems(endpoints);

            expect(items[0].buttons).to.be.undefined;
        });

        it('should handle multiple endpoints correctly', () => {
            const endpoints: APIEndpointConfig[] = [
                {
                    id: 'ep1',
                    name: 'Get Orders',
                    method: 'GET',
                    path: '/v1/orders',
                    headers: {},
                    queryParams: {}
                } as any,
                {
                    id: 'ep2',
                    name: 'Create Order',
                    method: 'POST',
                    path: '/v1/orders',
                    headers: {},
                    queryParams: {}
                } as any,
                {
                    id: 'ep3',
                    name: 'Delete Order',
                    method: 'DELETE',
                    path: '/v1/orders/{id}',
                    folder: 'Orders',
                    headers: {},
                    queryParams: {}
                } as any
            ];

            const items = (service as any).createQuickPickItems(endpoints);

            expect(items).to.have.length(3);
            expect(items[0].label).to.include('Get Orders');
            expect(items[1].label).to.include('Create Order');
            expect(items[2].label).to.include('Delete Order');
            expect(items[2].detail).to.equal('Folder: Orders');
        });

        it('should handle empty endpoint array', () => {
            const items = (service as any).createQuickPickItems([]);
            expect(items).to.be.an('array').that.is.empty;
        });
    });

    describe('Error Handling', () => {
        it('should handle empty endpoint list gracefully', async () => {
            mockEndpointManager.getAllEndpoints.resolves([]);

            const showInfoStub = sinon.stub(vscode.window, 'showInformationMessage');

            const result = await service.showQuickPick();

            expect(result.action).to.equal('cancelled');
            expect(result.endpoint).to.be.undefined;
            expect(showInfoStub.calledOnce).to.be.true;
            expect(showInfoStub.firstCall.args[0]).to.include('No endpoints available');
        });

        it('should handle errors during endpoint retrieval', async () => {
            const error = new Error('Database error');
            mockEndpointManager.getAllEndpoints.rejects(error);

            const showErrorStub = sinon.stub(vscode.window, 'showErrorMessage');

            const result = await service.showQuickPick();

            expect(result.action).to.equal('cancelled');
            expect(mockLogger.error.calledOnce).to.be.true;
            expect(showErrorStub.calledOnce).to.be.true;
        });
    });

    // Note: QuickPick interaction tests (two-step flow, action selection)
    // are tested in integration tests where VS Code API can be properly mocked
});
