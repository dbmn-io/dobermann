// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import '../../../helpers/vscode-mock';

import { expect } from 'chai';
import { describe, it } from 'mocha';
import { PaginationDetectorService } from '../../../../services/pagination/pagination-detector.service';
import { APIEndpointConfig } from '../../../../data-loading/types';

describe('PaginationDetectorService', () => {

    function makeEndpoint(queryParams: Record<string, string>): APIEndpointConfig {
        return { queryParams } as unknown as APIEndpointConfig;
    }

    describe('detectSize', () => {
        it('should detect {{A8:SIZE:100}} in query params', () => {
            const detector = new PaginationDetectorService();
            const endpoint = makeEndpoint({ size: '{{A8:SIZE:100}}' });
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.paramKey).to.equal('size');
                expect(result.value).to.equal(100);
            }
        });

        it('should detect {{A8:SIZE:50}} with different param name', () => {
            const detector = new PaginationDetectorService();
            const endpoint = makeEndpoint({ limit: '{{A8:SIZE:50}}' });
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.paramKey).to.equal('limit');
                expect(result.value).to.equal(50);
            }
        });

        it('should return disabled when no size template found', () => {
            const detector = new PaginationDetectorService();
            const endpoint = makeEndpoint({ size: '100' });
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(false);
        });

        it('should return disabled when queryParams is undefined', () => {
            const detector = new PaginationDetectorService();
            const endpoint = {} as APIEndpointConfig;
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(false);
        });

        it('should handle HeaderConfig format', () => {
            const detector = new PaginationDetectorService();
            const endpoint = {
                queryParams: { size: { value: '{{A8:SIZE:200}}', enabled: true } }
            } as unknown as APIEndpointConfig;
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.paramKey).to.equal('size');
                expect(result.value).to.equal(200);
            }
        });

        it('should skip disabled params', () => {
            const detector = new PaginationDetectorService();
            const endpoint = {
                queryParams: { size: { value: '{{A8:SIZE:100}}', enabled: false } }
            } as unknown as APIEndpointConfig;
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(false);
        });

        it('should detect {{A8:SIZE:100:header.pageSize}} with sizePath', () => {
            const detector = new PaginationDetectorService();
            const endpoint = makeEndpoint({ size: '{{A8:SIZE:100:header.pageSize}}' });
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.paramKey).to.equal('size');
                expect(result.value).to.equal(100);
                expect(result.sizePath).to.equal('header.pageSize');
            }
        });

        it('should return sizePath as undefined when not present', () => {
            const detector = new PaginationDetectorService();
            const endpoint = makeEndpoint({ size: '{{A8:SIZE:100}}' });
            const result = detector.detectSize(endpoint);
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.value).to.equal(100);
                expect(result.sizePath).to.be.undefined;
            }
        });
    });

    describe('replacePaginationTemplate - SIZE resolution', () => {
        it('should resolve {{A8:SIZE:100}} to 100', () => {
            const detector = new PaginationDetectorService();
            const queryParams = {
                page: '{{A8:PAGE:0}}',
                size: '{{A8:SIZE:100}}'
            };
            const paginationConfig = {
                enabled: true as const,
                location: 'query' as const,
                paramKey: 'page',
                startValue: 0,
                templateVariable: '{{A8:PAGE:0}}'
            };
            const result = detector.replacePaginationTemplate(queryParams, paginationConfig, 0);
            expect(result.page).to.equal('0');
            expect(result.size).to.equal('100');
        });

        it('should resolve both PAGE and SIZE in a single pass', () => {
            const detector = new PaginationDetectorService();
            const queryParams = {
                page: '{{A8:PAGE:1:header.totalCount}}',
                limit: '{{A8:SIZE:50}}',
                filter: 'active'
            };
            const paginationConfig = {
                enabled: true as const,
                location: 'query' as const,
                paramKey: 'page',
                startValue: 1,
                totalCountPath: 'header.totalCount',
                templateVariable: '{{A8:PAGE:1:header.totalCount}}'
            };
            const result = detector.replacePaginationTemplate(queryParams, paginationConfig, 3);
            expect(result.page).to.equal('3');
            expect(result.limit).to.equal('50');
            expect(result.filter).to.equal('active');
        });

        it('should handle SIZE in HeaderConfig format', () => {
            const detector = new PaginationDetectorService();
            const queryParams = {
                page: '{{A8:PAGE:0}}',
                size: { value: '{{A8:SIZE:25}}', enabled: true }
            };
            const paginationConfig = {
                enabled: true as const,
                location: 'query' as const,
                paramKey: 'page',
                startValue: 0,
                templateVariable: '{{A8:PAGE:0}}'
            };
            const result = detector.replacePaginationTemplate(queryParams, paginationConfig, 2);
            expect(result.page).to.equal('2');
            expect(result.size).to.deep.equal({ value: '25', enabled: true });
        });

        it('should leave params without templates unchanged', () => {
            const detector = new PaginationDetectorService();
            const queryParams = {
                page: '{{A8:PAGE:0}}',
                size: '100',
                filter: 'active'
            };
            const paginationConfig = {
                enabled: true as const,
                location: 'query' as const,
                paramKey: 'page',
                startValue: 0,
                templateVariable: '{{A8:PAGE:0}}'
            };
            const result = detector.replacePaginationTemplate(queryParams, paginationConfig, 5);
            expect(result.page).to.equal('5');
            expect(result.size).to.equal('100');
            expect(result.filter).to.equal('active');
        });

        it('should resolve {{A8:SIZE:100:header.pageSize}} to 100', () => {
            const detector = new PaginationDetectorService();
            const queryParams = {
                page: '{{A8:PAGE:0}}',
                size: '{{A8:SIZE:100:header.pageSize}}'
            };
            const paginationConfig = {
                enabled: true as const,
                location: 'query' as const,
                paramKey: 'page',
                startValue: 0,
                templateVariable: '{{A8:PAGE:0}}'
            };
            const result = detector.replacePaginationTemplate(queryParams, paginationConfig, 0);
            expect(result.page).to.equal('0');
            expect(result.size).to.equal('100');
        });

        it('should resolve SIZE with sizePath in HeaderConfig format', () => {
            const detector = new PaginationDetectorService();
            const queryParams = {
                page: '{{A8:PAGE:1}}',
                size: { value: '{{A8:SIZE:50:data.pageSize}}', enabled: true }
            };
            const paginationConfig = {
                enabled: true as const,
                location: 'query' as const,
                paramKey: 'page',
                startValue: 1,
                templateVariable: '{{A8:PAGE:1}}'
            };
            const result = detector.replacePaginationTemplate(queryParams, paginationConfig, 2);
            expect(result.page).to.equal('2');
            expect(result.size).to.deep.equal({ value: '50', enabled: true });
        });
    });

    describe('extractPageSizeFromResponse - with sizePath', () => {
        it('should extract page size from explicit sizePath', () => {
            const detector = new PaginationDetectorService();
            const response = { header: { pageSize: 25 } };
            const result = detector.extractPageSizeFromResponse(response, 'header.pageSize');
            expect(result).to.equal(25);
        });

        it('should fall back to common paths when sizePath not found', () => {
            const detector = new PaginationDetectorService();
            const response = { pageSize: 50 };
            const result = detector.extractPageSizeFromResponse(response, 'nonexistent.path');
            expect(result).to.equal(50);
        });

        it('should fall back to common paths when no sizePath provided', () => {
            const detector = new PaginationDetectorService();
            const response = { pageSize: 30 };
            const result = detector.extractPageSizeFromResponse(response);
            expect(result).to.equal(30);
        });

        it('should prefer sizePath over common paths', () => {
            const detector = new PaginationDetectorService();
            const response = { pageSize: 10, custom: { mySize: 99 } };
            const result = detector.extractPageSizeFromResponse(response, 'custom.mySize');
            expect(result).to.equal(99);
        });
    });

    // GitHub Issue #245: pagination via templates in the request body
    describe('body pagination (#245)', () => {
        function makeBodyEndpoint(body: string): APIEndpointConfig {
            return { body } as unknown as APIEndpointConfig;
        }

        const body = JSON.stringify({
            Query: "AsnId = '900'",
            Page: '{{A8:PAGE:0:header.totalCount}}',
            Size: '{{A8:SIZE:20}}'
        });

        it('detects a page template in the body with location "body"', () => {
            const detector = new PaginationDetectorService();
            const result = detector.detectPagination(makeBodyEndpoint(body));
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.location).to.equal('body');
                expect(result.paramKey).to.equal('Page');
                expect(result.startValue).to.equal(0);
                expect(result.totalCountPath).to.equal('header.totalCount');
            }
        });

        it('detects a size template in the body with location "body"', () => {
            const detector = new PaginationDetectorService();
            const result = detector.detectSize(makeBodyEndpoint(body));
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.location).to.equal('body');
                expect(result.paramKey).to.equal('Size');
                expect(result.value).to.equal(20);
            }
        });

        it('prefers query-param pagination over body when both present', () => {
            const detector = new PaginationDetectorService();
            const endpoint = {
                queryParams: { page: '{{A8:PAGE:1}}' },
                body
            } as unknown as APIEndpointConfig;
            const result = detector.detectPagination(endpoint);
            expect(result.enabled).to.equal(true);
            if (result.enabled) {
                expect(result.location).to.equal('query');
                expect(result.startValue).to.equal(1);
            }
        });

        it('ignores templates that are commented out', () => {
            const detector = new PaginationDetectorService();
            const commented = '{\n  // "Page": "{{A8:PAGE:0}}"\n  "Query": "x"\n}';
            const result = detector.detectPagination(makeBodyEndpoint(commented));
            expect(result.enabled).to.equal(false);
        });

        it('replacePaginationInBody substitutes page and size literals', () => {
            const detector = new PaginationDetectorService();
            const resolved = detector.replacePaginationInBody(body, 3);
            const parsed = JSON.parse(resolved);
            expect(parsed.Page).to.equal('3');
            expect(parsed.Size).to.equal('20');
            expect(parsed.Query).to.equal("AsnId = '900'");
            expect(resolved).to.not.contain('{{A8:');
        });

        it('extractPageSizeFromBody reads the size template value', () => {
            const detector = new PaginationDetectorService();
            expect(detector.extractPageSizeFromBody(body)).to.equal(20);
            expect(detector.extractPageSizeFromBody('{"Query":"x"}')).to.equal(undefined);
        });
    });
});
