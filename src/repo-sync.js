#!/usr/bin/env node

/**
 * Repo Sync Module
 *
 * Exports Postman collections and environments to the local filesystem
 * as Git-friendly JSON files. Features:
 * - Deterministic output (sorted keys)
 * - Volatile fields removed (_postman_id, timestamps)
 * - Secrets redacted in environments
 * - Manifest tracking for change detection
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createLogger } from './logger.js';

const logger = createLogger({ name: 'repo-sync' });

const DEFAULT_CONFIG = {
  collectionsDir: 'postman/collections',
  environmentsDir: 'postman/environments',
  manifestFile: 'postman/.sync-manifest.json',
  indent: 2,
  sortKeys: true,
  dryRun: false
};

export class RepoSync {
  constructor(client, config = {}) {
    this.client = client;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Export all collections for a spec to repo
   * @param {string} specName - Name of the spec (for filename generation)
   * @param {Array} collectionUids - Array of {uid, type} objects
   * @param {string} outputDir - Base output directory
   */
  async exportCollections(specName, collectionUids, outputDir) {
    const collectionsDir = path.join(outputDir, this.config.collectionsDir);
    
    if (!this.config.dryRun) {
      fs.mkdirSync(collectionsDir, { recursive: true });
    }

    const exports = [];

    for (const { uid, type } of collectionUids) {
      try {
        const collection = await this.client.getCollection(uid);
        const normalized = this.normalizeCollection(collection.collection);

        const filename = this.generateFilename(specName, type, 'collection');
        const filepath = path.join(collectionsDir, filename);

        if (!this.config.dryRun) {
          this.writeJsonFile(filepath, normalized);
          logger.info(`Exported: ${filename}`);
        } else {
          logger.info(`Would export: ${filename}`);
        }

        exports.push({
          type,
          uid,
          filename,
          hash: this.hashContent(normalized),
          updatedAt: collection.collection?.info?.updatedAt
        });
      } catch (error) {
        logger.error(`Failed to export collection ${uid}`, { error: error.message });
      }
    }

    return exports;
  }

  /**
   * Export environments to repo
   * @param {string} specName - Name of the spec
   * @param {Array} environmentUids - Array of {uid, name} objects
   * @param {string} outputDir - Base output directory
   */
  async exportEnvironments(specName, environmentUids, outputDir) {
    const envsDir = path.join(outputDir, this.config.environmentsDir);
    
    if (!this.config.dryRun) {
      fs.mkdirSync(envsDir, { recursive: true });
    }

    const exports = [];

    for (const { uid, name } of environmentUids) {
      try {
        const envData = await this.client.getEnvironment(uid);
        const sanitized = this.sanitizeEnvironment(envData.environment);

        const filename = `${this.slugify(name)}.environment.json`;
        const filepath = path.join(envsDir, filename);

        if (!this.config.dryRun) {
          this.writeJsonFile(filepath, sanitized);
          logger.info(`Exported: ${filename}`);
        } else {
          logger.info(`Would export: ${filename}`);
        }

        exports.push({
          name,
          uid,
          filename,
          hash: this.hashContent(sanitized),
          updatedAt: envData.environment?.updatedAt
        });
      } catch (error) {
        logger.error(`Failed to export environment ${uid}`, { error: error.message });
      }
    }

    return exports;
  }

  /**
   * Normalize collection for deterministic Git diffs
   * - Removes volatile fields (only from metadata, not request/response bodies)
   * - Sorts keys
   * - Normalizes script whitespace
   */
  normalizeCollection(collection) {
    const normalized = JSON.parse(JSON.stringify(collection));

    // Remove volatile fields from collection metadata only
    // NOT from request/response bodies or schemas
    this.removeVolatileFieldsFromMetadata(normalized);

    // Normalize script whitespace
    this.normalizeScripts(normalized.item);

    // Sort keys for consistent output
    return this.config.sortKeys ? this.sortObjectKeys(normalized) : normalized;
  }

  /**
   * Sanitize environment (redact secrets)
   */
  sanitizeEnvironment(env) {
    const sanitized = JSON.parse(JSON.stringify(env));

    // Remove volatile metadata
    delete sanitized.uid;
    delete sanitized.id;
    delete sanitized.owner;
    delete sanitized.createdAt;
    delete sanitized.updatedAt;
    delete sanitized.isPublic;

    // Secret value patterns to redact
    const secretPatterns = /^(api[_-]?key|token|secret|password|auth|bearer|credential|private)/i;

    for (const variable of sanitized.values || []) {
      if (variable.type === 'secret' || secretPatterns.test(variable.key)) {
        variable.value = '';
        variable._redacted = true;
      }
    }

    return this.config.sortKeys ? this.sortObjectKeys(sanitized) : sanitized;
  }

  /**
   * Remove volatile fields from collection metadata only
   * Preserves id fields in request/response bodies and schemas
   */
  removeVolatileFieldsFromMetadata(collection) {
    // Volatile metadata fields at collection level
    const volatileMetadataFields = [
      '_postman_id',
      'id',
      'uid',
      'owner',
      'createdAt',
      'updatedAt',
      'lastUpdatedBy',
      'fork'
    ];

    // Remove from collection root
    for (const field of volatileMetadataFields) {
      delete collection[field];
    }

    // Remove from info object
    if (collection.info) {
      for (const field of volatileMetadataFields) {
        delete collection.info[field];
      }
    }

    // Process items recursively, but only remove metadata fields
    // Never touch request/response bodies
    this.removeMetadataFieldsFromItems(collection.item, volatileMetadataFields);
  }

  /**
   * Remove metadata fields from collection items only
   * Preserves body content, schemas, and examples
   */
  removeMetadataFieldsFromItems(items, fields) {
    if (!Array.isArray(items)) return;

    for (const item of items) {
      if (!item) continue;

      // Remove from item metadata only
      for (const field of fields) {
        delete item[field];
      }

      // If this is a folder (has nested items), recurse
      if (item.item) {
        this.removeMetadataFieldsFromItems(item.item, fields);
        continue;
      }

      // For request items, only remove from specific metadata locations
      // NEVER from request.body, response.body, or any content fields
      if (item.request) {
        // Remove from request metadata only
        for (const field of fields) {
          delete item.request[field];
        }

        // Remove from URL object metadata if present
        if (item.request.url && typeof item.request.url === 'object') {
          for (const field of fields) {
            delete item.request.url[field];
          }
        }

        // Remove from header metadata
        if (Array.isArray(item.request.header)) {
          for (const header of item.request.header) {
            for (const field of fields) {
              delete header[field];
            }
          }
        }

        // NOTE: Intentionally NOT removing from item.request.body
        // This preserves examples and schemas
      }

      // Remove from response metadata only, NOT response body
      if (Array.isArray(item.response)) {
        for (const response of item.response) {
          for (const field of fields) {
            delete response[field];
          }
          // Remove from response header metadata
          if (Array.isArray(response.header)) {
            for (const header of response.header) {
              for (const field of fields) {
                delete header[field];
              }
            }
          }
          // NOTE: Intentionally NOT removing from response.body
        }
      }

      // Remove from event (script) metadata
      if (Array.isArray(item.event)) {
        for (const event of item.event) {
          for (const field of fields) {
            delete event[field];
          }
          if (event.script && typeof event.script === 'object') {
            for (const field of fields) {
              delete event.script[field];
            }
          }
        }
      }
    }
  }

  /**
   * Normalize script whitespace for cleaner diffs
   */
  normalizeScripts(items) {
    for (const item of items || []) {
      if (item.event) {
        for (const event of item.event) {
          if (event.script?.exec && Array.isArray(event.script.exec)) {
            event.script.exec = event.script.exec.map(line =>
              line.replace(/\r\n/g, '\n').trimEnd()
            );
          }
        }
      }
      if (item.item) {
        this.normalizeScripts(item.item);
      }
    }
  }

  /**
   * Sort object keys recursively for deterministic output
   */
  sortObjectKeys(obj) {
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortObjectKeys(item));
    }
    if (obj && typeof obj === 'object') {
      return Object.keys(obj)
        .sort()
        .reduce((sorted, key) => {
          sorted[key] = this.sortObjectKeys(obj[key]);
          return sorted;
        }, {});
    }
    return obj;
  }

  /**
   * Generate consistent filename
   */
  generateFilename(specName, type, entityType) {
    const slug = this.slugify(specName);
    const typeSuffix = type === 'main' ? '' : `-${type}`;
    return `${slug}${typeSuffix}.${entityType}.json`;
  }

  /**
   * Slugify a name for filesystem use
   */
  slugify(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  /**
   * Write JSON file with consistent formatting
   */
  writeJsonFile(filepath, data) {
    fs.mkdirSync(path.dirname(filepath), { recursive: true });
    fs.writeFileSync(
      filepath,
      JSON.stringify(data, null, this.config.indent) + '\n'
    );
  }

  /**
   * Generate content hash for change detection
   */
  hashContent(obj) {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(obj))
      .digest('hex')
      .substring(0, 12);
  }

  /**
   * Load existing manifest
   */
  loadManifest(outputDir) {
    const manifestPath = path.join(outputDir, this.config.manifestFile);

    if (fs.existsSync(manifestPath)) {
      return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    }

    return {
      version: '1.0',
      lastSync: null,
      collections: {},
      environments: {}
    };
  }

  /**
   * Update sync manifest
   */
  async updateManifest(outputDir, syncResult) {
    const manifestPath = path.join(outputDir, this.config.manifestFile);
    const manifest = this.loadManifest(outputDir);

    manifest.lastSync = new Date().toISOString();
    manifest.specPath = syncResult.specPath;
    manifest.workspaceId = this.client.workspaceId;

    // Update collection entries
    for (const coll of syncResult.collections || []) {
      manifest.collections[coll.uid] = {
        type: coll.type,
        filename: coll.filename,
        hash: coll.hash,
        updatedAt: coll.updatedAt,
        syncedAt: manifest.lastSync
      };
    }

    // Update environment entries
    for (const env of syncResult.environments || []) {
      manifest.environments[env.uid] = {
        name: env.name,
        filename: env.filename,
        hash: env.hash,
        updatedAt: env.updatedAt,
        syncedAt: manifest.lastSync
      };
    }

    if (!this.config.dryRun) {
      this.writeJsonFile(manifestPath, manifest);
      logger.info(`Updated manifest: ${this.config.manifestFile}`);
    } else {
      logger.info(`Would update manifest: ${this.config.manifestFile}`);
    }

    return manifest;
  }

  /**
   * Check for changes by comparing updatedAt timestamps
   * Detects new, modified, and deleted items
   * @param {string} outputDir - Directory containing manifest
   * @returns {object} Change detection results
   */
  async detectChanges(outputDir) {
    const manifest = this.loadManifest(outputDir);
    const changes = {
      collections: [],
      environments: [],
      hasChanges: false
    };

    // Get current workspace state with pagination support
    const currentCollections = await this.getAllWorkspaceCollections();
    const currentEnvironments = await this.getAllWorkspaceEnvironments();

    // Create sets for efficient lookup
    const currentCollectionUids = new Set(currentCollections.map(c => c.uid));
    const currentEnvironmentUids = new Set(currentEnvironments.map(e => e.uid));

    // Check collections for changes (new and modified)
    for (const coll of currentCollections) {
      const tracked = manifest.collections[coll.uid];

      if (!tracked) {
        changes.collections.push({ uid: coll.uid, name: coll.name, change: 'new' });
        changes.hasChanges = true;
      } else if (tracked.updatedAt !== coll.updatedAt) {
        changes.collections.push({
          uid: coll.uid,
          name: coll.name,
          change: 'modified',
          previousUpdate: tracked.updatedAt,
          currentUpdate: coll.updatedAt
        });
        changes.hasChanges = true;
      }
    }

    // Check for deleted collections (in manifest but not in workspace)
    for (const [uid, tracked] of Object.entries(manifest.collections)) {
      if (!currentCollectionUids.has(uid)) {
        changes.collections.push({
          uid,
          name: tracked.name || tracked.filename || 'Unknown',
          change: 'deleted'
        });
        changes.hasChanges = true;
      }
    }

    // Check environments for changes (new and modified)
    for (const env of currentEnvironments) {
      const tracked = manifest.environments[env.uid];

      if (!tracked) {
        changes.environments.push({ uid: env.uid, name: env.name, change: 'new' });
        changes.hasChanges = true;
      } else if (tracked.updatedAt !== env.updatedAt) {
        changes.environments.push({
          uid: env.uid,
          name: env.name,
          change: 'modified',
          previousUpdate: tracked.updatedAt,
          currentUpdate: env.updatedAt
        });
        changes.hasChanges = true;
      }
    }

    // Check for deleted environments
    for (const [uid, tracked] of Object.entries(manifest.environments)) {
      if (!currentEnvironmentUids.has(uid)) {
        changes.environments.push({
          uid,
          name: tracked.name || tracked.filename || 'Unknown',
          change: 'deleted'
        });
        changes.hasChanges = true;
      }
    }

    return changes;
  }

  /**
   * Get all collections with pagination support
   * @returns {Array} All collections in workspace
   */
  async getAllWorkspaceCollections() {
    const allCollections = [];
    let cursor = null;
    
    do {
      const result = await this.client.request(
        'GET', 
        `/collections?workspace=${this.client.workspaceId}${cursor ? `&cursor=${cursor}` : ''}`
      );
      
      if (result.collections) {
        allCollections.push(...result.collections);
      }
      
      // Check for pagination cursor
      cursor = result.meta?.nextCursor || result.nextCursor || null;
    } while (cursor);
    
    return allCollections;
  }

  /**
   * Get all environments with pagination support
   * @returns {Array} All environments in workspace
   */
  async getAllWorkspaceEnvironments() {
    const allEnvironments = [];
    let cursor = null;
    
    do {
      const result = await this.client.request(
        'GET', 
        `/environments?workspace=${this.client.workspaceId}${cursor ? `&cursor=${cursor}` : ''}`
      );
      
      if (result.environments) {
        allEnvironments.push(...result.environments);
      }
      
      // Check for pagination cursor
      cursor = result.meta?.nextCursor || result.nextCursor || null;
    } while (cursor);
    
    return allEnvironments;
  }

  /**
   * Get sync status summary
   */
  async getStatus(outputDir) {
    const manifest = this.loadManifest(outputDir);
    const changes = await this.detectChanges(outputDir);

    return {
      lastSync: manifest.lastSync,
      specPath: manifest.specPath,
      workspaceId: manifest.workspaceId,
      trackedCollections: Object.keys(manifest.collections).length,
      trackedEnvironments: Object.keys(manifest.environments).length,
      changes,
      needsSync: changes.hasChanges
    };
  }
}

export default RepoSync;
