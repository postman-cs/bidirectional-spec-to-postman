/**
 * Test Helpers
 *
 * Common utilities for testing including mock clients,
 * temporary file management, and assertion helpers.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get path to test fixtures
 * @param {string} filename - Fixture filename
 * @returns {string} Absolute path to fixture
 */
export function getFixturePath(filename) {
  return path.join(__dirname, '..', 'fixtures', filename);
}

/**
 * Read a test fixture file
 * @param {string} filename - Fixture filename
 * @returns {string} File contents
 */
export function readFixture(filename) {
  return fs.readFileSync(getFixturePath(filename), 'utf8');
}

/**
 * Mock SpecHubClient for testing without API calls
 */
export class MockSpecHubClient {
  constructor(options = {}) {
    this.apiKey = options.apiKey || 'mock-api-key';
    this.workspaceId = options.workspaceId || 'mock-workspace-id';
    this.collections = options.collections || [];
    this.specs = options.specs || [];
    this.environments = options.environments || [];
    this.calls = [];
  }

  /**
   * Record method call for assertion
   */
  _recordCall(method, args) {
    this.calls.push({ method, args, timestamp: Date.now() });
  }

  /**
   * Get recorded calls for a method
   */
  getCallsFor(method) {
    return this.calls.filter(c => c.method === method);
  }

  /**
   * Reset recorded calls
   */
  resetCalls() {
    this.calls = [];
  }

  async request(method, endpoint, body = null) {
    this._recordCall('request', { method, endpoint, body });
    return { success: true };
  }

  async uploadSpec(name, content, specId = null) {
    this._recordCall('uploadSpec', { name, content, specId });
    return specId || 'mock-spec-id-' + Date.now();
  }

  async generateOrSyncCollection(specId, name, options = {}) {
    this._recordCall('generateOrSyncCollection', { specId, name, options });
    return 'mock-collection-uid-' + Date.now();
  }

  async getCollection(collectionUid) {
    this._recordCall('getCollection', { collectionUid });
    const found = this.collections.find(c => c.uid === collectionUid);
    return found || {
      collection: {
        info: { name: 'Mock Collection', _postman_id: collectionUid },
        item: []
      }
    };
  }

  async updateCollection(collectionUid, collection) {
    this._recordCall('updateCollection', { collectionUid, collection });
    return { collection };
  }

  async addTestScripts(collectionUid, testScripts) {
    this._recordCall('addTestScripts', { collectionUid, testScripts });
    return { success: true };
  }

  async applyCollectionTags(collectionUid, type) {
    this._recordCall('applyCollectionTags', { collectionUid, type });
    return { tags: [] };
  }

  async findSpecByName(name) {
    this._recordCall('findSpecByName', { name });
    return this.specs.find(s => s.name === name) || null;
  }

  async listSpecs() {
    this._recordCall('listSpecs', {});
    return this.specs;
  }

  async getWorkspaceCollections() {
    this._recordCall('getWorkspaceCollections', {});
    return this.collections;
  }

  async getWorkspaceEnvironments() {
    this._recordCall('getWorkspaceEnvironments', {});
    return this.environments;
  }
}

/**
 * Validate JavaScript syntax of generated test scripts
 * @param {string|string[]} script - Test script (string or array of lines)
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
export function validateJavaScriptSyntax(script) {
  const code = Array.isArray(script) ? script.join('\n') : script;

  try {
    new vm.Script(code);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error.message,
      line: error.lineNumber || null
    };
  }
}

/**
 * Validate Postman test script structure
 * @param {string|string[]} script - Test script
 * @returns {{ valid: boolean, tests: string[], errors: string[] }}
 */
export function validatePostmanTestScript(script) {
  const code = Array.isArray(script) ? script.join('\n') : script;
  const tests = [];
  const errors = [];

  // Check for pm.test calls
  const testMatches = code.matchAll(/pm\.test\s*\(\s*["'`]([^"'`]+)["'`]/g);
  for (const match of testMatches) {
    tests.push(match[1]);
  }

  // Check for common issues
  if (code.includes('pm.expect') && !code.includes('pm.test')) {
    errors.push('pm.expect used outside of pm.test block');
  }

  // Validate syntax
  const syntaxResult = validateJavaScriptSyntax(code);
  if (!syntaxResult.valid) {
    errors.push(`Syntax error: ${syntaxResult.error}`);
  }

  return {
    valid: errors.length === 0,
    tests,
    errors
  };
}

/**
 * Create a temporary directory for test files
 * @returns {{ path: string, cleanup: () => void }}
 */
export function createTempDir() {
  const tempPath = path.join(__dirname, '..', '.temp-' + Date.now());
  fs.mkdirSync(tempPath, { recursive: true });

  return {
    path: tempPath,
    cleanup: () => {
      if (fs.existsSync(tempPath)) {
        fs.rmSync(tempPath, { recursive: true, force: true });
      }
    }
  };
}

/**
 * Create a minimal valid OpenAPI spec object
 * @param {object} overrides - Properties to override
 * @returns {object} OpenAPI spec object
 */
export function createMinimalSpec(overrides = {}) {
  return {
    openapi: '3.0.3',
    info: {
      title: 'Test API',
      version: '1.0.0',
      ...overrides.info
    },
    paths: overrides.paths || {
      '/test': {
        get: {
          summary: 'Test endpoint',
          operationId: 'testEndpoint',
          responses: {
            '200': {
              description: 'Success',
              content: {
                'application/json': {
                  schema: { type: 'object' }
                }
              }
            }
          }
        }
      }
    },
    servers: overrides.servers || [
      { url: 'https://api.example.com', description: 'Default' }
    ],
    ...overrides
  };
}

/**
 * Create an endpoint object for testing
 * @param {object} overrides - Properties to override
 * @returns {object} Endpoint object
 */
export function createTestEndpoint(overrides = {}) {
  return {
    id: overrides.id || 'test_endpoint',
    name: overrides.name || 'Test Endpoint',
    description: overrides.description || 'A test endpoint',
    method: overrides.method || 'GET',
    path: overrides.path || '/test',
    tags: overrides.tags || ['default'],
    parameters: overrides.parameters || [],
    requestBody: overrides.requestBody || null,
    responses: overrides.responses || {
      '200': {
        description: 'Success',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' }
              },
              required: ['id']
            }
          }
        }
      }
    },
    security: overrides.security || [],
    raw: overrides.raw || {}
  };
}

/**
 * Assert that an array contains expected items
 * @param {Array} actual - Actual array
 * @param {Array} expected - Expected items (subset)
 * @param {string} message - Assertion message
 */
export function assertContainsAll(actual, expected, message = '') {
  for (const item of expected) {
    const found = actual.some(a =>
      typeof item === 'object'
        ? JSON.stringify(a) === JSON.stringify(item)
        : a === item
    );
    if (!found) {
      throw new Error(`${message}: Expected array to contain ${JSON.stringify(item)}`);
    }
  }
}

/**
 * Deep clone an object
 * @param {object} obj - Object to clone
 * @returns {object} Cloned object
 */
export function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export default {
  getFixturePath,
  readFixture,
  MockSpecHubClient,
  validateJavaScriptSyntax,
  validatePostmanTestScript,
  createTempDir,
  createMinimalSpec,
  createTestEndpoint,
  assertContainsAll,
  deepClone
};
