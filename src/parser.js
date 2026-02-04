/**
 * OpenAPI Parser Module
 *
 * Parses OpenAPI 3.0/3.1 specifications and extracts endpoints, schemas,
 * and metadata needed for test generation.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import YAML from 'yaml';
import fs from 'fs';
import path from 'path';

/**
 * Custom error class for parsing errors
 */
export class ParserError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ParserError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Error codes for parser errors
 */
export const ParserErrorCode = {
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  FILE_NOT_READABLE: 'FILE_NOT_READABLE',
  INVALID_YAML: 'INVALID_YAML',
  INVALID_JSON: 'INVALID_JSON',
  MISSING_OPENAPI_VERSION: 'MISSING_OPENAPI_VERSION',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  MISSING_INFO: 'MISSING_INFO',
  MISSING_PATHS: 'MISSING_PATHS',
  INVALID_REF: 'INVALID_REF',
  CIRCULAR_REF: 'CIRCULAR_REF',
  PARSE_ERROR: 'PARSE_ERROR'
};

/**
 * Supported OpenAPI versions (3.0.x and 3.1.x)
 */
const SUPPORTED_VERSIONS = /^3\.(0|1)\.\d+$/;

/**
 * Validate that a spec file exists and is readable
 * @param {string} specPath - Path to spec file
 * @throws {ParserError} If file doesn't exist or isn't readable
 */
function validateFileExists(specPath) {
  // Skip validation for URLs
  if (specPath.startsWith('http://') || specPath.startsWith('https://')) {
    return;
  }

  const absolutePath = path.isAbsolute(specPath) ? specPath : path.resolve(process.cwd(), specPath);
  const normalizedPath = path.normalize(absolutePath);

  // Check if file exists first (for better error messages)
  if (!fs.existsSync(normalizedPath)) {
    throw new ParserError(
      `Spec file not found: ${specPath}`,
      ParserErrorCode.FILE_NOT_FOUND,
      { path: normalizedPath }
    );
  }

  // Path traversal protection: ensure path is within allowed directories
  const allowedRoots = [
    process.cwd(),
    path.resolve(process.cwd(), '..'), // Allow parent for monorepos
  ];

  const isAllowed = allowedRoots.some(root =>
    normalizedPath.startsWith(path.normalize(root) + path.sep) ||
    normalizedPath === path.normalize(root)
  );

  if (!isAllowed) {
    throw new ParserError(
      `Path traversal detected: ${specPath} resolves outside allowed directories`,
      ParserErrorCode.FILE_NOT_READABLE,
      { path: normalizedPath }
    );
  }

  try {
    fs.accessSync(normalizedPath, fs.constants.R_OK);
  } catch (error) {
    throw new ParserError(
      `Spec file not readable: ${specPath}`,
      ParserErrorCode.FILE_NOT_READABLE,
      { path: normalizedPath, cause: error.message }
    );
  }
}

/**
 * Validate OpenAPI version compatibility
 * @param {Object} api - Parsed OpenAPI spec
 * @throws {ParserError} If version is missing or unsupported
 */
function validateOpenApiVersion(api) {
  if (!api.openapi) {
    throw new ParserError(
      'Missing OpenAPI version. Spec must include "openapi" field (e.g., "3.0.3" or "3.1.0")',
      ParserErrorCode.MISSING_OPENAPI_VERSION
    );
  }

  if (!SUPPORTED_VERSIONS.test(api.openapi)) {
    throw new ParserError(
      `Unsupported OpenAPI version: ${api.openapi}. Supported versions: 3.0.x and 3.1.x`,
      ParserErrorCode.UNSUPPORTED_VERSION,
      { version: api.openapi, supported: ['3.0.x', '3.1.x'] }
    );
  }
}

/**
 * Validate required OpenAPI fields
 * @param {Object} api - Parsed OpenAPI spec
 * @throws {ParserError} If required fields are missing
 */
function validateRequiredFields(api) {
  if (!api.info) {
    throw new ParserError(
      'Missing required "info" object. OpenAPI spec must include info with title and version.',
      ParserErrorCode.MISSING_INFO
    );
  }

  if (!api.info.title) {
    throw new ParserError(
      'Missing required "info.title" field.',
      ParserErrorCode.MISSING_INFO,
      { field: 'info.title' }
    );
  }

  if (!api.info.version) {
    throw new ParserError(
      'Missing required "info.version" field.',
      ParserErrorCode.MISSING_INFO,
      { field: 'info.version' }
    );
  }

  // Paths is optional but warn if missing
  if (!api.paths || Object.keys(api.paths).length === 0) {
    // Not an error, just means no endpoints
  }
}

/**
 * Parse error message to provide more helpful information
 * @param {Error} error - Original error
 * @param {string} specPath - Path to spec file
 * @returns {ParserError} Formatted parser error
 */
function formatParseError(error, specPath) {
  const message = error.message || '';

  // YAML syntax errors
  if (message.includes('YAMLException') || message.includes('YAML')) {
    return new ParserError(
      `YAML syntax error in ${specPath}: ${message}`,
      ParserErrorCode.INVALID_YAML,
      { cause: message }
    );
  }

  // JSON syntax errors
  if (message.includes('JSON') || message.includes('Unexpected token')) {
    return new ParserError(
      `JSON syntax error in ${specPath}: ${message}`,
      ParserErrorCode.INVALID_JSON,
      { cause: message }
    );
  }

  // Missing $ref targets
  if (message.includes('$ref') || message.includes('reference')) {
    return new ParserError(
      `Invalid reference in ${specPath}: ${message}. Check that all $ref targets exist.`,
      ParserErrorCode.INVALID_REF,
      { cause: message }
    );
  }

  // Circular reference
  if (message.includes('circular') || message.includes('Circular')) {
    return new ParserError(
      `Circular reference detected in ${specPath}: ${message}`,
      ParserErrorCode.CIRCULAR_REF,
      { cause: message }
    );
  }

  return new ParserError(
    `Failed to parse OpenAPI spec ${specPath}: ${message}`,
    ParserErrorCode.PARSE_ERROR,
    { cause: message }
  );
}

/**
 * Parse an OpenAPI spec from file path or URL
 * @param {string} specPath - Path to spec file or URL
 * @param {Object} options - Parsing options
 * @param {number} options.timeout - Timeout for parsing (default: 30000ms)
 * @param {boolean} options.validate - Whether to validate the spec (default: true)
 * @returns {Promise<Object>} Parsed and dereferenced OpenAPI spec
 */
export async function parseSpec(specPath, options = {}) {
  const { timeout = 30000, validate = true } = options;

  // Validate file exists (for local files)
  validateFileExists(specPath);

  try {
    // Parse and dereference the spec (resolves $refs)
    // SwaggerParser handles circular references gracefully
    const api = await SwaggerParser.dereference(specPath, {
      dereference: {
        circular: 'ignore' // Handle circular refs by keeping them as-is
      }
    });

    // Validate OpenAPI structure
    if (validate) {
      validateOpenApiVersion(api);
      validateRequiredFields(api);
    }

    return api;
  } catch (error) {
    // If it's already a ParserError, re-throw
    if (error instanceof ParserError) {
      throw error;
    }

    // Format and throw appropriate error
    throw formatParseError(error, specPath);
  }
}

/**
 * Extract endpoints from parsed OpenAPI spec
 * @param {Object} api - Parsed OpenAPI spec
 * @returns {Array} Array of endpoint objects
 */
export function extractEndpoints(api) {
  const endpoints = [];
  const paths = api.paths || {};

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    // Skip parameters at path level for now
    const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    
    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation) continue;

      const endpoint = {
        id: operation.operationId || `${method}_${pathStr.replace(/[^a-zA-Z0-9]/g, '_')}`,
        name: operation.summary || operation.operationId || `${method.toUpperCase()} ${pathStr}`,
        description: operation.description || '',
        method: method.toUpperCase(),
        path: pathStr,
        tags: operation.tags || ['default'],
        parameters: [...(pathItem.parameters || []), ...(operation.parameters || [])],
        requestBody: operation.requestBody,
        responses: operation.responses || {},
        security: operation.security || api.security || [],
        // Store raw operation for advanced use cases
        raw: operation
      };

      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

/**
 * Extract response schema for a specific status code
 * @param {Object} responses - Responses object from OpenAPI
 * @param {string} statusCode - HTTP status code
 * @returns {Object|null} Schema object or null
 */
export function getResponseSchema(responses, statusCode = '200') {
  const response = responses[statusCode] || responses.default;
  if (!response) return null;

  // Handle $ref if not dereferenced
  const resolvedResponse = response.$ref ? {} : response;
  
  const content = resolvedResponse.content || response.content;
  if (!content) return null;

  // Prefer application/json
  const jsonContent = content['application/json'];
  if (jsonContent && jsonContent.schema) {
    return {
      schema: jsonContent.schema,
      contentType: 'application/json'
    };
  }

  // Fall back to first content type
  const firstContentType = Object.keys(content)[0];
  if (firstContentType && content[firstContentType].schema) {
    return {
      schema: content[firstContentType].schema,
      contentType: firstContentType
    };
  }

  return null;
}

/**
 * Extract required fields from a schema
 * @param {Object} schema - JSON Schema object
 * @returns {Array} Array of required field names
 */
export function getRequiredFields(schema) {
  if (!schema) return [];
  
  // Direct required array
  if (schema.required && Array.isArray(schema.required)) {
    return schema.required;
  }

  // Handle allOf compositions
  if (schema.allOf && Array.isArray(schema.allOf)) {
    const required = [];
    for (const subSchema of schema.allOf) {
      required.push(...getRequiredFields(subSchema));
    }
    return [...new Set(required)]; // Deduplicate
  }

  return [];
}

/**
 * Get example value for a schema
 * @param {Object} schema - JSON Schema object
 * @returns {*} Example value or undefined
 */
export function getExample(schema) {
  if (!schema) return undefined;
  
  // Direct example
  if (schema.example !== undefined) {
    return schema.example;
  }

  // Examples array
  if (schema.examples && Array.isArray(schema.examples) && schema.examples.length > 0) {
    return schema.examples[0];
  }

  // Generate simple example based on type
  switch (schema.type) {
    case 'string':
      if (schema.enum && schema.enum.length > 0) {
        return schema.enum[0];
      }
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'date') return new Date().toISOString().split('T')[0];
      if (schema.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
      return 'string';
    case 'integer':
    case 'number':
      return schema.minimum || 0;
    case 'boolean':
      return true;
    case 'array':
      return schema.items ? [getExample(schema.items)] : [];
    case 'object':
      if (schema.properties) {
        const example = {};
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          example[key] = getExample(propSchema);
        }
        return example;
      }
      return {};
    default:
      return undefined;
  }
}

/**
 * Build a request body example from schema
 * @param {Object} requestBody - OpenAPI request body object
 * @returns {Object|null} Example body or null
 */
export function buildRequestBodyExample(requestBody) {
  if (!requestBody || !requestBody.content) return null;

  const jsonContent = requestBody.content['application/json'];
  if (!jsonContent || !jsonContent.schema) return null;

  // Use provided example if available
  if (jsonContent.example) {
    return jsonContent.example;
  }

  // Generate from schema
  return getExample(jsonContent.schema);
}

/**
 * Convert path parameters to Postman format
 * @param {string} path - URL path with {param} syntax
 * @returns {string} Path with :param syntax
 */
export function convertPathParams(path) {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * Extract server/base URL from spec
 * @param {Object} api - Parsed OpenAPI spec
 * @returns {string} Base URL
 */
export function getBaseUrl(api) {
  if (api.servers && api.servers.length > 0) {
    return api.servers[0].url;
  }
  return 'https://api.example.com';
}

export default {
  parseSpec,
  extractEndpoints,
  getResponseSchema,
  getRequiredFields,
  getExample,
  buildRequestBodyExample,
  convertPathParams,
  getBaseUrl,
  ParserError,
  ParserErrorCode
};
