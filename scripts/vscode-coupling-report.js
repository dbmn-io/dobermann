#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #326: how much of src/ still depends on VS Code. Counts non-test source files that import
 * or require `vscode`, by area, and checks the declared core modules import none. Run with
 * `npm run report:vscode`; exits 1 if a core module imports vscode.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'src');
const { modules } = require('./core-modules.json');
const VSCODE = /(?:from\s+['"]vscode['"]|require\(\s*['"]vscode['"]\s*\))/;

function walk(dir, out) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (full !== path.join(src, 'test')) walk(full, out);
        } else if (/\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
            out.push(full);
        }
    }
    return out;
}

const files = walk(src, []);
const coupled = files.filter(f => VSCODE.test(fs.readFileSync(f, 'utf8')));
const byArea = new Map();
for (const f of coupled) {
    const rel = path.relative(src, f).split(path.sep);
    const area = rel.length > 2 ? `${rel[0]}/${rel[1]}` : rel[0].replace(/\.ts$/, '');
    byArea.set(area, (byArea.get(area) || 0) + 1);
}
const coreCoupled = modules.filter(m => {
    const f = path.join(src, `${m}.ts`);
    return fs.existsSync(f) && VSCODE.test(fs.readFileSync(f, 'utf8'));
});

console.log(`VS Code coupling — src/ without tests: ${coupled.length} of ${files.length} files import vscode`);
console.log(`Core modules (scripts/core-modules.json): ${modules.length}, importing vscode: ${coreCoupled.length}`);
console.log('\nBy area:');
[...byArea.entries()].sort((a, b) => b[1] - a[1]).forEach(([area, n]) => console.log(`  ${String(n).padStart(3)}  ${area}`));
if (coreCoupled.length) {
    console.error(`\nCore modules importing vscode:\n  ${coreCoupled.join('\n  ')}`);
    process.exit(1);
}
