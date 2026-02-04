/**
 * Postman Collection Builder Module
 * 
 * Assembles Postman Collection v2.1 JSON structure from parsed endpoints
 * and generated test scripts.
 */

import postmanCollection from 'postman-collection';
const { Collection, Item, ItemGroup, Header, Url, Request, RequestBody, Response } = postmanCollection;
import { generateTests, generatePreRequestScript, generateTestName } from './generator.js';
import { buildRequestBodyExample, convertPathParams, getBaseUrl } from './parser.js';

/**
 * Build a Postman collection from parsed OpenAPI spec
 * @param {Object} api - Parsed OpenAPI spec
 * @param {Array} endpoints - Array of endpoint objects
 * @param {Object} options - Build options
 * @returns {Collection} Postman Collection instance
 */
export function buildCollection(api, endpoints, options = {}) {
  const collectionName = options.collectionName || api.info?.title || 'Generated API Collection';
  const collectionDescription = api.info?.description || 'Collection generated from OpenAPI spec with contract tests';
  
  // Group endpoints by tags
  const groupedEndpoints = groupEndpointsByTag(endpoints);
  
  // Build collection items (folders and requests)
  const items = [];
  
  for (const [tag, tagEndpoints] of Object.entries(groupedEndpoints)) {
    if (tagEndpoints.length === 1 && Object.keys(groupedEndpoints).length === 1) {
      // Single group, flatten to items
      items.push(...tagEndpoints.map(e => buildRequestItem(e, options)));
    } else {
      // Create folder for tag
      const folder = new ItemGroup({
        name: formatTagName(tag),
        description: `Endpoints for ${tag}`,
        item: tagEndpoints.map(e => buildRequestItem(e, options))
      });
      items.push(folder);
    }
  }

  // Create collection
  const collection = new Collection({
    info: {
      name: collectionName,
      description: collectionDescription,
      version: api.info?.version || '1.0.0',
      schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    item: items,
    variable: buildCollectionVariables(api, options),
    auth: buildCollectionAuth(api)
  });

  return collection;
}

/**
 * Build a request item for an endpoint
 * @param {Object} endpoint - Endpoint object
 * @param {Object} options - Build options
 * @returns {Item} Postman Item
 */
function buildRequestItem(endpoint, options) {
  const request = buildRequest(endpoint, options);
  const tests = generateTests(endpoint);
  const preRequest = generatePreRequestScript(endpoint);
  
  const events = [];
  
  // Add pre-request script
  if (preRequest && preRequest.trim()) {
    events.push({
      listen: 'prerequest',
      script: {
        type: 'text/javascript',
        exec: preRequest.split('\n')
      }
    });
  }
  
  // Add test script
  if (tests && tests.trim()) {
    events.push({
      listen: 'test',
      script: {
        type: 'text/javascript',
        exec: tests.split('\n')
      }
    });
  }

  return new Item({
    name: generateTestName(endpoint),
    description: buildRequestDescription(endpoint),
    request: request,
    response: buildExampleResponses(endpoint),
    event: events
  });
}

/**
 * Build request object for an endpoint
 * @param {Object} endpoint - Endpoint object
 * @param {Object} options - Build options
 * @returns {Object} Request configuration
 */
function buildRequest(endpoint, options) {
  const baseUrl = options.baseUrl || '{{baseUrl}}';
  const path = convertPathParams(endpoint.path);
  
  // Build URL
  const url = new Url({
    raw: `${baseUrl}${path}`,
    host: [baseUrl],
    path: path.split('/').filter(p => p),
    variable: buildPathVariables(endpoint),
    query: buildQueryParams(endpoint)
  });

  // Build headers
  const headers = buildHeaders(endpoint);

  // Build request body
  const body = buildRequestBody(endpoint);

  // Build request description
  const description = buildRequestDescription(endpoint);

  return new Request({
    method: endpoint.method,
    url: url,
    header: headers,
    body: body,
    description: description,
    auth: buildRequestAuth(endpoint)
  });
}

/**
 * Build path variables for URL
 * @param {Object} endpoint - Endpoint object
 * @returns {Array} Path variables
 */
function buildPathVariables(endpoint) {
  const pathParams = endpoint.parameters.filter(p => p.in === 'path');
  
  return pathParams.map(param => ({
    key: param.name,
    value: `{{${param.name}}}`,
    description: param.description || `${param.name} path parameter`
  }));
}

/**
 * Build query parameters
 * @param {Object} endpoint - Endpoint object
 * @returns {Array} Query parameters
 */
function buildQueryParams(endpoint) {
  const queryParams = endpoint.parameters.filter(p => p.in === 'query');
  
  return queryParams.map(param => ({
    key: param.name,
    value: param.schema?.default || `{{${param.name}}}`,
    description: param.description || `${param.name} query parameter`,
    disabled: !param.required
  }));
}

/**
 * Build headers for request
 * @param {Object} endpoint - Endpoint object
 * @returns {Array} Headers
 */
function buildHeaders(endpoint) {
  const headers = [];
  
  // Content-Type header for requests with body
  if (['POST', 'PUT', 'PATCH'].includes(endpoint.method) && endpoint.requestBody) {
    const contentTypes = endpoint.requestBody.content ? Object.keys(endpoint.requestBody.content) : [];
    if (contentTypes.length > 0) {
      headers.push(new Header({
        key: 'Content-Type',
        value: contentTypes[0]
      }));
    }
  }
  
  // Accept header based on responses
  const successResponse = endpoint.responses['200'] || endpoint.responses['201'];
  if (successResponse && successResponse.content) {
    const contentTypes = Object.keys(successResponse.content);
    if (contentTypes.length > 0 && !headers.find(h => h.key === 'Accept')) {
      headers.push(new Header({
        key: 'Accept',
        value: contentTypes[0]
      }));
    }
  }
  
  // Header parameters
  const headerParams = endpoint.parameters.filter(p => p.in === 'header');
  for (const param of headerParams) {
    headers.push(new Header({
      key: param.name,
      value: `{{${param.name}}}`,
      description: param.description
    }));
  }
  
  return headers;
}

/**
 * Build request body
 * @param {Object} endpoint - Endpoint object
 * @returns {RequestBody|null} Request body
 */
function buildRequestBody(endpoint) {
  if (!endpoint.requestBody || !endpoint.requestBody.content) {
    return null;
  }

  const contentTypes = Object.keys(endpoint.requestBody.content);
  if (contentTypes.length === 0) {
    return null;
  }

  const contentType = contentTypes[0];
  const content = endpoint.requestBody.content[contentType];
  
  let bodyData = '';
  
  if (content.example) {
    bodyData = JSON.stringify(content.example, null, 2);
  } else if (content.examples && Object.keys(content.examples).length > 0) {
    const firstExample = Object.values(content.examples)[0];
    bodyData = JSON.stringify(firstExample.value || firstExample, null, 2);
  } else if (content.schema) {
    const example = buildRequestBodyExample(endpoint.requestBody);
    if (example) {
      bodyData = JSON.stringify(example, null, 2);
    }
  }

  if (!bodyData) {
    return null;
  }

  return new RequestBody({
    mode: 'raw',
    raw: bodyData,
    options: {
      raw: {
        language: 'json'
      }
    }
  });
}

/**
 * Build request description
 * @param {Object} endpoint - Endpoint object
 * @returns {string} Description
 */
function buildRequestDescription(endpoint) {
  const parts = [];
  
  if (endpoint.description) {
    parts.push(endpoint.description);
  }
  
  // Add parameter documentation
  if (endpoint.parameters.length > 0) {
    parts.push('\n\n**Parameters:**');
    for (const param of endpoint.parameters) {
      const required = param.required ? ' (required)' : '';
      parts.push(`- \`${param.name}\` (${param.in})${required}: ${param.description || 'No description'}`);
    }
  }
  
  // Add response documentation
  const statusCodes = Object.keys(endpoint.responses);
  if (statusCodes.length > 0) {
    parts.push('\n\n**Responses:**');
    for (const code of statusCodes) {
      const response = endpoint.responses[code];
      const description = response.description || 'No description';
      parts.push(`- \`${code}\`: ${description}`);
    }
  }
  
  return parts.join('\n');
}

/**
 * Build example responses for documentation
 * @param {Object} endpoint - Endpoint object
 * @returns {Array} Example responses
 */
function buildExampleResponses(endpoint) {
  const examples = [];
  
  for (const [statusCode, response] of Object.entries(endpoint.responses)) {
    if (!response.content) continue;
    
    for (const [contentType, content] of Object.entries(response.content)) {
      let exampleBody = null;
      
      if (content.example) {
        exampleBody = JSON.stringify(content.example, null, 2);
      } else if (content.examples) {
        const firstExample = Object.values(content.examples)[0];
        exampleBody = JSON.stringify(firstExample.value || firstExample, null, 2);
      }
      
      if (exampleBody) {
        examples.push(new Response({
          name: `${statusCode} Example`,
          code: parseInt(statusCode) || 200,
          status: getStatusText(statusCode),
          header: [{
            key: 'Content-Type',
            value: contentType
          }],
          body: exampleBody
        }));
      }
    }
  }
  
  return examples;
}

/**
 * Build collection-level variables
 * @param {Object} api - Parsed OpenAPI spec
 * @param {Object} options - Build options
 * @returns {Array} Collection variables
 */
function buildCollectionVariables(api, options) {
  const variables = [];
  
  // Base URL
  const baseUrl = options.baseUrl || getBaseUrl(api);
  variables.push({
    key: 'baseUrl',
    value: baseUrl,
    type: 'string',
    description: 'Base URL for API requests'
  });
  
  // Response time threshold
  variables.push({
    key: 'RESPONSE_TIME_THRESHOLD',
    value: '2000',
    type: 'string',
    description: 'Maximum acceptable response time in milliseconds'
  });
  
  // Auth token placeholder
  variables.push({
    key: 'auth_token',
    value: '',
    type: 'string',
    description: 'Authentication token (set via environment or pre-request script)'
  });
  
  return variables;
}

/**
 * Build collection-level authentication
 * @param {Object} api - Parsed OpenAPI spec
 * @returns {Object|null} Auth configuration
 */
function buildCollectionAuth(api) {
  // Check for security schemes
  const securitySchemes = api.components?.securitySchemes || {};
  
  // Prefer API key or Bearer token if defined
  for (const [name, scheme] of Object.entries(securitySchemes)) {
    if (scheme.type === 'http' && scheme.scheme === 'bearer') {
      return {
        type: 'bearer',
        bearer: [
          {
            key: 'token',
            value: '{{auth_token}}',
            type: 'string'
          }
        ]
      };
    }
    
    if (scheme.type === 'apiKey' && scheme.in === 'header') {
      return {
        type: 'apikey',
        apikey: [
          {
            key: 'key',
            value: scheme.name,
            type: 'string'
          },
          {
            key: 'value',
            value: '{{auth_token}}',
            type: 'string'
          },
          {
            key: 'in',
            value: 'header',
            type: 'string'
          }
        ]
      };
    }
  }
  
  return null;
}

/**
 * Build request-level authentication
 * @param {Object} endpoint - Endpoint object
 * @returns {Object|null} Auth configuration
 */
function buildRequestAuth(endpoint) {
  // If endpoint has no security or empty security, it's public
  if (!endpoint.security || endpoint.security.length === 0) {
    return { type: 'noauth' };
  }
  
  // Otherwise, inherit from collection
  return null;
}

/**
 * Group endpoints by their first tag
 * @param {Array} endpoints - Array of endpoint objects
 * @returns {Object} Grouped endpoints
 */
function groupEndpointsByTag(endpoints) {
  const groups = {};
  
  for (const endpoint of endpoints) {
    const tag = endpoint.tags && endpoint.tags.length > 0 ? endpoint.tags[0] : 'default';
    
    if (!groups[tag]) {
      groups[tag] = [];
    }
    groups[tag].push(endpoint);
  }
  
  return groups;
}

/**
 * Format tag name for display
 * @param {string} tag - Tag name
 * @returns {string} Formatted name
 */
function formatTagName(tag) {
  return tag
    .split(/[-_]/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Get HTTP status text from code
 * @param {string} code - Status code
 * @returns {string} Status text
 */
function getStatusText(code) {
  const statusTexts = {
    '200': 'OK',
    '201': 'Created',
    '204': 'No Content',
    '400': 'Bad Request',
    '401': 'Unauthorized',
    '403': 'Forbidden',
    '404': 'Not Found',
    '409': 'Conflict',
    '422': 'Unprocessable Entity',
    '500': 'Internal Server Error'
  };
  
  return statusTexts[code] || 'Unknown';
}

export default {
  buildCollection,
  buildRequestItem
};
