# OpenAPI <-> Postman Spec Hub Sync CLI

A Spec Hub-first CLI that synchronizes OpenAPI specs and Postman collections in both directions. Forward sync uploads specs to Spec Hub, generates docs/smoke/contract collections, injects tests, and creates environments. Repo sync exports Postman artifacts to Git with deterministic JSON. Reverse sync brings documentation/examples back into the spec and stores tests as `x-postman-tests`.

> **Note:** This demo is designed for Postman Enterprise prospects to showcase Spec Hub-based synchronization and testing workflows using Postman's native [Spec Hub](https://learning.postman.com/docs/designing-and-developing-your-api/spec-hub/) capabilities.

## >> Problem Statement

When teams use OpenAPI specs as the source of truth, collections, tests, and documentation in Postman often drift from the spec and each other.

**The Traditional Anti-Pattern:**
1. Upload spec to Spec Hub → generate collection
2. Make manual edits and tests in collections
3. Spec updates → collections regenerate
4. Manual edits are lost and Git has no record of Postman changes

**The Solution**: Use Spec Hub native generation plus test injection, repo export, and reverse sync for safe documentation/example updates. Collections stay aligned with the spec, and documentation changes flow back without touching structural contracts.

## * Features

- **Spec Hub forward sync**: Upload/update specs and generate docs/smoke/contract collections
- **Test injection**: Smoke and contract tests injected into Spec Hub-generated collections
- **Bidirectional sync**: Reverse sync applies documentation/examples back to the spec
- **Repo sync**: Export collections/environments to Git with deterministic JSON and secret redaction
- **Change detection + 3-way merge**: Baselines enable safe reverse sync
- **Smart environment generation**: One environment per server in the spec
- **Postman CLI ready**: Works with modern Postman CLI

## - Prerequisites

- Node.js 18+ 
- [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/) installed
- Postman API key
- Target workspace ID

## * Quick Start

### 1. Install Dependencies

```bash
cd demo
npm install
```

### 2. Configure Environment

**Option A: Environment Variables**

```bash
export POSTMAN_API_KEY="your-api-key"
export POSTMAN_WORKSPACE_ID="your-workspace-id"
export SPEC_FILE="specs/sample-api.yaml"  # Optional: default spec path
```

**Option B: Configuration File**

Create `sync.config.json` in your project root:

```json
{
  "$schema": "./sync.config.schema.json",
  "version": "1.0",
  "workspace": "${POSTMAN_WORKSPACE_ID}",
  "spec": "specs/sample-api.yaml",
  
  "forwardSync": {
    "testLevel": "all"
  },
  
  "reverseSync": {
    "conflictStrategy": "spec-wins"
  },
  
  "repoSync": {
    "outputDir": "postman"
  }
}
```

**Option C: CLI Arguments**

```bash
node src/cli.js forward --spec specs/api.yaml --workspace <id> --api-key <key>
```

**Priority**: CLI args > Environment variables > Config file > Defaults

### 3. Forward Sync to Spec Hub

```bash
# Unified CLI (recommended)
node src/cli.js forward --spec specs/sample-api.yaml

# Or forward-only script
npm run sync:spec-hub -- --spec specs/sample-api.yaml
```

This will:
1. Upload spec to Spec Hub (or update existing)
2. Generate main collection (clean docs, no tests)
3. Generate smoke test collection with basic health checks
4. Generate contract test collection with comprehensive validation
5. Inject appropriate tests into test collections
6. Create/update environments (one per server in spec)

### 4. Run Tests with Postman CLI

```bash
# Login to Postman (first time only)
postman login

# Run smoke tests (fast health checks)
postman collection run "Task Management API - Smoke Tests" \
  --environment "Task Management API - Production server"

# Run contract tests (comprehensive validation)
postman collection run "Task Management API - Contract Tests" \
  --environment "Task Management API - Production server"
```

## - Usage

### Unified CLI (Recommended)

```bash
node src/cli.js <command> [options]
```

Commands:
- `forward` - Spec Hub forward sync (spec -> Postman)
- `repo` - Export Postman artifacts to repo
- `reverse` - Postman -> spec (docs/examples only)
- `bidirectional` / `bidi` - Full bidirectional workflow
- `status` - Detect drift

### Forward Sync (Spec Hub, forward-only)

```bash
node src/spec-hub-sync.js --spec <path> [options]

Options:
  --spec, -s        Path to OpenAPI spec file (required)
  --workspace, -w   Postman workspace ID (default: env.POSTMAN_WORKSPACE_ID)
  --api-key, -k     Postman API key (default: env.POSTMAN_API_KEY)
  --test-level, -t  Test level: smoke, contract, or all (default: all)
  --dry-run, -d     Validate spec without uploading
  --help, -h        Show help message
```

### Bidirectional Sync CLI

The unified CLI provides full bidirectional sync capabilities:

```bash
# Forward sync (spec -> Postman)
node src/cli.js forward --spec specs/api.yaml

# Export Postman artifacts to repo
node src/cli.js repo --spec specs/api.yaml --output .

# Reverse sync (Postman -> spec, descriptions/examples only)
node src/cli.js reverse --spec specs/api.yaml --collection <uid>

# Full bidirectional workflow
node src/cli.js bidi --spec specs/api.yaml --output .

# Check sync status
node src/cli.js status --output .
```

**NPM Script Shortcuts:**
```bash
npm run sync:forward -- --spec specs/api.yaml
npm run sync:repo -- --spec specs/api.yaml --output .
npm run sync:reverse -- --spec specs/api.yaml --collection <uid>
npm run sync:status -- --output .
```

**Configuration Priority:**
1. **CLI options** (highest priority)
2. **Environment variables**
3. **Config file** (`sync.config.json`)
4. **Hardcoded defaults** (lowest priority)


## - Demo Scenarios

### Scenario 1: Initial Sync

```bash
npm run sync:spec-hub -- --spec specs/sample-api.yaml
```

**Result:**
- Spec uploaded to Spec Hub
- "Task Management API" collection generated (clean docs)
- "Task Management API - Smoke Tests" collection generated with basic tests
- "Task Management API - Contract Tests" collection generated with comprehensive tests
- Environments created (one per server: Production, Staging, etc.)

### Scenario 2: Spec Update

1. Edit `specs/sample-api.yaml` (add endpoint, change schema, etc.)
2. Re-run sync:
   ```bash
   npm run sync:spec-hub -- --spec specs/sample-api.yaml
   ```

**Result:**
- Spec updated in Spec Hub
- Collections re-generated
- **Contract tests persist** (validated!)
- No orphaned tests, no manual intervention

### Scenario 3: Add Required Field

1. Add new required field to response schema in spec
2. Re-run sync
3. **Result:** New validation automatically included in contract tests

## - Architecture

### Forward Sync (Spec to Postman)

```
OpenAPI Spec (GitHub)
    │
    ▼
Upload to Spec Hub
    │
    ├──▶ Spec Hub generates "Docs" collection (clean)
    │
    └──▶ Spec Hub generates "Tests" collection
            │
            └──▶ Inject contract tests via API
                    │
                    └──▶ Tests persist on spec updates
```

### Bidirectional Sync

```
GIT REPOSITORY                         POSTMAN CLOUD
├── specs/api.yaml (Source of Truth)   ├── Spec Hub (OpenAPI)
├── postman/                           ├── Collections (Main, Smoke, Contract)
│   ├── collections/*.json             └── Team Forks -> Pull Requests
│   ├── environments/*.json
│   └── .sync-manifest.json
         │                                      │
         │ Forward Sync ──────────────────────▶ │
         │                                      │
         │ ◀────────────────────── Repo Sync   │
         │                                      │
         │ ◀──────────────── Reverse Sync      │
         │   (descriptions, examples only)      │
```

**Change Classification:**
| Change Type | Spec -> Postman | Postman -> Spec | Rationale |
|-------------|-----------------|-----------------|-----------|
| Endpoints/paths | Always | Never | Contract integrity |
| Schemas | Always | Never | Contract integrity |
| Security schemes | Always | Never | Safety |
| Descriptions | Initial | Enhanced | Docs evolve |
| Examples | Initial | Enhanced | Real-world data |
| Tests | N/A | x-postman-tests | Collection-only |

## - Spec Hub Workflow

### Current Approach: Spec Hub Native

```bash
# Login to Postman (first time only)
postman login --with-api-key $POSTMAN_API_KEY

# Sync spec to Spec Hub
npm run sync:spec-hub -- --spec specs/api.yaml

# This command:
# 1. Uploads/updates spec in Spec Hub
# 2. Generates docs collection (via Spec Hub API)
# 3. Generates test collection (via Spec Hub API)
# 4. Injects contract tests into test collection
# 5. Creates/updates environment
```

### Output Structure

```
Postman Workspace
├── Spec: Task Management API (in Spec Hub)
├── Collection: Task Management API (clean docs) [tags: generated, docs]
├── Collection: Task Management API - Smoke Tests [tags: generated, smoke]
├── Collection: Task Management API - Contract Tests [tags: generated, contract]
├── Environment: Task Management API - Production server
└── Environment: Task Management API - Staging server
```

## - Collection Tags

All generated collections are automatically tagged for easy organization:

| Collection Type | Tags | Purpose |
|----------------|------|---------|
| Main/Docs | `generated`, `docs` | Clean documentation collection |
| Smoke Tests | `generated`, `smoke` | Basic health check tests |
| Contract Tests | `generated`, `contract` | Comprehensive validation tests |

### Using Tags

In Postman, you can filter collections by tag to:
- Find all generated collections: filter by `generated`
- Find all smoke tests across APIs: filter by `smoke`
- Find all contract tests: filter by `contract`

Tags help teams identify:
- Which collections are auto-generated (vs. manually created)
- Which collections are safe for CI/CD (`smoke`, `contract`)
- Which collections are for documentation only (`docs`)

## - Configuration

The tool supports three levels of configuration with the following priority:

1. **CLI options** (highest priority)
2. **Environment variables**
3. **Config file** (`sync.config.json`)
4. **Hardcoded defaults** (lowest priority)

### Environment Variables

| Variable | Description | Maps To |
|----------|-------------|---------|
| `POSTMAN_API_KEY` | Postman API key for authentication | API authentication |
| `POSTMAN_WORKSPACE_ID` | Target workspace ID | `workspace` |
| `SPEC_FILE` | Default OpenAPI spec file path | `spec` |
| `TEST_LEVEL` | Test level: `smoke`, `contract`, `all`, `none` | `forwardSync.testLevel` |
| `EXPORT_TO_REPO` | Auto-export to repo after sync (`true`/`false`) | `forwardSync.exportToRepo` |
| `OUTPUT_DIR` | Output directory for repo sync | `repoSync.outputDir` |
| `INCLUDE_ENVS` | Include environments in repo sync (`true`/`false`) | `repoSync.includeEnvironments` |
| `CONFLICT_STRATEGY` | Conflict resolution: `spec-wins`, `collection-wins`, `interactive` | `reverseSync.conflictStrategy` |
| `INCLUDE_TESTS` | Include tests as vendor extensions (`true`/`false`) | `reverseSync.includeTests` |
| `AUTO_MERGE` | Auto-merge safe changes in bidirectional sync (`true`/`false`) | `bidirectional.autoMerge` |
| `DRY_RUN` | Preview changes without applying (`true`/`false`) | `dryRun` |

### Configuration File

Create a `sync.config.json` file in your project root:

```json
{
  "$schema": "./sync.config.schema.json",
  "version": "1.0",
  "workspace": "${POSTMAN_WORKSPACE_ID}",
  "spec": "specs/sample-api.yaml",
  
  "forwardSync": {
    "testLevel": "all",
    "exportToRepo": false
  },
  
  "reverseSync": {
    "enabled": true,
    "conflictStrategy": "spec-wins",
    "includeTests": true,
    "storeTestsAs": "x-postman-tests",
    "autoCreatePR": true,
    "prLabels": ["auto-generated", "documentation"]
  },
  
  "repoSync": {
    "enabled": true,
    "outputDir": "postman",
    "format": "json",
    "prettyPrint": true,
    "sortKeys": true,
    "includeEnvironments": true,
    "collections": {
      "directory": "collections",
      "filenamePattern": "{{slug}}-{{type}}.collection.json"
    },
    "environments": {
      "directory": "environments",
      "filenamePattern": "{{slug}}-{{server}}.environment.json",
      "redactSecrets": true,
      "secretPatterns": [
        "^api[_-]?key",
        "^token",
        "^secret",
        "^password",
        "^auth",
        "^bearer"
      ]
    },
    "manifest": {
      "enabled": true,
      "filename": ".sync-manifest.json"
    }
  },
  
  "bidirectional": {
    "autoMerge": false
  },
  
  "dryRun": false,
  
  "ci": {
    "checkBreakingChanges": true,
    "failOnBreaking": false,
    "scheduleReverseSyncCheck": "0 * * * *"
  }
}
```

### Configuration Examples

**Example 1: Minimal config with env vars**
```bash
export POSTMAN_WORKSPACE_ID="my-workspace"
export POSTMAN_API_KEY="my-api-key"
export SPEC_FILE="specs/api.yaml"

spec-sync forward  # Uses all env vars
```

**Example 2: Full config file**
```json
{
  "version": "1.0",
  "workspace": "${POSTMAN_WORKSPACE_ID}",
  "spec": "specs/api.yaml",
  "forwardSync": {
    "testLevel": "contract"
  },
  "bidirectional": {
    "autoMerge": true
  }
}
```

**Example 3: CLI overrides everything**
```bash
# Uses config file but overrides test level
spec-sync forward --test-level smoke
```

## - Environment Variables (Generated)

The tool generates **one environment per server** defined in your OpenAPI spec. Each environment has its own `baseUrl`, auth tokens, and test data.

### Auto-Extracted Variables

| Variable Type | Source | Example |
|--------------|--------|---------|
| **baseUrl** | `servers[].url` | `https://api.example.com/v1` |
| **Path Parameters** | `{taskId}` in paths | `taskId: task-001` |
| **Query Parameters** | `parameters` with defaults | `limit: 20`, `offset: 0` |
| **Security Schemes** | `securitySchemes` | `auth_token` (secret type) |
| **Examples** | `example` values | Used as test data |

### Example: Multiple Environments

For a spec with two servers:
```yaml
servers:
  - url: https://api.example.com/v1
    description: Production server
  - url: https://staging-api.example.com/v1
    description: Staging server
```

The tool creates:
- **Task Management API - Production server** → `baseUrl: https://api.example.com/v1`
- **Task Management API - Staging server** → `baseUrl: https://staging-api.example.com/v1`

### Manual Configuration

```bash
# Set auth token for production
postman environment update "Task Management API - Production server" \
  --variable auth_token=prod-jwt-token

# Set auth token for staging  
postman environment update "Task Management API - Staging server" \
  --variable auth_token=staging-jwt-token
```

## - CI/CD Integration

### GitHub Actions Workflow

The included `.github/workflows/contract-tests.yml` provides a complete CI/CD pipeline:

**Features:**
- Syncs spec to Postman Spec Hub on every push/PR
- Generates all three collection types (main, smoke, contract)
- Runs smoke and contract tests separately
- Posts results as PR comments
- Generates spec change reports (added/removed endpoints)
- Supports manual workflow dispatch with environment selection

### Required Repository Secrets

Configure these in your GitHub repository settings (Settings → Secrets and variables → Actions):

| Secret | Description | How to Get |
|--------|-------------|------------|
| `POSTMAN_API_KEY` | Postman API key for authentication | [Postman API Keys](https://web.postman.co/settings/me/api-keys) |
| `POSTMAN_WORKSPACE_ID` | Target workspace ID | From workspace URL: `https://web.postman.co/workspace/{workspace-id}` |
| `API_AUTH_TOKEN` | Auth token for test runs (optional) | Your API's auth token for authenticated endpoints |

### Workflow Triggers

```yaml
on:
  push:
    branches: [main, master]
    paths:
      - 'specs/**'      # Spec changes
      - 'src/**'        # Generator changes
  pull_request:
    branches: [main, master]
    paths:
      - 'specs/**'
  workflow_dispatch:    # Manual trigger
    inputs:
      test_level:       # all | smoke | contract
      environment:      # staging | production
```

### Example Usage

**Automatic on push:**
```bash
git add specs/api.yaml
git commit -m "Add new endpoint"
git push
# Workflow runs automatically
```

**Manual with options:**
1. Go to Actions → Contract Tests
2. Click "Run workflow"
3. Select test level and environment
4. Click "Run"

### Complete Workflow Example

```yaml
name: Contract Tests

on:
  push:
    paths:
      - 'specs/**'

jobs:
  sync-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Sync spec to Spec Hub
        run: npm run sync:spec-hub -- --spec specs/api.yaml
        env:
          POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
          POSTMAN_WORKSPACE_ID: ${{ secrets.POSTMAN_WORKSPACE_ID }}
        
      - name: Run smoke tests
        run: |
          postman collection run "API Name - Smoke Tests" \
            --environment "API Name - Staging server" \
            --reporters cli,junit
        env:
          POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
        
      - name: Run contract tests
        run: |
          postman collection run "API Name - Contract Tests" \
            --environment "API Name - Staging server" \
            --reporters cli,junit
        env:
          POSTMAN_API_KEY: ${{ secrets.POSTMAN_API_KEY }}
```

## - Test Generation Logic

### Smoke Tests (Basic)

| Test | Description |
|------|-------------|
| Status code validation | Checks for success codes (200-299) |
| Response time | Validates under threshold (default: 2000ms) |
| Body exists | Ensures non-empty response for 2xx |

### Contract Tests (Comprehensive)

| Test Type | Trigger | Generated Test |
|-----------|---------|----------------|
| Status Code | `responses: {200: ...}` | `pm.response.to.have.status(200)` |
| Response Time | Always | `pm.expect(pm.response.responseTime).to.be.below(threshold)` |
| Content-Type | `content: application/json` | Header validation |
| JSON Schema | Response schema defined | Structure validation |
| Required Fields | `required: ["id", "name"]` | Field existence checks |
| **Enum Validation** | `enum: ["a", "b"]` | `pm.expect(value).to.be.oneOf([...])` |
| **Format Validation** | `format: date-time, email, uuid` | Regex pattern matching |
| **Pattern Validation** | `pattern: "^\\d{3}$"` | Custom regex validation |
| **String Constraints** | `minLength`, `maxLength` | Length boundary checks |
| **Numeric Constraints** | `minimum`, `maximum`, `multipleOf` | Range validation |
| **Array Constraints** | `minItems`, `maxItems` | Array size validation |
| Error Structure | 4xx responses defined | Error field validation |

## >> Positioning vs. Spec Hub Native Features

| Feature | Spec Hub Native | This Tool |
|---------|----------------|-----------|
| Spec storage | [x] Yes | [x] Uses Spec Hub |
| Collection generation | [x] Yes | [x] Uses Spec Hub |
| **Contract test generation** | [ ] No | [x] Injects tests |
| **Test persistence** | N/A | [x] Validated |
| **Triple collections** (docs + smoke + contract) | [ ] No | [x] Yes |
| **Auto-tagging** | [ ] No | [x] Yes |
| **Multi-environments** (per server) | [ ] No | [x] Yes |
| CI/CD integration | ! Manual | [x] Automated |

**Use this when**: You need contract tests on Spec Hub-generated collections that persist across spec updates.

## - Development

### Project Structure

```
demo/
├── src/
│   ├── cli.js                  # Unified CLI for bidirectional sync
│   ├── config-loader.js        # Configuration loading with env var support
│   ├── spec-hub-sync.js        # Forward sync orchestrator
│   ├── spec-hub-client.js      # Spec Hub API client (with fork/PR support)
│   ├── repo-sync.js            # Export Postman artifacts to repo
│   ├── reverse-sync.js         # Reverse sync (Postman -> spec)
│   ├── change-detector.js      # Change classification for bidirectional sync
│   ├── spec-merge.js           # 3-way merge for spec updates
│   ├── test-generator.js       # Contract/smoke test generator
│   ├── environment-generator.js # Multi-environment generator
│   └── parser.js               # OpenAPI parser
├── scripts/
│   ├── cleanup-collections.js  # Cleanup orphaned collections
│   └── cleanup-specs.js        # Cleanup orphaned specs
├── specs/
│   └── sample-api.yaml         # Demo OpenAPI spec
├── postman/                    # Git-tracked Postman artifacts (after repo sync)
│   ├── collections/            # Exported collections (diff-friendly JSON)
│   ├── environments/           # Exported environments (secrets redacted)
│   └── .sync-manifest.json     # Sync state for change detection
├── .github/workflows/
│   ├── contract-tests.yml      # Test execution workflow
│   └── sync.yml                # Bidirectional sync workflow (hourly)
├── sync.config.json            # Project configuration (optional)
├── sync.config.schema.json     # JSON Schema for config validation
├── package.json
├── README.md
└── CLAUDE.md
```

> **Note:** This repo uses Spec Hub for forward sync; there is no standalone local collection generator in `src/`.

### Available Scripts

```bash
# Sync spec to Spec Hub (recommended)
npm run sync:spec-hub -- --spec specs/api.yaml

# Validate spec
npm run validate:spec -- specs/api.yaml

# Legacy local generation
npm run generate -- --spec specs/api.yaml

# Validate test persistence behavior
npm run validate:test-persistence

# Cleanup orphaned resources
node scripts/cleanup-collections.js
node scripts/cleanup-specs.js
```

## - Sample API

The included `specs/sample-api.yaml` is a Task Management API with:

- **7 endpoints** covering CRUD operations
- **Multiple response codes**: 200, 201, 204, 400, 404, 409, 422
- **Request/response schemas** with required fields
- **Response examples**
- **Authentication** (Bearer token)
- **Public endpoint** (health check)

## - License

MIT

## - Resources

- [Postman Spec Hub Documentation](https://learning.postman.com/docs/designing-and-developing-your-api/spec-hub/)
- [Postman CLI Documentation](https://learning.postman.com/docs/postman-cli/postman-cli-overview/)
- [Postman API Reference](https://www.postman.com/postman/workspace/postman-public-workspace/documentation/12959542-c8142d51-e97c-46b6-bd77-52bb66712c9a)
