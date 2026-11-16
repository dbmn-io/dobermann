// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Node's `fs/promises` for the browser: ./fs.ts's promises. */
import { promises } from './fs';

export const { access, mkdir, readFile, writeFile, appendFile, rm, unlink, rename, stat, readdir } = promises;
export default promises;
