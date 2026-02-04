#!/usr/bin/env node

/**
 * Spec-Derived Contract Test Generator
 * 
 * CLI tool that generates Postman collections with contract tests
 * from OpenAPI 3.x specifications.
 * 
 * Usage:
 *   node src/index.js --spec specs/sample-api.yaml --output output/collection.json
 *   node src/index.js --spec https://example.com/api.yaml --base-url https://api.example.com
 */

import { parseSpec, extractEndpoints, getBaseUrl } from './parser.js';
import { buildCollection } from './builder.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// CLI argument parsing
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    spec: null,
    output: null,
    baseUrl: null,
    environment: null,
    collectionName: null,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    switch (arg) {
      case '--spec':
      case '-s':
        options.spec = args[++i];
        break;
      case '--output':
      case '-o':
        options.output = args[++i];
        break;
      case '--base-url':
      case '-b':
        options.baseUrl = args[++i];
        break;
      case '--environment':
      case '-e':
        options.environment = args[++i];
        break;
      case '--collection-name':
      case '-n':
        options.collectionName = args[++i];
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
    }
  }

  return options;
}

// Show help
function showHelp() {
  console.log(`
Spec-Derived Contract Test Generator

Generate Postman collections with contract tests from OpenAPI specifications.
All tests are derived from spec metadata - no manual test writing required.

Usage:
  node src/index.js --spec <path> [options]

Options:
  --spec, -s            Path or URL to OpenAPI spec (YAML or JSON) [required]
  --output, -o          Output path for collection JSON [default: output/collection.json]
  --base-url, -b        Override base URL from spec
  --environment, -e     Output path for environment JSON [default: output/environment.json]
  --collection-name, -n Custom name for the collection
  --help, -h            Show this help message

Examples:
  # Basic usage
  node src/index.js --spec specs/sample-api.yaml

  # With custom output paths
  node src/index.js --spec specs/api.yaml --output collections/my-api.json

  # With URL spec and custom base URL
  node src/index.js --spec https://example.com/api.yaml --base-url https://api.prod.com

  # Run generated collection with Postman CLI
  postman collection run output/collection.json --environment output/environment.json

Demo Scenarios:
  1. Initial generation: Generate collection with tests from spec
  2. Rename scenario: Change endpoint path in spec, regenerate - tests follow automatically
  3. Schema change: Add required field to response, regenerate - validation updates
  4. New endpoint: Add to spec, regenerate - tests created automatically
`);
}

// Validate options
function validateOptions(options) {
  if (options.help) {
    showHelp();
    process.exit(0);
  }

  if (!options.spec) {
    console.error('Error: --spec is required');
    showHelp();
    process.exit(1);
  }

  // Set defaults
  if (!options.output) {
    options.output = path.join(process.cwd(), 'output', 'collection.json');
  }
  
  if (!options.environment) {
    options.environment = path.join(process.cwd(), 'output', 'environment.json');
  }
}

// Generate environment file
function generateEnvironment(api, options) {
  const baseUrl = options.baseUrl || getBaseUrl(api);
  
  const environment = {
    id: `env-${Date.now()}`,
    name: `${api.info?.title || 'API'} Environment`,
    values: [
      {
        key: 'baseUrl',
        value: baseUrl,
        type: 'default',
        enabled: true
      },
      {
        key: 'RESPONSE_TIME_THRESHOLD',
        value: '2000',
        type: 'default',
        enabled: true
      },
      {
        key: 'auth_token',
        value: '',
        type: 'secret',
        enabled: true
      }
    ],
    _postman_variable_scope: 'environment'
  };

  // Add variables for common path parameters
  const endpoints = extractEndpoints(api);
  const pathParams = new Set();
  
  for (const endpoint of endpoints) {
    const params = endpoint.path.match(/\{([^}]+)\}/g) || [];
    for (const param of params) {
      pathParams.add(param.replace(/[{}]/g, ''));
    }
  }
  
  for (const param of pathParams) {
    environment.values.push({
      key: param,
      value: `test-${param}-001`,
      type: 'default',
      enabled: true
    });
  }

  return environment;
}

// Main function
async function main() {
  try {
    const options = parseArgs();
    validateOptions(options);

    console.log('🔍 Parsing OpenAPI spec...');
    console.log(`   Source: ${options.spec}`);
    
    // Parse the spec
    const api = await parseSpec(options.spec);
    
    console.log(`✅ Parsed: ${api.info?.title || 'Untitled API'} (${api.info?.version || 'unknown version'})`);
    
    // Extract endpoints
    console.log('📋 Extracting endpoints...');
    const endpoints = extractEndpoints(api);
    console.log(`   Found ${endpoints.length} endpoints`);
    
    // Build collection
    console.log('🔨 Building Postman collection...');
    const collection = buildCollection(api, endpoints, {
      collectionName: options.collectionName,
      baseUrl: options.baseUrl
    });
    
    // Ensure output directory exists
    const outputDir = path.dirname(options.output);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    // Write collection
    const collectionJson = collection.toJSON();
    fs.writeFileSync(options.output, JSON.stringify(collectionJson, null, 2));
    console.log(`✅ Collection written to: ${options.output}`);
    
    // Generate and write environment
    const environment = generateEnvironment(api, options);
    const envDir = path.dirname(options.environment);
    if (!fs.existsSync(envDir)) {
      fs.mkdirSync(envDir, { recursive: true });
    }
    fs.writeFileSync(options.environment, JSON.stringify(environment, null, 2));
    console.log(`✅ Environment written to: ${options.environment}`);
    
    // Summary
    console.log('\n📊 Generation Summary:');
    console.log(`   Endpoints: ${endpoints.length}`);
    console.log(`   Tags: ${[...new Set(endpoints.flatMap(e => e.tags))].length}`);
    
    // Count tests generated
    let totalTests = 0;
    for (const endpoint of endpoints) {
      const responseCodes = Object.keys(endpoint.responses);
      // Each endpoint gets: status code, response time, content-type, schema, required fields
      totalTests += 2; // status + response time
      if (endpoint.responses['200']?.content || endpoint.responses['201']?.content) {
        totalTests += 2; // content-type + schema
      }
      const successResponse = endpoint.responses['200'] || endpoint.responses['201'];
      if (successResponse?.content?.['application/json']?.schema?.required) {
        totalTests += 1; // required fields
      }
    }
    console.log(`   Estimated Tests: ~${totalTests}`);
    
    console.log('\n🚀 Next Steps:');
    console.log(`   1. Import collection: postman collection run ${options.output}`);
    console.log(`   2. Or import into Postman app and configure environment variables`);
    console.log(`   3. Set auth_token in environment for authenticated endpoints`);
    
    // Demo scenarios reminder
    console.log('\n💡 Demo Scenarios:');
    console.log('   Try these to see spec-driven test generation in action:');
    console.log('   1. Rename an endpoint path in the spec → regenerate → tests follow');
    console.log('   2. Add a required field to a response schema → regenerate → validation updates');
    console.log('   3. Add a new endpoint → regenerate → tests created automatically');
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    if (error.message.includes('ENOENT')) {
      console.error('   Could not find the spec file. Check the path and try again.');
    } else if (error.message.includes('parse')) {
      console.error('   Could not parse the OpenAPI spec. Ensure it is valid YAML/JSON.');
    }
    
    process.exit(1);
  }
}

// Run main
main();
