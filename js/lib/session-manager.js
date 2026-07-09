// Session Manager - Unified session handling for web and mobile
// Handles session persistence, refresh, and mobile-specific lifecycle events

class SessionManager {
  constructor() {
    this.isMobile = this.detectMobile();
    this.sessionKey = 'supabase_session';
    this.rememberKey = 'remember_login';
    this.refreshInProgress = false;
    this.refreshPromise = null;
    
    this.setupEventListeners();
  }

  // Detect mobile devices
  detectMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
           (window.innerWidth <= 768 && 'ontouchstart' in window);
  }

  // Set up mobile-specific event listeners
  setupEventListeners() {
    if (!this.isMobile) return;

    // Handle page visibility changes (mobile app switching)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.handlePageVisible();
      } else {
        this.handlePageHidden();
      }
    });

    // Handle page focus (iOS Safari specific)
    window.addEventListener('focus', () => {
      this.handlePageVisible();
    });

    // Handle beforeunload to save session state
    window.addEventListener('beforeunload', () => {
      this.updateSessionActivity();
    });

    // Handle page load
    window.addEventListener('load', () => {
      this.handlePageVisible();
    });
  }

  // Handle page becoming visible
  async handlePageVisible() {
    const session = this.getSession();
    if (session) {
      await this.validateSession(session);
    }
  }

  // Handle page becoming hidden
  handlePageHidden() {
    this.updateSessionActivity();
  }

  // Get session from localStorage
  getSession() {
    try {
      const sessionData = localStorage.getItem(this.sessionKey);
      return sessionData ? JSON.parse(sessionData) : null;
    } catch (e) {
      return null;
    }
  }

  // Set session in localStorage
  setSession(sessionData) {
    try {
      const enhancedSession = {
        ...sessionData,
        last_activity: Date.now(),
        is_mobile: this.isMobile,
        created_at: sessionData.created_at || Date.now()
      };
      
      localStorage.setItem(this.sessionKey, JSON.stringify(enhancedSession));
      return true;
    } catch (e) {
      return false;
    }
  }

  // Clear session
  clearSession() {
    try {
      localStorage.removeItem(this.sessionKey);
      localStorage.removeItem(this.rememberKey);
      // Clear other auth-related data
      localStorage.removeItem('userTier');
      localStorage.removeItem('profileLastChecked');
      localStorage.removeItem('subscriptionLastChecked');
      localStorage.removeItem('cachedSubscription');
      localStorage.removeItem('encryptionKeyLastChecked');
      localStorage.removeItem('cachedKeyMaterial');
      localStorage.removeItem('cachedSalt');
      return true;
    } catch (e) {
      return false;
    }
  }

  // Update session activity timestamp
  updateSessionActivity() {
    try {
      const session = this.getSession();
      if (session) {
        session.last_activity = Date.now();
        localStorage.setItem(this.sessionKey, JSON.stringify(session));
      }
    } catch (e) {
      // Error updating activity
    }
  }

  // Check if session is valid
  isSessionValid(session) {
    if (!session || !session.access_token || !session.user) {
      return false;
    }

    return (session.expires_at || 0) > Date.now();
  }

  // Check if session needs refresh
  needsRefresh(session) {
    if (!session) return false;

    const now = Date.now();
    const expiresAt = session.expires_at || 0;
    const timeUntilExpiry = expiresAt - now;

    // Refresh shortly before expiry. A refresh token, rather than a synthetic
    // long-lived expiry, keeps a remembered login alive.
    return timeUntilExpiry < 10 * 60 * 1000;
  }

  // Validate session and refresh if needed
  async validateSession(session, refreshCallback) {
    if (!session) return null;

    // Update activity
    this.updateSessionActivity();

    // Check if session is still valid
    if (!this.isSessionValid(session)) {
      this.clearSession();
      return null;
    }

    // Check if refresh is needed
    if (this.needsRefresh(session) && refreshCallback) {
      return await this.refreshSession(session, refreshCallback);
    }

    return session;
  }

  // Refresh session with callback
  async refreshSession(session, refreshCallback) {
    // Prevent multiple simultaneous refresh attempts
    if (this.refreshInProgress) {
      return this.refreshPromise;
    }

    this.refreshInProgress = true;
    this.refreshPromise = this._performRefresh(session, refreshCallback);

    try {
      const result = await this.refreshPromise;
      return result;
    } finally {
      this.refreshInProgress = false;
      this.refreshPromise = null;
    }
  }

  // Perform the actual refresh
  async _performRefresh(session, refreshCallback) {
    try {
      const refreshedSession = await refreshCallback(session);
      
      if (refreshedSession) {
        this.setSession(refreshedSession);
        return refreshedSession;
      }
      
      // Keep a still-valid JWT if a refresh transiently fails, but never
      // invent a new expiry for it.
      if (this.isSessionValid(session)) {
        return session;
      }
      
      // Clear invalid session
      this.clearSession();
      return null;
      
    } catch (e) {
      // Keep using a token that is still genuinely valid.
      if (this.isSessionValid(session)) {
        return session;
      }
      
      this.clearSession();
      return null;
    }
  }

  // Set remember login preference
  setRememberLogin(remember = true) {
    if (remember) {
      localStorage.setItem(this.rememberKey, 'true');
    } else {
      localStorage.removeItem(this.rememberKey);
    }
  }

  // Check if login should be remembered
  shouldRememberLogin() {
    // Always remember login by default (like modern websites)
    // Users can explicitly opt out if they want
    const explicitlyDisabled = localStorage.getItem(this.rememberKey) === 'false';
    return !explicitlyDisabled;
  }

  // Create a session using Supabase's actual access-token expiry.
  createSession(authData) {
    const expiresIn = authData.expires_in || 3600;

    const session = {
      access_token: authData.access_token,
      refresh_token: authData.refresh_token,
      user: authData.user,
      expires_at: Date.now() + (expiresIn * 1000),
      expires_in: expiresIn,
      created_at: Date.now(),
      last_activity: Date.now(),
      is_mobile: this.isMobile
    };

    this.setSession(session);
    return session;
  }

  // Get session info for debugging
  getSessionInfo() {
    const session = this.getSession();
    if (!session) return null;

    const now = Date.now();
    return {
      isValid: this.isSessionValid(session),
      needsRefresh: this.needsRefresh(session),
      expiresIn: Math.max(0, session.expires_at - now),
      timeSinceActivity: now - (session.last_activity || 0),
      isMobile: session.is_mobile,
      createdAt: new Date(session.created_at || 0).toISOString()
    };
  }
}

// Export for use in other modules
window.SessionManager = SessionManager;
