// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/** Issue #321: `IConfiguration` from a plain object keyed `section.key`, for `test:core`. */
import { IConfiguration } from '../interfaces/configuration.interface';

export class MemoryConfiguration implements IConfiguration {
    constructor(private readonly values: Record<string, unknown> = {}) {}

    get<T>(section: string, key: string, defaultValue: T): T {
        const id = `${section}.${key}`;
        return id in this.values ? this.values[id] as T : defaultValue;
    }
}
