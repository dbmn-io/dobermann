// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #298: how many pages a paginated endpoint's total needs, from one page's response. The engine
 * uses it to mark a paginated batch complete once every page is in (Compare flags it until then).
 */
import { expect } from 'chai';
import { PaginationDetectorService } from '../../../services/pagination/pagination-detector.service';
import type { APIEndpointConfig } from '../../../data-loading/types';

const endpoint = (queryParams: Record<string, string>): APIEndpointConfig =>
    ({ id: 'e', name: 'Inventory', method: 'GET', path: '/inventory', queryParams } as unknown as APIEndpointConfig);
const pages = (e: APIEndpointConfig, body: unknown) => new PaginationDetectorService().totalPagesFromResponse(e, body);

describe('Pages a paginated total needs', () => {
    it('the total over the page size, a short last page included', () => {
        const e = endpoint({ page: '{{A8:PAGE:0:header.totalCount}}', size: '100' });
        expect(pages(e, { header: { totalCount: '950' } })).to.equal(10);
        expect(pages(e, { header: { totalCount: 1000 } })).to.equal(10);
    });

    it('Lesson 4: the total at the top, the size from the template', () => {
        const e = endpoint({ page: '{{A8:PAGE:0:totalCount}}', size: '{{A8:SIZE:500:pageSize}}' });
        expect(pages(e, { totalCount: 5000, pageSize: 500, data: [] })).to.equal(10);
    });

    it('a path written from the saved file ("data.…") is read on the body', () => {
        const e = endpoint({ page: '{{A8:PAGE:1:data.header.totalCount}}', size: '50' });
        expect(pages(e, { header: { totalCount: 100 } })).to.equal(2);
    });

    it('the page size from the response when the request has none', () => {
        const e = endpoint({ page: '{{A8:PAGE:0:header.totalCount}}' });
        expect(pages(e, { header: { totalCount: 300 }, pageSize: 100 })).to.equal(3);
    });

    it('#446: the API sends fewer per page than asked: its own page size and pages win', () => {
        // The Training Ground: asked for 2,000, it sends 500 and says so. 105,000 rows was 53 pages, 26,500 rows
        const e = endpoint({ page: '{{A8:PAGE:0:totalCount}}', size: '2000' });
        expect(pages(e, { totalCount: 105000, pageSize: 500, totalPages: 211, data: [] })).to.equal(211);
        // No totalPages in the response: its page size
        expect(pages(e, { totalCount: 105000, pageSize: 500, data: [] })).to.equal(210);
        // A response page size bigger than asked doesn't matter: the request's
        expect(pages(endpoint({ page: '{{A8:PAGE:0:totalCount}}', size: '100' }), { totalCount: 1000, pageSize: 500 })).to.equal(10);
    });

    it('#446: once the page size is known, a short last page does not shrink it', () => {
        const detector = new PaginationDetectorService();
        expect(detector.pagesFor(1050, 100, { size: 50 }, undefined, false)).to.deep.equal({ totalPages: 11, pageSize: 100 });
        expect(detector.pagesFor(1050, 100, { size: 50 })).to.deep.equal({ totalPages: 21, pageSize: 50 });   // the first page: learned
    });

    it('#446: later pages ask for the page size the API sends, when it sends fewer than asked', () => {
        // Asked for 2,000, it sends 500. Asking for 2,000 again, an API that starts page 2 at
        // page × 2,000 and sends 500 skips 1,500 rows a page; asking for 500 is right on any API
        const detector = new PaginationDetectorService();
        const e = endpoint({ page: '{{A8:PAGE:0:totalCount}}', size: '{{A8:SIZE:2000:pageSize}}' });
        const sizes = detector.sizeToAsk(e, { totalCount: 105000, pageSize: 500, data: [] });
        expect(sizes).to.deep.equal({ asked: 2000, sent: 500 });
        expect(detector.replacePaginationTemplate(e.queryParams as Record<string, string>, detector.detectPagination(e) as never, 1, sizes?.sent))
            .to.deep.equal({ page: '1', size: '500' });
        expect(detector.replacePaginationInBody('{"Page": "{{A8:PAGE:0:header.totalCount}}", "Size": {{A8:SIZE:2000}}}', 1, 500))
            .to.equal('{"Page": "1", "Size": 500}');
        // Sent what was asked, or more, or says nothing: the template's size
        expect(detector.sizeToAsk(e, { totalCount: 105000, pageSize: 2000 })).to.equal(undefined);
        expect(detector.sizeToAsk(e, { totalCount: 105000 })).to.equal(undefined);
        expect(detector.replacePaginationTemplate(e.queryParams as Record<string, string>, detector.detectPagination(e) as never, 1))
            .to.deep.equal({ page: '1', size: '2000' });
    });

    it('nothing when it cannot be told', () => {
        expect(pages(endpoint({ limit: '500' }), { totalCount: 5000 })).to.equal(undefined);                          // not paginated
        expect(pages(endpoint({ page: '{{A8:PAGE}}', size: '100' }), { totalCount: 5000 })).to.equal(undefined);      // no total path
        expect(pages(endpoint({ page: '{{A8:PAGE:0:totalCount}}', size: '100' }), { header: {} })).to.equal(undefined); // no total
    });
});
