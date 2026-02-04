#!/usr/bin/env node

/**
 * Configuration Loader
 *
 * Loads and merges configuration from sync.config.json with CLI options.
 * Priority: CLI args > environment variables > config file > defaults
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_CONFIG = {
  version: '1.0',
  workspace: null,

  // Spec configuration
  spec: null,

  // Logging configuration
  logging: {
    level: 'info',  // debug, info, warn, error, silent
    format: 'text', // text, json
    colors: true
  },

  // Forward sync configuration
  forwardSync: {
    testLevel: 'all',
    exportToRepo: false
  },

  // Reverse sync configuration
  reverseSync: {
    enabled: true,
    conflictStrategy: 'spec-wins',
    storeTestsAs: 'x-postman-tests',
    autoCreatePR: true,
    prLabels: ['auto-generated', 'documentation'],
    includeTests: true
  },

  // Repo sync configuration
  repoSync: {
    enabled: true,
    outputDir: 'postman',
    format: 'json',
    prettyPrint: true,
    sortKeys: true,
    includeEnvironments: true,
    collections: {
      directory: 'collections',
      filenamePattern: '{{slug}}-{{type}}.collection.json'
    },
    environments: {
      directory: 'environments',
      filenamePattern: '{{slug}}-{{server}}.environment.json',
      redactSecrets: true,
      secretPatterns: [
        '^api[_-]?key',
        '^token',
        '^secret',
        '^password',
        '^auth',
        '^bearer'
      ]
    },
    manifest: {
      enabled: true,
      filename: '.sync-manifest.json'
    }
  },

  // Bidirectional sync configuration
  bidirectional: {
    autoMerge: false
  },

  // Global options
  dryRun: false,

  forkWorkflow: {
    enabled: true,
    autoMergeApproved: false,
    requireReviewers: []
  },

  ci: {
    checkBreakingChanges: true,
    failOnBreaking: false,
    scheduleReverseSyncCheck: '0 * * * *'
  }
};

/**
 * Find config file by walking up directory tree
 */
function findConfigFile(startDir = process.cwd()) {
  let currentDir = startDir;
  const configNames = ['sync.config.json', '.sync.config.json'];

  while (currentDir !== path.dirname(currentDir)) {
    for (const name of configNames) {
      const configPath = path.join(currentDir, name);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Load config file
 */
function loadConfigFile(configPath) {
  if (!configPath || !fs.existsSync(configPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);

    // Expand environment variables in workspace field
    if (config.workspace && config.workspace.startsWith('${') && config.workspace.endsWith('}')) {
      const envVar = config.workspace.slice(2, -1);
      config.workspace = process.env[envVar] || null;
    }

    return config;
  } catch (error) {
    // Use process.stderr directly to avoid circular dependency with logger
    process.stderr.write(`Warning: Failed to load config from ${configPath}: ${error.message}\n`);
    return null;
  }
}

/**
 * Deep merge two objects (target wins on conflicts)
 */
function deepMerge(base, override) {
  if (!override) return base;
  if (!base) return override;

  const result = { ...base };

  for (const [key, value] of Object.entries(override)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (typeof value === 'object' && !Array.isArray(value) &&
        typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Load configuration with priority merging
 * Priority: cliOptions > envVars > configFile > defaults
 */
export function loadConfig(cliOptions = {}) {
  // Start with defaults
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

  // Find and load config file
  const configPath = cliOptions.config || findConfigFile();
  const fileConfig = loadConfigFile(configPath);

  if (fileConfig) {
    config = deepMerge(config, fileConfig);
    config._configPath = configPath;
  }

  // Apply environment variables (higher priority than config file)
  
  // Core credentials and workspace
  if (process.env.POSTMAN_WORKSPACE_ID) {
    config.workspace = process.env.POSTMAN_WORKSPACE_ID;
  }
  
  // Spec file path
  if (process.env.SPEC_FILE) {
    config.spec = process.env.SPEC_FILE;
  }
  
  // Forward sync options
  if (process.env.TEST_LEVEL) {
    config.forwardSync.testLevel = process.env.TEST_LEVEL;
  }
  
  if (process.env.EXPORT_TO_REPO) {
    config.forwardSync.exportToRepo = process.env.EXPORT_TO_REPO === 'true';
  }
  
  // Repo sync options
  if (process.env.OUTPUT_DIR) {
    config.repoSync.outputDir = process.env.OUTPUT_DIR;
  }
  
  if (process.env.INCLUDE_ENVS) {
    config.repoSync.includeEnvironments = process.env.INCLUDE_ENVS !== 'false';
  }
  
  // Reverse sync options
  if (process.env.CONFLICT_STRATEGY) {
    config.reverseSync.conflictStrategy = process.env.CONFLICT_STRATEGY;
  }
  
  if (process.env.INCLUDE_TESTS) {
    config.reverseSync.includeTests = process.env.INCLUDE_TESTS !== 'false';
  }
  
  // Bidirectional sync options
  if (process.env.AUTO_MERGE) {
    config.bidirectional.autoMerge = process.env.AUTO_MERGE === 'true';
  }
  
  // Global options
  if (process.env.DRY_RUN) {
    config.dryRun = process.env.DRY_RUN === 'true';
  }

  // Logging options
  if (process.env.LOG_LEVEL) {
    config.logging.level = process.env.LOG_LEVEL.toLowerCase();
  }

  if (process.env.LOG_FORMAT) {
    config.logging.format = process.env.LOG_FORMAT.toLowerCase();
  }

  // Apply CLI options (highest priority)
  if (cliOptions.workspace) {
    config.workspace = cliOptions.workspace;
  }
  
  if (cliOptions.spec) {
    config.spec = cliOptions.spec;
  }

  if (cliOptions.output) {
    config.repoSync.outputDir = cliOptions.output;
  }

  if (cliOptions.strategy) {
    config.reverseSync.conflictStrategy = cliOptions.strategy;
  }
  
  if (cliOptions.testLevel) {
    config.forwardSync.testLevel = cliOptions.testLevel;
  }
  
  if (cliOptions.exportToRepo !== undefined) {
    config.forwardSync.exportToRepo = cliOptions.exportToRepo;
  }
  
  if (cliOptions.autoMerge !== undefined) {
    config.bidirectional.autoMerge = cliOptions.autoMerge;
  }
  
  if (cliOptions.dryRun !== undefined) {
    config.dryRun = cliOptions.dryRun;
  }
  
  if (cliOptions.envs !== undefined) {
    config.repoSync.includeEnvironments = cliOptions.envs;
  }
  
  if (cliOptions.tests !== undefined) {
    config.reverseSync.includeTests = cliOptions.tests;
  }

  // Store API key separately (never in config file)
  config._apiKey = cliOptions.apiKey || process.env.POSTMAN_API_KEY;

  return config;
}

/**
 * Get spec configuration from loaded config
 */
export function getSpecConfig(config, specPath) {
  if (!config.specs) {
    return null;
  }

  // Try to find matching spec config
  const specName = path.basename(specPath, path.extname(specPath));

  for (const [key, specConfig] of Object.entries(config.specs)) {
    if (specConfig.path === specPath || key === specName) {
      return specConfig;
    }
  }

  return null;
}

/**
 * Get collection naming pattern
 */
export function getCollectionName(config, specTitle, collectionType) {
  const specConfig = config.specs ? Object.values(config.specs)[0] : null;
  const pattern = specConfig?.collections?.[collectionType]?.namePattern;

  if (!pattern) {
    // Default naming
    switch (collectionType) {
      case 'main':
        return specTitle;
      case 'smoke':
        return `${specTitle} - Smoke Tests`;
      case 'contract':
        return `${specTitle} - Contract Tests`;
      default:
        return specTitle;
    }
  }

  return pattern.replace('{{spec.info.title}}', specTitle);
}

/**
 * Get collection tags
 */
export function getCollectionTags(config, collectionType) {
  const specConfig = config.specs ? Object.values(config.specs)[0] : null;
  const tags = specConfig?.collections?.[collectionType]?.tags;

  if (!tags) {
    // Default tags
    switch (collectionType) {
      case 'main':
        return ['generated', 'docs'];
      case 'smoke':
        return ['generated', 'smoke'];
      case 'contract':
        return ['generated', 'contract'];
      default:
        return ['generated'];
    }
  }

  return tags;
}

export { DEFAULT_CONFIG };
