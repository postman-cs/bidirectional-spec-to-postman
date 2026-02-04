#!/usr/bin/env node

/**
 * Integration Tests for Bi-Directional Sync
 *
 * These tests require actual Postman API credentials.
 * They are skipped by default unless POSTMAN_API_KEY is set.
 *
 * Run with: POSTMAN_API_KEY=xxx POSTMAN_WORKSPACE_ID=xxx npm run test:integration
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { SpecHubClient } from '../../spec-hub-client.js';
import { RepoSync } from '../../repo-sync.js';
import { ReverseSync } from '../../reverse-sync.js';
import { sync as forwardSync } from '../../spec-hub-sync.js';
import { parseSpec } from '../../parser.js';

// ============================================================
// TEST CONFIGURATION
// ============================================================

const API_KEY = process.env.POSTMAN_API_KEY;
const WORKSPACE_ID = process.env.POSTMAN_WORKSPACE_ID;

// Skip all integration tests if credentials not available
const describeIntegration = (API_KEY && WORKSPACE_ID) ? describe : describe.skip;

// Test timeout for API calls (30 seconds)
const TEST_TIMEOUT = 30000;

// Helper to wrap async operations with timeout
async function withTimeout(promise, ms, message) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(message || `Operation timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timeout]);
}

// ============================================================
// TEST FIXTURES
// ============================================================

const TEST_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Integration Test API',
    version: '1.0.0',
    description: 'Test API for integration tests'
  },
  servers: [
    { url: 'https://api.example.com/v1' }
  ],
  paths: {
    '/test-items': {
      get: {
        operationId: 'listTestItems',
        summary: 'List test items',
        description: 'Returns a list of test items',
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/TestItem' }
                },
                example: [{ id: '1', name: 'Test Item' }]
              }
            }
          }
        }
      },
      post: {
        operationId: 'createTestItem',
        summary: 'Create test item',
        description: 'Creates a new test item',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/TestItem' },
              example: { id: '2', name: 'New Item' }
            }
          }
        },
        responses: {
          '201': {
            description: 'Created',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TestItem' }
              }
            }
          }
        }
      }
    },
    '/test-items/{id}': {
      get: {
        operationId: 'getTestItem',
        summary: 'Get test item',
        description: 'Returns a single test item by ID',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'The test item ID',
            schema: { type: 'string' }
          }
        ],
        responses: {
          '200': {
            description: 'Successful response',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/TestItem' }
              }
            }
          },
          '404': {
            description: 'Not found'
          }
        }
      }
    }
  },
  components: {
    schemas: {
      TestItem: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' }
        }
      }
    }
  }
};

// ============================================================
// TEST HELPERS
// ============================================================

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sync-test-'));
}

function cleanupTempDir(tempDir) {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function writeTestSpec(tempDir, spec = TEST_SPEC) {
  const specPath = path.join(tempDir, 'test-api.yaml');
  const yaml = await import('js-yaml');
  fs.writeFileSync(specPath, yaml.default.dump(spec));
  return specPath;
}

// ============================================================
// INTEGRATION TESTS
// ============================================================

describeIntegration('Bi-Directional Sync Integration', () => {
  let client;
  let tempDir;
  let specPath;
  const createdCollections = [];

  before(async function() {
    console.log('\n🔧 Setting up integration tests...');
    console.log(`   Workspace: ${WORKSPACE_ID}`);

    client = new SpecHubClient(API_KEY, WORKSPACE_ID);
    tempDir = createTempDir();

    // Write test spec to temp file
    specPath = await writeTestSpec(tempDir);

    console.log(`   Temp directory: ${tempDir}`);
  });

  after(async function() {
    console.log('\n🧹 Cleaning up integration tests...');

    // Clean up created collections
    for (const uid of createdCollections) {
      try {
        await client.deleteCollection(uid);
        console.log(`   Deleted collection: ${uid}`);
      } catch (error) {
        console.log(`   Failed to delete collection ${uid}: ${error.message}`);
      }
    }

    // Clean up temp directory
    cleanupTempDir(tempDir);

    console.log('   Cleanup complete');
  });

  // ============================================================
  // TEST: Forward + Repo Sync End-to-End
  // ============================================================

  it('should forward sync spec to Postman and export to repo', async function() {
    console.log('\n📤 Test: Forward + Repo Sync');

    // Step 1: Forward sync
    console.log('   Step 1: Forward syncing spec...');
    const forwardResult = await withTimeout(
      forwardSync({
        spec: specPath,
        workspaceId: WORKSPACE_ID,
        apiKey: API_KEY,
        testLevel: 'smoke',
        dryRun: false
      }),
      TEST_TIMEOUT,
      'Forward sync timed out'
    );

    assert.ok(forwardResult, 'Forward sync should return a result');
    console.log('   ✓ Forward sync complete');

    // Track created collections for cleanup
    const spec = await parseSpec(specPath);
    const specName = spec.info.title;

    const collections = await client.getWorkspaceCollections();
    const mainCollection = collections.find(c => c.name === specName);

    if (mainCollection) {
      createdCollections.push(mainCollection.uid);
    }

    // Step 2: Repo sync
    console.log('   Step 2: Exporting to repo...');
    const repoSync = new RepoSync(client);

    const collectionUids = collections
      .filter(c => c.name === specName || c.name.startsWith(`${specName} -`))
      .map(c => ({
        uid: c.uid,
        type: c.name.includes('Smoke') ? 'smoke' :
              c.name.includes('Contract') ? 'contract' : 'main'
      }));

    const exported = await repoSync.exportCollections(
      specName,
      collectionUids,
      tempDir
    );

    assert.ok(exported.length > 0, 'Should export at least one collection');
    console.log(`   ✓ Exported ${exported.length} collections`);

    // Step 3: Verify exported files
    console.log('   Step 3: Verifying exported files...');
    const collectionsDir = path.join(tempDir, 'postman/collections');

    assert.ok(fs.existsSync(collectionsDir), 'Collections directory should exist');

    const exportedFiles = fs.readdirSync(collectionsDir);
    assert.ok(exportedFiles.length > 0, 'Should have exported files');

    // Verify file structure
    const mainFile = exportedFiles.find(f => f.includes('integration-test-api') && !f.includes('smoke') && !f.includes('contract'));
    assert.ok(mainFile, 'Should have main collection file');

    const mainContent = JSON.parse(fs.readFileSync(path.join(collectionsDir, mainFile), 'utf8'));
    assert.ok(mainContent.info, 'Collection should have info');
    assert.ok(mainContent.item, 'Collection should have items');
    assert.strictEqual(mainContent.info.name, specName, 'Collection name should match spec');

    // Verify volatile fields removed
    assert.strictEqual(mainContent._postman_id, undefined, 'Should not have _postman_id');
    assert.strictEqual(mainContent.owner, undefined, 'Should not have owner');

    console.log('   ✓ Exported files verified');

    // Step 4: Verify manifest
    console.log('   Step 4: Verifying manifest...');
    await repoSync.updateManifest(tempDir, {
      specPath,
      collections: exported,
      environments: []
    });

    const manifestPath = path.join(tempDir, 'postman/.sync-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'Manifest should exist');

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.lastSync, 'Manifest should have lastSync');
    assert.ok(manifest.collections, 'Manifest should have collections');
    assert.strictEqual(Object.keys(manifest.collections).length, exported.length, 'Manifest should track all collections');

    console.log('   ✓ Manifest verified');
    console.log('   ✅ Test passed: Forward + Repo Sync');
  });

  // ============================================================
  // TEST: Reverse Sync with Real Collection
  // ============================================================

  it('should reverse sync descriptions from Postman to spec', async function() {
    console.log('\n📥 Test: Reverse Sync');

    // Step 1: Get or create a collection
    console.log('   Step 1: Finding test collection...');
    const spec = await parseSpec(specPath);
    const specName = spec.info.title;

    const collections = await client.getWorkspaceCollections();
    let testCollection = collections.find(c => c.name === specName);

    if (!testCollection) {
      console.log('   Creating new collection for reverse sync test...');
      await withTimeout(
        forwardSync({
          spec: specPath,
          workspaceId: WORKSPACE_ID,
          apiKey: API_KEY,
          testLevel: 'none',
          dryRun: false
        }),
        TEST_TIMEOUT,
        'Forward sync timed out'
      );

      const newCollections = await client.getWorkspaceCollections();
      testCollection = newCollections.find(c => c.name === specName);
    }

    assert.ok(testCollection, 'Should have a test collection');
    createdCollections.push(testCollection.uid);

    console.log(`   ✓ Found collection: ${testCollection.uid}`);

    // Step 2: Modify collection in Postman
    console.log('   Step 2: Simulating Postman edits...');
    const collectionData = await client.getCollection(testCollection.uid);
    const collection = collectionData.collection;

    if (collection.item && collection.item[0]) {
      collection.item[0].description = 'Enhanced in Postman during integration test';
    }

    await client.updateCollection(testCollection.uid, collection);
    console.log('   ✓ Modified collection in Postman');

    // Step 3: Reverse sync
    console.log('   Step 3: Running reverse sync...');
    const reverseSync = new ReverseSync(client, {
      conflictStrategy: 'spec-wins',
      storeTestsAsExtension: true
    });

    const outputSpecPath = path.join(tempDir, 'test-api-updated.yaml');

    const result = await withTimeout(
      reverseSync.reverseSync(
        specPath,
        testCollection.uid,
        {
          dryRun: false,
          outputPath: outputSpecPath
        }
      ),
      TEST_TIMEOUT,
      'Reverse sync timed out'
    );

    assert.ok(result, 'Reverse sync should return a result');
    assert.strictEqual(result.status, 'synced', 'Should have synced status');
    console.log(`   ✓ Reverse sync complete: ${result.applied?.length || 0} changes applied`);

    // Step 4: Verify spec was updated
    console.log('   Step 4: Verifying spec updates...');
    const updatedSpec = await parseSpec(outputSpecPath);

    // Verify structure preserved
    assert.ok(updatedSpec.paths, 'Should preserve paths');
    assert.ok(updatedSpec.components?.schemas?.TestItem, 'Should preserve schemas');

    console.log('   ✓ Spec structure preserved');
    console.log('   ✅ Test passed: Reverse Sync');
  });

  // ============================================================
  // TEST: Change Detection
  // ============================================================

  it('should detect changes in workspace collections', async function() {
    console.log('\n🔍 Test: Change Detection');

    const repoSync = new RepoSync(client);

    // Create a manifest first
    await repoSync.updateManifest(tempDir, {
      specPath,
      collections: [],
      environments: []
    });

    // Detect changes
    const changes = await repoSync.detectChanges(tempDir);

    assert.ok(changes, 'Should return changes object');
    assert.ok(typeof changes.hasChanges === 'boolean', 'Should have hasChanges boolean');

    console.log(`   Changes detected: ${changes.hasChanges}`);
    console.log(`   Collections: ${changes.collections.length}`);
    console.log(`   Environments: ${changes.environments.length}`);
    console.log('   ✅ Test passed: Change Detection');
  });
});

// ============================================================
// STANDALONE TEST RUNNER MESSAGE
// ============================================================

if (!API_KEY || !WORKSPACE_ID) {
  console.log('\n⚠️  Integration tests skipped - no credentials');
  console.log('Set POSTMAN_API_KEY and POSTMAN_WORKSPACE_ID to run integration tests\n');
}
