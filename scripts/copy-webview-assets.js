// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Copy webview assets (HTML, CSS, JS) to the out directory
 * 
 * This script copies all webview assets from src/webviews to out/webviews
 * so they are available in the packaged extension.
 */

const fs = require('fs');
const path = require('path');

function copyFileSync(src, dest) {
    const destDir = path.dirname(dest);
    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(src, dest);
}

function copyDirectorySync(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    
    const items = fs.readdirSync(src);
    
    for (const item of items) {
        const srcPath = path.join(src, item);
        const destPath = path.join(dest, item);
        const stat = fs.statSync(srcPath);
        
        if (stat.isDirectory()) {
            copyDirectorySync(srcPath, destPath);
        } else {
            // Copy HTML, CSS, JS, and font files but skip TS files (they get compiled separately)
            const ext = path.extname(item);
            if (['.html', '.css', '.js', '.ttf', '.woff', '.woff2', '.png', '.svg'].includes(ext)) {
                copyFileSync(srcPath, destPath);
                console.log(`Copied: ${srcPath} -> ${destPath}`);
            }
        }
    }
}

const srcDir = path.join(__dirname, '../src/webviews');
const destDir = path.join(__dirname, '../out/webviews');

console.log('📁 Copying webview assets...');
console.log(`Source: ${srcDir}`);
console.log(`Destination: ${destDir}`);

if (!fs.existsSync(srcDir)) {
    console.error('❌ Source webviews directory not found:', srcDir);
    process.exit(1);
}

try {
    copyDirectorySync(srcDir, destDir);
    console.log('✅ Successfully copied webview assets');
} catch (error) {
    console.error('❌ Error copying webview assets:', error);
    process.exit(1);
}