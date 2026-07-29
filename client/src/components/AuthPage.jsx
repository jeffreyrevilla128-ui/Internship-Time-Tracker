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

// Point this at your Express server. Adjust the port if yours differs.
const API_BASE = `${import.meta.env.VITE_API_URL}/api`;

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
  // --- Mobile onboarding flow --------------------------------------------
  // Below 900px the page starts on a full-screen hero. Once the intro
  // animation finishes (see the useEffect below) this flips true on its
  // own, revealing the existing Google-only auth card as a bottom sheet
  // that slides up over the hero. Desktop is unaffected —
  // .auth-mobile-hero is display:none there, so this state has no
  // visual effect above 900px.
  const [showAuthSheet, setShowAuthSheet] = useState(false);

  // --- Shared submit/notice state -------------------------------------------
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [notice, setNotice] = useState(null); // { type: 'success' | 'error', message }
  const noticeTimerRef = useRef(null);

  // --- Logo click "spin" animation ------------------------------------------
  // Two separate icon instances exist (desktop brand panel + mobile hero),
  // each gets its own ref so a click on one never affects the other.
  // Triggering via ref + classList (rather than React state) means a click
  // mid-animation can restart it immediately: remove the class, force a
  // reflow, then re-add it — no queued/overlapping animations, no jitter.
  const brandLogoIconRef = useRef(null);
  const mobileLogoIconRef = useRef(null);

  const spinLogo = (ref) => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove('auth-logo-spin');
    // eslint-disable-next-line no-void
    void el.offsetWidth; // force reflow so the animation restarts from 0%
    el.classList.add('auth-logo-spin');
  };

  const handleLogoKeyDown = (ref) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      spinLogo(ref);
    }
  };

  const clearLogoSpin = (e) => {
    e.currentTarget.classList.remove('auth-logo-spin');
  };

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
  // MOBILE LANDING INTRO — plays automatically on mount, no tap required.
  // Sequence: clock icon spins in -> headline/tagline fade up (pure CSS,
  // timed via animation-delay in AuthPage.css) -> Google sign-in sheet
  // slides up. The two timeouts below only need to (1) kick off the icon
  // spin and (2) flip showAuthSheet once the text has finished animating;
  // the icon and text animations themselves are driven entirely by CSS so
  // their timing stays in one place (the stylesheet).
  //   150ms  -> icon spin starts (900ms animation, ends ~1050ms)
  //   1100ms -> title starts fading up (600ms, ends 1700ms) [CSS]
  //   1300ms -> tagline starts fading up (600ms, ends 1900ms) [CSS]
  //   2000ms -> sheet + Google button slide up (450ms transition)
  useEffect(() => {
    const iconTimer = setTimeout(() => spinLogo(mobileLogoIconRef), 150);
    const sheetTimer = setTimeout(() => setShowAuthSheet(true), 2000);
    return () => {
      clearTimeout(iconTimer);
      clearTimeout(sheetTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <div className="auth-shell">
      {/* ============================================================= */}
      {/* BRANDING PANEL — hidden below 900px                            */}
      {/* ============================================================= */}
      <aside className="auth-brand-panel" aria-hidden="true">
        <div className="auth-brand-top">
          <div className="auth-brand-logo">
            <span
              className="auth-brand-logo-icon"
              ref={brandLogoIconRef}
              role="button"
              tabIndex={0}
              aria-label="OJT Tracker logo"
              onClick={() => spinLogo(brandLogoIconRef)}
              onKeyDown={handleLogoKeyDown(brandLogoIconRef)}
              onAnimationEnd={clearLogoSpin}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="#0891b2" strokeWidth="1.8" />
                <path d="M12 7v5.2l3.4 2" stroke="#0891b2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>OJT TRACKER</span>
          </div>
        </div>

        <div className="auth-brand-center">
          <h2 className="auth-brand-headline">Your OJT journey starts here.</h2>
          <p className="auth-brand-tagline">
            Track your progress, log your hours, and stay organized throughout your internship—all in one secure platform built for you.
          </p>
        </div>

        <p className="auth-brand-footer">Built to help you track your OJT journey, one log at a time.</p>
      </aside>

      {/* ============================================================= */}
      {/* FORM PANEL                                                     */}
      {/* ============================================================= */}
      <main className={`auth-form-panel${showAuthSheet ? ' auth-sheet-open' : ''}`}>
        {/* MOBILE-ONLY HERO — shown below 900px in place of the desktop
            brand panel (which is hidden at that width). display:none at
            min-width:900px, same pattern already used by
            .auth-brand-panel / .auth-card-mobile-logo above.

            Auto-playing intro (mobile only, see the useEffect above):
              1. Clock icon spins in on mount.
              2. Headline + tagline fade/slide up shortly after (CSS
                 animation-delay, no interaction needed).
              3. showAuthSheet flips true once that's done, sliding the
                 existing Google-only auth card up from the bottom as
                 an overlay over the hero (see .auth-sheet-open rules
                 in the CSS). No tap required at any step. */}
        <div className="auth-mobile-hero">
          <div className="auth-mobile-hero-content">
            <div className="auth-mobile-hero-logo">
              <span
                className="auth-mobile-hero-logo-icon"
                ref={mobileLogoIconRef}
                role="button"
                tabIndex={0}
                aria-label="OJT Tracker logo"
                onClick={() => spinLogo(mobileLogoIconRef)}
                onKeyDown={handleLogoKeyDown(mobileLogoIconRef)}
                onAnimationEnd={clearLogoSpin}
              >
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="#0891b2" strokeWidth="1.8" />
                  <path d="M12 7v5.2l3.4 2" stroke="#0891b2" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
              <span>OJT TRACKER</span>
            </div>
            <h1 className="auth-mobile-hero-title">Your OJT journey starts here.</h1>
            <p className="auth-mobile-hero-tagline">
              Track your progress, log your hours, and stay organized throughout your internship.
            </p>
          </div>
        </div>

        <div className="auth-card auth-card-google-only" aria-hidden={!showAuthSheet}>
          {/* Mobile-only compact heading — the hero above already carries
              the full welcome message on small screens, so this sheet
              just needs a short prompt instead of repeating it. Hidden
              on desktop, where .auth-card-header below still renders. */}
          <h2 className="auth-mobile-sheet-heading">Sign in to continue</h2>

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