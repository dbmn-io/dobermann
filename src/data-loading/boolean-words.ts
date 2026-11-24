// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * The words a boolean is read as, in one place: Map's check (format-converter), Validate's tick boxes and the request
 * (template-parser, modifier-executor, data-transformation) agree. 2026-11-25: active/enabled and inactive/disabled
 * passed Map and Validate, then failed the request ("Invalid boolean value: active").
 */
export const BOOLEAN_TRUE = ['true', 'yes', 'y', '1', 'on', 'active', 'enabled'];
export const BOOLEAN_FALSE = ['false', 'no', 'n', '0', 'off', 'inactive', 'disabled'];
