// Web Application - Simplified Storage Adapter
// Ultra-aggressive caching with localStorage and minimal API calls

class WebStorage {
  constructor() {
    this.cachePrefix = 'anchored_notes_';
    this.metaKey = 'anchored_meta';
    this.syncQueueKey = 'anchored_sync_queue';
    this.lastSyncKey = 'anchored_last_sync';
    this.changeCountKey = 'anchored_change_count';
    
    // Cache settings - ultra-aggressive
    this.cacheExpiryHours = 24; // 24+ hour cache duration
    this.batchSyncThreshold = 10; // Sync after 10+ changes
    this.batchSyncInterval = 30 * 60 * 1000; // 30 minutes in milliseconds
    this.maxRetries = 3;
    
    // Initialize sync queue and change tracking
    this.initializeSyncTracking();
    this.setupEmergencySync();
    this.startPeriodicSync();
    this.startCleanupTask();
  }

  // Initialize sync tracking metadata
  initializeSyncTracking() {
    if (!localStorage.getItem(this.syncQueueKey)) {
      localStorage.setItem(this.syncQueueKey, JSON.stringify([]));
    }
    if (!localStorage.getItem(this.changeCountKey)) {
      localStorage.setItem(this.changeCountKey, '0');
    }
    if (!localStorage.getItem(this.lastSyncKey)) {
      localStorage.setItem(this.lastSyncKey, '0');
    }
  }

  // Setup emergency sync on page unload
  setupEmergencySync() {
    window.addEventListener('beforeunload', () => {
      this.emergencySync();
    });
    
    // Also sync on visibility change (tab switching)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.emergencySync();
      }
    });
  }

  // Start periodic sync timer
  startPeriodicSync() {
    setInterval(() => {
      this.checkAndSync();
    }, this.batchSyncInterval);
  }

  // Start periodic cleanup of soft deleted notes
  startCleanupTask() {
    // Clean up soft deleted notes every hour (like extension)
    setInterval(() => {
      this.cleanupSyncedDeletedNotes();
    }, 60 * 60 * 1000); // 1 hour
    
    // Also clean up on first run (5 seconds after initialization)
    setTimeout(() => {
      this.cleanupSyncedDeletedNotes();
    }, 5000);
  }

  // Clean up soft deleted notes that have been synced to cloud
  async cleanupSyncedDeletedNotes() {
    if (!window.supabaseClient?.isAuthenticated?.()) {
      // Supabase client not available for cleanup
      return;
    }

    try {
      // Delegate to the API client so the dashboard and storage layer share
      // one throttled, batched cleanup request.
      const result = await window.supabaseClient.cleanupOldDeletedNotes();
      if (result.noteIds?.length) {
        this.cleanupDeletedNotesFromCache(result.noteIds);
      }
    } catch (error) {
      // Failed to cleanup soft deleted notes
    }
  }

  // Remove deleted notes from local cache
  cleanupDeletedNotesFromCache(noteIds) {
    try {
      // Remove individual note caches
      noteIds.forEach(noteId => {
        localStorage.removeItem(this.getCacheKey(noteId));
      });

      // Update all notes cache to remove deleted notes
      const cacheData = localStorage.getItem(this.getAllNotesKey());
      if (cacheData) {
        const { notes, timestamp } = JSON.parse(cacheData);
        if (notes) {
          const filteredNotes = notes.filter(note => !noteIds.includes(note.id));
          const newCacheData = {
            notes: filteredNotes,
            timestamp: timestamp
          };
          localStorage.setItem(this.getAllNotesKey(), JSON.stringify(newCacheData));
        }
      }
    } catch (error) {
      // Failed to cleanup deleted notes from cache
    }
  }

  // Get cache key for a note
  getCacheKey(noteId) {
    return `${this.cachePrefix}note_${noteId}`;
  }

  // Get all notes cache key
  getAllNotesKey() {
    return `${this.cachePrefix}all_notes`;
  }

  // Check if cache is expired
  isCacheExpired(timestamp) {
    const now = Date.now();
    const expiryTime = this.cacheExpiryHours * 60 * 60 * 1000;
    return (now - timestamp) > expiryTime;
  }

  // Load from cache immediately - cache-first strategy
  async getAllNotesFromCache() {
    try {
      const cacheData = localStorage.getItem(this.getAllNotesKey());
      if (!cacheData) return null;

      const { notes, timestamp } = JSON.parse(cacheData);
      
      // Return cached data regardless of expiry for immediate loading
      // API fetch will happen in background if expired
      return notes || [];
    } catch (error) {
      // Failed to load notes from cache
      return null;
    }
  }

  // Save notes to cache
  saveNotesToCache(notes) {
    try {
      const cacheData = {
        notes: notes,
        timestamp: Date.now()
      };
      localStorage.setItem(this.getAllNotesKey(), JSON.stringify(cacheData));
    } catch (error) {
      // Failed to save notes to cache
    }
  }

  // Get single note from cache
  async getNoteFromCache(noteId) {
    try {
      const cacheData = localStorage.getItem(this.getCacheKey(noteId));
      if (!cacheData) return null;

      const { note, timestamp } = JSON.parse(cacheData);
      return note;
    } catch (error) {
      // Failed to load note from cache
      return null;
    }
  }

  // Save single note to cache
  saveNoteToCache(note) {
    try {
      const cacheData = {
        note: note,
        timestamp: Date.now()
      };
      localStorage.setItem(this.getCacheKey(note.id), JSON.stringify(cacheData));
      
      // Also update the note in the all notes cache
      this.updateNoteInAllNotesCache(note);
    } catch (error) {
      // Failed to save note to cache
    }
  }

  // Update a single note in the all notes cache
  updateNoteInAllNotesCache(updatedNote) {
    try {
      const cacheData = localStorage.getItem(this.getAllNotesKey());
      if (!cacheData) return;

      const { notes, timestamp } = JSON.parse(cacheData);
      if (!notes) return;

      // Find and update the note, or add if new
      const noteIndex = notes.findIndex(note => note.id === updatedNote.id);
      if (noteIndex >= 0) {
        notes[noteIndex] = updatedNote;
      } else {
        notes.unshift(updatedNote); // Add new note to beginning
      }

      // Save updated cache
      const newCacheData = {
        notes: notes,
        timestamp: timestamp // Keep original timestamp
      };
      localStorage.setItem(this.getAllNotesKey(), JSON.stringify(newCacheData));
    } catch (error) {
      // Failed to update note in all notes cache
    }
  }

  // Remove note from cache
  removeNoteFromCache(noteId) {
    try {
      // Remove individual note cache
      localStorage.removeItem(this.getCacheKey(noteId));
      
      // Remove from all notes cache
      const cacheData = localStorage.getItem(this.getAllNotesKey());
      if (cacheData) {
        const { notes, timestamp } = JSON.parse(cacheData);
        if (notes) {
          const filteredNotes = notes.filter(note => note.id !== noteId);
          const newCacheData = {
            notes: filteredNotes,
            timestamp: timestamp
          };
          localStorage.setItem(this.getAllNotesKey(), JSON.stringify(newCacheData));
        }
      }
    } catch (error) {
      // Failed to remove note from cache
    }
  }

  // Add note to sync queue
  addToSyncQueue(note, operation = 'update') {
    try {
      const queue = JSON.parse(localStorage.getItem(this.syncQueueKey) || '[]');
      
      // Remove any existing entry for this note to avoid duplicates
      const filteredQueue = queue.filter(item => item.noteId !== note.id);
      
      // Add new entry
      filteredQueue.push({
        noteId: note.id,
        note: note,
        operation: operation,
        timestamp: Date.now(),
        retries: 0
      });
      
      localStorage.setItem(this.syncQueueKey, JSON.stringify(filteredQueue));
      
      // Increment change count
      const changeCount = parseInt(localStorage.getItem(this.changeCountKey) || '0') + 1;
      localStorage.setItem(this.changeCountKey, changeCount.toString());
      
      // Check if we should sync now
      this.checkAndSync();
    } catch (error) {
      // Failed to add note to sync queue
    }
  }

  // Check if we should sync and do it
  async checkAndSync() {
    const changeCount = parseInt(localStorage.getItem(this.changeCountKey) || '0');
    const lastSync = parseInt(localStorage.getItem(this.lastSyncKey) || '0');
    const now = Date.now();
    const timeSinceLastSync = now - lastSync;
    
    // Sync if we have 10+ changes OR 30+ minutes have passed
    if (changeCount >= this.batchSyncThreshold || timeSinceLastSync >= this.batchSyncInterval) {
      await this.processSyncQueue();
    }
  }

  // Emergency sync - synchronous for beforeunload
  emergencySync() {
    const queue = JSON.parse(localStorage.getItem(this.syncQueueKey) || '[]');
    if (queue.length === 0) return;

    // Use sendBeacon for emergency sync (fire-and-forget)
    if (navigator.sendBeacon && window.supabaseClient) {
      try {
        const syncData = {
          notes: queue.map(item => ({
            id: item.note.id,
            operation: item.operation,
            note: item.note
          }))
        };
        
        const blob = new Blob([JSON.stringify(syncData)], { type: 'application/json' });
        const success = navigator.sendBeacon('/api/emergency-sync', blob);
        
        if (success) {
          // Clear queue on successful beacon
          localStorage.setItem(this.syncQueueKey, '[]');
          localStorage.setItem(this.changeCountKey, '0');
        }
      } catch (error) {
        // Emergency sync failed
      }
    }
  }

  // Process sync queue - batch API operations
  async processSyncQueue() {
    if (!window.supabaseClient) {
      // Supabase client not available for sync
      return;
    }

    try {
      const queue = JSON.parse(localStorage.getItem(this.syncQueueKey) || '[]');
      if (queue.length === 0) return;

      // Processing sync queue
      
      // Group operations by type
      const updates = queue.filter(item => item.operation === 'update');
      const deletions = queue.filter(item => item.operation === 'delete');
      
      let successCount = 0;
      let failedItems = [];

      // Process updates in batch
      if (updates.length > 0) {
        try {
          await this.batchUpdateNotes(updates.map(item => item.note));
          successCount += updates.length;
        } catch (error) {
          // Batch update failed
          failedItems.push(...updates);
        }
      }

      // Process deletions in batch
      if (deletions.length > 0) {
        try {
          await this.batchDeleteNotes(deletions.map(item => item.noteId));
          successCount += deletions.length;
        } catch (error) {
          // Batch delete failed
          failedItems.push(...deletions);
        }
      }

      // Update queue with failed items (with retry logic)
      const retryQueue = failedItems
        .map(item => ({ ...item, retries: (item.retries || 0) + 1 }))
        .filter(item => item.retries < this.maxRetries);

      localStorage.setItem(this.syncQueueKey, JSON.stringify(retryQueue));
      localStorage.setItem(this.changeCountKey, retryQueue.length.toString());
      localStorage.setItem(this.lastSyncKey, Date.now().toString());

      // Sync completed
    } catch (error) {
      // Sync queue processing failed
    }
  }

  // Batch update notes via API
  async batchUpdateNotes(notes) {
    if (!window.supabaseClient || notes.length === 0) return;

    // Prepare sync payload in the exact same format as extension
    const syncPayload = {
      operation: 'sync',
      notes: notes.map(note => ({
        id: note.id,
        title: note.title,
        content: note.content,
        url: note.url || '',
        domain: note.domain || '',
        tags: note.tags || [],
        createdAt: note.createdAt,
        updatedAt: note.updatedAt
      })),
      deletions: [],
      lastSyncTime: this.lastSyncTime,
      timestamp: Date.now()
    };

    // Use the same sync method as extension
    if (window.supabaseClient.syncNotes) {
      await window.supabaseClient.syncNotes(syncPayload);
    } else {
      throw new Error('Sync method not available');
    }
  }

  // Batch delete notes via API
  async batchDeleteNotes(noteIds) {
    if (!window.supabaseClient || noteIds.length === 0) return;

    // Use existing delete method from extension
    for (const noteId of noteIds) {
      if (window.supabaseClient.deleteNote) {
        await window.supabaseClient.deleteNote(noteId);
      }
    }
  }

  // Public API - Get all notes (cache-first, API-minimal)
  async getAllNotes() {
    // 1. Load from cache immediately
    const cachedNotes = await this.getAllNotesFromCache();
    
    // 2. Check if we need to fetch from API (once per day)
    const lastSync = parseInt(localStorage.getItem(this.lastSyncKey) || '0');
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const shouldFetchFromAPI = (now - lastSync) > oneDayMs;
    
    // 3. Return cached data immediately if available
    if (cachedNotes && cachedNotes.length > 0) {
      // Fetch from API in background if needed
      if (shouldFetchFromAPI) {
        this.fetchNotesFromAPI().catch(error => {
          // Background API fetch failed
        });
      }
      return cachedNotes;
    }
    
    // 4. No cache available - fetch from API synchronously
    if (shouldFetchFromAPI || !cachedNotes) {
      try {
        return await this.fetchNotesFromAPI();
      } catch (error) {
        // API fetch failed, returning empty array
        return [];
      }
    }
    
    return cachedNotes || [];
  }

  // Fetch notes from API and update cache
  async fetchNotesFromAPI() {
    if (!window.supabaseClient) {
      throw new Error('Supabase client not available');
    }

    try {
      // Use existing API method from extension - only get non-deleted notes
      let notes = [];
      if (window.supabaseClient.fetchNotes) {
        notes = await window.supabaseClient.fetchNotes();
      } else if (window.supabaseClient.getAllNotes) {
        notes = await window.supabaseClient.getAllNotes();
      } else if (window.supabaseClient.syncNotes) {
        // Fallback to sync method
        const syncResult = await window.supabaseClient.syncNotes([]);
        notes = syncResult.serverNotes || [];
      }

      // Filter out any deleted notes (safety check)
      notes = notes.filter(note => !note.is_deleted);

      // Decrypt notes if encryption is available
      const decryptedNotes = [];
      for (const note of notes) {
        try {
          if (note.title_encrypted && window.noteEncryption && window.supabaseClient.getUserEncryptionKey) {
            const userKey = await window.supabaseClient.getUserEncryptionKey();
            if (userKey) {
              const decryptedNote = await window.noteEncryption.decryptNoteFromCloud(note, userKey);
              decryptedNotes.push(decryptedNote);
            } else {
              decryptedNotes.push(note); // Add as-is if no key
            }
          } else {
            decryptedNotes.push(note); // Add unencrypted note
          }
        } catch (error) {
          // Failed to decrypt note
          decryptedNotes.push(note); // Add as-is on decrypt failure
        }
      }

      // Update cache
      this.saveNotesToCache(decryptedNotes);
      localStorage.setItem(this.lastSyncKey, Date.now().toString());

      return decryptedNotes;
    } catch (error) {
      // Failed to fetch notes from API
      throw error;
    }
  }

  // Public API - Get single note
  async getNote(noteId) {
    // Try cache first
    const cachedNote = await this.getNoteFromCache(noteId);
    if (cachedNote) {
      return cachedNote;
    }

    // Fallback to API if not in cache
    try {
      if (window.supabaseClient && window.supabaseClient.getNote) {
        const note = await window.supabaseClient.getNote(noteId);
        if (note) {
          this.saveNoteToCache(note);
        }
        return note;
      }
    } catch (error) {
      // Failed to fetch note from API
    }

    return null;
  }

  // Public API - Save note (cache immediately, queue for sync)
  async saveNote(note) {
    // Ensure note has required fields
    if (!note.id) {
      note.id = crypto.randomUUID();
    }
    if (!note.createdAt) {
      note.createdAt = new Date().toISOString();
    }
    note.updatedAt = new Date().toISOString();
    
    // Ensure URL and domain are present for compatibility with extension
    if (!note.url) {
      note.url = '';
    }
    if (!note.domain) {
      note.domain = '';
    }
    if (!note.tags) {
      note.tags = [];
    }

    // Save to cache immediately
    this.saveNoteToCache(note);
    
    // Add to sync queue
    this.addToSyncQueue(note, 'update');
    
    return note;
  }

  // Save note without triggering individual sync (for bulk operations like import)
  async saveNoteWithoutSync(note) {
    if (!note || !note.id) {
      throw new Error('Invalid note data');
    }
    if (!note.createdAt) {
      note.createdAt = new Date().toISOString();
    }
    note.updatedAt = new Date().toISOString();
    
    // Ensure URL and domain are present for compatibility with extension
    if (!note.url) {
      note.url = '';
    }
    if (!note.domain) {
      note.domain = '';
    }
    if (!note.tags) {
      note.tags = [];
    }

    // Save to cache immediately (but don't add to sync queue)
    this.saveNoteToCache(note);
    
    return note;
  }

  // Add multiple notes to sync queue in bulk (for import)
  addNotesToSyncQueue(notes) {
    try {
      const queue = JSON.parse(localStorage.getItem(this.syncQueueKey) || '[]');
      
      // Remove any existing entries for these notes to avoid duplicates
      const noteIds = notes.map(note => note.id);
      const filteredQueue = queue.filter(item => !noteIds.includes(item.noteId));
      
      // Add all notes to queue
      notes.forEach(note => {
        filteredQueue.push({
          noteId: note.id,
          note: note,
          operation: 'update',
          timestamp: Date.now(),
          retries: 0
        });
      });
      
      localStorage.setItem(this.syncQueueKey, JSON.stringify(filteredQueue));
      
      // Update change count
      const changeCount = parseInt(localStorage.getItem(this.changeCountKey) || '0') + notes.length;
      localStorage.setItem(this.changeCountKey, changeCount.toString());
      
    } catch (error) {
      console.error('Failed to add notes to sync queue:', error);
    }
  }

  // Public API - Delete note (remove from cache, queue for sync)
  async deleteNote(noteId) {
    // Remove from cache immediately
    this.removeNoteFromCache(noteId);
    
    // Add to sync queue
    this.addToSyncQueue({ id: noteId }, 'delete');
    
    return true;
  }

  // Public API - Search notes (cache-only for performance)
  async searchNotes(query, domain = null) {
    const allNotes = await this.getAllNotesFromCache() || [];
    const searchTerm = query.toLowerCase();
    
    return allNotes.filter(note => {
      // Filter by domain if specified
      if (domain && note.domain !== domain) {
        return false;
      }
      
      // Search in title, content, and tags
      return note.title?.toLowerCase().includes(searchTerm) ||
             note.content?.toLowerCase().includes(searchTerm) ||
             (note.tags && note.tags.some(tag => tag.toLowerCase().includes(searchTerm)));
    }).sort((a, b) => {
      // Sort by relevance (title matches first, then by update time)
      const aTitle = a.title?.toLowerCase().includes(searchTerm);
      const bTitle = b.title?.toLowerCase().includes(searchTerm);
      
      if (aTitle && !bTitle) return -1;
      if (!aTitle && bTitle) return 1;
      
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  // Public API - Get notes by domain (cache-only)
  async getNotesByDomain(domain) {
    const allNotes = await this.getAllNotesFromCache() || [];
    return allNotes
      .filter(note => note.domain === domain)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // Public API - Get notes by URL (cache-only)
  async getNotesByUrl(url) {
    const allNotes = await this.getAllNotesFromCache() || [];
    return allNotes
      .filter(note => note.url === url)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  // Public API - Force sync now
  async forceSyncNow() {
    await this.processSyncQueue();
  }

  // Public API - Clear all cache (for debugging/reset)
  clearCache() {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(this.cachePrefix) || 
          key === this.metaKey || 
          key === this.syncQueueKey || 
          key === this.lastSyncKey || 
          key === this.changeCountKey) {
        localStorage.removeItem(key);
      }
    });
    
    // Reinitialize tracking
    this.initializeSyncTracking();
  }

  // Public API - Get sync status
  getSyncStatus() {
    const queue = JSON.parse(localStorage.getItem(this.syncQueueKey) || '[]');
    const changeCount = parseInt(localStorage.getItem(this.changeCountKey) || '0');
    const lastSync = parseInt(localStorage.getItem(this.lastSyncKey) || '0');
    
    return {
      pendingChanges: queue.length,
      totalChanges: changeCount,
      lastSync: lastSync ? new Date(lastSync) : null,
      nextSyncDue: changeCount >= this.batchSyncThreshold
    };
  }
}

// Export for use in web application
window.WebStorage = WebStorage;

// Initialize storage instance immediately
window.storage = new WebStorage();
