#!/usr/bin/env node

/**
 * Postman API Uploader
 * 
 * Uploads generated collections to Postman Cloud via the Postman API.
 * Handles the proper format conversion for API compatibility.
 */

import fs from 'fs';

const POSTMAN_API_BASE = 'https://api.getpostman.com';

/**
 * Clean collection for Postman API upload
 * The Postman API expects a specific format that's slightly different
 * from the postman-collection SDK output
 */
function cleanCollectionForApi(collection) {
  // Deep clone
  const cleaned = JSON.parse(JSON.stringify(collection));
  
  // Remove internal SDK properties
  function cleanItem(item) {
    // Remove id fields (API will assign new ones)
    delete item.id;
    
    // Clean up URL - API expects simpler format
    if (item.request?.url) {
      const url = item.request.url;
      
      // If url is an object with host/path, convert to string or simplify
      if (typeof url === 'object') {
        // Build URL string from parts
        const host = Array.isArray(url.host) ? url.host.join('') : url.host;
        const path = Array.isArray(url.path) ? url.path.join('/') : url.path;
        const query = url.query;
        
        // Simplify query params
        if (query && Array.isArray(query)) {
          item.request.url.query = query.map(q => ({
            key: q.key,
            value: typeof q.value === 'string' ? q.value : '{{' + q.key + '}}',
            description: q.description?.content || q.description,
            disabled: q.disabled
          })).filter(q => q.key && !q.key.startsWith('_'));
        }
        
        // Keep as object but clean it up
        delete url.protocol;
        delete url.port;
      }
    }
    
    // Clean up description
    if (item.description && typeof item.description === 'object') {
      item.description = item.description.content || item.description;
    }
    if (item.request?.description && typeof item.request.description === 'object') {
      item.request.description = item.request.description.content || item.request.description;
    }
    
    // Recurse into folders
    if (item.item && Array.isArray(item.item)) {
      item.item.forEach(cleanItem);
    }
    
    return item;
  }
  
  if (cleaned.item && Array.isArray(cleaned.item)) {
    cleaned.item.forEach(cleanItem);
  }
  
  // Clean info
  delete cleaned.info._postman_id;
  delete cleaned.info.id;
  
  return cleaned;
}

/**
 * Upload collection to Postman
 */
async function uploadCollection(collectionPath, apiKey, workspaceId) {
  const collectionJson = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const cleaned = cleanCollectionForApi(collectionJson);
  
  const payload = {
    collection: cleaned
  };
  
  const url = workspaceId 
    ? `${POSTMAN_API_BASE}/collections?workspace=${workspaceId}`
    : `${POSTMAN_API_BASE}/collections`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`Upload failed: ${JSON.stringify(result.error, null, 2)}`);
  }
  
  return result.collection;
}

/**
 * Update existing collection
 */
async function updateCollection(collectionId, collectionPath, apiKey) {
  const collectionJson = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
  const cleaned = cleanCollectionForApi(collectionJson);
  
  const payload = {
    collection: cleaned
  };
  
  const response = await fetch(`${POSTMAN_API_BASE}/collections/${collectionId}`, {
    method: 'PUT',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`Update failed: ${JSON.stringify(result.error, null, 2)}`);
  }
  
  return result.collection;
}

/**
 * List collections in workspace
 */
async function listCollections(apiKey, workspaceId) {
  const url = workspaceId
    ? `${POSTMAN_API_BASE}/collections?workspace=${workspaceId}`
    : `${POSTMAN_API_BASE}/collections`;
  
  const response = await fetch(url, {
    headers: {
      'X-Api-Key': apiKey
    }
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`List failed: ${JSON.stringify(result.error, null, 2)}`);
  }
  
  return result.collections || [];
}

/**
 * Upload environment to Postman
 */
async function uploadEnvironment(environmentPath, apiKey, workspaceId) {
  const envJson = JSON.parse(fs.readFileSync(environmentPath, 'utf8'));
  
  // Clean environment
  const cleaned = {
    name: envJson.name,
    values: envJson.values.map(v => ({
      key: v.key,
      value: v.value,
      type: v.type,
      enabled: v.enabled
    }))
  };
  
  const payload = {
    environment: cleaned
  };
  
  const url = workspaceId
    ? `${POSTMAN_API_BASE}/environments?workspace=${workspaceId}`
    : `${POSTMAN_API_BASE}/environments`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  
  const result = await response.json();
  
  if (!response.ok) {
    throw new Error(`Environment upload failed: ${JSON.stringify(result.error, null, 2)}`);
  }
  
  return result.environment;
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  const apiKey = process.env.POSTMAN_API_KEY;
  const workspaceId = process.env.POSTMAN_WORKSPACE_ID;
  
  if (!apiKey) {
    console.error('Error: POSTMAN_API_KEY environment variable required');
    process.exit(1);
  }
  
  try {
    switch (command) {
      case 'upload': {
        const collectionPath = args[1] || 'output/collection.json';
        
        // Check if collection exists
        const collections = await listCollections(apiKey, workspaceId);
        const collectionJson = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));
        const collectionName = collectionJson.info?.name;
        
        const existing = collections.find(c => c.name === collectionName);
        
        if (existing) {
          console.log(`Updating existing collection: ${collectionName}`);
          const result = await updateCollection(existing.id, collectionPath, apiKey);
          console.log(`✅ Updated: ${result.uid}`);
        } else {
          console.log(`Creating new collection: ${collectionName}`);
          const result = await uploadCollection(collectionPath, apiKey, workspaceId);
          console.log(`✅ Created: ${result.uid}`);
        }
        break;
      }
      
      case 'upload-env': {
        const envPath = args[1] || 'output/environment.json';
        console.log('Uploading environment...');
        const result = await uploadEnvironment(envPath, apiKey, workspaceId);
        console.log(`✅ Environment uploaded: ${result.uid}`);
        break;
      }
      
      case 'list': {
        const collections = await listCollections(apiKey, workspaceId);
        console.log('Collections:');
        collections.forEach(c => {
          console.log(`  - ${c.name} (${c.uid})`);
        });
        break;
      }
      
      default:
        console.log(`
Postman API Uploader

Usage:
  node src/api-uploader.js upload [collection-path]   Upload/update collection
  node src/api-uploader.js upload-env [env-path]      Upload environment
  node src/api-uploader.js list                       List collections

Environment:
  POSTMAN_API_KEY      Required - Your Postman API key
  POSTMAN_WORKSPACE_ID Optional - Target workspace ID
        `);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

main();

export { uploadCollection, updateCollection, listCollections, uploadEnvironment };
