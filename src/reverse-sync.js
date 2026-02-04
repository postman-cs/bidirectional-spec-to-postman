#!/usr/bin/env node

/**
 * Reverse Sync Module
 *
 * Orchestrates the reverse sync workflow:
 * 1. Fetch collection from Postman
 * 2. Transform to OpenAPI via Postman API
 * 3. Detect and classify changes
 * 4. Apply allowed changes back to spec
 * 5. Store tests as vendor extensions
 */

import fs from 'fs';
import path from 'path';
import { ChangeDetector, CHANGE_DIRECTION } from './change-detector.js';
import { SpecMerge } from './spec-merge.js';
import { createLogger } from './logger.js';

const logger = createLogger({ name: 'reverse-sync' });

export class ReverseSync {
  constructor(client, config = {}) {
    this.client = client;
    this.config = {
      conflictStrategy: config.conflictStrategy || 'spec-wins',
      autoMergeDescriptions: config.autoMergeDescriptions ?? true,
      autoMergeExamples: config.autoMergeExamples ?? true,
      storeTestsAsExtension: config.storeTestsAsExtension ?? true,
      baselineDir: config.baselineDir || '.sync-baselines',
      ...config
    };
    this.changeDetector = new ChangeDetector();
    this.specMerge = new SpecMerge(this.config);
  }

  /**
   * Main entry: Analyze and optionally apply reverse sync
   * @param {string} specPath - Path to local OpenAPI spec
   * @param {string} collectionUid - Collection UID to sync from
   * @param {object} options - Options (dryRun, outputPath)
   */
  async reverseSync(specPath, collectionUid, options = {}) {
    logger.info('\nReverse Sync: Postman -> OpenAPI Spec');
    logger.info('-'.repeat(50));

    // Step 1: Load local spec
    logger.info('\n[1] Loading local spec...');
    const localSpec = this.specMerge.readSpec(specPath);
    logger.info(`    Loaded: ${localSpec.info?.title} v${localSpec.info?.version}`);

    // Step 2: Get Postman collection
    logger.info('\n[2] Fetching collection from Postman...');
    const collection = await this.client.getCollection(collectionUid);
    logger.info(`    Collection: ${collection.collection?.info?.name}`);

    // Step 3: Transform collection to OpenAPI
    logger.info('\n[3] Transforming collection to OpenAPI...');
    let remoteSpec;
    try {
      remoteSpec = await this.client.getCollectionAsOpenApi(collectionUid);
      logger.info('    Transformation complete');
    } catch (error) {
      logger.error(`    Transformation failed: ${error.message}`);
      logger.info('    Falling back to description/example extraction only');
      remoteSpec = null;
    }

    // Step 4: Load baseline spec (for 3-way merge)
    const baseSpec = await this.loadBaseline(specPath) || localSpec;

    // Step 5: Detect and classify changes
    logger.info('\n[4] Detecting changes...');
    let changes;

    if (remoteSpec) {
      changes = this.changeDetector.detectChanges(baseSpec, localSpec, remoteSpec);
    } else {
      // Fallback: extract what we can from collection directly
      changes = this.extractChangesFromCollection(baseSpec, localSpec, collection.collection);
    }

    this.printChangeSummary(changes);

    // Step 6: Return analysis if dry-run
    if (options.dryRun) {
      return {
        status: 'dry-run',
        changes,
        wouldApply: changes.safeToSync.length,
        wouldSkip: changes.blocked.length,
        wouldReview: changes.needsReview.length
      };
    }

    // Step 7: Check for blocking issues
    if (changes.blocked.length > 0) {
      logger.info('\n    Blocked changes detected (structural changes cannot reverse-sync):');
      for (const blocked of changes.blocked.slice(0, 5)) {
        logger.info(`      - ${blocked.path}: ${blocked.reason}`);
      }
      if (changes.blocked.length > 5) {
        logger.info(`      ... and ${changes.blocked.length - 5} more`);
      }
    }

    // Step 8: Apply safe changes
    if (changes.safeToSync.length === 0 && changes.tests.length === 0) {
      logger.info('\n    No changes to apply');
      return { status: 'no-changes', changes };
    }

    logger.info('\n[5] Applying changes...');
    const mergeResult = this.specMerge.mergeSpecs(
      localSpec,
      remoteSpec || localSpec,
      changes.safeToSync
    );

    // Step 9: Store tests as vendor extension if configured
    if (this.config.storeTestsAsExtension && collection.collection) {
      const testsApplied = this.applyTestsAsExtensions(
        mergeResult.spec,
        collection.collection
      );
      if (testsApplied > 0) {
        logger.info(`    Applied ${testsApplied} test scripts as x-postman-tests`);
      }
    }

    // Step 10: Write updated spec
    const outputPath = options.outputPath || specPath;

    // Backup original if modifying in place
    if (outputPath === specPath && !options.noBackup) {
      const backupPath = this.specMerge.backupSpec(specPath);
      logger.info(`    Backup created: ${backupPath}`);
    }

    this.specMerge.writeSpec(mergeResult.spec, outputPath);
    logger.info(`\n    Updated: ${outputPath}`);
    logger.info(`    Applied: ${mergeResult.applied.length} changes`);
    logger.info(`    Skipped: ${mergeResult.skipped.length} changes`);

    // Step 11: Save new baseline for future 3-way merges
    await this.saveBaseline(specPath, mergeResult.spec);

    return {
      status: 'synced',
      changes,
      applied: mergeResult.applied,
      skipped: mergeResult.skipped,
      outputPath
    };
  }

  /**
   * Print change summary
   */
  printChangeSummary(changes) {
    const summary = this.changeDetector.getSummary(changes);
    logger.info('\n    Change Summary:');
    logger.info(`      Safe to sync: ${summary.safeToSync}`);
    logger.info(`      Needs review: ${summary.needsReview}`);
    logger.info(`      Blocked: ${summary.blocked}`);
    logger.info(`      Tests: ${summary.tests}`);
    if (summary.hasConflicts) {
      logger.info('      (!) Conflicts detected');
    }
  }

  /**
   * Load baseline spec for 3-way merge
   */
  async loadBaseline(specPath) {
    const baselinePath = this.getBaselinePath(specPath);

    if (fs.existsSync(baselinePath)) {
      try {
        const content = fs.readFileSync(baselinePath, 'utf8');
        return JSON.parse(content);
      } catch (error) {
        logger.info(`    Could not load baseline: ${error.message}`);
      }
    }

    return null;
  }

  /**
   * Save baseline spec after successful sync
   */
  async saveBaseline(specPath, spec) {
    const baselinePath = this.getBaselinePath(specPath);
    const baselineDir = path.dirname(baselinePath);

    fs.mkdirSync(baselineDir, { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(spec, null, 2));
  }

  /**
   * Get baseline file path for a spec
   */
  getBaselinePath(specPath) {
    const specName = path.basename(specPath, path.extname(specPath));
    return path.join(
      path.dirname(specPath),
      this.config.baselineDir,
      `${specName}.baseline.json`
    );
  }

  /**
   * Extract changes directly from collection (fallback when transformation fails)
   */
  extractChangesFromCollection(baseSpec, localSpec, collection) {
    const changes = {
      safeToSync: [],
      needsReview: [],
      blocked: [],
      tests: []
    };

    // Extract descriptions from collection items
    this.extractDescriptionsFromItems(collection.item, changes, '');

    return changes;
  }

  /**
   * Recursively extract descriptions from collection items
   * Only extracts changes that can be mapped to valid OpenAPI paths
   */
  extractDescriptionsFromItems(items, changes, pathPrefix) {
    for (const item of items || []) {
      if (item.item) {
        // Folder - recurse
        this.extractDescriptionsFromItems(
          item.item,
          changes,
          `${pathPrefix}/${item.name}`
        );
      } else if (item.request) {
        // Request item - extract description only if it maps to a valid OpenAPI path
        const urlPath = this.extractPathFromUrl(item.request.url);
        const method = (item.request.method || 'get').toLowerCase();

        // Validate this is a mappable OpenAPI path before adding
        if (!this.isValidOpenAPIPath(urlPath, method)) {
          logger.warn(`Cannot map collection item to OpenAPI: ${method} ${urlPath} - skipping`);
          continue;
        }

        if (item.description) {
          changes.safeToSync.push({
            path: `paths.${urlPath}.${method}.description`,
            kind: 'E',
            newValue: item.description,
            direction: CHANGE_DIRECTION.BIDIRECTIONAL,
            reason: 'Request description',
            hasConflict: false
          });
        }

        // Extract test scripts
        if (item.event) {
          const testEvents = item.event.filter(e => e.listen === 'test');
          if (testEvents.length > 0) {
            changes.tests.push({
              path: `paths.${urlPath}.${method}.tests`,
              kind: 'E',
              newValue: testEvents,
              direction: CHANGE_DIRECTION.COLLECTION_ONLY,
              reason: 'Test scripts',
              hasConflict: false
            });
          }
        }
      }
    }
  }

  /**
   * Extract path from URL object/string
   * @param {string|object} url - URL string or Postman URL object
   * @returns {string} Extracted path
   */
  extractPathFromUrl(url) {
    if (!url) return '/';

    try {
      if (typeof url === 'string') {
        // Handle Postman variable syntax
        const urlStr = url.replace(/\{\{[^}]+\}\}/g, 'http://localhost');
        return new URL(urlStr).pathname || '/';
      } else if (typeof url === 'object') {
        if (url.path && Array.isArray(url.path)) {
          return '/' + url.path.join('/');
        } else if (url.pathname) {
          return url.pathname;
        } else if (url.raw) {
          const urlStr = url.raw.replace(/\{\{[^}]+\}\}/g, 'http://localhost');
          return new URL(urlStr).pathname || '/';
        }
      }
    } catch (error) {
      // Fallback: extract path manually
      if (typeof url === 'string') {
        return url.replace(/^https?:\/\/[^\/]+/, '').replace(/^\{\{[^}]+\}\}/, '') || '/';
      }
    }

    return '/';
  }

  /**
   * Check if a path/method combination is valid for OpenAPI
   * @param {string} urlPath - URL path
   * @param {string} method - HTTP method
   * @returns {boolean} True if valid OpenAPI path
   */
  isValidOpenAPIPath(urlPath, method) {
    // Must have a valid HTTP method
    const validMethods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
    if (!validMethods.includes(method.toLowerCase())) {
      return false;
    }

    // Must start with /
    if (!urlPath || !urlPath.startsWith('/')) {
      return false;
    }

    // Path should not contain invalid characters for OpenAPI
    // Allow alphanumeric, /, {}, -, _, and common URL characters
    const validPathPattern = /^[a-zA-Z0-9\/{}._~!$&'()*+,;=:@-]+$/;
    if (!validPathPattern.test(urlPath)) {
      return false;
    }

    return true;
  }

  /**
   * Extract and store test scripts as OpenAPI vendor extensions
   */
  applyTestsAsExtensions(spec, collection) {
    const testsByOperation = this.extractTestsFromCollection(collection);
    let appliedCount = 0;

    for (const [operationKey, tests] of Object.entries(testsByOperation)) {
      const [urlPath, method] = operationKey.split('|');

      // Find matching operation in spec
      const operation = this.findOperation(spec, urlPath, method);

      if (operation) {
        operation['x-postman-tests'] = tests;
        appliedCount++;
      }
    }

    return appliedCount;
  }

  /**
   * Find operation in spec by path and method
   */
  findOperation(spec, urlPath, method) {
    if (!spec.paths) return null;

    // Try exact match first
    if (spec.paths[urlPath]?.[method]) {
      return spec.paths[urlPath][method];
    }

    // Try matching with path parameters
    for (const [specPath, methods] of Object.entries(spec.paths)) {
      if (this.pathsMatch(specPath, urlPath) && methods[method]) {
        return methods[method];
      }
    }

    return null;
  }

  /**
   * Check if spec path matches collection URL path
   * Handles path parameters: /users/{id} matches /users/123
   */
  pathsMatch(specPath, urlPath) {
    const specParts = specPath.split('/');
    const urlParts = urlPath.split('/');

    if (specParts.length !== urlParts.length) return false;

    for (let i = 0; i < specParts.length; i++) {
      const specPart = specParts[i];
      const urlPart = urlParts[i];

      // Path parameter matches anything
      if (specPart.startsWith('{') && specPart.endsWith('}')) {
        continue;
      }

      if (specPart !== urlPart) {
        return false;
      }
    }

    return true;
  }

  /**
   * Extract test scripts from collection items
   */
  extractTestsFromCollection(collection) {
    const tests = {};

    const processItems = (items, folderPath = '') => {
      for (const item of items || []) {
        if (item.item) {
          // Folder - recurse
          processItems(item.item, `${folderPath}/${item.name}`);
        } else if (item.request && item.event) {
          const testEvents = item.event.filter(e => e.listen === 'test');

          if (testEvents.length > 0) {
            const url = item.request.url;
            let urlPath;
            
            try {
              if (typeof url === 'string') {
                // Handle Postman variable syntax like {{baseUrl}}/users/123
                // Extract path from URL, handling variables gracefully
                const urlStr = url.replace(/\{\{[^}]+\}\}/g, 'http://localhost');
                urlPath = new URL(urlStr).pathname;
              } else if (url && typeof url === 'object') {
                // Handle Postman URL object
                if (url.path && Array.isArray(url.path)) {
                  urlPath = '/' + url.path.join('/');
                } else if (url.raw) {
                  // Parse raw URL, handling variables
                  const urlStr = url.raw.replace(/\{\{[^}]+\}\}/g, 'http://localhost');
                  try {
                    urlPath = new URL(urlStr).pathname;
                  } catch {
                    // Fallback: extract path manually
                    urlPath = urlStr.replace(/^https?:\/\/[^\/]+/, '');
                  }
                } else {
                  urlPath = '/';
                }
              } else {
                urlPath = '/';
              }
            } catch (error) {
              // If URL parsing fails, use a fallback
              logger.debug(`URL parsing failed for item "${item.name}", using fallback`, { error: error.message });
              if (typeof url === 'string') {
                // Extract path after domain or use as-is if no domain
                urlPath = url.replace(/^https?:\/\/[^\/]+/, '').replace(/^\{\{[^}]+\}\}/, '');
                if (!urlPath.startsWith('/')) urlPath = '/' + urlPath;
              } else {
                urlPath = '/';
              }
            }
            
            const method = (item.request.method || 'get').toLowerCase();
            const key = `${urlPath}|${method}`;

            tests[key] = testEvents.map(e => ({
              name: item.name,
              script: e.script?.exec || [],
              type: e.script?.type || 'text/javascript'
            }));
          }
        }
      }
    };

    processItems(collection.item);
    return tests;
  }

  /**
   * Get reverse sync status/preview without making changes
   */
  async getStatus(specPath, collectionUid) {
    return this.reverseSync(specPath, collectionUid, { dryRun: true });
  }
}

export default ReverseSync;
