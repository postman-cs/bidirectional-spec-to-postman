/**
 * Parser Module Unit Tests
 * Run with: node --test src/__tests__/parser.test.js
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  parseSpec,
  extractEndpoints,
  getResponseSchema,
  getRequiredFields,
  getExample,
  buildRequestBodyExample,
  convertPathParams,
  getBaseUrl
} from '../parser.js';

import {
  getFixturePath,
  createMinimalSpec,
  deepClone
} from './helpers/test-helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// parseSpec Tests
// ============================================================

describe('parseSpec', () => {
  it('should parse valid YAML spec file', async () => {
    const specPath = getFixturePath('minimal-spec.yaml');
    const api = await parseSpec(specPath);

    assert.strictEqual(api.openapi, '3.0.3');
    assert.strictEqual(api.info.title, 'Minimal API');
    assert.ok(api.paths['/health']);
  });

  it('should parse complex YAML spec with all features', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    assert.strictEqual(api.info.title, 'Complex API');
    assert.ok(api.paths['/items']);
    assert.ok(api.paths['/items/{itemId}']);
    assert.ok(api.components.schemas.Item);
    assert.ok(api.components.securitySchemes);
  });

  it('should dereference $ref references', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);

    // After dereferencing, $ref should be resolved to actual schema
    const itemSchema = api.paths['/items'].get.responses['200'].content['application/json'].schema.items;
    assert.strictEqual(itemSchema.type, 'object');
    assert.ok(itemSchema.properties.id);
  });

  it('should throw error for non-existent file', async () => {
    await assert.rejects(
      () => parseSpec('/nonexistent/path/spec.yaml'),
      /Spec file not found/
    );
  });

  it('should handle circular references', async () => {
    const specPath = getFixturePath('circular-spec.yaml');
    // SwaggerParser should handle circular refs during dereference
    const api = await parseSpec(specPath);

    assert.strictEqual(api.info.title, 'Circular Reference API');
    assert.ok(api.components.schemas.Node);
  });
});

// ============================================================
// extractEndpoints Tests
// ============================================================

describe('extractEndpoints', () => {
  it('should extract endpoints from simple spec', async () => {
    const specPath = getFixturePath('minimal-spec.yaml');
    const api = await parseSpec(specPath);
    const endpoints = extractEndpoints(api);

    assert.strictEqual(endpoints.length, 1);
    assert.strictEqual(endpoints[0].method, 'GET');
    assert.strictEqual(endpoints[0].path, '/health');
    assert.strictEqual(endpoints[0].id, 'healthCheck');
  });

  it('should extract all HTTP methods', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);
    const endpoints = extractEndpoints(api);

    const methods = endpoints.map(e => e.method);
    assert.ok(methods.includes('GET'));
    assert.ok(methods.includes('POST'));
    assert.ok(methods.includes('PUT'));
    assert.ok(methods.includes('DELETE'));
  });

  it('should include path-level parameters', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);
    const endpoints = extractEndpoints(api);

    const getItemEndpoint = endpoints.find(e => e.path === '/items/{itemId}' && e.method === 'GET');
    assert.ok(getItemEndpoint);
    assert.ok(getItemEndpoint.parameters.length > 0);

    const itemIdParam = getItemEndpoint.parameters.find(p => p.name === 'itemId');
    assert.ok(itemIdParam);
    assert.strictEqual(itemIdParam.in, 'path');
  });

  it('should merge path and operation parameters', async () => {
    const api = createMinimalSpec({
      paths: {
        '/items/{id}': {
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'string' } }
          ],
          get: {
            summary: 'Get item',
            parameters: [
              { name: 'include', in: 'query', schema: { type: 'string' } }
            ],
            responses: { '200': { description: 'OK' } }
          }
        }
      }
    });

    const endpoints = extractEndpoints(api);
    const getEndpoint = endpoints[0];

    assert.strictEqual(getEndpoint.parameters.length, 2);
    assert.ok(getEndpoint.parameters.find(p => p.name === 'id'));
    assert.ok(getEndpoint.parameters.find(p => p.name === 'include'));
  });

  it('should handle empty paths', () => {
    const api = { openapi: '3.0.3', info: { title: 'Empty', version: '1.0.0' } };
    const endpoints = extractEndpoints(api);

    assert.strictEqual(endpoints.length, 0);
  });

  it('should handle spec with no paths property', () => {
    const api = { openapi: '3.0.3', info: { title: 'No Paths', version: '1.0.0' }, paths: null };
    const endpoints = extractEndpoints(api);

    assert.strictEqual(endpoints.length, 0);
  });

  it('should generate operationId when missing', () => {
    const api = createMinimalSpec({
      paths: {
        '/users/{userId}/posts': {
          post: {
            summary: 'Create post',
            responses: { '201': { description: 'Created' } }
          }
        }
      }
    });

    const endpoints = extractEndpoints(api);
    assert.ok(endpoints[0].id);
    assert.ok(endpoints[0].id.includes('post'));
  });

  it('should extract tags from operations', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);
    const endpoints = extractEndpoints(api);

    const itemEndpoint = endpoints.find(e => e.path === '/items' && e.method === 'GET');
    assert.ok(itemEndpoint.tags.includes('Items'));
  });

  it('should extract security requirements', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);
    const endpoints = extractEndpoints(api);

    // Global security should be inherited
    const itemEndpoint = endpoints.find(e => e.path === '/items' && e.method === 'GET');
    assert.ok(itemEndpoint.security.length > 0);
  });

  it('should extract request body', async () => {
    const specPath = getFixturePath('complex-spec.yaml');
    const api = await parseSpec(specPath);
    const endpoints = extractEndpoints(api);

    const createEndpoint = endpoints.find(e => e.path === '/items' && e.method === 'POST');
    assert.ok(createEndpoint.requestBody);
    assert.ok(createEndpoint.requestBody.content['application/json']);
  });
});

// ============================================================
// getResponseSchema Tests
// ============================================================

describe('getResponseSchema', () => {
  const responses = {
    '200': {
      description: 'Success',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { id: { type: 'string' } } }
        }
      }
    },
    '201': {
      description: 'Created',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { id: { type: 'string' }, created: { type: 'boolean' } } }
        }
      }
    },
    '204': {
      description: 'No Content'
    },
    'default': {
      description: 'Error',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { error: { type: 'string' } } }
        }
      }
    }
  };

  it('should return schema for specified status code', () => {
    const result = getResponseSchema(responses, '200');

    assert.ok(result);
    assert.strictEqual(result.contentType, 'application/json');
    assert.strictEqual(result.schema.type, 'object');
    assert.ok(result.schema.properties.id);
  });

  it('should return schema for 201 status code', () => {
    const result = getResponseSchema(responses, '201');

    assert.ok(result);
    assert.ok(result.schema.properties.created);
  });

  it('should fall back to default response', () => {
    const result = getResponseSchema(responses, '500');

    assert.ok(result);
    assert.ok(result.schema.properties.error);
  });

  it('should return null for response without content', () => {
    const result = getResponseSchema(responses, '204');

    assert.strictEqual(result, null);
  });

  it('should return null for missing response', () => {
    const result = getResponseSchema({}, '200');

    assert.strictEqual(result, null);
  });

  it('should prefer application/json content type', () => {
    const multiContentResponses = {
      '200': {
        description: 'Success',
        content: {
          'text/plain': { schema: { type: 'string' } },
          'application/json': { schema: { type: 'object' } },
          'application/xml': { schema: { type: 'object' } }
        }
      }
    };

    const result = getResponseSchema(multiContentResponses, '200');

    assert.strictEqual(result.contentType, 'application/json');
    assert.strictEqual(result.schema.type, 'object');
  });

  it('should fall back to first content type if no JSON', () => {
    const xmlResponses = {
      '200': {
        description: 'Success',
        content: {
          'application/xml': { schema: { type: 'object' } }
        }
      }
    };

    const result = getResponseSchema(xmlResponses, '200');

    assert.strictEqual(result.contentType, 'application/xml');
  });

  it('should handle response with $ref (unresolved)', () => {
    const refResponses = {
      '200': {
        $ref: '#/components/responses/Success'
      }
    };

    // When not dereferenced, should return null (no content available)
    const result = getResponseSchema(refResponses, '200');
    assert.strictEqual(result, null);
  });
});

// ============================================================
// getRequiredFields Tests
// ============================================================

describe('getRequiredFields', () => {
  it('should return direct required array', () => {
    const schema = {
      type: 'object',
      required: ['id', 'name'],
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' }
      }
    };

    const required = getRequiredFields(schema);

    assert.deepStrictEqual(required, ['id', 'name']);
  });

  it('should handle allOf compositions', () => {
    const schema = {
      allOf: [
        {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } }
        },
        {
          type: 'object',
          required: ['name', 'createdAt'],
          properties: {
            name: { type: 'string' },
            createdAt: { type: 'string' }
          }
        }
      ]
    };

    const required = getRequiredFields(schema);

    assert.ok(required.includes('id'));
    assert.ok(required.includes('name'));
    assert.ok(required.includes('createdAt'));
  });

  it('should deduplicate required fields from allOf', () => {
    const schema = {
      allOf: [
        { type: 'object', required: ['id', 'name'] },
        { type: 'object', required: ['name', 'email'] }
      ]
    };

    const required = getRequiredFields(schema);

    assert.strictEqual(required.length, 3);
    assert.ok(required.includes('id'));
    assert.ok(required.includes('name'));
    assert.ok(required.includes('email'));
  });

  it('should return empty array for schema without required', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'string' }
      }
    };

    const required = getRequiredFields(schema);

    assert.deepStrictEqual(required, []);
  });

  it('should return empty array for null schema', () => {
    const required = getRequiredFields(null);
    assert.deepStrictEqual(required, []);
  });

  it('should return empty array for undefined schema', () => {
    const required = getRequiredFields(undefined);
    assert.deepStrictEqual(required, []);
  });

  it('should handle nested allOf', () => {
    const schema = {
      allOf: [
        {
          allOf: [
            { required: ['a'] },
            { required: ['b'] }
          ]
        },
        { required: ['c'] }
      ]
    };

    const required = getRequiredFields(schema);

    assert.ok(required.includes('a'));
    assert.ok(required.includes('b'));
    assert.ok(required.includes('c'));
  });
});

// ============================================================
// getExample Tests
// ============================================================

describe('getExample', () => {
  it('should return direct example', () => {
    const schema = { type: 'string', example: 'hello world' };
    assert.strictEqual(getExample(schema), 'hello world');
  });

  it('should return first item from examples array', () => {
    const schema = { type: 'string', examples: ['first', 'second'] };
    assert.strictEqual(getExample(schema), 'first');
  });

  it('should prefer example over examples', () => {
    const schema = { type: 'string', example: 'direct', examples: ['array'] };
    assert.strictEqual(getExample(schema), 'direct');
  });

  it('should generate string example', () => {
    const schema = { type: 'string' };
    assert.strictEqual(getExample(schema), 'string');
  });

  it('should generate email format example', () => {
    const schema = { type: 'string', format: 'email' };
    assert.strictEqual(getExample(schema), 'user@example.com');
  });

  it('should generate date-time format example', () => {
    const schema = { type: 'string', format: 'date-time' };
    const example = getExample(schema);
    assert.ok(example.includes('T'));
    assert.ok(example.endsWith('Z') || example.includes('+'));
  });

  it('should generate date format example', () => {
    const schema = { type: 'string', format: 'date' };
    const example = getExample(schema);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(example));
  });

  it('should generate uuid format example', () => {
    const schema = { type: 'string', format: 'uuid' };
    const example = getExample(schema);
    assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(example));
  });

  it('should return first enum value for string with enum', () => {
    const schema = { type: 'string', enum: ['active', 'inactive', 'pending'] };
    assert.strictEqual(getExample(schema), 'active');
  });

  it('should generate integer example', () => {
    const schema = { type: 'integer' };
    assert.strictEqual(getExample(schema), 0);
  });

  it('should use minimum for integer when available', () => {
    const schema = { type: 'integer', minimum: 5 };
    assert.strictEqual(getExample(schema), 5);
  });

  it('should generate number example', () => {
    const schema = { type: 'number' };
    assert.strictEqual(getExample(schema), 0);
  });

  it('should generate boolean example', () => {
    const schema = { type: 'boolean' };
    assert.strictEqual(getExample(schema), true);
  });

  it('should generate array example', () => {
    const schema = {
      type: 'array',
      items: { type: 'string' }
    };
    const example = getExample(schema);
    assert.ok(Array.isArray(example));
    assert.strictEqual(example[0], 'string');
  });

  it('should generate object example from properties', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        active: { type: 'boolean' }
      }
    };

    const example = getExample(schema);

    assert.strictEqual(typeof example, 'object');
    assert.strictEqual(example.id, 0);
    assert.strictEqual(example.name, 'string');
    assert.strictEqual(example.active, true);
  });

  it('should return empty object for object without properties', () => {
    const schema = { type: 'object' };
    const example = getExample(schema);
    assert.deepStrictEqual(example, {});
  });

  it('should return empty array for array without items', () => {
    const schema = { type: 'array' };
    const example = getExample(schema);
    assert.deepStrictEqual(example, []);
  });

  it('should return undefined for null schema', () => {
    assert.strictEqual(getExample(null), undefined);
  });

  it('should return undefined for unknown type', () => {
    const schema = { type: 'unknown' };
    assert.strictEqual(getExample(schema), undefined);
  });
});

// ============================================================
// buildRequestBodyExample Tests
// ============================================================

describe('buildRequestBodyExample', () => {
  it('should return provided example', () => {
    const requestBody = {
      content: {
        'application/json': {
          schema: { type: 'object' },
          example: { name: 'Test', value: 123 }
        }
      }
    };

    const example = buildRequestBodyExample(requestBody);

    assert.deepStrictEqual(example, { name: 'Test', value: 123 });
  });

  it('should generate example from schema when no example provided', () => {
    const requestBody = {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              count: { type: 'integer' }
            }
          }
        }
      }
    };

    const example = buildRequestBodyExample(requestBody);

    assert.strictEqual(example.name, 'string');
    assert.strictEqual(example.count, 0);
  });

  it('should return null for missing request body', () => {
    assert.strictEqual(buildRequestBodyExample(null), null);
    assert.strictEqual(buildRequestBodyExample(undefined), null);
  });

  it('should return null for request body without content', () => {
    assert.strictEqual(buildRequestBodyExample({}), null);
    assert.strictEqual(buildRequestBodyExample({ content: null }), null);
  });

  it('should return null for non-JSON content', () => {
    const requestBody = {
      content: {
        'text/plain': {
          schema: { type: 'string' }
        }
      }
    };

    assert.strictEqual(buildRequestBodyExample(requestBody), null);
  });

  it('should return null for JSON content without schema', () => {
    const requestBody = {
      content: {
        'application/json': {}
      }
    };

    assert.strictEqual(buildRequestBodyExample(requestBody), null);
  });
});

// ============================================================
// convertPathParams Tests
// ============================================================

describe('convertPathParams', () => {
  it('should convert single path parameter', () => {
    assert.strictEqual(convertPathParams('/users/{userId}'), '/users/:userId');
  });

  it('should convert multiple path parameters', () => {
    assert.strictEqual(
      convertPathParams('/users/{userId}/posts/{postId}'),
      '/users/:userId/posts/:postId'
    );
  });

  it('should handle path with no parameters', () => {
    assert.strictEqual(convertPathParams('/users/list'), '/users/list');
  });

  it('should handle root path', () => {
    assert.strictEqual(convertPathParams('/'), '/');
  });

  it('should handle parameter at beginning', () => {
    assert.strictEqual(convertPathParams('/{version}/users'), '/:version/users');
  });

  it('should handle consecutive parameters', () => {
    assert.strictEqual(convertPathParams('/{a}/{b}/{c}'), '/:a/:b/:c');
  });

  it('should preserve dashes and underscores in param names', () => {
    assert.strictEqual(convertPathParams('/items/{item-id}'), '/items/:item-id');
    assert.strictEqual(convertPathParams('/items/{item_id}'), '/items/:item_id');
  });
});

// ============================================================
// getBaseUrl Tests
// ============================================================

describe('getBaseUrl', () => {
  it('should return first server URL', () => {
    const api = {
      servers: [
        { url: 'https://api.example.com/v1', description: 'Production' },
        { url: 'https://staging.example.com/v1', description: 'Staging' }
      ]
    };

    assert.strictEqual(getBaseUrl(api), 'https://api.example.com/v1');
  });

  it('should return default URL when no servers', () => {
    const api = { openapi: '3.0.3', info: { title: 'Test', version: '1.0.0' } };
    assert.strictEqual(getBaseUrl(api), 'https://api.example.com');
  });

  it('should return default URL for empty servers array', () => {
    const api = { servers: [] };
    assert.strictEqual(getBaseUrl(api), 'https://api.example.com');
  });

  it('should handle server URL with variables', () => {
    const api = {
      servers: [
        { url: 'https://{environment}.example.com', description: 'Variable' }
      ]
    };

    assert.strictEqual(getBaseUrl(api), 'https://{environment}.example.com');
  });
});
