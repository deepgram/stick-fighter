/**
 * OAuth2/OIDC authentication module — server-managed session.
 *
 * Login flow is handled entirely server-side:
 *   1. Frontend redirects to /api/auth/login (server generates PKCE, redirects to OIDC provider)
 *   2. OIDC provider redirects back to /auth/callback (server exchanges code, sets session cookie)
 *   3. Server redirects to /multiplayer
 *
 * Session is stored in a cookie (sf_session) set by the server.
 * Frontend reads session via /api/auth/session endpoint.
 */

/** Cached session state */
let _session = null;
let _sessionChecked = false;

/**
 * Fetch OIDC configuration from the server.
 * @returns {Promise<object>} Auth config (configured, clientId, etc.)
 */
export async function getAuthConfig() {
  try {
    const resp = await fetch('/api/auth/config');
    if (!resp.ok) return { configured: false };
    return await resp.json();
  } catch {
    return { configured: false };
  }
}

/**
 * Check if OIDC login is available.
 * @returns {Promise<boolean>}
 */
export async function isAuthConfigured() {
  const config = await getAuthConfig();
  return config.configured === true;
}

/**
 * Initiate the login flow by redirecting to the server's login endpoint.
 * The server handles PKCE generation, stores the verifier, and redirects to the OIDC provider.
 * @param {string} [returnPath='/multiplayer'] — path to return to after login
 */
export function login(returnPath = '/multiplayer') {
  const params = new URLSearchParams({ return_path: returnPath });
  window.location.href = `/api/auth/login?${params}`;
}

/**
 * Log out — clear session cookie via server endpoint.
 */
export function logout() {
  _session = null;
  _sessionChecked = false;
  window.location.href = '/api/auth/logout';
}

/**
 * Check if the user is currently logged in (session cookie exists).
 * @returns {boolean}
 */
export function isLoggedIn() {
  return _session?.authenticated === true;
}

/**
 * Get the stored user info.
 * @returns {object|null} User object with id, name, email — or null.
 */
export function getUser() {
  return _session?.user || null;
}

/**
 * Check auth state by calling the server session endpoint.
 * Call on page load to restore session from cookie.
 * @returns {Promise<boolean>} True if user is authenticated.
 */
export async function checkAuth() {
  try {
    const resp = await fetch('/api/auth/session');
    if (!resp.ok) {
      _session = { authenticated: false };
      _sessionChecked = true;
      return false;
    }
    _session = await resp.json();
    _sessionChecked = true;
    return _session.authenticated === true;
  } catch {
    _session = { authenticated: false };
    _sessionChecked = true;
    return false;
  }
}

/**
 * Update the authenticated user's display name.
 * @param {string} newName — new username (2-30 chars, alphanumeric + hyphens)
 * @returns {Promise<{name: string}|{error: string}>}
 */
export async function updateUsername(newName) {
  if (!isLoggedIn()) return { error: 'Not logged in' };

  try {
    const resp = await fetch('/api/auth/username', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });

    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return { error: data.detail || `Error ${resp.status}` };
    }

    const data = await resp.json();
    // Update cached session with new name
    if (_session?.user) {
      _session.user.name = data.name;
    }
    return data;
  } catch {
    return { error: 'Network error' };
  }
}

/**
 * No-op handleCallback — kept for backwards compatibility.
 * The server now handles the callback directly.
 */
export async function handleCallback() {
  // Server handles /auth/callback — this is a no-op
  return null;
}

/**
 * No-op refreshToken — server manages token lifecycle.
 */
export async function refreshToken() {
  return await checkAuth();
}

/**
 * Get the access token from the session cookie (for API calls that need it).
 * @returns {string|null}
 */
export function getAccessToken() {
  // Read from cookie directly if needed
  const cookie = document.cookie.split('; ').find(c => c.startsWith('sf_session='));
  if (!cookie) return null;
  try {
    const data = JSON.parse(atob(cookie.split('=')[1]));
    return data.access_token || null;
  } catch {
    return null;
  }
}
