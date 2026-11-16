#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * #406: every source file carries the licence header.
 *
 *   node scripts/spdx-headers.mjs check   # lists files without one; exit 1 if any (npm run spdx:check)
 *   node scripts/spdx-headers.mjs add     # adds it where missing, after a shebang if there is one
 *
 * Covers .ts, .js, .mjs under src/, web/src/, desktop/ (not desktop/out) and scripts/; skips
 * generated and vendored files. The header is two comment lines so tools that read the first
 * line (shebang, 'use strict') keep working.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPDX_LINES = ['// SPDX-License-Identifier: AGPL-3.0-only', '// Copyright (C) 2026 Flexion Tech Pty Ltd'];
const INCLUDE = /^(src|web\/src|desktop|scripts)\/.*\.(ts|js|mjs|cjs)$/;
const EXCLUDE = /^(desktop\/(out|release|dist)\/|src\/test\/fixtures\/|.*\.d\.ts$|.*\.min\.js$|.*\/vendor\/)/;

export function sourceFiles() {
    let listed;
    try {
        listed = execFileSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
    } catch {
        // Not a git checkout (the exported tree, say): walk the folders instead
        const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
            if (e.name === 'node_modules' || e.name === '.git') return [];
            const p = path.join(dir, e.name);
            return e.isDirectory() ? walk(p) : [path.relative(root, p)];
        });
        listed = walk(root);
    }
    return listed.filter(f => INCLUDE.test(f) && !EXCLUDE.test(f));
}
export function hasHeader(text) {
    return text.split('\n').slice(0, 5).some(line => line.includes('SPDX-License-Identifier: AGPL-3.0-only'));
}
export function withHeader(text) {
    const lines = text.split('\n');
    const header = SPDX_LINES.join('\n') + '\n';
    if (lines[0]?.startsWith('#!')) return lines[0] + '\n' + header + lines.slice(1).join('\n');
    return header + text;
}

const mode = process.argv[2];
const missing = sourceFiles().filter(f => !hasHeader(fs.readFileSync(path.join(root, f), 'utf8')));
if (mode === 'check') {
    if (missing.length) {
        console.error(`${missing.length} source file(s) without the SPDX header (npm run spdx:add):\n  ${missing.slice(0, 40).join('\n  ')}${missing.length > 40 ? '\n  …' : ''}`);
        process.exit(1);
    }
    console.log(`SPDX header present on all ${sourceFiles().length} source files.`);
} else if (mode === 'add') {
    for (const f of missing) {
        const p = path.join(root, f);
        fs.writeFileSync(p, withHeader(fs.readFileSync(p, 'utf8')));
    }
    console.log(`Added the SPDX header to ${missing.length} file(s).`);
} else {
    console.error('usage: spdx-headers.mjs check | add');
    process.exit(1);
}
