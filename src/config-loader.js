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

  reverseSync: {
    enabled: true,
    conflictStrategy: 'spec-wins',
    storeTestsAs: 'x-postman-tests',
    autoCreatePR: true,
    prLabels: ['auto-generated', 'documentation']
  },

  repoSync: {
    enabled: true,
    outputDir: 'postman',
    format: 'json',
    prettyPrint: true,
    sortKeys: true,
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
    console.warn(`Warning: Failed to load config from ${configPath}: ${error.message}`);
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

  // Apply environment variables
  if (process.env.POSTMAN_WORKSPACE_ID) {
    config.workspace = process.env.POSTMAN_WORKSPACE_ID;
  }

  // Apply CLI options (highest priority)
  if (cliOptions.workspace) {
    config.workspace = cliOptions.workspace;
  }

  if (cliOptions.output) {
    config.repoSync.outputDir = cliOptions.output;
  }

  if (cliOptions.strategy) {
    config.reverseSync.conflictStrategy = cliOptions.strategy;
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

export default {
  loadConfig,
  getSpecConfig,
  getCollectionName,
  getCollectionTags,
  DEFAULT_CONFIG
};
