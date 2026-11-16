// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { isEmptyRequestBody } from '../../../../services/console/request-body';

describe('isEmptyRequestBody (Issue #306)', () => {
    it('treats a missing or blank body as empty', () => {
        expect(isEmptyRequestBody(null)).to.equal(true);
        expect(isEmptyRequestBody(undefined)).to.equal(true);
        expect(isEmptyRequestBody('')).to.equal(true);
        expect(isEmptyRequestBody('  \n ')).to.equal(true);
    });

    it('treats {} and [] as empty, however they are formatted', () => {
        expect(isEmptyRequestBody('{}')).to.equal(true);
        expect(isEmptyRequestBody('{\n}')).to.equal(true);
        expect(isEmptyRequestBody(' [ ] ')).to.equal(true);
    });

    it('keeps a body with content', () => {
        expect(isEmptyRequestBody('{"sku":"A"}')).to.equal(false);
        expect(isEmptyRequestBody('[{}]')).to.equal(false);
        expect(isEmptyRequestBody('{"a":null}')).to.equal(false);
    });

    it('keeps non-JSON bodies (XML, text)', () => {
        expect(isEmptyRequestBody('<order/>')).to.equal(false);
        expect(isEmptyRequestBody('plain text')).to.equal(false);
        expect(isEmptyRequestBody('null')).to.equal(false);
    });
});
