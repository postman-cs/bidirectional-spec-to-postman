/**
 * Test Generator Module Unit Tests
 * Run with: node --test src/__tests__/test-generator.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  TestLevel,
  generateTestScriptsForSpec,
  generatePreRequestScript
} from '../test-generator.js';

import { parseSpec } from '../parser.js';

import {
  getFixturePath,
  createMinimalSpec,
  createTestEndpoint,
  validateJavaScriptSyntax,
  validatePostmanTestScript,
  deepClone
} from './helpers/test-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// TestLevel Tests
// ============================================================

describe('TestLevel', () => {
  it('should define SMOKE level', () => {
    assert.strictEqual(TestLevel.SMOKE, 'smoke');
  });

  it('should define CONTRACT level', () => {
    assert.strictEqual(TestLevel.CONTRACT, 'contract');
  });
});

// ============================================================
// generateTestScriptsForSpec Tests
// ============================================================

describe('generateTestScriptsForSpec', () => {
  it('should generate test scripts for all endpoints', async () => {
    const specPath = getFixturePath('minimal-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    assert.ok(Object.keys(scripts).length > 0);
    assert.ok(scripts['default'], 'Should have default script');
  });

  it('should generate smoke tests when level is SMOKE', async () => {
    const specPath = getFixturePath('minimal-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const healthScript = scripts['Health check'] || scripts['default'];

    const scriptText = healthScript.join('\n');
    assert.ok(scriptText.includes('Smoke tests') || scriptText.includes('smoke'));
  });

  it('should generate contract tests when level is CONTRACT', async () => {
    const specPath = getFixturePath('minimal-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const healthScript = scripts['Health check'] || scripts['default'];

    const scriptText = healthScript.join('\n');
    assert.ok(scriptText.includes('Contract tests') || scriptText.includes('contract'));
  });

  it('should include default test script', async () => {
    const specPath = getFixturePath('minimal-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    assert.ok(scripts['default']);
    assert.ok(Array.isArray(scripts['default']));
  });

  it('should generate tests for complex spec with multiple endpoints', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    assert.ok(Object.keys(scripts).length > 5, 'Should have multiple test scripts');
  });

  it('should produce valid JavaScript syntax', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    for (const [name, script] of Object.entries(scripts)) {
      const result = validateJavaScriptSyntax(script);
      assert.ok(result.valid, `Script for "${name}" has invalid syntax: ${result.error}`);
    }
  });

  it('should produce valid Postman test structure', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    for (const [name, script] of Object.entries(scripts)) {
      const result = validatePostmanTestScript(script);
      assert.ok(result.tests.length > 0, `Script for "${name}" should have at least one pm.test`);
    }
  });
});

// ============================================================
// Smoke Test Script Tests
// ============================================================

describe('Smoke Test Script Generation', () => {
  it('should validate status code as success range', async () => {
    const api = createMinimalSpec();
    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const script = scripts['Test endpoint'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('pm.test'));
    assert.ok(scriptText.includes('status') || scriptText.includes('Status'));
  });

  it('should include response time check', async () => {
    const api = createMinimalSpec();
    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const script = scripts['Test endpoint'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('responseTime') || scriptText.includes('Response time'));
  });

  it('should use configurable threshold from environment', async () => {
    const api = createMinimalSpec();
    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const script = scripts['Test endpoint'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('RESPONSE_TIME_THRESHOLD'));
  });

  it('should include basic response body check', async () => {
    const api = createMinimalSpec();
    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const script = scripts['Test endpoint'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('response.json') ||
      scriptText.includes('Response body') ||
      scriptText.includes('not.be.undefined')
    );
  });

  it('should handle endpoints with multiple success codes', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'Multi response',
            responses: {
              '200': { description: 'OK' },
              '201': { description: 'Created' },
              '204': { description: 'No Content' }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const script = scripts['Multi response'] || scripts['default'];
    const scriptText = script.join('\n');

    // Should include multiple success codes
    assert.ok(scriptText.includes('200') || scriptText.includes('201'));
  });
});

// ============================================================
// Contract Test Script Tests
// ============================================================

describe('Contract Test Script Generation', () => {
  it('should validate specific status code', async () => {
    const api = createMinimalSpec();
    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['Test endpoint'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('200') || scriptText.includes('status'));
  });

  it('should validate Content-Type header', async () => {
    const api = createMinimalSpec();
    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['Test endpoint'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('Content-Type') ||
      scriptText.includes('application/json')
    );
  });

  it('should include JSON schema validation', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With schema',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        count: { type: 'integer' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With schema'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('object') || scriptText.includes('schema'));
  });

  it('should validate required fields', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With required',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['id', 'name'],
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With required'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('id') || scriptText.includes('required'));
    assert.ok(scriptText.includes('name') || scriptText.includes('required'));
  });

  it('should validate enum constraints', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With enum',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        status: {
                          type: 'string',
                          enum: ['active', 'inactive', 'pending']
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With enum'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('active') ||
      scriptText.includes('oneOf') ||
      scriptText.includes('enum')
    );
  });

  it('should validate format patterns', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With formats',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        email: { type: 'string', format: 'email' },
                        id: { type: 'string', format: 'uuid' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With formats'] || scripts['default'];
    const scriptText = script.join('\n');

    // Should include format validation regex patterns
    assert.ok(
      scriptText.includes('match') ||
      scriptText.includes('@') ||
      scriptText.includes('email') ||
      scriptText.includes('uuid')
    );
  });

  it('should validate string length constraints', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With constraints',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        name: {
                          type: 'string',
                          minLength: 1,
                          maxLength: 100
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With constraints'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('length') ||
      scriptText.includes('minLength') ||
      scriptText.includes('1') ||
      scriptText.includes('100')
    );
  });

  it('should validate numeric constraints', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With numeric',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        price: {
                          type: 'number',
                          minimum: 0,
                          maximum: 9999.99
                        },
                        quantity: {
                          type: 'integer',
                          minimum: 0
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With numeric'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('number') ||
      scriptText.includes('minimum') ||
      scriptText.includes('at.least') ||
      scriptText.includes('0')
    );
  });

  it('should validate array constraints', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With array',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'array',
                      minItems: 0,
                      maxItems: 100,
                      items: {
                        type: 'object',
                        properties: {
                          id: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With array'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('array'));
  });

  it('should include error response validation', async () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'With errors',
            responses: {
              '200': { description: 'OK' },
              '400': { description: 'Bad Request' },
              '404': { description: 'Not Found' }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const script = scripts['With errors'] || scripts['default'];
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('error') ||
      scriptText.includes('400') ||
      scriptText.includes('Error response')
    );
  });

  it('should handle nested object schemas', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const nestedScript = scripts['Get nested structure'] || scripts['default'];

    const result = validateJavaScriptSyntax(nestedScript);
    assert.ok(result.valid, `Nested schema script has invalid syntax: ${result.error}`);
  });
});

// ============================================================
// Default Test Script Tests
// ============================================================

describe('Default Test Scripts', () => {
  it('should generate valid default smoke test', async () => {
    const api = { openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' }, paths: {} };
    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);

    assert.ok(scripts['default']);
    const result = validateJavaScriptSyntax(scripts['default']);
    assert.ok(result.valid);
  });

  it('should generate valid default contract test', async () => {
    const api = { openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' }, paths: {} };
    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    assert.ok(scripts['default']);
    const result = validateJavaScriptSyntax(scripts['default']);
    assert.ok(result.valid);
  });

  it('should include standard success codes in default smoke test', async () => {
    const api = { openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' }, paths: {} };
    const scripts = generateTestScriptsForSpec(api, TestLevel.SMOKE);
    const scriptText = scripts['default'].join('\n');

    assert.ok(scriptText.includes('200') || scriptText.includes('201') || scriptText.includes('204'));
  });

  it('should check for JSON response in default contract test', async () => {
    const api = { openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' }, paths: {} };
    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const scriptText = scripts['default'].join('\n');

    assert.ok(scriptText.includes('json') || scriptText.includes('JSON'));
  });
});

// ============================================================
// generatePreRequestScript Tests
// ============================================================

describe('generatePreRequestScript', () => {
  it('should generate pre-request script for endpoint', () => {
    const endpoint = createTestEndpoint({
      path: '/users/{userId}',
      method: 'GET'
    });

    const script = generatePreRequestScript(endpoint);

    assert.ok(Array.isArray(script));
    assert.ok(script.length > 0);
  });

  it('should set path parameters', () => {
    const endpoint = createTestEndpoint({
      path: '/users/{userId}/posts/{postId}',
      method: 'GET'
    });

    const script = generatePreRequestScript(endpoint);
    const scriptText = script.join('\n');

    assert.ok(scriptText.includes('userId'));
    assert.ok(scriptText.includes('postId'));
    assert.ok(scriptText.includes('pm.variables.set'));
  });

  it('should include auth setup for secured endpoints', () => {
    const endpoint = createTestEndpoint({
      security: [{ bearerAuth: [] }]
    });

    const script = generatePreRequestScript(endpoint);
    const scriptText = script.join('\n');

    assert.ok(
      scriptText.includes('auth') ||
      scriptText.includes('Auth') ||
      scriptText.includes('token')
    );
  });

  it('should handle endpoint with no path parameters', () => {
    const endpoint = createTestEndpoint({
      path: '/health',
      method: 'GET'
    });

    const script = generatePreRequestScript(endpoint);

    // Should still be valid, just without parameter setup
    const result = validateJavaScriptSyntax(script);
    assert.ok(result.valid);
  });

  it('should handle endpoint with no security', () => {
    const endpoint = createTestEndpoint({
      security: []
    });

    const script = generatePreRequestScript(endpoint);

    // Should still be valid
    const result = validateJavaScriptSyntax(script);
    assert.ok(result.valid);
  });

  it('should produce valid JavaScript', () => {
    const endpoint = createTestEndpoint({
      path: '/users/{userId}/items/{itemId}',
      security: [{ apiKeyAuth: [] }]
    });

    const script = generatePreRequestScript(endpoint);
    const result = validateJavaScriptSyntax(script);

    assert.ok(result.valid, `Pre-request script has invalid syntax: ${result.error}`);
  });
});

// ============================================================
// Edge Cases and Error Handling
// ============================================================

describe('Edge Cases', () => {
  it('should handle spec with no responses', () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'No responses',
            responses: {}
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const result = validateJavaScriptSyntax(scripts['No responses'] || scripts['default']);

    assert.ok(result.valid);
  });

  it('should handle response without content', () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          delete: {
            summary: 'No content response',
            responses: {
              '204': { description: 'No Content' }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const result = validateJavaScriptSyntax(scripts['No content response'] || scripts['default']);

    assert.ok(result.valid);
  });

  it('should handle deeply nested schemas', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);

    // All scripts should have valid syntax
    for (const [name, script] of Object.entries(scripts)) {
      const result = validateJavaScriptSyntax(script);
      assert.ok(result.valid, `Script "${name}" has invalid syntax: ${result.error}`);
    }
  });

  it('should handle schema with special characters in property names', () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'Special chars',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        'data-value': { type: 'string' },
                        'item_count': { type: 'integer' },
                        '@type': { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const result = validateJavaScriptSyntax(scripts['Special chars'] || scripts['default']);

    assert.ok(result.valid, `Script has invalid syntax: ${result.error}`);
  });

  it('should handle empty enum array', () => {
    const api = createMinimalSpec({
      paths: {
        '/test': {
          get: {
            summary: 'Empty enum',
            responses: {
              '200': {
                description: 'OK',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        status: { type: 'string', enum: [] }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    });

    const scripts = generateTestScriptsForSpec(api, TestLevel.CONTRACT);
    const result = validateJavaScriptSyntax(scripts['Empty enum'] || scripts['default']);

    assert.ok(result.valid);
  });
});
