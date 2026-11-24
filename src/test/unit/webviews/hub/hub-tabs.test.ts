// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';

/* hub-tabs.js attaches itself to `window.HubTabs` via an IIFE that also
 * touches `document`. Stub both before requiring so the module loads
 * cleanly in a non-DOM test runner. The renderer subscribes itself on
 * `init()`, which we never call here — these tests cover the pure state
 * reducer only. */
function loadHubTabs() {
    const w = global as unknown as {
        window?: Record<string, unknown>;
        document?: Record<string, unknown>;
    };
    if (!w.window) w.window = {};
    if (!w.document) {
        w.document = {
            getElementById: () => null,
            querySelector: () => null,
            addEventListener: () => undefined
        };
    }
    delete require.cache[require.resolve('../../../../webviews/hub/hub-tabs')];
    require('../../../../webviews/hub/hub-tabs');
    return (w.window as { HubTabs: HubTabs }).HubTabs;
}

interface TabSpec {
    id?: string;
    type: 'endpoint' | 'environment' | 'console' | 'batch' | 'page';
    refId: string;
    name?: string;
    preview?: boolean;
}

interface Tab {
    id: string;
    type: string;
    refId: string;
    name: string;
    preview: boolean;
    dirty: boolean;
    status?: string;
    progress?: { done: number; total: number };
}

interface HubTabs {
    getState: () => { tabs: Tab[]; activeTabId: string | null; previewTabId: string | null };
    openOrFocusTab: (spec: TabSpec) => Tab;
    focusTab: (id: string) => void;
    closeTab: (id: string) => boolean;
    markDirty: (id: string, dirty: boolean) => void;
    promotePreviewToKept: (id: string) => void;
    setStatus: (id: string, status: string, progress?: { done: number; total: number }) => void;
    reorderTab: (id: string, newIndex: number) => void;
    _makeTabId: (type: string, refId: string) => string;
    _swapTab: (fromId: string, spec: TabSpec & { id: string }) => Tab;
}

describe('HubTabs — tab state reducer (R1-2)', () => {
    let HubTabs: HubTabs;

    beforeEach(() => {
        HubTabs = loadHubTabs();
    });

    describe('openOrFocusTab', () => {
        it('opens a new tab and makes it active', () => {
            const tab = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'My Endpoint' });
            const s = HubTabs.getState();
            expect(s.tabs).to.have.length(1);
            expect(s.activeTabId).to.equal(tab.id);
            expect(tab.name).to.equal('My Endpoint');
            expect(tab.preview).to.equal(false);
            expect(tab.dirty).to.equal(false);
        });

        it('focuses an existing tab (same type + refId) without creating a duplicate', () => {
            const a = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'A' });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-2', name: 'B' });
            const focused = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'A' });
            expect(focused.id).to.equal(a.id);
            expect(HubTabs.getState().tabs).to.have.length(2);
            expect(HubTabs.getState().activeTabId).to.equal(a.id);
        });

        it('replaces the existing preview tab in-place when opening another preview', () => {
            const p1 = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', preview: true });
            const p2 = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-2', preview: true });
            const s = HubTabs.getState();
            expect(s.tabs).to.have.length(1, 'preview slot should not accumulate');
            expect(s.tabs[0].id).to.equal(p2.id);
            expect(s.previewTabId).to.equal(p2.id);
            // Sanity: previous preview tab is gone.
            expect(s.tabs.find(t => t.id === p1.id)).to.equal(undefined);
        });

        it('keeps kept tabs while replacing the preview slot', () => {
            const kept = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'kept', name: 'Kept' });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'p1', preview: true });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'p2', preview: true });
            const s = HubTabs.getState();
            expect(s.tabs).to.have.length(2);
            expect(s.tabs[0].id).to.equal(kept.id);
            expect(s.tabs[1].refId).to.equal('p2');
        });

        it('promotes an existing preview tab to kept when reopened with preview:false', () => {
            const t = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', preview: true });
            expect(t.preview).to.equal(true);
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', preview: false });
            const s = HubTabs.getState();
            expect(s.tabs[0].preview).to.equal(false);
            expect(s.previewTabId).to.equal(null);
        });
    });

    describe('closeTab', () => {
        it('removes the tab and picks a sensible new active', () => {
            const a = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'a' });
            const b = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'b' });
            const c = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'c' });
            // Active is c. Close b (in the middle) — active stays c.
            HubTabs.closeTab(b.id);
            expect(HubTabs.getState().activeTabId).to.equal(c.id);
            // Close c (rightmost active) — active falls back to the new last.
            HubTabs.closeTab(c.id);
            expect(HubTabs.getState().activeTabId).to.equal(a.id);
            HubTabs.closeTab(a.id);
            expect(HubTabs.getState().activeTabId).to.equal(null);
            expect(HubTabs.getState().tabs).to.have.length(0);
        });

        it('returns false when closing a non-existent tab', () => {
            expect(HubTabs.closeTab('nope:nope')).to.equal(false);
        });

        it('clears the preview slot when closing the preview tab', () => {
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'p', preview: true });
            const s = HubTabs.getState();
            expect(s.previewTabId).to.not.equal(null);
            HubTabs.closeTab(s.previewTabId as string);
            expect(HubTabs.getState().previewTabId).to.equal(null);
        });
    });

    describe('markDirty', () => {
        it('promotes a preview tab to kept when it goes dirty', () => {
            const t = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'p', preview: true });
            HubTabs.markDirty(t.id, true);
            const s = HubTabs.getState();
            expect(s.tabs[0].dirty).to.equal(true);
            expect(s.tabs[0].preview).to.equal(false);
            expect(s.previewTabId).to.equal(null);
        });

        it('is idempotent when the dirty flag is unchanged', () => {
            const t = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'p' });
            HubTabs.markDirty(t.id, false);
            HubTabs.markDirty(t.id, false);
            expect(HubTabs.getState().tabs[0].dirty).to.equal(false);
        });
    });

    describe('setStatus (console-only progress)', () => {
        it('updates status and progress for console tabs', () => {
            const t = HubTabs.openOrFocusTab({ type: 'console', refId: 'run-1', name: 'Run 1' });
            HubTabs.setStatus(t.id, 'running', { done: 50, total: 200 });
            const s = HubTabs.getState();
            expect(s.tabs[0].status).to.equal('running');
            expect(s.tabs[0].progress).to.deep.equal({ done: 50, total: 200 });
        });

        it('Issue #312: an unchanged status and progress does not emit at all', () => {
            const t = HubTabs.openOrFocusTab({ type: 'console', refId: 'run-1', name: 'Run 1' });
            HubTabs.setStatus(t.id, 'running', { done: 50, total: 200 });
            let emits = 0;
            (HubTabs as unknown as { subscribe: (fn: () => void) => void }).subscribe(() => { emits++; });
            HubTabs.setStatus(t.id, 'running', { done: 50, total: 200 });
            expect(emits).to.equal(0);
        });

        it('Issue #312: a status change still emits (the tab is rebuilt for its new look)', () => {
            const t = HubTabs.openOrFocusTab({ type: 'console', refId: 'run-1', name: 'Run 1' });
            HubTabs.setStatus(t.id, 'running', { done: 50, total: 200 });
            let emits = 0;
            (HubTabs as unknown as { subscribe: (fn: () => void) => void }).subscribe(() => { emits++; });
            HubTabs.setStatus(t.id, 'paused', { done: 50, total: 200 });
            expect(emits).to.equal(1);
        });
    });

    // GitHub Issue #292: Settings / Account / Import / Export open as
    // hub-native single-instance page tabs keyed `page:<section>`.
    describe('page tabs (Issue #292)', () => {
        const settings: TabSpec = { id: 'page:settings', type: 'page', refId: 'settings', name: 'Settings', preview: false };

        it('opens a page tab once and refocuses it on repeat opens', () => {
            HubTabs.openOrFocusTab(settings);
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'EP 1' });
            const again = HubTabs.openOrFocusTab(settings);
            const s = HubTabs.getState();
            expect(s.tabs.filter(t => t.type === 'page')).to.have.length(1);
            expect(again.id).to.equal('page:settings');
            expect(s.activeTabId).to.equal('page:settings');
        });

        it('is keyed by id, so it coexists with an endpoint sharing the refId', () => {
            HubTabs.openOrFocusTab(settings);
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'settings', name: 'settings endpoint' });
            expect(HubTabs.getState().tabs.map(t => t.id)).to.deep.equal(['page:settings', 'endpoint:settings']);
        });

        it('closes like any kept tab and falls back to a neighbour', () => {
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'EP 1' });
            HubTabs.openOrFocusTab(settings);
            expect(HubTabs.closeTab('page:settings')).to.equal(true);
            const s = HubTabs.getState();
            expect(s.tabs.map(t => t.id)).to.deep.equal(['endpoint:ep-1']);
            expect(s.activeTabId).to.equal('endpoint:ep-1');
        });

        it('never occupies the preview slot', () => {
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'EP 1', preview: true });
            HubTabs.openOrFocusTab(settings);
            const s = HubTabs.getState();
            expect(s.previewTabId).to.equal('endpoint:ep-1');
            expect(s.tabs.find(t => t.id === 'page:settings')?.preview).to.equal(false);
        });
    });

    describe('reorderTab', () => {
        it('moves a tab to a new index, clamping out-of-range values', () => {
            const a = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'a' });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'b' });
            const c = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'c' });
            HubTabs.reorderTab(a.id, 2);
            expect(HubTabs.getState().tabs.map(t => t.refId)).to.deep.equal(['b', 'c', 'a']);
            HubTabs.reorderTab(c.id, -10); // clamps to 0
            expect(HubTabs.getState().tabs.map(t => t.refId)).to.deep.equal(['c', 'b', 'a']);
        });

        it('is a no-op when target index equals current index', () => {
            const a = HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'a' });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'b' });
            HubTabs.reorderTab(a.id, 0);
            expect(HubTabs.getState().tabs.map(t => t.refId)).to.deep.equal(['a', 'b']);
        });
    });

    describe('tab id keying', () => {
        it('keys tabs by type:refId so the same endpoint id under different types coexists', () => {
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'shared' });
            HubTabs.openOrFocusTab({ type: 'console',  refId: 'shared' });
            const s = HubTabs.getState();
            expect(s.tabs).to.have.length(2);
            expect(s.tabs.map(t => t.id).sort()).to.deep.equal(['console:shared', 'endpoint:shared']);
        });
    });

    describe('setTabStatus → Activity drawer (Issue #312)', () => {
        it('mirrors live progress into the drawer, which the Hub page never reached on its own', () => {
            const w = global as unknown as { window: Record<string, unknown> };
            const applied: Array<[string, unknown]> = [];
            w.window.HubActivity = { applyLiveProgress: (id: string, p: unknown) => applied.push([id, p]) };
            const tab = HubTabs.openOrFocusTab({ type: 'console', refId: 'batch-9', name: 'Orders' });
            (HubTabs as unknown as { handleHostMessage: (m: unknown) => boolean }).handleHostMessage({ type: 'setTabStatus', tabId: tab.id, status: 'running', progress: { done: 3, total: 10 } });
            expect(applied).to.deep.equal([['batch-9', { done: 3, total: 10 }]]);
            delete w.window.HubActivity;
        });
    });

    describe('#470: a batch\'s Console takes its Run Batch tab\'s place', () => {
        it('the same slot in the strip, the Run Batch tab gone, and the focus when it had it', () => {
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-1', name: 'Items' });
            HubTabs.openOrFocusTab({ id: 'batch:ep-1', type: 'batch', refId: 'ep-1', name: 'Run Batch: Items' });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-2', name: 'Stock' });
            HubTabs.focusTab('batch:ep-1');
            HubTabs._swapTab('batch:ep-1', { id: 'console:B1', type: 'console', refId: 'B1', name: 'Items 24 Nov' });
            const s = HubTabs.getState();
            expect(s.tabs.map(t => t.id)).to.deep.equal(['endpoint:ep-1', 'console:B1', 'endpoint:ep-2']);
            expect(s.tabs[1]).to.include({ name: 'Items 24 Nov', type: 'console', preview: false, dirty: false });
            expect(s.activeTabId).to.equal('console:B1');
        });

        it('a queued batch starting while another tab is shown: the Console in the slot, the user left where they are', () => {
            HubTabs.openOrFocusTab({ id: 'batch:ep-1', type: 'batch', refId: 'ep-1', name: 'Run Batch: Items' });
            HubTabs.openOrFocusTab({ type: 'endpoint', refId: 'ep-2', name: 'Stock' });
            HubTabs._swapTab('batch:ep-1', { id: 'console:B2', type: 'console', refId: 'B2', name: 'Items' });
            const s = HubTabs.getState();
            expect(s.tabs.map(t => t.id)).to.deep.equal(['console:B2', 'endpoint:ep-2']);
            expect(s.activeTabId).to.equal('endpoint:ep-2');
        });
    });
});
