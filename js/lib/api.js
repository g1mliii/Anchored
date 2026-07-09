// URL Notes Web Application - Supabase API Client
// Adapted from extension for web environment without Chrome APIs

class SupabaseClient {
  constructor() {
    this.supabaseUrl = 'https://kqjcorjjvunmyrnzvqgr.supabase.co';
    this.supabaseAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtxamNvcmpqdnVubXlybnp2cWdyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3MTc4ODgsImV4cCI6MjA3MTI5Mzg4OH0.l-ZdPOYMNi8x3lBqlemwQ2elDyvoPy-2ZUWuODVviWk';
    this.apiUrl = `${this.supabaseUrl}/rest/v1`;
    this.authUrl = `${this.supabaseUrl}/auth/v1`;
    this.currentUser = null;
    this.accessToken = null;
    this._deletedNotesCleanupPromise = null;
  }

  // Web storage adapter - replaces chrome.storage.local
  async getStorage(keys) {
    if (Array.isArray(keys)) {
      const result = {};
      for (const key of keys) {
        const value = localStorage.getItem(key);
        if (value !== null) {
          try {
            result[key] = JSON.parse(value);
          } catch (e) {
            result[key] = value;
          }
        }
      }
      return result;
    } else if (typeof keys === 'string') {
      const value = localStorage.getItem(keys);
      if (value !== null) {
        try {
          return { [keys]: JSON.parse(value) };
        } catch (e) {
          return { [keys]: value };
        }
      }
      return {};
    } else {
      // Get all keys
      const result = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        const value = localStorage.getItem(key);
        try {
          result[key] = JSON.parse(value);
        } catch (e) {
          result[key] = value;
        }
      }
      return result;
    }
  }

  async setStorage(items) {
    for (const [key, value] of Object.entries(items)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  }

  async removeStorage(keys) {
    if (Array.isArray(keys)) {
      for (const key of keys) {
        localStorage.removeItem(key);
      }
    } else if (typeof keys === 'string') {
      localStorage.removeItem(keys);
    }
  }

  // PKCE helpers
  async generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return Array.from(array).map(b => ('0' + b.toString(16)).slice(-2)).join('');
  }

  async sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    return await crypto.subtle.digest('SHA-256', data);
  }

  base64UrlEncode(arrayBuffer) {
    let str = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
    return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // Read the JWT expiry rather than trusting a legacy localStorage timestamp.
  // Older releases wrote a 7-30 day value here for a token that only lived an hour.
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

  async generateCodeChallenge(verifier) {
    const hashed = await this.sha256(verifier);
    return this.base64UrlEncode(hashed);
  }

  // Initialize client and check auth status
  async init() {
    try {
      // Load config overrides if available
      try {
        if (window.urlNotesConfig?.loadConfig) {
          const cfg = await window.urlNotesConfig.loadConfig();
          if (cfg?.supabaseUrl) this.supabaseUrl = cfg.supabaseUrl;
          if (cfg?.supabaseAnonKey) this.supabaseAnonKey = cfg.supabaseAnonKey;
          this.apiUrl = `${this.supabaseUrl}/rest/v1`;
          this.authUrl = `${this.supabaseUrl}/auth/v1`;
        }
      } catch (e) {
        // Config load failed, using defaults
      }

      // Check for stored session
      const result = await this.getStorage(['supabase_session']);
      if (result.supabase_session) {
        const storedSession = result.supabase_session;
        this.accessToken = storedSession.access_token;
        this.currentUser = storedSession.user;
        const now = Date.now();
        const tokenExpiresAt = this.getAccessTokenExpiresAt(this.accessToken);
        const expiresAt = tokenExpiresAt || storedSession.expires_at || 0;
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

        // Correct sessions saved by earlier releases before deciding whether to
        // refresh. This makes the client recover instead of trusting a stale JWT.
        if (tokenExpiresAt && storedSession.expires_at !== tokenExpiresAt) {
          await this.setStorage({
            supabase_session: {
              ...storedSession,
              expires_at: tokenExpiresAt,
              expires_in: Math.max(0, Math.floor((tokenExpiresAt - now) / 1000))
            }
          });
        }

        // More aggressive token validation for mobile to prevent JWT errors
        if (expiresAt && expiresAt < now) {
          // Token is definitely expired, try to refresh
          try {
            await this.refreshSession();
          } catch (e) {
            // Refresh failed, sign out
            await this.signOut();
            return;
          }
        } else if (!expiresAt || (expiresAt - now) < 10 * 60 * 1000) {
          // Token expires within 10 minutes or has no expiry, refresh proactively
          try {
            await this.refreshSession();
          } catch (e) {
            // If refresh fails but token isn't expired yet, continue but validate
            if (isMobile) {
              // On mobile, validate token immediately to catch JWT issues early
              const isValid = await this.verifyToken();
              if (!isValid) {
                await this.signOut();
                return;
              }
            }
          }
        }

        // Always validate token on mobile to prevent dashboard errors
        if (isMobile) {
          const isValid = await this.verifyToken();
          if (!isValid) {
            // Token is invalid, try one refresh attempt
            try {
              await this.refreshSession();
              // Verify the refreshed token
              const isValidAfterRefresh = await this.verifyToken();
              if (!isValidAfterRefresh) {
                await this.signOut();
                return;
              }
            } catch (e) {
              await this.signOut();
              return;
            }
          }
        }

        // Session is valid, continue with profile setup
        if (this.accessToken && this.currentUser) {
          // Check if we need to create/update profile (only if not done recently)
          try {
            const { profileLastChecked, userTier } = await this.getStorage(['profileLastChecked', 'userTier']);
            const now = Date.now();
            const oneHour = 60 * 60 * 1000; // 1 hour in milliseconds

            // Only check profile if we haven't done so in the last hour AND don't have userTier
            if ((!profileLastChecked || (now - profileLastChecked) > oneHour) && !userTier) {
              await this.upsertProfile(this.currentUser);
              await this.setStorage({ profileLastChecked: now });
            } else if (userTier) {
              // Use cached subscription status
              try {
                window.eventBus?.emit('tier:changed', { tier: userTier, active: userTier !== 'free' });
              } catch (_) { }
            }
          } catch (e) {
            // Profile initialization failed
          }
        }
      }
    } catch (error) {
      // Supabase client initialization error
    }
  }

  // Get authorization headers
  getHeaders(includeAuth = true) {
    const headers = {
      'Content-Type': 'application/json',
      'apikey': this.supabaseAnonKey
    };

    if (includeAuth && this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    return headers;
  }

  // Internal: sleep helper for backoff
  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Centralized request helper with timeout, retry/backoff, and 401 refresh retry
  async _request(url, {
    method = 'GET',
    headers = {},
    body = undefined,
    auth = true,
    timeoutMs = 10000,
    maxRetries = 2,
    raw = false
  } = {}) {
    const makeOnce = async () => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init = { method, headers: { ...this.getHeaders(auth), ...headers }, signal: controller.signal };
        if (body !== undefined) {
          init.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        const res = await fetch(url, init);
        return res;
      } finally {
        clearTimeout(id);
      }
    };

    let attempt = 0;
    let didRefresh = false;
    let res;

    while (true) {
      try {
        res = await makeOnce();

        // Handle 401 once by refreshing session
        if (res.status === 401 && auth && !didRefresh) {
          try {
            await this.refreshSession();
            didRefresh = true;
            // retry immediately after refresh
            res = await makeOnce();
          } catch (e) {
            // fall through to error handling
          }
        }

        // Retry on 429/5xx with backoff
        if ((res.status === 429 || (res.status >= 500 && res.status <= 599)) && attempt < maxRetries) {
          const backoff = Math.min(2000 * Math.pow(2, attempt), 8000);
          await this._sleep(backoff);
          attempt++;
          continue;
        }

        if (raw) return res;

        const text = await res.text();
        let data;
        try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }

        if (!res.ok) {
          const detail = (data && (data.error_description || data.msg || data.error)) || (typeof data === 'string' ? data : 'Request failed');
          const err = new Error(detail);
          err.status = res.status;
          err.data = data;
          throw err;
        }

        return data;
      } catch (err) {
        // Retry network and abort errors
        const isAbort = err?.name === 'AbortError';
        const isNetwork = err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError');
        if ((isAbort || isNetwork) && attempt < maxRetries) {
          const backoff = Math.min(2000 * Math.pow(2, attempt), 8000);
          await this._sleep(backoff);
          attempt++;
          continue;
        }
        throw err;
      }
    }
  }

  // Sign in with email and password
  async signInWithEmail(email, password, options = {}) {
    try {
      const body = { email, password };

      // Add captcha token if provided
      if (options.captchaToken) {
        body.gotrue_meta_security = { captcha_token: options.captchaToken };
      }

      const data = await this._request(`${this.authUrl}/token?grant_type=password`, {
        method: 'POST',
        auth: false,
        body
      });
      await this.handleAuthSuccess(data);
      return data;
    } catch (error) {
      // Sign in error
      throw error;
    }
  }

  // Sign up with email and password
  async signUpWithEmail(email, password, options = {}) {
    try {
      const body = { email, password };

      // Add captcha token if provided
      if (options.captchaToken) {
        body.gotrue_meta_security = { captcha_token: options.captchaToken };
      }

      const data = await this._request(`${this.authUrl}/signup`, {
        method: 'POST',
        auth: false,
        body
      });

      // If we got an access token, user is authenticated immediately
      if (data.access_token) {
        await this.handleAuthSuccess(data);

        // Send verification email in background (non-blocking)
        // This allows user to login immediately while still getting verification email
        this.sendVerificationEmail(email).catch(() => {
          // Silently fail - don't block signup if email fails
        });
      }

      return data;
    } catch (error) {
      // Handle specific error cases
      if (error.status === 500) {
        error.message = 'Account creation failed due to server configuration. Please contact support or try again later.';
      } else if (error.message && error.message.includes('already')) {
        error.message = 'User already registered';
      }
      throw error;
    }
  }

  // Send verification email (for optional email verification after signup)
  async sendVerificationEmail(email) {
    try {
      await this._request(`${this.authUrl}/otp`, {
        method: 'POST',
        auth: false,
        body: {
          email,
          type: 'signup',
          options: {
            email_redirect_to: `${window.location.origin}/auth/confirm`
          }
        }
      });
    } catch (error) {
      // Email send failed - log but don't throw
      console.warn('Verification email send failed:', error.message);
    }
  }

  // Web-based OAuth sign in (without chrome.identity)
  async signInWithOAuth(provider) {
    try {
      // For web environment, we'll use redirect-based OAuth flow
      const redirectUri = window.location.origin + '/auth/callback';
      const codeVerifier = await this.generateCodeVerifier();
      const codeChallenge = await this.generateCodeChallenge(codeVerifier);

      // Store code verifier for later use
      sessionStorage.setItem('oauth_code_verifier', codeVerifier);

      const scope = encodeURIComponent('openid email profile');
      const authUrl = `${this.authUrl}/authorize?provider=${encodeURIComponent(provider)}&redirect_to=${encodeURIComponent(redirectUri)}&response_type=code&code_challenge=${encodeURIComponent(codeChallenge)}&code_challenge_method=S256&scope=${scope}`;

      // Redirect to OAuth provider
      window.location.href = authUrl;
    } catch (error) {
      // OAuth sign in error
      throw error;
    }
  }

  // Google Sign-In with ID Token (for Google's pre-built solution)
  async signInWithGoogleIdToken(idToken, nonce = null) {
    try {
      const payload = {
        provider: 'google',
        id_token: idToken
      };

      if (nonce) {
        payload.nonce = nonce;
      }

      const data = await this._request(`${this.authUrl}/token?grant_type=id_token`, {
        method: 'POST',
        auth: false,
        body: payload
      });

      // For Google Auth, ensure persistent session for all users (like other websites)
      localStorage.setItem('remember_login', 'true');

      await this.handleAuthSuccess(data);
      return data;
    } catch (error) {
      throw error;
    }
  }

  // Alternative Google Sign-In using Supabase OAuth flow
  async signInWithGoogleOAuth() {
    try {
      const { data, error } = await this._supabaseClient.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/dashboard`
        }
      });

      if (error) {
        throw error;
      }
      return data;
    } catch (error) {
      console.error('❌ Google OAuth error:', error);
      throw error;
    }
  }

  // Verify OTP token (for email confirmation, password reset, etc.)
  async verifyOtp({ token_hash, type }) {
    try {

      const data = await this._request(`${this.authUrl}/verify`, {
        method: 'POST',
        auth: false,
        body: {
          token_hash,
          type
        }
      });

      console.log('✅ OTP verification successful');
      await this.handleAuthSuccess(data);
      return data;
    } catch (error) {
      console.error('❌ OTP verification error:', {
        message: error.message,
        status: error.status,
        response: error.response
      });
      throw error;
    }
  }

  // Handle OAuth callback (for web environment)
  async handleOAuthCallback() {
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const code = urlParams.get('code');
      const error = urlParams.get('error');

      if (error) {
        const errorDescription = urlParams.get('error_description');
        throw new Error(`OAuth error: ${error} ${errorDescription || ''}`.trim());
      }

      if (!code) {
        throw new Error('Authorization code not found in callback URL');
      }

      const codeVerifier = sessionStorage.getItem('oauth_code_verifier');
      if (!codeVerifier) {
        throw new Error('Code verifier not found in session storage');
      }

      // Clean up stored verifier
      sessionStorage.removeItem('oauth_code_verifier');

      const redirectUri = window.location.origin + '/auth/callback';

      // Exchange code for tokens
      const response = await fetch(`${this.authUrl}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
          'apikey': this.supabaseAnonKey
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri
        })
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error_description || 'Token exchange failed');
      }

      const data = await response.json();
      await this.handleAuthSuccess(data);
      return data;
    } catch (error) {
      // OAuth callback error
      throw error;
    }
  }

  // Handle successful authentication
  async handleAuthSuccess(authData) {
    this.accessToken = authData.access_token;
    this.currentUser = authData.user;

    // Detect mobile for enhanced session handling
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
      (window.innerWidth <= 768 && 'ontouchstart' in window);

    // Use actual token expiry from Supabase (typically 1 hour)
    // The refresh_token will keep the session alive long-term
    const expiresIn = authData.expires_in || 3600; // seconds
    const expiresAt = Date.now() + (expiresIn * 1000); // convert to milliseconds

    // Store session with enhanced metadata
    await this.setStorage({
      supabase_session: {
        access_token: authData.access_token,
        refresh_token: authData.refresh_token,
        user: authData.user,
        expires_at: expiresAt,
        expires_in: expiresIn,
        created_at: Date.now(),
        last_activity: Date.now(),
        is_mobile: isMobile
      }
    });

    // Clear premium status cache to force refresh
    await this.removeStorage(['cachedPremiumStatus']);

    // Create or update user profile
    await this.upsertProfile(authData.user);
    try {
      window.eventBus?.emit('auth:changed', { user: this.currentUser });
    } catch (_) { }
  }

  // Sign out
  async signOut() {
    try {
      if (this.accessToken) {
        await fetch(`${this.authUrl}/logout`, {
          method: 'POST',
          headers: this.getHeaders()
        });
      }
    } catch (error) {
      // Sign out error
    } finally {
      // Clear local session
      this.accessToken = null;
      this.currentUser = null;
      await this.removeStorage(['supabase_session']);

      // Clear all caches
      await this.removeStorage([
        'userTier',
        'profileLastChecked',
        'subscriptionLastChecked',
        'cachedSubscription',
        'encryptionKeyLastChecked',
        'cachedKeyMaterial',
        'cachedSalt'
      ]);

      // Reset premium gating
      try {
        await this.setStorage({ userTier: 'free' });
      } catch (_) { }

      try {
        window.eventBus?.emit('auth:changed', { user: null });
      } catch (_) { }
      try {
        window.eventBus?.emit('tier:changed', { tier: 'free', active: false, expiresAt: null });
      } catch (_) { }
    }
  }

  // Reset password
  async resetPassword(email) {
    try {
      // Get current domain for redirect URL
      const currentDomain = window.location.origin;
      const redirectUrl = `${currentDomain}/`;

      const response = await fetch(`${this.authUrl}/recover`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.supabaseAnonKey
        },
        body: JSON.stringify({
          email: email,
          type: 'recovery',
          options: {
            redirectTo: redirectUrl
          }
        })
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error_description || 'Password reset failed');
      }

      return true;
    } catch (error) {
      // Password reset error
      throw error;
    }
  }

  // Verify token validity
  async verifyToken() {
    if (!this.accessToken) return false;

    try {
      const response = await this._request(`${this.authUrl}/user`, { auth: true, raw: true });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  // Refresh session using refresh_token
  async refreshSession() {
    try {
      const { supabase_session } = await this.getStorage(['supabase_session']);
      const refreshToken = supabase_session?.refresh_token;
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const response = await fetch(`${this.authUrl}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: this.getHeaders(false),
        body: JSON.stringify({ refresh_token: refreshToken })
      });

      if (!response.ok) {
        let detail = 'Refresh token failed';
        try {
          const j = await response.json();
          detail = j.error_description || j.msg || j.error || JSON.stringify(j);
        } catch (_) {
          try { detail = await response.text(); } catch (_) { }
        }
        throw new Error(detail);
      }

      const data = await response.json();

      // Some responses may omit user; fetch it if needed
      if (!data.user && data.access_token) {
        try {
          const ures = await fetch(`${this.authUrl}/user`, {
            headers: {
              ...this.getHeaders(false),
              Authorization: `Bearer ${data.access_token}`
            }
          });
          if (ures.ok) {
            data.user = await ures.json();
          }
        } catch (_) { }
      }

      // If refresh_token not returned, keep existing one
      if (!data.refresh_token && refreshToken) {
        data.refresh_token = refreshToken;
      }

      // Preserve session metadata from original session
      const originalSession = supabase_session;
      data.created_at = originalSession?.created_at || Date.now();
      data.is_mobile = originalSession?.is_mobile || false;

      await this.handleAuthSuccess(data);
      return true;
    } catch (error) {
      // Never extend an expired access token locally. The caller can retry with
      // the refresh token or prompt for sign-in when refresh really fails.
      throw error;
    }
  }
  // Create or update user profile
  async upsertProfile(user) {
    try {
      // First, check if profile exists and get current data
      let profile = null;
      try {
        const arr = await this._request(`${this.apiUrl}/profiles?id=eq.${user.id}&select=salt,subscription_tier,subscription_expires_at`, { auth: true });
        if (Array.isArray(arr) && arr[0]) profile = arr[0];
      } catch (error) {
        // upsertProfile: Error checking profile existence
      }

      // Only create profile if it doesn't exist
      if (!profile) {
        const baseProfile = { id: user.id, email: user.email, updated_at: new Date().toISOString() };
        await this._request(`${this.apiUrl}/profiles`, {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates' },
          body: baseProfile,
          auth: true
        });

        // Fetch the newly created profile
        try {
          const arr = await this._request(`${this.apiUrl}/profiles?id=eq.${user.id}&select=salt,subscription_tier,subscription_expires_at`, { auth: true });
          if (Array.isArray(arr) && arr[0]) profile = arr[0];
        } catch (error) {
          // upsertProfile: Error fetching newly created profile
        }
      }

      // Generate salt only if missing
      if (profile && !profile.salt) {
        const saltBytes = new Uint8Array(32);
        crypto.getRandomValues(saltBytes);
        const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        await this._request(`${this.apiUrl}/profiles?id=eq.${user.id}`, {
          method: 'PATCH',
          body: { salt, updated_at: new Date().toISOString() },
          auth: true
        });
        // Update local profile object
        profile = { ...profile, salt };
      }

      // Update userTier in local storage using the profile we already fetched
      if (profile) {
        const isActive = profile.subscription_expires_at ?
          new Date(profile.subscription_expires_at) > new Date() : false;
        const userTier = isActive ? (profile.subscription_tier || 'premium') : 'free';

        await this.setStorage({ userTier });

        // Clear premium status cache to force UI refresh
        await this.removeStorage(['cachedPremiumStatus']);

        // Store profile data in cache for reuse (including salt for encryption key)
        const profileData = {
          tier: profile.subscription_tier || 'free',
          active: isActive,
          expiresAt: profile.subscription_expires_at,
          salt: profile.salt
        };

        await this.setStorage({
          subscriptionLastChecked: Date.now(),
          cachedSubscription: profileData
        });

        try {
          window.eventBus?.emit('tier:changed', {
            tier: userTier,
            active: isActive,
            expiresAt: profile.subscription_expires_at
          });
        } catch (_) { }
      }
    } catch (error) {
      // Error upserting profile
    }
  }

  // Sync notes to cloud using Edge Function
  async syncNotes(syncPayload) {
    // syncNotes called

    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    // Ensure encryption module is available
    if (!window.noteEncryption) {
      // NoteEncryption module not available
      throw new Error('NoteEncryption module not available');
    }

    try {
      // Ensure encryption key is available
      const encryptionKey = await this.getUserEncryptionKey();
      if (!encryptionKey) {
        // Encryption key not available
        throw new Error('Encryption key not available');
      }
      // Encryption key obtained successfully

      const encryptedNotes = [];

      // Encrypt notes before uploading (only if notes exist)
      if (syncPayload.notes && Array.isArray(syncPayload.notes)) {
        for (const note of syncPayload.notes) {
          // Skip notes without title or content
          if (!note.content || !note.title) {
            // Skipping note without title or content
            continue;
          }

          // Encrypting note
          const encryptedNote = await window.noteEncryption.encryptNoteForCloud(
            note,
            encryptionKey
          );

          // Note encrypted successfully

          encryptedNotes.push(encryptedNote);
        }
      }

      // Prepare the final payload for the Edge Function
      const edgeFunctionPayload = {
        operation: syncPayload.operation,
        notes: encryptedNotes,
        deletions: syncPayload.deletions || [],
        lastSyncTime: syncPayload.lastSyncTime,
        timestamp: syncPayload.timestamp
      };

      // Edge function payload prepared

      // Use Edge Function for sync
      const response = await fetch(`${this.supabaseUrl}/functions/v1/sync-notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
          'apikey': this.supabaseAnonKey
        },
        body: JSON.stringify(edgeFunctionPayload)
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Sync error response
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = { error: errorText || 'Sync failed' };
        }

        // If it's an "Invalid operation" error, try direct database access as fallback
        if (errorData.error === 'Invalid operation') {
          // Edge function failed, trying direct database access
          return await this.syncNotesDirectly(encryptedNotes, syncPayload.deletions || []);
        }

        throw new Error(errorData.error || `Sync failed with status ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      // Sync error
      throw error;
    }
  }

  // Fallback sync method using direct database access
  async syncNotesDirectly(encryptedNotes, deletions = []) {
    // Using direct database sync fallback

    try {
      // Process deletions first
      for (const deletion of deletions) {
        await this._request(`${this.apiUrl}/notes?id=eq.${deletion.id}`, {
          method: 'PATCH',
          body: { is_deleted: true, deleted_at: new Date().toISOString() },
          auth: true
        });
      }

      // Process note updates/creates
      for (const note of encryptedNotes) {
        // Check if note exists
        const existingNotes = await this._request(`${this.apiUrl}/notes?id=eq.${note.id}&user_id=eq.${this.currentUser.id}`, { auth: true });

        if (existingNotes && existingNotes.length > 0) {
          // Update existing note
          await this._request(`${this.apiUrl}/notes?id=eq.${note.id}&user_id=eq.${this.currentUser.id}`, {
            method: 'PATCH',
            body: {
              title_encrypted: note.title_encrypted,
              content_encrypted: note.content_encrypted,
              tags_encrypted: note.tags_encrypted,
              content_hash: note.content_hash,
              url: note.url,
              domain: note.domain,
              updated_at: new Date().toISOString()
            },
            auth: true
          });
        } else {
          // Insert new note
          await this._request(`${this.apiUrl}/notes`, {
            method: 'POST',
            body: {
              id: note.id,
              user_id: this.currentUser.id,
              title_encrypted: note.title_encrypted,
              content_encrypted: note.content_encrypted,
              tags_encrypted: note.tags_encrypted,
              content_hash: note.content_hash,
              url: note.url,
              domain: note.domain,
              created_at: note.createdAt || new Date().toISOString(),
              updated_at: note.updatedAt || new Date().toISOString()
            },
            auth: true
          });
        }
      }

      // Return success response
      return {
        success: true,
        missingNotes: [],
        processedDeletions: deletions
      };
    } catch (error) {
      // Direct database sync failed
      throw error;
    }
  }

  // Fetch notes from cloud using direct database access (Edge Function is for sync operations only)
  async fetchNotes(lastSyncTime = null) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    // Use direct database access for fetching notes (more efficient for read-only operations)
    try {
      // Using direct database access for notes
      const query = lastSyncTime
        ? `${this.apiUrl}/notes?user_id=eq.${this.currentUser.id}&updated_at=gte.${lastSyncTime}&is_deleted=eq.false&order=updated_at.desc`
        : `${this.apiUrl}/notes?user_id=eq.${this.currentUser.id}&is_deleted=eq.false&order=updated_at.desc`;

      const encryptedNotes = await this._request(query, { auth: true });

      if (!encryptedNotes || !Array.isArray(encryptedNotes)) {
        return [];
      }

      return await this.decryptNotes(encryptedNotes);
    } catch (error) {
      // API: Fetch error
      throw error;
    }
  }

  // Helper method to decrypt notes
  async decryptNotes(encryptedNotes) {
    if (!encryptedNotes || !Array.isArray(encryptedNotes)) {
      return [];
    }

    const decryptedNotes = [];
    const userKey = await this.getUserEncryptionKey();

    for (const encryptedNote of encryptedNotes) {
      try {
        let decryptedNote;

        // Check if note is encrypted or plain text
        if (encryptedNote.title_encrypted && encryptedNote.content_encrypted && userKey) {
          // Note is encrypted, decrypt it
          decryptedNote = await window.noteEncryption.decryptNoteFromCloud(
            encryptedNote,
            userKey
          );
        } else if (encryptedNote.title && encryptedNote.content) {
          // Note is plain text, use as-is
          decryptedNote = {
            ...encryptedNote,
            title: encryptedNote.title,
            content: encryptedNote.content
          };
        } else {
          continue;
        }

        // Normalize field names to match extension format (camelCase)
        const normalizedNote = {
          id: decryptedNote.id,
          title: decryptedNote.title,
          content: decryptedNote.content,
          url: decryptedNote.url || '',
          domain: decryptedNote.domain || '',
          tags: decryptedNote.tags || [],
          createdAt: decryptedNote.created_at || decryptedNote.createdAt || new Date().toISOString(),
          updatedAt: decryptedNote.updated_at || decryptedNote.updatedAt || new Date().toISOString(),
          version: decryptedNote.version || 1,
          // Preserve encrypted fields for future sync operations
          title_encrypted: decryptedNote.title_encrypted,
          content_encrypted: decryptedNote.content_encrypted,
          tags_encrypted: decryptedNote.tags_encrypted,
          content_hash: decryptedNote.content_hash
        };

        decryptedNotes.push(normalizedNote);
      } catch (error) {
        // Failed to process note
        // Try to use the note as-is if decryption fails
        if (encryptedNote.title && encryptedNote.content) {
          const fallbackNote = {
            id: encryptedNote.id,
            title: encryptedNote.title,
            content: encryptedNote.content,
            url: encryptedNote.url || '',
            domain: encryptedNote.domain || '',
            tags: encryptedNote.tags || [],
            createdAt: encryptedNote.created_at || encryptedNote.createdAt || new Date().toISOString(),
            updatedAt: encryptedNote.updated_at || encryptedNote.updatedAt || new Date().toISOString(),
            version: encryptedNote.version || 1,
            // Preserve any encrypted fields that might exist
            title_encrypted: encryptedNote.title_encrypted,
            content_encrypted: encryptedNote.content_encrypted,
            tags_encrypted: encryptedNote.tags_encrypted,
            content_hash: encryptedNote.content_hash
          };
          decryptedNotes.push(fallbackNote);
        }
      }
    }

    return decryptedNotes;
  }

  // Delete note from cloud
  async deleteNote(noteId) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    try {
      await this._request(`${this.apiUrl}/notes?id=eq.${noteId}`, {
        method: 'PATCH',
        body: { is_deleted: true, deleted_at: new Date().toISOString() },
        auth: true
      });
      return true;
    } catch (error) {
      // Delete error
      throw error;
    }
  }



  // Get user's encryption key (with caching to prevent multiple API calls)
  async getUserEncryptionKey() {
    if (!this.currentUser) {
      // getUserEncryptionKey: No authenticated user
      throw new Error('No authenticated user');
    }

    // Check if we have cached key material and salt
    const { encryptionKeyLastChecked, cachedKeyMaterial, cachedSalt } = await this.getStorage(['encryptionKeyLastChecked', 'cachedKeyMaterial', 'cachedSalt']);
    const now = Date.now();
    const oneHour = 60 * 60 * 1000; // 1 hour cache

    // Use cached material if it's recent
    if (encryptionKeyLastChecked && cachedKeyMaterial && cachedSalt && (now - encryptionKeyLastChecked) < oneHour) {
      return await window.noteEncryption.generateKey(cachedKeyMaterial, cachedSalt);
    }

    // Derive key from stable user material + per-user salt from profile
    const keyMaterial = `${this.currentUser.id}:${this.currentUser.email}`;
    let salt = null;

    // Try to get salt from cached profile data first
    try {
      const { cachedSubscription } = await this.getStorage(['cachedSubscription']);
      if (cachedSubscription?.salt) {
        salt = cachedSubscription.salt;
      }
    } catch (error) {
      // getUserEncryptionKey: Error checking cached subscription
    }

    // If no cached salt, fetch from API
    if (!salt) {
      try {
        const arr = await this._request(`${this.apiUrl}/profiles?id=eq.${this.currentUser.id}&select=salt`, { auth: true });
        salt = arr?.[0]?.salt || null;
      } catch (error) {
        // getUserEncryptionKey: Error fetching salt from API
      }
    }

    if (!salt) {
      // Fallback: local salt (as last resort)
      const local = await this.getStorage(['local_salt']);
      if (!local.local_salt) {
        const saltBytes = new Uint8Array(32);
        crypto.getRandomValues(saltBytes);
        const gen = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
        await this.setStorage({ local_salt: gen });
        salt = gen;
      } else {
        salt = local.local_salt;
      }
    }

    const encryptionKey = await window.noteEncryption.generateKey(keyMaterial, salt);

    // Cache the key material and salt instead of the CryptoKey object
    // CryptoKey objects cannot be serialized to JSON
    await this.setStorage({
      encryptionKeyLastChecked: now,
      cachedKeyMaterial: keyMaterial,
      cachedSalt: salt
    });

    return encryptionKey;
  }

  // Check if user is authenticated
  isAuthenticated() {
    return !!(this.accessToken && this.currentUser);
  }

  // Clean up old soft deleted notes (24+ hours old)
  async cleanupOldDeletedNotes({ force = false } = {}) {
    if (!this.isAuthenticated()) {
      // User not authenticated, skipping cleanup
      return { cleaned: 0, noteIds: [] };
    }

    if (this._deletedNotesCleanupPromise) {
      return this._deletedNotesCleanupPromise;
    }

    const runCleanup = async () => {
      const userId = this.currentUser?.id;
      if (!userId) return { cleaned: 0, noteIds: [] };

      const lastCleanupKey = `anchored_last_deleted_notes_cleanup_${userId}`;
      const now = Date.now();
      const oneDay = 24 * 60 * 60 * 1000;
      const lastCleanupAt = Number(localStorage.getItem(lastCleanupKey) || 0);

      // Automatic cleanup is a maintenance task, not something to query after
      // every dashboard load. The manual button still bypasses this throttle.
      if (!force && now - lastCleanupAt < oneDay) {
        return { cleaned: 0, noteIds: [], skipped: true };
      }

      const cutoffISOString = new Date(now - oneDay).toISOString();
      const query = `${this.apiUrl}/notes?select=id&user_id=eq.${userId}&is_deleted=eq.true&deleted_at=lt.${cutoffISOString}`;
      const oldDeletedNotes = await this._request(query, { auth: true });
      const noteIds = (oldDeletedNotes || []).map(note => note.id).filter(Boolean);

      // Record completed empty runs too, otherwise users without deleted notes
      // would pay for the same query on every page load.
      if (noteIds.length === 0) {
        localStorage.setItem(lastCleanupKey, String(now));
        return { cleaned: 0, total: 0, noteIds };
      }

      // Keep URLs comfortably below common request limits while replacing the
      // former one-delete-request-per-note loop with batched deletes.
      const batchSize = 100;
      for (let index = 0; index < noteIds.length; index += batchSize) {
        const batch = noteIds.slice(index, index + batchSize);
        await this._request(`${this.apiUrl}/notes?id=in.(${batch.join(',')})&user_id=eq.${userId}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
          auth: true
        });
      }

      localStorage.setItem(lastCleanupKey, String(now));
      return { cleaned: noteIds.length, total: noteIds.length, noteIds };
    };

    this._deletedNotesCleanupPromise = runCleanup();
    try {
      return await this._deletedNotesCleanupPromise;
    } finally {
      this._deletedNotesCleanupPromise = null;
    }
  }

  // Get current user
  getCurrentUser() {
    return this.currentUser;
  }

  // Get current session (from storage or in-memory)
  async getSession() {
    try {
      const { supabase_session } = await this.getStorage(['supabase_session']);
      if (supabase_session) return supabase_session;
      if (this.accessToken && this.currentUser) {
        return {
          access_token: this.accessToken,
          user: this.currentUser
        };
      }
      return null;
    } catch (e) {
      // getSession error
      return null;
    }
  }

  // Check subscription status (with caching to prevent multiple API calls)
  async getSubscriptionStatus() {
    if (!this.isAuthenticated()) {
      // getSubscriptionStatus: User not authenticated, returning free tier
      return { tier: 'free', active: false };
    }

    try {
      // Check if we have cached subscription status
      const { subscriptionLastChecked, cachedSubscription } = await this.getStorage(['subscriptionLastChecked', 'cachedSubscription']);
      const now = Date.now();
      const fiveMinutes = 5 * 60 * 1000; // 5 minutes cache

      // Use cached data if it's recent
      if (subscriptionLastChecked && cachedSubscription && (now - subscriptionLastChecked) < fiveMinutes) {
        return cachedSubscription;
      }

      // Fetch fresh data from API
      const profiles = await this._request(`${this.apiUrl}/profiles?id=eq.${this.currentUser.id}&select=subscription_tier,subscription_expires_at,salt`, { auth: true });
      const profile = profiles?.[0];

      if (!profile) {
        const result = { tier: 'free', active: false };
        await this.setStorage({
          subscriptionLastChecked: now,
          cachedSubscription: result
        });
        return result;
      }

      const isActive = profile.subscription_expires_at ?
        new Date(profile.subscription_expires_at) > new Date() : false;

      const result = {
        tier: profile.subscription_tier || 'free',
        active: isActive,
        expiresAt: profile.subscription_expires_at,
        salt: profile.salt // Include salt for encryption key reuse
      };

      await this.setStorage({
        subscriptionLastChecked: now,
        cachedSubscription: result
      });

      return result;
    } catch (error) {
      // Error checking subscription
      return { tier: 'free', active: false };
    }
  }

  // Update subscription
  async updateSubscription(tier, expiresAt) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    try {
      const response = await fetch(`${this.apiUrl}/profiles?id=eq.${this.currentUser.id}`, {
        method: 'PATCH',
        headers: this.getHeaders(),
        body: JSON.stringify({
          subscription_tier: tier,
          subscription_expires_at: expiresAt,
          updated_at: new Date().toISOString()
        })
      });

      if (!response.ok) {
        throw new Error('Failed to update subscription');
      }

      return true;
    } catch (error) {
      // Subscription update error
      throw error;
    }
  }

  // Get storage usage
  async getStorageUsage() {
    if (!this.isAuthenticated()) {
      // getStorageUsage: User not authenticated, returning 0 usage
      return { used: 0, limit: 0 };
    }

    try {
      // Get both storage_used_bytes and subscription info in ONE API call
      const profiles = await this._request(`${this.apiUrl}/profiles?id=eq.${this.currentUser.id}&select=storage_used_bytes,subscription_tier,subscription_expires_at`, { auth: true });
      const profile = profiles?.[0];

      if (!profile) {
        // getStorageUsage: No profile found, returning 0 usage
        return { used: 0, limit: 0 };
      }

      // Calculate limit locally instead of calling getSubscriptionStatus()
      const isActive = profile.subscription_expires_at ?
        new Date(profile.subscription_expires_at) > new Date() : false;
      const tier = isActive ? (profile.subscription_tier || 'premium') : 'free';

      const limit = tier === 'premium' ?
        1024 * 1024 * 1024 : // 1GB for premium
        100 * 1024 * 1024;   // 100MB for free

      const result = {
        used: profile?.storage_used_bytes || 0,
        limit: limit
      };

      return result;
    } catch (error) {
      // getStorageUsage: Error getting storage usage
      return { used: 0, limit: 0 };
    }
  }

  // Resolve conflicts in cloud
  async resolveConflict(noteId, resolution, localNote = null) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    try {
      // Use Edge Function for conflict resolution
      const response = await fetch(`${this.supabaseUrl}/functions/v1/sync-notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
          'apikey': this.supabaseAnonKey
        },
        body: JSON.stringify({
          operation: 'resolve_conflict',
          noteId: noteId,
          resolution: resolution,
          localNote: localNote
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Conflict resolution error response
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = { error: errorText || 'Conflict resolution failed' };
        }
        throw new Error(errorData.error || `Conflict resolution failed with status ${response.status}`);
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      // Conflict resolution error
      return { success: false, error: error.message };
    }
  }

  // Sync version history to cloud
  async syncVersions(noteId, versions) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    try {
      // Use Edge Function for version sync
      const response = await fetch(`${this.supabaseUrl}/functions/v1/sync-notes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
          'apikey': this.supabaseAnonKey
        },
        body: JSON.stringify({
          operation: 'sync_versions',
          notes: versions  // Edge Function expects 'notes' parameter, not 'versions'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Version sync error response
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = { error: errorText || 'Version sync failed' };
        }
        throw new Error(errorData.error || `Version sync failed with status ${response.status}`);
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      // Version sync error
      return { success: false, error: error.message };
    }
  }

  // Call Supabase RPC functions
  async rpc(functionName, params = {}) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/rest/v1/rpc/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
          'apikey': this.supabaseAnonKey
        },
        body: JSON.stringify(params)
      });

      if (!response.ok) {
        const errorText = await response.text();
        // RPC error response
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = { error: errorText || `RPC ${functionName} failed` };
        }
        throw new Error(errorData.error || `RPC ${functionName} failed with status ${response.status}`);
      }

      const data = await response.json();
      return { data, error: null };
    } catch (error) {
      // RPC error
      return { data: null, error: error.message };
    }
  }

  // Call Supabase Edge Functions
  async callFunction(functionName, params = {}) {
    if (!this.isAuthenticated()) {
      throw new Error('User not authenticated');
    }

    try {
      const response = await fetch(`${this.supabaseUrl}/functions/v1/${functionName}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
          'apikey': this.supabaseAnonKey
        },
        body: JSON.stringify(params)
      });

      if (!response.ok) {
        const errorText = await response.text();
        // Function error response
        let errorData;
        try {
          errorData = JSON.parse(errorText);
        } catch (e) {
          errorData = { error: errorText || `Function ${functionName} failed` };
        }
        throw new Error(errorData.error || `Function ${functionName} failed with status ${response.status}`);
      }

      const data = await response.json();
      return data;
    } catch (error) {
      // Function error
      throw error;
    }
  }
}

// Export singleton instance
window.supabaseClient = new SupabaseClient();

// Also export as window.api for dashboard compatibility
window.api = window.supabaseClient;
