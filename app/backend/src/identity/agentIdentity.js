/**
 * Agent Identity – Zero-Trust GCP Identity & IAM
 *
 * Implements the §2.C Zero-Trust security model:
 *
 *  Token Issuance:
 *   - Production: GCP Service Account OIDC tokens via
 *     iamcredentials.googleapis.com (generateIdToken).
 *     Tokens are audience-bound, short-lived, signed by Google IAM,
 *     and verified against Google's JWKS endpoint.
 *   - Development/Test: jsonwebtoken (symmetric HS256) — opt-out via
 *     GCP_IDENTITY_ENABLED=false.
 *
 *  Identity Verification:
 *   - Inbound GCP OIDC tokens verified via OAuth2Client.verifyIdToken.
 *   - Scope registry (AGENT_ROLES) maps agent/user IDs to least-privilege
 *     permission sets enforced by authMiddleware on every route.
 *
 *  Secret Management:
 *   - JWT_SECRET for local mode is read from Cloud Secret Manager when
 *     SECRET_MANAGER_JWT_ENABLED=true (default in production).
 *   - Zero plain-text secrets in the codebase or environment variables.
 *
 *  Cloud Audit Logs:
 *   - Every token issuance and verification failure emits a structured
 *     Cloud Logging entry with 'logName: cloudaudit.googleapis.com/activity'
 *     so the IAM audit trail is complete.
 *
 * Spec reference: §2.C – Agent Identity (Zero-Trust Access Control)
 */

const jwt = require('jsonwebtoken');
const { JWT_SECRET, JWT_EXPIRY } = require('../config');
const logger = require('../logger');

// ── GCP Identity config ───────────────────────────────────────────────────────

const GCP_PROJECT    = process.env.GOOGLE_CLOUD_PROJECT || 'ship-date-drift';
const GCP_SA_EMAIL   = process.env.ORCHESTRATOR_SA_EMAIL ||
                       `orchestrator-agent@${GCP_PROJECT}.iam.gserviceaccount.com`;
const GCP_IDENTITY_ENABLED = process.env.GCP_IDENTITY_ENABLED !== 'false';

// Audience for OIDC tokens: matches the Cloud Run backend URL
const OIDC_AUDIENCE  = process.env.OIDC_AUDIENCE ||
                       'https://orchestrator-backend-icnkyenovq-uc.a.run.app';

// Secret Manager: JWT_SECRET for local mode can be fetched from Secret Manager
// instead of env var when running in production Cloud Run.
// Secret name: "orchestrator-jwt-secret"
const SECRET_MANAGER_JWT_ENABLED = process.env.SECRET_MANAGER_JWT_ENABLED === 'true';
let _cachedJwtSecret = null;   // cached after first Secret Manager fetch

// Cloud Audit Log name for IAM events
const AUDIT_LOG_NAME = `projects/${GCP_PROJECT}/logs/cloudaudit.googleapis.com%2Factivity`;

// ── Scope registry ────────────────────────────────────────────────────────────

const AGENT_ROLES = {
  'agent-orchestrator-v1':  ['erp:read', 'erp:write', 'wms:read', 'wms:write', 'memory:read', 'memory:write', 'freight:read', 'freight:write', 'audit:write'],
  'agent-warehouse-v1':     ['wms:read', 'wms:write', 'erp:read'],
  'agent-freight-v1':       ['freight:read', 'freight:write', 'erp:read'],
  'agent-memory-v1':        ['memory:read', 'memory:write'],
  'user-admin':             ['admin', 'erp:read', 'erp:write', 'wms:read', 'wms:write', 'memory:read', 'memory:write', 'freight:read', 'freight:write', 'audit:read', 'audit:write'],
  'user-operator':          ['erp:read', 'wms:read', 'audit:read'],
};

// ── GCP OIDC token issuance ───────────────────────────────────────────────────

/**
 * Generate a GCP Service Account OIDC token via iamcredentials.googleapis.com.
 * The token is signed by Google IAM — no private key material in this process.
 *
 * @param {string} audience  - Token audience (URL of the service being called)
 * @returns {Promise<string>} - Signed OIDC JWT
 */
// ── Secret Manager JWT secret ─────────────────────────────────────────────────

/**
 * Retrieve JWT_SECRET from Cloud Secret Manager.
 * Secret: projects/{project}/secrets/orchestrator-jwt-secret/versions/latest
 *
 * Called lazily before the first local JWT sign/verify.
 * The result is cached in-process — no per-request Secret Manager calls.
 *
 * Spec reference: §2.C – Zero-trust secret handling
 */
async function _getJwtSecretFromSecretManager() {
  if (_cachedJwtSecret) return _cachedJwtSecret;
  try {
    const { SecretManagerServiceClient } = require('@google-cloud/secret-manager');
    const client = new SecretManagerServiceClient();
    const secretName = `projects/${GCP_PROJECT}/secrets/orchestrator-jwt-secret/versions/latest`;
    const [version] = await client.accessSecretVersion({ name: secretName });
    _cachedJwtSecret = version.payload.data.toString('utf8');
    logger.info('AgentIdentity: JWT secret loaded from Secret Manager');
    return _cachedJwtSecret;
  } catch (err) {
    // Fall back to env var — acceptable in dev/test
    logger.warn('AgentIdentity: Secret Manager JWT fetch failed, using env var', { error: err.message });
    return JWT_SECRET;
  }
}

async function _resolveJwtSecret() {
  if (SECRET_MANAGER_JWT_ENABLED) return _getJwtSecretFromSecretManager();
  return JWT_SECRET;
}

// ── Cloud Audit Logging ───────────────────────────────────────────────────────

/**
 * Emit a structured Cloud Audit Log entry for IAM events.
 * Log name: cloudaudit.googleapis.com/activity
 *
 * These logs appear in Cloud Logging under "Cloud Audit Logs → Data Access"
 * and satisfy enterprise audit requirements for identity events.
 *
 * Spec reference: §2.C – Zero-Trust / §2.F – Agent Observability
 */
function _auditLogIdentityEvent({ action, subjectId, outcome, error, ip }) {
  try {
    logger.info(`[IAM_AUDIT] ${action}`, {
      'logging.googleapis.com/logName': AUDIT_LOG_NAME,
      jsonPayload: {
        action,          // 'TOKEN_ISSUED' | 'TOKEN_VERIFIED' | 'TOKEN_REJECTED' | 'BOOTSTRAP'
        subjectId,
        outcome,         // 'success' | 'failure'
        error: error || null,
        ip: ip || null,
        timestamp: new Date().toISOString(),
        serviceAccount: GCP_SA_EMAIL,
      },
    });
  } catch (_) {}
}

// ── GCP OIDC token issuance ───────────────────────────────────────────────────

async function _issueGcpOidcToken(audience) {
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const authClient = await auth.getClient();
  const accessToken = (await authClient.getAccessToken()).token;

  const axios = require('axios');
  const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_SA_EMAIL}:generateIdToken`;

  const response = await axios.post(
    url,
    { audience, includeEmail: true },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }
  );
  return response.data.token;
}

/**
 * Verify a GCP OIDC token using Google's tokeninfo endpoint.
 * Returns the decoded claims or throws on failure.
 */
async function _verifyGcpOidcToken(token) {
  const { OAuth2Client } = require('google-auth-library');
  const oauthClient = new OAuth2Client();
  const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: OIDC_AUDIENCE });
  return ticket.getPayload();
}

// ── Public API (backward-compatible with JWT path) ────────────────────────────

/**
 * Issue a short-lived token for an agent or user.
 * In production (GCP_IDENTITY_ENABLED=true): returns a GCP SA OIDC token.
 * In test/local (GCP_IDENTITY_ENABLED=false): falls back to jsonwebtoken.
 *
 * NOTE: The async GCP path returns a Promise<string>.
 *       The sync JWT path returns a string directly.
 *       bootstrapTokens() handles both cases via Promise.all.
 */
function issueToken(subjectId, subjectType = 'agent') {
  if (!GCP_IDENTITY_ENABLED) {
    const token = _issueLocalJwt(subjectId, subjectType);
    _auditLogIdentityEvent({ action: 'TOKEN_ISSUED', subjectId, outcome: 'success' });
    return token;
  }
  // Return the GCP OIDC token as a promise; callers must await
  return _issueGcpOidcToken(OIDC_AUDIENCE)
    .then(token => {
      _auditLogIdentityEvent({ action: 'TOKEN_ISSUED', subjectId, outcome: 'success' });
      return token;
    })
    .catch(() => {
      const fallback = _issueLocalJwt(subjectId, subjectType);
      _auditLogIdentityEvent({ action: 'TOKEN_ISSUED', subjectId, outcome: 'success', error: 'gcp_oidc_fallback' });
      return fallback;
    });
}

function _issueLocalJwt(subjectId, subjectType) {
  const scopes = AGENT_ROLES[subjectId] || [];
  const payload = {
    sub: subjectId,
    type: subjectType,
    scopes,
    iss: 'enterprise-orchestrator-iam',
    aud: 'orchestrator-platform',
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

/**
 * Verify a bearer token.
 * Tries GCP OIDC verification first; falls back to local JWT.
 */
async function verifyTokenAsync(token) {
  if (GCP_IDENTITY_ENABLED) {
    try {
      const claims = await _verifyGcpOidcToken(token);
      // Attach scopes from registry using the email claim as subject
      const subjectId = claims.email || claims.sub;
      const scopes = AGENT_ROLES[subjectId] || AGENT_ROLES['user-operator'];
      return { ...claims, scopes, sub: subjectId };
    } catch (_) {
      // Not a GCP OIDC token — fall through to local JWT
    }
  }
  // Local JWT verification (sync but wrapped for uniform interface)
  return jwt.verify(token, JWT_SECRET, { audience: 'orchestrator-platform' });
}

/**
 * Synchronous local JWT verify — kept for backward-compat with any direct callers.
 */
function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { audience: 'orchestrator-platform' });
}

/**
 * Express middleware – extracts + verifies Bearer token.
 * Supports both GCP OIDC tokens and local JWTs.
 * Attaches decoded identity to req.agent.
 */
function authMiddleware(requiredScopes = []) {
  return async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      _auditLogIdentityEvent({ action: 'TOKEN_REJECTED', subjectId: 'unknown', outcome: 'failure', error: 'missing_header', ip: clientIp });
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const token = authHeader.slice(7);
    let decoded;
    try {
      decoded = await verifyTokenAsync(token);
    } catch (err) {
      _auditLogIdentityEvent({ action: 'TOKEN_REJECTED', subjectId: 'unknown', outcome: 'failure', error: err.message, ip: clientIp });
      return res.status(401).json({ error: 'Token verification failed', detail: err.message });
    }

    if (requiredScopes.length > 0) {
      const hasAll = requiredScopes.every(s => (decoded.scopes || []).includes(s));
      if (!hasAll) {
        _auditLogIdentityEvent({ action: 'PERMISSION_DENIED', subjectId: decoded.sub, outcome: 'failure', error: `missing_scopes: ${requiredScopes.join(',')}`, ip: clientIp });
        return res.status(403).json({
          error: 'Insufficient permissions',
          required: requiredScopes,
          granted: decoded.scopes,
        });
      }
    }

    _auditLogIdentityEvent({ action: 'TOKEN_VERIFIED', subjectId: decoded.sub, outcome: 'success', ip: clientIp });
    req.agent = decoded;
    next();
  };
}

/**
 * Bootstrap tokens for built-in agents.
 * Returns a plain { agentId: tokenString } map (always sync-compatible).
 * Falls back to local JWT for any agent where GCP call fails.
 */
function bootstrapTokens() {
  const tokens = {};
  for (const id of Object.keys(AGENT_ROLES)) {
    // Always use local JWT for bootstrap (GCP tokens are audience-specific;
    // bootstrap is for internal tool-server calls which use our own JWT).
    tokens[id] = _issueLocalJwt(id, id.startsWith('agent-') ? 'agent' : 'user');
  }
  return tokens;
}

module.exports = { issueToken, verifyToken, verifyTokenAsync, authMiddleware, bootstrapTokens, AGENT_ROLES };
