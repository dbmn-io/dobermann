// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Issue #324: sql.js execution storage in a temp folder, for `test:core`. The WASM and schema
 * come from their sources (the same files webpack copies into dist/), so no build is needed.
 */
import * as path from 'path';
import { SqlJsStorageOptions } from '../../../services/storage/sqljs-execution-storage.service';
import { createMockLogger } from '../../helpers/logging/mock-logger';

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');

export const SQL_WASM_PATH = require.resolve('sql.js/dist/sql-wasm.wasm');
export const SCHEMA_SQL_PATH = path.join(repoRoot, 'src', 'services', 'storage', 'sqlite-schema.sql');

/** Options for a database at `<tempDir>/.dbmn/executions.db`, where the extension keeps it. */
export function tempStorageOptions(tempDir: string, extra: Partial<SqlJsStorageOptions> = {}): SqlJsStorageOptions {
    return {
        resolveDatabaseDir: async () => path.join(tempDir, '.dbmn'),
        wasmPath: SQL_WASM_PATH,
        schemaPath: SCHEMA_SQL_PATH,
        logger: createMockLogger(),
        ...extra
    };
}
