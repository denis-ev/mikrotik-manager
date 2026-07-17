import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import type { User, UserRole } from '../types';

/**
 * Landing route for the OIDC redirect. The backend hands us the session JWT in
 * the URL fragment (never sent to the server); we hydrate the auth store and go
 * to the dashboard.
 */
export default function OidcCallbackPage() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const navigate = useNavigate();
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const token = hash.get('token');
    // Same-site relative paths only (reject absolute / protocol-relative).
    const rawReturn = hash.get('returnTo') || '/dashboard';
    const returnTo = /^\/(?!\/)[^\\]*$/.test(rawReturn) ? rawReturn : '/dashboard';

    if (!token) {
      navigate('/login?error=sso&reason=' + encodeURIComponent('No token returned'), { replace: true });
      return;
    }

    // Persist the token first so the /me request is authenticated.
    setAuth(token, { id: 0, username: '', role: 'viewer' });
    authApi.me()
      .then((r) => {
        const u = (r.data as { user: { userId?: number; id?: number; username: string; role: UserRole } }).user;
        const user: User = { id: u.id ?? u.userId ?? 0, username: u.username, role: u.role };
        setAuth(token, user);
        navigate(returnTo.startsWith('/') ? returnTo : '/dashboard', { replace: true });
      })
      .catch(() => {
        useAuthStore.getState().logout();
        navigate('/login?error=sso&reason=' + encodeURIComponent('Could not load your account'), { replace: true });
      });
  }, [navigate, setAuth]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="flex items-center gap-3 text-slate-500">
        <span className="inline-block w-5 h-5 border-2 border-slate-400/30 border-t-slate-400 rounded-full animate-spin" />
        Signing you in…
      </div>
    </div>
  );
}
