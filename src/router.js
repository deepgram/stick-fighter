/**
 * Parse the current URL path to determine the route.
 * @param {string} [pathname] - Override for testing (defaults to window.location.pathname)
 * @returns {{ type: string, code?: string }}
 */
export function parseRoute(pathname) {
  if (pathname === undefined) {
    pathname = window.location.pathname;
  }
  const roomMatch = pathname.match(/^\/room\/([a-z0-9-]+)$/i);
  if (roomMatch) {
    return { type: 'room', code: roomMatch[1] };
  }
  if (pathname === '/auth/callback') {
    return { type: 'auth-callback' };
  }
  if (pathname === '/leaderboard') {
    return { type: 'leaderboard' };
  }
  return { type: 'home' };
}
