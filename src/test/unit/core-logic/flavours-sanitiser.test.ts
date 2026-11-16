// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    reconcileFlavours,
    sanitizeEndpointConfig
} from '../../../apiConfigManager';
import type { Flavour } from '../../../data-loading/zod-schemas';

describe('reconcileFlavours — backward-compat sync between body and flavours[0]', () => {
    it('wraps a legacy body into a single Default flavour when flavours is empty', () => {
        const result = reconcileFlavours('{"a":1}', undefined, undefined);
        expect(result.flavours).to.have.lengthOf(1);
        expect(result.flavours[0].name).to.equal('Default');
        expect(result.flavours[0].body).to.equal('{"a":1}');
        expect(result.body).to.equal('{"a":1}');
    });

    it('produces a single empty Default flavour when both body and flavours are missing', () => {
        const result = reconcileFlavours(undefined, undefined, undefined);
        expect(result.flavours).to.have.lengthOf(1);
        expect(result.flavours[0].name).to.equal('Default');
        expect(result.flavours[0].body).to.equal(undefined);
        expect(result.body).to.equal(undefined);
    });

    it('copies the first flavour\'s body up to the endpoint level when flavours is set', () => {
        const flavours: Flavour[] = [
            { id: 'f1', name: 'minimal', body: '{"x":1}' },
            { id: 'f2', name: 'full',    body: '{"x":1,"y":2,"z":3}' }
        ];
        const result = reconcileFlavours(undefined, undefined, flavours);
        expect(result.body).to.equal('{"x":1}');
        expect(result.flavours).to.have.lengthOf(2);
        expect(result.flavours.map(f => f.name)).to.deep.equal(['minimal', 'full']);
    });

    it('lets an explicit body override flavours[0] and syncs it back into the primary flavour', () => {
        // Until the endpoint editor learns about flavours (P1c), every save
        // from the editor passes the user's latest body in `body` /
        // `bodyWithComments` but doesn't touch the flavours array — the
        // flavours[0].body in storage stays at whatever it was when the
        // record was last reconciled. If the sanitizer preferred flavours
        // here it would silently throw away every body edit. The explicit
        // body wins and flavours[0] is updated to match.
        const flavours: Flavour[] = [{ id: 'f1', name: 'Default', body: '{"old":true}' }];
        const result = reconcileFlavours('{"new":true}', undefined, flavours);
        expect(result.body).to.equal('{"new":true}');
        expect(result.flavours[0].body).to.equal('{"new":true}');
    });

    it('keeps the primary flavour when body is omitted (migration / partial-update path)', () => {
        // If the caller didn't pass body at all (undefined, not empty
        // string), flavours[0] is the source of truth. This is the
        // migration scenario — legacy records that have flavours but the
        // top-level body was never written.
        const flavours: Flavour[] = [{ id: 'f1', name: 'Default', body: '{"keep":true}' }];
        const result = reconcileFlavours(undefined, undefined, flavours);
        expect(result.body).to.equal('{"keep":true}');
        expect(result.flavours[0].body).to.equal('{"keep":true}');
    });

    it('treats an empty-string body as "user cleared the body" and syncs flavours[0] to empty', () => {
        const flavours: Flavour[] = [{ id: 'f1', name: 'Default', body: '{"will-be-cleared":true}' }];
        const result = reconcileFlavours('', '', flavours);
        expect(result.body).to.equal(undefined);
        expect(result.flavours[0].body).to.equal(undefined);
    });

    it('trims whitespace from flavour names and bodies', () => {
        const flavours: Flavour[] = [
            { id: 'f1', name: '  spaced  ', body: '  {"a":1}  ' }
        ];
        const result = reconcileFlavours(undefined, undefined, flavours);
        expect(result.flavours[0].name).to.equal('spaced');
        expect(result.flavours[0].body).to.equal('{"a":1}');
    });

    it('assigns a generated id to flavours that arrive without one', () => {
        const flavours: Flavour[] = [
            { id: '', name: 'no-id', body: '{}' } as Flavour
        ];
        const result = reconcileFlavours(undefined, undefined, flavours);
        expect(result.flavours[0].id).to.match(/^flavour_/);
    });

    it('preserves bodyWithComments from the first flavour up to the endpoint level', () => {
        const flavours: Flavour[] = [
            { id: 'f1', name: 'commented', body: '{"a":1}', bodyWithComments: '// hi\n{"a":1}' }
        ];
        const result = reconcileFlavours(undefined, undefined, flavours);
        expect(result.bodyWithComments).to.equal('// hi\n{"a":1}');
    });
});

describe('sanitizeEndpointConfig — flavours + tags integration', () => {
    it('auto-wraps a legacy body record into a Default flavour without changing visible body', () => {
        const config = sanitizeEndpointConfig({
            name: 'Old endpoint',
            path: '/api/legacy',
            method: 'POST',
            headers: {},
            queryParams: {},
            body: '{"legacy":true}'
        });
        expect(config.body).to.equal('{"legacy":true}');
        expect(config.flavours).to.exist;
        expect(config.flavours!).to.have.lengthOf(1);
        expect(config.flavours![0].name).to.equal('Default');
        expect(config.flavours![0].body).to.equal('{"legacy":true}');
    });

    it('preserves explicitly-provided flavours and resyncs body to the first flavour', () => {
        const config = sanitizeEndpointConfig({
            name: 'Multi flavour',
            path: '/api/orders',
            method: 'POST',
            headers: {},
            queryParams: {},
            flavours: [
                { id: 'a', name: 'minimal', body: '{"min":1}' },
                { id: 'b', name: 'full',    body: '{"min":1,"extra":2}' }
            ]
        });
        expect(config.flavours).to.have.lengthOf(2);
        expect(config.body).to.equal('{"min":1}');  // synced from flavours[0]
    });

    it('deduplicates and trims tags, drops empty strings', () => {
        const config = sanitizeEndpointConfig({
            name: 'Tagged',
            path: '/api/x',
            method: 'GET',
            headers: {},
            queryParams: {},
            tags: ['smoke', '  smoke  ', '', 'team/backend', 'team/backend']
        });
        expect(config.tags).to.deep.equal(['smoke', 'team/backend']);
    });

    it('returns undefined tags when none provided (so the field stays optional)', () => {
        const config = sanitizeEndpointConfig({
            name: 'Untagged',
            path: '/api/x',
            method: 'GET',
            headers: {},
            queryParams: {}
        });
        expect(config.tags).to.equal(undefined);
    });

    it('always carries a flavours array of length >= 1 after sanitisation', () => {
        const blank = sanitizeEndpointConfig({
            name: 'Empty',
            path: '/api/empty',
            method: 'GET',
            headers: {},
            queryParams: {}
        });
        expect(blank.flavours).to.exist;
        expect(blank.flavours!.length).to.be.at.least(1);
        expect(blank.flavours![0].name).to.equal('Default');
    });
});
