#!/usr/bin/env node

/**
 * Spec Hub Client
 *
 * Handles all interactions with Postman Spec Hub API.
 * Uses native fetch with Postman API key authentication.
 */

import fs from 'fs';
import vm from 'vm';
import { createLogger } from './logger.js';

const POSTMAN_API_BASE = 'https://api.getpostman.com';
const DEFAULT_TIMEOUT = 30000; // 30 seconds
const DEFAULT_MAX_RPM = 250; // Conservative buffer below Postman's 300 RPM limit

// Create logger instance
const logger = createLogger({ name: 'spec-hub-client' });

/**
 * Token bucket rate limiter for Postman API
 * Ensures we stay under the 300 RPM limit
 */
class RateLimiter {
  constructor(rpm = DEFAULT_MAX_RPM) {
    this.tokens = rpm;
    this.lastRefill = Date.now();
    this.rpm = rpm;
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 60000; // minutes
    this.tokens = Math.min(this.rpm, this.tokens + elapsed * this.rpm);
    this.lastRefill = now;
  }

  async acquire() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    const waitMs = (60000 / this.rpm) * (1 - this.tokens);
    await new Promise(resolve => setTimeout(resolve, waitMs));
    return this.acquire();
  }
}

/**
 * Custom error classes for different failure types
 */
export class NetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

export class AuthenticationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class RateLimitError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class NotFoundError extends Error {
  constructor(message, resource) {
    super(message);
    this.name = 'NotFoundError';
    this.resource = resource;
  }
}

class SpecHubClient {
  constructor(apiKey, workspaceId, options = {}) {
    this.apiKey = apiKey;
    this.workspaceId = workspaceId;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000; // Base delay in ms
    this.maxRetryDelay = options.maxRetryDelay || 30000; // Max delay in ms
    this.rateLimiter = new RateLimiter(options.maxRpm || DEFAULT_MAX_RPM);
  }

  /**
   * Calculate retry delay with exponential backoff and jitter
   * @param {number} attempt - Current attempt number (0-indexed)
   * @param {number} retryAfter - Optional Retry-After header value in seconds
   * @returns {number} Delay in milliseconds
   */
  calculateRetryDelay(attempt, retryAfter = null) {
    // If server provided Retry-After, use it (with small buffer)
    if (retryAfter) {
      return Math.min(retryAfter * 1000 + 100, this.maxRetryDelay);
    }
    
    // Exponential backoff: 1s, 2s, 4s, 8s...
    const exponentialDelay = this.retryDelay * Math.pow(2, attempt);
    
    // Add jitter (±25%) to prevent thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
    
    return Math.min(exponentialDelay + jitter, this.maxRetryDelay);
  }

  /**
   * Execute request with retry logic for transient failures
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {object|null} body - Request body
   * @param {object} options - Additional options
   */
  async requestWithRetry(method, endpoint, body = null, options = {}) {
    let lastError;
    
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.request(method, endpoint, body, options);
      } catch (error) {
        lastError = error;
        
        // Don't retry on 4xx errors (client errors)
        if (error instanceof AuthenticationError ||
            (error.message && error.message.match(/API Error 4\d{2}/))) {
          throw error;
        }
        
        // Check if this is the last attempt
        if (attempt >= this.maxRetries) {
          break;
        }
        
        // Get Retry-After header if available
        const retryAfter = error.retryAfter || null;
        
        // Calculate delay
        const delay = this.calculateRetryDelay(attempt, retryAfter);
        
        logger.warn(`Request failed, retrying... (${attempt + 1}/${this.maxRetries})`, {
          endpoint,
          error: error.message,
          delay: Math.round(delay)
        });
        
        await this.sleep(delay);
      }
    }
    
    throw lastError;
  }

  /**
   * Make authenticated API request with timeout and error handling
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {object|null} body - Request body
   * @param {object} options - Additional options (timeout)
   */
  async request(method, endpoint, body = null, options = {}) {
    // Acquire rate limit token before making request
    await this.rateLimiter.acquire();

    const url = `${POSTMAN_API_BASE}${endpoint}`;
    const timeout = options.timeout || this.timeout;

    // Create AbortController for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    const fetchOptions = {
      method,
      headers: {
        'X-Api-Key': this.apiKey,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    };

    if (body) {
      fetchOptions.body = JSON.stringify(body);
    }

    try {
      logger.debug(`API request: ${method} ${endpoint}`);
      const response = await fetch(url, fetchOptions);
      clearTimeout(timeoutId);

      let data;
      const contentType = response.headers.get('content-type') || '';
      
      // Handle empty responses (204 No Content)
      if (response.status === 204) {
        return null;
      }
      
      // Only parse JSON if content-type indicates JSON
      if (contentType.includes('application/json')) {
        try {
          data = await response.json();
        } catch (parseError) {
          data = { error: 'Failed to parse JSON response', raw: await response.text() };
        }
      } else {
        // For non-JSON responses, return text or empty object
        const text = await response.text();
        data = text ? { raw: text } : {};
      }

      if (!response.ok) {
        // Handle specific error types
        if (response.status === 401) {
          throw new AuthenticationError(`Authentication failed for ${endpoint}. Check your API key.`);
        }
        if (response.status === 404) {
          throw new NotFoundError(`Resource not found: ${endpoint}`, endpoint);
        }
        if (response.status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          throw new RateLimitError(`Rate limit exceeded for ${endpoint}`, retryAfter);
        }

        const errorMessage = data.error?.message || data.error || JSON.stringify(data);
        throw new Error(`API Error ${response.status} on ${method} ${endpoint}: ${errorMessage}`);
      }

      return data;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error.name === 'AbortError') {
        throw new NetworkError(`Request timeout after ${timeout}ms: ${method} ${endpoint}`, error);
      }

      if (error instanceof NetworkError ||
          error instanceof AuthenticationError ||
          error instanceof RateLimitError ||
          error instanceof NotFoundError) {
        throw error;
      }

      // Network errors
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        throw new NetworkError(`Network error: ${error.message}`, error);
      }

      throw error;
    }
  }

  /**
   * Detect OpenAPI version from spec content
   * @param {string|object} specContent - OpenAPI spec content
   * @returns {string} Version string like '3.0', '3.1', '2.0' or 'unknown'
   */
  detectOpenApiVersion(specContent) {
    try {
      const spec = typeof specContent === 'string' ? JSON.parse(specContent) : specContent;
      
      // Check for OpenAPI 3.x
      if (spec.openapi) {
        const version = spec.openapi.startsWith('3.1') ? '3.1' : 
                       spec.openapi.startsWith('3.0') ? '3.0' : '3.0';
        return version;
      }
      
      // Check for Swagger 2.0
      if (spec.swagger && spec.swagger.startsWith('2.0')) {
        return '2.0';
      }
      
      return '3.0'; // Default to 3.0
    } catch {
      return '3.0'; // Default to 3.0 on parse error
    }
  }

  /**
   * Detect if spec is YAML format
   * @param {string} specContent - Raw spec content
   * @returns {boolean} True if YAML format
   */
  detectYamlFormat(specContent) {
    if (typeof specContent !== 'string') return false;
    
    // Check for YAML indicators (not JSON)
    const trimmed = specContent.trim();
    
    // If it starts with { or [, it's JSON
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return false;
    }
    
    // Check for YAML-specific patterns
    const yamlIndicators = [
      /^openapi:\s/m,
      /^swagger:\s/m,
      /^info:\s/m,
      /^paths:\s/m,
      /^---\s*$/m
    ];
    
    return yamlIndicators.some(pattern => pattern.test(trimmed));
  }

  /**
   * Upload or update spec in Spec Hub
   * Properly detects OpenAPI version and format
   */
  async uploadSpec(name, specContent, specId = null) {
    const version = this.detectOpenApiVersion(specContent);
    const isYaml = this.detectYamlFormat(specContent);
    
    // Determine the type and file path
    // Postman API uses format like "openapi:3" or "openapi:3_1"
    const type = version === '3.1' ? 'openapi:3_1' : 
                 version === '2.0' ? 'openapi:2' : 'openapi:3';
    
    // Use appropriate file extension
    const filePath = isYaml ? 'index.yaml' : 'index.json';
    
    // Ensure content is a string
    const contentStr = typeof specContent === 'string' 
      ? specContent 
      : JSON.stringify(specContent, null, 2);

    const payload = {
      name,
      type,
      files: [
        {
          path: filePath,
          content: contentStr
        }
      ]
    };

    if (specId) {
      // Update existing spec
      await this.request('PATCH', `/specs/${specId}/files/${filePath}`, {
        content: contentStr
      });
      return specId;
    } else {
      // Create new spec
      const result = await this.request('POST', `/specs?workspaceId=${this.workspaceId}`, payload);
      return result.id;
    }
  }

  /**
   * Get collections generated from a spec
   * Distinguishes between "no collections" (404) and API errors
   */
  async getSpecGeneratedCollections(specId) {
    try {
      const result = await this.request('GET', `/specs/${specId}/generations/collection`);
      return result.collections || [];
    } catch (error) {
      // Check if it's a NotFoundError (no collections yet) vs a real API error
      if (error instanceof NotFoundError) {
        // No collections generated yet - this is expected for new specs
        return [];
      }
      
      // For other errors, log and re-throw
      logger.error(`Error fetching spec collections`, { error: error.message });
      throw error;
    }
  }

  /**
   * Generate or sync collection from spec
   * 
   * If collection with same name exists for this spec, sync it.
   * Otherwise, generate a new collection.
   */
  async generateOrSyncCollection(specId, name, options = {}) {
    // First, check if a collection with this name already exists for this spec
    const existingCollections = await this.getSpecGeneratedCollections(specId);
    const existingCollection = existingCollections.find(c => c.name === name);

    if (existingCollection) {
      // Collection exists, sync it with the spec
      // The ID from spec generations is just the collection ID
      // We need to find the full UID from the collections list
      logger.info(`Syncing existing collection: ${existingCollection.id}`);
      await this.syncCollectionWithSpec(existingCollection.id, specId);
      
      // Wait for sync to complete
      await this.waitForCollectionSync(existingCollection.id);
      
      // Find the full UID from collections list
      const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
      const collection = collections.collections?.find(c => c.name === name);
      
      if (!collection) {
        throw new Error(`Synced collection "${name}" not found`);
      }
      
      return collection.uid;
    }

    // No existing collection, generate new one
    logger.info(`Generating new collection: ${name}`);

    // Record timestamp before generation to avoid race conditions
    const generationStartTime = new Date().toISOString();

    const payload = {
      name,
      options: {
        enableOptionalParameters: options.enableOptionalParameters ?? true,
        folderStrategy: options.folderStrategy || 'Tags',
        ...options
      }
    };

    await this.request(
      'POST',
      `/specs/${specId}/generations/collection`,
      payload
    );

    // Collection generation is async, wait for it to complete
    await this.waitForCollectionGeneration(name, 15, generationStartTime);

    // Find and return the generated collection
    const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
    const collection = collections.collections?.find(c => c.name === name);

    if (!collection) {
      throw new Error(`Generated collection "${name}" not found`);
    }

    return collection.uid;
  }

  /**
   * Sync collection with spec
   */
  async syncCollectionWithSpec(collectionId, specId) {
    return this.request(
      'PUT',
      `/collections/${collectionId}/synchronizations?specId=${specId}`
    );
  }

  /**
   * Wait for collection sync to complete with exponential backoff
   */
  async waitForCollectionSync(collectionUid, maxAttempts = 15) {
    let delay = 2000; // Start with 2 seconds
    
    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(delay);

      // Check if collection is accessible and stable
      try {
        const collection = await this.getCollectionWithRetry(collectionUid);
        if (collection && collection.collection) {
          // Collection exists and is accessible - sync is likely complete
          return collection;
        }
      } catch (error) {
        // Collection might be temporarily unavailable during sync
        logger.debug(`Waiting for sync... (${i + 1}/${maxAttempts})`);
      }
      
      // Exponential backoff: 2s, 3s, 4.5s, 6.75s... (max 10s)
      delay = Math.min(delay * 1.5, 10000);
    }

    throw new Error(`Collection sync timed out after ${maxAttempts} attempts`);
  }

  /**
   * Wait for collection generation to complete with exponential backoff
   * Uses creation timestamp to avoid race conditions with concurrent pipelines
   * @param {string} name - Collection name to wait for
   * @param {number} maxAttempts - Maximum polling attempts
   * @param {string|null} createdAfter - ISO timestamp to filter collections created after this time
   */
  async waitForCollectionGeneration(name, maxAttempts = 15, createdAfter = null) {
    // Default to 5 seconds ago if no timestamp provided
    const threshold = createdAfter || new Date(Date.now() - 5000).toISOString();
    let delay = 2000; // Start with 2 seconds

    for (let i = 0; i < maxAttempts; i++) {
      await this.sleep(delay);

      try {
        const collections = await this.request('GET', `/collections?workspace=${this.workspaceId}`);
        // Filter by name AND creation time to avoid race conditions
        const collection = collections.collections?.find(c =>
          c.name === name &&
          (!c.createdAt || new Date(c.createdAt) > new Date(threshold))
        );

        if (collection) {
          return collection;
        }
      } catch (error) {
        logger.debug(`Waiting for generation... (${i + 1}/${maxAttempts})`);
      }

      // Exponential backoff
      delay = Math.min(delay * 1.5, 10000);
    }

    throw new Error(`Collection generation timed out after ${maxAttempts} attempts`);
  }

  /**
   * Get collection with retry logic for transient failures
   */
  async getCollectionWithRetry(collectionUid, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await this.getCollection(collectionUid);
      } catch (error) {
        lastError = error;
        
        // Only retry on 5xx errors or network issues
        const statusCode = error.message.match(/API Error (\d+)/)?.[1];
        if (statusCode && parseInt(statusCode) < 500) {
          throw error; // Don't retry 4xx errors
        }
        
        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
          logger.debug(`Retrying collection fetch... (${i + 1}/${maxRetries})`);
          await this.sleep(delay);
        }
      }
    }
    
    throw lastError;
  }

  /**
   * Sleep utility for async delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get collection details
   */
  async getCollection(collectionUid) {
    return this.request('GET', `/collections/${collectionUid}`);
  }

  /**
   * Update collection
   */
  async updateCollection(collectionUid, collection) {
    return this.request('PUT', `/collections/${collectionUid}`, { collection });
  }

  /**
   * Add test scripts to collection requests
   */
  async addTestScripts(collectionUid, testScripts) {
    const collectionData = await this.getCollection(collectionUid);

    // Validate response structure
    if (!collectionData?.collection) {
      throw new Error(`Collection ${collectionUid} not found or has no data`);
    }

    const collection = collectionData.collection;

    // Validate item array
    if (!Array.isArray(collection.item)) {
      logger.warn(`Collection ${collectionUid} has no items to inject tests into`);
      return { success: true, injected: 0 };
    }

    // Recursively add tests to all request items
    const injectedCount = this.addTestsToItems(collection.item, testScripts);

    // Update the collection
    await this.updateCollection(collectionUid, collection);

    return { success: true, injected: injectedCount };
  }

  /**
   * Generate a stable key for test script lookup from collection item
   * Matches the key generation in test-generator.js
   * @param {object} request - Postman request object
   * @returns {string} Stable key
   */
  generateTestKeyFromItem(request) {
    const method = (request.method || 'get').toLowerCase();
    
    // Extract path from URL
    let path = '/';
    const url = request.url;
    
    if (typeof url === 'string') {
      // Handle Postman variable syntax
      const urlStr = url.replace(/\{\{[^}]+\}\}/g, '');
      try {
        path = new URL(urlStr).pathname || '/';
      } catch {
        // Fallback: extract path manually
        path = urlStr.replace(/^https?:\/\/[^\/]+/, '') || '/';
      }
    } else if (url && typeof url === 'object') {
      if (url.path && Array.isArray(url.path)) {
        path = '/' + url.path.join('/');
      } else if (url.pathname) {
        path = url.pathname;
      }
    }
    
    // Normalize path
    path = path.replace(/\/{2,}/g, '/');
    if (!path.startsWith('/')) path = '/' + path;
    
    return `${method}|${path}`;
  }

  /**
   * Validate JavaScript syntax of a test script
   * @param {string} scriptContent - Script content to validate
   * @returns {boolean} True if syntax is valid
   */
  validateScriptSyntax(scriptContent) {
    try {
      new vm.Script(scriptContent);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Recursively add test scripts to collection items
   * @returns {number} Number of test scripts injected
   */
  addTestsToItems(items, testScripts, injectedCount = 0) {
    if (!Array.isArray(items)) {
      return injectedCount;
    }

    for (const item of items) {
      if (!item) continue;

      // Recurse into folders first
      if (Array.isArray(item.item)) {
        injectedCount = this.addTestsToItems(item.item, testScripts, injectedCount);
        continue;
      }

      // Skip items without valid requests
      if (!item.request?.method || !item.request?.url) {
        continue;
      }

      // This is a request item, add tests
      // Try stable key first (method|path), then fall back to name, then default
      const stableKey = this.generateTestKeyFromItem(item.request);
      const testScript = testScripts[stableKey] || testScripts[item.name] || testScripts['default'];

      if (testScript) {
        const scriptLines = Array.isArray(testScript) ? testScript : testScript.split('\n');
        const scriptContent = scriptLines.join('\n');

        // Validate script syntax before injection
        if (!this.validateScriptSyntax(scriptContent)) {
          logger.warn(`Invalid script syntax for item "${item.name}", skipping test injection`, {
            key: stableKey
          });
          continue;
        }

        item.event = item.event || [];

        // Remove existing test events
        item.event = item.event.filter(e => e.listen !== 'test');

        // Add new test event
        item.event.push({
          listen: 'test',
          script: {
            type: 'text/javascript',
            exec: scriptLines
          }
        });

        injectedCount++;
      }
    }

    return injectedCount;
  }

  /**
   * Delete spec
   */
  async deleteSpec(specId) {
    return this.request('DELETE', `/specs/${specId}`);
  }

  /**
   * Delete collection
   */
  async deleteCollection(collectionUid) {
    return this.request('DELETE', `/collections/${collectionUid}`);
  }

  /**
   * List specs in workspace with pagination support
   * Handles workspaces with >50 specs
   */
  async listSpecs() {
    const allSpecs = [];
    let cursor = null;

    do {
      const url = `/specs?workspaceId=${this.workspaceId}${cursor ? `&cursor=${cursor}` : ''}`;
      const result = await this.request('GET', url);

      if (result.specs) {
        allSpecs.push(...result.specs);
      }

      // Check for pagination cursor in Postman API response
      cursor = result.meta?.nextCursor || result.nextCursor || null;
    } while (cursor);

    return allSpecs;
  }

  /**
   * Find spec by name
   */
  async findSpecByName(name) {
    const specs = await this.listSpecs();
    return specs.find(s => s.name === name);
  }

  /**
   * Get collection tags
   */
  async getCollectionTags(collectionUid) {
    return this.request('GET', `/collections/${collectionUid}/tags`);
  }

  /**
   * Update collection tags (replaces all existing tags)
   * @param {string} collectionUid - Collection UID
   * @param {string[]} tags - Array of tag slugs
   */
  async updateCollectionTags(collectionUid, tags) {
    // Validate and format tags
    const formattedTags = tags.map(tag => ({
      slug: this.validateTag(tag)
    }));

    return this.request('PUT', `/collections/${collectionUid}/tags`, {
      tags: formattedTags
    });
  }

  /**
   * Validate and format a tag according to Postman rules:
   * - 2-64 characters
   * - Must match: ^[a-z][a-z0-9-]*[a-z0-9]+$
   * - Starts with letter, ends with letter/number, can contain hyphens
   */
  validateTag(tag) {
    if (!tag || typeof tag !== 'string') {
      throw new Error('Tag must be a non-empty string');
    }

    // Convert to lowercase and replace invalid characters
    let clean = tag.toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')  // Replace invalid chars with hyphens
      .replace(/^-+|-+$/g, '');      // Trim leading/trailing hyphens

    // Ensure starts with letter
    if (!/^[a-z]/.test(clean)) {
      clean = 'tag-' + clean;
    }

    // Ensure ends with letter or number
    if (!/[a-z0-9]$/.test(clean)) {
      clean = clean + '0';
    }

    // Length validation (2-64 chars)
    if (clean.length < 2) {
      clean = 'tag-' + clean;
    }
    if (clean.length > 64) {
      clean = clean.substring(0, 64).replace(/-+$/, '');  // Trim without trailing hyphen
      // Re-check ending
      if (!/[a-z0-9]$/.test(clean)) {
        clean = clean.substring(0, 63) + '0';
      }
    }

    return clean;
  }

  /**
   * Apply standard tags to a collection based on type
   * @param {string} collectionUid - Collection UID
   * @param {string} type - Collection type: 'main', 'smoke', or 'contract'
   */
  async applyCollectionTags(collectionUid, type) {
    const tagMap = {
      'main': ['generated', 'docs'],
      'smoke': ['generated', 'smoke'],
      'contract': ['generated', 'contract']
    };

    const tags = tagMap[type];
    if (!tags) {
      throw new Error(`Unknown collection type: ${type}. Use 'main', 'smoke', or 'contract'.`);
    }

    return this.updateCollectionTags(collectionUid, tags);
  }

  // ============================================================
  // BIDIRECTIONAL SYNC METHODS
  // ============================================================

  /**
   * Get all collections in workspace with metadata (for change detection)
   * Returns uid, name, and updatedAt for efficient polling
   * Supports pagination for large workspaces
   */
  async getWorkspaceCollections() {
    const allCollections = [];
    let cursor = null;
    
    do {
      const url = `/collections?workspace=${this.workspaceId}${cursor ? `&cursor=${cursor}` : ''}`;
      const result = await this.request('GET', url);
      
      if (result.collections) {
        allCollections.push(...result.collections);
      }
      
      // Check for pagination cursor in Postman API response
      cursor = result.meta?.nextCursor || result.nextCursor || null;
    } while (cursor);
    
    return allCollections;
  }

  /**
   * Get all environments in workspace with metadata (for change detection)
   * Supports pagination for large workspaces
   */
  async getWorkspaceEnvironments() {
    const allEnvironments = [];
    let cursor = null;
    
    do {
      const url = `/environments?workspace=${this.workspaceId}${cursor ? `&cursor=${cursor}` : ''}`;
      const result = await this.request('GET', url);
      
      if (result.environments) {
        allEnvironments.push(...result.environments);
      }
      
      // Check for pagination cursor in Postman API response
      cursor = result.meta?.nextCursor || result.nextCursor || null;
    } while (cursor);
    
    return allEnvironments;
  }

  /**
   * Get environment by UID
   */
  async getEnvironment(environmentUid) {
    return this.request('GET', `/environments/${environmentUid}`);
  }

  /**
   * Convert collection back to OpenAPI via Postman API
   * Uses Postman's native transformation - returns OpenAPI spec derived from collection
   * @param {string} collectionUid - Collection UID to transform
   * @returns {object} Parsed OpenAPI specification
   */
  async getCollectionAsOpenApi(collectionUid) {
    const result = await this.request(
      'GET',
      `/collections/${collectionUid}/transformations?format=openapi3`
    );
    // result.output is a stringified JSON
    return typeof result.output === 'string'
      ? JSON.parse(result.output)
      : result.output;
  }

  /**
   * Create a fork of a collection
   * @param {string} collectionUid - Source collection UID
   * @param {string} forkLabel - Label for the fork
   * @param {string} targetWorkspaceId - Optional target workspace (defaults to current)
   */
  async forkCollection(collectionUid, forkLabel, targetWorkspaceId = null) {
    const workspaceParam = targetWorkspaceId || this.workspaceId;

    return this.request(
      'POST',
      `/collections/fork/${collectionUid}?workspace=${workspaceParam}`,
      { label: forkLabel }
    );
  }

  /**
   * List all forks of a collection
   * @param {string} collectionUid - Collection UID to list forks for
   */
  async getCollectionForks(collectionUid) {
    const result = await this.request('GET', `/collections/${collectionUid}/forks`);
    return result.forks || [];
  }

  /**
   * Create a pull request from fork to parent collection
   * @param {string} destinationCollectionUid - Parent collection UID (PR target)
   * @param {string} sourceCollectionUid - Fork collection UID (PR source)
   * @param {object} options - PR options (title, description)
   */
  async createPullRequest(destinationCollectionUid, sourceCollectionUid, options = {}) {
    return this.request(
      'POST',
      `/collections/${destinationCollectionUid}/pull-requests`,
      {
        title: options.title || 'Sync changes from fork',
        description: options.description || '',
        source: sourceCollectionUid
      }
    );
  }

  /**
   * Get pull requests for a collection
   * @param {string} collectionUid - Collection UID
   * @param {string} status - Filter by status: 'open', 'merged', 'declined'
   */
  async getPullRequests(collectionUid, status = 'open') {
    const result = await this.request(
      'GET',
      `/collections/${collectionUid}/pull-requests?status=${status}`
    );
    return result.pullRequests || result.data || [];
  }

  /**
   * Merge a pull request
   * @param {string} collectionUid - Collection UID (PR destination)
   * @param {string} pullRequestId - Pull request ID to merge
   */
  async mergePullRequest(collectionUid, pullRequestId) {
    return this.request(
      'POST',
      `/collections/${collectionUid}/pull-requests/${pullRequestId}/merge`
    );
  }

  /**
   * Decline a pull request
   * @param {string} collectionUid - Collection UID (PR destination)
   * @param {string} pullRequestId - Pull request ID to decline
   */
  async declinePullRequest(collectionUid, pullRequestId) {
    return this.request(
      'PUT',
      `/collections/${collectionUid}/pull-requests/${pullRequestId}`,
      { status: 'declined' }
    );
  }
}

export { SpecHubClient };
