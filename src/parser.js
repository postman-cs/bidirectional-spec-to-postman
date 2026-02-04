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
 * Parse an OpenAPI spec from file path or URL
 * @param {string} specPath - Path to spec file or URL
 * @returns {Promise<Object>} Parsed and dereferenced OpenAPI spec
 */
export async function parseSpec(specPath) {
  try {
    // Parse and dereference the spec (resolves $refs)
    const api = await SwaggerParser.dereference(specPath);
    return api;
  } catch (error) {
    throw new Error(`Failed to parse OpenAPI spec: ${error.message}`);
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
  getBaseUrl
};
