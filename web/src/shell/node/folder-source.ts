// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Where folder mode's files are (./fs.ts): the user's workspace folder, behind the few
 * operations the shell needs. Two of them: a browser's File System Access handle for the folder
 * the user picked (the web app, here), and the desktop app's main process
 * (../desktop-folder.ts), which reads and writes the folder by its path.
 *
 * A file is named by the folders down to it from the workspace folder (`parts`).
 */
export interface FolderFile {
    size: number;
    /** Changes when the file is saved: with `size`, how another writer's save is noticed. */
    lastModified: number;
}

export interface FolderSource {
    /** A file as it is now. Undefined: not there. */
    stat(parts: string[]): Promise<FolderFile | undefined>;
    read(parts: string[]): Promise<(FolderFile & { bytes: Uint8Array }) | undefined>;
    /**
     * The whole file, or (`at`) these bytes from that position, keeping what is before it.
     * Makes the file and its folders as needed. The file as it is afterwards; undefined when it
     * couldn't be written.
     */
    write(parts: string[], bytes: Uint8Array, at?: number): Promise<FolderFile | undefined>;
    remove(parts: string[]): Promise<void>;
    /** What is directly in a folder. Undefined: no such folder. */
    list(parts: string[]): Promise<Array<{ name: string; kind: 'file' | 'directory' }> | undefined>;
}

/** The folder the user picked in a browser (Chrome and Edge: File System Access). */
export function browserFolderSource(root: FileSystemDirectoryHandle): FolderSource {
    async function directoryFor(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
        let dir = root;
        for (const part of parts) {
            try {
                dir = await dir.getDirectoryHandle(part, { create });
            } catch {
                return undefined;
            }
        }
        return dir;
    }

    async function fileFor(parts: string[], create: boolean): Promise<FileSystemFileHandle | undefined> {
        const dir = await directoryFor(parts.slice(0, -1), create);
        if (!dir) return undefined;
        try {
            return await dir.getFileHandle(parts[parts.length - 1], { create });
        } catch {
            return undefined;
        }
    }

    const described = (file: File): FolderFile => ({ size: file.size, lastModified: file.lastModified });

    return {
        async stat(parts) {
            const handle = await fileFor(parts, false);
            return handle ? described(await handle.getFile()) : undefined;
        },
        async read(parts) {
            const handle = await fileFor(parts, false);
            if (!handle) return undefined;
            const file = await handle.getFile();
            return { ...described(file), bytes: new Uint8Array(await file.arrayBuffer()) };
        },
        async write(parts, bytes, at) {
            const handle = await fileFor(parts, true);
            if (!handle) return undefined;
            const writable = await handle.createWritable({ keepExistingData: at !== undefined });
            if (at !== undefined) await writable.seek(at);
            await writable.write(bytes);
            await writable.close();
            return described(await handle.getFile());
        },
        async remove(parts) {
            const dir = await directoryFor(parts.slice(0, -1), false);
            await dir?.removeEntry(parts[parts.length - 1]).catch(() => undefined);
        },
        async list(parts) {
            const dir = await directoryFor(parts, false);
            if (!dir) return undefined;
            const entries: Array<{ name: string; kind: 'file' | 'directory' }> = [];
            for await (const [name, entry] of dir.entries()) entries.push({ name, kind: entry.kind });
            return entries;
        }
    };
}

/**
 * #441: a folder only DBMN for VS Code 0.3.1 has used keeps its data in `.active8`, and a browser
 * can't make the link a later VS Code leaves there (move-data-dir.ts). The web app still asks for
 * `.dbmn/…`; here that is `.active8/…`, so the two share one History. A later VS Code moves
 * `.active8` to `.dbmn` when it opens the folder, and from then on there is nothing to map.
 */
export function legacyDataDirSource(source: FolderSource, dataDir: string, legacyDir: string): FolderSource {
    const map = (parts: string[]): string[] => parts[0] === dataDir ? [legacyDir, ...parts.slice(1)] : parts;
    return {
        stat: parts => source.stat(map(parts)),
        read: parts => source.read(map(parts)),
        write: (parts, bytes, at) => source.write(map(parts), bytes, at),
        remove: parts => source.remove(map(parts)),
        async list(parts) {
            const entries = await source.list(map(parts));
            // The workspace itself: its data folder is `.dbmn` to the app
            return parts.length === 0 ? entries?.map(entry => entry.name === legacyDir ? { ...entry, name: dataDir } : entry) : entries;
        }
    };
}
