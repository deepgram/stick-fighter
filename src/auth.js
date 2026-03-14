/**
 * OAuth2/OIDC authentication module with PKCE support.
 *
 * Manages login flow, token storage (localStorage), and user state.
 * Works with id.dx.deepgram.com as the identity provider.
 * Uses Authorization Code + PKCE (S256) for public client flow.
 */

const STORAGE_KEYS = {
  accessToken: 'sf_auth_access_token',
  idToken: 'sf_auth_id_token',
  refreshToken: 'sf_auth_refresh_token',
  expiresAt: 'sf_auth_expires_at',
  user: 'sf_auth_user',
};

/** Cached auth config from server */
let _authConfig = null;

/**
 * Fetch OIDC configuration from the server.
 * @returns {Promise<object>} Auth config (configured, clientId, authorizationEndpoint, etc.)
 */
export async function getAuthConfig() {
  if (_authConfig) return _authConfig;
  try {
    const resp = await fetch('/api/auth/config');
    if (!resp.ok) return { configured: false };
    _authConfig = await resp.json();
    return _authConfig;
  } catch {
    return { configured: false };
  }
}

/**
 * Check if OIDC login is available (server configured with client_id).
 * @returns {Promise<boolean>}
 */
export async function isAuthConfigured() {
  const config = await getAuthConfig();
  return config.configured === true;
}

/**
 * Initiate the login flow by redirecting to the OIDC provider.
 * Uses PKCE (S256) for secure public client auth.
 * @param {string} [returnPath] — optional path to return to after login (stored in sessionStorage)
 */
export async function login(returnPath) {
  const config = await getAuthConfig();
  if (!config.configured) {
    console.warn('[auth] OIDC not configured');
    return;
  }

  // Generate a random state parameter for CSRF protection
  const state = crypto.randomUUID();
  sessionStorage.setItem('sf_auth_state', state);

  // PKCE: generate code_verifier and code_challenge
  const codeVerifier = _generateCodeVerifier();
  sessionStorage.setItem('sf_auth_code_verifier', codeVerifier);
  const codeChallenge = await _computeCodeChallenge(codeVerifier);

  // Store return path so we can redirect back after callback
  if (returnPath) {
    sessionStorage.setItem('sf_auth_return_path', returnPath);
  }

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  window.location.href = `${config.authorizationEndpoint}?${params}`;
}

/**
 * Handle the OAuth callback — exchange the code for tokens using PKCE.
 * Call this when the router detects /auth/callback with a ?code= param.
 * @returns {Promise<object|null>} User info on success, null on failure.
 */
export async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');

  if (error) {
    console.error('[auth] OAuth error:', error, params.get('error_description'));
    return null;
  }

  if (!code) {
    console.error('[auth] No authorization code in callback');
    return null;
  }

  // Verify state parameter
  const savedState = sessionStorage.getItem('sf_auth_state');
  if (savedState && state !== savedState) {
    console.error('[auth] State mismatch — possible CSRF');
    return null;
  }
  sessionStorage.removeItem('sf_auth_state');

  // Retrieve PKCE code_verifier
  const codeVerifier = sessionStorage.getItem('sf_auth_code_verifier') || '';
  sessionStorage.removeItem('sf_auth_code_verifier');

  try {
    const config = await getAuthConfig();
    const body = { code, redirect_uri: config.redirectUri };
    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }

    const resp = await fetch('/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      console.error('[auth] Token exchange failed:', resp.status);
      return null;
    }

    const data = await resp.json();
    _storeTokens(data);

    // Clean the URL (remove ?code=&state= params)
    const returnPath = sessionStorage.getItem('sf_auth_return_path') || '/';
    sessionStorage.removeItem('sf_auth_return_path');
    window.history.replaceState({}, '', returnPath);

    return data.user || null;
  } catch (err) {
    console.error('[auth] Callback error:', err);
    return null;
  }
}

/**
 * Refresh the access token using the stored refresh_token.
 * @returns {Promise<boolean>} True if refresh succeeded.
 */
export async function refreshToken() {
  const refreshTokenValue = localStorage.getItem(STORAGE_KEYS.refreshToken);
  if (!refreshTokenValue) return false;

  try {
    const resp = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshTokenValue }),
    });

    if (!resp.ok) {
      // Refresh failed — clear auth state
      logout();
      return false;
    }

    const data = await resp.json();
    _storeTokens(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Log out — clear all stored auth data.
 */
export function logout() {
  for (const key of Object.values(STORAGE_KEYS)) {
    localStorage.removeItem(key);
  }
}

/**
 * Check if the user is currently logged in.
 * @returns {boolean}
 */
export function isLoggedIn() {
  return !!localStorage.getItem(STORAGE_KEYS.accessToken);
}

/**
 * Get the stored user info.
 * @returns {object|null} User object with id, name, email — or null.
 */
export function getUser() {
  const raw = localStorage.getItem(STORAGE_KEYS.user);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Get the stored access token.
 * @returns {string|null}
 */
export function getAccessToken() {
  return localStorage.getItem(STORAGE_KEYS.accessToken);
}

/**
 * Check if the token is expired and attempt refresh if needed.
 * Call on page load to keep the session alive.
 * @returns {Promise<boolean>} True if user is authenticated after check.
 */
export async function checkAuth() {
  if (!isLoggedIn()) return false;

  const expiresAt = parseInt(localStorage.getItem(STORAGE_KEYS.expiresAt) || '0', 10);
  const now = Date.now();

  // If token expires within 5 minutes, refresh it
  if (expiresAt && now > expiresAt - 5 * 60 * 1000) {
    const refreshed = await refreshToken();
    if (!refreshed) return false;
  }

  return true;
}

/**
 * Update the authenticated user's display name.
 * @param {string} newName — new username (2-30 chars, alphanumeric + hyphens)
 * @returns {Promise<{name: string}|{error: string}>}
 */
export async function updateUsername(newName) {
  const token = getAccessToken();
  if (!token) return { error: 'Not logged in' };

  try {
    const resp = await fetch('/api/auth/username', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ name: newName }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return { error: data.detail || `Error ${resp.status}` };
    }

    const data = await resp.json();
    // Update stored user info with new name
    const user = getUser();
    if (user) {
      user.name = data.name;
      localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(user));
    }
    return data;
  } catch {
    return { error: 'Network error' };
  }
}

// ── Internal helpers ──

function _storeTokens(data) {
  if (data.access_token) {
    localStorage.setItem(STORAGE_KEYS.accessToken, data.access_token);
  }
  if (data.id_token) {
    localStorage.setItem(STORAGE_KEYS.idToken, data.id_token);
  }
  if (data.refresh_token) {
    localStorage.setItem(STORAGE_KEYS.refreshToken, data.refresh_token);
  }
  if (data.expires_in) {
    const expiresAt = Date.now() + data.expires_in * 1000;
    localStorage.setItem(STORAGE_KEYS.expiresAt, expiresAt.toString());
  }
  if (data.user && data.user.id) {
    localStorage.setItem(STORAGE_KEYS.user, JSON.stringify(data.user));
  }
}

/**
 * Generate a random PKCE code_verifier (64 hex characters).
 * @returns {string}
 */
export function _generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute the PKCE code_challenge from a code_verifier using S256.
 * code_challenge = base64url(SHA-256(code_verifier))
 * @param {string} verifier
 * @returns {Promise<string>}
 */
export async function _computeCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
