#!/usr/bin/env node

/**
 * Smart Environment Generator
 * 
 * Generates Postman environments from OpenAPI spec.
 * Creates ONE environment per server (dev, staging, prod)
 * Each environment has its own baseUrl, auth, and test data.
 */

import { extractEndpoints } from './parser.js';

/**
 * Generate environment for a specific server
 * @param {Object} api - Parsed OpenAPI spec
 * @param {Object} server - Server object { url, description }
 * @returns {Object} Postman environment object
 */
export function generateEnvironmentForServer(api, server) {
  const values = [];
  
  // 1. Base URL for this environment
  values.push({
    key: 'baseUrl',
    value: server.url,
    type: 'default',
    enabled: true
  });
  
  // 2. Path parameters
  const pathParamVars = generatePathParameterVariables(api);
  values.push(...pathParamVars);
  
  // 3. Query parameters with defaults
  const queryParamVars = generateQueryParameterVariables(api);
  values.push(...queryParamVars);
  
  // 4. Security/auth variables (per environment)
  const authVars = generateAuthVariables(api);
  values.push(...authVars);
  
  // 5. Test configuration
  values.push({
    key: 'RESPONSE_TIME_THRESHOLD',
    value: '2000',
    type: 'default',
    enabled: true
  });
  
  const envName = generateEnvironmentName(api.info?.title || 'API', server.description);
  
  return {
    name: envName,
    values: values,
    _postman_variable_scope: 'environment'
  };
}

/**
 * Generate environment name from API title and server description
 */
function generateEnvironmentName(apiTitle, serverDescription) {
  const cleanTitle = apiTitle.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
  const cleanDesc = (serverDescription || 'Default')
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim();
  return `${cleanTitle} - ${cleanDesc}`;
}

/**
 * Generate path parameter variables
 * Extracts {param} from paths and creates example values
 */
function generatePathParameterVariables(api) {
  const values = [];
  const endpoints = extractEndpoints(api);
  const seenParams = new Set();
  
  for (const endpoint of endpoints) {
    const pathParams = endpoint.path.match(/\{([^}]+)\}/g) || [];
    
    for (const param of pathParams) {
      const paramName = param.replace(/[{}]/g, '');
      
      if (seenParams.has(paramName)) continue;
      seenParams.add(paramName);
      
      // Find parameter schema for examples/defaults
      const paramSchema = endpoint.parameters?.find(p => p.name === paramName && p.in === 'path')?.schema;
      const exampleValue = generateExampleValue(paramName, paramSchema);
      
      values.push({
        key: paramName,
        value: exampleValue,
        type: 'default',
        enabled: true
      });
    }
  }
  
  return values;
}

/**
 * Generate query parameter variables with defaults
 */
function generateQueryParameterVariables(api) {
  const values = [];
  const endpoints = extractEndpoints(api);
  const seenParams = new Set();
  
  for (const endpoint of endpoints) {
    const queryParams = endpoint.parameters?.filter(p => p.in === 'query') || [];
    
    for (const param of queryParams) {
      if (seenParams.has(param.name)) continue;
      seenParams.add(param.name);
      
      const defaultValue = getParameterDefault(param);
      
      values.push({
        key: param.name,
        value: defaultValue,
        type: 'default',
        enabled: false  // Disabled by default, enable as needed
      });
    }
  }
  
  return values;
}

/**
 * Generate authentication variables from security schemes
 * Variable names must match what collections expect (e.g., bearerToken for Bearer auth)
 */
function generateAuthVariables(api) {
  const values = [];
  const securitySchemes = api.components?.securitySchemes || {};

  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      // Use 'bearerToken' to match collection expectation
      values.push({
        key: 'bearerToken',
        value: '',
        type: 'secret',
        enabled: true
      });
    } else if (scheme.type === 'apiKey') {
      values.push({
        key: `api_key_${scheme.name || name}`,
        value: '',
        type: 'secret',
        enabled: true
      });
    } else if (scheme.type === 'oauth2') {
      values.push(
        { key: 'client_id', value: '', type: 'secret', enabled: true },
        { key: 'client_secret', value: '', type: 'secret', enabled: true },
        { key: 'access_token', value: '', type: 'secret', enabled: true }
      );
    } else if (scheme.type === 'http' && scheme.scheme === 'basic') {
      values.push(
        { key: 'username', value: '', type: 'secret', enabled: true },
        { key: 'password', value: '', type: 'secret', enabled: true }
      );
    }
  }

  // If no security schemes, add generic bearerToken for consistency
  if (values.length === 0) {
    values.push({
      key: 'bearerToken',
      value: '',
      type: 'secret',
      enabled: true
    });
  }

  return values;
}

/**
 * Generate example value for a parameter
 */
function generateExampleValue(paramName, schema) {
  if (!schema) {
    // Generate based on param name patterns
    if (paramName.includes('id')) return `example-${paramName}-001`;
    if (paramName.includes('email')) return 'user@example.com';
    if (paramName.includes('name')) return 'Example Name';
    return `example-${paramName}`;
  }
  
  // Use schema info
  if (schema.example) return String(schema.example);
  if (schema.examples?.length > 0) return String(schema.examples[0]);
  
  // Type-based defaults
  switch (schema.type) {
    case 'string':
      if (schema.enum?.length > 0) return schema.enum[0];
      if (paramName.includes('id')) return `example-${paramName}-001`;
      if (paramName.includes('email')) return 'user@example.com';
      if (schema.format === 'uuid') return '550e8400-e29b-41d4-a716-446655440000';
      if (schema.format === 'date-time') return new Date().toISOString();
      return 'example-string';
    case 'integer':
    case 'number':
      return String(schema.minimum || schema.default || 1);
    case 'boolean':
      return 'true';
    default:
      return `example-${paramName}`;
  }
}

/**
 * Get default value for a query parameter
 */
function getParameterDefault(param) {
  const schema = param.schema;
  
  if (schema?.default !== undefined) {
    return String(schema.default);
  }
  
  if (schema?.example !== undefined) {
    return String(schema.example);
  }
  
  if (schema?.enum?.length > 0) {
    return schema.enum[0];
  }
  
  // Type-based defaults
  switch (schema?.type) {
    case 'string':
      if (param.name === 'limit') return '20';
      if (param.name === 'offset') return '0';
      if (param.name === 'status') return 'pending';
      return '';
    case 'integer':
    case 'number':
      return '0';
    case 'boolean':
      return 'false';
    default:
      return '';
  }
}

export default {
  generateEnvironmentForServer
};
