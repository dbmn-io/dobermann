#!/bin/bash

# Add mock logger import to test files that need it

echo "Adding mock logger imports to test files..."

# List of test files that need the import
TEST_FILES=(
    "src/test/integration/command-execution/services/execution/batch-execution-engine-phase3.test.ts"
    "src/test/integration/command-execution/services/execution/execution-coordinator-phase3.test.ts"
    "src/test/integration/command-execution/services/execution/execution-service2-phase2.test.ts"
    "src/test/integration/command-execution/services/execution/execution-service-headers-compatibility.test.ts"
    "src/test/integration/command-execution/services/execution/individual-execution-engine-phase3.test.ts"
    "src/test/integration/command-execution/services/execution/unified-batch-status-flow.test.ts"
    "src/test/integration/execution-engine/execution-coordinator-integration.test.ts"
    "src/test/integration/services/logging/batch-format-convergence.test.ts"
    "src/test/integration/services/logging/end-to-end-logging.test.ts"
    "src/test/integration/services/logging/execution-logging-integration.test.ts"
    "src/test/integration/services/logging/live-vs-post-completion.test.ts"
    "src/test/integration/transaction-preparation/transaction-preparation-flows.test.ts"
    "src/test/integration/command-execution/config/feature-flags-phase4.test.ts"
    "src/test/integration/command-execution/commands/execution-commands-phase5.test.ts"
    "src/test/integration/webview-interactions/execution/timer-integration.test.ts"
    "src/test/unit/core-logic/timer-manager.test.ts"
    "src/test/unit/services/execution/batch-execution-engine-progress.test.ts"
    "src/test/unit/services/logging/execution-logging.service.test.ts"
    "src/test/unit/services/logging/unified-formatter.test.ts"
    "src/test/unit/services/transaction-creator/transaction-creator-actual-file-creation.test.ts"
    "src/test/unit/services/transaction-creator/transaction-creator-file-creation.test.ts"
    "src/test/unit/services/transaction-creator/transaction-creator-template-fix.test.ts"
    "src/test/integration/command-execution/services/transaction-creator/headers-queryparams-storage.test.ts"
    "src/test/integration/command-execution/services/transaction-creator/transaction-creator-phase2.test.ts"
)

# Import line to add
IMPORT_LINE="import { createMockLogger } from "

for file in "${TEST_FILES[@]}"; do
    if [ -f "$file" ]; then
        # Check if import already exists
        if ! grep -q "createMockLogger" "$file"; then
            echo "Adding import to $file"
            
            # Calculate relative path from test file to helpers
            dir=$(dirname "$file")
            # Count how many directories deep we are from src/test
            depth=$(echo "$dir" | tr '/' '\n' | grep -v "^$" | wc -l)
            depth=$((depth - 2)) # Subtract src/test
            
            # Build relative path
            relative_path=""
            for ((i=0; i<depth; i++)); do
                relative_path="../$relative_path"
            done
            relative_path="${relative_path}helpers/logging/mock-logger"
            
            # Add import after the first import line
            sed -i "/^import /a ${IMPORT_LINE}'${relative_path}';" "$file"
        else
            echo "Import already exists in $file"
        fi
    else
        echo "File not found: $file"
    fi
done

echo "Done adding imports!"