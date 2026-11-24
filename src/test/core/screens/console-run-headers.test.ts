// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The Console's Settings tab lists the run's header values, each by its own name, in place of a
 * fixed Organization (James, 2026-11-24: "Remove organization… it should just be whatever headings
 * exist on the environment that we've run against… the ones that we show in the heading should be
 * on this screen").
 */
import { expect } from 'chai';
import { runHeaders } from '../../../screens/console/run-headers';
import { buildConsolePage } from '../../../screens/console/console-page';

/** An environment whose header shows org and version, and keeps one other variable. */
const environment = {
    variables: { org: '840', version: 'v3', skuPrefix: 'AB' },
    variableSettings: { org: { showInHeader: true }, version: { showInHeader: true }, skuPrefix: {} }
};

describe('Console: the run\'s header values', () => {
    it('a run lists the values it was sent with, by their own names, in the header\'s order', () => {
        expect(runHeaders({ version: 'v2', org: '880' }, undefined, environment)).to.deep.equal([{ name: 'org', value: '880' }, { name: 'version', value: 'v2' }]);
    });

    it('a batch, which kept every variable, lists only the header\'s', () => {
        expect(runHeaders({ org: '880', version: 'v2', skuPrefix: 'XY' }, undefined, environment)).to.deep.equal([{ name: 'org', value: '880' }, { name: 'version', value: 'v2' }]);
    });

    it('an old run that kept only its organization shows it as org', () => {
        expect(runHeaders(undefined, '880', environment)).to.deep.equal([{ name: 'org', value: '880' }]);
        expect(runHeaders(undefined, '880', undefined)).to.deep.equal([{ name: 'org', value: '880' }]);
        expect(runHeaders({ version: 'v2' }, '880', environment)).to.deep.equal([{ name: 'org', value: '880' }, { name: 'version', value: 'v2' }]);
    });

    it('with its environment gone, what the run kept', () => {
        expect(runHeaders({ org: '880', region: 'east' }, undefined, undefined)).to.deep.equal([{ name: 'org', value: '880' }, { name: 'region', value: 'east' }]);
    });

    it('none: nothing, and Unknown is no value', () => {
        expect(runHeaders(undefined, undefined, environment)).to.deep.equal([]);
        expect(runHeaders({ org: '' }, 'Unknown', environment)).to.deep.equal([]);
    });
});

describe('Console: the Settings tab', () => {
    const template = '<div id="sending-to">{{RUN_HEADERS}}</div><div id="vars" data-env-vars="{{ENVIRONMENT_VARIABLES_JSON}}"></div>';
    const page = (summary: Record<string, unknown>) => buildConsolePage(template, () => '', { type: 'batch', responseFiles: [], executionSummary: { status: 'completed', ...summary } } as never);
    const vars = (html: string) => {
        const encoded = /data-env-vars="([^"]*)"/.exec(html)![1];
        return encoded ? JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) : {};
    };

    it('lists each header by its own name, never a fixed Organization', () => {
        const html = page({ headers: [{ name: 'org', value: '880' }, { name: 'version', value: 'v2' }], organization: '880' });
        expect(html).to.contain('<span class="stat-label">org</span><span class="font-mono">880</span>');
        expect(html).to.contain('<span class="stat-label">version</span><span class="font-mono">v2</span>');
        expect(html).to.not.contain('Organization');
    });

    it('escapes what it shows', () => {
        expect(page({ headers: [{ name: 'org', value: '<b>880</b>' }] })).to.contain('&lt;b&gt;880&lt;/b&gt;');
    });

    it('Variables keeps the rest: a header is not listed twice', () => {
        const html = page({ headers: [{ name: 'org', value: '880' }], environmentVariables: { org: '880', skuPrefix: 'XY' } });
        expect(vars(html)).to.deep.equal({ skuPrefix: 'XY' });
    });
});
