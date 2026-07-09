// Simple Event Bus for centralized state management
class EventBus {
  constructor() {
    this.events = {};
  }

  emit(eventName, data) {
    if (this.events[eventName]) {
      this.events[eventName].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          // Event callback error
        }
      });
    }
  }

  on(eventName, callback) {
    if (!this.events[eventName]) {
      this.events[eventName] = [];
    }
    this.events[eventName].push(callback);
  }

  off(eventName, callback) {
    if (this.events[eventName]) {
      this.events[eventName] = this.events[eventName].filter(cb => cb !== callback);
    }
  }
}

// Initialize global event bus
window.eventBus = new EventBus();

// Main Application Orchestrator
class App {
  constructor() {
    this.currentUser = null;
    this.isAuthenticated = false;
    this.authCheckInProgress = false;
    this.authCheckPromise = null;
    this.subscriptionData = null; // Cache subscription data
    this.subscriptionCheckInProgress = false;
    this.init();
  }

  // Detect search engine crawlers to prevent redirect issues
  isSearchEngineCrawler() {
    const userAgent = navigator.userAgent.toLowerCase();
    const crawlers = [
      'googlebot',
      'bingbot',
      'slurp',
      'duckduckbot',
      'baiduspider',
      'yandexbot',
      'facebookexternalhit',
      'twitterbot',
      'linkedinbot'
    ];

    return crawlers.some(crawler => userAgent.includes(crawler));
  }

  async init() {
    // Show loading state for protected pages to prevent flashing
    this.showLoadingStateIfNeeded();

    // Initialize theme
    this.initTheme();

    // Wait for auth module to be ready
    await this.waitForAuthModule();

    // Check authentication status
    await this.checkAuthStatus();

    // If authenticated, load subscription status once for all modules
    if (this.isAuthenticated) {
      await this.loadSubscriptionStatusOnce();

      // Set up periodic session refresh for persistent login
      this.setupSessionRefresh();
    }

    // Initialize page-specific functionality
    this.initPageHandlers();

    // Set up global event listeners
    this.setupGlobalListeners();

    // Hide loading state
    this.hideLoadingState();
  }

  // Set up periodic session refresh to keep users logged in
  setupSessionRefresh() {
    // Check the local expiry often enough to refresh before a one-hour JWT expires.
    // This does not make a network request until the token is close to expiry.
    const refreshInterval = 5 * 60 * 1000; // 5 minutes
    const refreshWindow = 10 * 60 * 1000; // 10 minutes

    setInterval(async () => {
      try {
        const sessionData = localStorage.getItem('supabase_session');
        if (sessionData) {
          const session = JSON.parse(sessionData);
          const expiresAt = session.expires_at || 0;
          const now = Date.now();

          if (expiresAt - now < refreshWindow) {
            await this.refreshAuthToken(session);
          }
        }
      } catch (e) {
        // Session refresh failed silently
      }
    }, refreshInterval);

    // Set up mobile-specific session management
    this.setupMobileSessionHandling();
  }

  // Detect mobile devices
  isMobile() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (window.innerWidth <= 768 && 'ontouchstart' in window);
  }

  // Mobile-specific session handling
  setupMobileSessionHandling() {
    if (!this.isMobile()) return;

    // Handle page visibility changes (mobile app switching)
    document.addEventListener('visibilitychange', async () => {
      if (!document.hidden && this.isAuthenticated) {
        // Page became visible - check and refresh session if needed
        await this.checkAndRefreshSession();
      }
    });

    // Handle page focus (iOS Safari specific)
    window.addEventListener('focus', async () => {
      if (this.isAuthenticated) {
        await this.checkAndRefreshSession();
      }
    });

    // Handle beforeunload to save session state
    window.addEventListener('beforeunload', () => {
      if (this.isAuthenticated && this.currentUser) {
        // Ensure session is saved with current timestamp
        const sessionData = localStorage.getItem('supabase_session');
        if (sessionData) {
          try {
            const session = JSON.parse(sessionData);
            session.last_activity = Date.now();
            localStorage.setItem('supabase_session', JSON.stringify(session));
          } catch (e) {
            // Error saving session activity
          }
        }
      }
    });
  }

  // Check and refresh session if needed
  async checkAndRefreshSession() {
    try {
      const sessionData = localStorage.getItem('supabase_session');
      if (!sessionData) return;

      const session = JSON.parse(sessionData);
      const expiresAt = session.expires_at || 0;
      const now = Date.now();

      // Refresh shortly before the access token expires. Persistent login is
      // maintained by the refresh token, not by extending this timestamp.
      if (expiresAt - now < 10 * 60 * 1000) {
        await this.refreshAuthToken(session);
      }
    } catch (e) {
      // Session check failed
    }
  }

  // Centralized subscription status loading to avoid multiple API calls
  async loadSubscriptionStatusOnce() {
    if (this.subscriptionCheckInProgress) {
      return;
    }

    this.subscriptionCheckInProgress = true;

    try {
      // Check cache first
      const cachedData = localStorage.getItem('cachedSubscription');
      const cacheTime = localStorage.getItem('subscriptionCacheTime');

      if (cachedData && cacheTime) {
        const age = Date.now() - parseInt(cacheTime);
        if (age < 5 * 60 * 1000) { // 5 minutes cache
          this.subscriptionData = JSON.parse(cachedData);
          this.emitSubscriptionStateChange();
          return;
        }
      }

      // Load fresh data if not cached or expired
      if (window.api) {
        const response = await window.api.callFunction('subscription-api', {
          action: 'get_subscription_status'
        });

        if (!response.error) {
          this.subscriptionData = response;

          // Cache the response
          localStorage.setItem('cachedSubscription', JSON.stringify(response));
          localStorage.setItem('subscriptionCacheTime', Date.now().toString());

          this.emitSubscriptionStateChange();
        }
      }
    } catch (error) {
      // Subscription loading failed silently
    } finally {
      this.subscriptionCheckInProgress = false;
    }
  }

  // Emit subscription state change event
  emitSubscriptionStateChange() {
    if (window.eventBus && this.subscriptionData) {
      window.eventBus.emit('subscription:updated', this.subscriptionData);
    }
  }

  // Show loading state for protected pages to prevent redirect flashing
  showLoadingStateIfNeeded() {
    const currentPath = window.location.pathname;
    if (currentPath.includes('/dashboard') || currentPath.includes('/account')) {
      // Add a loading overlay to prevent content flashing during auth check
      const loadingOverlay = document.createElement('div');
      loadingOverlay.id = 'auth-loading-overlay';
      loadingOverlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: var(--bg-primary, #ffffff);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      `;
      // Create loading content safely
      const container = document.createElement('div');
      container.style.textAlign = 'center';
      
      const spinner = document.createElement('div');
      spinner.style.cssText = 'width: 40px; height: 40px; border: 3px solid #f3f3f3; border-top: 3px solid #007aff; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 16px;';
      
      const text = document.createElement('p');
      text.style.cssText = 'color: var(--text-secondary, #666); margin: 0;';
      text.textContent = 'Loading...';
      
      container.appendChild(spinner);
      container.appendChild(text);
      
      // Add keyframes style
      const style = document.createElement('style');
      style.textContent = '@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }';
      
      loadingOverlay.appendChild(container);
      loadingOverlay.appendChild(style);
      document.body.appendChild(loadingOverlay);
    }
  }

  // Hide loading state
  hideLoadingState() {
    const loadingOverlay = document.getElementById('auth-loading-overlay');
    if (loadingOverlay) {
      loadingOverlay.remove();
    }
  }

  // Wait for auth module to initialize - optimized with Promise.all
  async waitForAuthModule() {
    // Use Promise.race for timeout instead of polling loop
    const authModulePromise = new Promise((resolve) => {
      const checkAuth = () => {
        if (window.auth) {
          resolve(window.auth);
        } else {
          setTimeout(checkAuth, 50); // Reduced polling interval
        }
      };
      checkAuth();
    });

    const timeoutPromise = new Promise((resolve) => {
      setTimeout(() => resolve(null), 3000); // Reduced timeout to 3 seconds
    });

    const result = await Promise.race([authModulePromise, timeoutPromise]);
    if (!result) {
      // Auth module not available after timeout
    }
    return result;
  }

  initTheme() {
    // Check for saved theme preference or default to system preference
    const savedTheme = localStorage.getItem('theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme) {
      document.documentElement.setAttribute('data-theme', savedTheme);
    } else if (systemPrefersDark) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
    }

    // Listen for system theme changes
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('theme')) {
        document.documentElement.setAttribute('data-theme', e.matches ? 'dark' : 'light');
      }
    });
  }

  async checkAuthStatus() {
    // Prevent multiple simultaneous auth checks
    if (this.authCheckInProgress) {
      return this.authCheckPromise;
    }

    this.authCheckInProgress = true;
    this.authCheckPromise = this._performAuthCheck();

    try {
      const result = await this.authCheckPromise;
      // Emit auth state change event for other modules to listen
      this.emitAuthStateChange();
      return result;
    } finally {
      this.authCheckInProgress = false;
      this.authCheckPromise = null;
    }
  }

  // Decode the `exp` claim locally so old synthetic expiry timestamps cannot
  // keep an expired access token looking valid.
  getAccessTokenExpiresAt(accessToken) {
    try {
      const payload = accessToken?.split('.')[1];
      if (!payload) return 0;
      const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const decoded = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
      const { exp } = JSON.parse(decoded);
      return Number.isFinite(exp) ? exp * 1000 : 0;
    } catch (_) {
      return 0;
    }
  }

  // Emit auth state change event for centralized state management
  emitAuthStateChange() {
    const authData = {
      isAuthenticated: this.isAuthenticated,
      currentUser: this.currentUser
    };

    // Use custom event system for auth state sharing
    if (window.eventBus) {
      window.eventBus.emit('auth:stateChanged', authData);
    } else {
      // Fallback: store in global state
      window.authState = authData;
    }
  }

  // Restore authentication from localStorage with token refresh
  async restoreAuthFromStorage() {
    try {
      const cachedSession = localStorage.getItem('supabase_session');
      if (!cachedSession) {
        return null;
      }

      const sessionData = JSON.parse(cachedSession);
      if (!sessionData.access_token || !sessionData.user) {
        localStorage.removeItem('supabase_session');
        return null;
      }

      const now = Date.now();
      const tokenExpiresAt = this.getAccessTokenExpiresAt(sessionData.access_token);
      const expiresAt = tokenExpiresAt || sessionData.expires_at || 0;

      if (tokenExpiresAt && sessionData.expires_at !== tokenExpiresAt) {
        sessionData.expires_at = tokenExpiresAt;
        sessionData.expires_in = Math.max(0, Math.floor((tokenExpiresAt - now) / 1000));
        localStorage.setItem('supabase_session', JSON.stringify(sessionData));
      }

      const isMobile = this.isMobile();
      const refreshWindow = 10 * 60 * 1000; // refresh shortly before JWT expiry

      // If token expires within refresh window, try to refresh it
      if (expiresAt - now < refreshWindow) {
        try {
          const refreshed = await this.refreshAuthToken(sessionData);
          if (refreshed) {
            return refreshed;
          }
        } catch (e) {
          // For mobile, be more lenient with refresh failures
          if (isMobile && expiresAt > now) {
            // Token is still technically valid, keep using it
            return sessionData;
          }
          // Refresh failed, clear session
          localStorage.removeItem('supabase_session');
          return null;
        }
      }

      // Token is still valid
      if (expiresAt > now) {
        return sessionData;
      }

      // For mobile, be more lenient with expired tokens if they're recent
      if (isMobile && (now - expiresAt) < 24 * 60 * 60 * 1000) { // 24 hour grace period on mobile
        try {
          const refreshed = await this.refreshAuthToken(sessionData);
          if (refreshed) {
            return refreshed;
          }
        } catch (e) {
          // Even refresh failed, token is truly expired
        }
      }

      // Token is expired, clear it
      localStorage.removeItem('supabase_session');
      return null;
    } catch (e) {
      // Error parsing session, clear it
      localStorage.removeItem('supabase_session');
      return null;
    }
  }

  // Refresh authentication token
  async refreshAuthToken(sessionData) {
    if (!sessionData.refresh_token) {
      return null;
    }

    try {
      const response = await fetch('https://kqjcorjjvunmyrnzvqgr.supabase.co/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk'
        },
        body: JSON.stringify({
          refresh_token: sessionData.refresh_token
        })
      });

      if (!response.ok) {
        throw new Error('Token refresh failed');
      }

      const data = await response.json();

      if (data.access_token) {
        // `expires_in` is the JWT lifetime in seconds. Keep it accurate so an
        // expired access token is refreshed instead of being sent to Auth.
        const isMobile = this.isMobile();
        const expiresIn = data.expires_in || 3600;

        const newSession = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || sessionData.refresh_token,
          user: data.user || sessionData.user,
          expires_at: Date.now() + (expiresIn * 1000),
          expires_in: expiresIn,
          created_at: sessionData.created_at || Date.now(),
          last_activity: Date.now(),
          is_mobile: isMobile
        };

        localStorage.setItem('supabase_session', JSON.stringify(newSession));

        // Keep the shared API client in sync with the stored session. Without
        // this, its next request would still send the token that was refreshed.
        if (window.supabaseClient) {
          window.supabaseClient.accessToken = newSession.access_token;
          window.supabaseClient.currentUser = newSession.user;
        }

        // Update current auth state
        this.isAuthenticated = true;
        this.currentUser = newSession.user;

        return newSession;
      }

      return null;
    } catch (e) {
      return null;
    }
  }

  async _performAuthCheck() {
    try {
      // Skip redirects for search engine crawlers
      if (this.isSearchEngineCrawler()) {
        return;
      }

      const currentPath = window.location.pathname;

      // First, try to restore session from localStorage immediately
      const restoredAuth = await this.restoreAuthFromStorage();
      if (restoredAuth) {
        this.isAuthenticated = true;
        this.currentUser = restoredAuth.user;

        // If on login page and authenticated, redirect to dashboard
        if (currentPath === '/' || currentPath === '/index.html' || currentPath.endsWith('index.html')) {
          // Don't redirect if handling password reset
          const urlParams = new URLSearchParams(window.location.search);
          const hashParams = new URLSearchParams(window.location.hash.substring(1));

          const isRecovery = (urlParams.has('type') && urlParams.get('type') === 'recovery') ||
            (hashParams.has('type') && hashParams.get('type') === 'recovery');

          if (!isRecovery) {
            window.location.href = '/dashboard';
            return;
          }
        }
        return; // Successfully authenticated from storage
      }

      // Wait for auth module to initialize with timeout
      let authReady = false;
      let attempts = 0;
      const maxAttempts = 15; // 1.5 seconds max wait

      while (!authReady && attempts < maxAttempts) {
        if (window.auth && window.auth.supabaseClient) {
          authReady = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
        attempts++;
      }

      if (authReady && window.auth && window.auth.supabaseClient) {
        // Try to initialize the client and restore session
        try {
          await window.auth.supabaseClient.init();
        } catch (e) {
          // Client init failed, continue with fallback
        }

        const isAuthed = window.auth.isAuthenticated();
        const user = window.auth.getCurrentUser();

        if (isAuthed && user) {
          this.isAuthenticated = true;
          this.currentUser = user;

          // User is authenticated - redirect to dashboard if on login page
          if (currentPath === '/' || currentPath === '/index.html' || currentPath.endsWith('index.html')) {
            // Don't redirect if we're handling a password reset callback
            const urlParams = new URLSearchParams(window.location.search);
            const hashParams = new URLSearchParams(window.location.hash.substring(1));

            const isRecovery = (urlParams.has('type') && urlParams.get('type') === 'recovery') ||
              (hashParams.has('type') && hashParams.get('type') === 'recovery');

            if (!isRecovery) {
              window.location.href = '/dashboard';
              return;
            }
          }
        } else if (!this.isAuthenticated) {
          // Only redirect if we truly have no authentication
          this.isAuthenticated = false;
          this.currentUser = null;

          // User is not authenticated - redirect to login if on protected pages
          if (currentPath.includes('/dashboard') || currentPath.includes('/account')) {
            if (window.auth && window.auth.showNotification) {
              window.auth.showNotification('Session expired. Please sign in again.', 'info');
            }
            setTimeout(() => {
              window.location.href = '/?redirect=' + encodeURIComponent(currentPath);
            }, 1000);
            return;
          }
        }
      } else {
        // Auth module not ready after timeout
        if (currentPath.includes('/dashboard') || currentPath.includes('/account')) {
          // Only redirect if we don't have cached session data
          if (!cachedSession) {
            window.location.href = '/?redirect=' + encodeURIComponent(currentPath);
            return;
          }
          // If we have cached session, stay on page and let it load
        }

        // Set authenticated state based on cached session if available
        if (!this.isAuthenticated && cachedSession) {
          try {
            const sessionData = JSON.parse(cachedSession);
            if (sessionData.access_token && sessionData.user) {
              this.isAuthenticated = true;
              this.currentUser = sessionData.user;
            }
          } catch (e) {
            this.isAuthenticated = false;
          }
        }
      }
    } catch (error) {
      // Auth check failed - use cached session as fallback
      const currentPath = window.location.pathname;

      // Check for cached session as fallback
      try {
        const cachedSession = localStorage.getItem('supabase_session');
        if (cachedSession) {
          const sessionData = JSON.parse(cachedSession);
          if (sessionData.access_token && sessionData.user) {
            // Check if token is not expired
            const expiresAt = sessionData.expires_at || 0;
            const now = Date.now();

            if (expiresAt > now) {
              this.isAuthenticated = true;
              this.currentUser = sessionData.user;
              return; // Don't redirect if we have valid cached session
            }
          }
        }
      } catch (e) {
        // Cached session check failed - clear invalid data
        localStorage.removeItem('supabase_session');
      }

      // Only set to false if we don't have valid cached session
      if (!this.isAuthenticated) {
        this.isAuthenticated = false;
        this.currentUser = null;

        // On error, redirect protected pages to login only if no cached session
        if (currentPath.includes('/dashboard') || currentPath.includes('/account')) {
          // Add a small delay to prevent rapid redirects
          setTimeout(() => {
            window.location.href = '/?redirect=' + encodeURIComponent(currentPath);
          }, 1000);
        }
      }
    }
  }

  initPageHandlers() {
    const path = window.location.pathname;

    if (path === '/' || path === '/index.html' || path.endsWith('index.html')) {
      this.initLandingPage();
    } else if (path.includes('/dashboard')) {
      this.initDashboardPage();
    } else if (path.includes('/account')) {
      this.initAccountPage();
    }
  }

  initLandingPage() {
    // Auth form switching
    const showRegister = document.getElementById('showRegister');
    const showLogin = document.getElementById('showLogin');
    const showForgotPassword = document.getElementById('showForgotPassword');
    const backToLogin = document.getElementById('backToLogin');

    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    const forgotPasswordForm = document.getElementById('forgotPasswordForm');

    if (showRegister) {
      showRegister.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchAuthForm(loginForm, registerForm);
      });
    }

    if (showLogin) {
      showLogin.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchAuthForm(registerForm, loginForm);
      });
    }

    if (showForgotPassword) {
      showForgotPassword.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchAuthForm(loginForm, forgotPasswordForm);
      });
    }

    if (backToLogin) {
      backToLogin.addEventListener('click', (e) => {
        e.preventDefault();
        this.switchAuthForm(forgotPasswordForm, loginForm);
      });
    }

    // Form submissions will be handled in auth.js (task 3)
  }

  initDashboardPage() {
    // Dashboard-specific initialization will be handled in dashboard.js (task 4)
  }

  initAccountPage() {
    // Account-specific initialization will be handled in account.js (task 5)
  }

  switchAuthForm(hideForm, showForm) {
    hideForm.classList.add('hidden');
    showForm.classList.remove('hidden');
  }

  setupGlobalListeners() {
    // Dashboard link handler - check authentication first
    const dashboardLink = document.getElementById('dashboardLink');
    if (dashboardLink) {
      dashboardLink.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleDashboardAccess();
      });
    }

    // Account navigation links - handle with authentication check
    const accountLinks = document.querySelectorAll('a[href="/account"], a[href*="/account"]');
    accountLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleAccountAccess();
      });
    });

    // Dashboard navigation links - handle with authentication check  
    const dashboardLinks = document.querySelectorAll('a[href="/dashboard"], a[href*="/dashboard"]');
    dashboardLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        this.handleDashboardAccess();
      });
    });

    // Note: Logout functionality is handled in auth.js to avoid duplicate listeners

    // Global modal close functionality
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal')) {
        this.closeModal(e.target);
      }
      if (e.target.classList.contains('modal-close')) {
        this.closeModal(e.target.closest('.modal'));
      }
    });

    // Escape key to close modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const openModal = document.querySelector('.modal:not(.hidden)');
        if (openModal) {
          this.closeModal(openModal);
        }
      }
    });
  }

  async handleDashboardAccess() {
    // Check authentication with fallback to cached session
    const isAuthenticated = this.checkAuthenticationForNavigation();

    if (isAuthenticated) {
      // User is authenticated, go to dashboard
      window.location.href = '/dashboard';
    } else {
      // User is not authenticated, show message and scroll to sign-in form
      this.showAuthPrompt();
    }
  }

  async handleAccountAccess() {
    // Check authentication with fallback to cached session
    const isAuthenticated = this.checkAuthenticationForNavigation();

    if (isAuthenticated) {
      // User is authenticated, go to account page
      window.location.href = '/account';
    } else {
      // User is not authenticated, show message and scroll to sign-in form
      this.showAuthPrompt();
    }
  }

  // Helper method to check authentication for navigation with cached session fallback
  checkAuthenticationForNavigation() {
    // Use cached authentication state from main auth check to avoid redundant checks
    if (this.isAuthenticated && this.currentUser) {
      return true;
    }

    // First check if auth module is available and user is authenticated
    if (window.auth && window.auth.isAuthenticated()) {
      return true;
    }

    // Fallback: check cached session
    try {
      const cachedSession = localStorage.getItem('supabase_session');
      if (cachedSession) {
        const sessionData = JSON.parse(cachedSession);
        if (sessionData.access_token && sessionData.user) {
          // Check if token is not expired
          const expiresAt = sessionData.expires_at || 0;
          const now = Date.now();

          if (expiresAt > now) {
            return true; // Valid cached session
          }
        }
      }
    } catch (e) {
      // Error checking cached session
    }

    return false;
  }

  showAuthPrompt() {
    // Show a notification
    if (window.auth && window.auth.showNotification) {
      window.auth.showNotification('Please sign in to access your dashboard', 'info');
    }

    // Scroll to the auth form
    const authContainer = document.querySelector('.auth-container');
    if (authContainer) {
      authContainer.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });

      // Focus on email input
      setTimeout(() => {
        const emailInput = document.getElementById('loginEmail');
        if (emailInput) {
          emailInput.focus();
        }
      }, 500);
    }
  }

  logout() {
    // Delegate to auth module if available
    if (window.auth && window.auth.handleSignOut) {
      window.auth.handleSignOut();
    } else {
      // Fallback logout - clear all auth-related data
      localStorage.removeItem('supabase_session');
      localStorage.removeItem('remember_login');
      localStorage.removeItem('userTier');
      localStorage.removeItem('profileLastChecked');
      localStorage.removeItem('subscriptionLastChecked');
      localStorage.removeItem('cachedSubscription');
      localStorage.removeItem('encryptionKeyLastChecked');
      localStorage.removeItem('cachedKeyMaterial');
      localStorage.removeItem('cachedSalt');

      this.isAuthenticated = false;
      this.currentUser = null;

      // Show message and redirect
      this.showMessage('Signed out', 'success');
      setTimeout(() => {
        window.location.href = '/';
      }, 500);
    }
  }

  showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('hidden');
      document.body.style.overflow = 'hidden';
    }
  }

  hideModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  closeModal(modal) {
    if (modal) {
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  }

  showMessage(message, type = 'info') {
    // Create and show a temporary message
    const messageEl = document.createElement('div');
    messageEl.className = `${type}-message`;
    messageEl.textContent = message;

    // Insert at top of page
    const container = document.querySelector('.app-container');
    if (container) {
      container.insertBefore(messageEl, container.firstChild);

      // Auto-remove after 5 seconds
      setTimeout(() => {
        if (messageEl.parentNode) {
          messageEl.parentNode.removeChild(messageEl);
        }
      }, 5000);
    }
  }

  // Utility method for API calls (will be enhanced in task 2)
  async apiCall(endpoint, options = {}) {
    const baseUrl = 'https://your-supabase-url.supabase.co'; // Will be configured properly in task 2

    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (this.isAuthenticated) {
      const token = localStorage.getItem('auth_token');
      if (token) {
        defaultOptions.headers['Authorization'] = `Bearer ${token}`;
      }
    }

    const finalOptions = {
      ...defaultOptions,
      ...options,
      headers: {
        ...defaultOptions.headers,
        ...options.headers,
      },
    };

    try {
      const response = await fetch(`${baseUrl}${endpoint}`, finalOptions);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      // API call failed silently
      throw error;
    }
  }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.app = new App();
});

// Export for use in other modules
window.App = App;
