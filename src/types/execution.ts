// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Flexion Tech Pty Ltd
// Re-export types from storage for convenience
export type { ExecutionMetadata, ExecutionStatus } from '../storage/execution-metadata';

// Additional execution-related types for services
export interface ExecutionFilters {
  endpointId?: string;
  state?: string;
  environmentId?: string;
  limit?: number;
  offset?: number;
  orderBy?: string;
  orderDirection?: 'asc' | 'desc';
}