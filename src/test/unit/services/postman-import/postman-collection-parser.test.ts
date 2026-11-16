// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import {
    PostmanCollectionParser,
    isPostmanCollection
} from '../../../../services/postman-import/postman-collection-parser';

const SAMPLES = path.resolve(__dirname, '../../../../../sample-data/Postman_Collections');

function loadSample(name: string): string {
    return fs.readFileSync(path.join(SAMPLES, name), 'utf8');
}

describe('PostmanCollectionParser (GitHub #189)', () => {
    let parser: PostmanCollectionParser;

    beforeEach(() => {
        parser = new PostmanCollectionParser();
    });

    describe('isPostmanCollection sniff', () => {
        it('accepts a real Postman v2.1 collection', () => {
            const json = JSON.parse(loadSample('Clear.Sorting.Dedication.postman_collection.json'));
            expect(isPostmanCollection(json)).to.equal(true);
        });

        it('rejects an arbitrary JSON object', () => {
            expect(isPostmanCollection({ foo: 'bar' })).to.equal(false);
            expect(isPostmanCollection({ info: { name: 'x' }, items: [] })).to.equal(false);
            expect(isPostmanCollection(null)).to.equal(false);
        });
    });

    describe('Clear.Sorting.Dedication sample', () => {
        const SAMPLE = 'Clear.Sorting.Dedication.postman_collection.json';

        it('extracts 8 endpoints all under "Sorting"', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            expect(result.endpointCount).to.equal(8);
            expect(result.collectionName).to.equal('Clear Sorting Dedication');
            expect(result.folders).to.deep.equal(['Sorting']);
            for (const e of result.importPackage.endpoints.endpoints) {
                expect(e.folder).to.equal('Sorting');
            }
        });

        it('maps method, path, name and body correctly for first endpoint', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            const first = result.importPackage.endpoints.endpoints[0];
            expect(first.name).to.equal('Search Sort Location Assignments');
            expect(first.method).to.equal('POST');
            expect(first.path).to.equal('/sorting/api/stagingLocationAssignment/lpnLocationAssignment/search');
            expect(first.body).to.contain("LocationId in ('SG05-03')");
        });

        it('generates a fresh DBMN endpoint id for each request', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            const ids = result.importPackage.endpoints.endpoints.map(e => e.id);
            expect(new Set(ids).size).to.equal(ids.length);
            for (const id of ids) {
                expect(id).to.match(/^endpoint_/);
            }
        });

        it('includes headers when includeHeaders=true', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            const first = result.importPackage.endpoints.endpoints[0];
            expect(first.headers).to.have.property('Authorization', '{{token}}');
            expect(first.headers).to.have.property('organisation', '{{org}}');
            expect(first.headers).to.have.property('location', '{{loc}}');
            expect(first.headers).to.have.property('Content-Type', 'application/json');
        });

        it('omits headers when includeHeaders=false', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: false });
            for (const e of result.importPackage.endpoints.endpoints) {
                expect(e.headers).to.deep.equal({});
            }
            expect(result.headerCount).to.equal(0);
        });

        it('overrides folder when targetFolder is set', () => {
            const result = parser.parse(loadSample(SAMPLE), {
                includeHeaders: true,
                targetFolder: 'MyTarget'
            });
            for (const e of result.importPackage.endpoints.endpoints) {
                expect(e.folder).to.equal('MyTarget');
            }
            expect(result.folders).to.deep.equal(['MyTarget']);
        });

        it('targetFolder = empty string puts everything in root', () => {
            const result = parser.parse(loadSample(SAMPLE), {
                includeHeaders: false,
                targetFolder: ''
            });
            for (const e of result.importPackage.endpoints.endpoints) {
                expect(e.folder).to.equal(undefined);
            }
            expect(result.folders).to.deep.equal([]);
        });

        it('does not overwrite an explicit Authorization header with bearer token', () => {
            // The sample already has an explicit Authorization header AND auth.bearer.
            // Authorization header value must come from request.header[], not auth.bearer.
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            const first = result.importPackage.endpoints.endpoints[0];
            expect(first.headers!.Authorization).to.equal('{{token}}');
        });

        it('produces a synthetic ImportPackage with empty environments', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            expect(result.importPackage.environments.environments).to.deep.equal([]);
            expect(result.importPackage.metadata.exportedBy).to.equal('Postman Collection Import');
            expect(result.importPackage.folders.endpoints.folders).to.deep.equal(['Sorting']);
        });
    });

    describe('GPC_MAWM sample (deeper nesting + top-level requests)', () => {
        const SAMPLE = 'GPC_MAWM.postman_collection (1).json';

        it('flattens to 36 endpoints', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            expect(result.endpointCount).to.equal(36);
        });

        it('uses immediate parent folder name (collapses deeper nesting)', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            const folders = new Set(result.importPackage.endpoints.endpoints.map(e => e.folder || ''));
            expect(folders).to.include('EmpLive');
            expect(folders).to.include("Facility API's");
            expect(folders).to.include('Inbound');
            expect(folders).to.include('Items');
            expect(folders).to.include('Outbound');
        });

        it('top-level requests (with no folder) end up at root', () => {
            const result = parser.parse(loadSample(SAMPLE), { includeHeaders: true });
            const rootRequests = result.importPackage.endpoints.endpoints.filter(
                e => !e.folder
            );
            expect(rootRequests.length).to.be.greaterThan(0);
            const rootNames = rootRequests.map(e => e.name);
            expect(rootNames).to.include('API Auth Token');
            expect(rootNames).to.include('User-level Auth Token');
        });

        it('targetFolder override applies to all endpoints regardless of nesting', () => {
            const result = parser.parse(loadSample(SAMPLE), {
                includeHeaders: false,
                targetFolder: 'AllInOne'
            });
            for (const e of result.importPackage.endpoints.endpoints) {
                expect(e.folder).to.equal('AllInOne');
            }
        });
    });

    describe('contextual unsupported-feature detection', () => {
        it('returns no warnings for the clean Sorting sample (only raw bodies, bearer auth, no scripts)', () => {
            const result = parser.parse(
                loadSample('Clear.Sorting.Dedication.postman_collection.json'),
                { includeHeaders: true }
            );
            expect(result.unsupportedFeatures).to.deep.equal([]);
        });

        it('detects pre-request and test scripts when present', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [{
                    name: 'r',
                    event: [
                        { listen: 'prerequest', script: { exec: ['var x = 1;'] } },
                        { listen: 'test', script: { exec: ['pm.test(\'ok\', () => {})'] } }
                    ],
                    request: { method: 'GET', url: { path: ['x'] } }
                }]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            const codes = result.unsupportedFeatures.map(f => f.code);
            expect(codes).to.include('preRequestScripts');
            expect(codes).to.include('testScripts');
        });

        it('does not flag empty scripts (whitespace-only exec arrays)', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [{
                    name: 'r',
                    event: [{ listen: 'test', script: { exec: [''] } }],
                    request: { method: 'GET', url: { path: ['x'] } }
                }]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            expect(result.unsupportedFeatures).to.deep.equal([]);
        });

        it('detects non-raw bodies and lists distinct modes in detail', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [
                    { name: 'a', request: { method: 'POST', url: { path: ['x'] }, body: { mode: 'formdata' } } },
                    { name: 'b', request: { method: 'POST', url: { path: ['y'] }, body: { mode: 'urlencoded' } } },
                    { name: 'c', request: { method: 'POST', url: { path: ['z'] }, body: { mode: 'raw', raw: '{}' } } }
                ]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            const f = result.unsupportedFeatures.find(x => x.code === 'nonRawBodies');
            expect(f).to.exist;
            expect(f!.count).to.equal(2);
            expect(f!.detail).to.equal('formdata, urlencoded');
        });

        it('detects non-bearer auth types', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [
                    { name: 'a', request: { method: 'GET', url: { path: ['x'] }, auth: { type: 'apikey' } } },
                    { name: 'b', request: { method: 'GET', url: { path: ['y'] }, auth: { type: 'oauth2' } } },
                    { name: 'c', request: { method: 'GET', url: { path: ['z'] }, auth: { type: 'bearer', bearer: [{ key: 'token', value: 't' }] } } }
                ]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            const f = result.unsupportedFeatures.find(x => x.code === 'nonBearerAuth');
            expect(f).to.exist;
            expect(f!.count).to.equal(2);
            expect(f!.detail).to.equal('apikey, oauth2');
        });

        it('detects deep folder nesting', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [{
                    name: 'L1',
                    item: [{
                        name: 'L2',
                        item: [
                            { name: 'r', request: { method: 'GET', url: { path: ['x'] } } }
                        ]
                    }]
                }]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            const f = result.unsupportedFeatures.find(x => x.code === 'deepFolderNesting');
            expect(f).to.exist;
            expect(f!.count).to.equal(1);
        });

        it('detects collection-level variables and scripts', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                event: [{ listen: 'prerequest', script: { exec: ['globalThing = 1;'] } }],
                variable: [{ key: 'a', value: '1' }, { key: 'b', value: '2' }],
                item: [{ name: 'r', request: { method: 'GET', url: { path: ['x'] } } }]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            const codes = result.unsupportedFeatures.map(f => f.code);
            expect(codes).to.include('collectionLevelScripts');
            expect(codes).to.include('collectionVariables');
            const vars = result.unsupportedFeatures.find(f => f.code === 'collectionVariables');
            expect(vars!.count).to.equal(2);
        });

        it('builds a per-endpoint loss map only for affected endpoints', () => {
            const collection = JSON.stringify({
                info: { name: 't', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [
                    {
                        name: 'lossy',
                        event: [{ listen: 'test', script: { exec: ['pm.test(\'x\',()=>{})'] } }],
                        request: {
                            method: 'POST',
                            url: { path: ['x'] },
                            body: { mode: 'urlencoded' },
                            auth: { type: 'oauth2' }
                        }
                    },
                    {
                        name: 'clean',
                        request: { method: 'GET', url: { path: ['y'] } }
                    }
                ]
            });
            const result = parser.parse(collection, { includeHeaders: false });
            const lossy = result.importPackage.endpoints.endpoints.find(e => e.name === 'lossy')!;
            const clean = result.importPackage.endpoints.endpoints.find(e => e.name === 'clean')!;

            // lossy endpoint has a loss entry covering all the dropped features
            const lossyLoss = result.lostByEndpointId[lossy.id];
            expect(lossyLoss).to.exist;
            expect(lossyLoss.testScripts).to.equal(1);
            expect(lossyLoss.nonRawBodyMode).to.equal('urlencoded');
            expect(lossyLoss.nonBearerAuthType).to.equal('oauth2');

            // clean endpoint is NOT in the loss map at all
            expect(result.lostByEndpointId[clean.id]).to.be.undefined;
        });

        it('GPC_MAWM detects test scripts, non-raw bodies and basic auth (but not deep nesting — it is single-level)', () => {
            const result = parser.parse(loadSample('GPC_MAWM.postman_collection (1).json'), { includeHeaders: false });
            const codes = result.unsupportedFeatures.map(f => f.code);
            expect(codes).to.include('testScripts');
            expect(codes).to.include('nonRawBodies');
            expect(codes).to.include('nonBearerAuth');
            expect(codes).not.to.include('deepFolderNesting');
        });
    });

    describe('error handling', () => {
        it('throws when JSON is malformed', () => {
            expect(() => parser.parse('not json', { includeHeaders: true })).to.throw();
        });

        it('throws when JSON is not a Postman collection', () => {
            const stub = JSON.stringify({ foo: 'bar' });
            expect(() => parser.parse(stub, { includeHeaders: true })).to.throw(
                /Postman v2.1 collection/
            );
        });
    });
});
