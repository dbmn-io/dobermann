// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import '../../../helpers/vscode-mock';

import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as sinon from 'sinon';
import { PaginationSetupService } from '../../../../services/pagination/pagination-setup.service';


describe('PaginationSetupService', () => {

    describe('buildSizeTemplate', () => {
        it('should build {{A8:SIZE:100}}', () => {
            const service = new PaginationSetupService();
            expect(service.buildSizeTemplate(100)).to.equal('{{A8:SIZE:100}}');
        });

        it('should build {{A8:SIZE:50}}', () => {
            const service = new PaginationSetupService();
            expect(service.buildSizeTemplate(50)).to.equal('{{A8:SIZE:50}}');
        });

        it('should build {{A8:SIZE:100:header.pageSize}} with sizePath', () => {
            const service = new PaginationSetupService();
            expect(service.buildSizeTemplate(100, 'header.pageSize')).to.equal('{{A8:SIZE:100:header.pageSize}}');
        });

        it('should build without sizePath when not provided', () => {
            const service = new PaginationSetupService();
            expect(service.buildSizeTemplate(100, undefined)).to.equal('{{A8:SIZE:100}}');
        });
    });

    describe('savePaginationConfig - with size', () => {
        it('should save both page and size templates', async () => {
            const service = new PaginationSetupService();
            const savedParams: Record<string, string> = {};

            const mockEndpointManager = {
                getEndpoint: sinon.stub().resolves({
                    queryParams: { filter: 'active' }
                }),
                updateEndpoint: sinon.stub().callsFake((_id: string, updates: Record<string, unknown>) => {
                    Object.assign(savedParams, updates.queryParams);
                    return Promise.resolve(updates);
                })
            };

            await service.savePaginationConfig(mockEndpointManager, 'ep-1', {
                paramKey: 'page',
                startValue: 1,
                totalCountPath: 'header.totalCount',
                sizeParamKey: 'size',
                sizeValue: 100
            });

            expect(mockEndpointManager.updateEndpoint.calledOnce).to.be.true;
            const updateCall = mockEndpointManager.updateEndpoint.firstCall.args[1];
            expect(updateCall.queryParams.page).to.equal('{{A8:PAGE:1:header.totalCount}}');
            expect(updateCall.queryParams.size).to.equal('{{A8:SIZE:100}}');
            expect(updateCall.queryParams.filter).to.equal('active');
        });

        it('should save only page template when size not provided', async () => {
            const service = new PaginationSetupService();

            const mockEndpointManager = {
                getEndpoint: sinon.stub().resolves({ queryParams: {} }),
                updateEndpoint: sinon.stub().resolves({})
            };

            await service.savePaginationConfig(mockEndpointManager, 'ep-1', {
                paramKey: 'page',
                startValue: 0
            });

            const updateCall = mockEndpointManager.updateEndpoint.firstCall.args[1];
            expect(updateCall.queryParams.page).to.equal('{{A8:PAGE:0}}');
            expect(Object.keys(updateCall.queryParams)).to.have.lengthOf(1);
        });

        it('should save size template with sizePath', async () => {
            const service = new PaginationSetupService();

            const mockEndpointManager = {
                getEndpoint: sinon.stub().resolves({ queryParams: {} }),
                updateEndpoint: sinon.stub().resolves({})
            };

            await service.savePaginationConfig(mockEndpointManager, 'ep-1', {
                paramKey: 'page',
                startValue: 1,
                sizeParamKey: 'size',
                sizeValue: 100,
                sizePath: 'header.pageSize'
            });

            const updateCall = mockEndpointManager.updateEndpoint.firstCall.args[1];
            expect(updateCall.queryParams.size).to.equal('{{A8:SIZE:100:header.pageSize}}');
        });

        it('should not save size template when sizeValue is 0', async () => {
            const service = new PaginationSetupService();

            const mockEndpointManager = {
                getEndpoint: sinon.stub().resolves({ queryParams: {} }),
                updateEndpoint: sinon.stub().resolves({})
            };

            await service.savePaginationConfig(mockEndpointManager, 'ep-1', {
                paramKey: 'page',
                startValue: 1,
                sizeParamKey: 'size',
                sizeValue: 0
            });

            const updateCall = mockEndpointManager.updateEndpoint.firstCall.args[1];
            expect(updateCall.queryParams.page).to.equal('{{A8:PAGE:1}}');
            expect(updateCall.queryParams.size).to.be.undefined;
        });
    });

    // GitHub Issue #245: save pagination config into the request body
    describe('savePaginationConfig - body location (#245)', () => {
        it('rewrites the body PAGE/SIZE templates in place (adds total-count path)', async () => {
            const service = new PaginationSetupService();
            const body = JSON.stringify({
                Query: "AsnId = '900'",
                Page: '{{A8:PAGE:0}}',
                Size: '{{A8:SIZE:20}}'
            });
            const mockEndpointManager = {
                getEndpoint: sinon.stub().resolves({ body }),
                updateEndpoint: sinon.stub().resolves({})
            };

            await service.savePaginationConfig(mockEndpointManager, 'ep-1', {
                location: 'body',
                paramKey: 'Page',
                startValue: 0,
                totalCountPath: 'header.totalCount',
                sizeParamKey: 'Size',
                sizeValue: 50
            });

            const updateCall = mockEndpointManager.updateEndpoint.firstCall.args[1];
            const parsed = JSON.parse(updateCall.body);
            expect(parsed.Page).to.equal('{{A8:PAGE:0:header.totalCount}}');
            expect(parsed.Size).to.equal('{{A8:SIZE:50}}');
            expect(parsed.Query).to.equal("AsnId = '900'");
            // must NOT touch query params for body pagination
            expect(updateCall.queryParams).to.be.undefined;
        });

        it('updates bodyWithComments alongside body when present', async () => {
            const service = new PaginationSetupService();
            const mockEndpointManager = {
                getEndpoint: sinon.stub().resolves({
                    body: '{"Page":"{{A8:PAGE:0}}"}',
                    bodyWithComments: '{\n  // page\n  "Page": "{{A8:PAGE:0}}"\n}'
                }),
                updateEndpoint: sinon.stub().resolves({})
            };

            await service.savePaginationConfig(mockEndpointManager, 'ep-1', {
                location: 'body',
                paramKey: 'Page',
                startValue: 0,
                totalCountPath: 'header.totalCount'
            });

            const updateCall = mockEndpointManager.updateEndpoint.firstCall.args[1];
            expect(updateCall.body).to.contain('{{A8:PAGE:0:header.totalCount}}');
            expect(updateCall.bodyWithComments).to.contain('{{A8:PAGE:0:header.totalCount}}');
            expect(updateCall.bodyWithComments).to.contain('// page');
        });
    });
});
