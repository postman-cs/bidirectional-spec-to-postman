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
import { createLogger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = createLogger({ name: 'cli' });

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
    .option('-s, --spec <path>', 'Path to OpenAPI spec file (can also be set via SPEC_FILE env or config)')
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
    spec: options.spec,
    output: options.output,
    strategy: options.strategy,
    testLevel: options.testLevel,
    exportToRepo: options.exportToRepo,
    autoMerge: options.autoMerge,
    dryRun: options.dryRun,
    envs: options.envs,
    tests: options.tests
  });

  return config;
}

/**
 * Validate required options
 */
function validateConfig(config) {
  if (!config.workspace) {
    logger.error('Workspace ID required. Set POSTMAN_WORKSPACE_ID, use --workspace, or configure in sync.config.json');
    process.exit(1);
  }
  if (!config._apiKey) {
    logger.error('API key required. Set POSTMAN_API_KEY or use --api-key');
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

    logger.info('Forward Sync: OpenAPI -> Postman');
    logger.info('='.repeat(50));

    if (config._configPath) {
      logger.info(`Using config: ${config._configPath}`);
    }

    // Use spec from CLI or config
    const specPath = options.spec || config.spec;
    if (!specPath) {
      logger.error('Spec file path is required. Use --spec, set SPEC_FILE env var, or configure in sync.config.json');
      process.exit(1);
    }

    // Use test level from CLI, config, or default
    const testLevel = options.testLevel || config.forwardSync.testLevel;
    const dryRun = options.dryRun || config.dryRun;
    const exportToRepo = options.exportToRepo || (config.forwardSync.exportToRepo ? config.repoSync.outputDir : null);

    try {
      // Call sync directly instead of execSync
      const result = await forwardSync({
        spec: specPath,
        workspaceId: config.workspace,
        apiKey: config._apiKey,
        testLevel: testLevel,
        dryRun: dryRun
      });

      // Export to repo if requested
      if (exportToRepo && !dryRun) {
        logger.info('Exporting to repo...');
        await runRepoSync(specPath, exportToRepo, config);
      }

      return result;
    } catch (error) {
      logger.error(`Forward sync failed: ${error.message}`);
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

    // Use spec from CLI or config
    const specPath = options.spec || config.spec;
    if (!specPath) {
      logger.error('Error: Spec file path is required. Use --spec, set SPEC_FILE env var, or configure in sync.config.json');
      process.exit(1);
    }

    const outputDir = options.output || config.repoSync.outputDir || '.';
    const includeEnvs = options.envs !== undefined ? options.envs : config.repoSync.includeEnvironments;
    const dryRun = options.dryRun || config.dryRun;
    await runRepoSync(specPath, outputDir, config, includeEnvs, dryRun);
  });

/**
 * Run repo sync operation
 */
async function runRepoSync(specPath, outputDir, config, includeEnvs = true, dryRun = false) {
  logger.info('\nRepo Sync: Postman -> Filesystem');
  logger.info('='.repeat(50));

  if (dryRun) {
    logger.info('DRY RUN - no files will be written');
  }

  if (config._configPath) {
    logger.info(`Using config: ${config._configPath}`);
  }

  const client = new SpecHubClient(config._apiKey, config.workspace);
  
  // Avoid double-prefixing: only use the subdirectory names, not the full outputDir
  // The outputDir is the base directory, collections.directory is relative to it
  const repoSync = new RepoSync(client, {
    collectionsDir: config.repoSync.collections.directory,
    environmentsDir: config.repoSync.environments.directory,
    manifestFile: config.repoSync.manifest.filename,
    sortKeys: config.repoSync.sortKeys,
    indent: config.repoSync.prettyPrint ? 2 : 0,
    dryRun: dryRun
  });

  const spec = await parseSpec(specPath);
  const specName = spec.info?.title || 'api';

  logger.info(`\n[1] Fetching collections for: ${specName}`);

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
    logger.info('    No matching collections found');
    return { collections: [], environments: [] };
  }

  logger.info(`    Found ${relevantCollections.length} collections`);

  const collections = await repoSync.exportCollections(
    specName,
    relevantCollections,
    outputDir
  );

  // Export environments
  let environments = [];
  if (includeEnvs) {
    logger.info('\n[2] Exporting environments...');
    const allEnvs = await client.getWorkspaceEnvironments();

    // Filter to environments matching this spec
    const relevantEnvs = allEnvs
      .filter(e => e.name.startsWith(specName))
      .map(e => ({ uid: e.uid, name: e.name }));

    if (relevantEnvs.length > 0) {
      environments = await repoSync.exportEnvironments(specName, relevantEnvs, outputDir);
    } else {
      logger.info('    No matching environments found');
    }
  }

  // Update manifest
  logger.info('\n[3] Updating manifest...');
  await repoSync.updateManifest(outputDir, {
    specPath,
    collections,
    environments
  });

  logger.info('\nRepo sync complete');
  logger.info(`  Collections: ${collections.length}`);
  logger.info(`  Environments: ${environments.length}`);

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

    // Use spec from CLI or config
    const specPath = options.spec || config.spec;
    if (!specPath) {
      logger.error('Error: Spec file path is required. Use --spec, set SPEC_FILE env var, or configure in sync.config.json');
      process.exit(1);
    }

    const strategy = options.strategy || config.reverseSync.conflictStrategy;
    const dryRun = options.dryRun || config.dryRun;
    const includeTests = options.tests !== undefined ? options.tests : config.reverseSync.includeTests;

    logger.info('\nReverse Sync: Postman -> OpenAPI');
    logger.info('='.repeat(50));

    if (config._configPath) {
      logger.info(`Using config: ${config._configPath}`);
    }

    const client = new SpecHubClient(config._apiKey, config.workspace);
    const reverseSync = new ReverseSync(client, {
      conflictStrategy: strategy,
      storeTestsAsExtension: includeTests
    });

    const result = await reverseSync.reverseSync(
      specPath,
      options.collection,
      {
        dryRun: dryRun,
        outputPath: options.output
      }
    );

    if (result.status === 'dry-run') {
      logger.info('\nDry Run Results:');
      logger.info(`  Would apply: ${result.wouldApply} changes`);
      logger.info(`  Would skip: ${result.wouldSkip} blocked changes`);
      logger.info(`  Needs review: ${result.wouldReview} changes`);
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

    logger.info('\nBidirectional Sync: Full Workflow');
    logger.info('='.repeat(50));

    if (config._configPath) {
      logger.info(`Using config: ${config._configPath}`);
    }

    // Use spec from CLI or config
    const specPath = options.spec || config.spec;
    if (!specPath) {
      logger.error('Spec file path is required. Use --spec, set SPEC_FILE env var, or configure in sync.config.json');
      process.exit(1);
    }

    const client = new SpecHubClient(config._apiKey, config.workspace);
    const outputDir = options.output || config.repoSync.outputDir || '.';
    const dryRun = options.dryRun || config.dryRun;
    const autoMerge = options.autoMerge !== undefined ? options.autoMerge : config.bidirectional.autoMerge;

    // Stage 1: Forward sync
    logger.info('\n[Stage 1] Forward Sync (Spec -> Postman)');
    logger.info('-'.repeat(40));

    let forwardResult;
    try {
      forwardResult = await forwardSync({
        spec: specPath,
        workspaceId: config.workspace,
        apiKey: config._apiKey,
        testLevel: config.forwardSync.testLevel,
        dryRun: dryRun
      });
    } catch (error) {
      logger.error('Forward sync failed:', error.message);
      process.exit(1);
    }

    // Stage 2: Repo sync
    logger.info('\n[Stage 2] Repo Sync (Postman -> Files)');
    logger.info('-'.repeat(40));

    if (!dryRun) {
      await runRepoSync(specPath, outputDir, config);
    } else {
      logger.info('  Skipped (dry-run mode)');
    }

    // Stage 3: Check for reverse sync and execute if auto-merge
    logger.info('\n[Stage 3] Reverse Sync Check');
    logger.info('-'.repeat(40));

    const repoSync = new RepoSync(client);
    const status = await repoSync.getStatus(outputDir);

    if (status.needsSync) {
      logger.info('  Changes detected in Postman');
      logger.info(`    Collections: ${status.changes.collections.length}`);
      logger.info(`    Environments: ${status.changes.environments.length}`);

      if (autoMerge && !dryRun) {
        logger.info('\n  Auto-merging safe changes...');

        const strategy = options.strategy || config.reverseSync.conflictStrategy;
        const reverseSync = new ReverseSync(client, {
          conflictStrategy: strategy,
          storeTestsAsExtension: config.reverseSync.includeTests
        });

        // Get the main collection UID from manifest
        const manifest = repoSync.loadManifest(outputDir);
        const mainCollectionUid = Object.keys(manifest.collections).find(
          uid => manifest.collections[uid].type === 'main'
        );

        if (mainCollectionUid) {
          logger.info(`  Syncing from collection: ${mainCollectionUid}`);

          const result = await reverseSync.reverseSync(
            specPath,
            mainCollectionUid,
            { dryRun: false }
          );

          logger.info(`\n  Reverse sync complete:`);
          logger.info(`    Applied: ${result.applied?.length || 0} changes`);
          logger.info(`    Skipped: ${result.skipped?.length || 0} changes`);

          if (result.status === 'synced') {
            // Re-export to repo after reverse sync
            logger.info('\n  Re-exporting to repo...');
            await runRepoSync(specPath, outputDir, config);
          }
        } else {
          logger.info('  No main collection found in manifest');
        }
      } else if (!autoMerge) {
        logger.info('\n  Run with --auto-merge to apply safe changes');
        logger.info('  Or run reverse sync manually:');

        const manifest = repoSync.loadManifest(outputDir);
        const mainCollectionUid = Object.keys(manifest.collections).find(
          uid => manifest.collections[uid].type === 'main'
        );

        if (mainCollectionUid) {
          logger.info(`    spec-sync reverse --spec ${specPath} --collection ${mainCollectionUid}`);
        }
      }
    } else {
      logger.info('  No changes detected - in sync');
    }

    logger.info('\nBidirectional sync complete');
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
      logger.error('Error: Workspace ID and API key required');
      process.exit(1);
    }

    logger.info('\nSync Status');
    logger.info('='.repeat(50));

    if (config._configPath) {
      logger.info(`Using config: ${config._configPath}`);
    }

    const client = new SpecHubClient(config._apiKey, config.workspace);
    const outputDir = options.output || config.repoSync.outputDir || '.';
    const repoSync = new RepoSync(client);

    try {
      const status = await repoSync.getStatus(outputDir);

      logger.info(`\nLast Sync: ${status.lastSync || 'Never'}`);
      logger.info(`Spec: ${status.specPath || config.spec || 'Not configured'}`);
      logger.info(`Workspace: ${status.workspaceId || config.workspace}`);
      logger.info(`\nTracked Collections: ${status.trackedCollections}`);
      logger.info(`Tracked Environments: ${status.trackedEnvironments}`);

      if (status.needsSync) {
        logger.info('\nChanges Detected:');

        for (const coll of status.changes.collections) {
          logger.info(`  Collection: ${coll.name} (${coll.change})`);
        }

        for (const env of status.changes.environments) {
          logger.info(`  Environment: ${env.name} (${env.change})`);
        }

        logger.info('\nRun "spec-sync repo" to export changes');
        logger.info('Run "spec-sync bidi --auto-merge" to sync bidirectionally');
      } else {
        logger.info('\nStatus: In sync');
      }
    } catch (error) {
      if (error.message.includes('manifest')) {
        logger.info('\nNo sync manifest found. Run "spec-sync repo" first.');
      } else {
        logger.error(`Error: ${error.message}`);
      }
    }
  });

// ============================================================
// PARSE AND RUN
// ============================================================

program.parse();
