/**
 * Test helpers for Console Generation fixtures
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ResponseFixture {
  executionId: string;
  duration: number;
  httpStatus: number;
  httpStatusText: string;
  headers: Record<string, string>;
  data?: any;
  error?: string;
  details?: any;
}

export interface BatchFixtures {
  responses: ResponseFixture[];
  metadata: {
    batchId: string;
    totalMembers: number;
    successCount: number;
    errorCount: number;
  };
}

/**
 * Load a single response fixture
 */
export function loadConsoleFixture(fileName: string): ResponseFixture {
  const fixturePath = path.join(__dirname, fileName);
  const content = fs.readFileSync(fixturePath, 'utf-8');
  return JSON.parse(content);
}

/**
 * Load multiple fixtures as batch
 */
export function loadBatchFixtures(fileNames: string[]): BatchFixtures {
  const responses = fileNames.map(fileName => loadConsoleFixture(fileName));
  
  const successCount = responses.filter(r => r.httpStatus >= 200 && r.httpStatus < 300).length;
  const errorCount = responses.length - successCount;
  
  return {
    responses,
    metadata: {
      batchId: `batch-${Date.now()}`,
      totalMembers: responses.length,
      successCount,
      errorCount
    }
  };
}

/**
 * Create mock execution metadata for testing
 */
export function createMockExecutionMetadata(fixture: ResponseFixture) {
  return {
    id: fixture.executionId,
    environment: 'test',
    organization: 'test-org',
    endpointId: 'test-endpoint',
    endpointName: 'Test API Endpoint',
    endpointMethod: 'POST',
    endpointPath: '/api/test',
    executionType: 'individual' as const,
    rows: '1',
    status: fixture.httpStatus >= 200 && fixture.httpStatus < 300 ? 'completed' : 'error',
    runTime: fixture.duration,
    createdAt: new Date('2024-01-15T10:30:00Z'),
    startedAt: new Date('2024-01-15T10:30:01Z'),
    completedAt: new Date(new Date('2024-01-15T10:30:01Z').getTime() + fixture.duration),
    httpStatus: fixture.httpStatus,
    httpStatusText: fixture.httpStatusText,
    responseFile: `/mock/response/${fixture.executionId}-response.json`,
    requestFile: `/mock/request/${fixture.executionId}-request.json`
  };
}

/**
 * Test data extraction patterns
 */
export const TEST_SCENARIOS = {
  INDIVIDUAL_SIMPLE_ARRAY: {
    file: 'individual-simple-array.json',
    expectedRows: 4,
    expectedColumns: 6,
    expectedDataType: 'array',
    expectedTableStructure: {
      columns: ['productId', 'name', 'price', 'category', 'inStock', 'lastUpdated'],
      sortableColumns: ['name', 'price', 'lastUpdated'],
      filterableColumns: ['category', 'inStock']
    }
  },
  
  INDIVIDUAL_NESTED_OBJECT: {
    file: 'individual-nested-object.json', 
    expectedRows: 1,
    expectedColumns: 15, // After flattening
    expectedDataType: 'object',
    expectedFlattenedPaths: [
      'order.orderId',
      'order.customer.name', 
      'order.customer.address.city',
      'order.pricing.total'
    ],
    expectedExpandableArrays: ['order.items'],
    expectedNestedObjects: ['order.customer', 'order.shipping']
  },
  
  BATCH_ALL_SUCCESS: {
    files: ['batch-member-success-1.json', 'batch-member-success-2.json'],
    expectedRows: 2,
    expectedColumns: 8, // executionId + httpStatus + flattened data
    expectedAggregatedColumns: [
      'executionId',
      'httpStatus', 
      'shipmentId',
      'trackingNumber',
      'warehouse.name',
      'totals.totalItems'
    ]
  },
  
  BATCH_MIXED_RESULTS: {
    files: [
      'batch-member-success-1.json',
      'batch-member-error-1.json', 
      'batch-member-error-2.json'
    ],
    expectedRows: 3,
    expectedSuccessRows: 1,
    expectedErrorRows: 2,
    expectedErrorColumns: ['error', 'details.field', 'details.message']
  },
  
  COMPLEX_HIERARCHY: {
    file: 'complex-nested-hierarchy.json',
    expectedDepth: 5, // warehouse > zones > racks > shelves > items
    expectedProgressiveLevels: [
      { level: 'warehouse', rows: 1 },
      { level: 'zones', rows: 2 },
      { level: 'racks', rows: 3 }, 
      { level: 'shelves', rows: 4 },
      { level: 'items', rows: 12 }
    ]
  },
  
  LARGE_ARRAY: {
    file: 'large-array-response.json',
    expectedRows: 5, // Sample shows 5, header indicates 1000 total
    expectedVirtualScrolling: true,
    expectedTotalCount: 1000, // From x-total-count header
    expectedPerformanceTargets: {
      loadTime: 100, // ms
      renderTime: 500, // ms
      scrollFPS: 60
    }
  }
} as const;

/**
 * Data structure analysis helpers
 */
export function analyzeDataStructure(data: any) {
  if (Array.isArray(data)) {
    return {
      type: 'array',
      length: data.length,
      itemStructure: data.length > 0 ? analyzeObjectStructure(data[0]) : null
    };
  } else if (typeof data === 'object' && data !== null) {
    return {
      type: 'object', 
      structure: analyzeObjectStructure(data)
    };
  } else {
    return {
      type: 'primitive',
      dataType: typeof data
    };
  }
}

function analyzeObjectStructure(obj: any, prefix = '', depth = 0): any {
  const structure: any = {
    depth,
    paths: [],
    arrays: [],
    nestedObjects: []
  };
  
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    
    if (Array.isArray(value)) {
      structure.arrays.push({
        path: fullPath,
        length: value.length,
        itemType: value.length > 0 ? typeof value[0] : 'unknown'
      });
    } else if (typeof value === 'object' && value !== null) {
      structure.nestedObjects.push(fullPath);
      if (depth < 3) { // Prevent infinite recursion
        const nested = analyzeObjectStructure(value, fullPath, depth + 1);
        structure.paths.push(...nested.paths);
        structure.arrays.push(...nested.arrays);
        structure.nestedObjects.push(...nested.nestedObjects);
      }
    } else {
      structure.paths.push({
        path: fullPath,
        type: typeof value,
        sampleValue: value
      });
    }
  }
  
  return structure;
}

/**
 * Mock data generators for additional test cases
 */
export function generateLargeArrayData(count: number) {
  const customers = [];
  for (let i = 1; i <= count; i++) {
    customers.push({
      customerId: `C${i.toString().padStart(3, '0')}`,
      name: `Customer ${i}`,
      email: `customer${i}@example.com`,
      status: i % 10 === 0 ? 'overdue' : 'active',
      accountBalance: Math.random() * 50000 - 5000,
      totalOrders: Math.floor(Math.random() * 100),
      lastOrderDate: new Date(Date.now() - Math.random() * 365 * 24 * 60 * 60 * 1000).toISOString()
    });
  }
  
  return {
    executionId: `large-test-${count}`,
    duration: 100 + count / 10,
    httpStatus: 200,
    httpStatusText: 'OK',
    headers: {
      'content-type': 'application/json',
      'x-total-count': count.toString()
    },
    data: customers
  };
}

/**
 * Performance testing helpers
 */
export function measurePerformance<T>(fn: () => T, description: string): T {
  const start = performance.now();
  const result = fn();
  const end = performance.now();
  
  console.log(`${description}: ${(end - start).toFixed(2)}ms`);
  return result;
}

export type TestScenario = keyof typeof TEST_SCENARIOS;