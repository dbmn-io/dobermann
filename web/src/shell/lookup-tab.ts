// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A lookup table's tab in the web app: the shared LookupController (src/screens/lookup) over the
 * lookup tables kept with the saved queries, in this browser's state (as the queries are).
 */
import { ScreenSession } from '../../../src/screens/screen-session';
import type { LookupTab, TabChannel } from '../../../src/screens/hub/hub.ports';
import type { IKeyValueStore } from '../../../src/platform/interfaces/key-value-store.interface';
import { LookupController } from '../../../src/screens/lookup/lookup.controller';
import { buildLookupPage } from '../../../src/screens/lookup/lookup-page';
import { LookupTablesStore } from '../../../src/services/lookup-tables/lookup-tables';
import { asset, screenHost } from './browser-host';

export interface LookupTabDeps {
    /** The state the saved queries are kept in. */
    state: Pick<IKeyValueStore, 'get' | 'update'>;
    toast: { info(m: string): void; warn(m: string): void; error(m: string): void };
}

/** HubTabFactory.lookup for the web app. */
export function lookupTab(deps: LookupTabDeps) {
    return async (config: { id: string; name: string; renamed?(name: string): void }, channel: TabChannel): Promise<LookupTab> => {
        const session = new ScreenSession({ post: m => channel.post(m) }, screenHost);
        const controller = new LookupController(session, {
            store: new LookupTablesStore(deps.state),
            toast: deps.toast,
            host: { renamed: name => config.renamed?.(name) }
        }, { id: config.id });
        return {
            html: buildLookupPage(asset, { name: config.name }),
            handle: async message => {
                if (await session.handleShared(message)) return;
                await controller.handleMessage(message as never);
            },
            dispose: () => {
                session.dismissAll();
                controller.dispose();
            },
            rename: name => controller.handleMessage({ type: 'lookup.rename', name })
        };
    };
}
