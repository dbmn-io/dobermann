// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
import { expect } from 'chai';
import {
    getEndpointViewScopeKey,
    isV2ConsoleViewsRegistry,
    mergeConsoleViews,
    migrateConsoleViewsRegistry
} from '../../../../services/console/view-scope-key';

const tabSettings = (
    activeView: string,
    views: Array<{ name: string; rowBasis?: string; columns?: any[] }>
) => ({
    activeView,
    views: views.map(v => ({ rowBasis: 'root', columns: [], ...v }))
});

const consoleViews = (
    success: { activeView: string; views: Array<{ name: string }> },
    errors?: { activeView: string; views: Array<{ name: string }> }
) => ({
    success: tabSettings(success.activeView, success.views),
    errors: errors ? tabSettings(errors.activeView, errors.views) : tabSettings('', [])
});

describe('isV2ConsoleViewsRegistry - Issue #237', () => {
    it('rejects empty / null / non-object', () => {
        expect(isV2ConsoleViewsRegistry(null)).to.equal(false);
        expect(isV2ConsoleViewsRegistry(undefined)).to.equal(false);
        expect(isV2ConsoleViewsRegistry('hi')).to.equal(false);
    });

    it('rejects flat legacy registry shape', () => {
        const flat = { 'endpoint-1': { success: { activeView: 'a', views: [] } } };
        expect(isV2ConsoleViewsRegistry(flat)).to.equal(false);
    });

    it('accepts the wrapped v2 shape', () => {
        const v2 = { schemaVersion: 2, scopes: {} };
        expect(isV2ConsoleViewsRegistry(v2)).to.equal(true);
    });
});

describe('mergeConsoleViews - Issue #237 collision rules', () => {
    it('preserves both buckets when names do not collide', () => {
        const primary = consoleViews({ activeView: 'A', views: [{ name: 'A' }] });
        const incoming = consoleViews({ activeView: 'B', views: [{ name: 'B' }] });
        const { merged, renamed } = mergeConsoleViews(primary, incoming);
        expect(renamed).to.equal(0);
        expect((merged as any).success.views.map((v: any) => v.name)).to.deep.equal(['A', 'B']);
    });

    it('renames colliding incoming view to "Name (2)"', () => {
        const primary = consoleViews({ activeView: 'Default', views: [{ name: 'Default' }] });
        const incoming = consoleViews({ activeView: 'Default', views: [{ name: 'Default' }] });
        const { merged, renamed } = mergeConsoleViews(primary, incoming);
        expect(renamed).to.equal(1);
        expect((merged as any).success.views.map((v: any) => v.name)).to.deep.equal(['Default', 'Default (2)']);
    });

    it('keeps primary activeView through a collision', () => {
        const primary = consoleViews({ activeView: 'Default', views: [{ name: 'Default' }] });
        const incoming = consoleViews({ activeView: 'Default', views: [{ name: 'Default' }] });
        const { merged } = mergeConsoleViews(primary, incoming);
        expect((merged as any).success.activeView).to.equal('Default');
    });

    it('finds next free suffix when (2) already taken', () => {
        const primary = consoleViews({ activeView: 'X', views: [{ name: 'X' }, { name: 'X (2)' }] });
        const incoming = consoleViews({ activeView: 'X', views: [{ name: 'X' }] });
        const { merged } = mergeConsoleViews(primary, incoming);
        expect((merged as any).success.views.map((v: any) => v.name)).to.deep.equal(['X', 'X (2)', 'X (3)']);
    });

    it('uses incoming when primary has no tab settings', () => {
        const incoming = consoleViews({ activeView: 'A', views: [{ name: 'A' }] });
        const { merged, renamed } = mergeConsoleViews({}, incoming);
        expect(renamed).to.equal(0);
        expect((merged as any).success.views.map((v: any) => v.name)).to.deep.equal(['A']);
    });
});

describe('migrateConsoleViewsRegistry - Issue #237', () => {
    it('returns empty v2 registry when legacy has no entries', async () => {
        const { registry, migrated, renamed } = await migrateConsoleViewsRegistry(
            {},
            async () => 'unused'
        );
        expect(registry).to.deep.equal({ schemaVersion: 2, scopes: {} });
        expect(migrated).to.equal(0);
        expect(renamed).to.equal(0);
    });

    it('keys each entry by URL+method via the resolver', async () => {
        const legacy = {
            'ep-1': consoleViews({ activeView: 'A', views: [{ name: 'A' }] }),
            'ep-2': consoleViews({ activeView: 'B', views: [{ name: 'B' }] })
        };
        const resolve = async (id: string) => id === 'ep-1'
            ? getEndpointViewScopeKey('POST', '/lpn/search')
            : getEndpointViewScopeKey('GET', '/items');
        const { registry, migrated, renamed } = await migrateConsoleViewsRegistry(legacy, resolve);
        expect(migrated).to.equal(2);
        expect(renamed).to.equal(0);
        expect(Object.keys(registry.scopes)).to.have.members(['POST /lpn/search', 'GET /items']);
    });

    it('merges entries that resolve to the same scope, renaming collisions', async () => {
        const legacy = {
            'ep-1': consoleViews({ activeView: 'Default', views: [{ name: 'Default' }, { name: 'ByDate' }] }),
            'ep-2': consoleViews({ activeView: 'Default', views: [{ name: 'Default' }, { name: 'ByPallet' }] })
        };
        const resolve = async () => getEndpointViewScopeKey('POST', '/lpn/search');
        const { registry, migrated, renamed } = await migrateConsoleViewsRegistry(legacy, resolve);
        expect(migrated).to.equal(2);
        expect(renamed).to.equal(1);
        const scope: any = registry.scopes['POST /lpn/search'];
        expect(scope.success.views.map((v: any) => v.name)).to.deep.equal([
            'Default', 'ByDate', 'Default (2)', 'ByPallet'
        ]);
        expect(scope.success.activeView).to.equal('Default');
    });

    it('preserves orphan entries under orphan:<id> scope', async () => {
        const legacy = {
            'ep-deleted': consoleViews({ activeView: 'A', views: [{ name: 'A' }] })
        };
        const resolve = async (id: string) => `orphan:${id}`;
        const { registry } = await migrateConsoleViewsRegistry(legacy, resolve);
        expect(registry.scopes).to.have.property('orphan:ep-deleted');
    });

    it('skips reserved keys and non-object values defensively', async () => {
        const legacy = {
            schemaVersion: 99,
            scopes: 'garbage',
            'ep-good': consoleViews({ activeView: 'A', views: [{ name: 'A' }] })
        };
        const resolve = async () => 'POST /x';
        const { registry, migrated } = await migrateConsoleViewsRegistry(legacy, resolve);
        expect(migrated).to.equal(1);
        expect(Object.keys(registry.scopes)).to.deep.equal(['POST /x']);
    });
});
