# Testing Guide

This document describes the test structure, how to run tests, and how to add new tests.

## Test Structure

```
src/__tests__/
  fixtures/           # Test fixtures (OpenAPI specs)
    minimal-spec.yaml   # Minimal valid OpenAPI 3.0 spec
    complex-spec.yaml   # Spec with all OpenAPI features
    invalid-spec.yaml   # Intentionally invalid spec
    circular-spec.yaml  # Spec with circular $ref
  helpers/            # Test utilities
    test-helpers.js     # Mock clients, validation helpers
  integration/        # Integration tests (require API key)
    integration.test.js
  parser.test.js      # Parser module unit tests
  test-generator.test.js # Test generator unit tests
  sync.test.js        # Bidirectional sync unit tests
```

## Running Tests

### Unit Tests

Run all unit tests:

```bash
npm test
# or
npm run test:unit
```

Run specific test file:

```bash
node --test src/__tests__/parser.test.js
```

### Integration Tests

Integration tests require valid Postman credentials:

```bash
export POSTMAN_API_KEY=your-api-key
export POSTMAN_WORKSPACE_ID=your-workspace-id
npm run test:integration
```

### All Tests

```bash
npm run test:all
```

### With Coverage

Run tests with coverage reporting:

```bash
npm run test:coverage
```

Generate LCOV report for CI:

```bash
npm run test:coverage:report
```

## Test Helpers

### Fixtures

Get path to test fixture:

```javascript
import { getFixturePath } from './helpers/test-helpers.js';

const specPath = getFixturePath('minimal-spec.yaml');
```

### Mock Client

Use MockSpecHubClient for tests without API calls:

```javascript
import { MockSpecHubClient } from './helpers/test-helpers.js';

const mockClient = new MockSpecHubClient({
  collections: [{ uid: 'test-uid', name: 'Test Collection' }]
});

// Check recorded calls
const calls = mockClient.getCallsFor('getCollection');
```

### JavaScript Validation

Validate generated test scripts:

```javascript
import { validateJavaScriptSyntax, validatePostmanTestScript } from './helpers/test-helpers.js';

const result = validateJavaScriptSyntax(script);
if (!result.valid) {
  console.error('Syntax error:', result.error);
}

const postmanResult = validatePostmanTestScript(script);
console.log('Test names:', postmanResult.tests);
```

### Create Test Fixtures

```javascript
import { createMinimalSpec, createTestEndpoint } from './helpers/test-helpers.js';

const spec = createMinimalSpec({
  paths: {
    '/custom': {
      get: { summary: 'Custom endpoint', responses: { '200': { description: 'OK' } } }
    }
  }
});

const endpoint = createTestEndpoint({
  method: 'POST',
  path: '/users',
  responses: { '201': { description: 'Created' } }
});
```

## Adding New Tests

### 1. Add Unit Tests

Create a new test file in `src/__tests__/`:

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

describe('MyModule', () => {
  it('should do something', () => {
    assert.strictEqual(1 + 1, 2);
  });
});
```

### 2. Add Test Fixtures

Add fixture files to `src/__tests__/fixtures/` with descriptive names.

### 3. Test Structure Guidelines

- Use `describe()` for grouping related tests
- Use `it()` for individual test cases
- Use `beforeEach()` for setup that runs before each test
- Use `assert` module for assertions
- Keep tests focused on one behavior
- Use descriptive test names

### 4. Mocking External APIs

Always mock external API calls in unit tests:

```javascript
const mockClient = new MockSpecHubClient();
mockClient.collections = [/* mock data */];
```

## Coverage Goals

- **parser.js**: Minimum 80% code coverage
- **test-generator.js**: Minimum 80% code coverage
- All edge cases should have tests
- All error conditions should have tests

## CI/CD

Tests run automatically on:
- Push to any branch
- Pull request creation

See `.github/workflows/contract-tests.yml` for CI configuration.
