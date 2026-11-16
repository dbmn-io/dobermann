// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
/**
 * Which channel this build is: a constant of the build, never read from the environment at
 * run time. `dev`: bundled pages on a local stack (the DESKTOP · LOCAL pill), for testing an
 * installable app before production can take it. `production` is refused until it exists (#380).
 */
export const CHANNEL: 'dev' | 'production' = 'dev';
