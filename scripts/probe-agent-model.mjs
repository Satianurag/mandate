#!/usr/bin/env node
/** Read the live Vertex catalog; optional tiny inference probe. Never prints credentials. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const command = promisify(execFile);
const modelIndex = process.argv.indexOf('--model');
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : null;
try {
  const [auth, config] = await Promise.all([
    command('gcloud', ['auth', 'print-access-token'], { timeout: 20000 }),
    command('gcloud', ['config', 'get-value', 'project'], { timeout: 10000 }),
  ]);
  const project = config.stdout.trim();
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) throw new Error('No valid gcloud project is configured');
  const headers = { authorization: `Bearer ${auth.stdout.trim()}`, 'content-type': 'application/json', 'x-goog-user-project': project };
  if (model && !/^gemini-[a-z0-9.-]+$/.test(model)) throw new Error('Pass a model ID from the live catalog or official documentation');
  const url = model
    ? `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/${model}:generateContent`
    : 'https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=100';
  const response = await fetch(url, {
    method: model ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(30000),
    ...(model ? { body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Return the JSON object {"ready":true}. Do not call tools.' }] }], generationConfig: { maxOutputTokens: 128, responseMimeType: 'application/json' } }) } : {}),
  });
  const text = await response.text(); let body;
  try { body = JSON.parse(text); } catch { throw new Error(`Vertex returned non-JSON HTTP ${response.status}`); }
  console.log(JSON.stringify({ project, model, status: response.status,
    ...(model ? { candidates: body.candidates, usage: body.usageMetadata } : { models: body.publisherModels?.filter(m => m.name?.includes('gemini')).map(m => ({ name: m.name, versionId: m.versionId })), nextPageToken: body.nextPageToken }),
    error: body.error ? { code: body.error.code, status: body.error.status, message: body.error.message } : undefined,
  }, null, 2));
  if (!response.ok) process.exitCode = 1;
} catch (error) {
  // Child-process errors can include command stdout. Never forward those objects.
  console.error(error?.cmd ? 'gcloud credential/configuration check failed; inspect gcloud login locally.' : error.message);
  process.exitCode = 1;
}
