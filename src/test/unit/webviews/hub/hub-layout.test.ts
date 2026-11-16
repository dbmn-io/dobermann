// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const HubLayoutMath = require('../../../../webviews/hub/hub-layout');

// GitHub Issue #349: the list panel (L2) is a drawer over the tab content.
// These helpers size it, decide which list actions close it, and map tabs
// to the rail item that owns them.

describe('hub-layout — drawer maths (Issue #349)', () => {
    const { MIN_DRAWER_W, DRAWER_GUTTER_W, DEFAULT_DRAWER_W, PREVIEW_CLOSE_DELAY_MS } = HubLayoutMath;

    describe('clampDrawerWidth', () => {
        it('passes a width that fits straight through', () => {
            expect(HubLayoutMath.clampDrawerWidth(400, 1600)).to.equal(400);
        });
        it('never goes below the minimum', () => {
            expect(HubLayoutMath.clampDrawerWidth(100, 1600)).to.equal(MIN_DRAWER_W);
        });
        it('leaves a gutter of tab content showing', () => {
            expect(HubLayoutMath.clampDrawerWidth(2000, 900)).to.equal(900 - DRAWER_GUTTER_W);
        });
        it('the minimum wins when the space is too narrow for both', () => {
            expect(HubLayoutMath.clampDrawerWidth(360, 200)).to.equal(MIN_DRAWER_W);
        });
        it('falls back to the default for a missing or bad width', () => {
            expect(HubLayoutMath.clampDrawerWidth(undefined, 1600)).to.equal(DEFAULT_DRAWER_W);
            expect(HubLayoutMath.clampDrawerWidth(NaN, 1600)).to.equal(DEFAULT_DRAWER_W);
            expect(HubLayoutMath.clampDrawerWidth(0, 1600)).to.equal(DEFAULT_DRAWER_W);
        });
    });

    describe('drawerCloseDelay', () => {
        it('closes at once for actions that open or focus a tab', () => {
            for (const type of ['openEndpointAsTab', 'openEnvironmentAsTab', 'openTransaction',
                'openBatchAsTab', 'runEndpoint', 'addEndpoint', 'addEnvironment']) {
                expect(HubLayoutMath.drawerCloseDelay({ type }), type).to.equal(0);
            }
        });
        it('waits out the double-click window for a catalogue preview', () => {
            expect(HubLayoutMath.drawerCloseDelay({ type: 'openEndpointAsTab', preview: true }))
                .to.equal(PREVIEW_CLOSE_DELAY_MS);
            expect(HubLayoutMath.drawerCloseDelay({ type: 'openEndpointAsTab', preview: false })).to.equal(0);
        });
        it('leaves the drawer open for everything else', () => {
            for (const type of ['searchTransactionContent', 'transactionAction', 'bulkDeleteEndpoints',
                'bulkDeleteTransactions', 'setHubPreferences', 'requestCloseEditors']) {
                expect(HubLayoutMath.drawerCloseDelay({ type }), type).to.equal(null);
            }
            expect(HubLayoutMath.drawerCloseDelay(undefined)).to.equal(null);
        });
    });

    describe('sectionForTab', () => {
        it('maps each tab type to the list that owns it', () => {
            expect(HubLayoutMath.sectionForTab({ type: 'endpoint' })).to.equal('catalogue');
            expect(HubLayoutMath.sectionForTab({ type: 'batch' })).to.equal('catalogue');
            expect(HubLayoutMath.sectionForTab({ type: 'environment' })).to.equal('environments');
            expect(HubLayoutMath.sectionForTab({ type: 'console' })).to.equal('transactions');
            expect(HubLayoutMath.sectionForTab({ type: 'batchConsole' })).to.equal('transactions');
        });
        it('page tabs map to their own rail item', () => {
            expect(HubLayoutMath.sectionForTab({ type: 'page', refId: 'settings' })).to.equal('settings');
        });
        it('returns null for no tab or an unknown type', () => {
            expect(HubLayoutMath.sectionForTab(null)).to.equal(null);
            expect(HubLayoutMath.sectionForTab({ type: 'mystery' })).to.equal(null);
        });
    });

    describe('isPageTabId', () => {
        it('matches page:* ids only', () => {
            expect(HubLayoutMath.isPageTabId('page:settings')).to.equal(true);
            expect(HubLayoutMath.isPageTabId('endpoint:settings')).to.equal(false);
            expect(HubLayoutMath.isPageTabId(undefined)).to.equal(false);
        });
    });
});
