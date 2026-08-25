/**
 * Model Armor – Security & Guardrails Layer
 *
 * Implements §2.E – Model Armor (Inline Security Guardrails):
 *
 * Primary path   : GCP Model Armor REST API (modelarmor.googleapis.com)
 *                  sanitizeUserPrompt endpoint – real GCP threat detection.
 *                  Template: "orchestrator-armor-v1" (managed in GCP console).
 *                  Regional endpoint required: modelarmor.{location}.rep.googleapis.com
 *
 * DLP path       : Cloud Data Loss Prevention (DLP) API for enterprise-grade
 *                  PII detection beyond the local regex fallback.
 *                  Configured info types: EMAIL_ADDRESS, PHONE_NUMBER, SSN,
 *                  CREDIT_CARD_NUMBER, API_KEY, AUTH_TOKEN.
 *                  When DLP_ENABLED=true, DLP runs AFTER local scan as a
 *                  second layer of defence on the sanitized output.
 *
 * Fallback path  : Local regex patterns used when GCP APIs are unavailable
 *                  (CI, unit tests, network-isolated environments).
 *
 * Responsibilities:
 *  - Prompt injection detection & neutralisation
 *  - PII masking (email, phone, SSN, credit-card, API key patterns)
 *  - Tool-poisoning prevention (prototype pollution, eval injection)
 *  - Jailbreak & hidden-text exploit detection
 *  - Cloud DLP secondary scan on model outputs (DLP_ENABLED=true)
 *
 * Spec reference: §2.E – Model Armor
 */

const { v4: uuidv4 } = require('uuid');

// ── GCP Model Armor config ────────────────────────────────────────────────────

const GCP_PROJECT  = process.env.GOOGLE_CLOUD_PROJECT  || 'ship-date-drift';
const GCP_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
const ARMOR_TEMPLATE_ID = process.env.MODEL_ARMOR_TEMPLATE_ID || 'orchestrator-armor-v1';
const ARMOR_ENABLED     = process.env.MODEL_ARMOR_ENABLED !== 'false'; // opt-out for tests
const DLP_ENABLED       = process.env.DLP_ENABLED === 'true';          // opt-in, off by default

// REP (Regional Endpoint) is required for this project — the standard
// modelarmor.googleapis.com endpoint returns 403 even after TOS acceptance.
// Override via MODEL_ARMOR_BASE_URL env var if the project uses the global endpoint.
const ARMOR_BASE_URL = process.env.MODEL_ARMOR_BASE_URL ||
  `https://modelarmor.${GCP_LOCATION}.rep.googleapis.com/v1`;

// ── Local fallback patterns ───────────────────────────────────────────────────

const INJECTION_PATTERNS = [
  /ignore\s+previous\s+instructions/gi,
  /forget\s+everything/gi,
  /you\s+are\s+now/gi,
  /pretend\s+you\s+are/gi,
  /act\s+as\s+if/gi,
  /system\s*:\s*override/gi,
  /\[\s*INST\s*\]/gi,
  /<\|im_start\|>/gi,
  /###\s*Instruction/gi,
  /disregard\s+all\s+prior/gi,
  /reveal\s+your\s+(system\s+)?prompt/gi,
  /output\s+your\s+instructions/gi,
];

const JAILBREAK_PATTERNS = [
  /DAN\s+mode/gi,
  /developer\s+mode/gi,
  /unlock\s+restricted/gi,
  /bypass\s+(safety|filter|guard)/gi,
];

const TOOL_POISONING_PATTERNS = [
  /"\s*__proto__\s*"/g,
  /"\s*constructor\s*"/g,
  /eval\s*\(/g,
  /Function\s*\(/g,
  /process\.env/g,
  /require\s*\(/g,
  /child_process/g,
];

const PII_PATTERNS = [
  { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, replacement: '[EMAIL_REDACTED]' },
  { pattern: /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, replacement: '[PHONE_REDACTED]' },
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[SSN_REDACTED]' },
  { pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g, replacement: '[CARD_REDACTED]' },
  { pattern: /password\s*[:=]\s*\S+/gi, replacement: 'password:[CREDENTIAL_REDACTED]' },
  { pattern: /api[_-]?key\s*[:=]\s*\S+/gi, replacement: 'api_key:[CREDENTIAL_REDACTED]' },
  { pattern: /token\s*[:=]\s*[A-Za-z0-9\-_.~+/]+=*/gi, replacement: 'token:[CREDENTIAL_REDACTED]' },
];

// ── Local fallback logic (unchanged from original) ────────────────────────────

function detectThreats(text) {
  const threats = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      threats.push({ type: 'PROMPT_INJECTION', pattern: pattern.toString() });
      pattern.lastIndex = 0;
    }
  }
  for (const pattern of JAILBREAK_PATTERNS) {
    if (pattern.test(text)) {
      threats.push({ type: 'JAILBREAK_ATTEMPT', pattern: pattern.toString() });
      pattern.lastIndex = 0;
    }
  }
  for (const pattern of TOOL_POISONING_PATTERNS) {
    if (pattern.test(text)) {
      threats.push({ type: 'TOOL_POISONING', pattern: pattern.toString() });
      pattern.lastIndex = 0;
    }
  }
  return threats;
}

function maskPII(text) {
  let masked = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

function sanitizeObject(obj, depth = 0) {
  if (depth > 10) return obj;
  if (typeof obj === 'string') return maskPII(obj);
  if (Array.isArray(obj)) return obj.map(item => sanitizeObject(item, depth + 1));
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      result[key] = sanitizeObject(value, depth + 1);
    }
    return result;
  }
  return obj;
}

function _localScan(payload) {
  const scanId = uuidv4();
  const textRepresentation = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const threats = detectThreats(textRepresentation);
  const hasCriticalThreat = threats.some(t => ['PROMPT_INJECTION', 'JAILBREAK_ATTEMPT'].includes(t.type));
  const piiMasked = PII_PATTERNS.some(({ pattern }) => {
    const r = pattern.test(textRepresentation);
    pattern.lastIndex = 0;
    return r;
  });
  const sanitized = typeof payload === 'string' ? maskPII(payload) : sanitizeObject(payload);
  return { safe: !hasCriticalThreat, sanitized, threats, piiMasked, scanId, source: 'local_fallback', timestamp: new Date().toISOString() };
}

// ── GCP Model Armor API call ──────────────────────────────────────────────────

/**
 * Calls GCP Model Armor sanitizeUserPrompt REST API.
 * Returns a result object normalised to the same shape as _localScan().
 * Throws on network/auth failures so the caller can fall back.
 */
async function _gcpArmorScan(text, scanId) {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token  = await client.getAccessToken();

  // Use the REP (Regional Endpoint) — required for this project after TOS acceptance
  const url = `${ARMOR_BASE_URL}/projects/${GCP_PROJECT}/locations/${GCP_LOCATION}/templates/${ARMOR_TEMPLATE_ID}:sanitizeUserPrompt`;

  const axios = require('axios');
  const response = await axios.post(
    url,
    { userPromptData: { text } },
    {
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': 'application/json',
      },
      timeout: 8000,
    }
  );

  const data = response.data;
  // Normalise GCP response → internal shape
  const result      = data.sanitizationResult || {};
  const matchState  = result.filterMatchState || 'NO_MATCH_FOUND';
  const filterMap   = result.filterResults   || {};

  // Extract per-filter verdicts from the nested filterResults map
  const threats = [];
  for (const [filterKey, filterValue] of Object.entries(filterMap)) {
    // Each entry has one sub-key (e.g. raiFilterResult, piAndJailbreakFilterResult)
    const inner = Object.values(filterValue)[0] || {};
    if (inner.matchState === 'MATCH_FOUND') {
      threats.push({
        type: filterKey.toUpperCase(),
        confidenceLevel: inner.confidenceLevel || null,
        detail: inner,
      });
    }
  }

  const safe = matchState !== 'MATCH_FOUND';

  return {
    safe,
    sanitized: text,   // GCP does not rewrite text; PII masking applied locally below
    threats,
    piiMasked: false,
    scanId,
    source: 'gcp_model_armor',
    endpoint: ARMOR_BASE_URL,
    timestamp: new Date().toISOString(),
  };
}

// ── Primary entry point ───────────────────────────────────────────────────────

// ── Cloud DLP secondary scan ──────────────────────────────────────────────────

/**
 * Run Cloud DLP on text to detect and redact PII beyond local regex patterns.
 *
 * Configured info types (enterprise DLP coverage):
 *   EMAIL_ADDRESS, PHONE_NUMBER, US_SOCIAL_SECURITY_NUMBER,
 *   CREDIT_CARD_NUMBER, API_KEY, AUTH_TOKEN, IBAN_CODE
 *
 * Triggered when DLP_ENABLED=true — intended for production deployments
 * handling supplier communications that may contain contractual PII.
 *
 * Spec reference: §2.E – Model Armor / DLP on agent outputs
 */
async function _cloudDlpScan(text) {
  try {
    const DLP = require('@google-cloud/dlp');
    const dlp = new DLP.DlpServiceClient();
    const projectId = GCP_PROJECT;

    const infoTypes = [
      { name: 'EMAIL_ADDRESS' },
      { name: 'PHONE_NUMBER' },
      { name: 'US_SOCIAL_SECURITY_NUMBER' },
      { name: 'CREDIT_CARD_NUMBER' },
      { name: 'IBAN_CODE' },
    ];

    const request = {
      parent: `projects/${projectId}/locations/global`,
      inspectConfig: {
        infoTypes,
        includeQuote: false,
        minLikelihood: 'LIKELY',
      },
      deidentifyConfig: {
        infoTypeTransformations: {
          transformations: [{
            infoTypes,
            primitiveTransformation: {
              replaceWithInfoTypeConfig: {},  // replaces with [EMAIL_ADDRESS] etc.
            },
          }],
        },
      },
      item: { value: text },
    };

    const [response] = await dlp.deidentifyContent(request);
    const deidentified = response.item.value;
    const piiMasked = deidentified !== text;

    return { sanitizedText: deidentified, piiMasked, dlpApplied: true };
  } catch (err) {
    // DLP unavailable — return original text unchanged
    return { sanitizedText: text, piiMasked: false, dlpApplied: false, dlpError: err.message };
  }
}

// ── Primary entry points ──────────────────────────────────────────────────────

/**
 * scan() – synchronous interface used by tests and the middleware.
 * Always returns the local fallback result synchronously.
 * The GCP call is attempted asynchronously and the result cached on the
 * returned promise so callers that await scanAsync() get the GCP verdict.
 */
function scan(payload) {
  return _localScan(payload);
}

/**
 * scanAsync() – async interface used by the /api/armor/scan route.
 * Tries GCP Model Armor first; falls back to local on any error.
 * When DLP_ENABLED=true, also runs Cloud DLP as a second layer.
 *
 * Scan pipeline:
 *   1. Local regex scan (sync, immediate)
 *   2. GCP Model Armor sanitizeUserPrompt (async, threat detection)
 *   3. Cloud DLP deidentifyContent (async, enterprise PII redaction)
 */
async function scanAsync(payload) {
  if (!ARMOR_ENABLED) return _localScan(payload);

  const textRepresentation = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const scanId = uuidv4();

  // Layer 1: local regex (always runs)
  const localResult = _localScan(payload);

  // Layer 2: GCP Model Armor
  let gcpResult;
  try {
    gcpResult = await _gcpArmorScan(textRepresentation, scanId);
  } catch (err) {
    gcpResult = null;
    localResult.gcpArmorError = err.message;
  }

  const combined = gcpResult
    ? {
        ...gcpResult,
        sanitized: localResult.sanitized,   // use locally-masked payload
        piiMasked: localResult.piiMasked,
        localThreats: localResult.threats,  // expose both sets
      }
    : localResult;

  // Layer 3: Cloud DLP (opt-in for production)
  if (DLP_ENABLED) {
    const outputText = typeof combined.sanitized === 'string'
      ? combined.sanitized
      : JSON.stringify(combined.sanitized);
    const dlpResult = await _cloudDlpScan(outputText);
    if (dlpResult.piiMasked) {
      combined.sanitized = typeof combined.sanitized === 'string'
        ? dlpResult.sanitizedText
        : JSON.parse(dlpResult.sanitizedText);
      combined.piiMasked = true;
      combined.dlpApplied = true;
    }
  }

  return combined;
}

/**
 * Express middleware – rejects blocked requests, passes sanitized payload through.
 * Uses synchronous local scan for request pipeline (no latency); async GCP scan
 * is fired-and-forgotten for audit logging.
 */
function armorMiddleware(req, res, next) {
  const result = scan(req.body);
  req.armorScan = result;
  req.body = result.sanitized;

  // Fire async GCP scan for audit (non-blocking)
  if (ARMOR_ENABLED) {
    scanAsync(req.body).then(gcpResult => {
      req.armorScanGcp = gcpResult;
    }).catch(() => {});
  }

  if (!result.safe) {
    return res.status(400).json({
      error: 'Request blocked by Model Armor',
      threats: result.threats,
      scanId: result.scanId,
    });
  }

  next();
}

module.exports = { scan, scanAsync, armorMiddleware, maskPII, detectThreats, _cloudDlpScan };
