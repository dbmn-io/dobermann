// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #392: what crosses between the desktop app's window and its main process (Electron IPC).
 * The window is the web app's shell and screens; the main process does what a page can't:
 * send a request without the browser's CORS rule, and read and write the workspace folder.
 *
 * The window is not trusted (Architecture-v2 2.3): the preload exposes only `DesktopBridge`,
 * and the main process parses every payload with these schemas before acting on it.
 */
import { z } from 'zod';
import type { OmarchyThemeReport } from '../theme/theme-choice';

export const DESKTOP_BRIDGE_VERSION = 1;

/** IPC channel names. The preload can't import this file (it is sandboxed): it repeats them, type-checked against this. */
export const DESKTOP_CHANNELS = {
    fetch: 'dbmn:fetch',
    cancelFetch: 'dbmn:fetch:cancel',
    /** #373: the desktop's current Omarchy theme (invoke), and each change to it (main → window). */
    omarchyTheme: 'dbmn:theme:omarchy',
    omarchyThemeChanged: 'dbmn:theme:omarchy:changed',
    /** #373: the computer's accent colour (invoke), and each change to it (main → window). */
    systemAccent: 'dbmn:theme:accent',
    systemAccentChanged: 'dbmn:theme:accent:changed',
    /** The workspace folder (desktop-workspace-folder.ts): which one, finding and choosing it, and its files. */
    folderState: 'dbmn:folder:state',
    folderFind: 'dbmn:folder:find',
    folderConnect: 'dbmn:folder:connect',
    folderChoose: 'dbmn:folder:choose',
    folderUseDefault: 'dbmn:folder:default',
    folderReveal: 'dbmn:folder:reveal',
    folderFile: 'dbmn:folder:file'
} as const;
/** How the main process hands the preload the pages' backend: a window argument, base64 JSON. */
export const DESKTOP_BACKEND_ARGUMENT = '--dbmn-backend=';
export type DesktopChannels = typeof DESKTOP_CHANNELS;

const httpUrl = z.string().max(16_384).refine(value => {
    try {
        const { protocol } = new URL(value);
        return protocol === 'http:' || protocol === 'https:';
    } catch {
        return false;
    }
}, 'Not an http(s) URL.');

export const desktopFetchRequestSchema = z.object({
    /** Names the request, for Cancel. */
    id: z.string().uuid(),
    url: httpUrl,
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
    headers: z.record(z.string()),
    body: z.string().optional()
}).strict();
export type DesktopFetchRequest = z.infer<typeof desktopFetchRequestSchema>;

export const desktopFetchCancelSchema = z.object({ id: z.string().uuid() }).strict();

export type DesktopFetchReply =
    | { ok: true; status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }
    /** No answer: the network failed, or (`aborted`) Cancel stopped it. */
    | { ok: false; aborted: boolean; error: string };

// ─── The workspace folder ────────────────────────────────────────────────────

/** A DBMN workspace folder on this computer: its path, and the id in its `.dbmn/workspace.json`. */
export interface DesktopFolder {
    path: string;
    name: string;
    workspaceId: string;
}

/** `deviceId`: this installation, as the account's list of workspaces names a device. */
export type DesktopFolderState =
    | { kind: 'connected'; folder: DesktopFolder; deviceId: string; defaultPath: string }
    /** Never chosen on this installation. */
    | { kind: 'none'; deviceId: string; defaultPath: string }
    /** Chosen before, and not there now (moved, renamed, its drive not connected). */
    | { kind: 'missing'; path: string; deviceId: string; defaultPath: string };

export type DesktopFolderResult =
    | { ok: true; folder: DesktopFolder }
    /** `cancelled`: the user closed the folder dialog. Otherwise `message` says why not. */
    | { ok: false; cancelled?: boolean; message: string };

/** A folder the account says DBMN has used: the page asks whether it is on this computer. */
export const desktopFolderCandidateSchema = z.object({
    path: z.string().min(1).max(4096),
    workspaceId: z.string().min(1).max(200)
}).strict();
export const desktopFolderCandidatesSchema = z.array(desktopFolderCandidateSchema).max(100);
export type DesktopFolderCandidate = z.infer<typeof desktopFolderCandidateSchema>;

/** One name in a path below the workspace folder: never a way out of it. */
const folderSegment = z.string().min(1).max(255).refine(value => value !== '.' && value !== '..' && !/[\\/\0]/.test(value), 'Not a file name.');
const folderParts = z.array(folderSegment).min(1).max(64);

/** A file below the workspace folder, named by the folders down to it. */
export const desktopFolderFileRequestSchema = z.discriminatedUnion('op', [
    z.object({ op: z.literal('stat'), parts: folderParts }).strict(),
    z.object({ op: z.literal('read'), parts: folderParts }).strict(),
    /** The whole file, or (`at`) these bytes from that position, keeping what is before it. */
    z.object({ op: z.literal('write'), parts: folderParts, bytes: z.instanceof(Uint8Array), at: z.number().int().nonnegative().optional() }).strict(),
    z.object({ op: z.literal('remove'), parts: folderParts }).strict(),
    /** What is directly in a folder (`parts` empty: the workspace folder itself). */
    z.object({ op: z.literal('list'), parts: z.array(folderSegment).max(64) }).strict()
]);
export type DesktopFolderFileRequest = z.infer<typeof desktopFolderFileRequestSchema>;

export interface DesktopFolderFile {
    size: number;
    /** Milliseconds, whole: what tells a file another writer saved from the one last seen. */
    lastModified: number;
    bytes?: Uint8Array;
}

export type DesktopFolderFileReply =
    /** `file` (stat, read, write) and `entries` (list) are absent when there is no such file or folder. */
    | { ok: true; file?: DesktopFolderFile; entries?: Array<{ name: string; kind: 'file' | 'directory' }> }
    | { ok: false; error: string };

/** What the preload puts on `window.dbmnDesktop`. Nothing else of Electron or Node reaches the page. */
export interface DesktopBridge {
    v: number;
    /** A packaged build: the backend its pages run on, unchecked until core's resolveDesktopBackend reads it. */
    backend?: { profile?: unknown; apiUrl?: unknown; anonKey?: unknown; siteUrl?: unknown };
    fetch(request: DesktopFetchRequest): Promise<DesktopFetchReply>;
    cancelFetch(id: string): void;
    /** #373: the desktop's current Omarchy theme; undefined on a computer without Omarchy. */
    omarchyTheme(): Promise<OmarchyThemeReport | undefined>;
    /** #373: each theme the desktop changes to (undefined when it stops being readable). */
    onOmarchyTheme(listener: (theme: OmarchyThemeReport | undefined) => void): void;
    /** #373: the computer's accent colour (Windows, macOS), as the system gives it; undefined where there is none to read. */
    systemAccent(): Promise<string | undefined>;
    /** #373: each accent colour the user changes to. */
    onSystemAccent(listener: (accent: string | undefined) => void): void;
    /** The workspace folder this installation uses, if any. */
    folderState(): Promise<DesktopFolderState>;
    /** Which of these folders (the account's) are DBMN workspaces on this computer. */
    folderFind(candidates: DesktopFolderCandidate[]): Promise<DesktopFolder[]>;
    /** Use one of them: only a folder that holds that workspace's marker is accepted. */
    folderConnect(candidate: DesktopFolderCandidate): Promise<DesktopFolderResult>;
    /** The computer's folder dialog; the folder the user chooses becomes the workspace. */
    folderChoose(): Promise<DesktopFolderResult>;
    /** The default folder (`defaultPath`), made if it isn't there. */
    folderUseDefault(): Promise<DesktopFolderResult>;
    /** Show the workspace folder in the file manager. False when there is none. */
    folderReveal(): Promise<boolean>;
    folderFile(request: DesktopFolderFileRequest): Promise<DesktopFolderFileReply>;
}
