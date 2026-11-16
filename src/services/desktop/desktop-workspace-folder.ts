// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The desktop app's workspace folder: the folder on this computer that holds the run history
 * and results (`.dbmn/`, and the run folders beside it), the same folder DBMN for VS Code uses.
 * The desktop app always runs on one; it never keeps history in the window's own storage.
 *
 * The main process owns the folder, because a page can't: a page can only be handed a folder
 * the user picks by hand each time, and can't look for one by its path. So this is where the
 * folder is remembered, found, chosen and made, and where its files are read and written for
 * the window (desktop-protocol.ts: every request parsed here before anything is done).
 *
 * What the window can reach:
 * - Files below the workspace folder only, named by the folders down to them. A name is never
 *   `..`, a path, or (on Windows) a drive, so no request names a file outside it.
 * - A folder becomes the workspace only when the user chose it in the computer's folder dialog,
 *   when it is the default folder, or when it already holds the marker of the workspace the
 *   window names (a folder the account says DBMN has used). The window can't point this at
 *   an arbitrary folder.
 *
 * Node's file system, no Electron: the main process wires it (desktop/src/main.ts) and shows the
 * folder dialog.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { moveLegacyDataDir } from '../workspace/move-data-dir';
import { DATA_DIR, LEGACY_DATA_DIR, parseWorkspaceMarker, WORKSPACE_MARKER, type WorkspaceMarker } from '../workspace/workspace-layout';
import {
    desktopFolderCandidateSchema,
    desktopFolderCandidatesSchema,
    desktopFolderFileRequestSchema,
    type DesktopFolder,
    type DesktopFolderFile,
    type DesktopFolderFileReply,
    type DesktopFolderResult,
    type DesktopFolderState
} from './desktop-protocol';

/** The folder DBMN for VS Code makes by default, in the user's home folder on every system. */
export const DEFAULT_WORKSPACE_FOLDER_NAME = 'Dobermann-Workspace';

export interface DesktopWorkspaceFolderOptions {
    /** Where this installation remembers its folder and its device id (in the app's own data). */
    configFile: string;
    /** The user's home folder (asked each time: the default folder is below it). */
    homeDir(): string;
    platform?: NodeJS.Platform;
    log?: (message: string, error?: unknown) => void;
}

export interface DesktopWorkspaceFolder {
    state(): DesktopFolderState;
    /** Which of the folders the window names are DBMN workspaces on this computer. */
    find(raw: unknown): DesktopFolder[];
    /** Use a folder the window names: only one that holds the marker of the workspace it names. */
    connect(raw: unknown): DesktopFolderResult;
    /** Use the folder the user chose in the computer's folder dialog. */
    usePicked(folderPath: string): DesktopFolderResult;
    /** Use the default folder, made if it isn't there. */
    useDefault(): DesktopFolderResult;
    /** The connected folder's path, for the file manager. */
    root(): string | undefined;
    file(raw: unknown): Promise<DesktopFolderFileReply>;
}

interface Config {
    deviceId: string;
    path?: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function isDirectory(folderPath: string): boolean {
    try {
        return fs.statSync(folderPath).isDirectory();
    } catch {
        return false;
    }
}

function readMarker(root: string): WorkspaceMarker | undefined {
    try {
        return parseWorkspaceMarker(fs.readFileSync(path.join(root, DATA_DIR, WORKSPACE_MARKER), 'utf8'));
    } catch {
        return undefined;
    }
}

/** Never half a file: written beside it, then moved over it. */
function writeWhole(file: string, content: string | Uint8Array): void {
    const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(temporary, content);
    try {
        fs.renameSync(temporary, file);
    } catch {
        // Windows, while another program holds the file open: written in place instead
        try {
            fs.writeFileSync(file, content);
        } finally {
            fs.rmSync(temporary, { force: true });
        }
    }
}

export function desktopWorkspaceFolder(options: DesktopWorkspaceFolderOptions): DesktopWorkspaceFolder {
    const platform = options.platform ?? process.platform;
    const log = options.log ?? (() => undefined);
    let config: Config | undefined;
    /** The folder in use, made ready once (its `.dbmn` and marker): what file requests are below. */
    let connected: DesktopFolder | undefined;

    function loadConfig(): Config {
        if (config) return config;
        let stored: Partial<Config> = {};
        try {
            stored = JSON.parse(fs.readFileSync(options.configFile, 'utf8')) as Partial<Config>;
        } catch {
            // first start, or unreadable: a new one
        }
        config = {
            deviceId: typeof stored.deviceId === 'string' && stored.deviceId ? stored.deviceId : `desktop-${randomUUID()}`,
            ...(typeof stored.path === 'string' && stored.path ? { path: stored.path } : {})
        };
        if (config.deviceId !== stored.deviceId) saveConfig();
        return config;
    }

    function saveConfig(): void {
        if (!config) return;
        try {
            fs.mkdirSync(path.dirname(options.configFile), { recursive: true });
            writeWhole(options.configFile, JSON.stringify(config, null, 2));
        } catch (error) {
            log('[Workspace] could not save which folder this installation uses', error);
        }
    }

    const defaultPath = (): string => path.join(options.homeDir(), DEFAULT_WORKSPACE_FOLDER_NAME);

    /**
     * An existing folder made ready to be the workspace: writable, with DBMN's own folder
     * (`.dbmn`; a workspace from before #344 has its `.active8` moved, as DBMN for VS Code does)
     * and the marker that says which workspace it is. Throws with what to tell the user.
     */
    function prepare(root: string): DesktopFolder {
        if (!isDirectory(root)) throw new Error(`${root} isn't a folder DBMN can open.`);
        try {
            fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK);
        } catch {
            throw new Error(`DBMN can't write to ${root}. Choose a folder you can save files in.`);
        }
        try {
            moveLegacyDataDir(root, platform);
        } catch (error) {
            log(`[Workspace] could not prepare ${DATA_DIR} in ${root}`, error);
        }
        const dataDir = path.join(root, DATA_DIR);
        try {
            fs.mkdirSync(dataDir, { recursive: true });
            let marker = readMarker(root);
            if (!marker) {
                marker = { id: randomUUID(), name: path.basename(root), createdAt: new Date().toISOString(), createdOn: loadConfig().deviceId };
                writeWhole(path.join(dataDir, WORKSPACE_MARKER), JSON.stringify(marker, null, 2));
            }
            return { path: root, name: path.basename(root), workspaceId: marker.id };
        } catch (error) {
            throw new Error(`DBMN couldn't set up ${root}: ${messageOf(error)}`);
        }
    }

    function use(root: string): DesktopFolderResult {
        try {
            connected = prepare(root);
        } catch (error) {
            return { ok: false, message: messageOf(error) };
        }
        loadConfig().path = connected.path;
        saveConfig();
        return { ok: true, folder: connected };
    }

    /** A folder the window names, when it is on this computer and holds that workspace's marker. */
    function known(candidate: { path: string; workspaceId: string }): DesktopFolder | undefined {
        if (!path.isAbsolute(candidate.path)) return undefined;
        const root = path.resolve(candidate.path);
        if (!isDirectory(root)) return undefined;
        return readMarker(root)?.id === candidate.workspaceId ? { path: root, name: path.basename(root), workspaceId: candidate.workspaceId } : undefined;
    }

    function state(): DesktopFolderState {
        const { deviceId, path: remembered } = loadConfig();
        const rest = { deviceId, defaultPath: defaultPath() };
        if (!remembered) {
            connected = undefined;
            return { kind: 'none', ...rest };
        }
        if (connected?.path === remembered && isDirectory(remembered)) return { kind: 'connected', folder: connected, ...rest };
        connected = undefined;
        // The remembered folder is never made again here: gone is for the user to settle
        if (!isDirectory(remembered)) return { kind: 'missing', path: remembered, ...rest };
        try {
            connected = prepare(remembered);
            return { kind: 'connected', folder: connected, ...rest };
        } catch (error) {
            log(`[Workspace] ${remembered} can't be used`, error);
            return { kind: 'missing', path: remembered, ...rest };
        }
    }

    /** The folder in use (looked up once after a restart, when the window asks for a file first). */
    function connectedRoot(): string | undefined {
        if (!connected) state();
        return connected?.path;
    }

    /** The file a request names, below the workspace folder. Undefined: a name this system reads as more than a name. */
    function fileBelow(root: string, parts: string[]): string | undefined {
        if (platform === 'win32' && parts.some(part => part.includes(':'))) return undefined;
        return path.join(root, ...parts);
    }

    async function described(file: string): Promise<DesktopFolderFile | undefined> {
        try {
            const stats = await fs.promises.stat(file);
            return stats.isFile() ? { size: stats.size, lastModified: Math.floor(stats.mtimeMs) } : undefined;
        } catch {
            return undefined;
        }
    }

    async function file(raw: unknown): Promise<DesktopFolderFileReply> {
        const parsed = desktopFolderFileRequestSchema.safeParse(raw);
        if (!parsed.success) return { ok: false, error: 'Not a workspace file request.' };
        const root = connectedRoot();
        if (!root) return { ok: false, error: 'No workspace folder is connected.' };
        // Gone since (moved, its drive unplugged): nothing is written, so it is never made again by a save
        if (!isDirectory(root)) return { ok: false, error: `The workspace folder ${root} can't be found.` };
        const request = parsed.data;
        const target = fileBelow(root, request.parts);
        if (!target) return { ok: false, error: 'Not a file name.' };
        try {
            switch (request.op) {
                case 'stat':
                    return { ok: true, file: await described(target) };
                case 'read': {
                    let handle: fs.promises.FileHandle;
                    try {
                        handle = await fs.promises.open(target, 'r');
                    } catch {
                        return { ok: true };
                    }
                    try {
                        const stats = await handle.stat();
                        if (!stats.isFile()) return { ok: true };
                        const bytes = await handle.readFile();
                        return { ok: true, file: { size: bytes.length, lastModified: Math.floor(stats.mtimeMs), bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) } };
                    } finally {
                        await handle.close();
                    }
                }
                case 'write': {
                    await fs.promises.mkdir(path.dirname(target), { recursive: true });
                    if (request.at === undefined) {
                        writeWhole(target, request.bytes);
                    } else {
                        // From a position, keeping what is before it: a run's archive growing
                        const handle = await fs.promises.open(target, fs.existsSync(target) ? 'r+' : 'w+');
                        try {
                            await handle.write(request.bytes, 0, request.bytes.length, request.at);
                        } finally {
                            await handle.close();
                        }
                    }
                    return { ok: true, file: await described(target) };
                }
                case 'remove':
                    await fs.promises.rm(target, { force: true });
                    return { ok: true };
                case 'list': {
                    let entries: fs.Dirent[];
                    try {
                        entries = await fs.promises.readdir(target, { withFileTypes: true });
                    } catch {
                        return { ok: true };
                    }
                    const listed: Array<{ name: string; kind: 'file' | 'directory' }> = [];
                    for (const entry of entries) {
                        // A link (`.active8`, to `.dbmn`) is what it points at
                        const directory = entry.isSymbolicLink() ? isDirectory(path.join(target, entry.name)) : entry.isDirectory();
                        if (directory) listed.push({ name: entry.name, kind: 'directory' });
                        else if (entry.isFile() || entry.isSymbolicLink()) listed.push({ name: entry.name, kind: 'file' });
                    }
                    return { ok: true, entries: listed };
                }
            }
        } catch (error) {
            log(`[Workspace] ${request.op} ${request.parts.join('/')} failed`, error);
            return { ok: false, error: messageOf(error) };
        }
    }

    return {
        state,
        find(raw) {
            const parsed = desktopFolderCandidatesSchema.safeParse(raw);
            if (!parsed.success) return [];
            const found = new Map<string, DesktopFolder>();
            for (const candidate of parsed.data) {
                const folder = known(candidate);
                if (folder && !found.has(folder.path)) found.set(folder.path, folder);
            }
            return [...found.values()];
        },
        connect(raw) {
            const parsed = desktopFolderCandidateSchema.safeParse(raw);
            const folder = parsed.success ? known(parsed.data) : undefined;
            if (!folder) return { ok: false, message: 'That folder isn\'t a DBMN workspace on this computer any more. Choose a folder.' };
            return use(folder.path);
        },
        usePicked(folderPath) {
            const root = path.resolve(folderPath);
            const name = path.basename(root);
            if (name === DATA_DIR || name === LEGACY_DATA_DIR) {
                return { ok: false, message: `That's DBMN's own folder (${name}), inside the workspace. Choose the folder that contains it.` };
            }
            return use(root);
        },
        useDefault() {
            const root = defaultPath();
            try {
                fs.mkdirSync(root, { recursive: true });
            } catch (error) {
                return { ok: false, message: `DBMN couldn't make ${root}: ${messageOf(error)}` };
            }
            return use(root);
        },
        root: () => (state().kind === 'connected' ? connected?.path : undefined),
        file
    };
}
