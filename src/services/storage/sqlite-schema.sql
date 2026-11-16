-- SQLite Schema for Active8 Execution Metadata Storage
-- GitHub Issue #102: Migrate from JSON to SQLite for performance and reliability
--
-- This schema maps directly from Zod schemas in src/storage/execution-metadata.ts
-- See ExecutionMetadataSchema and ExecutionRow interface for field definitions

-- Main executions table
CREATE TABLE IF NOT EXISTS executions (
    -- Primary key
    id TEXT PRIMARY KEY NOT NULL,

    -- Environment and organization
    environment TEXT NOT NULL,
    environment_id TEXT,  -- UUID of environment (optional for now, mandatory after migration)
    organization TEXT,

    -- Endpoint information
    endpoint_id TEXT NOT NULL,
    endpoint_name TEXT NOT NULL,
    endpoint_method TEXT NOT NULL,
    endpoint_path TEXT NOT NULL,

    -- Execution type and batch tracking
    execution_type TEXT NOT NULL CHECK(execution_type IN ('individual', 'batch', 'batch_member')) DEFAULT 'individual',
    batch_id TEXT,  -- Links batch_member to parent batch
    row_start INTEGER DEFAULT NULL,  -- Starting CSV row index for batch members (1-based, NULL for individual/batch)
    rows TEXT NOT NULL DEFAULT '1',  -- Number of rows: "count" for members, "count(total)" for batch parent

    -- Status (context-dependent based on execution_type)
    status TEXT NOT NULL,

    -- Timing information
    run_time REAL,  -- Execution duration in milliseconds
    created_at INTEGER NOT NULL,  -- Unix timestamp in milliseconds
    started_at INTEGER,
    completed_at INTEGER,

    -- File paths
    request_file TEXT,
    response_file TEXT,
    log_path TEXT,  -- Path to execution log file

    -- HTTP response information
    http_status INTEGER,
    http_status_text TEXT,
    error_message TEXT,

    -- Request tracking
    request_hash TEXT,

    -- Request metadata (stored as JSON strings)
    request_headers TEXT,  -- JSON: Record<string, string>
    request_query_params TEXT,  -- JSON: Record<string, string>

    -- Test-related fields
    test_status TEXT CHECK(test_status IN ('no-tests', 'pending', 'skipped', 'passed', 'failed', 'error', 'running') OR test_status IS NULL),
    tests_passed INTEGER,
    tests_failed INTEGER,
    test_results TEXT,  -- JSON: TestExecutionResult

    -- Batch configuration (stored as JSON string, only for execution_type='batch')
    batch_configuration TEXT,  -- JSON: BatchConfiguration
    batch_resumption_data TEXT,  -- JSON: BatchResumptionData

    -- Chunked preparation state (GitHub Issue #94)
    preparation_state TEXT,  -- JSON: BatchPreparationState

    -- Endpoint configuration (GitHub Issue #47)
    endpoint_config TEXT,  -- JSON: APIEndpointConfig

    -- Column mapping (GitHub Issue #48)
    column_mapping_used TEXT,  -- JSON: Array of column mapping objects

    -- Environment variables (GitHub Issue #165)
    environment_variables TEXT,  -- JSON: Record<string, string> of environment variables for {{ENV:varName}}

    -- Batch copy lineage (GitHub Issue #68)
    copied_from_batch_id TEXT,
    copied_from_environment TEXT,
    copied_from_organization TEXT,
    copied_at INTEGER,  -- Unix timestamp
    copy_generation INTEGER,

    -- Split transaction tracking (GitHub Issue #74)
    split_from_member_id TEXT,
    is_split_transaction INTEGER CHECK(is_split_transaction IN (0, 1)),  -- Boolean as 0/1
    split_reason TEXT,
    array_index INTEGER,
    original_array_size INTEGER,

    -- Reprocess tracking (GitHub Issue #151)
    reprocessed_from_batch_id TEXT,  -- Links to original batch (on child batch) — DEPRECATED: unused after in-batch reprocess overhaul
    reprocessed_to_batch_id TEXT,    -- Links to new batch created from reprocess (on parent batch) — DEPRECATED: unused after in-batch reprocess overhaul
    reprocess_type TEXT CHECK(reprocess_type IN ('INCOMPLETE', 'ERRORS', 'PENDING', 'ALL', 'SELECTED', 'SPLIT') OR reprocess_type IS NULL),

    -- In-batch reprocess tracking
    reprocess_count INTEGER DEFAULT 0,  -- Number of times this member has been retried

    -- Foreign key constraints
    FOREIGN KEY (batch_id) REFERENCES executions(id) ON DELETE CASCADE
);

-- Indexes for common query patterns

-- Index for execution type filtering (individual, batch, batch_member)
CREATE INDEX IF NOT EXISTS idx_execution_type ON executions(execution_type);

-- Index for status filtering (pending, running, completed, etc.)
CREATE INDEX IF NOT EXISTS idx_status ON executions(status);

-- Index for batch member lookups (critical for batch execution performance)
CREATE INDEX IF NOT EXISTS idx_batch_id ON executions(batch_id);

-- Composite index for batch members by status (heavily used in batch execution)
CREATE INDEX IF NOT EXISTS idx_batch_members
    ON executions(batch_id, execution_type, status)
    WHERE execution_type = 'batch_member';

-- Index for endpoint lookups
CREATE INDEX IF NOT EXISTS idx_endpoint
    ON executions(endpoint_id, environment);

-- Index for created_at sorting (execution history)
CREATE INDEX IF NOT EXISTS idx_created_at ON executions(created_at DESC);

-- Index for completed_at sorting (completed executions)
CREATE INDEX IF NOT EXISTS idx_completed_at ON executions(completed_at DESC);

-- Index for active queue (pending/running individual and batch executions)
-- GitHub Issue #94 - 'preparing' removed: batches transition directly to PENDING
CREATE INDEX IF NOT EXISTS idx_active_queue
    ON executions(execution_type, status, created_at)
    WHERE execution_type IN ('individual', 'batch')
    AND status IN ('pending', 'running');

-- Index for environment filtering
CREATE INDEX IF NOT EXISTS idx_environment ON executions(environment);

-- Index for organization filtering
CREATE INDEX IF NOT EXISTS idx_organization ON executions(organization);

-- Composite index for batch copy lineage tracking
CREATE INDEX IF NOT EXISTS idx_batch_copy
    ON executions(copied_from_batch_id, copy_generation)
    WHERE copied_from_batch_id IS NOT NULL;

-- Table for batch resumption data (optional separate table approach)
-- Currently stored as JSON in executions.batch_resumption_data
-- This table can be used for future optimization if needed
CREATE TABLE IF NOT EXISTS batch_resumption (
    batch_id TEXT PRIMARY KEY NOT NULL,
    current_execution_index INTEGER NOT NULL DEFAULT 0,
    completed_executions TEXT,  -- JSON array of execution IDs
    failed_executions TEXT,     -- JSON array of execution IDs
    skipped_executions TEXT,    -- JSON array of execution IDs
    paused_at INTEGER,          -- Unix timestamp

    FOREIGN KEY (batch_id) REFERENCES executions(id) ON DELETE CASCADE
);

-- GitHub Issue #247: links between runs. A chain sends one run's Console rows into another
-- run's batch; source = where the rows came from, target = the batch they became.
-- No FOREIGN KEYs on purpose: the cross-window merge rewrites execution rows with
-- INSERT OR REPLACE, and a cascading delete would lose every link to a merged row.
-- Reads join to executions, so a link to a deleted run simply stops showing.
CREATE TABLE IF NOT EXISTS execution_links (
    id TEXT PRIMARY KEY NOT NULL,
    source_execution_id TEXT NOT NULL,
    target_execution_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'chain',
    view_name TEXT,
    row_count INTEGER,
    created_at INTEGER NOT NULL  -- Unix ms
);
CREATE INDEX IF NOT EXISTS idx_links_source ON execution_links(source_execution_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON execution_links(target_execution_id);

-- Database metadata table for versioning and migrations
CREATE TABLE IF NOT EXISTS db_metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

-- Insert schema version
INSERT OR REPLACE INTO db_metadata (key, value) VALUES ('version', '1');
INSERT OR REPLACE INTO db_metadata (key, value) VALUES ('created_at', datetime('now'));

-- Performance views for common queries

-- Active queue view (pending/running individual and batch executions)
-- GitHub Issue #94 - 'preparing' removed: batches transition directly to PENDING
CREATE VIEW IF NOT EXISTS vw_active_queue AS
SELECT * FROM executions
WHERE execution_type IN ('individual', 'batch')
AND status IN ('pending', 'running')
ORDER BY
    CASE execution_type
        WHEN 'individual' THEN 1
        WHEN 'batch' THEN 2
    END,
    created_at ASC;

-- Completed executions view (execution history)
CREATE VIEW IF NOT EXISTS vw_execution_history AS
SELECT * FROM executions
WHERE (
    (execution_type = 'batch' AND status IN ('completed', 'stopped', 'cancelled'))
    OR
    (execution_type IN ('individual', 'batch_member') AND status IN ('completed', 'error', 'cancelled'))
)
ORDER BY completed_at DESC;

-- Batch summary view (batch executions with member counts)
CREATE VIEW IF NOT EXISTS vw_batch_summary AS
SELECT
    b.id,
    b.endpoint_name,
    b.environment,
    b.status,
    b.created_at,
    b.started_at,
    b.completed_at,
    b.rows,
    COUNT(m.id) as member_count,
    SUM(CASE WHEN m.status = 'completed' THEN 1 ELSE 0 END) as completed_count,
    SUM(CASE WHEN m.status = 'error' THEN 1 ELSE 0 END) as error_count,
    SUM(CASE WHEN m.status = 'pending' THEN 1 ELSE 0 END) as pending_count,
    SUM(CASE WHEN m.status = 'running' THEN 1 ELSE 0 END) as running_count
FROM executions b
LEFT JOIN executions m ON m.batch_id = b.id AND m.execution_type = 'batch_member'
WHERE b.execution_type = 'batch'
GROUP BY b.id;
