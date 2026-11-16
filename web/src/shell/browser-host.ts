// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** What a browser does for every screen: links, the clipboard, files to save, settings. */
import type { ScreenHostPorts } from '../../../src/screens/screen-session';
import { handleClipboardMessage } from '../../../src/services/ui/clipboard-bridge';
import type { HubSettings } from '../../../src/screens/hub/hub.ports';
import type { StoreContext } from '../../../src/platform/interfaces/store-context.interface';

export const screenHost: ScreenHostPorts = {
    openExternal: url => {
        if (/^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
    },
    clipboard: (message, reply) => handleClipboardMessage(message, reply, navigator.clipboard).then(() => undefined)
};

/** Save bytes as a download; the browser decides where. */
export async function download(name: string, bytes: Uint8Array): Promise<string> {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    const link = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
}

/** The Hub's Settings, kept in this browser like the rest of its per-device state. */
export function browserSettings(state: StoreContext): HubSettings {
    const key = (section: string, name: string) => `setting:${section}.${name}`;
    return {
        get: <T>(section: string, name: string, defaultValue: T): T => state.globalState.get<T>(key(section, name)) ?? defaultValue,
        update: async (section, name, value) => { await state.globalState.update(key(section, name), value); }
    };
}

/** The pages under src/webviews, by absolute URL: tabs are blob: frames, which can't resolve /paths. */
export const asset = (relativePath: string) => `${location.origin}/webviews/${relativePath}`;

const templates = new Map<string, Promise<string>>();
export function template(relativePath: string): Promise<string> {
    if (!templates.has(relativePath)) {
        templates.set(relativePath, fetch(asset(relativePath)).then(r => {
            if (!r.ok) throw new Error(`${relativePath}: ${r.status}`);
            return r.text();
        }));
    }
    return templates.get(relativePath)!;
}
