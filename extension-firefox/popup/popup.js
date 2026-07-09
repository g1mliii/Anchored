// URL Notes Extension - Popup Script

// Suppress ResizeObserver loop errors (common browser issue)
window.addEventListener('error', (e) => {
  if (e.message && e.message.includes('ResizeObserver loop completed with undelivered notifications')) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
});

class URLNotesApp {
  constructor() {
    this.filterMode = 'site'; // 'site', 'page', or 'all_notes'
    this.currentSite = null;
    this.notes = [];
    this.allNotes = []; // For the 'All Notes' view
    this.currentNote = null;
    this.searchQuery = '';
    this.isJotMode = false;
    this.premiumStatus = null;
    this.autosaveInterval = null;
    this.generatedTags = []; // Store AI-generated tags
    this.dialog = new CustomDialog();
    this.themeManager = new ThemeManager();
    // Rate limiting for AI usage calls
    this._lastAIUsageCall = 0;
    this._cachedAIUsage = null;
    this._isApplyingAIRewrite = false; // Flag to prevent draft saving during AI rewrite
    this._lastCacheClear = 0; // Rate limit cache clearing
    this._aiRewriteJustCompleted = false; // Flag to track if AI rewrite just completed

    // Memory leak prevention: Track all event listeners and timers for cleanup
    this._eventListeners = [];
    this._timeouts = [];
    this._intervals = [];
    this._messageListener = null;

    // Use IndexedDB storage instead of Chrome storage for sync compatibility
    this.storageManager = window.notesStorage || new StorageManager();

    // Ensure EditorManager is available before creating instance
    if (typeof EditorManager === 'undefined') {
      console.error('EditorManager not available, delaying initialization');
      setTimeout(() => this.constructor(), 100);
      return;
    }

    this.editorManager = new EditorManager(this.storageManager);
    this.settingsManager = new SettingsManager(this.storageManager);
    // Notes list/render manager (modularized)
    this.notesManager = new NotesManager(this);
    // Debounced draft saver for editorState caching
    this.saveDraftDebounced = Utils.debounce(() => this.saveEditorDraft(), 150);
    // Create a flush method to wait for pending saves to complete
    this.flushDraftSave = async () => {
      // Wait a bit longer than the debounce delay to ensure any pending save completes
      await new Promise(resolve => setTimeout(resolve, 300));
      // Then save the current editor state to ensure we have the latest
      return this.saveEditorDraft();
    };
    // Debounced AI usage checker to prevent rate limiting
    this.getAIUsageDebounced = Utils.debounce(() => this.getCurrentAIUsage(), 2000);
    // Enable compact layout to ensure everything fits without scroll/clipping
    try { document.documentElement.setAttribute('data-compact', '1'); } catch { }

    this.init();
  }

  // Determine if a note belongs to the current page
  isCurrentPageNote(note) {
    try {
      if (!note || !note.url || !this.currentSite || !this.currentSite.url) return false;
      const noteKey = this.normalizePageKey(note.url);
      const currentKey = this.normalizePageKey(this.currentSite.url);
      return noteKey === currentKey;
    } catch (_) {
      return false;
    }
  }


  // Get current tab information and update UI/context
  async loadCurrentSite() {
    try {
      const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.startsWith('http')) {
        const url = new URL(tab.url);
        this.currentSite = {
          domain: url.hostname,
          url: tab.url,
          title: tab.title,
          favicon: tab.favIconUrl || `https://www.google.com/s2/favicons?domain=${url.hostname}&sz=32`
        };

        // Update site icon with real favicon
        const siteIcon = document.querySelector('.site-icon');
        if (siteIcon) {
          // Clear existing content
          siteIcon.textContent = '';

          if (this.currentSite.favicon) {
            // Create favicon image directly (bypass XSS prevention for trusted favicon URLs)
            const img = document.createElement('img');
            img.src = this.currentSite.favicon;
            img.alt = 'Site favicon';
            siteIcon.appendChild(img);
          } else {
            // Create fallback SVG directly
            const fallbackDiv = document.createElement('div');
            fallbackDiv.className = 'site-fallback';
            fallbackDiv.setAttribute('aria-label', 'No favicon available');

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('fill', 'none');
            svg.setAttribute('stroke', 'currentColor');
            svg.setAttribute('stroke-width', '1.5');
            svg.setAttribute('stroke-linecap', 'round');
            svg.setAttribute('stroke-linejoin', 'round');

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', '12');
            circle.setAttribute('cy', '12');
            circle.setAttribute('r', '9');

            const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path1.setAttribute('d', 'M3 12h18');

            const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path2.setAttribute('d', 'M12 3a15.3 15.3 0 0 1 4 9 15.3 15.3 0 0 1-4 9 15.3 15.3 0 0 1-4-9 15.3 15.3 0 0 1 4-9z');

            svg.appendChild(circle);
            svg.appendChild(path1);
            svg.appendChild(path2);
            fallbackDiv.appendChild(svg);
            siteIcon.appendChild(fallbackDiv);
          }
        }

        // Update UI text and tooltips
        const domainEl = document.getElementById('siteDomain');
        const urlEl = document.getElementById('siteUrl');
        if (domainEl) {
          const displayDomain = (this.currentSite.domain || '').replace(/^www\./, '');
          domainEl.textContent = displayDomain;
          domainEl.title = displayDomain;
          domainEl.setAttribute('aria-busy', 'false');
        }
        if (urlEl) {
          urlEl.textContent = this.currentSite.url;
          urlEl.title = this.currentSite.url;
          urlEl.setAttribute('aria-busy', 'false');
        }

        // Apply cached accent immediately if available
        try {
          const cached = await this.themeManager.getCachedAccent(this.currentSite.domain);
          if (cached) this.themeManager.setAccentVariables(cached);
        } catch (_) { }
      } else {
        // No valid tab or URL (e.g., extension popup opened from management page)
        // Note: Removed verbose logging for cleaner console
        this.currentSite = null;

        // Update UI to show no site context
        const siteIcon = document.querySelector('.site-icon');
        if (siteIcon) {
          // Clear existing content
          siteIcon.textContent = '';

          // Create fallback SVG directly
          const fallbackDiv = document.createElement('div');
          fallbackDiv.className = 'site-fallback';
          fallbackDiv.setAttribute('aria-label', 'No site context');

          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('viewBox', '0 0 24 24');
          svg.setAttribute('fill', 'none');
          svg.setAttribute('stroke', 'currentColor');
          svg.setAttribute('stroke-width', '1.5');
          svg.setAttribute('stroke-linecap', 'round');
          svg.setAttribute('stroke-linejoin', 'round');

          const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
          circle.setAttribute('cx', '12');
          circle.setAttribute('cy', '12');
          circle.setAttribute('r', '9');

          const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path1.setAttribute('d', 'M3 12h18');

          const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path2.setAttribute('d', 'M12 3a9 9 0 0 1 0 18 9 9 0 0 1 0-18z');

          svg.appendChild(circle);
          svg.appendChild(path1);
          svg.appendChild(path2);
          fallbackDiv.appendChild(svg);
          siteIcon.appendChild(fallbackDiv);
        }

        const domainEl = document.getElementById('siteDomain');
        const urlEl = document.getElementById('siteUrl');
        if (domainEl) {
          domainEl.textContent = 'No site context';
          domainEl.title = 'Extension opened outside of web page';
          domainEl.setAttribute('aria-busy', 'false');
        }
        if (urlEl) {
          urlEl.textContent = 'No active tab';
          urlEl.title = 'Extension opened outside of web page';
          urlEl.setAttribute('aria-busy', 'false');
        }
      }
    } catch (error) {
      console.error('Error loading current site:', error);
      this.currentSite = null;

      // Update UI to show error state
      const domainEl = document.getElementById('siteDomain');
      const urlEl = document.getElementById('siteUrl');
      if (domainEl) {
        domainEl.textContent = 'Error loading site';
        domainEl.title = 'Failed to load current site information';
        domainEl.setAttribute('aria-busy', 'false');
      }
      if (urlEl) {
        urlEl.textContent = 'Error';
        urlEl.title = 'Failed to load current site information';
        urlEl.setAttribute('aria-busy', 'false');
      }
    }
  }

  // Handle real-time note updates from context menu
  async handleRealTimeNoteUpdate(message) {
    try {
      const { note, type } = message;

      if (type === 'new_note') {
        // New note created - refresh the notes list and open it
        await this.refreshNotesFromStorage();
        this.currentNote = note;
        await this.openEditor(true);
        this.persistEditorOpen(true);
        this.saveEditorDraft();
      } else if (type === 'append_selection') {
        // Note was appended to - update if it's currently open
        if (this.currentNote && this.currentNote.id === note.id) {
          // Update current note with new content
          this.currentNote = { ...note };

          // Refresh editor content if it's open
          const editor = document.getElementById('noteEditor');
          if (editor && editor.style.display !== 'none') {
            const titleHeader = document.getElementById('noteTitleHeader');
            const contentInput = document.getElementById('noteContentInput');
            const tagsInput = document.getElementById('tagsInput');

            if (titleHeader) titleHeader.value = this.currentNote.title || '';
            if (contentInput) {
              const safeContent = this.buildContentHtml(this.currentNote.content || '');
              if (window.safeDOM) {
                window.safeDOM.setInnerHTML(contentInput, safeContent, true);
              } else {
                contentInput.innerHTML = safeContent;
              }
            }
            if (tagsInput) tagsInput.value = (this.currentNote.tags || []).join(', ');
          }

          // Show a subtle notification
          Utils.showToast(`Note updated with new content`, 'success');
        }

        // Refresh notes list to show updated content
        await this.refreshNotesFromStorage();
      }
    } catch (error) {
      console.error('Error handling real-time note update:', error);
    }
  }

  // Refresh notes from storage and update UI
  async refreshNotesFromStorage() {
    try {
      this.allNotes = await this.loadNotes();
      this.render();
    } catch (error) {
      console.error('Error refreshing notes from storage:', error);
    }
  }

  async init() {
    // Wait for IndexedDB storage to be ready
    if (window.notesStorage && typeof window.notesStorage.init === 'function') {
      try {
        await window.notesStorage.init();
        // Note: Removed verbose logging for cleaner console
      } catch (error) {
        console.warn('Failed to initialize IndexedDB storage, falling back to Chrome storage:', error);
        this.storageManager = new StorageManager();
      }
    }

    this.premiumStatus = await getPremiumStatus();
    // Apply premium-dependent UI immediately
    try { await this.updatePremiumUI(); } catch (_) { }

    // Check if OAuth just completed (popup was closed during OAuth flow)
    await this.checkOAuthCompletion();

    // RESTORE CACHED VALUES IMMEDIATELY to prevent visual shifts
    await this.restoreCachedUIState();

    await this.loadCurrentSite();
    this.setupEventListeners();
    await this.themeManager.setupThemeDetection();
    if (this.currentSite) {
      await this.themeManager.applyAccentFromFavicon(this.currentSite);
    }
    // Initialize Supabase session from storage so auth UI persists across popup reopen
    try {
      if (window.supabaseClient && typeof window.supabaseClient.init === 'function') {
        await window.supabaseClient.init();
        // Note: Premium status already loaded above, no need to refresh
      }
    } catch (e) {
      console.warn('Supabase init failed:', e);
    }

    // Check if user needs to re-authenticate (expired session)
    await this.checkReauthRequired();

    // Initialize sync engine for timer-based sync
    try {
      if (window.syncEngine && typeof window.syncEngine.init === 'function') {
        await window.syncEngine.init();
      }
    } catch (error) {
      console.warn('Failed to initialize sync engine:', error);
    }

    // Listen for background sync timer messages
    this._messageListener = async (message, sender, sendResponse) => {
      if (message.action === 'sync-timer-triggered') {

        // Background timer fired, check if we can sync
        if (window.syncEngine) {
          try {
            const canSyncResult = await window.syncEngine.canSync();


            if (canSyncResult && canSyncResult.canSync) {
              // Double-check encryption readiness for timer-triggered sync
              if (window.encryptionManager && typeof window.encryptionManager.isEncryptionReady === 'function') {
                const encryptionReady = await window.encryptionManager.isEncryptionReady();
                if (!encryptionReady) {

                  browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
                  return;
                }
              }

              try {

                await window.syncEngine.manualSync();

                // After sync completes, restart the background timer for next cycle
                browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
              } catch (syncError) {
                console.error('Popup: Automatic sync failed:', syncError);

                // Even if sync fails, restart timer for next cycle
                browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
              }
            } else {
              // Can't sync, restart timer anyway for next cycle
              browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
            }
          } catch (error) {
            console.error('Popup: Error checking sync capability:', error);

            // Error checking sync capability, restart timer for next cycle
            browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
          }
        } else {
          console.warn('Popup: Sync engine not available');

          // Sync engine not available, restart timer for next cycle
          browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
        }
      }
    };
    browserAPI.runtime.onMessage.addListener(this._messageListener);

    // Check for overdue sync when popup opens
    try {
      const response = await browserAPI.runtime.sendMessage({ action: 'popup-opened' });
      if (response && response.shouldSync) {
        if (window.syncEngine) {
          try {
            // Add a small delay to ensure encryption is fully initialized after login
            await new Promise(resolve => setTimeout(resolve, 500));

            const canSyncResult = await window.syncEngine.canSync();


            if (canSyncResult && canSyncResult.canSync) {
              // Double-check encryption readiness for overdue sync after login
              if (window.encryptionManager && typeof window.encryptionManager.isEncryptionReady === 'function') {
                const encryptionReady = await window.encryptionManager.isEncryptionReady();
                if (!encryptionReady) {

                  browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
                  return;
                }
              }

              try {

                await window.syncEngine.manualSync();

                browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
              } catch (syncError) {
                console.error('Popup: Overdue sync failed:', syncError);

                browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
              }
            } else {

              browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
            }
          } catch (error) {
            console.error('Popup: Error checking sync capability for overdue sync:', error);

            browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
          }
        } else {
          console.warn('Popup: Sync engine not available for overdue sync');

          browserAPI.runtime.sendMessage({ action: 'restart-sync-timer' }).catch(() => { });
        }
      } else if (response) {
        const timeRemainingMinutes = Math.round(response.timeRemaining / (1000 * 60));
      }
    } catch (error) {
      console.error('Popup: Error checking for overdue sync:', error);
    }

    // Listen for global auth/tier changes
    try {
      window.eventBus?.on('auth:changed', (payload) => this.handleAuthChanged(payload));
      window.eventBus?.on('tier:changed', (status) => this.handleTierChanged(status));
    } catch (_) { }

    // Note: Sync event listeners removed - sync only happens on timer or manual button press

    // Listen for context menu messages from background script
    try {
      browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'context_menu_note_saved') {
          this.handleContextMenuNote(message.note);
          // Note: context_menu_draft_updated now handled via lastAction mechanism for better timing
        } else if (message.action === 'multi_highlight_note_updated') {
          // Handle multi-highlight note updates
          this.handleMultiHighlightNoteUpdate(message.note, message.type);
        }
      });
    } catch (_) { }

    // Setup conflict banner event listeners
    this.setupConflictBannerListeners();

    // Load notes first, before any rendering
    this.allNotes = await this.loadNotes();

    // Check current multi-highlight state
    await this.checkMultiHighlightState();

    await this.settingsManager.loadFontSetting();
    // Initialize settings UI once (font controls, preview, etc.)
    this.settingsManager.initSettings();
    Utils.checkStorageQuota();
    this.maybeShowQuotaWarning();
    // Note: These methods don't exist in editorManager, they're in the popup class
    // this.updateCharCount();
    // this.updateNotePreview();

    // Restore last UI state (filter + possibly open editor)
    try {
      const { lastFilterMode, editorState, lastAction, lastSearchQuery } = await browserAPI.storage.local.get(['lastFilterMode', 'editorState', 'lastAction', 'lastSearchQuery']);
      if (lastFilterMode === 'site' || lastFilterMode === 'page' || lastFilterMode === 'all_notes') {
        this.filterMode = lastFilterMode;
      }

      // Note: Draft clearing moved to restoration logic to allow proper auto-restore

      // Mark popup as open for context menu detection
      if (editorState) {
        editorState.open = true;
        // Preserve wasEditorOpen flag for auto-restore logic
        await browserAPI.storage.local.set({ editorState });
      } else {
        const newEditorState = { open: true, wasEditorOpen: false };
        await browserAPI.storage.local.set({ editorState: newEditorState });
      }

      // Set filter without rendering first
      this.switchFilter(this.filterMode, { persist: false, render: false });

      // Restore search query if present
      if (typeof lastSearchQuery === 'string' && lastSearchQuery.length > 0) {
        this.searchQuery = lastSearchQuery;
        const searchInputEl = document.getElementById('searchInput');
        const searchClearEl = document.getElementById('searchClear');
        if (searchInputEl) searchInputEl.value = lastSearchQuery;
        if (searchClearEl) searchClearEl.style.display = 'block';
      }

      // Now render after everything is set up
      this.render();
      // Priority 0: explicit keyboard command to create a new note
      if (lastAction && lastAction.type === 'new_note') {
        if (this.currentSite) {
          // Create new note and open editor
          await this.createNewNote();
          browserAPI.storage.local.remove('lastAction');
          return;
        } else {
          console.warn('Cannot create new note: No valid site context');
          browserAPI.storage.local.remove('lastAction');
        }
      }

      // Priority 0.5: context menu created note - open it in editor
      if (lastAction && lastAction.type === 'new_from_selection') {
        // Find the note that was created by context menu
        let createdNote = this.allNotes.find(n => n.id === lastAction.noteId);

        // If not found in IndexedDB, check chrome.storage.local (context menu storage)
        if (!createdNote) {
          try {
            const allData = await browserAPI.storage.local.get(null);
            for (const [key, value] of Object.entries(allData)) {
              if (key.startsWith('note_') && value && value.id === lastAction.noteId) {
                createdNote = value;

                break;
              }
            }
          } catch (error) {
            console.error('Failed to check chrome.storage.local for context menu note:', error);
          }
        }

        if (createdNote) {
          // Move note from chrome.storage.local to IndexedDB if needed
          if (createdNote.domain && createdNote.content) {
            try {
              await window.notesStorage.saveNote(createdNote);


              // Remove from chrome.storage.local
              const key = `note_${createdNote.id}`;
              await browserAPI.storage.local.remove(key);

              // Reload notes to include the new one
              this.allNotes = await this.loadNotes();
            } catch (error) {
              console.error('Failed to move context menu note to IndexedDB:', error);
            }
          }

          // Open the created note in editor
          this.currentNote = { ...createdNote };
          await this.openEditor(true);
          browserAPI.storage.local.remove('lastAction');
          return;
        }
      }

      // Priority 0.6: multi-highlight created note - open it in editor
      if (lastAction && lastAction.type === 'new_from_multi_highlight') {
        // Find the note that was created by multi-highlight
        let createdNote = this.allNotes.find(n => n.id === lastAction.noteId);

        // If not found in IndexedDB, check chrome.storage.local
        if (!createdNote) {
          try {
            const allData = await browserAPI.storage.local.get(null);
            for (const [key, value] of Object.entries(allData)) {
              if (key.startsWith('note_') && value && value.id === lastAction.noteId) {
                createdNote = value;
                console.log('Found multi-highlight note in chrome.storage.local:', createdNote);
                break;
              }
            }
          } catch (error) {
            console.error('Failed to check chrome.storage.local for multi-highlight note:', error);
          }
        }

        if (createdNote) {
          // Move note from chrome.storage.local to IndexedDB if needed
          if (createdNote.domain && createdNote.content) {
            try {
              await window.notesStorage.saveNote(createdNote);
              console.log('Moved multi-highlight note to IndexedDB:', createdNote.id);

              // Remove from chrome.storage.local
              const key = `note_${createdNote.id}`;
              await browserAPI.storage.local.remove(key);

              // Reload notes to include the new one
              this.allNotes = await this.loadNotes();
            } catch (error) {
              console.error('Failed to move multi-highlight note to IndexedDB:', error);
            }
          }

          // Open the created note in editor
          this.currentNote = { ...createdNote };
          await this.openEditor(true);
          browserAPI.storage.local.remove('lastAction');
          Utils.showToast(`Multi-highlight note created with ${lastAction.highlightCount} highlights`, 'success');
          return;
        }
      }

      // Priority 0.6.5: context menu appended to draft note - open editor with updated draft
      if (lastAction && lastAction.type === 'append_selection' && lastAction.isDraft) {
        console.log('🎯 Context menu appended to draft, opening updated draft in editor');

        // Get the updated draft from storage
        const { editorState } = await browserAPI.storage.local.get(['editorState']);
        if (editorState && editorState.noteDraft && editorState.noteDraft.id === lastAction.noteId) {
          // Set the updated draft as current note and open editor
          this.currentNote = { ...editorState.noteDraft };
          await this.openEditor(true);

        }

        // Remove action so it doesn't re-trigger
        browserAPI.storage.local.remove('lastAction');
        return;
      }

      // Priority 0.7: multi-highlight appended to existing note - refresh and show
      if (lastAction && lastAction.type === 'append_multi_highlights') {
        // Find the note that was updated by multi-highlight
        let updatedNote = this.allNotes.find(n => n.id === lastAction.noteId);

        // If not found in IndexedDB, check chrome.storage.local
        if (!updatedNote) {
          try {
            const allData = await browserAPI.storage.local.get(null);
            for (const [key, value] of Object.entries(allData)) {
              if (key.startsWith('note_') && value && value.id === lastAction.noteId) {
                updatedNote = value;
                console.log('Found updated multi-highlight note in chrome.storage.local:', updatedNote);
                break;
              }
            }
          } catch (error) {
            console.error('Failed to check chrome.storage.local for updated multi-highlight note:', error);
          }
        }

        if (updatedNote) {
          // Move note from chrome.storage.local to IndexedDB if needed
          if (updatedNote.domain && updatedNote.content) {
            try {
              await window.notesStorage.saveNote(updatedNote);
              console.log('Moved updated multi-highlight note to IndexedDB:', updatedNote.id);

              // Remove from chrome.storage.local
              const key = `note_${updatedNote.id}`;
              await browserAPI.storage.local.remove(key);

              // Reload notes to include the updated one
              this.allNotes = await this.loadNotes();
            } catch (error) {
              console.error('Failed to move updated multi-highlight note to IndexedDB:', error);
            }
          }

          // Open the updated note in editor
          this.currentNote = { ...updatedNote };
          await this.openEditor(true);
          browserAPI.storage.local.remove('lastAction');
          Utils.showToast(`Added ${lastAction.highlightCount} highlights to note`, 'success');
          return;
        }
      }

      // Priority 1: incoming context menu action
      if (lastAction && lastAction.domain) {
        // Check if this is a draft note update
        if (lastAction.isDraft) {
          // For draft notes, just update the current note content
          if (this.currentNote && this.currentNote.id === lastAction.noteId) {
            // Update the current note with the new content
            const target = this.allNotes.find(n => n.id === lastAction.noteId);
            if (target) {
              this.currentNote = { ...target };
              // Update the editor content
              const contentInput = document.getElementById('noteContentInput');
              if (contentInput) {
                const safeContent = this.buildContentHtml(this.currentNote.content || '');
                if (window.safeDOM) {
                  window.safeDOM.setInnerHTML(contentInput, safeContent, true);
                } else {
                  contentInput.innerHTML = safeContent;
                }
              }
              // Update the draft in storage
              await this.saveEditorDraft();
              Utils.showToast('Text appended to current note', 'success');
            }
          } else {
            // If no current note, check if we need to open the editor
            const target = this.allNotes.find(n => n.id === lastAction.noteId);
            if (target) {
              this.currentNote = { ...target };
              await this.openEditor(true);
              Utils.showToast('Text appended to note', 'success');
            }
          }
          // Remove action so it doesn't re-trigger
          browserAPI.storage.local.remove('lastAction');
          return;
        }

        // Regular note action - try to locate the target note by id in loaded notes
        const target = this.allNotes.find(n => n.id === lastAction.noteId);
        if (target) {
          this.currentNote = { ...target };
          // Do NOT clear editorState; we want reopen to work if user closes popup
          await this.openEditor(true);
          // Ensure open flag and draft are persisted immediately
          this.persistEditorOpen(true);
          this.saveEditorDraft();
          // Remove action so it doesn't re-trigger on next open
          browserAPI.storage.local.remove('lastAction');
          return;
        }
      }
      // Priority 2: previously open editor with cached draft
      // Only auto-open if there's a draft and the editor was actually open when popup closed

      if (editorState && editorState.noteDraft && editorState.wasEditorOpen) {
        // Check if the draft is recent enough to auto-open (10 minutes to be more forgiving)
        const now = Date.now();
        const draftTime = editorState.noteDraft.updatedAt ? new Date(editorState.noteDraft.updatedAt).getTime() : 0;
        const timeDiff = now - draftTime;
        const tenMinutes = 10 * 60 * 1000; // 10 minutes in milliseconds

        if (timeDiff < tenMinutes) {
          // Use improved restoration logic that handles both auto-restore and contamination prevention
          this.currentNote = null; // Clear so restoreEditorDraft knows this is auto-restore context
          const wasRestored = await this.restoreEditorDraft();
          if (wasRestored) {
            await this.openEditor(true);
          }
        } else {
          await browserAPI.storage.local.remove('editorState');
        }
      } else if (editorState && editorState.noteDraft) {

      } else {

      }
    } catch (_) {
      // Fallback to default filter
      this.switchFilter(this.filterMode, { persist: false, render: false });
      // Render after fallback setup
      this.render();
    }

    // Initialize ad manager for free users
    // TEMPORARILY DISABLED during growth phase - focus on user experience
    // try {
    //   if (window.adManager && typeof window.adManager.init === 'function') {
    //     await window.adManager.init();
    //   }
    // } catch (error) {
    //   console.warn('Failed to initialize ad manager:', error);
    // }

    // Initialize onboarding tooltips for new users
    try {
      if (window.OnboardingTooltips) {
        this.onboardingTooltips = new window.OnboardingTooltips();
        await this.onboardingTooltips.init();
      }
    } catch (error) {
      console.warn('Failed to initialize onboarding tooltips:', error);
    }

    // Initialize user engagement system for account creation prompts
    try {
      if (window.UserEngagement) {
        this.userEngagement = new window.UserEngagement();
        await this.userEngagement.init();
      }
    } catch (error) {
      console.warn('Failed to initialize user engagement:', error);
    }
  }

  // NEW: Restore cached UI state immediately to prevent visual shifts
  async restoreCachedUIState() {
    try {
      // 1. Restore filter mode and search query immediately
      const { lastFilterMode, lastSearchQuery } = await browserAPI.storage.local.get(['lastFilterMode', 'lastSearchQuery']);
      if (lastFilterMode === 'site' || lastFilterMode === 'page' || lastFilterMode === 'all_notes') {
        this.filterMode = lastFilterMode;
      }
      if (typeof lastSearchQuery === 'string' && lastSearchQuery.length > 0) {
        this.searchQuery = lastSearchQuery;
      }

      // 2. Set search placeholder immediately based on filter mode
      const searchInput = document.querySelector('.search-input');
      if (searchInput) {
        const placeholder =
          this.filterMode === 'all_notes' ? 'Search All Notes' :
            this.filterMode === 'site' ? 'Search This Site' :
              'Search This Page';
        searchInput.setAttribute('placeholder', placeholder);
      }

      // 3. Restore search input value immediately if exists
      if (this.searchQuery && searchInput) {
        searchInput.value = this.searchQuery;
        const searchClearEl = document.getElementById('searchClear');
        if (searchClearEl) searchClearEl.style.display = 'block';
      }

      // 4. Restore extension shortcuts immediately
      await this.restoreShortcutsImmediately();

      // 5. Set filter buttons active state immediately
      this.updateFilterButtonStates();

    } catch (error) {
      console.warn('Failed to restore cached UI state:', error);
    }
  }

  // NEW: Restore shortcuts immediately to prevent visual shift
  async restoreShortcutsImmediately() {
    try {
      // Try to get shortcuts from storage first (faster)
      const { cachedShortcuts } = await browserAPI.storage.local.get(['cachedShortcuts']);
      if (cachedShortcuts && cachedShortcuts.open && cachedShortcuts.new) {
        const openEl = document.getElementById('shortcutOpenValue');
        const newEl = document.getElementById('shortcutNewValue');

        if (openEl) openEl.textContent = cachedShortcuts.open;
        if (newEl) newEl.textContent = cachedShortcuts.new;
      }

      // Then get fresh shortcuts from chrome.commands
      const actions = await browserAPI.commands.getAll();
      const openAction = actions.find(a => a.name === '_execute_action');
      const createAction = actions.find(a => a.name === '_execute_browser_action');

      // Update shortcut display elements
      const openShortcut = openAction && openAction.shortcut ? openAction.shortcut : 'Not set';
      const newShortcut = createAction && createAction.shortcut ? createAction.shortcut : 'Not set';

      const openEl = document.getElementById('shortcutOpenValue');
      const newEl = document.getElementById('shortcutNewValue');

      if (openEl) openEl.textContent = openShortcut;
      if (newEl) newEl.textContent = newShortcut;

      // Cache the shortcuts for next time
      await browserAPI.storage.local.set({
        cachedShortcuts: { open: openShortcut, new: newShortcut }
      });

    } catch (error) {
      console.warn('Failed to restore shortcuts immediately:', error);
      // Only set fallback if no cached values were loaded
      const { cachedShortcuts } = await browserAPI.storage.local.get(['cachedShortcuts']);
      if (!cachedShortcuts || !cachedShortcuts.open || !cachedShortcuts.new) {
        const openEl = document.getElementById('shortcutOpenValue');
        const newEl = document.getElementById('shortcutNewValue');

        if (openEl) openEl.textContent = 'Not set';
        if (newEl) newEl.textContent = 'Not set';
      }
    }
  }

  // NEW: Update filter button states immediately
  updateFilterButtonStates() {
    try {
      // Remove active class and ARIA attributes from all filter buttons
      document.querySelectorAll('.filter-option').forEach(btn => {
        btn.classList.remove('active');
        btn.setAttribute('aria-selected', 'false');
        btn.removeAttribute('aria-current');
      });

      // Add active class to current filter button
      const buttonId = {
        'site': 'showAllBtn',
        'page': 'showPageBtn',
        'all_notes': 'showAllNotesBtn'
      }[this.filterMode];

      if (buttonId) {
        const activeButton = document.getElementById(buttonId);
        if (activeButton) {
          activeButton.classList.add('active');
          activeButton.setAttribute('aria-selected', 'true');
          activeButton.setAttribute('aria-current', 'page');
        }
      }

      // Set data-view on root for view-specific styling
      document.documentElement.setAttribute('data-view', this.filterMode);

    } catch (error) {
      console.warn('Failed to update filter button states:', error);
    }
  }

  // Handle auth change: refresh premium from storage (set by api.js) and update UI
  async handleAuthChanged(payload) {
    try {
      // Clear local AI usage tracking on auth changes
      await this.clearLocalAIUsage();

      // Refresh premium status from both storage and Supabase client
      this.premiumStatus = await getPremiumStatus();
      await this.updatePremiumUI();

      // Update settings UI to reflect auth changes
      await this.settingsManager.updateAuthUI();

      // If this is a status refresh, also refresh notes to show any decrypted content
      if (payload && payload.statusRefresh) {
        await this.refreshNotesFromStorage();
      } else {
        // Also refresh notes to show version history buttons if premium
        if (this.premiumStatus?.isPremium) {
          this.render();
        }
      }
    } catch (error) {
      console.error('Error handling auth change:', error);
    }
  }

  // Handle tier change from api.js with status payload { active, tier }
  async handleTierChanged(status) {
    try {
      // Clear local AI usage tracking on tier changes (free vs premium have different limits)
      await this.clearLocalAIUsage();

      const isPremium = !!(status && status.active && (status.tier || 'premium') !== 'free');
      this.premiumStatus = { isPremium };
      await this.updatePremiumUI();

      // Force refresh of AI usage data to get updated limits immediately
      await this.getAIUsageDebounced();

      // Update usage display in UI
      await this.loadUsageInfo();

      // Update settings UI to reflect tier changes
      await this.settingsManager.updateAuthUI();

      // Refresh notes display to show/hide premium features
      await this.refreshNotesFromStorage();
    } catch (error) {
      console.error('Error handling tier change:', error);
    }
  }

  // Check if OAuth just completed (called during popup initialization)
  async checkOAuthCompletion() {
    try {
      const { oauthJustCompleted } = await browserAPI.storage.local.get(['oauthJustCompleted']);

      if (oauthJustCompleted && oauthJustCompleted !== null && oauthJustCompleted.success) {
        // Check if this completion is recent (within last 30 seconds)
        const timeSinceCompletion = Date.now() - oauthJustCompleted.timestamp;

        if (timeSinceCompletion < 30000) {
          // Clear the flag so we don't trigger again
          await browserAPI.storage.local.set({ oauthJustCompleted: null });

          // Trigger refresh after a short delay to ensure UI is ready
          setTimeout(() => {
            if (this.settingsManager && this.settingsManager.handleRefreshPremiumStatus) {
              this.settingsManager.handleRefreshPremiumStatus();
            }
          }, 1500);
        } else {
          // Old completion, clear it
          await browserAPI.storage.local.set({ oauthJustCompleted: null });
        }
      }
    } catch (error) {
      console.error('Error checking OAuth completion:', error);
    }
  }

  // Check if user needs to re-authenticate due to expired session
  async checkReauthRequired() {
    try {
      const storage = typeof browser !== 'undefined' ? browser.storage.local : chrome.storage.local;
      const { needsReauth } = await storage.get(['needsReauth']);

      if (needsReauth) {
        // Clear the flag
        await storage.remove(['needsReauth']);

        // Show notification to user
        this.showNotification('Authentication expired. Go to Settings to sign in again.', 'warning');
      }
    } catch (error) {
      console.error('Error checking reauth requirement:', error);
    }
  }



  // Note: Sync event handlers removed - sync only happens on timer or manual button press

  // Handle context menu notes from background script
  async handleContextMenuNote(note) {
    try {
      // Save the note using the proper storage system
      await window.notesStorage.saveNote(note);

      // Refresh the notes list
      this.allNotes = await this.loadNotes();
      this.render();

      // Show success message
      Utils.showToast('Note saved from context menu', 'success');
    } catch (error) {
      console.error('Failed to handle context menu note:', error);
      Utils.showToast('Failed to save note', 'error');
    }
  }

  // Note: Draft updates from context menu now handled via lastAction mechanism in init()

  // Handle multi-highlight note updates from background script
  async handleMultiHighlightNoteUpdate(note, type) {
    try {
      // Save the note using the proper storage system
      await window.notesStorage.saveNote(note);

      // Refresh the notes list
      this.allNotes = await this.loadNotes();
      this.render();

      // Show appropriate success message based on type
      if (type === 'append_multi_highlights') {
        Utils.showToast('Highlights added to existing note', 'success');
      } else if (type === 'new_from_multi_highlight') {
        Utils.showToast('New note created with highlights', 'success');
      } else {
        Utils.showToast('Note updated with highlights', 'success');
      }

      // If we have a current note open and it's the same one, update it
      if (this.currentNote && this.currentNote.id === note.id) {
        this.currentNote = { ...note };

        // Update the editor content to show the new content
        const contentInput = document.getElementById('noteContentInput');
        if (contentInput) {
          const safeContent = this.buildContentHtml(note.content || '');
          if (window.safeDOM) {
            window.safeDOM.setInnerHTML(contentInput, safeContent, true);
          } else {
            contentInput.innerHTML = safeContent;
          }
        }
      }
    } catch (error) {
      console.error('Failed to handle multi-highlight note update:', error);
      Utils.showToast('Failed to add highlights', 'error');
    }
  }

  // Toggle multi-highlight mode on the current webpage
  async toggleMultiHighlightMode() {
    if (!this.currentSite || !this.currentSite.url) {
      console.warn('No current site to toggle multi-highlight mode');
      return;
    }

    try {
      // Get current tab to send message
      const tab = await this.getCurrentTab();
      if (!tab) {
        console.warn('No active tab found');
        return;
      }

      // First check if content script is ready by sending a ping message
      try {
        await browserAPI.tabs.sendMessage(tab.id, { action: 'ping' });
        console.log('Content script is ready');
      } catch (error) {
        console.warn('Content script not ready, attempting to inject:', error);
        // Try to inject the content script if it's not loaded
        try {
          console.log('Attempting to inject content script...');

          // Check if we have permission to inject
          if (!browserAPI.scripting) {
            throw new Error('Scripting API not available');
          }

          // Try to inject the content script
          await browserAPI.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content.js']
          });

          console.log('Content script injection successful, waiting for initialization...');

          // Wait longer for the script to initialize and try multiple ping attempts
          let pingSuccess = false;
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await new Promise(resolve => setTimeout(resolve, 300 * attempt)); // Progressive delay
              await browserAPI.tabs.sendMessage(tab.id, { action: 'ping' });
              console.log(`Content script ping successful on attempt ${attempt}`);
              pingSuccess = true;
              break;
            } catch (pingError) {
              console.log(`Ping attempt ${attempt} failed:`, pingError);
              if (attempt === 3) {
                throw new Error('Content script not responding after multiple attempts');
              }
            }
          }

          if (!pingSuccess) {
            throw new Error('Content script not responding after injection');
          }

          console.log('Content script injected and ready');

        } catch (injectError) {
          console.error('Failed to inject content script:', injectError);

          // Provide more specific error messages
          if (injectError.message.includes('Cannot access')) {
            Utils.showToast('Cannot access this page - Try refreshing or use a regular webpage', 'error');
          } else if (injectError.message.includes('Scripting API not available')) {
            Utils.showToast('Extension permissions issue - Check extension settings', 'error');
          } else {
            Utils.showToast('Failed to load multi-highlight - Refresh the page and try again', 'error');
          }
          return;
        }
      }

      // Now send the toggle message with a timeout
      const response = await Promise.race([
        browserAPI.tabs.sendMessage(tab.id, { action: 'toggleMultiHighlight' }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Message timeout')), 5000)
        )
      ]);

      if (response && response.enabled) {
        // Update button state to show active
        const btn = document.getElementById('multiHighlightBtn');
        if (btn) {
          btn.classList.add('active');
          btn.title = 'Multi-Highlight Mode Active (Click to Exit)';
        }

        // Show notification
        Utils.showToast('Multi-highlight enabled - Select text on the page to highlight', 'success');

        // Close popup to let user interact with the webpage
        setTimeout(() => {
          window.close();
        }, 1500);
      } else {
        // Update button state to show inactive
        const btn = document.getElementById('multiHighlightBtn');
        if (btn) {
          btn.classList.remove('active');
          btn.title = 'Toggle Multi-Highlight Mode';
        }

        Utils.showToast('Multi-highlight mode disabled.', 'info');
      }
    } catch (error) {
      console.error('Failed to toggle multi-highlight mode:', error);

      if (error.message === 'Message timeout') {
        Utils.showToast('Multi-highlight not responding - Refresh the page and try again', 'error');
      } else if (error.message.includes('Could not establish connection')) {
        Utils.showToast('Multi-highlight not available on this page - Refresh and try again', 'error');
      } else {
        Utils.showToast('Failed to toggle multi-highlight - Make sure you\'re on a webpage', 'error');
      }
    }
  }

  // Check current multi-highlight state
  async checkMultiHighlightState() {
    if (!this.currentSite || !this.currentSite.url) return;

    try {
      const tab = await this.getCurrentTab();
      if (!tab) return;

      // First check if content script is ready
      try {
        await browserAPI.tabs.sendMessage(tab.id, { action: 'ping' });
      } catch (error) {
        // Content script not ready, that's okay - just return
        console.debug('Content script not ready for multi-highlight state check:', error);
        return;
      }

      const response = await browserAPI.tabs.sendMessage(tab.id, { action: 'getMultiHighlightState' });
      if (response) {
        const btn = document.getElementById('multiHighlightBtn');
        if (btn) {
          if (response.enabled) {
            btn.classList.add('active');
            btn.title = `Multi-Highlight Mode Active (${response.highlightCount} highlights)`;
          } else {
            btn.classList.remove('active');
            btn.title = 'Toggle Multi-Highlight Mode';
          }
        }
      }
    } catch (error) {
      // Content script might not be ready yet, that's okay
      console.debug('Could not check multi-highlight state:', error);
    }
  }

  // Helper method to get current tab
  async getCurrentTab() {
    try {
      const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
      return tab;
    } catch (error) {
      console.error('Failed to get current tab:', error);
      return null;
    }
  }

  // Note: Sync status update removed - sync only happens on timer or manual button press

  // Setup conflict banner event listeners
  setupConflictBannerListeners() {
    const keepMineBtn = document.getElementById('keepMineBtn');
    const useServerBtn = document.getElementById('useServerBtn');

    if (keepMineBtn) {
      keepMineBtn.addEventListener('click', () => this.handleConflictResolution('local'));
    }

    if (useServerBtn) {
      useServerBtn.addEventListener('click', () => this.handleConflictResolution('server'));
    }
  }

  // Handle conflict resolution
  handleConflictResolution(choice) {
    try {
      // Hide the conflict banner
      const banner = document.getElementById('conflictBanner');
      if (banner) {
        banner.style.display = 'none';
      }

      // Emit event for sync engine to handle
      window.eventBus?.emit('conflict:resolved', { choice });

      Utils.showToast(`Using ${choice === 'local' ? 'local' : 'server'} version`, 'success');
    } catch (_) { }
  }

  // Show conflict banner
  showConflictBanner(message = 'Sync conflict detected') {
    try {
      const banner = document.getElementById('conflictBanner');
      const messageEl = document.getElementById('conflictMessage');

      if (banner && messageEl) {
        messageEl.textContent = message;
        banner.style.display = 'block';

        // Auto-hide after 30 seconds
        setTimeout(() => {
          banner.style.display = 'none';
        }, 30000);
      }
    } catch (_) { }
  }

  // Refresh premium flag from chrome.storage.local 'userTier'
  async refreshPremiumFromStorage() {
    try {
      const { userTier } = await browserAPI.storage.local.get(['userTier']);
      const isPremium = !!(userTier && userTier !== 'free');
      this.premiumStatus = { isPremium };
      await this.updatePremiumUI();
    } catch (_) { }
  }

  // Load all notes from storage into the master list
  async loadNotes() {
    try {
      // Use IndexedDB storage if available, fallback to Chrome storage
      if (this.storageManager === window.notesStorage && typeof this.storageManager.getAllNotesForDisplay === 'function') {
        // Use IndexedDB storage - get notes for display (excludes deleted notes)
        this.allNotes = await this.storageManager.getAllNotesForDisplay();
      } else {
        // Fallback to Chrome storage
        const allData = await browserAPI.storage.local.get(null);
        let allNotes = [];
        for (const key in allData) {
          // Filter out settings or non-array data
          if (key !== 'themeMode' && Array.isArray(allData[key])) {
            allNotes = allNotes.concat(allData[key]);
          }
        }
        // Sort by most recently updated
        allNotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        this.allNotes = allNotes;
      }

      // Ensure allNotes is always an array
      if (!Array.isArray(this.allNotes)) {
        this.allNotes = [];
      }

      return this.allNotes;
    } catch (error) {
      console.error('Error loading notes:', error);
      this.allNotes = []; // Fallback to an empty list on error
      return this.allNotes;
    }
  }

  // Setup event listeners
  setupEventListeners() {
    // Listen for real-time note updates from context menu
    browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'note_updated') {
        this.handleRealTimeNoteUpdate(message);
      }
    });
    // Filter between all notes and page-specific (deduplicated bindings)
    const on = (id, evt, handler) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener(evt, handler);
    };
    [
      ['showAllBtn', 'site'],
      ['showPageBtn', 'page'],
      ['showAllNotesBtn', 'all_notes']
    ].forEach(([id, mode]) => on(id, 'click', () => this.switchFilter(mode)));

    // Search functionality
    const searchInput = document.getElementById('searchInput');
    const searchClear = document.getElementById('searchClear');

    // Debounce render function
    const debouncedRender = Utils.debounce(() => this.render(), 200);

    searchInput.addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      debouncedRender();
      searchClear.style.display = this.searchQuery ? 'block' : 'none';
      try { browserAPI.storage.local.set({ lastSearchQuery: this.searchQuery }); } catch (_) { }
    });

    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      this.searchQuery = '';
      this.render();
      searchClear.style.display = 'none';
      // Clear the search query from storage so it doesn't restore on reopen
      try { browserAPI.storage.local.remove('lastSearchQuery'); } catch (_) { }
    });

    // Add new note
    document.getElementById('addNoteBtn').addEventListener('click', async () => {
      // Use the main createNewNote method which has better error handling
      await this.createNewNote();
    });


    // Editor controls
    // Shared save handler to avoid duplication across Back and Save buttons
    const saveStandard = () => this.saveCurrentNote({
      clearDraftAfterSave: false,
      closeEditorAfterSave: false,
      showToast: true,
      switchFilterAfterSave: false // Keep current filter
    }).catch(() => { });
    document.getElementById('backBtn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Back button: Save note and clear draft (same as save button)
      const notesContainer = document.querySelector('.notes-container');
      this.editorManager.closeEditor({ clearDraft: true });
      // Animate notes list entrance
      if (notesContainer) {
        notesContainer.classList.add('panel-fade-in');
        setTimeout(() => notesContainer.classList.remove('panel-fade-in'), 220);
      }
      // Save the note
      saveStandard();
    });

    document.getElementById('saveNoteBtn').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Same functionality as back button: save and close editor
      const notesContainer = document.querySelector('.notes-container');
      this.editorManager.closeEditor({ clearDraft: true });
      // Animate notes list entrance
      if (notesContainer) {
        notesContainer.classList.add('panel-fade-in');
        setTimeout(() => notesContainer.classList.remove('panel-fade-in'), 220);
      }
      // Use same save path as Back button
      saveStandard();
    });

    document.getElementById('deleteNoteBtn').addEventListener('click', () => {
      this.deleteCurrentNote();
    });

    document.getElementById('exportNoteBtn').addEventListener('click', () => {
      this.exportCurrentNote();
    });

    // Editor inputs
    document.getElementById('noteTitleHeader').addEventListener('input', () => {
      this.saveDraftDebounced();
    });

    const contentInput = document.getElementById('noteContentInput');
    contentInput.addEventListener('input', (e) => {
      this.editorManager.updateCharCount();

      // Skip draft saving during AI rewrite to prevent content reset
      if (!this._isApplyingAIRewrite) {
        this.saveDraftDebounced();
      }
    });
    // Paste sanitization: allow only text, links, and line breaks
    contentInput.addEventListener('paste', (e) => this.handleEditorPaste(e));
    // Intercept link clicks inside the editor (use capture phase to handle before contenteditable)
    contentInput.addEventListener('click', (e) => this.handleEditorLinkClick(e), true);
    // Also handle mousedown to prevent selection issues with links
    contentInput.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'A') {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    }, true);

    // Handle Enter key for list creation
    contentInput.addEventListener('keydown', (e) => this.editorManager.handleEditorKeyDown(e));

    // Skip textarea-specific key handling; editor is now contenteditable

    document.getElementById('tagsInput').addEventListener('input', () => {
      this.saveDraftDebounced();
    });

    // Settings button simply opens the settings panel
    document.getElementById('settingsBtn').addEventListener('click', () => {
      this.openSettings();
    });

    // Multi-highlight button toggles multi-highlight mode on the current webpage
    document.getElementById('multiHighlightBtn').addEventListener('click', () => {
      this.toggleMultiHighlightMode();
    });



    // Import functionality is handled by SettingsManager
    // No need to add duplicate event listeners here

    document.getElementById('aiRewriteBtn').addEventListener('click', async () => {
      // Toggle AI dropdown
      await this.toggleAIDropdown();
    });

    // AI Summary button click handler
    const aiSummaryBtn = document.getElementById('aiSummaryBtn');
    if (aiSummaryBtn) {
      aiSummaryBtn.addEventListener('click', () => {
        this.showAISummaryModal();
      });
    } else {
      console.warn('AI Summary button not found in setupEventListeners');
    }

    document.getElementById('listBtn').addEventListener('click', () => {
      this.editorManager.createList();
    });

    // Initialize formatting controls (bold, underline, strikethrough, color)
    this.editorManager.initializeFormattingControls();

    // Developer tools removed: mock data generation/cleanup and storage stress tools

    // Font selector
    document.getElementById('fontSelector').addEventListener('change', (e) => {
      this.saveFontSetting(e.target.value);
    });





    // Refresh notes when storage changes (e.g., context menu adds a note)
    // Debounce to avoid thrashing on bulk updates/imports
    const debouncedRefresh = Utils.debounce(async () => {
      // Don't refresh during filter transitions to prevent pop-in effect
      if (this._isFilterTransitioning) return;



      this.allNotes = await this.loadNotes();
      this.render();
      // If the currently open editor's note changed in storage, refresh its fields live
      if (this.currentNote) {
        const updated = this.allNotes.find(n => n.id === this.currentNote.id);
        if (updated) {
          const editorEl = document.getElementById('noteEditor');
          const isEditorOpen = editorEl && editorEl.style.display !== 'none';

          // Check if editor has unsaved changes before replacing currentNote
          let hasUnsavedChanges = false;
          if (isEditorOpen) {
            const titleHeader = document.getElementById('noteTitleHeader');
            const contentInput = document.getElementById('noteContentInput');
            const tagsInput = document.getElementById('tagsInput');

            // Check if current editor content differs from the updated note
            const currentTitle = (titleHeader && titleHeader.value) || '';
            const currentContent = this.htmlToMarkdown(contentInput ? contentInput.innerHTML : '');
            const currentTags = (tagsInput && tagsInput.value
              ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
              : []);

            hasUnsavedChanges = (
              currentTitle !== (updated.title || '') ||
              currentContent !== (updated.content || '') ||
              JSON.stringify(currentTags.sort()) !== JSON.stringify((updated.tags || []).sort())
            );
          }

          // Only replace currentNote if there are no unsaved changes OR if the note content actually changed in storage
          // This allows legitimate updates (like context menu appends) to override unsaved changes
          const noteContentChanged = (
            (updated.title || '') !== (this.currentNote.title || '') ||
            (updated.content || '') !== (this.currentNote.content || '') ||
            JSON.stringify((updated.tags || []).sort()) !== JSON.stringify((this.currentNote.tags || []).sort())
          );

          if (!hasUnsavedChanges || noteContentChanged) {
            this.currentNote = { ...updated };
          }

          if (isEditorOpen && (!hasUnsavedChanges || noteContentChanged)) {
            const titleHeader = document.getElementById('noteTitleHeader');
            const contentInput = document.getElementById('noteContentInput');
            const tagsInput = document.getElementById('tagsInput');

            // Only update fields if they are not focused and actually differ
            if (titleHeader) {
              const titleFocused = document.activeElement === titleHeader;
              const newTitle = this.currentNote.title || '';
              if (!titleFocused && titleHeader.value !== newTitle) {
                titleHeader.value = newTitle;
              }
            }

            if (contentInput) {
              const contentFocused = document.activeElement === contentInput;
              const newHtml = this.buildContentHtml(this.currentNote.content || '');
              if (!contentFocused && contentInput.innerHTML !== newHtml) {
                if (window.safeDOM) {
                  window.safeDOM.setInnerHTML(contentInput, newHtml, true);
                } else {
                  contentInput.innerHTML = newHtml;
                }
              }
            }

            if (tagsInput) {
              const tagsFocused = document.activeElement === tagsInput;
              const newTags = (this.currentNote.tags || []).join(', ');
              if (!tagsFocused && tagsInput.value !== newTags) {
                tagsInput.value = newTags;
              }
            }
          }
        }
      }
    }, 120);

    // Listen for in-app notes events to refresh immediately (authored changes)
    try {
      const refresh = () => debouncedRefresh();
      window.eventBus?.on('notes:created', refresh);
      window.eventBus?.on('notes:updated', refresh);
      window.eventBus?.on('notes:deleted', refresh);
      window.eventBus?.on('notes:domain_deleted', refresh);
      window.eventBus?.on('notes:imported', refresh);
    } catch (_) { }

    browserAPI.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      // Ignore editorState-only changes (draft autosave), which shouldn't trigger a UI refresh
      const changedKeys = Object.keys(changes || {});
      if (changedKeys.length > 0 && changedKeys.every(k => k === 'editorState' || k === 'allNotesOpenDomains' || k === 'lastSearchQuery')) {
        return;
      }
      // If the user is actively editing in the editor, avoid immediate refresh to prevent caret jumps.
      const active = document.activeElement;
      const isEditing = active && (active.id === 'noteTitleHeader' || active.id === 'noteContentInput' || active.id === 'tagsInput');
      if (isEditing) {
        clearTimeout(this._pendingStorageRefresh);
        this._pendingStorageRefresh = setTimeout(() => {
          debouncedRefresh();
        }, 400);
        return;
      }
      // Otherwise refresh normally
      debouncedRefresh();
    });

    // Persist editor/filter state when popup is about to close
    const pagehideHandler = () => {
      try {
        // Save draft if we have a current note
        if (this.currentNote) {
          this.saveEditorDraft();
          // Don't change wasEditorOpen flag here - preserve it for next open
          // Just mark popup as closed
        } else if (!this.currentNote) {
          // No current note, so editor wasn't open
          this.persistEditorOpen(false);
        }

        // Mark popup as closed for context menu detection
        browserAPI.storage.local.get(['editorState']).then(({ editorState }) => {
          if (editorState) {
            editorState.open = false;
            // Preserve wasEditorOpen flag - don't clear it
            browserAPI.storage.local.set({ editorState });
          }
        });
      } catch (_) { }
    };
    window.addEventListener('pagehide', pagehideHandler);
    this._eventListeners.push({ target: window, event: 'pagehide', handler: pagehideHandler });
  }

  initSettings() {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsPanel = document.getElementById('settingsPanel');
    const settingsBackBtn = document.getElementById('settingsBackBtn');
    const exportNotesBtn = document.getElementById('exportNotesBtn');
    const importNotesBtn = document.getElementById('importNotesBtn');
    const importNotesInput = document.getElementById('importNotesInput');
    const fontSelector = document.getElementById('fontSelector');
    const fontSizeSelect = document.getElementById('fontSizeSelect');
    const fontSizeValue = document.getElementById('fontSizeValue');
    const fontPreviewText = document.getElementById('fontPreviewText');

    const updateFontPreview = (fontName, sizePx) => {
      if (fontPreviewText) {
        const previewFontFamily = (fontName === 'Default' || fontName === 'System')
          ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
          : fontName;
        fontPreviewText.style.fontFamily = previewFontFamily;
        fontPreviewText.style.fontSize = `${sizePx}px`;
      }
    };

    // Close settings: apply chosen font to editor then hide panel
    // Keep this binding here so it's wired once
    settingsBackBtn.addEventListener('click', () => {
      const fontName = fontSelector.value;
      const size = fontSizeSelect.value;
      this.applyFont(fontName, size);
      this.closeSettings();
    });

    // Font controls
    fontSelector.addEventListener('change', (e) => {
      const fontName = e.target.value;
      const size = fontSizeSelect.value;
      // Do not apply to editor while settings is open; preview only
      updateFontPreview(fontName, size);
      browserAPI.storage.local.set({ editorFont: fontName });
    });

    fontSizeSelect.addEventListener('change', (e) => {
      let size = parseInt(e.target.value, 10);
      if (Number.isNaN(size)) size = 12;
      // Clamp to [8, 18]
      size = Math.max(8, Math.min(18, size));
      const fontName = fontSelector.value;
      // Do not apply to editor while settings is open; preview only
      updateFontPreview(fontName, size);
      browserAPI.storage.local.set({ editorFontSize: String(size) });
    });

    // Load saved font settings
    browserAPI.storage.local.get(['editorFont', 'editorFontSize'], ({ editorFont, editorFontSize }) => {
      // Normalize legacy 'System' to 'Default'
      const normalizedFont = editorFont === 'System' ? 'Default' : (editorFont || 'Default');
      fontSelector.value = normalizedFont;
      if (editorFont === 'System') {
        browserAPI.storage.local.set({ editorFont: 'Default' });
      }
      // Determine size with default 12 and clamp within [8, 18]
      let sizeToUse = parseInt(editorFontSize || fontSizeSelect.value || '12', 10);
      if (Number.isNaN(sizeToUse)) sizeToUse = 12;
      sizeToUse = Math.max(8, Math.min(18, sizeToUse));
      fontSizeSelect.value = String(sizeToUse);
      this.applyFont(fontSelector.value, sizeToUse);
      updateFontPreview(fontSelector.value, sizeToUse);
    });
  }


  // Switch between different note filters
  // options.persist: whether to store lastFilterMode (default: true)
  async switchFilter(filter, options = { persist: true, render: true }) {
    // Prevent rapid filter switching
    if (this.filterMode === filter) return;

    // Set flag to prevent other renders during filter transition
    this._isFilterTransitioning = true;

    this.filterMode = filter;

    // Clear search when switching filters since results may not be relevant
    if (this.searchQuery) {
      this.searchQuery = '';
      const searchInput = document.getElementById('searchInput') || document.querySelector('.search-input');
      if (searchInput) searchInput.value = '';
      const searchClear = document.getElementById('searchClear');
      if (searchClear) searchClear.style.display = 'none';
      // Clear from storage
      try { browserAPI.storage.local.remove('lastSearchQuery'); } catch (_) { }
    }

    // Update filter UI
    document.querySelectorAll('.filter-option').forEach(btn => {
      btn.classList.remove('active');
      btn.setAttribute('aria-selected', 'false');
      btn.removeAttribute('aria-current');
    });
    const buttonId = {
      'site': 'showAllBtn',
      'page': 'showPageBtn',
      'all_notes': 'showAllNotesBtn'
    }[filter];
    const filterBtn = document.getElementById(buttonId);
    if (filterBtn) {
      filterBtn.classList.add('active');
      filterBtn.setAttribute('aria-selected', 'true');
      filterBtn.setAttribute('aria-current', 'page');
    }

    // Set data-view on root for view-specific styling (compact site/page)
    document.documentElement.setAttribute('data-view', filter);

    // Search placeholder is now handled centrally in restoreCachedUIState to prevent caching conflicts
    // No need to update it here anymore

    // Ensure notes are loaded before rendering to prevent pop-in effect
    if (options.render !== false) {
      // Load notes first if not already loaded
      if (!this.allNotes || !Array.isArray(this.allNotes)) {
        await this.loadNotes();
      }
      // Now render with fresh data
      this.render();
    }

    // Persist last chosen filter unless suppressed
    if (!options || options.persist !== false) {
      browserAPI.storage.local.set({ lastFilterMode: this.filterMode });
    }

    // Clear filter transition flag after a delay
    setTimeout(() => {
      this._isFilterTransitioning = false;
    }, 300);
  }

  // Delegate notes rendering to NotesManager (modularized)
  render() {
    const t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    this.notesManager.render();
    const t1 = (window.performance && performance.now) ? performance.now() : Date.now();
    // Note: Removed verbose render timing logging for cleaner console
  }

  // Proactive, non-blocking storage warnings using toast only (no dialog to avoid API mismatch)
  async maybeShowQuotaWarning() {
    try {
      if (!this.storageManager || !this.storageManager.checkStorageQuota) return;
      const est = await this.storageManager.checkStorageQuota();
      if (!est || typeof est.percentage !== 'number') return;
      const pct = est.percentage;
      const band = pct >= 95 ? 'critical' : pct >= 90 ? 'high' : pct >= 75 ? 'warn' : 'ok';
      if (band === 'ok') return;
      if (this._lastQuotaWarnBand === band) return;
      this._lastQuotaWarnBand = band;
      const msg = band === 'critical'
        ? `Storage almost full: ${est.usageInMB}/${est.quotaInMB} MB (${pct}%). Saves may fail.`
        : band === 'high'
          ? `Storage very high: ${est.usageInMB}/${est.quotaInMB} MB (${pct}%).`
          : `Storage usage high: ${est.usageInMB}/${est.quotaInMB} MB (${pct}%).`;
      Utils.showToast(msg, 'info');
    } catch (_) { /* noop */ }
  }

  // Group notes by domain, including aggregated tags
  groupNotesByDomain(notes) {
    const grouped = notes.reduce((acc, note) => {
      const domain = note.domain || 'No Domain';
      if (!acc[domain]) {
        acc[domain] = { notes: [], tagCounts: {} };
      }
      acc[domain].notes.push(note);
      if (note.tags && note.tags.length > 0) {
        note.tags.forEach(tag => {
          acc[domain].tagCounts[tag] = (acc[domain].tagCounts[tag] || 0) + 1;
        });
      }
      return acc;
    }, {});

    // Get top 5 tags for each domain
    for (const domain in grouped) {
      grouped[domain].tags = Object.entries(grouped[domain].tagCounts)
        .sort(([, countA], [, countB]) => countB - countA)
        .slice(0, 5)
        .map(([tag]) => tag);
    }

    return grouped;
  }

  // Render notes grouped by domain for 'All Notes' view
  renderGroupedNotes(notes) {
    const notesList = document.getElementById('notesList');
    notesList.setAttribute('aria-busy', 'true');
    const groupedData = this.groupNotesByDomain(notes);
    const sortedDomains = Object.keys(groupedData).sort();

    // Only clear if there are other children to prevent unnecessary clearing
    if (notesList.children.length > 0) {
      if (window.safeDOM) {
        window.safeDOM.clearContent(notesList);
      } else {
        notesList.innerHTML = '';
      }
    }
    notesList.classList.add('notes-fade-in');

    sortedDomains.forEach(domain => {
      const { notes: domainNotes, tags: domainTags } = groupedData[domain];

      const domainGroup = document.createElement('details');
      domainGroup.className = 'domain-group';
      // Expand top two results only when searching
      const domainIndex = sortedDomains.indexOf(domain);
      domainGroup.open = this.searchQuery && domainIndex < 2;

      // Domain group created

      const rightDomainTagsHtml = (domainTags && domainTags.length > 0) ? `
        <div class="domain-tags domain-tags-right">
          ${domainTags.map(tag => `<span class="note-tag">${tag}</span>`).join('')}
        </div>
      ` : '';

      const domainGroupHtml = `
        <summary class="domain-group-header">
          <div class="domain-header-info">
            <span>${domain} (${domainNotes.length})</span>
            <div class="domain-inline-actions">
              <button class="icon-btn sm glass open-domain-btn" data-domain="${domain}" title="Open ${domain}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 3h7v7"/>
                  <path d="M10 14 21 3"/>
                  <path d="M3 10v11h11"/>
                </svg>
              </button>
            </div>
          </div>
          <div class="domain-actions">
            <button class="icon-btn delete-domain-btn" data-domain="${domain}" title="Delete all notes for this domain">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-trash-2"><polyline points="3,6 5,6 21,6"></polyline><path d="m19,6v14a2,2,0,0,1-2,2H7a2,2,0,0,1-2-2V6m3,0V4a2,2,0,0,1,2-2h4a2,2,0,0,1,2,2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
            </button>
          </div>
          ${rightDomainTagsHtml}
        </summary>
        <div class="domain-notes-list"></div>
      `;

      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(domainGroup, domainGroupHtml, false);
      } else {
        domainGroup.innerHTML = domainGroupHtml;
      }

      // No pre-open suppression; restore original behavior

      const deleteDomainBtn = domainGroup.querySelector('.delete-domain-btn');
      const openDomainBtn = domainGroup.querySelector('.open-domain-btn');
      const actionsContainer = domainGroup.querySelector('.domain-actions');
      const domainNotesList = domainGroup.querySelector('.domain-notes-list');

      deleteDomainBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        this.showInlineConfirm(actionsContainer, () => {
          this.deleteNotesByDomain(domain, true);
        });
      });

      if (openDomainBtn) {
        openDomainBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          this.openDomainHomepage(domain);
        });
      }

      // Append note elements as DOM nodes so their event listeners remain active
      domainNotes.forEach(n => {
        const el = this.createNoteElement(n);
        el.classList.add('note-item-stagger');
        domainNotesList.appendChild(el);
      });

      notesList.appendChild(domainGroup);
    });
    notesList.setAttribute('aria-busy', 'false');
  }

  // Create a note element
  createNoteElement(note) {
    const noteDiv = document.createElement('div');
    noteDiv.className = 'note-item';
    noteDiv.addEventListener('click', () => this.openNote(note));

    // Build preview HTML that makes markdown links clickable (first line only)
    const previewHtml = this.buildPreviewHtml(note.content);

    // Show page indicator for current page notes when not in page filter mode
    const pageIndicator = (this.filterMode !== 'page' && this.isCurrentPageNote(note)) ?
      '<span class="page-indicator" data-tooltip="Current page note">•</span>' : '';

    // Check if user has premium access for version history button
    const hasVersionHistory = this.premiumStatus?.isPremium || false;

    const noteHtml = `
      <div class="note-content">
        <div class="note-main">
          <h4 class="note-title">${pageIndicator}${note.title || 'Untitled'}</h4>
          <div class="note-preview">${previewHtml}</div>
        </div>
        <div class="note-sidebar">
          <div class="note-actions">
            <button class="icon-btn open-page-btn" data-url="${note.url}" title="Open page">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                <polyline points="15,3 21,3 21,9"></polyline>
                <line x1="10" y1="14" x2="21" y2="3"></line>
              </svg>
            </button>
            ${hasVersionHistory ? `
              <button class="icon-btn version-history-btn" title="Version History">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" stroke-width="2"/>
                </svg>
              </button>
            ` : ''}
            <button class="icon-btn delete-note-btn" data-note-id="${note.id}" title="Delete note">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3,6 5,6 21,6"></polyline>
                <path d="m19,6v14a2,2 0 0,1 -2,2H7a2 2 0 0,1 -2,-2V6m3,0V4a2,2 0 0,1 2,-2h4a2 2 0 0,1 2,2v2"></path>
                <line x1="10" y1="11" x2="10" y2="3"></line>
                <line x1="14" y1="11" x2="14" y2="17"></line>
              </svg>
            </button>
          </div>
          <div class="note-meta">
            <span class="note-date">${Utils.formatDate(note.updatedAt)}</span>
            <span class="note-domain">${note.domain}</span>
          </div>
          ${note.tags && note.tags.length > 0 ? `<div class="note-tags">${note.tags.slice(0, 2).map(tag => `<span class="note-tag">${tag}</span>`).join('')}${note.tags.length > 2 ? `<span class="note-tag note-tag-more">+${note.tags.length - 2}</span>` : ''}</div>` : ''}
        </div>
      </div>
    `;

    if (window.safeDOM) {
      window.safeDOM.setInnerHTML(noteDiv, noteHtml, false);
    } else {
      noteDiv.innerHTML = noteHtml;
    }

    // Add open button event listener (only present in non-page views)
    const openBtn = noteDiv.querySelector('.open-page-btn');
    if (openBtn) {
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const displayText = note.title || note.pageTitle || '';
        this.openLinkAndHighlight(note.url, displayText);
      });
    }

    // Add version history button event listener
    const versionBtn = noteDiv.querySelector('.version-history-btn');
    if (versionBtn) {
      versionBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Note: Removed verbose logging for cleaner console
        // Call the version history method from notes.js module
        if (window.notesManager && window.notesManager.showVersionHistory) {
          window.notesManager.showVersionHistory(note);
        } else {
          console.warn('Version history functionality not available');
        }
      });
    }

    // Add delete button event listener (two-tap confirm on same icon)
    const deleteBtn = noteDiv.querySelector('.delete-note-btn');
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent opening the note
      this.handleTwoTapDelete(deleteBtn, () => {
        this.deleteNoteFromList(note.id, true);
      });
    });

    return noteDiv;
  }

  // Lightweight two-tap delete: first tap arms, second within timeout confirms
  handleTwoTapDelete(btn, onConfirm) {
    try {
      const armed = btn.getAttribute('data-armed') === 'true';
      if (armed) {
        // Confirmed
        btn.removeAttribute('data-armed');
        btn.classList.remove('confirm');
        if (btn._confirmTimer) {
          clearTimeout(btn._confirmTimer);
          btn._confirmTimer = null;
        }
        onConfirm && onConfirm();
        return;
      }
      // Arm
      btn.setAttribute('data-armed', 'true');
      btn.classList.add('confirm');
      const prevTitle = btn.getAttribute('title') || '';
      btn.setAttribute('data-prev-title', prevTitle);
      btn.setAttribute('title', 'Click again to delete');
      // Auto-disarm after 1.6s
      btn._confirmTimer = setTimeout(() => {
        btn.removeAttribute('data-armed');
        btn.classList.remove('confirm');
        const pt = btn.getAttribute('data-prev-title');
        if (pt !== null) btn.setAttribute('title', pt);
      }, 1600);
    } catch (_) {
      // Fallback: direct confirm
      onConfirm && onConfirm();
    }
  }

  // Convert first line of note content to preview HTML with clickable links
  buildPreviewHtml(content) {
    try {
      const firstLine = (content || '').split('\n')[0];
      if (!firstLine) return '';
      // Escape HTML except simple markdown links we convert below
      const escapeHtml = (s) => s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Extract optional leading bullet "- " then markdown link [text](url)
      const bulletMatch = firstLine.match(/^\s*-\s*(.*)$/);
      const line = bulletMatch ? bulletMatch[1] : firstLine;

      // Replace markdown links with plain text (no anchors in list preview)
      const mdLink = /\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
      let replaced = '';
      let lastIndex = 0;
      let match;
      while ((match = mdLink.exec(line)) !== null) {
        // Append escaped text before the match
        replaced += escapeHtml(line.slice(lastIndex, match.index));
        const text = escapeHtml(match[1]);
        // Only include the display text; do not render as a link in previews
        replaced += `${text}`;
        lastIndex = mdLink.lastIndex;
      }
      replaced += escapeHtml(line.slice(lastIndex));

      // Add a bullet visually if original started with "- "
      const bulletPrefix = bulletMatch ? '&#8226; ' : '';
      return `${bulletPrefix}${replaced}`;
    } catch (e) {
      return (content || '').substring(0, 100);
    }
  }

  // Render markdown/plain text to minimal HTML for the contenteditable editor
  buildContentHtml(content) {
    try {
      const escapeHtml = (s) => (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      let text = content || '';

      // Convert formatting markers to HTML (process outermost first to handle nesting)
      // Bold: **text** -> <b>text</b> (process first - outermost)
      text = text.replace(/\*\*([^*]*(?:\*(?!\*)[^*]*)*)\*\*/g, '<b>$1</b>');

      // Italics: *text* -> <i>text</i> (avoid conflict with bold)
      text = text.replace(/\*([^*]+)\*/g, '<i>$1</i>');

      // Underline: __text__ -> <u>text</u>
      text = text.replace(/__([^_]*(?:_(?!_)[^_]*)*?)__/g, '<u>$1</u>');

      // Strikethrough: ~~text~~ -> <s>text</s> (process last - innermost)
      text = text.replace(/~~([^~]*(?:~(?!~)[^~]*)*?)~~/g, '<s>$1</s>');

      // Color: {color:#ff0000}text{/color} -> <span style="color:#ff0000">text</span>
      text = text.replace(/\{color:([^}]+)\}([^{]*)\{\/color\}/g, '<span style="color:$1">$2</span>');

      // Citation: {citation}text{/citation} -> <span style="font-style: italic; color: var(--text-secondary)">text</span>
      text = text.replace(/\{citation\}([^{]*)\{\/citation\}/g, '<span style="font-style: italic; color: var(--text-secondary)">$1</span>');

      const lines = text.split(/\r?\n/);
      const mdLink = /\[(.+?)\]\((https?:\/\/[^\s)]+)\)/g;
      const htmlLines = lines.map(line => {
        let out = '';
        let lastIndex = 0;
        let match;
        while ((match = mdLink.exec(line)) !== null) {
          // Don't escape the part that might contain our HTML tags
          const beforeLink = line.slice(lastIndex, match.index);
          out += this.escapeHtmlExceptTags(beforeLink);
          const text = escapeHtml(match[1]);
          const href = match[2];
          out += `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
          lastIndex = mdLink.lastIndex;
        }
        const afterLink = line.slice(lastIndex);
        out += this.escapeHtmlExceptTags(afterLink);
        return out;
      });
      return htmlLines.join('<br>');
    } catch (e) {
      return (content || '').replace(/\n/g, '<br>');
    }
  }

  // Helper method to escape HTML but preserve our formatting tags
  escapeHtmlExceptTags(text) {
    // First escape all HTML
    let escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Then unescape our allowed formatting tags
    escaped = escaped
      .replace(/&lt;(\/?(?:b|i|u|s|span[^&]*))&gt;/gi, '<$1>')
      .replace(/&lt;span style=&quot;([^&]*)&quot;&gt;/gi, '<span style="$1">');

    return escaped;
  }

  // Convert limited HTML back to markdown-like plain text for storage
  htmlToMarkdown(html) {
    const tmp = document.createElement('div');
    if (window.safeDOM) {
      window.safeDOM.setInnerHTML(tmp, html || '', true);
    } else {
      tmp.innerHTML = html || '';
    }
    // Remove disallowed tags by unwrapping while preserving line breaks.
    // For block elements, insert <br> boundaries to reflect visual line breaks.
    const allowed = new Set(['A', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN']);
    const blockTags = new Set(['DIV', 'P', 'PRE', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
    const walker = document.createTreeWalker(tmp, NodeFilter.SHOW_ELEMENT, null);
    const toRemove = [];
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (!allowed.has(el.tagName)) {
        const isBlock = blockTags.has(el.tagName);
        if (isBlock) {
          // Insert a <br> before block (if not at start or already separated)
          if (el.previousSibling && el.previousSibling.nodeName !== 'BR') {
            el.parentNode.insertBefore(document.createElement('br'), el);
          }
        }
        // Unwrap: move children out in place
        let lastChild = null;
        while (el.firstChild) {
          lastChild = el.firstChild;
          el.parentNode.insertBefore(lastChild, el);
        }
        if (isBlock) {
          // Insert a <br> after block to mark end of this block
          if (lastChild && lastChild.nodeName !== 'BR') {
            el.parentNode.insertBefore(document.createElement('br'), el);
          }
        }
        toRemove.push(el);
      }
    }
    toRemove.forEach(n => n.remove());

    // Convert formatting tags to markdown-style markers
    // Process innermost tags first to preserve nested formatting
    // We need to process in reverse document order to handle nested tags correctly

    // Strikethrough tags (process first - innermost)
    tmp.querySelectorAll('s, strike').forEach(el => {
      const innerHTML = el.innerHTML;
      const md = document.createElement('span');
      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(md, `~~${innerHTML}~~`, true);
      } else {
        md.innerHTML = `~~${innerHTML}~~`;
      }
      // Replace with the content, not a text node, to preserve nested HTML
      while (md.firstChild) {
        el.parentNode.insertBefore(md.firstChild, el);
      }
      el.remove();
    });

    // Underline tags
    tmp.querySelectorAll('u').forEach(el => {
      const innerHTML = el.innerHTML;
      const md = document.createElement('span');
      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(md, `__${innerHTML}__`, true);
      } else {
        md.innerHTML = `__${innerHTML}__`;
      }
      while (md.firstChild) {
        el.parentNode.insertBefore(md.firstChild, el);
      }
      el.remove();
    });

    // Italics tags
    tmp.querySelectorAll('i, em').forEach(el => {
      const innerHTML = el.innerHTML;
      const md = document.createElement('span');
      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(md, `*${innerHTML}*`, true);
      } else {
        md.innerHTML = `*${innerHTML}*`;
      }
      while (md.firstChild) {
        el.parentNode.insertBefore(md.firstChild, el);
      }
      el.remove();
    });

    // Bold tags (process last - outermost)
    tmp.querySelectorAll('b, strong').forEach(el => {
      const innerHTML = el.innerHTML;
      const md = document.createElement('span');
      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(md, `**${innerHTML}**`, true);
      } else {
        md.innerHTML = `**${innerHTML}**`;
      }
      while (md.firstChild) {
        el.parentNode.insertBefore(md.firstChild, el);
      }
      el.remove();
    });

    // Citation spans (preserve with special formatting) - process BEFORE color spans
    tmp.querySelectorAll('span[style*="font-style: italic"][style*="color"]').forEach(el => {
      const text = el.textContent;
      // Check if this looks like a citation (italic + secondary color)
      const style = el.getAttribute('style');
      if (style.includes('font-style: italic') && style.includes('var(--text-secondary)')) {
        // Mark as citation with special syntax
        const md = document.createTextNode(`{citation}${text}{/citation}`);
        el.replaceWith(md);
      } else {
        // Just unwrap if not a citation
        el.replaceWith(document.createTextNode(text));
      }
    });

    // Color spans (process AFTER citation spans to avoid conflicts)
    tmp.querySelectorAll('span[style*="color"]').forEach(el => {
      const text = el.textContent;
      const style = el.getAttribute('style');
      const colorMatch = style.match(/color:\s*([^;]+)/);
      if (colorMatch) {
        const color = colorMatch[1].trim();
        const md = document.createTextNode(`{color:${color}}${text}{/color}`);
        el.replaceWith(md);
      } else {
        // If no color found, just unwrap
        el.replaceWith(document.createTextNode(text));
      }
    });

    // Replace anchors with [text](href)
    tmp.querySelectorAll('a[href]').forEach(a => {
      const text = a.textContent || a.getAttribute('href');
      const href = a.getAttribute('href');
      const md = document.createTextNode(`[${text}](${href})`);
      a.replaceWith(md);
    });

    // Convert <br> to \n
    const htmlStr = tmp.innerHTML
      .replace(/<br\s*\/?>(?=\n)?/gi, '\n')
      .replace(/<br\s*\/?>(?!\n)/gi, '\n');

    // Strip remaining tags if any
    const text = htmlStr.replace(/<[^>]*>/g, '');
    // Decode entities by using textContent of a temp element
    const decode = document.createElement('textarea');
    if (window.safeDOM) {
      window.safeDOM.setInnerHTML(decode, text, false);
    } else {
      decode.innerHTML = text;
    }
    return decode.value;
  }

  // --- Caret/Selection utilities ---
  getSelectionOffsets(container) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
      const range = sel.getRangeAt(0);
      const computePos = (node, targetNode, targetOffset) => {
        let pos = 0;
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ALL, null);
        let current = walker.currentNode;
        const advance = (n) => {
          if (n.nodeType === Node.TEXT_NODE) {
            pos += n.nodeValue.length;
          } else if (n.nodeName === 'BR') {
            pos += 1; // treat <br> as one char (newline)
          }
        };
        // If container itself is text node, handle differently
        if (node.nodeType === Node.TEXT_NODE) {
          // Not typical for our container; fallback to length
          return Math.min(targetOffset, node.nodeValue.length);
        }
        while (current) {
          if (current === targetNode) {
            if (current.nodeType === Node.TEXT_NODE) {
              pos += Math.min(targetOffset, current.nodeValue.length);
            } else if (current.nodeName === 'BR') {
              pos += 1; // caret after BR counts as after newline
            }
            break;
          }
          // Dive into children first
          if (current.firstChild) {
            current = current.firstChild;
            continue;
          }
          // Process node
          advance(current);
          // Move to next sibling or ascend
          while (current && !current.nextSibling && current !== node) {
            current = current.parentNode;
          }
          if (!current || current === node) {
            break;
          }
          current = current.nextSibling;
        }
        return pos;
      };
      const start = computePos(container, range.startContainer, range.startOffset);
      const end = computePos(container, range.endContainer, range.endOffset);
      return { start, end };
    } catch (_) {
      return { start: 0, end: 0 };
    }
  }

  setSelectionOffsets(container, start, end) {
    try {
      let pos = 0;
      let startNode = null, startOffset = 0;
      let endNode = null, endOffset = 0;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL, null);
      let current = walker.currentNode;

      const matchPoint = (needStart, needEnd, len) => {
        if (needStart && startNode === null && pos + len >= start) {
          startNode = current.nodeType === Node.TEXT_NODE ? current : container;
          startOffset = current.nodeType === Node.TEXT_NODE ? (start - pos) : 0;
        }
        if (needEnd && endNode === null && pos + len >= end) {
          endNode = current.nodeType === Node.TEXT_NODE ? current : container;
          endOffset = current.nodeType === Node.TEXT_NODE ? (end - pos) : 0;
        }
      };

      while (current) {
        if (current.nodeType === Node.TEXT_NODE) {
          const len = current.nodeValue.length;
          matchPoint(true, true, len);
          pos += len;
        } else if (current.nodeName === 'BR') {
          const len = 1;
          // Place caret before/after BR by anchoring to container and zero offsets; browsers will place it around the BR
          matchPoint(true, true, len);
          pos += len;
        }

        // Traverse depth-first
        if (current.firstChild) {
          current = current.firstChild;
          continue;
        }
        while (current && !current.nextSibling && current !== container) {
          current = current.parentNode;
        }
        if (!current || current === container) break;
        current = current.nextSibling;
      }

      const range = document.createRange();
      range.setStart(startNode || container, startNode ? startOffset : 0);
      range.setEnd(endNode || container, endNode ? endOffset : 0);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) { }
  }

  // Handle paste into contenteditable: sanitize to safe minimal HTML
  handleEditorPaste(e) {
    try {
      const clipboard = e.clipboardData || window.clipboardData;
      if (!clipboard) return; // let default behavior
      const text = clipboard.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      const html = this.sanitizePastedTextToHtml(text);
      this.insertHtmlAtCaret(html);
      this.editorManager.updateCharCount();
    } catch (_) {
      // On error, allow default paste
    }
  }

  // Convert pasted plain text to safe HTML (linkify + line breaks)
  sanitizePastedTextToHtml(text) {
    const escapeHtml = (s) => (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&#34;')
      .replace(/'/g, '&#39;');

    // Split into lines and escape first
    const raw = (text || '').replace(/\r\n?/g, '\n');
    const lines = raw.split('\n').map(escapeHtml);
    // Linkify URLs and emails per line
    const urlRe = /\b(https?:\/\/[^\s<>"]+)\b/g;
    const emailRe = /\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;
    const linked = lines.map(line => {
      let out = line.replace(urlRe, (m) => `<a href="${m}" target="_blank" rel="noopener noreferrer">${m}</a>`);
      out = out.replace(emailRe, (m) => `<a href="mailto:${m}">${m}</a>`);
      return out;
    });
    return linked.join('<br>');
  }

  // Insert HTML at caret within contenteditable safely
  insertHtmlAtCaret(html) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) {
      document.execCommand('insertHTML', false, html);
      return;
    }
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const frag = range.createContextualFragment(html);
    const lastNode = frag.lastChild;
    range.insertNode(frag);
    // Move caret after inserted content
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // Build a normalized key for URL equality on the "This Page" filter and tab matching
  // - strips hash (including :~:text fragments)
  // - removes common tracking query params
  // - lowercases host and removes leading www.
  // - removes trailing slash from path (except root)
  // - sorts remaining query params for stable comparison
  normalizePageKey(u) {
    try {
      const x = new URL(u, this.currentSite ? this.currentSite.url : undefined);
      let host = (x.hostname || '').replace(/^www\./i, '').toLowerCase();
      let path = x.pathname || '/';
      if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
      // For "This Page" filter, be more flexible - just use hostname + base path
      // Remove query params and fragments for looser matching
      return `${host}${path}`;
    } catch {
      return (u || '').toString();
    }
  }

  // Wait briefly until the content script in a tab has reported readiness via background session storage
  async awaitContentReady(tabId, { timeoutMs = 3000, intervalMs = 150 } = {}) {
    const key = `pageInfo_${tabId}`;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const data = await browserAPI.storage.session.get(key);
        if (data && data[key]) return true;
      } catch (_) { /* no-op */ }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    return false;
  }

  // Handle clicking links inside the editor contenteditable
  handleEditorLinkClick(e) {
    const target = e.target;
    if (target && target.tagName === 'A') {
      e.preventDefault();
      e.stopPropagation(); // Prevent contenteditable from handling the click
      const href = target.getAttribute('href');
      const text = target.textContent || '';
      this.openLinkAndHighlight(href, text);
      return false; // Additional prevention of event propagation
    }
  }

  async openLinkAndHighlight(href, text) {
    try {
      const baseUrl = (this.currentNote && this.currentNote.url) || (this.currentSite && this.currentSite.url) || undefined;
      let absoluteHref = href;
      try {
        // Resolve relative links against the current page URL when possible
        absoluteHref = baseUrl ? new URL(href, baseUrl).toString() : new URL(href).toString();
      } catch { }

      // Build a comparable key with normalization (local to this method)
      const makeKey = (u) => {
        try {
          const x = new URL(u);
          let host = x.hostname.replace(/^www\./i, '').toLowerCase();
          let path = x.pathname || '/';
          if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
          const params = new URLSearchParams(x.search);
          const deny = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'mc_eid', 'yclid', 'igshid', 'si', 'si_source', 'si_id'];
          deny.forEach(k => params.delete(k));
          const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
          const query = entries.length ? ('?' + entries.map(([k, v]) => `${k}=${v}`).join('&')) : '';
          return `${host}${path}${query}`;
        } catch {
          return u;
        }
      };
      const targetKey = makeKey(absoluteHref);

      const tabs = await browserAPI.tabs.query({ currentWindow: true });
      let targetTab = tabs.find(t => makeKey(t.url) === targetKey);

      // For new tabs, try to include a text fragment to encourage native highlight
      const addTextFragment = (u, txt) => {
        if (!txt) return u;
        try {
          const urlObj = new URL(u);
          const enc = encodeURIComponent(txt.trim()).slice(0, 500);
          const hash = urlObj.hash || '';

          // If hash already contains :~:text, don't add another one
          if (hash.includes(':~:text=')) {
            return u;
          }

          // Compose new hash preserving existing hash if present
          const baseHash = hash.replace(/^#/, '');
          const newHash = baseHash
            ? `${baseHash}#:~:text=${enc}`  // Text fragments use # separator
            : `:~:text=${enc}`;
          urlObj.hash = `#${newHash}`;
          return urlObj.toString();
        } catch (error) {
          return u;
        }
      };



      if (!targetTab) {
        const urlToOpen = addTextFragment(absoluteHref, text);
        targetTab = await browserAPI.tabs.create({ url: urlToOpen, active: true });
        // Wait for content script to be ready, then highlight
        await this.awaitContentReady(targetTab.id, { timeoutMs: 4000, intervalMs: 200 });
        browserAPI.tabs.sendMessage(targetTab.id, { action: 'highlightText', href: urlToOpen, text }).catch(() => { });
      } else {
        // If already on the same page, do not reload the page. Just activate and request highlight.
        await browserAPI.tabs.update(targetTab.id, { active: true });
        browserAPI.tabs.sendMessage(targetTab.id, { action: 'highlightText', href: absoluteHref, text }).catch(() => { });
      }
    } catch (err) {
      // Fallback: open normally
      try {
        window.open(href, '_blank', 'noopener,noreferrer');
      } catch (fallbackError) {
        // Even fallback failed
      }
    }
  }

  // Open a domain's homepage using existing tab reuse and highlight logic
  async openDomainHomepage(domain) {
    try {
      const url = `https://${domain}/`;
      await this.openLinkAndHighlight(url, '');
    } catch (e) {
      // Fallback open; openLinkAndHighlight already attempts a safe open
      window.open(`https://${domain}/`, '_blank', 'noopener,noreferrer');
    }
  }

  // Check if user can create a new note (note limit for free users)
  async checkNoteLimitBeforeCreate() {
    const FREE_NOTE_LIMIT = 50;

    // Check if user is premium
    const isPremium = this.premiumStatus?.isPremium || false;

    // Premium users have no limit
    if (isPremium) {
      return true;
    }

    // Count current notes (use allNotes which is already loaded)
    const currentNoteCount = this.allNotes ? this.allNotes.length : 0;

    // Check if user has reached the limit
    if (currentNoteCount >= FREE_NOTE_LIMIT) {
      // Show upgrade prompt
      this.showNoteLimitUpgradePrompt(currentNoteCount, FREE_NOTE_LIMIT);
      return false;
    }

    // Show warning when approaching limit (at 45 notes)
    if (currentNoteCount === 45) {
      Utils.showToast(`You have ${FREE_NOTE_LIMIT - currentNoteCount} notes left on the free plan`, 'warning');
    }

    return true;
  }

  // Show upgrade prompt when note limit is reached
  showNoteLimitUpgradePrompt(currentCount, limit) {
    // Sanitize limit to ensure it's a safe number
    const safeLimit = parseInt(limit) || 50;

    // Use the dialog system for a more prominent message
    if (this.dialog) {
      // Create XSS-safe message using textContent (the dialog uses textContent internally)
      const safeMessage = `📝 Note Limit Reached\n\nYou've reached the free plan limit of ${safeLimit} notes. Upgrade to Premium for unlimited notes, cloud sync, and more!`;

      this.dialog.show(safeMessage).then((confirmed) => {
        if (confirmed) {
          // Open settings to show upgrade options
          this.settingsManager.openSettings();
          // Show a helpful message
          setTimeout(() => {
            Utils.showToast('Sign in and upgrade to Premium for unlimited notes', 'info');
          }, 500);
        }
      });
    } else {
      // Fallback to toast if dialog not available (Utils.showToast is XSS safe)
      Utils.showToast(`Note limit reached (${safeLimit} max). Upgrade to Premium for unlimited notes!`, 'warning');
      // Open settings after a delay
      setTimeout(() => {
        this.settingsManager.openSettings();
      }, 2000);
    }
  }

  // Create a new note (hybrid - always save both domain and URL)
  async createNewNote() {
    // Check note limit before creating new note
    const canCreate = await this.checkNoteLimitBeforeCreate();
    if (!canCreate) {
      return; // User hit the limit, prompt was shown
    }

    this.isJotMode = false;

    // Clear current note and any existing drafts to prevent contamination
    this.currentNote = null;
    // Clear any existing drafts but preserve editor open state
    await this.clearEditorState();

    // Clear any stored drafts
    if (window.notesStorage && window.notesStorage.clearEditorDraft) {
      try {
        // Clear all drafts to ensure clean state
        window.notesStorage.clearAllEditorDrafts();
      } catch (error) {
        console.warn('Failed to clear editor drafts:', error);
      }
    }

    // Clear editor inputs directly
    const titleInput = document.getElementById('noteTitleHeader');
    const contentInput = document.getElementById('noteContentInput');
    const tagsInput = document.getElementById('tagsInput');

    if (titleInput) titleInput.value = '';
    if (contentInput) {
      if (window.safeDOM) {
        window.safeDOM.clearContent(contentInput);
      } else {
        contentInput.innerHTML = '';
      }
    }
    if (tagsInput) tagsInput.value = '';

    let noteContext;

    // Check if we have a valid currentSite context
    if (!this.currentSite || !this.currentSite.domain) {
      // Note: Removed verbose logging for cleaner console
      // Create a general note when no site context is available
      noteContext = {
        domain: 'general',
        url: 'about:addons', // Firefox uses about:addons instead of chrome://extensions
        title: 'General Note'
      };
    } else {
      noteContext = this.currentSite;
    }

    const newNote = {
      id: this.generateId(),
      title: '',
      content: '',
      tags: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      domain: noteContext.domain,
      url: noteContext.url,
      pageTitle: noteContext.title
    };

    this.currentNote = newNote;
    this.openEditor();
  }


  // Open existing note
  async openNote(note) {
    // Create a deep copy to avoid reference issues
    this.currentNote = JSON.parse(JSON.stringify(note));

    // CRITICAL FIX: Clear ALL cached editor state to prevent caching issues
    // This ensures no draft from a previous note contaminates the new note
    if (this.editorState) {
      this.editorState.noteDraft = null;
      this.editorState.open = false;
    }

    // Clear any stored drafts for this note
    if (window.notesStorage && window.notesStorage.clearEditorDraft) {
      try {
        await window.notesStorage.clearEditorDraft(note.id);
      } catch (error) {
        console.warn('Failed to clear editor draft:', error);
      }
    }

    // Additional safety: Clear any existing editor state from storage
    // This prevents drafts from previous notes from appearing
    try {
      const { editorState } = await browserAPI.storage.local.get(['editorState']);
      if (editorState && editorState.noteDraft) {
        // Only clear if the draft is for a different note or different domain
        if (editorState.noteDraft.id !== note.id || editorState.noteDraft.domain !== note.domain) {
          console.log('Clearing editor state for different note/domain:', {
            draftId: editorState.noteDraft.id,
            draftDomain: editorState.noteDraft.domain,
            noteId: note.id,
            noteDomain: note.domain
          });
          await browserAPI.storage.local.remove('editorState');
        }
      }
    } catch (error) {
      console.warn('Failed to check/clear editor state:', error);
    }

    await this.openEditor(false);
  }

  // Open the note editor
  async openEditor(focusContent = false) {

    const editor = document.getElementById('noteEditor');
    const titleHeader = document.getElementById('noteTitleHeader');
    const contentInput = document.getElementById('noteContentInput');
    const tagsInput = document.getElementById('tagsInput');
    const dateSpan = document.getElementById('noteDate');
    const aiRewriteBtn = document.getElementById('aiRewriteBtn');

    // First, try to restore from cached draft
    const draftWasRestored = await this.restoreEditorDraft();

    // Populate editor with note data (only skip if we restored a draft for this exact note)
    if (!draftWasRestored) {
      // Always populate when no draft was restored (clears any stale form data)
      titleHeader.value = this.currentNote.title || '';
      const safeContent = this.buildContentHtml(this.currentNote.content || '');
      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(contentInput, safeContent, true);
      } else {
        contentInput.innerHTML = safeContent;
      }
      tagsInput.value = (this.currentNote.tags || []).join(', ');
    }
    // Do not show created date inside the editor UI to avoid mid-editor clutter
    if (dateSpan) {
      dateSpan.textContent = '';
      dateSpan.style.display = 'none';
    }

    // Show premium features - use robust premium checking
    try {
      // Use cached premium status instead of direct calls
      const premiumStatus = await getPremiumStatus();
      const isPremium = premiumStatus.isPremium;

      // Note: Removed verbose logging for cleaner console

      // Temporarily show AI rewrite button for all users
      aiRewriteBtn.style.display = 'flex';

      // Also update the overall premium UI to ensure consistency
      try {
        await this.updatePremiumUI();
      } catch (error) {
        console.warn('Failed to update premium UI in openEditor:', error);
      }
    } catch (error) {
      console.error('Premium check failed in openEditor:', error);
      // Hide AI button on error
      aiRewriteBtn.style.display = 'none';
    }

    // Show editor with animation and persistent state
    editor.style.display = 'flex';
    editor.classList.add('open', 'slide-in', 'editor-fade-in');
    // Mark editor as open but don't save draft yet (wait for user changes)
    this.persistEditorOpen(true);



    // Only save draft if we didn't restore one (to avoid overwriting restored content)
    if (!draftWasRestored && !this._isApplyingAIRewrite) {
      // Save initial state as draft
      setTimeout(() => {
        if (!this._isApplyingAIRewrite) {
          this.saveEditorDraft();
        }
      }, 100);
    }

    // Focus appropriately and try to restore caret from cached draft (if present)
    setTimeout(() => {
      const focusContentNow = (focusContent || this.isJotMode);
      if (focusContentNow) {
        contentInput.focus();
      } else {
        titleHeader.focus();
      }
      // Attempt to restore caret from editorState
      try {
        browserAPI.storage.local.get(['editorState']).then(({ editorState }) => {
          if (!editorState || !editorState.noteDraft) return;
          const d = editorState.noteDraft;
          if (d.id === this.currentNote.id && typeof d.caretStart === 'number' && typeof d.caretEnd === 'number') {
            // Ensure content area is focused before restoring selection
            contentInput.focus();
            this.setSelectionOffsets(contentInput, d.caretStart, d.caretEnd);
          }
        }).catch(() => { });
      } catch (_) { }
    }, 120);

    // Note: updateCharCount method doesn't exist in editorManager
  }

  // Close the note editor
  async closeEditor(options = { clearDraft: false }) {
    const editor = document.getElementById('noteEditor');

    // Always save draft before closing (unless explicitly clearing or during AI rewrite)
    if (!options.clearDraft && this.currentNote && !this._isApplyingAIRewrite) {
      try {
        // Save the current editor content as a draft (don't modify currentNote)
        await this.saveEditorDraft();
        // Note: Removed verbose logging for cleaner console
      } catch (error) {
        console.error('Failed to save editor draft:', error);
      }
    }

    editor.classList.add('slide-out');

    setTimeout(() => {
      editor.style.display = 'none';
      editor.classList.remove('open', 'slide-in', 'slide-out', 'editor-fade-in');
      // If requested, clear cached draft; otherwise keep cached but mark not open
      if (options && options.clearDraft) {
        this.clearEditorState();
        // Only when explicitly clearing the draft do we drop currentNote reference
        this.currentNote = null;
      } else {
        // Mark editor as not open but keep draft cached
        this.persistEditorOpen(false);
      }
    }, 240);
  }



  // Save current note
  async saveCurrentNote(optionsOrAutosave = false) {
    const opts = typeof optionsOrAutosave === 'object' ? optionsOrAutosave : {
      clearDraftAfterSave: true,
      closeEditorAfterSave: true,
      showToast: !optionsOrAutosave, // if autosave boolean passed true, suppress toast
      switchFilterAfterSave: false // Keep current filter instead of switching to page
    };
    if (!this.currentNote) {
      Utils.showToast('No note to save', 'info');
      return;
    }

    // Wait for any pending draft saves to ensure we have the latest content
    if (!this._isApplyingAIRewrite) {
      await this.flushDraftSave();
    }

    // Grab editor fields
    const titleHeader = document.getElementById('noteTitleHeader');
    const contentInput = document.getElementById('noteContentInput');
    const tagsInput = document.getElementById('tagsInput');

    // Update note data from editor
    this.currentNote.title = (titleHeader && titleHeader.value ? titleHeader.value : '').trim();
    // Convert editor HTML back to markdown/plain text for storage
    this.currentNote.content = this.htmlToMarkdown(contentInput ? contentInput.innerHTML : '');
    this.currentNote.tags = (tagsInput && tagsInput.value
      ? tagsInput.value.split(',').map(tag => tag.trim()).filter(tag => tag.length > 0)
      : []);
    this.currentNote.updatedAt = new Date().toISOString();

    // CRITICAL FIX: Don't update URL and page title from currentSite
    // This was causing existing notes to change their URL/pageTitle when saved from different sites
    // The note should preserve its original URL and pageTitle

    // Don't save empty notes (title, content, and tags all empty)
    const isTitleEmpty = !this.currentNote.title;
    const isContentEmpty = (this.currentNote.content || '').trim() === '';
    const areTagsEmpty = (this.currentNote.tags || []).length === 0;
    if (isTitleEmpty && isContentEmpty && areTagsEmpty) {
      try { await this.editorManager.clearEditorState(); } catch (_) { }
      try { await this.editorManager.persistEditorOpen(false); } catch (_) { }
      this.editorManager.closeEditor({ clearDraft: true });
      return;
    }

    // Save note using storage manager (IndexedDB or Chrome storage)
    await this.storageManager.saveNote(this.currentNote);

    // Refresh notes list from storage to ensure consistency
    await this.loadNotes();

    try {
      // Show "Note Saved" popup
      this.showNoteSavedPopup('Note saved locally');

      // NO automatic sync - notes are saved locally only
      // Sync will happen on timer (every 5 minutes) or manual button press

      // Check for user engagement opportunities after successful save
      if (this.userEngagement) {
        this.userEngagement.checkAndShowPrompt().catch(() => { });
      }

    } catch (error) {
      console.error('Save failed:', error);
      this.showNoteSavedPopup('Save failed', 'error');
    }

    // Clear draft and/or close according to options
    if (opts.closeEditorAfterSave) {
      this.editorManager.closeEditor({ clearDraft: !!opts.clearDraftAfterSave });
    } else if (opts.clearDraftAfterSave) {
      await this.editorManager.clearEditorState();
    } else {
      // Persist editor open false since we're leaving editor via back
      await this.editorManager.persistEditorOpen(false);
    }

    if (opts.switchFilterAfterSave) {
      // After saving, switch to This Page filter
      this.switchFilter('page');
      // Re-render from memory (switchFilter already renders)
      Utils.checkStorageQuota();
    } else {
      // Re-render to show the saved note while keeping current filter
      this.render();
    }
  }

  // Unified note saved notification using premium glassmorphism toast
  showNoteSavedPopup(message, type = 'saved') {
    // Convert custom popup types to standard toast types
    let toastType = 'success';

    switch (type) {
      case 'sync':
        toastType = 'warning'; // Orange for syncing in progress
        break;
      case 'synced':
        toastType = 'success'; // Green for successful sync
        break;
      case 'sync-error':
        toastType = 'error'; // Red for sync errors
        break;
      case 'error':
        toastType = 'error';
        break;
      default:
        toastType = 'success'; // Default saved state
        break;
    }

    // Use the unified premium glassmorphism toast system
    Utils.showToast(message, toastType);
  }

  // Delete current note (from editor)
  async deleteCurrentNote() {
    if (!this.currentNote) {
      Utils.showToast('No note to delete', 'info');
      return;
    }

    // If it's a new, unsaved note, just close the editor
    const isNewNote = !this.allNotes.some(n => n.id === this.currentNote.id);
    if (isNewNote) {
      this.editorManager.closeEditor();
      return;
    }

    const confirmed = await this.dialog.show(`Delete "${this.currentNote.title || 'Untitled'}"?`);
    if (!confirmed) {
      return;
    }

    // Delete note using storage manager
    await this.storageManager.deleteNote(this.currentNote.id);

    // Refresh notes list from storage to ensure consistency
    await this.loadNotes();

    Utils.showToast('Note deleted', 'success');
    // Clear draft cache and close editor
    this.editorManager.closeEditor({ clearDraft: true });
    await this.postDeleteRefresh();
  }

  // Export current note (from editor) - defaults to TXT format
  async exportCurrentNote() {
    if (!this.currentNote) {
      Utils.showToast('No note to export', 'info');
      return;
    }

    try {
      // Create a single note export data structure
      const singleNoteData = {
        [this.currentNote.domain]: [this.currentNote]
      };

      // Use TXT format for single note export
      const exportFormats = new ExportFormats();
      const exportResult = exportFormats.exportToFormat(singleNoteData, 'txt', true);

      // Create and download file
      const blob = new Blob([exportResult.content], { type: exportResult.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = exportResult.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Show success message
      Utils.showToast('Note exported as Plain Text', 'success');
    } catch (error) {
      console.error('Error exporting note:', error);
      Utils.showToast('Failed to export note', 'error');
    }
  }

  // Delete note from list (with confirmation)
  async deleteNoteFromList(noteId, skipConfirm = false) {
    const note = this.allNotes.find(n => n.id === noteId);
    if (!note) return;

    // This function is now only called directly when confirmed, so no need for dialog.
    // The inline confirmation is handled by the click listener in `createNoteElement`.

    // Delete note using storage manager
    await this.storageManager.deleteNote(noteId);

    // Clear draft if the deleted note is currently in the editor or draft
    if (this.currentNote && this.currentNote.id === noteId) {
      // If the deleted note is currently open in editor, close editor and clear draft
      this.editorManager.closeEditor({ clearDraft: true });
    } else {
      // Check if there's a draft for this note and clear it
      try {
        const { editorState } = await browserAPI.storage.local.get(['editorState']);
        if (editorState && editorState.noteDraft && editorState.noteDraft.id === noteId) {
          await browserAPI.storage.local.remove('editorState');
          console.log('Cleared draft for deleted note:', noteId);
        }
      } catch (error) {
        console.warn('Error checking/clearing draft for deleted note:', error);
      }
    }

    // Refresh notes list from storage to ensure consistency
    await this.loadNotes();

    Utils.showToast('Note deleted', 'success');
    await this.postDeleteRefresh();
  }

  // Standardized inline confirmation UI
  showInlineConfirm(parent, onConfirm) {
    // Remove any other open confirmations
    const existingConfirm = document.querySelector('.inline-confirm');
    if (existingConfirm) {
      existingConfirm.remove();
    }

    const confirmUI = document.createElement('div');
    confirmUI.className = 'inline-confirm';
    const confirmHtml = `
      <span>Delete?</span>
      <button class="confirm-yes">Confirm</button>
      <button class="confirm-no">Cancel</button>
    `;

    if (window.safeDOM) {
      window.safeDOM.setInnerHTML(confirmUI, confirmHtml, false);
    } else {
      confirmUI.innerHTML = confirmHtml;
    }

    parent.appendChild(confirmUI);

    confirmUI.querySelector('.confirm-yes').addEventListener('click', (e) => {
      e.stopPropagation();
      onConfirm();
      confirmUI.remove();
    });

    confirmUI.querySelector('.confirm-no').addEventListener('click', (e) => {
      e.stopPropagation();
      confirmUI.remove();
    });
  }

  // Persist editor open flag (and keep existing noteDraft intact)
  async persistEditorOpen(isOpen) {
    try {
      const { editorState } = await browserAPI.storage.local.get(['editorState']);
      const state = editorState || {};
      state.open = !!isOpen;

      if (isOpen) {
        // Set wasEditorOpen flag to true when editor is opened by user
        // This helps distinguish between popup opening and actual editor opening
        state.wasEditorOpen = true;
      } else {
        // Clear wasEditorOpen flag when editor is closed by user
        // This ensures we don't auto-open on next popup open
        state.wasEditorOpen = false;
      }

      await browserAPI.storage.local.set({ editorState: state });
    } catch (_) { }
  }

  // Save AI rewritten content immediately (bypasses AI rewrite flag check)
  async saveAIRewrittenContent() {
    try {
      if (!this.currentNote) {
        return;
      }

      // Ensure we have valid DOM elements before proceeding
      const titleHeader = document.getElementById('noteTitleHeader');
      const contentInput = document.getElementById('noteContentInput');
      const tagsInput = document.getElementById('tagsInput');

      if (!titleHeader || !contentInput || !tagsInput) {
        return;
      }

      // Capture caret in content area
      let caretStart = 0, caretEnd = 0;
      try {
        if (contentInput) {
          const pos = this.getSelectionOffsets(contentInput);
          caretStart = pos.start;
          caretEnd = pos.end;
        }
      } catch (_) { }

      const currentContent = this.htmlToMarkdown(contentInput ? contentInput.innerHTML : '');

      const draft = {
        id: this.currentNote.id,
        title: (titleHeader && titleHeader.value) || '',
        content: currentContent,
        tags: (tagsInput && tagsInput.value
          ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
          : []),
        createdAt: this.currentNote.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        domain: this.currentNote.domain,
        url: this.currentNote.url,
        pageTitle: this.currentNote.pageTitle
      };

      const { editorState } = await browserAPI.storage.local.get(['editorState']);
      const state = editorState || {};
      state.noteDraft = draft;
      state.caretStart = caretStart;
      state.caretEnd = caretEnd;

      await browserAPI.storage.local.set({ editorState: state });
    } catch (error) {
      console.error('❌ Failed to save AI rewritten content:', error);
    }
  }

  // Save the current editor draft (title/content/tags) into storage
  async saveEditorDraft() {
    try {
      if (!this.currentNote) {
        return;
      }

      // Skip draft saving during AI rewrite operations to prevent content reset
      if (this._isApplyingAIRewrite) {
        return;
      }

      // Be extra careful if AI rewrite just completed
      if (this._aiRewriteJustCompleted) {
        // Add a small delay to ensure DOM is stable
        await new Promise(resolve => setTimeout(resolve, 100));
      }



      // Ensure we have valid DOM elements before proceeding
      const titleHeader = document.getElementById('noteTitleHeader');
      const contentInput = document.getElementById('noteContentInput');
      const tagsInput = document.getElementById('tagsInput');

      if (!titleHeader || !contentInput || !tagsInput) {
        console.log('Skipping draft save - editor elements not available');
        return;
      }
      // Capture caret in content area
      let caretStart = 0, caretEnd = 0;
      try {
        if (contentInput) {
          const pos = this.getSelectionOffsets(contentInput);
          caretStart = pos.start;
          caretEnd = pos.end;
        }
      } catch (_) { }

      const currentContent = this.htmlToMarkdown(contentInput ? contentInput.innerHTML : '');

      // Safeguard: Don't save if content is empty and we had content before
      const { editorState: existingState } = await browserAPI.storage.local.get(['editorState']);
      if (existingState && existingState.noteDraft && existingState.noteDraft.content &&
        existingState.noteDraft.content.trim() && !currentContent.trim()) {
        return;
      }

      const draft = {
        id: this.currentNote.id,
        title: (titleHeader && titleHeader.value) || '',
        content: currentContent,
        tags: (tagsInput && tagsInput.value
          ? tagsInput.value.split(',').map(t => t.trim()).filter(Boolean)
          : []),
        createdAt: this.currentNote.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        // CRITICAL FIX: Always preserve the original note's domain and URL
        // Don't use currentSite domain/URL as it can change when editing from different sites
        domain: this.currentNote.domain,
        url: this.currentNote.url,
        pageTitle: this.currentNote.pageTitle,
        caretStart,
        caretEnd
      };

      // Preserve existing editorState (including wasEditorOpen flag and open state) when saving draft
      const updatedState = {
        ...existingState,
        noteDraft: draft
      };
      await browserAPI.storage.local.set({ editorState: updatedState });
    } catch (error) {
      console.error('Failed to save editor draft:', error);
    }
  }

  // NEW: Clean up old drafts to prevent unwanted auto-opening
  async cleanupOldDrafts() {
    try {
      const { editorState } = await browserAPI.storage.local.get(['editorState']);
      if (editorState && editorState.noteDraft) {
        const now = Date.now();
        const draftTime = editorState.noteDraft.updatedAt ? new Date(editorState.noteDraft.updatedAt).getTime() : 0;
        const timeDiff = now - draftTime;
        const tenMinutes = 10 * 60 * 1000; // 10 minutes in milliseconds

        if (timeDiff > tenMinutes) {
          await browserAPI.storage.local.remove('editorState');
        }
      }
    } catch (error) {
      console.warn('Failed to cleanup old drafts:', error);
    }
  }

  // Restore editor draft from storage
  async restoreEditorDraft() {
    try {
      // Skip draft restoration during AI rewrite operations
      if (this._isApplyingAIRewrite) {
        return false;
      }

      const { editorState } = await browserAPI.storage.local.get(['editorState']);

      if (!editorState || !editorState.noteDraft) {
        return false;
      }

      const draft = editorState.noteDraft;

      // Context 1: Auto-restore when no current note (popup just opened)
      if (!this.currentNote) {


        // Set the draft as current note
        this.currentNote = { ...draft };

        // Populate form fields with draft content
        const titleHeader = document.getElementById('noteTitleHeader');
        const contentInput = document.getElementById('noteContentInput');
        const tagsInput = document.getElementById('tagsInput');

        if (titleHeader) titleHeader.value = draft.title || '';
        if (contentInput) {
          const safeContent = this.buildContentHtml(draft.content || '');
          if (window.safeDOM) {
            window.safeDOM.setInnerHTML(contentInput, safeContent, true);
          } else {
            contentInput.innerHTML = safeContent;
          }
        }
        if (tagsInput) tagsInput.value = (draft.tags || []).join(', ');

        return true; // Draft was restored
      }

      // Context 2: Note switching - only restore if it's for the same note
      if (draft.id === this.currentNote.id) {


        // Update currentNote with draft content
        this.currentNote = { ...draft };

        // Populate form fields with draft content
        const titleHeader = document.getElementById('noteTitleHeader');
        const contentInput = document.getElementById('noteContentInput');
        const tagsInput = document.getElementById('tagsInput');

        if (titleHeader) titleHeader.value = draft.title || '';
        if (contentInput) {
          const safeContent = this.buildContentHtml(draft.content || '');
          if (window.safeDOM) {
            window.safeDOM.setInnerHTML(contentInput, safeContent, true);
          } else {
            contentInput.innerHTML = safeContent;
          }
        }
        if (tagsInput) tagsInput.value = (draft.tags || []).join(', ');

        return true; // Draft was restored
      } else {
        // Clear draft if it's from a different note to prevent contamination
        console.log('Clearing draft from different note:', {
          draftId: draft.id,
          currentNoteId: this.currentNote.id
        });
        await this.clearEditorState();
        return false; // No draft restored
      }
    } catch (error) {
      console.error('Error in restoreEditorDraft:', error);
      return false;
    }
  }

  // Clear editor state entirely
  async clearEditorState() {
    try {
      await browserAPI.storage.local.remove('editorState');
    } catch (_) { }
  }

  // Delete all notes for a specific domain
  async deleteNotesByDomain(domain, confirmed = false) {
    if (!confirmed) {
      const notesForDomainCount = this.allNotes.filter(note => note.domain === domain).length;
      const userConfirmed = await this.dialog.show(`Are you sure you want to delete all ${notesForDomainCount} notes for ${domain}? This cannot be undone.`);
      if (!userConfirmed) return;
    }

    // Delete notes using storage manager
    await this.storageManager.deleteNotesByDomain(domain);

    // Clear draft if it belongs to the deleted domain
    if (this.currentNote && this.currentNote.domain === domain) {
      // If the current note belongs to the deleted domain, close editor and clear draft
      this.editorManager.closeEditor({ clearDraft: true });
    } else {
      // Check if there's a draft for this domain and clear it
      try {
        const { editorState } = await browserAPI.storage.local.get(['editorState']);
        if (editorState && editorState.noteDraft && editorState.noteDraft.domain === domain) {
          await browserAPI.storage.local.remove('editorState');
          console.log('Cleared draft for deleted domain:', domain);
        }
      } catch (error) {
        console.warn('Error checking/clearing draft for deleted domain:', error);
      }
    }

    // Refresh notes list from storage to ensure consistency
    await this.loadNotes();

    await this.postDeleteRefresh();
    Utils.showToast(`Deleted all notes for ${domain}`, 'success');
  }

  // After any deletion, optionally clear the search if it would show an empty list, then render
  async postDeleteRefresh() {
    // Compute what would be visible with current filter + search
    let filtered = [];
    if (this.filterMode === 'site') {
      // Only filter by site if we have a valid currentSite with domain
      if (this.currentSite && this.currentSite.domain && this.currentSite.domain !== 'localhost') {
        filtered = this.allNotes.filter(n => n.domain === this.currentSite.domain);
      } else {
        // If no valid currentSite, show all notes instead of filtering to empty
        filtered = this.allNotes;
      }
    } else if (this.filterMode === 'page') {
      // Only filter by page if we have a valid currentSite with URL
      if (this.currentSite && this.currentSite.url && this.currentSite.url !== 'http://localhost') {
        const currentKey = this.normalizePageKey(this.currentSite.url);
        filtered = this.allNotes.filter(n => this.normalizePageKey(n.url) === currentKey);
      } else {
        // If no valid currentSite URL, show all notes instead of filtering to empty
        filtered = this.allNotes;
      }
    } else {
      filtered = this.allNotes;
    }

    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.map(n => {
        let score = 0;
        if (n.domain && n.domain.toLowerCase().includes(q)) score += 4;
        if ((n.title || '').toLowerCase().includes(q)) score += 3;
        if ((n.tags || []).some(tag => (tag || '').toLowerCase().includes(q))) score += 2;
        if ((n.content || '').toLowerCase().includes(q)) score += 1;
        return { n, score };
      }).filter(it => it.score > 0).map(it => it.n);
    }

    if (this.searchQuery && filtered.length === 0) {
      // Clear query and input field
      this.searchQuery = '';
      const input = document.getElementById('searchInput') || document.querySelector('.search-input');
      if (input) input.value = '';
      // Also clear the search query from storage
      try { browserAPI.storage.local.remove('lastSearchQuery'); } catch (_) { }
    }

    this.render();
  }


  // AI Rewrite (placeholder)
  aiRewrite() {
    Utils.showToast('AI Rewrite coming soon!', 'info');
  }

  async updatePremiumUI() {
    try {
      // Use cached premium status instead of direct calls
      const premiumStatus = await getPremiumStatus();
      const isPremium = premiumStatus.isPremium;

      // Update the instance property so version history button can access it
      this.premiumStatus = premiumStatus;

      // AI button visibility - temporarily show for all users
      const aiBtn = document.getElementById('aiRewriteBtn');
      if (aiBtn) {
        aiBtn.style.display = 'flex'; // Show for all users temporarily
      }

      // AI Summary button visibility - temporarily show for all users
      const aiSummaryBtn = document.getElementById('aiSummaryBtn');
      if (aiSummaryBtn) {
        aiSummaryBtn.style.display = 'flex'; // Show for all users temporarily
      } else {
        console.warn('updatePremiumUI: AI Summary button not found');
      }

      // Ads container visibility
      const ad = document.getElementById('adContainer');
      if (ad) {
        ad.style.display = isPremium ? 'none' : 'block';
      }

      // Always allow All Notes view
      const allNotesBtn = document.getElementById('showAllNotesBtn');
      if (allNotesBtn) {
        allNotesBtn.classList.remove('premium-feature');
        allNotesBtn.disabled = false;
        allNotesBtn.title = 'View all notes';
      }
    } catch (error) {
      console.error('updatePremiumUI failed:', error);
      // Hide premium features if check fails
      const aiBtn = document.getElementById('aiRewriteBtn');
      if (aiBtn) aiBtn.style.display = 'none';

      const aiSummaryBtn = document.getElementById('aiSummaryBtn');
      if (aiSummaryBtn) {
        aiSummaryBtn.style.display = 'flex'; // Show for all users temporarily
      } else {
        console.warn('updatePremiumUI error handler: AI Summary button not found');
      }

      const ad = document.getElementById('adContainer');
      if (ad) ad.style.display = 'block';
    }
  }

  // Handle paste events in editor
  handleEditorPaste(e) {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    const sanitizedText = Utils.sanitizeHtml(text);
    document.execCommand('insertText', false, sanitizedText);
  }

  // Handle link clicks in editor (legacy method - should use the main handleEditorLinkClick)
  handleEditorLinkClick_legacy(e) {
    if (e.target.tagName === 'A') {
      e.preventDefault();
      e.stopPropagation(); // Prevent contenteditable from handling the click
      const url = e.target.href;

      // Check if the URL is already open in a tab (flexible matching)
      browserAPI.tabs.query({}, (tabs) => {
        const targetUrl = new URL(url);
        const existingTab = tabs.find(tab => {
          if (!tab.url) return false;
          try {
            const tabUrl = new URL(tab.url);
            // Match by hostname and pathname, ignore query params and fragments
            return tabUrl.hostname === targetUrl.hostname &&
              tabUrl.pathname === targetUrl.pathname;
          } catch {
            return false;
          }
        });

        if (existingTab) {
          // Switch to existing tab and highlight text
          browserAPI.tabs.update(existingTab.id, { active: true });
          browserAPI.tabs.sendMessage(existingTab.id, {
            action: 'highlightText',
            text: e.target.textContent,
            href: url
          }).catch(() => { });
        } else {
          // Create new tab
          browserAPI.tabs.create({ url: url });
        }
      });
      return false; // Additional prevention of event propagation
    }
  }

  // Save font setting
  async saveFontSetting(fontFamily) {
    try {
      await browserAPI.storage.local.set({ fontFamily });
      document.body.style.fontFamily = fontFamily;
      Utils.showToast('Font updated', 'success');
    } catch (error) {
      Utils.showToast('Failed to save font setting', 'error');
    }
  }

  // AI rewrite functionality
  async aiRewrite() {
    // Check if we have a current note (including drafts)
    if (!this.currentNote) {
      Utils.showToast('Open or create a note to use AI Rewrite', 'info');
      return;
    }

    // Check if note has content (either saved or draft)
    // Get content from editor inputs first (for drafts), then fall back to note data
    const noteContentInput = document.getElementById('noteContentInput');
    const noteTitleHeader = document.getElementById('noteTitleHeader');

    // Fix: For contenteditable elements, use innerHTML to preserve links and formatting
    // This is important for maintaining clickable links generated from context menu
    const draftContent = noteContentInput ? (noteContentInput.innerHTML || '') : '';
    const draftTitle = noteTitleHeader ? (noteTitleHeader.value || '') : '';

    const hasContent = draftContent.trim() ||
      draftTitle.trim() ||
      this.currentNote?.content ||
      this.currentNote?.title;

    if (!hasContent) {
      Utils.showToast('Add some content to your note first to use AI Rewrite', 'info');
      return;
    }

    // Check if user is authenticated (required for usage tracking)
    if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
      Utils.showToast('Sign in to use AI Rewrite - Free users get 30 rewrites per month!', 'info');
      // Optionally open settings to guide them to sign up
      setTimeout(() => {
        this.showSettings();
      }, 2000); // Show settings after 2 seconds
      return;
    }

    // Check if free user has any AI calls remaining
    const isPremium = await this.checkPremiumStatus();
    if (!isPremium) {
      const currentUsage = await this.getCurrentAIUsage();
      if (currentUsage && currentUsage.remainingCalls <= 0) {
        Utils.showToast('You\'ve used all 30 free AI rewrites this month! Upgrade for unlimited access', 'info');
        return;
      }
    }

    // Toggle dropdown instead of showing dialog - wait for draft save to complete
    await this.toggleAIDropdown();
  }

  // Show AI rewrite dialog
  async showAIRewriteDialog() {
    const dialog = document.getElementById('aiRewriteDialog');
    if (dialog) {
      dialog.style.display = 'flex';
      this.setupAIRewriteEventListeners();

      // Load and display usage info
      await this.loadUsageInfo();
    }
  }

  // Setup AI rewrite dialog event listeners
  setupAIRewriteEventListeners() {
    // Close button
    const closeBtn = document.getElementById('aiRewriteCloseBtn');
    if (closeBtn) {
      closeBtn.onclick = () => this.hideAIRewriteDialog();
    }

    // Style selection buttons
    const styleBtns = document.querySelectorAll('.rewrite-style-btn');
    styleBtns.forEach(btn => {
      btn.onclick = (e) => this.handleStyleSelection(e.target.dataset.style);
    });

    // Try another style button
    const tryAnotherBtn = document.getElementById('tryAnotherStyleBtn');
    if (tryAnotherBtn) {
      tryAnotherBtn.onclick = () => this.showStyleSelection();
    }

    // Apply rewrite button
    const applyBtn = document.getElementById('applyRewriteBtn');
    if (applyBtn) {
      applyBtn.onclick = () => this.applyAIRewrite();
    }
  }

  // Handle style selection
  async handleStyleSelection(style) {
    // Update active button
    const styleBtns = document.querySelectorAll('.rewrite-style-btn');
    styleBtns.forEach(btn => {
      btn.classList.remove('active');
      if (btn.dataset.style === style) {
        btn.classList.add('active');
      }
    });

    // Show loading state
    this.showRewriteLoading();

    try {
      // Call AI rewrite API
      const rewrittenContent = await this.callAIRewriteAPI(this.currentNote.content, style, '');

      // Show preview
      this.showRewritePreview(rewrittenContent, style);
    } catch (error) {
      console.error('AI rewrite failed:', error);
      Utils.showToast('AI rewrite failed. Please try again.', 'error');
      this.showStyleSelection();
    }
  }

  // Show rewrite loading state
  showRewriteLoading() {
    const rewriteLoading = document.getElementById('rewriteLoading');
    document.getElementById('rewriteOptions').style.display = 'none';
    document.getElementById('rewritePreview').style.display = 'none';
    rewriteLoading.style.display = 'block';
    rewriteLoading.setAttribute('aria-busy', 'true');
  }

  // Show style selection
  showStyleSelection() {
    const rewriteLoading = document.getElementById('rewriteLoading');
    document.getElementById('rewriteOptions').style.display = 'block';
    document.getElementById('rewritePreview').style.display = 'none';
    rewriteLoading.style.display = 'none';
    rewriteLoading.setAttribute('aria-busy', 'false');
  }

  // Apply AI rewrite directly to the note
  async applyAIRewriteToNote(rewrittenContent, style) {
    // Get the content input element
    const contentInput = document.getElementById('noteContentInput');

    if (contentInput && rewrittenContent) {
      try {
        // Set flag to prevent draft saving during content update
        this._isApplyingAIRewrite = true;

        // Cancel any pending debounced saves to prevent interference
        if (this.saveDraftDebounced.cancel) {
          this.saveDraftDebounced.cancel();
        }

        // Update the current note object with AI content FIRST
        if (this.currentNote) {
          this.currentNote.content = rewrittenContent;
          this.currentNote.updatedAt = new Date().toISOString();
        }

        // Apply the rewritten content to the editor
        const htmlContent = this.buildContentHtml(rewrittenContent);

        // Set up a mutation observer to protect against content changes
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.type === 'childList' || mutation.type === 'characterData') {
              protectContent();
            }
          });
        });

        // Use safe DOM manipulation for AI rewrite content
        if (window.safeDOM) {
          window.safeDOM.setInnerHTML(contentInput, htmlContent, true);
        } else {
          contentInput.innerHTML = htmlContent;
        }

        // Set up a one-time protection against content being reverted
        let protectionActive = true;
        const protectContent = () => {
          if (!protectionActive) return;

          const currentContent = contentInput.innerHTML;
          if (currentContent !== htmlContent) {
            // Use safe DOM manipulation for protection as well
            if (window.safeDOM) {
              window.safeDOM.setInnerHTML(contentInput, htmlContent, true);
            } else {
              contentInput.innerHTML = htmlContent;
            }
          }
        };

        // Check and protect the content a few times during the critical period
        setTimeout(protectContent, 50);
        setTimeout(protectContent, 150);
        setTimeout(protectContent, 300);
        setTimeout(protectContent, 500);

        // Disable protection after 1 second
        setTimeout(() => {
          protectionActive = false;
          observer.disconnect();
        }, 1000);

        // Start observing changes
        observer.observe(contentInput, {
          childList: true,
          subtree: true,
          characterData: true
        });



        // Update character count
        this.editorManager.updateCharCount();

        // Apply generated tags if available
        if (this.generatedTags && this.generatedTags.length > 0) {
          this.applyGeneratedTags();
        }

        // Set up tag protection using the same mechanism as content protection
        const tagsInput = document.getElementById('tagsInput');
        const finalTagsValue = tagsInput ? tagsInput.value : '';
        const finalTagsArray = this.currentNote ? [...(this.currentNote.tags || [])] : [];

        const protectTags = () => {
          if (!protectionActive || !tagsInput) return;

          // If tags input was changed, reapply the correct value
          if (tagsInput.value !== finalTagsValue) {
            tagsInput.value = finalTagsValue;
          }

          // Also protect the currentNote.tags array
          if (this.currentNote && JSON.stringify(this.currentNote.tags) !== JSON.stringify(finalTagsArray)) {
            this.currentNote.tags = [...finalTagsArray];
          }
        };

        // Protect tags at the same intervals as content
        setTimeout(protectTags, 50);
        setTimeout(protectTags, 150);
        setTimeout(protectTags, 300);
        setTimeout(protectTags, 500);

        // Immediately save the AI rewritten content to prevent it from being overwritten
        await this.saveAIRewrittenContent();

        // Wait longer to ensure everything is stable before clearing flag
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        console.error('💥 Error applying AI rewrite:', error);
      } finally {
        // Always clear the flag
        this._isApplyingAIRewrite = false;
        this._aiRewriteJustCompleted = true;

        // Clear the "just completed" flag after a delay to allow proper saving
        setTimeout(() => {
          this._aiRewriteJustCompleted = false;
        }, 3000);
      }

      // Success - content applied
    } else {
      console.error('Could not apply AI rewrite: missing content input or rewritten content');
    }
  }

  // Apply generated tags to the current note
  applyGeneratedTags() {
    if (!this.generatedTags || this.generatedTags.length === 0) return;

    // Get the tags input element
    const tagsInput = document.getElementById('tagsInput');
    if (!tagsInput) return;

    // Get current tags
    const currentTags = this.currentNote.tags || [];

    // Merge generated tags with existing tags, avoiding duplicates
    const mergedTags = [...currentTags];
    this.generatedTags.forEach(tag => {
      if (!mergedTags.includes(tag)) {
        mergedTags.push(tag);
      }
    });

    // Update the tags input
    tagsInput.value = mergedTags.join(', ');

    // Update the current note object
    this.currentNote.tags = mergedTags;

    // Show notification about added tags
    const newTagsCount = this.generatedTags.length;
    const tagText = newTagsCount === 1 ? '1 new tag' : `${newTagsCount} new tags`;
    Utils.showToast(`Added ${tagText} to your note`, 'success');

    // Clear generated tags after applying
    this.generatedTags = [];
  }

  // Hide AI rewrite dialog
  hideAIRewriteDialog() {
    const dialog = document.getElementById('aiRewriteDialog');
    if (dialog) {
      dialog.style.display = 'none';
      // Reset state
      this.showStyleSelection();
    }
  }

  // Call AI rewrite API
  async callAIRewriteAPI(content, style, userContext = '') {
    try {
      // Check if user is authenticated
      if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
        throw new Error('User not authenticated');
      }

      // Prepare context information
      const context = {
        domain: this.currentNote.domain || 'general',
        noteTitle: this.currentNote.title || 'Untitled Note',
        userIntent: this.getUserIntentFromContent(content),
        writingStyle: this.analyzeWritingStyle(content),
        userContext: userContext, // Add user-provided context
        feature: 'rewrite' // Specify feature for usage tracking
      };

      // Get the current user and access token from custom client
      if (!window.supabaseClient.isAuthenticated()) {
        throw new Error('Please create an account to use AI Rewrite. Free users get 30 rewrites/month!');
      }

      const user = window.supabaseClient.getCurrentUser();
      if (!user) {
        throw new Error('Please create an account to use AI Rewrite. Free users get 30 rewrites/month!');
      }

      // Call our Edge Function which handles Gemini API
      const apiUrl = `${window.supabaseClient.supabaseUrl}/functions/v1/hyper-api`;
      const requestBody = {
        content: content,
        style: style,
        context: context,
        generateTags: true,
        existingTags: this.currentNote.tags || []
      };



      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${window.supabaseClient.accessToken}`,
          'apikey': window.supabaseClient.supabaseAnonKey
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        let errorData = {};
        try {
          errorData = await response.json();
        } catch (parseError) {
          console.error('AI rewrite: Failed to parse error response as JSON:', parseError);
          errorData = { error: `HTTP ${response.status}: ${response.statusText}` };
        }



        // Show user-friendly error message
        if (response.status === 401) {
          Utils.showToast('Please sign in to use AI rewrite.', 'error');
        } else if (response.status === 429) {
          Utils.showToast('Monthly AI usage limit exceeded.', 'error');
        } else if (errorData.error && errorData.error.includes('Content too large')) {
          // Extract word limit from error message if available
          const wordLimitMatch = errorData.error.match(/Maximum (\d+(?:,\d+)*) words/);
          const wordLimit = wordLimitMatch ? wordLimitMatch[1] : '15,000';
          Utils.showToast(`Your note is too long for AI rewrite. Please shorten it to under ${wordLimit} words and try again.`, 'error');
        } else {
          Utils.showToast(errorData.error || 'AI rewrite failed. Please try again.', 'error');
        }

        throw new Error(errorData.error || `AI rewrite failed with status ${response.status}`);
      }

      const data = await response.json();

      // Track local AI usage (1 credit for rewrite)
      await this.trackLocalAIUsage(1);

      // Show remaining calls info
      if (data.remainingCalls !== undefined) {
        const remainingText = data.remainingCalls === 1 ? '1 call' : `${data.remainingCalls} calls`;
        Utils.showToast(`AI rewrite complete! ${remainingText} left this month`, 'success');
      }

      // Store generated tags for later use
      if (data.generatedTags && data.generatedTags.length > 0) {
        this.generatedTags = data.generatedTags;
      }

      return data.rewrittenContent;
    } catch (error) {
      // Don't log "content too large" errors as they're user errors, not system errors
      if (!error.message.includes('Content too large')) {
      console.error('AI rewrite API call failed:', error);
      }

      // Show helpful message for authentication errors
      if (error.message.includes('create an account')) {
        Utils.showToast(error.message, 'info');
        return null;
      }

      // Don't show toast here if we already showed one in the response handling
      if (!error.message.includes('AI rewrite failed')) {
        Utils.showToast('AI rewrite failed. Using fallback processing.', 'warning');
      }

      // Fallback to simulation if API fails for other reasons
      console.log('Falling back to simulated AI rewrite');
      return this.simulateAIRewrite(content, style);
    }
  }

  // Analyze user intent from content
  getUserIntentFromContent(content) {
    const text = content.toLowerCase();

    if (text.includes('meeting') || text.includes('agenda') || text.includes('schedule')) {
      return 'Meeting/Planning';
    } else if (text.includes('research') || text.includes('study') || text.includes('learn')) {
      return 'Research/Learning';
    } else if (text.includes('idea') || text.includes('concept') || text.includes('brainstorm')) {
      return 'Ideation/Brainstorming';
    } else if (text.includes('review') || text.includes('feedback') || text.includes('evaluate')) {
      return 'Review/Feedback';
    } else if (text.includes('todo') || text.includes('task') || text.includes('action')) {
      return 'Task Management';
    } else {
      return 'General Note';
    }
  }

  // Analyze current writing style
  analyzeWritingStyle(content) {
    const text = content.toLowerCase();

    if (text.includes('i am') || text.includes('you are') || text.includes('we are')) {
      return 'Formal';
    } else if (text.includes("i'm") || text.includes("you're") || text.includes("we're")) {
      return 'Casual';
    } else if (text.includes('gonna') || text.includes('wanna') || text.includes('kinda')) {
      return 'Very Casual';
    } else if (text.includes('therefore') || text.includes('furthermore') || text.includes('consequently')) {
      return 'Academic';
    } else {
      return 'Neutral';
    }
  }

  // Simulate AI rewrite (placeholder for real AI service)
  simulateAIRewrite(content, style) {
    const transformations = {
      formal: (text) => text.replace(/\b(?:I'm|I am|you're|you are|we're|we are|they're|they are)\b/gi,
        (match) => match.toLowerCase().includes('i') ? 'I am' :
          match.toLowerCase().includes('you') ? 'you are' :
            match.toLowerCase().includes('we') ? 'we are' : 'they are'),
      casual: (text) => text.replace(/\b(?:I am|you are|we are|they are)\b/gi,
        (match) => match.toLowerCase().includes('i') ? "I'm" :
          match.toLowerCase().includes('you') ? "you're" :
            match.toLowerCase().includes('we') ? "we're" : "they're"),
      professional: (text) => text.replace(/\b(?:gonna|wanna|gotta|kinda|sorta)\b/gi,
        (match) => match === 'gonna' ? 'going to' :
          match === 'wanna' ? 'want to' :
            match === 'gotta' ? 'got to' :
              match === 'kinda' ? 'kind of' : 'sort of'),
      creative: (text) => text.replace(/\b(?:good|bad|big|small)\b/gi,
        (match) => match === 'good' ? 'excellent' :
          match === 'bad' ? 'terrible' :
            match === 'big' ? 'enormous' : 'tiny'),
      concise: (text) => text.replace(/\b(?:very|really|quite|rather|somewhat)\s+/gi, '')
    };

    const transform = transformations[style] || ((text) => text);
    return transform(content);
  }

  // Toggle AI dropdown
  async toggleAIDropdown() {
    const dropdown = document.getElementById('aiDropdownMenu');
    if (dropdown) {
      const isVisible = dropdown.classList.contains('show');

      if (isVisible) {
        this.hideAIDropdown();
      } else {
        // Flush any pending draft saves to ensure we work with current content
        if (this.currentNote && !this._isApplyingAIRewrite) {
          await this.flushDraftSave();
        }
        this.showAIDropdown();
      }
    }
  }

  // Show AI dropdown
  async showAIDropdown() {
    // Don't clear the AI rewrite flag here - let it be managed by the rewrite process

    const dropdown = document.getElementById('aiDropdownMenu');
    const trigger = document.getElementById('aiRewriteBtn');

    if (dropdown && trigger) {
      // Load usage and context info (loadUsageInfo already calls displayContextInfo)
      await this.loadUsageInfo();

      // Position dropdown relative to trigger button with better boundary checking
      const triggerRect = trigger.getBoundingClientRect();
      const dropdownWidth = 240; // Width from CSS
      const dropdownHeight = 300; // Approximate height
      const margin = 8;

      // Calculate position
      let left = triggerRect.left;
      let top = triggerRect.bottom + margin;

      // Check if dropdown would go off the right edge
      if (left + dropdownWidth > window.innerWidth) {
        left = window.innerWidth - dropdownWidth - margin;
      }

      // Check if dropdown would go off the left edge
      if (left < margin) {
        left = margin;
      }

      // Check if dropdown would go off the bottom edge
      if (top + dropdownHeight > window.innerHeight) {
        top = triggerRect.top - dropdownHeight - margin;
      }

      // Apply positioning
      dropdown.style.position = 'fixed';
      dropdown.style.left = left + 'px';
      dropdown.style.top = top + 'px';
      dropdown.style.right = 'auto'; // Reset right positioning

      // Show dropdown
      dropdown.classList.add('show');

      // Setup event listeners
      this.setupDropdownEventListeners();

      // Close dropdown when clicking outside
      setTimeout(() => {
        document.addEventListener('click', this.handleOutsideClick.bind(this), { once: true });
      }, 100);
    }
  }

  // Hide AI dropdown
  hideAIDropdown() {
    const dropdown = document.getElementById('aiDropdownMenu');
    if (dropdown) {
      dropdown.classList.remove('show');

      // Flush any pending draft saves when closing dropdown to ensure current content is saved
      if (this.currentNote && !this._isApplyingAIRewrite) {
        this.flushDraftSave().catch(error => {
          console.error('Failed to flush draft save on dropdown close:', error);
        });
      }

      // Clear user context input when hiding dropdown
      const userContextInput = document.getElementById('userContextInput');
      if (userContextInput) {
        userContextInput.value = '';
        const charCount = document.getElementById('charCount');
        if (charCount) {
          charCount.textContent = '0';
          charCount.style.color = 'rgba(255, 255, 255, 0.7)';
        }
      }

      // Reset style selection
      const styleOptions = document.querySelectorAll('.style-option');
      styleOptions.forEach(option => option.classList.remove('active'));
    }
  }

  // Handle clicks outside dropdown
  handleOutsideClick(event) {
    const dropdown = document.getElementById('aiDropdownMenu');
    const trigger = document.getElementById('aiRewriteBtn');

    if (dropdown && trigger && !dropdown.contains(event.target) && !trigger.contains(event.target)) {
      // Just hide dropdown - no need to save draft again
      this.hideAIDropdown();
    }
  }

  // Show AI Summary modal
  async showAISummaryModal() {
    const modal = document.getElementById('ai-summary-modal');

    if (modal) {
      // Load usage info and populate domain dropdown
      await this.loadSummaryUsageInfo();
      await this.populateDomainDropdown();

      // Show modal
      modal.classList.add('show');

      // Setup modal event listeners
      this.setupModalEventListeners();

      // Initialize site content button state
      this.updateSiteContentButtonState();
    } else {
      console.warn('AI Summary modal not found!');
    }
  }

  // Hide AI Summary modal
  hideAISummaryModal() {
    const modal = document.getElementById('ai-summary-modal');
    if (modal) {
      modal.classList.remove('show');
    }
  }

  // Setup modal event listeners
  setupModalEventListeners() {
    // Close button
    const closeBtn = document.getElementById('aiSummaryCloseBtn');
    if (closeBtn) {
      closeBtn.onclick = () => this.hideAISummaryModal();
    }

    // Close on outside click
    const modal = document.getElementById('ai-summary-modal');
    if (modal) {
      modal.onclick = (e) => {
        if (e.target === modal) {
          this.hideAISummaryModal();
        }
      };
    }

    // Domain selection change
    const domainSelect = document.getElementById('summaryDomainSelect');
    if (domainSelect) {
      domainSelect.onchange = () => this.updateDomainInfo();
    }

    // Generate button
    const generateBtn = document.getElementById('aiSummaryGenerateBtn');
    if (generateBtn) {
      generateBtn.onclick = () => this.executeAISummary();
    }

    // Site content summary button
    const siteContentBtn = document.getElementById('siteContentSummaryBtn');
    if (siteContentBtn) {
      siteContentBtn.onclick = () => this.executeSiteContentSummary();
    }
  }

  // Update site content button state
  updateSiteContentButtonState() {
    const siteContentBtn = document.getElementById('siteContentSummaryBtn');
    if (siteContentBtn) {
      if (this.currentSite && this.currentSite.domain && this.currentSite.url.startsWith('http')) {
        siteContentBtn.disabled = false;
        // Use textContent to safely set domain (already XSS-safe, but being explicit)
        const safeDomain = String(this.currentSite.domain).replace(/[<>]/g, '');
        siteContentBtn.textContent = `Summarize ${safeDomain} (20 tokens)`;
      } else {
        siteContentBtn.disabled = true;
        siteContentBtn.textContent = 'Summarize Current Page (20 tokens)';
      }
    }
  }

  // Load summary usage info
  async loadSummaryUsageInfo() {
    try {
      // Check if user is authenticated
      if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
        const usageCount = document.getElementById('summaryUsageCount');
        if (usageCount) {
          usageCount.textContent = '0';
        }
        return;
      }

      const user = window.supabaseClient.getCurrentUser();
      if (!user) {
        const usageCount = document.getElementById('summaryUsageCount');
        if (usageCount) {
          usageCount.textContent = '0';
        }
        return;
      }

      // Get current usage from Supabase using the shared function
      const usageData = await this.getCurrentAIUsage();

      if (!usageData) {
        console.warn('Failed to get summary usage');
        const noteSummaryUsageCount = document.getElementById('noteSummaryUsageCount');
        if (noteSummaryUsageCount) {
          noteSummaryUsageCount.textContent = '0';
        }
        const siteSummaryUsageCount = document.getElementById('siteSummaryUsageCount');
        if (siteSummaryUsageCount) {
          siteSummaryUsageCount.textContent = '0';
        }
        return;
      }



      // Update UI with note summary tokens (individual tokens for note summaries)
      const noteSummaryUsageCount = document.getElementById('noteSummaryUsageCount');
      if (noteSummaryUsageCount) {
        noteSummaryUsageCount.textContent = usageData.remainingCalls || 0;
      }

      const noteSummaryUsageLimit = document.getElementById('noteSummaryUsageLimit');
      if (noteSummaryUsageLimit) {
        noteSummaryUsageLimit.textContent = usageData.monthlyLimit || 500;
      }

      // Update UI with site summary uses (each site summary costs 20 tokens)
      const siteSummaryUsageCount = document.getElementById('siteSummaryUsageCount');
      if (siteSummaryUsageCount) {
        // Calculate remaining site summary uses (divide by 20, floor the result)
        const remainingSiteSummaryUses = Math.floor((usageData.remainingCalls || 0) / 20);
        siteSummaryUsageCount.textContent = remainingSiteSummaryUses;
      }

      // Also update the site summary usage limit display (show total site summary uses available)
      const siteSummaryUsageLimit = document.getElementById('siteSummaryUsageLimit');
      if (siteSummaryUsageLimit) {
        // Calculate total site summary uses available (divide by 20, floor the result)
        const totalSiteSummaryUses = Math.floor((usageData.monthlyLimit || 500) / 20);
        siteSummaryUsageLimit.textContent = totalSiteSummaryUses;
      }
    } catch (error) {
      console.error('Failed to load summary usage info:', error);
      const noteSummaryUsageCount = document.getElementById('noteSummaryUsageCount');
      if (noteSummaryUsageCount) {
        noteSummaryUsageCount.textContent = '0';
      }
      const siteSummaryUsageCount = document.getElementById('siteSummaryUsageCount');
      if (siteSummaryUsageCount) {
        siteSummaryUsageCount.textContent = '0';
      }
    }
  }

  // Populate domain dropdown with available domains
  async populateDomainDropdown() {
    try {
      // Use filtered notes (excluding deleted notes) instead of all notes
      let filteredNotes;
      if (this.storageManager === window.notesStorage && typeof this.storageManager.getAllNotesForDisplay === 'function') {
        // Use IndexedDB storage - get notes for display (excludes deleted notes)
        filteredNotes = await this.storageManager.getAllNotesForDisplay();
      } else {
        // Fallback to Chrome storage - use the same filtering logic as loadNotes()
        const allData = await browserAPI.storage.local.get(null);
        let allNotes = [];
        for (const key in allData) {
          // Filter out settings or non-array data
          if (key !== 'themeMode' && Array.isArray(allData[key])) {
            allNotes = allNotes.concat(allData[key]);
          }
        }
        // Sort by most recently updated
        allNotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        filteredNotes = allNotes;
      }

      const domains = [...new Set(filteredNotes.map(note => note.domain).filter(Boolean))];

      const domainSelect = document.getElementById('summaryDomainSelect');

      if (domainSelect) {
        // Clear existing options and set appropriate placeholder
        const placeholderText = domains.length === 0 ? 'No notes to summarize' : 'Select a domain...';
        if (window.safeDOM) {
          window.safeDOM.setInnerHTML(domainSelect, `<option value="">${placeholderText}</option>`, false);
        } else {
          domainSelect.innerHTML = `<option value="">${placeholderText}</option>`;
        }

        // Add domain options
        domains.forEach(domain => {
          const noteCount = filteredNotes.filter(note => note.domain === domain).length;
          const option = document.createElement('option');
          // Sanitize domain value to prevent XSS in option value attribute
          const safeDomain = String(domain).replace(/[<>"']/g, '');
          option.value = safeDomain;
          // textContent is already XSS-safe, but sanitize for extra safety
          option.textContent = `${safeDomain} (${noteCount} notes)`;
          domainSelect.appendChild(option);
        });
      }
    } catch (error) {
      console.error('Failed to populate domain dropdown:', error);
    }
  }

  // Update domain info when selection changes
  async updateDomainInfo() {
    const domainSelect = document.getElementById('summaryDomainSelect');
    const generateBtn = document.getElementById('aiSummaryGenerateBtn');
    const siteContentBtn = document.getElementById('siteContentSummaryBtn');

    if (domainSelect && generateBtn && siteContentBtn) {
      const selectedDomain = domainSelect.value;

      if (selectedDomain) {
        // Use filtered notes (excluding deleted notes) for consistency
        let filteredNotes;
        if (this.storageManager === window.notesStorage && typeof this.storageManager.getAllNotesForDisplay === 'function') {
          // Use IndexedDB storage - get notes for display (excludes deleted notes)
          filteredNotes = await this.storageManager.getAllNotesForDisplay();
        } else {
          // Fallback to Chrome storage - use the same filtering logic as loadNotes()
          const allData = await browserAPI.storage.local.get(null);
          let allNotes = [];
          for (const key in allData) {
            // Filter out settings or non-array data
            if (key !== 'themeMode' && Array.isArray(allData[key])) {
              allNotes = allNotes.concat(allData[key]);
            }
          }
          // Sort by most recently updated
          allNotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
          filteredNotes = allNotes;
        }

        const noteCount = filteredNotes.filter(note => note.domain === selectedDomain).length;

        generateBtn.disabled = false;
        generateBtn.textContent = `Generate Summary (${noteCount} tokens)`;
      } else {
        generateBtn.disabled = true;
        generateBtn.textContent = 'Generate Summary';
      }

      // Enable site content summary button if we have a current site
      if (this.currentSite && this.currentSite.domain && this.currentSite.url.startsWith('http')) {
        siteContentBtn.disabled = false;
        // Use textContent to safely set domain (already XSS-safe, but being explicit)
        const safeDomain = String(this.currentSite.domain).replace(/[<>]/g, '');
        siteContentBtn.textContent = `Summarize ${safeDomain} (20 tokens)`;
      } else {
        siteContentBtn.disabled = true;
        siteContentBtn.textContent = 'Summarize Current Page (20 tokens)';
      }
    }
  }

  // Setup dropdown event listeners
  setupDropdownEventListeners() {
    // Style selection
    const styleOptions = document.querySelectorAll('.style-option');
    styleOptions.forEach(option => {
      option.onclick = (e) => {
        // Remove active class from all options
        styleOptions.forEach(opt => opt.classList.remove('active'));
        // Add active class to clicked option
        e.currentTarget.classList.add('active');
      };
    });

    // User context input character counter
    const userContextInput = document.getElementById('userContextInput');
    const charCount = document.getElementById('charCount');

    if (userContextInput && charCount) {
      userContextInput.addEventListener('input', () => {
        const currentLength = userContextInput.value.length;
        charCount.textContent = currentLength;

        // Visual feedback when approaching limit
        if (currentLength > 250) {
          charCount.style.color = '#ff6b6b';
        } else if (currentLength > 200) {
          charCount.style.color = '#ffd93d';
        } else {
          charCount.style.color = 'rgba(255, 255, 255, 0.7)';
        }
      });
    }

    // Execute AI rewrite button
    const executeBtn = document.getElementById('executeAIRewrite');
    if (executeBtn) {
      executeBtn.onclick = () => this.executeAIRewrite();
    }


  }

  // Execute AI rewrite from dropdown
  async executeAIRewrite() {
    const activeStyle = document.querySelector('.style-option.active');
    if (!activeStyle) {
      Utils.showToast('Please select a rewrite style first.', 'warning');
      return;
    }

    const style = activeStyle.dataset.style;

    // Get current content from editor only - don't use saved note content
    const contentInput = document.getElementById('noteContentInput');
    const titleInput = document.getElementById('noteTitleHeader');

    if (!contentInput || !titleInput) {
      Utils.showToast('Editor not found', 'error');
      return;
    }

    const title = titleInput.value || '';
    const content = this.editorManager.htmlToMarkdown(contentInput.innerHTML || '');
    const combinedContent = `${title} ${content}`.trim();

    if (!combinedContent) {
      Utils.showToast('Add some content to your note first to use AI Rewrite', 'info');
      return;
    }

    // Check if user is authenticated (same pattern as AI summary)
    if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
      Utils.showToast('Sign in to use AI Rewrite - Free users get 30 rewrites per month!', 'info');
      return;
    }

    // Hide dropdown
    this.hideAIDropdown();

    // Show loading state
    Utils.showToast('AI is rewriting your note...', 'info');

    try {
      // Get user context if provided
      const userContextInput = document.getElementById('userContextInput');
      const userContext = userContextInput ? userContextInput.value.trim() : '';

      // Call AI rewrite API with user context
      const rewrittenContent = await this.callAIRewriteAPI(combinedContent, style, userContext);

      // Check if API call was successful
      if (rewrittenContent === null) {
        // API call failed due to authentication
        return;
      }

      // Apply the rewritten content directly to the note
      await this.applyAIRewriteToNote(rewrittenContent, style);

      // Force update usage display after AI rewrite
      await this.forceUpdateAIUsageDisplay();

      // Show success message
      Utils.showToast(`AI rewrite applied! Content rewritten in ${style} style.`, 'success');

    } catch (error) {
      console.error('AI rewrite failed:', error);
      Utils.showToast('AI rewrite failed. Please try again.', 'error');
    }
  }

  // Execute AI summary from modal
  async executeAISummary() {
    // Check if user is authenticated (same pattern as AI rewrite)
    if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
      Utils.showToast('Please create an account to use AI Summary. Free users get 30 summaries/month!', 'info');
      return;
    }

    const user = window.supabaseClient.getCurrentUser();
    if (!user) {
      Utils.showToast('Please create an account to use AI Summary.', 'info');
      return;
    }

    // AI Summary is now available to all users (free and premium)
    // No premium check needed

    const domainSelect = document.getElementById('summaryDomainSelect');
    if (!domainSelect || !domainSelect.value) {
      Utils.showToast('Please select a domain to summarize.', 'warning');
      return;
    }

    const selectedDomain = domainSelect.value;

    // Get all notes for the selected domain from local storage
    const domainNotes = await this.getNotesForDomain(selectedDomain);

    if (!domainNotes || domainNotes.length === 0) {
      Utils.showToast('No notes found for the selected domain.', 'warning');
      return;
    }

    // Check if user has enough tokens for domain summary (1 token per note)
    const currentUsage = await this.getCurrentAIUsage();
    if (!currentUsage || currentUsage.remainingCalls < domainNotes.length) {
      Utils.showToast(`Not enough tokens for note summary. You need ${domainNotes.length} tokens (1 per note) but only have ${currentUsage?.remainingCalls || 0} remaining.`, 'warning');
      return;
    }

    // Hide modal
    this.hideAISummaryModal();

    // Show loading state
    Utils.showToast('AI is generating a summary...', 'info');

    try {
      // Combine all note content for summarization
      const combinedContent = domainNotes.map(note =>
        `Title: ${note.title || 'Untitled'}\nContent: ${note.content || ''}\nTags: ${(note.tags || []).join(', ')}\n---`
      ).join('\n');

      // Call AI summary API
      const summaryContent = await this.callAISummaryAPI(combinedContent, selectedDomain, domainNotes.length);

      if (summaryContent === null) {
        return; // API call failed
      }

      // Create a new summary note
      await this.createSummaryNote(summaryContent, selectedDomain, domainNotes.length);

      // Track local AI usage (variable credits based on note count)
      await this.trackLocalAIUsage(domainNotes.length);

      // Show success message
      Utils.showToast(`Summary note created for ${selectedDomain}!`, 'success');

    } catch (error) {
      console.error('AI summary failed:', error);
      Utils.showToast('AI summary failed. Please try again.', 'error');
    }
  }

  // Get notes for a specific domain from local storage
  async getNotesForDomain(domain) {
    try {
      // Use filtered notes (excluding deleted notes) for consistency
      let filteredNotes;
      if (this.storageManager === window.notesStorage && typeof this.storageManager.getAllNotesForDisplay === 'function') {
        // Use IndexedDB storage - get notes for display (excludes deleted notes)
        filteredNotes = await this.storageManager.getAllNotesForDisplay();
      } else {
        // Fallback to Chrome storage - use the same filtering logic as loadNotes()
        const allData = await browserAPI.storage.local.get(null);
        let allNotes = [];
        for (const key in allData) {
          // Filter out settings or non-array data
          if (key !== 'themeMode' && Array.isArray(allData[key])) {
            allNotes = allNotes.concat(allData[key]);
          }
        }
        // Sort by most recently updated
        allNotes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
        filteredNotes = allNotes;
      }

      return filteredNotes.filter(note => note.domain === domain);
    } catch (error) {
      console.error('Failed to get notes for domain:', error);
      return [];
    }
  }

  // Call AI summary API
  async callAISummaryAPI(content, domain, noteCount) {
    try {
      const apiUrl = `${window.supabaseClient.supabaseUrl}/functions/v1/hyper-api`;

      const requestBody = {
        content: content,
        style: 'concise', // Use concise style for summaries
        generateTags: false,
        existingTags: [],
        context: {
          domain: domain,
          feature: 'summarize',
          noteCount: noteCount
        }
      };

      // Get access token safely - use same pattern as AI rewrite
      let accessToken = '';
      if (window.supabaseClient && window.supabaseClient.isAuthenticated()) {
        const user = window.supabaseClient.getCurrentUser();
        if (user) {
          // Use accessToken directly like AI rewrite function
          accessToken = window.supabaseClient.accessToken || '';
        }
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'apikey': window.supabaseClient.supabaseAnonKey
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json();
        if (response.status === 401) {
          Utils.showToast('Please sign in to use AI features.', 'warning');
          return null;
        } else if (response.status === 429) {
          Utils.showToast(`Monthly AI usage limit exceeded. ${errorData.remainingCalls || 0} calls remaining.`, 'warning');
          return null;
        }
      }

      const data = await response.json();
      return data.rewrittenContent;
    } catch (error) {
      console.error('AI summary API call failed:', error);
      throw error;
    }
  }

  // Create a new summary note
  async createSummaryNote(summaryContent, domain, noteCount) {
    try {
      const summaryNote = {
        id: Utils.generateId(),
        title: `Summary of ${domain} Notes - ${noteCount} notes analyzed`,
        content: summaryContent,
        url: `https://${domain}`,
        domain: domain,
        tags: ['summary', 'ai-generated', domain],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isEncrypted: false
      };

      // Save the summary note
      await this.storageManager.saveNote(summaryNote);

      // Refresh the notes list
      await this.loadNotes();

      // Switch to the new note
      this.openNote(summaryNote);

    } catch (error) {
      console.error('Failed to create summary note:', error);
      throw error;
    }
  }

  // Execute site content summary
  async executeSiteContentSummary() {
    // Check if user is authenticated
    if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
      Utils.showToast('Please create an account to use AI Summary. Free users get 30 summaries/month!', 'info');
      return;
    }

    const user = window.supabaseClient.getCurrentUser();
    if (!user) {
      Utils.showToast('Please create an account to use AI Summary.', 'info');
      return;
    }

    // AI Summary is now available to all users (free and premium)
    // Check if user has enough tokens for site content summary (requires 20 tokens)
    const currentUsage = await this.getCurrentAIUsage();
    if (!currentUsage || currentUsage.remainingCalls < 20) {
      const remainingUses = Math.floor((currentUsage?.remainingCalls || 0) / 20);
      Utils.showToast(`Not enough tokens for page summary. You need 20 tokens but only have ${currentUsage?.remainingCalls || 0} remaining. (${remainingUses} page summaries available)`, 'warning');
      return;
    }

    // Check if we have a current site
    if (!this.currentSite || !this.currentSite.domain || !this.currentSite.url.startsWith('http')) {
      Utils.showToast('No valid webpage to summarize. Please navigate to a webpage first.', 'warning');
      return;
    }

    // Hide modal
    this.hideAISummaryModal();

    // Show loading state
    Utils.showToast('Extracting page content for AI summary...', 'info');

    try {
      // Get the current tab
      const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        throw new Error('No active tab found');
      }

      // Try to extract page content using content script
      let response = null;

      try {
        // First try sending message to existing content script
        response = await browserAPI.tabs.sendMessage(tab.id, { action: 'extractPageContent' });
      } catch (messageError) {
        console.log('Content script not ready, injecting...', messageError.message);

        try {
          // Inject content script and try again
          await browserAPI.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content/content.js']
          });

          // Wait a moment for script to initialize
          await new Promise(resolve => setTimeout(resolve, 100));

          // Try message again
          response = await browserAPI.tabs.sendMessage(tab.id, { action: 'extractPageContent' });
        } catch (injectionError) {
          console.error('Failed to inject content script:', injectionError);
          throw new Error('Unable to access page content. Please refresh the page and try again.');
        }
      }

      if (!response || !response.success || !response.content) {
        throw new Error('Failed to extract page content');
      }

      const pageContent = response.content;
      if (pageContent.length < 100) {
        Utils.showToast('Page content is too short to summarize meaningfully.', 'warning');
        return;
      }

      // Update loading message
      Utils.showToast('AI is generating page summary...', 'info');

      // Call AI summary API with page content
      const summaryContent = await this.callSiteContentSummaryAPI(pageContent, this.currentSite.domain, this.currentSite.title);

      if (summaryContent === null) {
        return; // API call failed
      }

      // Create a new summary note for the page content
      await this.createSiteContentSummaryNote(summaryContent, this.currentSite);

      // Track local AI usage (20 credits for site content summary)
      await this.trackLocalAIUsage(20);

      // Show success message
      Utils.showToast(`Page summary created for ${this.currentSite.domain}!`, 'success');

    } catch (error) {
      console.error('Site content summary failed:', error);
      if (error.message.includes('Could not establish connection')) {
        Utils.showToast('Please refresh the page and try again.', 'error');
      } else {
        Utils.showToast('Failed to summarize page content. Please try again.', 'error');
      }
    }
  }

  // Call AI summary API for site content (uses 20 credits per page)
  async callSiteContentSummaryAPI(content, domain, pageTitle) {
    try {
      const apiUrl = `${window.supabaseClient.supabaseUrl}/functions/v1/hyper-api`;

      const requestBody = {
        content: content,
        style: 'concise',
        generateTags: false,
        existingTags: [],
        context: {
          domain: domain,
          noteTitle: pageTitle,
          feature: 'summarize',
          noteCount: 20 // Site content summary uses 20 note summary credits (equivalent to 1 usage)
        }
      };

      // Get access token
      let accessToken = '';
      if (window.supabaseClient && window.supabaseClient.isAuthenticated()) {
        const user = window.supabaseClient.getCurrentUser();
        if (user) {
          accessToken = window.supabaseClient.accessToken || '';
        }
      }

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'apikey': window.supabaseClient.supabaseAnonKey
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));

        if (response.status === 429) {
          Utils.showToast('Monthly AI usage limit exceeded. Upgrade to premium for more usage.', 'error');
        } else if (response.status === 401) {
          Utils.showToast('Authentication failed. Please sign in again.', 'error');
        } else {
          Utils.showToast(errorData.error || 'AI service temporarily unavailable.', 'error');
        }
        return null;
      }

      const data = await response.json();
      return data.rewrittenContent || null;

    } catch (error) {
      console.error('Site content summary API error:', error);
      Utils.showToast('AI service temporarily unavailable. Please try again later.', 'error');
      return null;
    }
  }

  // Create a new summary note for site content
  async createSiteContentSummaryNote(summaryContent, siteInfo) {
    try {
      const summaryNote = {
        id: Utils.generateId(),
        title: `Page Summary: ${siteInfo.title || siteInfo.domain}`,
        content: summaryContent,
        url: siteInfo.url,
        domain: siteInfo.domain,
        tags: ['page-summary', 'ai-generated', siteInfo.domain],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isEncrypted: false
      };

      // Save the summary note
      await this.storageManager.saveNote(summaryNote);

      // Refresh the notes list
      await this.loadNotes();

      // Switch to the new note
      this.openNote(summaryNote);

    } catch (error) {
      console.error('Failed to create site content summary note:', error);
      throw error;
    }
  }

  // Display context information
  async displayContextInfo() {
    if (!this.currentNote) return;

    // Update dropdown context tags
    const contextDomain = document.getElementById('contextDomain');
    const contextIntent = document.getElementById('contextIntent');
    const contextStyle = document.getElementById('contextStyle');

    if (contextDomain && contextIntent && contextStyle) {
      // Domain context
      const domain = this.currentNote.domain || 'general';
      contextDomain.textContent = `🌐 ${domain}`;

      // Intent context - handle both saved notes and drafts
      // Get content from editor inputs first (for drafts), then fall back to note data
      const noteContentInput = document.getElementById('noteContentInput');
      const noteTitleHeader = document.getElementById('noteTitleHeader');

      // Fix: For contenteditable elements, use innerHTML to preserve links and formatting
      // This is important for maintaining clickable links generated from context menu
      const draftContent = noteContentInput ? (noteContentInput.innerHTML || '') : '';
      const draftTitle = noteTitleHeader ? (noteTitleHeader.value || '') : '';

      const content = draftContent.trim() || this.currentNote.content || '';
      const title = draftTitle.trim() || this.currentNote.title || '';
      const combinedText = `${title} ${content}`.trim();

      const intent = this.getUserIntentFromContent(combinedText);
      contextIntent.textContent = `🎯 ${intent}`;

      // Style context - analyze current content
      const style = this.analyzeWritingStyle(combinedText);
      contextStyle.textContent = `✍️ ${style}`;
    }
  }

  // Load and display usage info
  async loadUsageInfo() {
    try {
      // Use the global cached premium status function instead of direct calls
      const premiumStatus = await getPremiumStatus();
      const isPremium = premiumStatus.isPremium;

      // Update dropdown usage badge based on actual usage data
      const remainingCalls = document.getElementById('aiDropdownRemainingCalls');
      if (remainingCalls) {
        // Check authentication state first
        const isAuthenticated = window.supabaseClient?.isAuthenticated?.() || false;
        const user = window.supabaseClient?.getCurrentUser?.();

        if (!isAuthenticated || !user) {
          if (isPremium) {
            remainingCalls.textContent = '500/month';
          } else {
            remainingCalls.textContent = '30/month';
          }
          return;
        }

        // First try to get cached usage data, only fetch fresh if not available
        let currentUsage = null;

        // Check if we have recent cached data (within 5 minutes)
        if (this._cachedAIUsage && this._cachedAIUsage.timestamp > Date.now() - 300000) {
          currentUsage = this._cachedAIUsage.data;
        } else {
          // No cache or cache is stale, fetch fresh data
          currentUsage = await this.getCurrentAIUsage();
        }

        if (currentUsage) {
          // Display actual remaining calls and monthly limit
          remainingCalls.textContent = `${currentUsage.remainingCalls}/${currentUsage.monthlyLimit}`;
        } else {
          // Fallback to premium status if backend call fails
          if (isPremium) {
            remainingCalls.textContent = '500/month';
          } else {
            remainingCalls.textContent = '30/month';
          }
        }

        // Show upgrade message if free user has 0 calls remaining
        if (!isPremium && currentUsage && currentUsage.remainingCalls === 0) {
          this.showUpgradeMessage();
        }
      }

      // Display context info
      await this.displayContextInfo();
    } catch (error) {
      console.error('Error loading usage info:', error);
    }
  }

  // Force update AI usage display immediately
  async forceUpdateAIUsageDisplay() {
    try {
      // Get fresh usage data
      const currentUsage = await this.getCurrentAIUsage();

      if (currentUsage) {
        // Update AI dropdown display
        const aiDropdownElement = document.getElementById('aiDropdownRemainingCalls');
        if (aiDropdownElement) {
          const newText = `${currentUsage.remainingCalls}/${currentUsage.monthlyLimit}`;
          aiDropdownElement.textContent = newText;
        }

        // Update other displays
        const noteSummaryElement = document.getElementById('noteSummaryUsageCount');
        if (noteSummaryElement) {
          noteSummaryElement.textContent = currentUsage.remainingCalls || 0;
        }

        const siteSummaryElement = document.getElementById('siteSummaryUsageCount');
        if (siteSummaryElement) {
          const remainingSiteSummaryUses = Math.floor((currentUsage.remainingCalls || 0) / 20);
          siteSummaryElement.textContent = remainingSiteSummaryUses;
        }
      }

    } catch (error) {
      console.error('Error force updating AI usage display:', error);
    }
  }

  // Refresh AI usage display in all locations
  async refreshAIUsageDisplay() {
    try {
      // Don't clear cache - reuse existing data if available

      // Update AI dropdown display
      const aiDropdownRemainingCalls = document.getElementById('aiDropdownRemainingCalls');
      if (aiDropdownRemainingCalls) {
        const currentUsage = await this.getCurrentAIUsage();
        if (currentUsage) {
          const newText = `${currentUsage.remainingCalls}/${currentUsage.monthlyLimit}`;
          aiDropdownRemainingCalls.textContent = newText;
        }
      }

      // Update other usage displays (note summary, site summary)
      const noteSummaryUsageCount = document.getElementById('noteSummaryUsageCount');
      if (noteSummaryUsageCount) {
        const currentUsage = await this.getCurrentAIUsage();
        if (currentUsage) {
          noteSummaryUsageCount.textContent = currentUsage.remainingCalls || 0;
        }
      }

      const siteSummaryUsageCount = document.getElementById('siteSummaryUsageCount');
      if (siteSummaryUsageCount) {
        const currentUsage = await this.getCurrentAIUsage();
        if (currentUsage) {
          const remainingSiteSummaryUses = Math.floor((currentUsage.remainingCalls || 0) / 20);
          siteSummaryUsageCount.textContent = remainingSiteSummaryUses;
        }
      }

    } catch (error) {
      console.error('Error refreshing AI usage display:', error);
    }
  }

  // Get current AI usage with local tracking
  async getCurrentAIUsage(featureName = 'overall') {
    try {
      if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
        return null;
      }

      const user = window.supabaseClient.getCurrentUser();
      if (!user) return null;

      // Rate limiting: prevent multiple calls within 5 seconds
      const rateLimitKey = `aiUsageRateLimit_${user.id}`;
      const now = Date.now();
      const lastCall = this._lastAIUsageCall || 0;

      if (now - lastCall < 5000) { // 5 second rate limit
        // Return cached result if available
        if (this._cachedAIUsage && this._cachedAIUsage.timestamp > now - 300000) { // 5 minute cache
          return this._cachedAIUsage.data;
        }
      }

      this._lastAIUsageCall = now;

      // Get cached server data and local usage tracking
      const cacheKey = 'cachedAIUsage';
      const localUsageKey = 'localAIUsage';
      const result = await browserAPI.storage.local.get([cacheKey, localUsageKey]);

      // Check if we have valid cached server data
      let serverData = null;
      if (result[cacheKey]) {
        const { data, timestamp } = result[cacheKey];
        const now = Date.now();
        const cacheAge = now - timestamp;
        const cacheExpiry = 60 * 60 * 1000; // 1 hour cache

        if (cacheAge < cacheExpiry) {
          serverData = data;
        }
      }

      // If no valid cache, fetch from server
      if (!serverData) {
        const session = await window.supabaseClient.getSession();
        const expiresAt = session?.expires_at || 0;
        if (!expiresAt || expiresAt - Date.now() < 60 * 1000) {
          try {
            await window.supabaseClient.refreshSession();
          } catch (refreshError) {
            console.warn('Token refresh failed, continuing with current token:', refreshError);
          }
        }

        const { data: usageData, error } = await window.supabaseClient.rpc('check_ai_usage', {
          p_user_id: user.id,
          p_feature_name: 'overall'
        });

        if (error) {
          // Handle rate limit errors specifically
          if (error.message && error.message.includes('rate limit')) {
            console.warn('Rate limit reached for AI usage check, using cached data');
            // Return cached data if available, or default values
            return this._cachedAIUsage?.data || {
              remainingCalls: 0,
              monthlyLimit: 30,
              resetDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
            };
          }
          console.warn('Failed to get AI usage:', error);
          return null;
        }

        serverData = usageData;

        // Cache the server result
        await browserAPI.storage.local.set({
          [cacheKey]: {
            data: serverData,
            timestamp: Date.now()
          }
        });

        // Reset local usage tracking when we get fresh server data
        await browserAPI.storage.local.set({
          [localUsageKey]: {
            userId: user.id,
            usageCount: 0,
            timestamp: Date.now()
          }
        });
      }

      // Get local usage tracking
      let localUsage = result[localUsageKey];
      if (!localUsage || localUsage.userId !== user.id) {
        // Initialize local usage for this user
        localUsage = {
          userId: user.id,
          usageCount: 0,
          timestamp: Date.now()
        };
        await browserAPI.storage.local.set({ [localUsageKey]: localUsage });
      }

      // Calculate current remaining calls with local adjustments
      const adjustedRemainingCalls = Math.max(0, serverData.remainingCalls - localUsage.usageCount);

      const usageResult = {
        ...serverData,
        remainingCalls: adjustedRemainingCalls,
        localUsageCount: localUsage.usageCount
      };

      // Cache the result
      this._cachedAIUsage = {
        data: usageResult,
        timestamp: Date.now()
      };

      return usageResult;

    } catch (error) {
      console.warn('Error getting AI usage:', error);
      return null;
    }
  }

  // Track local AI usage
  async trackLocalAIUsage(usageAmount = 1) {
    try {
      if (!window.supabaseClient || !window.supabaseClient.isAuthenticated()) {
        return;
      }

      const user = window.supabaseClient.getCurrentUser();
      if (!user) return;

      const localUsageKey = 'localAIUsage';
      const result = await browserAPI.storage.local.get([localUsageKey]);

      let localUsage = result[localUsageKey];
      if (!localUsage || localUsage.userId !== user.id) {
        localUsage = {
          userId: user.id,
          usageCount: 0,
          timestamp: Date.now()
        };
      }

      // Increment local usage
      localUsage.usageCount += usageAmount;
      localUsage.timestamp = Date.now();

      await browserAPI.storage.local.set({ [localUsageKey]: localUsage });


    } catch (error) {
      console.warn('Error tracking local AI usage:', error);
    }
  }

  // Clear local AI usage tracking (on auth changes)
  async clearLocalAIUsage() {
    try {
      // Rate limit cache clearing to prevent excessive clearing
      const now = Date.now();
      if (this._lastCacheClear && now - this._lastCacheClear < 10000) { // 10 second rate limit
        return;
      }
      this._lastCacheClear = now;

      // Clear both local usage tracking AND cached server data
      // This ensures fresh AI usage data is fetched with updated limits after tier changes
      await browserAPI.storage.local.remove(['localAIUsage', 'cachedAIUsage']);
    } catch (error) {
      console.warn('Error clearing local AI usage:', error);
    }
  }



  // Check premium status
  async checkPremiumStatus() {
    try {
      // Use the global cached premium status function instead of direct calls
      const premiumStatus = await getPremiumStatus();
      return premiumStatus.isPremium;
    } catch (error) {
      console.warn('Error checking premium status:', error);
      return false;
    }
  }

  // Show upgrade message when free users hit their limit
  showUpgradeMessage() {
    // Use unified toast system for upgrade message
    Utils.showToast('AI limit reached! Upgrade to Premium for 500 rewrites/month', 'warning');

    // Also update the usage badge to show upgrade option
    const usageBadge = document.getElementById('usageBadge');
    if (usageBadge) {
      // Create upgrade message
      const upgradeMsg = document.createElement('div');
      upgradeMsg.className = 'upgrade-message';
      const upgradeHtml = `
        <span class="upgrade-text">Upgrade to Premium</span>
        <span class="upgrade-subtitle">Get 500 rewrites/month</span>
      `;

      if (window.safeDOM) {
        window.safeDOM.setInnerHTML(upgradeMsg, upgradeHtml, false);
      } else {
        upgradeMsg.innerHTML = upgradeHtml;
      }

      // Replace the usage badge content
      if (window.safeDOM) {
        window.safeDOM.clearContent(usageBadge);
      } else {
        usageBadge.innerHTML = '';
      }
      usageBadge.appendChild(upgradeMsg);

      // Add click handler to open settings
      upgradeMsg.style.cursor = 'pointer';
      upgradeMsg.onclick = () => {
        // Open settings panel
        this.showSettings();
        this.hideAIDropdown();
      };
    }
  }

  // Apply AI rewrite to current note
  async applyAIRewrite() {
    const previewContent = document.getElementById('previewContent');
    if (previewContent && this.currentNote) {
      // Update note content
      this.currentNote.content = previewContent.textContent;

      // Update editor
      const contentInput = document.getElementById('noteContentInput');
      if (contentInput) {
        const safeContent = this.buildContentHtml(previewContent.textContent);
        if (window.safeDOM) {
          window.safeDOM.setInnerHTML(contentInput, safeContent, true);
        } else {
          contentInput.innerHTML = safeContent;
        }
      }

      // Save note
      await this.saveNote();

      // Close dialog
      this.hideAIRewriteDialog();

      Utils.showToast('AI rewrite applied successfully!', 'success');
    }
  }

  // Export notes
  async exportNotes() {
    // SettingsManager exposes handleExportNotes()
    if (this.settingsManager && typeof this.settingsManager.handleExportNotes === 'function') {
      this.settingsManager.handleExportNotes();
    } else if (this.storageManager && typeof this.storageManager.exportNotes === 'function') {
      // Fallback to storage manager export if settings module isn't wired
      try {
        const exportData = await this.storageManager.exportNotes();

        // Get selected format (default to JSON if not available)
        const formatSelect = document.getElementById('exportFormatSelect');
        const selectedFormat = formatSelect ? formatSelect.value : 'json';

        // Use ExportFormats class to convert data
        const exportFormats = new ExportFormats();
        const exportResult = exportFormats.exportToFormat(exportData, selectedFormat);

        const blob = new Blob([exportResult.content], { type: exportResult.mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = exportResult.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        // Show success message with format info
        const formatInfo = exportFormats.getSupportedFormats()[selectedFormat];
        Utils.showToast(`Notes exported as ${formatInfo.name}`, 'success');
      } catch (e) {
        Utils.showToast('Failed to export notes', 'error');
      }
    } else {
      Utils.showToast('Export not available', 'info');
    }
  }

  // Open settings panel
  openSettings() {
    this.settingsManager.openSettings();
  }

  // Post-delete refresh functionality
  async postDeleteRefresh() {
    try {
      // Re-render the notes list
      this.render();
      // Update storage quota display
      Utils.checkStorageQuota();
    } catch (error) {
      console.error('Error in post-delete refresh:', error);
    }
  }



  // Generate a unique ID for new notes
  generateId() {
    try {
      // Use crypto.randomUUID if available (modern browsers)
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
      }

      // Fallback for older browsers
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    } catch (error) {
      console.error('Failed to generate ID:', error);
      // Final fallback
      return Date.now().toString(36) + Math.random().toString(36).substr(2);
    }
  }

  // Apply font settings to editor
  applyFont(fontName, size) {
    try {
      const contentInput = document.getElementById('noteContentInput');
      if (contentInput) {
        const fontFamily = (fontName === 'Default' || fontName === 'System')
          ? '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'
          : fontName;
        contentInput.style.fontFamily = fontFamily;
        contentInput.style.fontSize = `${size}px`;
      }
    } catch (error) {
      console.warn('Failed to apply font:', error);
    }
  }

  // Close settings panel
  closeSettings() {
    try {
      const settingsPanel = document.getElementById('settingsPanel');
      if (settingsPanel) {
        settingsPanel.style.display = 'none';
      }
    } catch (error) {
      console.warn('Failed to close settings:', error);
    }
  }

  // Import functionality is handled by SettingsManager.handleImportNotes()

  // Show notification message using unified glassmorphism toast system
  showNotification(message, type = 'info') {
    // Use the unified Utils.showToast for consistent glassmorphism styling
    // This ensures sync notifications (the most important ones) use the best styling
    if (window.Utils && typeof window.Utils.showToast === 'function') {
      window.Utils.showToast(message, type);
    } else {
      // Fallback to console if Utils not available
      console.log(`${type.toUpperCase()}: ${message}`);
    }
  }

  // Helper to track setTimeout calls for cleanup
  _setTimeout(callback, delay) {
    const timeoutId = setTimeout(() => {
      callback();
      // Remove from tracking after execution
      const index = this._timeouts.indexOf(timeoutId);
      if (index > -1) this._timeouts.splice(index, 1);
    }, delay);
    this._timeouts.push(timeoutId);
    return timeoutId;
  }

  // Helper to track setInterval calls for cleanup
  _setInterval(callback, delay) {
    const intervalId = setInterval(callback, delay);
    this._intervals.push(intervalId);
    return intervalId;
  }

  // Cleanup method to prevent memory leaks
  cleanup() {
    try {
      // Clear all tracked timeouts
      if (this._timeouts && Array.isArray(this._timeouts)) {
        this._timeouts.forEach(timeoutId => {
          if (timeoutId) clearTimeout(timeoutId);
        });
        this._timeouts = [];
      }

      // Clear all tracked intervals
      if (this._intervals && Array.isArray(this._intervals)) {
        this._intervals.forEach(intervalId => {
          if (intervalId) clearInterval(intervalId);
        });
        this._intervals = [];
      }

      // Remove all tracked event listeners
      if (this._eventListeners && Array.isArray(this._eventListeners)) {
        this._eventListeners.forEach(({ target, event, handler }) => {
          if (target && event && handler) {
            target.removeEventListener(event, handler);
          }
        });
        this._eventListeners = [];
      }

      // Remove chrome message listener
      if (this._messageListener) {
        browserAPI.runtime.onMessage.removeListener(this._messageListener);
        this._messageListener = null;
      }

      // Clear autosave interval if exists
      if (this.autosaveInterval) {
        clearInterval(this.autosaveInterval);
        this.autosaveInterval = null;
      }

      // Cleanup theme manager
      if (this.themeManager && typeof this.themeManager.cleanup === 'function') {
        this.themeManager.cleanup();
      }

      // Cleanup settings manager
      if (this.settingsManager && typeof this.settingsManager.cleanup === 'function') {
        this.settingsManager.cleanup();
      }

      // Cleanup notes manager
      if (this.notesManager && typeof this.notesManager.cleanup === 'function') {
        this.notesManager.cleanup();
      }

      // Cleanup editor manager
      if (this.editorManager && typeof this.editorManager.cleanup === 'function') {
        this.editorManager.cleanup();
      }
    } catch (error) {
      console.warn('Error during cleanup:', error);
    }
  }

}

// Get premium status from storage or default to false
async function getPremiumStatus() {
  try {
    // Use cached premium status to avoid unnecessary sync calls
    const { cachedPremiumStatus } = await browserAPI.storage.local.get(['cachedPremiumStatus']);

    // If we have a recent cached value (less than 1 hour old), use it
    if (cachedPremiumStatus && cachedPremiumStatus.timestamp && cachedPremiumStatus.status && typeof cachedPremiumStatus.status.isPremium === 'boolean') {
      const age = Date.now() - cachedPremiumStatus.timestamp;
      if (age < 3600000) { // 1 hour in milliseconds
        return cachedPremiumStatus.status;
      }
    }

    // Clear corrupted cache if it exists
    if (cachedPremiumStatus && (!cachedPremiumStatus.status || typeof cachedPremiumStatus.status.isPremium !== 'boolean')) {
      await clearPremiumStatusCache();
    }

    // Otherwise get fresh status and cache it
    let isPremium = false;

    // Check chrome storage directly to avoid calling notesStorage.checkPremiumAccess
    try {
      const { userTier } = await browserAPI.storage.local.get(['userTier']);

      // Check if userTier exists and has the expected structure
      if (userTier) {
        if (typeof userTier === 'string') {
          // Handle string format like "premium"
          isPremium = userTier === 'premium';
        } else if (typeof userTier === 'object' && userTier !== null) {
          // Handle object format like { active: true, tier: 'premium' }
          const isActive = userTier.active === true;
          const isNotFree = userTier.tier && userTier.tier !== 'free';

          isPremium = isActive && isNotFree;
        } else {
          isPremium = false;
        }
      } else {
        isPremium = false;
      }
    } catch (error) {
      console.warn('Chrome storage premium check failed:', error);
      isPremium = false;
    }

    const status = { isPremium };

    // Cache the result with timestamp
    await browserAPI.storage.local.set({
      cachedPremiumStatus: {
        status,
        timestamp: Date.now()
      }
    });

    return status;
  } catch (error) {
    console.warn('Failed to get premium status:', error);
    // Default to non-premium on error
    return { isPremium: false };
  }
}

// Clear corrupted premium status cache
async function clearPremiumStatusCache() {
  try {
    // Also clear AI usage cache when premium status changes
    // This ensures AI limits are refreshed when tier changes
    await browserAPI.storage.local.remove(['cachedPremiumStatus', 'cachedAIUsage']);
  } catch (error) {
    console.warn('Failed to clear premium status cache:', error);
  }
}

// Note: clearAIUsageCache removed - now using local usage tracking instead

document.addEventListener('DOMContentLoaded', () => {
  // getPremiumStatus clears malformed cache entries itself. Keep valid one-hour
  // caches so reopening the popup does not refresh Auth and call the AI RPC.



  // Expose the app globally so modules (e.g., editor.js) can read premiumStatus
  window.urlNotesApp = new URLNotesApp();

  // Cleanup on popup unload to prevent memory leaks
  window.addEventListener('unload', () => {
    if (window.urlNotesApp && window.urlNotesApp.cleanup) {
      window.urlNotesApp.cleanup();
    }
  });

  // Expose notesManager globally for version history functionality
  if (window.urlNotesApp && window.urlNotesApp.notesManager) {
    window.notesManager = window.urlNotesApp.notesManager;
  }
});
