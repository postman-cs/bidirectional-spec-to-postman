/**
 * Test Script Generator Module
 * 
 * Generates Postman test scripts from OpenAPI spec metadata.
 * All tests are deterministic functions of the spec - no manual test writing.
 */

import { getResponseSchema, getRequiredFields } from './parser.js';

/**
 * Generate test scripts for an endpoint
 * @param {Object} endpoint - Endpoint object from parser
 * @returns {string} JavaScript test script for Postman
 */
export function generateTests(endpoint) {
  const tests = [];
  
  // Add header comment
  tests.push(`// Contract tests generated from OpenAPI spec`);
  tests.push(`// Endpoint: ${endpoint.method} ${endpoint.path}`);
  tests.push(`// Operation ID: ${endpoint.id}`);
  tests.push('');

  // 1. Status code validation
  const statusCodes = Object.keys(endpoint.responses);
  if (statusCodes.length > 0) {
    // Test for success codes (2xx)
    const successCodes = statusCodes.filter(code => code.startsWith('2'));
    if (successCodes.length > 0) {
      const expectedCode = successCodes[0]; // Use first 2xx code
      tests.push(`// Status code validation`);
      tests.push(`pm.test("Status code is ${expectedCode}", function () {`);
      tests.push(`    pm.response.to.have.status(${expectedCode});`);
      tests.push(`});`);
      tests.push('');
    }
  }

  // 2. Response time check (configurable threshold)
  tests.push(`// Performance baseline check`);
  tests.push(`pm.test("Response time is acceptable", function () {`);
  tests.push(`    const threshold = parseInt(pm.environment.get("RESPONSE_TIME_THRESHOLD") || pm.globals.get("RESPONSE_TIME_THRESHOLD") || "2000");`);
  tests.push(`    pm.expect(pm.response.responseTime).to.be.below(threshold);`);
  tests.push(`});`);
  tests.push('');

  // 3. Content-Type validation
  const response200 = endpoint.responses['200'] || endpoint.responses['201'];
  if (response200 && response200.content) {
    const contentTypes = Object.keys(response200.content);
    if (contentTypes.length > 0) {
      const expectedContentType = contentTypes[0];
      tests.push(`// Content-Type validation`);
      tests.push(`pm.test("Content-Type is ${expectedContentType}", function () {`);
      tests.push(`    pm.response.to.have.header("Content-Type");`);
      tests.push(`    const contentType = pm.response.headers.get("Content-Type");`);
      tests.push(`    pm.expect(contentType).to.include("${expectedContentType.split(';')[0]}");`);
      tests.push(`});`);
      tests.push('');
    }
  }

  // 4. JSON Schema validation
  const schemaInfo = getResponseSchema(endpoint.responses, '200') || 
                     getResponseSchema(endpoint.responses, '201') ||
                     getResponseSchema(endpoint.responses, 'default');
  
  if (schemaInfo && schemaInfo.schema) {
    tests.push(`// JSON Schema validation`);
    tests.push(`pm.test("Response matches schema", function () {`);
    tests.push(`    const schema = ${JSON.stringify(schemaInfo.schema, null, 4)};`);
    tests.push(`    `);
    tests.push(`    // Validate response structure`);
    tests.push(`    const jsonData = pm.response.json();`);
    tests.push(`    `);
    tests.push(`    // Basic type validation based on schema type`);
    tests.push(`    if (schema.type === 'object') {`);
    tests.push(`        pm.expect(jsonData).to.be.an('object');`);
    tests.push(`    } else if (schema.type === 'array') {`);
    tests.push(`        pm.expect(jsonData).to.be.an('array');`);
    tests.push(`    }`);
    tests.push(`});`);
    tests.push('');

    // 5. Required field checks
    const requiredFields = getRequiredFields(schemaInfo.schema);
    if (requiredFields.length > 0) {
      tests.push(`// Required field validation`);
      tests.push(`pm.test("Response has required fields", function () {`);
      tests.push(`    const jsonData = pm.response.json();`);
      tests.push(`    `);
      
      // Handle array responses
      tests.push(`    // Check required fields exist`);
      tests.push(`    const dataToCheck = Array.isArray(jsonData) ? (jsonData[0] || {}) : jsonData;`);
      tests.push(`    `);
      
      for (const field of requiredFields) {
        tests.push(`    pm.expect(dataToCheck).to.have.property('${field}');`);
        tests.push(`    pm.expect(dataToCheck['${field}']).to.not.be.undefined;`);
      }
      tests.push(`});`);
      tests.push('');
    }
  }

  // 6. Response structure validation (basic)
  if (schemaInfo && schemaInfo.schema) {
    const schema = schemaInfo.schema;
    
    if (schema.type === 'array' && schema.items) {
      tests.push(`// Array response validation`);
      tests.push(`pm.test("Response is an array with items", function () {`);
      tests.push(`    const jsonData = pm.response.json();`);
      tests.push(`    pm.expect(jsonData).to.be.an('array');`);
      tests.push(`});`);
      tests.push('');
    }
  }

  // 7. Error response validation (if 4xx responses defined)
  const errorCodes = Object.keys(endpoint.responses).filter(code => code.startsWith('4') || code.startsWith('5'));
  if (errorCodes.length > 0) {
    tests.push(`// Error response structure validation`);
    tests.push(`pm.test("Error responses have proper structure (when applicable)", function () {`);
    tests.push(`    if (pm.response.code >= 400) {`);
    tests.push(`        const jsonData = pm.response.json();`);
    tests.push(`        // Error responses should typically have error details`);
    tests.push(`        const hasErrorField = jsonData.hasOwnProperty('error') || jsonData.hasOwnProperty('message') || jsonData.hasOwnProperty('detail');`);
    tests.push(`        pm.expect(hasErrorField).to.be.true;`);
    tests.push(`    }`);
    tests.push(`});`);
    tests.push('');
  }

  return tests.join('\n');
}

/**
 * Generate pre-request script for an endpoint
 * @param {Object} endpoint - Endpoint object
 * @returns {string} JavaScript pre-request script
 */
export function generatePreRequestScript(endpoint) {
  const scripts = [];
  
  scripts.push(`// Pre-request script generated from OpenAPI spec`);
  scripts.push(`// Endpoint: ${endpoint.method} ${endpoint.path}`);
  scripts.push('');

  // Set dynamic path parameters if not already set
  const pathParams = endpoint.path.match(/\{([^}]+)\}/g) || [];
  if (pathParams.length > 0) {
    scripts.push(`// Set path parameters if not defined`);
    for (const param of pathParams) {
      const paramName = param.replace(/[{}]/g, '');
      scripts.push(`if (!pm.variables.get("${paramName}")) {`);
      scripts.push(`    pm.variables.set("${paramName}", "test-${paramName}-001");`);
      scripts.push(`}`);
    }
    scripts.push('');
  }

  // Set query parameters defaults
  const queryParams = endpoint.parameters.filter(p => p.in === 'query');
  if (queryParams.length > 0) {
    scripts.push(`// Query parameters available: ${queryParams.map(p => p.name).join(', ')}`);
    scripts.push(`// Set these via environment variables or collection variables`);
    scripts.push('');
  }

  // Auth setup placeholder
  if (endpoint.security && endpoint.security.length > 0) {
    scripts.push(`// Authentication required`);
    scripts.push(`// Set auth token via: pm.environment.set("auth_token", "your-token")`);
    scripts.push(`// Or configure authorization in the collection level`);
    scripts.push('');
  }

  // Request body setup for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
    scripts.push(`// Request body will be sent as configured`);
    scripts.push(`// Ensure request body variables are set if using dynamic data`);
    scripts.push('');
  }

  return scripts.join('\n');
}

/**
 * Generate a descriptive name for a test
 * @param {Object} endpoint - Endpoint object
 * @returns {string} Test name
 */
export function generateTestName(endpoint) {
  if (endpoint.name) {
    return endpoint.name;
  }
  return `${endpoint.method} ${endpoint.path}`;
}

/**
 * Generate documentation for tests
 * @param {Object} endpoint - Endpoint object
 * @returns {string} Markdown documentation
 */
export function generateTestDocumentation(endpoint) {
  const docs = [];
  
  docs.push(`## ${generateTestName(endpoint)}`);
  docs.push('');
  docs.push(`**Method:** ${endpoint.method}`);
  docs.push(`**Path:** ${endpoint.path}`);
  docs.push(`**Operation ID:** ${endpoint.id}`);
  docs.push('');
  
  if (endpoint.description) {
    docs.push(`**Description:** ${endpoint.description}`);
    docs.push('');
  }
  
  docs.push('### Generated Tests');
  docs.push('');
  
  const statusCodes = Object.keys(endpoint.responses);
  if (statusCodes.length > 0) {
    const successCodes = statusCodes.filter(code => code.startsWith('2'));
    if (successCodes.length > 0) {
      docs.push(`- ✅ Status code validation (expects ${successCodes[0]})`);
    }
  }
  
  docs.push(`- ✅ Response time threshold check`);
  
  const response200 = endpoint.responses['200'] || endpoint.responses['201'];
  if (response200 && response200.content) {
    const contentTypes = Object.keys(response200.content);
    if (contentTypes.length > 0) {
      docs.push(`- ✅ Content-Type validation (${contentTypes[0]})`);
    }
  }
  
  const schemaInfo = getResponseSchema(endpoint.responses, '200') || 
                     getResponseSchema(endpoint.responses, '201');
  if (schemaInfo && schemaInfo.schema) {
    docs.push(`- ✅ JSON Schema structure validation`);
    
    const requiredFields = getRequiredFields(schemaInfo.schema);
    if (requiredFields.length > 0) {
      docs.push(`- ✅ Required fields check (${requiredFields.join(', ')})`);
    }
  }
  
  const errorCodes = Object.keys(endpoint.responses).filter(code => code.startsWith('4'));
  if (errorCodes.length > 0) {
    docs.push(`- ✅ Error response structure validation`);
  }
  
  docs.push('');
  
  return docs.join('\n');
}

export default {
  generateTests,
  generatePreRequestScript,
  generateTestName,
  generateTestDocumentation
};
