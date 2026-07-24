import React, { useState, useEffect } from 'react';
import AuthPage from './components/AuthPage';
import OJTDashboard from './components/OJTDashboard';

// Must match the key internshipConfigApi.js / attendanceapi.js read from.
const TOKEN_STORAGE_KEY = 'ojt-auth-token';
const API_BASE = `${import.meta.env.VITE_API_URL}/api`;

function App() {
  // Now holds the real user object from the backend ({ id, username,
  // email, role }), not just a boolean. null = logged out.
  const [user, setUser] = useState(null);

  // True only while the initial "is there a valid session?" check is
  // running on mount — prevents flashing the login page for a moment
  // before a stored token has had a chance to be verified.
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  // On first load, a token may already be sitting in localStorage from a
  // previous visit. Verify it against the backend (rather than just
  // trusting its presence) and restore the session if it's still valid.
  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      const token = localStorage.getItem(TOKEN_STORAGE_KEY);
      if (!token) {
        setIsCheckingSession(false);
        return;
      }

      try {
        const res = await fetch(`${API_BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });

        if (!res.ok) {
          // Token expired, invalid, or the account no longer exists —
          // clear it so the person isn't stuck bouncing on every refresh.
          localStorage.removeItem(TOKEN_STORAGE_KEY);
          if (!cancelled) setUser(null);
          return;
        }

        const data = await res.json();
        if (!cancelled) setUser(data.user);
      } catch {
        // Network error (e.g. backend not running) — don't clear the
        // token here, since it may still be valid; just fall back to
        // the login screen for this session.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setIsCheckingSession(false);
      }
    }

    restoreSession();
    return () => { cancelled = true; };
  }, []);

  // AuthPage's handleLoginSubmit already hits the real /api/auth/login
  // endpoint and calls this with the actual { user, token } response —
  // nothing mocked here anymore.
  const handleLogin = ({ user, token }) => {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // Storage can fail (private browsing, quota, etc.) — the session
      // still works for the current tab even if it won't persist a reload.
    }
    setUser(user);
  };

  // Registration returns the same { user, token } shape as login, and
  // logs the person straight in since there's no email verification step.
  const handleRegister = ({ user, token }) => {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, token);
    } catch {
      // See handleLogin.
    }
    setUser(user);
  };

  const handleLogout = () => {
    try {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
    } catch {
      // Nothing to do if storage isn't available.
    }
    setUser(null);
  };

  // Brief loading state while restoreSession() runs — avoids showing the
  // login form for a split second on every refresh before a valid,
  // already-stored token has been confirmed.
  if (isCheckingSession) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <p className="text-slate-500 text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 antialiased selection:bg-blue-500 selection:text-white">
      {user ? (
        <OJTDashboard user={user} onLogout={handleLogout} />
      ) : (
        <AuthPage onLogin={handleLogin} onRegister={handleRegister} />
      )}
    </div>
  );
}

export default App;