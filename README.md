# Spec-Derived Contract Test Generator

A demo tool that generates Postman collections with contract tests from OpenAPI 3.x specifications. All tests are derived directly from spec metadata—no manual test writing required.

> **Note:** This demo is designed for Postman Enterprise prospects to showcase spec-driven testing workflows. It complements Postman's native [Spec Hub](https://learning.postman.com/docs/designing-and-developing-your-api/spec-hub/) capabilities for teams who need programmatic control over test generation.

## 🎯 Problem Statement

When teams use OpenAPI specs as their source of truth and generate Postman collections, a common anti-pattern emerges:

1. **Renames break tests**: Developers manually write tests on generated collections. If you rename `/users/{id}` to `/customers/{id}` in the spec, those tests are orphaned.
2. **Regeneration overwrites work**: When the spec updates and you regenerate the collection, manual modifications (including tests) are lost.
3. **Forks don't solve this**: Forking just delays the problem—sync issues persist when pulling changes.

**The Solution**: Generate contract tests **FROM the spec itself**. Tests become a deterministic function of the spec—when the spec changes, tests regenerate automatically. No orphaned tests, no sync headaches.

## ✨ Features

- **Spec-driven test generation**: All tests derived from OpenAPI metadata
- **Status code validation**: Tests verify expected response codes
- **JSON Schema validation**: Response structure validated against spec schemas
- **Required field checks**: Ensures required fields are present in responses
- **Content-Type validation**: Verifies response content types
- **Performance baselines**: Configurable response time thresholds
- **Environment generation**: Creates matching Postman environments
- **Postman CLI ready**: Works with the modern Postman CLI (Newman is deprecated)

## 📋 Prerequisites

- Node.js 18+ 
- [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/) installed (for running collections)

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd demo
npm install
```

### 2. Generate Collection from Spec

```bash
npm run generate -- --spec specs/sample-api.yaml --output output/collection.json
```

Or directly:

```bash
node src/index.js --spec specs/sample-api.yaml --output output/collection.json
```

### 3. Run with Postman CLI

```bash
# Login to Postman (first time only)
postman login

# Run the generated collection
postman collection run output/collection.json --environment output/environment.json
```

## 📖 Usage

### CLI Options

```bash
node src/index.js --spec <path> [options]

Options:
  --spec, -s            Path or URL to OpenAPI spec (YAML or JSON) [required]
  --output, -o          Output path for collection JSON [default: output/collection.json]
  --base-url, -b        Override base URL from spec
  --environment, -e     Output path for environment JSON [default: output/environment.json]
  --collection-name, -n Custom name for the collection
  --help, -h            Show help message
```

### Examples

```bash
# Basic usage
node src/index.js --spec specs/sample-api.yaml

# With custom output paths
node src/index.js --spec specs/api.yaml --output collections/my-api.json

# With URL spec and custom base URL
node src/index.js --spec https://example.com/api.yaml --base-url https://api.prod.com

# With custom collection name
node src/index.js --spec specs/api.yaml --collection-name "My Production API"
```

## 🧪 Demo Scenarios

This demo proves the key value proposition: spec-derived tests stay in sync with spec changes.

### Scenario 1: Initial Generation

Generate a collection with tests from the sample spec:

```bash
node src/index.js --spec specs/sample-api.yaml
```

Observe:
- 6 endpoints organized into folders (Tasks, System)
- Contract tests embedded in each request
- Environment variables for configuration

### Scenario 2: Rename an Endpoint

1. Edit `specs/sample-api.yaml` and change:
   ```yaml
   # From
   /tasks/{taskId}:
   # To
   /items/{taskId}:
   ```

2. Regenerate:
   ```bash
   node src/index.js --spec specs/sample-api.yaml
   ```

3. **Result**: Tests are correctly generated for `/items/{taskId}`. No orphaned tests, no manual intervention required.

### Scenario 3: Add a Required Field

1. Edit `specs/sample-api.yaml` and add a new required field to the Task schema:
   ```yaml
   Task:
     required:
       - id
       - title
       - status
       - createdAt
       - updatedAt
       - assignee  # NEW FIELD
   ```

2. Regenerate:
   ```bash
   node src/index.js --spec specs/sample-api.yaml
   ```

3. **Result**: The contract test now validates that `assignee` is present in all Task responses.

### Scenario 4: Add a New Endpoint

1. Add a new endpoint to `specs/sample-api.yaml`:
   ```yaml
   /tasks/{taskId}/archive:
     post:
       summary: Archive a task
       operationId: archiveTask
       tags:
         - Tasks
       responses:
         '200':
           description: Task archived
   ```

2. Regenerate:
   ```bash
   node src/index.js --spec specs/sample-api.yaml
   ```

3. **Result**: Tests are automatically created for the new endpoint.

## 🔧 Test Generation Logic

For each endpoint in the spec, the following tests are generated:

| Test Type | Trigger | Generated Test |
|-----------|---------|----------------|
| Status Code | `responses: {200: ...}` | `pm.response.to.have.status(200)` |
| Response Time | Always | `pm.expect(pm.response.responseTime).to.be.below(threshold)` |
| Content-Type | `content: application/json` | Header validation |
| JSON Schema | Response schema defined | Structure validation |
| Required Fields | `required: ["id", "name"]` | Field existence checks |
| Error Structure | 4xx responses defined | Error field validation |

## 🏗️ Architecture

```
spec.yaml
    |
    v
[Parser] -- @apidevtools/swagger-parser
    |
    v
[Test Generator] -- Generates Postman test scripts
    |
    v
[Collection Builder] -- postman-collection SDK
    |
    v
+-- collection.json (with embedded tests)
+-- environment.json (variables)
```

## 🔐 Authentication

The generated collection supports multiple authentication methods based on your spec:

### Bearer Token (JWT)

Set the token in your environment:
```bash
postman environment create my-env --variable auth_token=your-jwt-token
```

### API Key

Set the API key in your environment:
```bash
postman environment create my-env --variable auth_token=your-api-key
```

### No Auth (Public Endpoints)

Endpoints with `security: []` in the spec are configured with `type: noauth`.

## 🔄 CI/CD Integration

### GitHub Actions Example

See `.github/workflows/contract-tests.yml` for a complete example:

```yaml
name: Contract Tests

on:
  push:
    paths:
      - 'specs/**'
  pull_request:
    paths:
      - 'specs/**'

jobs:
  generate-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          
      - name: Install dependencies
        run: npm ci
        
      - name: Generate collection
        run: npm run generate -- --spec specs/api.yaml
        
      - name: Setup Postman CLI
        run: |
          curl -o- "https://dl-cli.pstmn.io/install/linux64.sh" | sh
          
      - name: Login to Postman
        run: postman login --with-api-key ${{ secrets.POSTMAN_API_KEY }}
        
      - name: Run contract tests
        run: |
          postman collection run output/collection.json \
            --environment output/environment.json \
            --reporters cli,junit \
            --reporter-junit-export test-results.xml
            
      - name: Upload test results
        uses: actions/upload-artifact@v4
        with:
          name: test-results
          path: test-results.xml
```

## 📊 Output Structure

```
output/
├── collection.json      # Generated Postman collection with tests
└── environment.json     # Environment variables
```

### Collection Structure

```json
{
  "info": {
    "name": "Task Management API",
    "description": "Collection generated from OpenAPI spec with contract tests"
  },
  "item": [
    {
      "name": "Tasks",
      "item": [
        {
          "name": "List all tasks",
          "request": { ... },
          "event": [
            {
              "listen": "test",
              "script": {
                "exec": [
                  "// Contract tests generated from OpenAPI spec",
                  "pm.test(\"Status code is 200\", function () { ... })",
                  "..."
                ]
              }
            }
          ]
        }
      ]
    }
  ],
  "variable": [
    { "key": "baseUrl", "value": "https://api.example.com/v1" },
    { "key": "RESPONSE_TIME_THRESHOLD", "value": "2000" },
    { "key": "auth_token", "value": "" }
  ]
}
```

## 🎯 Positioning vs. Postman Spec Hub

This tool is designed for specific use cases:

| Use Case | Spec Hub | This Tool |
|----------|----------|-----------|
| Spec storage & versioning | ✅ Native | ❌ |
| Collection generation | ✅ Native | ✅ |
| Git sync for specs | ✅ Native | ❌ |
| **Custom test logic** | ❌ Limited | ✅ Full control |
| **CI/CD-native workflows** | ⚠️ Via API | ✅ Direct CLI |
| **Programmatic generation** | ⚠️ Via API | ✅ Local tool |
| **Offline/air-gapped** | ❌ Cloud | ✅ Works locally |

**When to use this tool:**
- You need custom test generation logic beyond Spec Hub's native capabilities
- You want to integrate spec-driven testing into existing CI/CD pipelines without cloud dependencies
- You're in an air-gapped environment
- You need programmatic control over the generation process

## 🛠️ Development

### Project Structure

```
demo/
├── src/
│   ├── parser.js       # OpenAPI spec parsing
│   ├── generator.js    # Test script generation
│   ├── builder.js      # Postman collection assembly
│   └── index.js        # CLI entry point
├── specs/
│   └── sample-api.yaml # Demo OpenAPI spec
├── output/             # Generated collections
├── package.json
└── README.md
```

### Running Tests

```bash
# Generate collection
npm run generate

# Run with Postman CLI
npm run test:collection
```

### Customizing Test Generation

Edit `src/generator.js` to customize test logic:

```javascript
// Add custom tests
export function generateTests(endpoint) {
  const tests = [];
  
  // Your custom test logic here
  tests.push(`pm.test("Custom validation", function () { ... })`);
  
  return tests.join('\n');
}
```

## 📝 Sample API

The included `specs/sample-api.yaml` is a Task Management API with:

- **6 endpoints** covering CRUD operations
- **Multiple response codes**: 200, 201, 204, 400, 404, 409, 422
- **Request/response schemas** with required fields
- **Query and path parameters**
- **Response examples**
- **Authentication** (Bearer token)
- **Public endpoint** (health check)

## 🤝 Contributing

This is a demo project. For production use, consider:

1. Adding more sophisticated schema validation (AJV integration)
2. Supporting OpenAPI 3.1 features
3. Adding diff reporting between generations
4. Integrating with Spec Hub APIs for upload

## 📄 License

MIT

## 🔗 Resources

- [Postman CLI Documentation](https://learning.postman.com/docs/postman-cli/postman-cli-overview/)
- [Postman Collection SDK](https://github.com/postmanlabs/postman-collection)
- [OpenAPI Specification](https://spec.openapis.org/)
- [Postman Spec Hub](https://learning.postman.com/docs/designing-and-developing-your-api/spec-hub/)
