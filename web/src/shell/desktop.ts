// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: the desktop app. The same shell and screens, in a window whose main process (desktop/)
 * does what a page can't. Its preload puts `DesktopBridge` on the window; in a browser there is
 * none, and the shell is the web app.
 */
import { DESKTOP_BRIDGE_VERSION, type DesktopBridge } from '../../../src/services/desktop/desktop-protocol';

export function desktopBridge(): DesktopBridge | undefined {
    const bridge = (window as unknown as { dbmnDesktop?: DesktopBridge }).dbmnDesktop;
    return bridge?.v === DESKTOP_BRIDGE_VERSION ? bridge : undefined;
}
