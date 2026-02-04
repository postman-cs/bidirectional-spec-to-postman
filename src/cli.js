#!/usr/bin/env node

/**
 * Bi-Directional Sync CLI
 *
 * Unified interface for OpenAPI <-> Postman synchronization
 *
 * Commands:
 *   forward  - Sync spec to Postman (existing behavior)
 *   repo     - Export Postman collections/environments to repo
 *   reverse  - Sync Postman changes back to spec
 *   bidi     - Full bidirectional workflow
 *   status   - Check sync status and detect drift
 */

import { Command } from 'commander';
import path from 'path';
import { fileURLToPath } from 'url';
import { SpecHubClient } from './spec-hub-client.js';
import { RepoSync } from './repo-sync.js';
import { ReverseSync } from './reverse-sync.js';
import { parseSpec } from './parser.js';
import { loadConfig } from './config-loader.js';
import { sync as forwardSync } from './spec-hub-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const program = new Command();

program
  .name('spec-sync')
  .description('Bi-directional OpenAPI <-> Postman sync tool')
  .version('2.0.0');

/**
 * Add common options to a command
 */
function addCommonOptions(cmd) {
  return cmd
    .requiredOption('-s, --spec <path>', 'Path to OpenAPI spec file')
    .option('-w, --workspace <id>', 'Postman workspace ID')
    .option('-k, --api-key <key>', 'Postman API key')
    .option('-c, --config <path>', 'Path to sync.config.json')
    .option('-d, --dry-run', 'Preview changes without applying', false);
}

/**
 * Load config and merge with CLI options
 */
function getConfig(options) {
  const config = loadConfig({
    workspace: options.workspace,
    apiKey: options.apiKey,
    config: options.config,
    output: options.output,
    strategy: options.strategy
  });

  return config;
}

/**
 * Validate required options
 */
function validateConfig(config) {
  if (!config.workspace) {
    console.error('Error: Workspace ID required. Set POSTMAN_WORKSPACE_ID, use --workspace, or configure in sync.config.json');
    process.exit(1);
  }
  if (!config._apiKey) {
    console.error('Error: API key required. Set POSTMAN_API_KEY or use --api-key');
    process.exit(1);
  }
}

// ============================================================
// FORWARD SYNC COMMAND
// ============================================================

const forwardCmd = program
  .command('forward')
  .description('Forward sync: OpenAPI spec -> Postman collections');

addCommonOptions(forwardCmd)
  .option('-t, --test-level <level>', 'Test level: smoke, contract, all, none', 'all')
  .option('--export-to-repo <path>', 'Also export collections to repo after sync')
  .action(async (options) => {
    const config = getConfig(options);
    validateConfig(config);

    console.log('\nForward Sync: OpenAPI -> Postman');
    console.log('='.repeat(50));

    if (config._configPath) {
      console.log(`Using config: ${config._configPath}`);
    }

    try {
      // Call sync directly instead of execSync
      const result = await forwardSync({
        spec: options.spec,
        workspaceId: config.workspace,
        apiKey: config._apiKey,
        testLevel: options.testLevel,
        dryRun: options.dryRun
      });

      // Export to repo if requested
      if (options.exportToRepo && !options.dryRun) {
        console.log('\nExporting to repo...');
        await runRepoSync(options.spec, options.exportToRepo, config);
      }

      return result;
    } catch (error) {
      console.error(`Forward sync failed: ${error.message}`);
      process.exit(1);
    }
  });

// ============================================================
// REPO SYNC COMMAND
// ============================================================

const repoCmd = program
  .command('repo')
  .description('Export Postman collections and environments to repo');

addCommonOptions(repoCmd)
  .option('-o, --output <dir>', 'Output directory')
  .option('--no-envs', 'Skip environment export')
  .action(async (options) => {
    const config = getConfig(options);
    validateConfig(config);

    const outputDir = options.output || config.repoSync.outputDir || '.';
    await runRepoSync(options.spec, outputDir, config, options.envs);
  });

/**
 * Run repo sync operation
 */
async function runRepoSync(specPath, outputDir, config, includeEnvs = true) {
  console.log('\nRepo Sync: Postman -> Filesystem');
  console.log('='.repeat(50));

  if (config._configPath) {
    console.log(`Using config: ${config._configPath}`);
  }

  const client = new SpecHubClient(config._apiKey, config.workspace);
  const repoSync = new RepoSync(client, {
    collectionsDir: path.join(config.repoSync.outputDir, config.repoSync.collections.directory),
    environmentsDir: path.join(config.repoSync.outputDir, config.repoSync.environments.directory),
    manifestFile: path.join(config.repoSync.outputDir, config.repoSync.manifest.filename),
    sortKeys: config.repoSync.sortKeys,
    indent: config.repoSync.prettyPrint ? 2 : 0
  });

  const spec = await parseSpec(specPath);
  const specName = spec.info?.title || 'api';

  console.log(`\n[1] Fetching collections for: ${specName}`);

  // Get all collections in workspace
  const allCollections = await client.getWorkspaceCollections();

  // Filter to collections matching this spec
  const relevantCollections = allCollections
    .filter(c =>
      c.name === specName ||
      c.name === `${specName} - Smoke Tests` ||
      c.name === `${specName} - Contract Tests`
    )
    .map(c => ({
      uid: c.uid,
      type: c.name.includes('Smoke') ? 'smoke' :
            c.name.includes('Contract') ? 'contract' : 'main'
    }));

  if (relevantCollections.length === 0) {
    console.log('    No matching collections found');
    return { collections: [], environments: [] };
  }

  console.log(`    Found ${relevantCollections.length} collections`);

  const collections = await repoSync.exportCollections(
    specName,
    relevantCollections,
    outputDir
  );

  // Export environments
  let environments = [];
  if (includeEnvs) {
    console.log('\n[2] Exporting environments...');
    const allEnvs = await client.getWorkspaceEnvironments();

    // Filter to environments matching this spec
    const relevantEnvs = allEnvs
      .filter(e => e.name.startsWith(specName))
      .map(e => ({ uid: e.uid, name: e.name }));

    if (relevantEnvs.length > 0) {
      environments = await repoSync.exportEnvironments(specName, relevantEnvs, outputDir);
    } else {
      console.log('    No matching environments found');
    }
  }

  // Update manifest
  console.log('\n[3] Updating manifest...');
  await repoSync.updateManifest(outputDir, {
    specPath,
    collections,
    environments
  });

  console.log('\nRepo sync complete');
  console.log(`  Collections: ${collections.length}`);
  console.log(`  Environments: ${environments.length}`);

  return { collections, environments };
}

// ============================================================
// REVERSE SYNC COMMAND
// ============================================================

const reverseCmd = program
  .command('reverse')
  .description('Reverse sync: Postman collection -> OpenAPI spec');

addCommonOptions(reverseCmd)
  .requiredOption('-C, --collection <uid>', 'Collection UID to sync from')
  .option('--strategy <strategy>', 'Conflict resolution: spec-wins, collection-wins, interactive')
  .option('--output <path>', 'Output path for updated spec')
  .option('--no-tests', 'Skip syncing tests as vendor extensions')
  .action(async (options) => {
    const config = getConfig(options);
    validateConfig(config);

    const strategy = options.strategy || config.reverseSync.conflictStrategy;

    console.log('\nReverse Sync: Postman -> OpenAPI');
    console.log('='.repeat(50));

    if (config._configPath) {
      console.log(`Using config: ${config._configPath}`);
    }

    const client = new SpecHubClient(config._apiKey, config.workspace);
    const reverseSync = new ReverseSync(client, {
      conflictStrategy: strategy,
      storeTestsAsExtension: options.tests !== false
    });

    const result = await reverseSync.reverseSync(
      options.spec,
      options.collection,
      {
        dryRun: options.dryRun,
        outputPath: options.output
      }
    );

    if (result.status === 'dry-run') {
      console.log('\nDry Run Results:');
      console.log(`  Would apply: ${result.wouldApply} changes`);
      console.log(`  Would skip: ${result.wouldSkip} blocked changes`);
      console.log(`  Needs review: ${result.wouldReview} changes`);
    }

    return result;
  });

// ============================================================
// BIDIRECTIONAL SYNC COMMAND
// ============================================================

const bidiCmd = program
  .command('bidirectional')
  .alias('bidi')
  .description('Full bidirectional sync workflow');

addCommonOptions(bidiCmd)
  .option('-o, --output <dir>', 'Repo output directory')
  .option('--auto-merge', 'Automatically apply safe changes', false)
  .option('--strategy <strategy>', 'Conflict resolution strategy')
  .action(async (options) => {
    const config = getConfig(options);
    validateConfig(config);

    console.log('\nBidirectional Sync: Full Workflow');
    console.log('='.repeat(50));

    if (config._configPath) {
      console.log(`Using config: ${config._configPath}`);
    }

    const client = new SpecHubClient(config._apiKey, config.workspace);
    const outputDir = options.output || config.repoSync.outputDir || '.';

    // Stage 1: Forward sync
    console.log('\n[Stage 1] Forward Sync (Spec -> Postman)');
    console.log('-'.repeat(40));

    let forwardResult;
    try {
      forwardResult = await forwardSync({
        spec: options.spec,
        workspaceId: config.workspace,
        apiKey: config._apiKey,
        testLevel: 'all',
        dryRun: options.dryRun
      });
    } catch (error) {
      console.error('Forward sync failed:', error.message);
      process.exit(1);
    }

    // Stage 2: Repo sync
    console.log('\n[Stage 2] Repo Sync (Postman -> Files)');
    console.log('-'.repeat(40));

    if (!options.dryRun) {
      await runRepoSync(options.spec, outputDir, config);
    } else {
      console.log('  Skipped (dry-run mode)');
    }

    // Stage 3: Check for reverse sync and execute if auto-merge
    console.log('\n[Stage 3] Reverse Sync Check');
    console.log('-'.repeat(40));

    const repoSync = new RepoSync(client);
    const status = await repoSync.getStatus(outputDir);

    if (status.needsSync) {
      console.log('  Changes detected in Postman');
      console.log(`    Collections: ${status.changes.collections.length}`);
      console.log(`    Environments: ${status.changes.environments.length}`);

      if (options.autoMerge && !options.dryRun) {
        console.log('\n  Auto-merging safe changes...');

        const strategy = options.strategy || config.reverseSync.conflictStrategy;
        const reverseSync = new ReverseSync(client, {
          conflictStrategy: strategy,
          storeTestsAsExtension: config.reverseSync.storeTestsAs === 'x-postman-tests'
        });

        // Get the main collection UID from manifest
        const manifest = repoSync.loadManifest(outputDir);
        const mainCollectionUid = Object.keys(manifest.collections).find(
          uid => manifest.collections[uid].type === 'main'
        );

        if (mainCollectionUid) {
          console.log(`  Syncing from collection: ${mainCollectionUid}`);

          const result = await reverseSync.reverseSync(
            options.spec,
            mainCollectionUid,
            { dryRun: false }
          );

          console.log(`\n  Reverse sync complete:`);
          console.log(`    Applied: ${result.applied?.length || 0} changes`);
          console.log(`    Skipped: ${result.skipped?.length || 0} changes`);

          if (result.status === 'synced') {
            // Re-export to repo after reverse sync
            console.log('\n  Re-exporting to repo...');
            await runRepoSync(options.spec, outputDir, config);
          }
        } else {
          console.log('  No main collection found in manifest');
        }
      } else if (!options.autoMerge) {
        console.log('\n  Run with --auto-merge to apply safe changes');
        console.log('  Or run reverse sync manually:');

        const manifest = repoSync.loadManifest(outputDir);
        const mainCollectionUid = Object.keys(manifest.collections).find(
          uid => manifest.collections[uid].type === 'main'
        );

        if (mainCollectionUid) {
          console.log(`    spec-sync reverse --spec ${options.spec} --collection ${mainCollectionUid}`);
        }
      }
    } else {
      console.log('  No changes detected - in sync');
    }

    console.log('\nBidirectional sync complete');
  });

// ============================================================
// STATUS COMMAND
// ============================================================

program
  .command('status')
  .description('Show sync status and detect drift')
  .option('-s, --spec <path>', 'Path to OpenAPI spec')
  .option('-o, --output <dir>', 'Repo output directory')
  .option('-w, --workspace <id>', 'Postman workspace ID')
  .option('-k, --api-key <key>', 'Postman API key')
  .option('-c, --config <path>', 'Path to sync.config.json')
  .action(async (options) => {
    const config = getConfig(options);

    if (!config.workspace || !config._apiKey) {
      console.error('Error: Workspace ID and API key required');
      process.exit(1);
    }

    console.log('\nSync Status');
    console.log('='.repeat(50));

    if (config._configPath) {
      console.log(`Using config: ${config._configPath}`);
    }

    const client = new SpecHubClient(config._apiKey, config.workspace);
    const outputDir = options.output || config.repoSync.outputDir || '.';
    const repoSync = new RepoSync(client);

    try {
      const status = await repoSync.getStatus(outputDir);

      console.log(`\nLast Sync: ${status.lastSync || 'Never'}`);
      console.log(`Spec: ${status.specPath || 'Not configured'}`);
      console.log(`Workspace: ${status.workspaceId || config.workspace}`);
      console.log(`\nTracked Collections: ${status.trackedCollections}`);
      console.log(`Tracked Environments: ${status.trackedEnvironments}`);

      if (status.needsSync) {
        console.log('\nChanges Detected:');

        for (const coll of status.changes.collections) {
          console.log(`  Collection: ${coll.name} (${coll.change})`);
        }

        for (const env of status.changes.environments) {
          console.log(`  Environment: ${env.name} (${env.change})`);
        }

        console.log('\nRun "spec-sync repo" to export changes');
        console.log('Run "spec-sync bidi --auto-merge" to sync bidirectionally');
      } else {
        console.log('\nStatus: In sync');
      }
    } catch (error) {
      if (error.message.includes('manifest')) {
        console.log('\nNo sync manifest found. Run "spec-sync repo" first.');
      } else {
        console.error(`Error: ${error.message}`);
      }
    }
  });

// ============================================================
// PARSE AND RUN
// ============================================================

program.parse();
