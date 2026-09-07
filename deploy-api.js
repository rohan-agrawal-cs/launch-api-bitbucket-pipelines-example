#!/usr/bin/env node
/**
 * Redeploys this repository to an existing Contentstack Launch environment
 * through the Launch Public API file-upload flow:
 *
 *   1. exchange M2M client credentials for an access token
 *   2. zip the source files Launch needs in order to build the project
 *   3. GET  /projects/:project/environments/:environment/deployments/upload/signed_url
 *   4. upload the zip to the returned signed URL
 *   5. POST /projects/:project/environments/:environment/deployments  { uploadUid }
 *   6. poll the deployment until it reaches a terminal status
 *
 * The project and environment must already exist -- create them once from the
 * Launch UI (or the Launch APIs) before the first pipeline run.
 *
 * Docs: https://www.contentstack.com/docs/developers/apis/launch-api
 */

try {
  require('dotenv').config();
} catch (_) {
  // dotenv is only needed for local runs; CI injects real environment variables.
}

const fs = require('fs');
const path = require('path');
const https = require('https');

const REGIONS = {
  AWS_NA:   { auth: 'app.contentstack.com',            launch: 'launch-api.contentstack.com' },
  AWS_EU:   { auth: 'eu-app.contentstack.com',         launch: 'eu-launch-api.contentstack.com' },
  AWS_AU:   { auth: 'au-app.contentstack.com',         launch: 'au-launch-api.contentstack.com' },
  AZURE_NA: { auth: 'azure-na-app.contentstack.com',   launch: 'azure-na-launch-api.contentstack.com' },
  AZURE_EU: { auth: 'azure-eu-app.contentstack.com',   launch: 'azure-eu-launch-api.contentstack.com' },
  GCP_NA:   { auth: 'gcp-na-app.contentstack.com',     launch: 'gcp-na-launch-api.contentstack.com' },
  GCP_EU:   { auth: 'gcp-eu-app.contentstack.com',     launch: 'gcp-eu-launch-api.contentstack.com' },
  // Contentstack-internal non-production stack, for testing this pipeline
  // before pointing it at a customer project.
  DEV11:    { auth: 'dev11-app.csnonprod.com',         launch: 'dev-launch-api.csnonprod.com' },
};

// Files and folders uploaded to Launch. Launch runs the build itself, so this
// is source -- not build output -- and node_modules is never included.
// Override per project with LAUNCH_INCLUDE="package.json,src,public".
const DEFAULT_INCLUDE = [
  'package.json',
  'package-lock.json',
  'next.config.js',
  'pages',
  'public',
  'app',
  'functions',
];

const NEVER_INCLUDE = new Set(['node_modules', '.git', '.next', '.DS_Store', 'deployment.zip']);

const SUCCESS_STATUSES = new Set(['LIVE', 'DEPLOYED']);
const FAILURE_STATUSES = new Set(['FAILED', 'CANCELLED', 'SKIPPED']);
const TERMINAL_STATUSES = new Set([...SUCCESS_STATUSES, ...FAILURE_STATUSES, 'ARCHIVED']);

const ZIP_NAME = 'deployment.zip';
const ZIP_PATH = path.join(process.cwd(), ZIP_NAME);
const POLL_INTERVAL_MS = 5000;
const API_TIMEOUT_MS = 60000;

function env(name) {
  return (process.env[name] || '').trim();
}

const VARIABLE_NAMES = {
  clientId: 'CONTENTSTACK_CLIENT_ID',
  clientSecret: 'CONTENTSTACK_CLIENT_SECRET',
  region: 'CONTENTSTACK_REGION',
  projectUid: 'PROJECT_UID',
  environmentUid: 'ENVIRONMENT_UID',
};

const REGION_HINT = `Use one of: ${Object.keys(REGIONS).join(', ')}`
  + ' -- or set CONTENTSTACK_AUTH_HOST and CONTENTSTACK_LAUNCH_API_HOST for a stack that is not listed.';

// Accepts a bare hostname or a full URL, and keeps only the hostname.
function hostOnly(value) {
  return value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
}

function resolveHosts(region) {
  const auth = hostOnly(env('CONTENTSTACK_AUTH_HOST'));
  const launch = hostOnly(env('CONTENTSTACK_LAUNCH_API_HOST'));

  // Explicit hosts win, so an unlisted stack needs no code change.
  if (auth && launch) return { auth, launch };
  if (auth || launch) {
    fail('Set both CONTENTSTACK_AUTH_HOST and CONTENTSTACK_LAUNCH_API_HOST, or neither.');
  }
  if (!REGIONS[region]) {
    fail(`Unknown CONTENTSTACK_REGION "${region}".`, REGION_HINT);
  }
  return REGIONS[region];
}

function loadConfig() {
  const region = env('CONTENTSTACK_REGION').toUpperCase();
  const usingHostOverrides = Boolean(env('CONTENTSTACK_AUTH_HOST') || env('CONTENTSTACK_LAUNCH_API_HOST'));
  const include = (env('LAUNCH_INCLUDE') || DEFAULT_INCLUDE.join(','))
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);

  const config = {
    clientId: env('CONTENTSTACK_CLIENT_ID'),
    clientSecret: env('CONTENTSTACK_CLIENT_SECRET'),
    region,
    projectUid: env('PROJECT_UID'),
    environmentUid: env('ENVIRONMENT_UID'),
    include,
    waitForDeployment: env('WAIT_FOR_DEPLOYMENT').toLowerCase() !== 'false',
    timeoutMs: (Number(env('DEPLOYMENT_TIMEOUT_SECONDS')) || 900) * 1000,
  };

  const required = ['clientId', 'clientSecret', 'projectUid', 'environmentUid'];
  if (!usingHostOverrides) required.push('region');

  const missing = required.filter(key => !config[key]).map(key => VARIABLE_NAMES[key]);
  if (missing.length) {
    fail(
      `Missing required variable(s): ${missing.join(', ')}`,
      missing.includes('CONTENTSTACK_REGION') ? REGION_HINT : undefined
    );
  }

  config.hosts = resolveHosts(region);
  return config;
}

function removeZip() {
  if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);
}

function fail(message, hint) {
  console.error(`\nDeployment failed: ${message}`);
  if (hint) console.error(hint);
  // process.exit() skips main()'s finally block, so clean up here too.
  removeZip();
  process.exit(1);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestJson({ hostname, path: requestPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(body);
    const req = https.request({
      hostname,
      path: requestPath,
      method,
      headers: payload
        ? { ...headers, 'Content-Length': payload.length }
        : headers,
      timeout: API_TIMEOUT_MS,
    }, res => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch (_) {
          json = null;
        }
        resolve({ status: res.statusCode, json, raw });
      });
    });

    req.on('timeout', () => req.destroy(new Error(`Request to ${hostname} timed out`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function describeError(response) {
  const body = response.json;
  if (body) {
    const message = body.error_description || body.error_message || body.error || body.message;
    if (message) return typeof message === 'string' ? message : JSON.stringify(message);
  }
  if (response.raw && response.raw.includes('<Error>')) {
    return 'received an XML error body -- check CONTENTSTACK_REGION';
  }
  return response.raw ? response.raw.slice(0, 500) : 'no response body';
}

async function getAccessToken(config) {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    scopes: 'launch:manage',
  }).toString();

  const response = await requestJson({
    hostname: config.hosts.auth,
    path: '/apps-api/apps/token',
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (response.status < 200 || response.status >= 300 || !response.json?.access_token) {
    fail(
      `could not fetch an access token (HTTP ${response.status}): ${describeError(response)}`,
      'Check CONTENTSTACK_CLIENT_ID / CONTENTSTACK_CLIENT_SECRET and that the app has the launch:manage scope.'
    );
  }

  return {
    token: response.json.access_token,
    organizationUid: response.json.organization_uid || null,
  };
}

async function launchApi(config, auth, apiPath, method, body) {
  const headers = {
    Authorization: `Bearer ${auth.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-cs-api-version': '1.0',
  };
  if (auth.organizationUid) headers.organization_uid = auth.organizationUid;

  const response = await requestJson({
    hostname: config.hosts.launch,
    path: apiPath,
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.status < 200 || response.status >= 300) {
    const hints = {
      401: 'The access token was rejected -- confirm the app has Launch API access.',
      403: 'The app is not allowed on this project -- check its scopes and organization.',
      404: 'Not found -- verify PROJECT_UID and ENVIRONMENT_UID.',
    };
    fail(`${method} ${apiPath} returned HTTP ${response.status}: ${describeError(response)}`, hints[response.status]);
  }

  return response.json || {};
}

function normalizeSignedUrl(data) {
  const toMap = (value, keyName, valueName) => {
    if (Array.isArray(value)) {
      return value.reduce((map, entry) => {
        const key = entry?.[keyName] ?? entry?.key;
        const val = entry?.[valueName] ?? entry?.value;
        if (key !== undefined && val !== undefined) map[String(key)] = String(val);
        return map;
      }, {});
    }
    return value && typeof value === 'object' ? { ...value } : {};
  };

  return {
    uploadUrl: data.uploadUrl,
    uploadUid: data.uploadUid,
    method: data.method,
    headers: toMap(data.headers, 'key', 'value'),
    fields: toMap(data.fields, 'formFieldKey', 'formFieldValue'),
  };
}

function uploadZip(signed, zipPath) {
  const url = new URL(signed.uploadUrl);
  const target = { hostname: url.hostname, path: url.pathname + url.search };
  const hasFields = Object.keys(signed.fields).length > 0;

  return new Promise((resolve, reject) => {
    const onResponse = res => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        res.resume();
        resolve();
        return;
      }
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => reject(new Error(`upload returned HTTP ${res.statusCode}${raw ? ` -- ${raw.slice(0, 500)}` : ''}`)));
    };

    if (hasFields) {
      // S3/GCS style: multipart POST with the policy fields, file last.
      const FormData = require('form-data');
      const form = new FormData();
      for (const [key, value] of Object.entries(signed.fields)) form.append(key, value);
      form.append('file', fs.createReadStream(zipPath), {
        filename: ZIP_NAME,
        contentType: 'application/zip',
      });

      form.getLength((err, length) => {
        if (err) {
          reject(new Error(`could not measure the upload body: ${err.message}`));
          return;
        }
        const req = https.request({
          ...target,
          method: signed.method || 'POST',
          headers: { ...signed.headers, ...form.getHeaders(), 'Content-Length': length },
        }, onResponse);
        req.on('error', reject);
        form.pipe(req);
      });
      return;
    }

    // Azure style: raw PUT of the zip bytes.
    const headers = {
      'Content-Type': 'application/zip',
      'Content-Length': fs.statSync(zipPath).size,
      ...signed.headers,
    };
    const req = https.request({ ...target, method: signed.method || 'PUT', headers }, onResponse);
    req.on('error', reject);
    fs.createReadStream(zipPath).pipe(req);
  });
}

function addDirectory(archive, dirPath, archivePath, stats) {
  for (const entry of fs.readdirSync(dirPath)) {
    if (NEVER_INCLUDE.has(entry)) continue;
    const fullPath = path.join(dirPath, entry);
    const entryArchivePath = path.posix.join(archivePath, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      addDirectory(archive, fullPath, entryArchivePath, stats);
    } else {
      archive.file(fullPath, { name: entryArchivePath });
      stats.files += 1;
    }
  }
}

function createZip(config) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });
    const stats = { files: 0, skipped: [] };

    output.on('close', () => resolve(stats));
    archive.on('error', reject);
    archive.pipe(output);

    for (const entry of config.include) {
      if (NEVER_INCLUDE.has(entry)) continue;
      const fullPath = path.join(process.cwd(), entry);
      if (!fs.existsSync(fullPath)) {
        stats.skipped.push(entry);
        continue;
      }
      if (fs.statSync(fullPath).isDirectory()) {
        addDirectory(archive, fullPath, entry, stats);
      } else {
        archive.file(fullPath, { name: entry });
        stats.files += 1;
      }
    }

    if (stats.files === 0) {
      archive.abort();
      reject(new Error(`nothing to upload -- none of [${config.include.join(', ')}] exist in ${process.cwd()}`));
      return;
    }

    archive.finalize();
  });
}

async function waitForDeployment(config, auth, deploymentUid, statusSoFar) {
  const apiPath = `/projects/${encodeURIComponent(config.projectUid)}`
    + `/environments/${encodeURIComponent(config.environmentUid)}`
    + `/deployments/${encodeURIComponent(deploymentUid)}`;

  let status = statusSoFar;
  let deployment = null;
  const deadline = Date.now() + config.timeoutMs;

  // Poll at least once even when the create call already returned a terminal
  // status, so the deployment URL is available for the final log line.
  for (;;) {
    const response = await launchApi(config, auth, apiPath, 'GET');
    deployment = response.deployment || response;
    if (deployment.status !== status) {
      status = deployment.status;
      console.log(`   status: ${status}`);
    }
    if (TERMINAL_STATUSES.has(status)) break;
    if (Date.now() > deadline) {
      fail(
        `deployment ${deploymentUid} was still ${status} after ${config.timeoutMs / 1000}s`,
        'The deployment is still running in Launch -- follow it in the Launch UI, or raise DEPLOYMENT_TIMEOUT_SECONDS.'
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return { status, deployment };
}

async function main() {
  const config = loadConfig();
  const commit = env('BITBUCKET_COMMIT');
  const branch = env('BITBUCKET_BRANCH');

  console.log('Redeploying to Contentstack Launch');
  console.log(`  region      : ${config.region || 'custom'} (${config.hosts.launch})`);
  console.log(`  project     : ${config.projectUid}`);
  console.log(`  environment : ${config.environmentUid}`);
  if (branch || commit) {
    console.log(`  source      : ${branch || 'unknown branch'}${commit ? ` @ ${commit.slice(0, 8)}` : ''}`);
  }

  try {
    console.log('\n1/5 Fetching an access token...');
    const auth = await getAccessToken(config);

    console.log('2/5 Zipping the project...');
    const stats = await createZip(config);
    const sizeMb = (fs.statSync(ZIP_PATH).size / (1024 * 1024)).toFixed(2);
    console.log(`     ${stats.files} file(s), ${sizeMb} MB`);
    if (stats.skipped.length) {
      console.log(`     not present, skipped: ${stats.skipped.join(', ')}`);
    }

    console.log('3/5 Requesting a signed upload URL...');
    const signedUrlPath = `/projects/${encodeURIComponent(config.projectUid)}`
      + `/environments/${encodeURIComponent(config.environmentUid)}`
      + '/deployments/upload/signed_url';
    const signed = normalizeSignedUrl(await launchApi(config, auth, signedUrlPath, 'GET'));
    if (!signed.uploadUrl || !signed.uploadUid) {
      throw new Error('the signed URL response did not contain uploadUrl and uploadUid');
    }

    console.log('4/5 Uploading the zip...');
    await uploadZip(signed, ZIP_PATH);

    console.log('5/5 Creating the deployment...');
    const deploymentsPath = `/projects/${encodeURIComponent(config.projectUid)}`
      + `/environments/${encodeURIComponent(config.environmentUid)}`
      + '/deployments';
    const created = await launchApi(config, auth, deploymentsPath, 'POST', { uploadUid: signed.uploadUid });
    const deployment = created.deployment || created;
    console.log(`     deployment ${deployment.uid} (#${deployment.deploymentNumber}) -- ${deployment.status}`);

    if (!config.waitForDeployment) {
      console.log('\nQueued. WAIT_FOR_DEPLOYMENT=false, so the pipeline is not waiting for the result.');
      return;
    }

    const result = await waitForDeployment(config, auth, deployment.uid, deployment.status);
    const url = result.deployment?.deploymentUrl;

    if (FAILURE_STATUSES.has(result.status)) {
      fail(
        `deployment ${deployment.uid} finished as ${result.status}`,
        'Open the deployment in the Launch UI for the build logs.'
      );
    }

    if (result.status === 'ARCHIVED') {
      console.log(`\nDeployment ${deployment.uid} was archived -- a newer deployment superseded it.`);
      return;
    }

    console.log(`\nDeployed. Status ${result.status}${url ? ` -- https://${url}` : ''}`);
  } catch (error) {
    fail(error.message);
  } finally {
    removeZip();
  }
}

main();
