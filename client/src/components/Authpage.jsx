import React, { useState, useEffect, useRef } from 'react';
import { useGoogleLogin } from '@react-oauth/google';

/* =====================================================================
   OJT TRACKER — AUTHENTICATION PAGE (Google OAuth only)
   Connected to the Express backend at API_BASE. On success, calls
   `onLogin` with the { user, token } payload so the parent component
   can store the session and redirect to the dashboard.

   The backend's /auth/google endpoint already handles both cases:
   - First-time Google sign-in  -> creates the account automatically
   - Returning user             -> logs them straight in
   No separate "register" flow is needed on the frontend anymore.
   ===================================================================== */

const THEME_STORAGE_KEY = 'ojt-dashboard-theme';

// Point this at your Express server. Adjust the port if yours differs.
const API_BASE = 'http://localhost:5000/api';

// ---------------------------------------------------------------------
// Minimal inline icon set — keeps the page dependency-free.
// ---------------------------------------------------------------------
const IconCheckCircle = (props) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    <path d="M8 12.3l2.6 2.6L16.2 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IconAlertCircle = (props) => (
  <svg width={18} height={18} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...props}>
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 7.5v5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <circle cx="12" cy="16.3" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

// Standard multi-color "G" glyph used for Google sign-in buttons.
const IconGoogle = (props) => (
  <svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true" {...props}>
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.56 2.7-3.86 2.7-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.85.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.94v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.94A9 9 0 0 0 0 9c0 1.45.35 2.83.94 4.03l3.01-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .94 4.97l3.01 2.33C4.66 5.17 6.65 3.58 9 3.58z" />
  </svg>
);

export default function AuthPage({ onLogin, onGoogleAuth }) {
  // --- Theme (shared with the dashboard, so it persists across the flow) --
  const [theme, setTheme] = useState(() => {
    try {
      const saved = localStorage.getItem(THEME_STORAGE_KEY);
      return saved === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can fail (private browsing, quota, etc.) — theme still
      // applies for the current session even if it can't be persisted.
    }
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));

  // --- Shared submit/notice state -------------------------------------------
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState(null); // { type: 'success' | 'error', message }
  const noticeTimerRef = useRef(null);

  const showNotice = (type, message, duration = 4000) => {
    setNotice({ type, message });
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), duration);
  };

  useEffect(
    () => () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    },
    []
  );

  // =========================================================================
  // GOOGLE SIGN-IN — the only authentication path. Existing backend logic
  // is unchanged: /auth/google creates a new account on first sign-in and
  // logs existing users straight in.
  // =========================================================================
  const handleGoogleClick = useGoogleLogin({
    onSuccess: async (tokenResponse) => {
      try {
        setIsSubmitting(true);

        const res = await fetch(`${API_BASE}/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            access_token: tokenResponse.access_token,
          }),
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Google login failed');
        }

        if (typeof onGoogleAuth === 'function') {
          await onGoogleAuth({ user: data.user, token: data.token });
        } else if (typeof onLogin === 'function') {
          await onLogin({ user: data.user, token: data.token });
        }
      } catch (err) {
        showNotice('error', err.message || 'Google login failed.');
      } finally {
        setIsSubmitting(false);
      }
    },
    onError: () => {
      showNotice('error', 'Google sign-in was cancelled or failed.');
    },
  });

  return (
    <div className="auth-shell" data-theme={theme}>
      {/* ============================================================= */}
      {/* BRANDING PANEL — hidden below 900px                            */}
      {/* ============================================================= */}
      <aside className="auth-brand-panel" aria-hidden="true">
        <div className="auth-brand-top">
          <div className="auth-brand-logo">
            <span className="auth-brand-logo-icon">⏱️</span>
            <span>OJT TRACKER</span>
          </div>
        </div>

        <div className="auth-brand-center">
          <h2 className="auth-brand-headline">Your OJT journey starts here.</h2>
          <p className="auth-brand-tagline">
            Track your progress, log your hours, and stay organized throughout your internship—all in one secure platform built for you.
          </p>
        </div>

        <p className="auth-brand-footer">Trusted by thousands of interns worldwide.</p>
      </aside>

      {/* ============================================================= */}
      {/* FORM PANEL                                                     */}
      {/* ============================================================= */}
      <main className="auth-form-panel">
        <button
          type="button"
          className="auth-theme-toggle"
          role="switch"
          aria-checked={theme === 'dark'}
          aria-label="Toggle dark mode"
          onClick={toggleTheme}
        >
          <span className="auth-theme-toggle-knob">
            <span className="auth-theme-toggle-icon auth-theme-toggle-icon-sun" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="12" cy="12" r="4.5" fill="currentColor" />
                <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="12" y1="1.5" x2="12" y2="3.5" /><line x1="12" y1="20.5" x2="12" y2="22.5" />
                  <line x1="4.4" y1="4.4" x2="5.8" y2="5.8" /><line x1="18.2" y1="18.2" x2="19.6" y2="19.6" />
                  <line x1="1.5" y1="12" x2="3.5" y2="12" /><line x1="20.5" y1="12" x2="22.5" y2="12" />
                  <line x1="4.4" y1="19.6" x2="5.8" y2="18.2" /><line x1="18.2" y1="5.8" x2="19.6" y2="4.4" />
                </g>
              </svg>
            </span>
            <span className="auth-theme-toggle-icon auth-theme-toggle-icon-moon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M20.5 13.4A8.5 8.5 0 1 1 10.6 3.5a7 7 0 0 0 9.9 9.9Z" fill="currentColor" />
              </svg>
            </span>
          </span>
        </button>

        <div className="auth-card auth-card-google-only">
          <div className="auth-card-mobile-logo" aria-hidden="true">
            <span>⏱️</span><span>OJT TRACKER</span>
          </div>

          <div className="auth-card-header">
            <span className="auth-card-eyebrow">Getting Started</span>
            <h1 className="auth-card-title">Welcome to OJT Tracker</h1>
            <p className="auth-card-subtitle">
              Sign in with your Google account to get started. First time here? We&apos;ll set up your profile in seconds.
            </p>
          </div>

          {notice && (
            <div className={`auth-notice auth-notice-${notice.type}`} role="status">
              {notice.type === 'success' ? <IconCheckCircle /> : <IconAlertCircle />}
              <span>{notice.message}</span>
            </div>
          )}

          <button
            type="button"
            className="auth-google-btn auth-google-btn-primary"
            onClick={handleGoogleClick}
            disabled={isSubmitting}
          >
            <IconGoogle />
            <span>{isSubmitting ? 'Signing in…' : 'Continue with Google'}</span>
          </button>

          <p className="auth-terms-note">
            By signing in, you agree to our Terms of Service. Your data is encrypted and secure.
          </p>
        </div>
      </main>
    </div>
  );
}
