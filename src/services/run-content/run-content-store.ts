// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * A run's content (each transaction's request, response and log) in one compressed archive per
 * run folder, instead of a file per transaction (#358). The execution DB keeps what it always
 * kept, including the request/response/log *paths*: those stay the identifiers. Their bytes live
 * in `<run folder>/run-content.dbmn`, and every reader and writer goes through this module.
 *
 * Why not inside the execution DB itself: it is sql.js, held whole in memory and rewritten whole
 * on every save. A real workspace measured 94 MB of DB beside 2.2 GB of run files (252,071 of
 * them); in the DB that would exhaust memory before it got slow. See Architecture.md, "Run content".
 *
 * The archive, both hosts alike (Node `fs` in VS Code; the web shell's `fs` in the browser):
 *   - append-only records: MAGIC · op · name · body. Ops: write (replace), append, delete.
 *   - each record's body deflated on its own (when that makes it smaller), so reading one
 *     transaction never unpacks the run. A batch of 670 requests is one file, ~17x smaller.
 *   - an index (name → body offsets) built from the records and kept per archive, extended
 *     from the last offset it read as the file grows. A half-written last record (a crash, or
 *     another window mid-append) is left for the next look; a damaged record is skipped.
 *
 * Paths that were never archived (workspaces from before #358, a batch's input CSV) read from
 * the loose file, so nothing older stops working.
 */
import * as fs from 'fs';
import * as path from 'path';
import { deflateSync, inflateSync } from 'fflate';

export const RUN_ARCHIVE_NAME = 'run-content.dbmn';

const MAGIC = [0x44, 0x42, 0x4d, 0x4e];          // "DBMN"
const OP_WRITE = 1, OP_APPEND = 2, OP_DELETE = 3, OP_IDENTITY = 4;
const DEFLATED = 0x80;
const HEAD = 4 + 1 + 4;                           // magic, op, name length

interface Segment { offset: number; length: number; deflated: boolean }
/**
 * `identity`: which archive this index read. Every archive opens with a record holding a random
 * ID, so a run folder deleted and made again (a new archive at the same path, perhaps the same
 * size and inode within the same millisecond) is read from the start, never through the old
 * index's offsets.
 */
interface ArchiveIndex { parsedTo: number; identity: string; entries: Map<string, Segment[]> }

const indexes = new Map<string, ArchiveIndex>();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A run file's archive (beside it) and its name in there. Split at the last `/` or `\\`, whichever the path uses: a run
 * VS Code recorded on Windows keeps `C:\\…\\transaction-001.json`, and the web app's path functions (POSIX, like Node's
 * on Linux and macOS) see no folder in it: its archive became `./run-content.dbmn` and nothing of the run read (#459).
 */
export function locateRunFile(filePath: string): { archive: string; name: string } {
    const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
    // (joined as before, so Node on Windows names each archive one way, whichever separator the path used)
    return { archive: path.join(cut < 0 ? '.' : filePath.slice(0, cut + 1), RUN_ARCHIVE_NAME), name: filePath.slice(cut + 1) };
}
const locate = locateRunFile;

function readRange(archive: string, offset: number, length: number): Uint8Array {
    const buffer = new Uint8Array(length);
    const fd = fs.openSync(archive, 'r');
    try {
        let read = 0;
        while (read < length) {
            const n = fs.readSync(fd, buffer, read, length - read, offset + read);
            if (n <= 0) break;
            read += n;
        }
        return read === length ? buffer : buffer.subarray(0, read);
    } finally {
        fs.closeSync(fd);
    }
}

function u32(bytes: Uint8Array, at: number): number {
    return ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3];
}

function isMagic(bytes: Uint8Array, at: number): boolean {
    return bytes[at] === MAGIC[0] && bytes[at + 1] === MAGIC[1] && bytes[at + 2] === MAGIC[2] && bytes[at + 3] === MAGIC[3];
}

/** The archive's index, brought up to date with whatever was appended since we last looked. */
function indexOf(archive: string): ArchiveIndex | undefined {
    let size: number;
    let identity: string;
    try {
        size = fs.statSync(archive).size;
        identity = decoder.decode(readRange(archive, 0, IDENTITY_RECORD_LENGTH));
    } catch {
        indexes.delete(archive);
        return undefined;
    }
    let index = indexes.get(archive);
    if (!index || size < index.parsedTo || index.identity !== identity) {
        index = { parsedTo: 0, identity, entries: new Map() };
        indexes.set(archive, index);
    }
    if (size === index.parsedTo) return index;

    const base = index.parsedTo;
    const tail = readRange(archive, base, size - base);
    let at = 0;
    while (at + HEAD <= tail.length) {
        if (!isMagic(tail, at)) { at++; continue; }        // damaged: find the next record
        const op = tail[at + 4];
        const nameLength = u32(tail, at + 5);
        const bodyLengthAt = at + HEAD + nameLength;
        if (bodyLengthAt + 4 > tail.length) break;          // half-written: next time
        const name = decoder.decode(tail.subarray(at + HEAD, bodyLengthAt));
        const bodyLength = u32(tail, bodyLengthAt);
        const bodyAt = bodyLengthAt + 4;
        if (bodyAt + bodyLength > tail.length) break;       // half-written: next time
        const kind = op & ~DEFLATED;
        const segment = { offset: base + bodyAt, length: bodyLength, deflated: (op & DEFLATED) !== 0 };
        if (kind === OP_WRITE) index.entries.set(name, [segment]);
        else if (kind === OP_APPEND) index.entries.set(name, [...(index.entries.get(name) ?? []), segment]);
        else if (kind === OP_DELETE) index.entries.delete(name);
        // OP_IDENTITY: the archive's opening record, nothing to index
        at = bodyAt + bodyLength;
    }
    index.parsedTo = base + at;
    return index;
}

function record(op: number, name: string, content: string | Uint8Array): Uint8Array {
    const raw = typeof content === 'string' ? encoder.encode(content) : content;
    const packed = raw.length > 64 ? deflateSync(raw, { level: 6 }) : raw;
    const deflated = packed.length < raw.length;
    const body = deflated ? packed : raw;
    const nameBytes = encoder.encode(name);
    const out = new Uint8Array(HEAD + nameBytes.length + 4 + body.length);
    out.set(MAGIC, 0);
    out[4] = op | (deflated ? DEFLATED : 0);
    new DataView(out.buffer).setUint32(5, nameBytes.length);
    out.set(nameBytes, HEAD);
    new DataView(out.buffer).setUint32(HEAD + nameBytes.length, body.length);
    out.set(body, HEAD + nameBytes.length + 4);
    return out;
}

/** An archive's opening record: magic, op, empty name, a random ID. */
const IDENTITY_RECORD_LENGTH = HEAD + 4 + 36;

function identityRecord(): Uint8Array {
    return record(OP_IDENTITY, '', crypto.randomUUID());
}

function appendRecord(filePath: string, op: number, content: string | Uint8Array): void {
    const { archive, name } = locate(filePath);
    const next = record(op, name, content);
    if (fs.existsSync(archive)) {
        fs.appendFileSync(archive, next);
        return;
    }
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const opening = identityRecord();
    const both = new Uint8Array(opening.length + next.length);
    both.set(opening);
    both.set(next, opening.length);
    fs.appendFileSync(archive, both);
}

/** Write (or replace) a run file's content. */
export function writeRunFile(filePath: string, content: string): void {
    appendRecord(filePath, OP_WRITE, content);
}

/** Add to a run file's content (the execution log, a line at a time). */
export function appendRunFile(filePath: string, content: string): void {
    appendRecord(filePath, OP_APPEND, content);
}

/** Forget a run file. A loose file from before #358 is removed too. */
export function removeRunFile(filePath: string): void {
    const { archive, name } = locate(filePath);
    if (indexOf(archive)?.entries.has(name)) appendRecord(filePath, OP_DELETE, '');
    try { fs.unlinkSync(filePath); } catch { /* not a loose file */ }
}

/** Rename a run file (reprocess keeps the earlier attempt's response as `…_attemptN`). */
export function renameRunFile(from: string, to: string): void {
    const content = readRunFileIfExists(from);
    if (content === undefined) return;
    writeRunFile(to, content);
    removeRunFile(from);
}

export function runFileExists(filePath: string): boolean {
    if (!filePath) return false;
    const { archive, name } = locate(filePath);
    return !!indexOf(archive)?.entries.has(name) || fs.existsSync(filePath);
}

/** A run file's content, or undefined when there is none. */
export function readRunFileIfExists(filePath: string): string | undefined {
    if (!filePath) return undefined;
    const { archive, name } = locate(filePath);
    const segments = indexOf(archive)?.entries.get(name);
    if (segments) {
        return segments.map(s => {
            const bytes = readRange(archive, s.offset, s.length);
            return decoder.decode(s.deflated ? inflateSync(bytes) : bytes);
        }).join('');
    }
    try {
        return fs.readFileSync(filePath, 'utf8') as string;
    } catch {
        return undefined;
    }
}

/** A run file's content; throws like `fs.readFileSync` when there is none. */
export function readRunFile(filePath: string): string {
    const content = readRunFileIfExists(filePath);
    if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such run file, '${filePath}'`), { code: 'ENOENT', path: filePath });
    }
    return content;
}

/** Size in bytes of a run file's content (uncompressed). */
export function runFileSize(filePath: string): number | undefined {
    const content = readRunFileIfExists(filePath);
    return content === undefined ? undefined : encoder.encode(content).length;
}

/** The names of the run files in a folder (archived and loose). */
export function listRunFiles(dir: string): string[] {
    const names = new Set(indexOf(path.join(dir, RUN_ARCHIVE_NAME))?.entries.keys() ?? []);
    try {
        for (const entry of fs.readdirSync(dir)) if (entry !== RUN_ARCHIVE_NAME) names.add(entry);
    } catch { /* no folder */ }
    return [...names];
}

/** Drop cached indexes (tests; and after a run folder is deleted wholesale). */
export function forgetRunArchives(dir?: string): void {
    if (!dir) { indexes.clear(); return; }
    for (const archive of [...indexes.keys()]) if (archive.startsWith(dir)) indexes.delete(archive);
}
