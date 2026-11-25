// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The unit lane (npm run test:unit; the pre-commit hook and CI run it): EVERY unit test file, so a new one is run by
 * default. Until 2026-11-25 test:unit was an allow-list (since a 2025-07-21 migration kept six files and folders were
 * added one at a time): 26 files ran in no lane, and 10 of them had gone red unseen.
 *
 * `ignore` stays empty: a red file is fixed, or retired with a line in its commit saying what covers it. If one must
 * wait, it goes here as `out/test/unit/<file>.test.js` with a comment saying what is wrong.
 */
module.exports = {
    require: ['out/test/helpers/vscode-mock.js'],
    spec: ['out/test/unit/**/*.test.js'],
    ignore: [],
    recursive: true,
    extension: ['js'],
    reporter: 'spec',
    timeout: 30000,
    slow: 5000,
    exit: true,
    bail: false
};
