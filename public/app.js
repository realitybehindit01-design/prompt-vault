// PromptVault Pro Enterprise - Robust Client Architecture & Offline Synchronization

// Application State
const state = {
  activeTab: 'home', // 'home' | 'prompts' | 'folders' | 'projects' | 'favorites' | 'categories' | 'tutorials'
  prompts: [],
  folders: [],
  projects: [],
  categories: [],
  activeCategory: 'all',
  activeFolderId: null,
  activeProjectId: null,
  activeModel: 'all',
  searchQuery: '',
  activeTag: null,
  sortBy: 'newest',
  viewMode: 'grid',
  viewingPrompt: null,
  runningPrompt: null,
  historyPrompt: null,
  movingPromptId: null,
  pendingDeleteId: null,
  pendingDuplicatePayload: null,
  expandedPromptIds: new Set(),
  syncStatus: 'synced', // 'synced' | 'syncing' | 'offline' | 'error'
  offlineQueue: []
};

const API_BASE = '/api';

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initServiceWorker();
  initIndexedDB();
  setupEventListeners();
  loadData();
});

// ==================== INDEXEDDB & OFFLINE PERSISTENCE ====================

let dbInstance = null;

function initIndexedDB() {
  const request = indexedDB.open('PromptVaultEnterpriseDB', 1);

  request.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('prompts')) db.createObjectStore('prompts', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('syncQueue')) db.createObjectStore('syncQueue', { autoIncrement: true });
  };

  request.onsuccess = (e) => {
    dbInstance = e.target.result;
    loadLocalCachedData();
  };

  request.onerror = (e) => {
    console.warn('[IndexedDB] Could not open database:', e);
  };
}

function saveToIndexedDB(storeName, items) {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    items.forEach(item => store.put(item));
  } catch (err) {
    console.warn(`[IndexedDB] Error saving to ${storeName}:`, err);
  }
}

function loadLocalCachedData() {
  if (!dbInstance) return;
  try {
    const tx = dbInstance.transaction(['prompts', 'folders', 'projects'], 'readonly');
    
    tx.objectStore('prompts').getAll().onsuccess = (e) => {
      if (state.prompts.length === 0 && e.target.result.length > 0) {
        state.prompts = e.target.result;
        renderCurrentTab();
      }
    };
    tx.objectStore('folders').getAll().onsuccess = (e) => {
      if (state.folders.length === 0 && e.target.result.length > 0) {
        state.folders = e.target.result;
        populateFolderDropdowns();
      }
    };
    tx.objectStore('projects').getAll().onsuccess = (e) => {
      if (state.projects.length === 0 && e.target.result.length > 0) {
        state.projects = e.target.result;
        populateProjectDropdowns();
      }
    };
  } catch (err) {
    console.warn('[IndexedDB] Error loading cache:', err);
  }
}

// Service Worker for Offline PWA
function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js')
      .then(() => console.log('[PWA] Service Worker registered'))
      .catch((err) => console.log('[PWA] Service Worker registration failed:', err));
  }

  window.addEventListener('online', () => {
    updateSyncBadge('syncing');
    processOfflineSyncQueue();
  });

  window.addEventListener('offline', () => {
    updateSyncBadge('offline');
    showToast('Working in Offline Mode. Changes will sync automatically.', 'info');
  });
}

function updateSyncBadge(status) {
  state.syncStatus = status;
  const badge = document.getElementById('sync-status-badge');
  const text = document.getElementById('sync-status-text');
  if (!badge || !text) return;

  badge.classList.remove('hidden');

  if (status === 'synced') {
    badge.className = 'inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-900/60';
    text.textContent = 'Synced';
    badge.querySelector('span:first-child').className = 'w-2 h-2 rounded-full bg-emerald-500';
  } else if (status === 'syncing') {
    badge.className = 'inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-xl bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-900/60';
    text.textContent = 'Syncing...';
    badge.querySelector('span:first-child').className = 'w-2 h-2 rounded-full bg-indigo-500 animate-ping';
  } else if (status === 'offline') {
    badge.className = 'inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400 border border-amber-200 dark:border-amber-900/60';
    text.textContent = 'Offline Cached';
    badge.querySelector('span:first-child').className = 'w-2 h-2 rounded-full bg-amber-500';
  } else if (status === 'error') {
    badge.className = 'inline-flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-xl bg-red-50 dark:bg-red-950/60 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-900/60';
    text.textContent = 'Sync Failed';
    badge.querySelector('span:first-child').className = 'w-2 h-2 rounded-full bg-red-500';
  }
}

async function processOfflineSyncQueue() {
  if (state.offlineQueue.length === 0) {
    loadData();
    return;
  }

  try {
    const payload = {
      prompts: state.offlineQueue.filter(i => i.type === 'prompt').map(i => i.data),
      folders: state.offlineQueue.filter(i => i.type === 'folder').map(i => i.data)
    };

    const res = await fetch(`${API_BASE}/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json());

    if (res.status === 'success') {
      state.offlineQueue = [];
      updateSyncBadge('synced');
      showToast('All offline changes successfully synced!', 'success');
      loadData();
    }
  } catch (err) {
    updateSyncBadge('error');
  }
}

// ==================== THEME MANAGEMENT ====================

function initTheme() {
  const savedTheme = localStorage.getItem('promptvault_theme') || 'dark';
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('dark');
    document.getElementById('theme-icon-sun')?.classList.remove('hidden');
    document.getElementById('theme-icon-moon')?.classList.add('hidden');
  } else {
    document.documentElement.classList.remove('dark');
    document.getElementById('theme-icon-sun')?.classList.add('hidden');
    document.getElementById('theme-icon-moon')?.classList.remove('hidden');
  }
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('promptvault_theme', isDark ? 'dark' : 'light');
  document.getElementById('theme-icon-sun')?.classList.toggle('hidden', !isDark);
  document.getElementById('theme-icon-moon')?.classList.toggle('hidden', isDark);
}

// ==================== EVENT LISTENERS ====================

function setupEventListeners() {
  const searchInput = document.getElementById('search-input');
  const clearSearchBtn = document.getElementById('clear-search-btn');

  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener('input', (e) => {
      clearTimeout(debounceTimer);
      const val = e.target.value.trim();
      clearSearchBtn?.classList.toggle('hidden', val.length === 0);
      debounceTimer = setTimeout(() => {
        state.searchQuery = val;
        if (state.activeTab === 'home' && val.length > 0) {
          setActiveTab('prompts');
        } else {
          renderPrompts();
        }
      }, 150);
    });

    clearSearchBtn?.addEventListener('click', () => {
      searchInput.value = '';
      state.searchQuery = '';
      clearSearchBtn.classList.add('hidden');
      renderPrompts();
    });
  }

  // Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key === 'k') || (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA')) {
      e.preventDefault();
      searchInput?.focus();
    }
    if (e.key === 'Escape') {
      closeAllModals();
    }
  });
}

// ==================== DATA LOADING ====================

async function loadData() {
  updateSyncBadge('syncing');
  try {
    const [promptsRes, foldersRes, projectsRes, catsRes, statsRes] = await Promise.all([
      fetch(`${API_BASE}/prompts`).then(r => r.json()),
      fetch(`${API_BASE}/folders`).then(r => r.json()),
      fetch(`${API_BASE}/projects`).then(r => r.json()),
      fetch(`${API_BASE}/categories`).then(r => r.json()),
      fetch(`${API_BASE}/stats`).then(r => r.json())
    ]);

    if (promptsRes.status === 'success') {
      state.prompts = promptsRes.data;
      saveToIndexedDB('prompts', state.prompts);
    }
    if (foldersRes.status === 'success') {
      state.folders = foldersRes.data;
      saveToIndexedDB('folders', state.folders);
    }
    if (projectsRes.status === 'success') {
      state.projects = projectsRes.data;
      saveToIndexedDB('projects', state.projects);
    }
    if (catsRes.status === 'success') state.categories = catsRes.data;
    if (statsRes.status === 'success') updateStatsDisplay(statsRes);

    populateFolderDropdowns();
    populateProjectDropdowns();
    populateCategoryDropdowns();
    renderCurrentTab();
    updateSyncBadge('synced');
  } catch (err) {
    console.error('Failed to load data:', err);
    updateSyncBadge('offline');
    loadLocalCachedData();
  }
}

function updateStatsDisplay(stats) {
  const total = stats.total_prompts || 0;
  const foldersCount = stats.total_folders || 0;
  const projectsCount = stats.total_projects || 0;
  const favs = stats.total_favorites || 0;
  const copies = stats.total_copies || 0;

  const topTotal = document.getElementById('top-badge-total');
  const topFolders = document.getElementById('top-badge-folders');
  const topProjects = document.getElementById('top-badge-projects');

  if (topTotal) topTotal.textContent = total;
  if (topFolders) topFolders.textContent = foldersCount;
  if (topProjects) topProjects.textContent = projectsCount;

  const homeTotal = document.getElementById('home-stat-total');
  const homeFolders = document.getElementById('home-stat-folders');
  const homeProjects = document.getElementById('home-stat-projects');
  const homeFavs = document.getElementById('home-stat-favs');
  const homeCopies = document.getElementById('home-stat-copies');

  if (homeTotal) homeTotal.textContent = total;
  if (homeFolders) homeFolders.textContent = foldersCount;
  if (homeProjects) homeProjects.textContent = projectsCount;
  if (homeFavs) homeFavs.textContent = favs;
  if (homeCopies) homeCopies.textContent = copies;
}

// Populate Dropdown Selects
function populateFolderDropdowns() {
  const quickFolder = document.getElementById('quick-folder');
  const formFolder = document.getElementById('form-folder');
  const moveFolder = document.getElementById('move-folder-select');
  const filterFolder = document.getElementById('filter-folder-select');
  const parentFolder = document.getElementById('form-folder-parent');

  const options = `
    <option value="">(None / Root)</option>
    ${state.folders.map(f => `
      <option value="${f.id}">${f.parent_id ? '  ↳ ' : ''}${escapeHtml(f.name)} (${f.prompt_count || 0})</option>
    `).join('')}
  `;

  if (quickFolder) quickFolder.innerHTML = options;
  if (formFolder) formFolder.innerHTML = options;
  if (moveFolder) moveFolder.innerHTML = options;
  if (parentFolder) parentFolder.innerHTML = options;

  if (filterFolder) {
    filterFolder.innerHTML = `
      <option value="all">All Folders</option>
      <option value="unassigned" ${state.activeFolderId === 'unassigned' ? 'selected' : ''}>📂 Unassigned (No Folder / Root)</option>
      ${state.folders.map(f => `
        <option value="${f.id}" ${state.activeFolderId == f.id ? 'selected' : ''}>${f.parent_id ? '↳ ' : ''}${escapeHtml(f.name)} (${f.prompt_count || 0})</option>
      `).join('')}
    `;
  }
}

function populateProjectDropdowns() {
  const formProj = document.getElementById('form-project');
  const moveProj = document.getElementById('move-project-select');
  const filterProj = document.getElementById('filter-project-select');
  const folderProj = document.getElementById('form-folder-project');

  const options = `
    <option value="">(None / Standalone)</option>
    ${state.projects.map(pr => `
      <option value="${pr.id}">${escapeHtml(pr.name)} ${pr.client ? `[${escapeHtml(pr.client)}]` : ''}</option>
    `).join('')}
  `;

  if (formProj) formProj.innerHTML = options;
  if (moveProj) moveProj.innerHTML = options;
  if (folderProj) folderProj.innerHTML = options;

  if (filterProj) {
    filterProj.innerHTML = `
      <option value="all">All Projects</option>
      ${state.projects.map(pr => `
        <option value="${pr.id}" ${state.activeProjectId == pr.id ? 'selected' : ''}>${escapeHtml(pr.name)}</option>
      `).join('')}
    `;
  }
}

function populateCategoryDropdowns() {
  const formCat = document.getElementById('form-category');
  const quickCat = document.getElementById('quick-category');

  const options = state.categories.map(c => `
    <option value="${escapeHtml(c.name)}">${escapeHtml(c.name)}</option>
  `).join('');

  if (formCat) formCat.innerHTML = options;
  if (quickCat) quickCat.innerHTML = options;
}

// ==================== TAB SWITCHING ====================

function setActiveTab(tab) {
  state.activeTab = tab;

  const navTabs = ['home', 'prompts', 'folders', 'projects', 'favorites', 'categories', 'tutorials'];
  navTabs.forEach(t => {
    const btn = document.getElementById(`nav-tab-${t}`);
    if (btn) {
      if (t === tab) {
        btn.className = 'px-3.5 py-1.5 rounded-xl transition-all bg-white dark:bg-slate-700 text-brand-600 dark:text-brand-400 font-bold shadow-xs flex items-center gap-1.5';
      } else {
        btn.className = 'px-3.5 py-1.5 rounded-xl transition-all text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5';
      }
    }
  });

  const views = {
    home: document.getElementById('view-tab-home'),
    prompts: document.getElementById('view-tab-prompts'),
    folders: document.getElementById('view-tab-folders'),
    projects: document.getElementById('view-tab-projects'),
    categories: document.getElementById('view-tab-categories'),
    tutorials: document.getElementById('view-tab-tutorials')
  };

  Object.keys(views).forEach(k => {
    if (k === tab || (tab === 'favorites' && k === 'prompts')) {
      views[k]?.classList.remove('hidden');
    } else {
      views[k]?.classList.add('hidden');
    }
  });

  renderCurrentTab();
}

function renderCurrentTab() {
  if (state.activeTab === 'home') renderHomeView();
  else if (state.activeTab === 'prompts' || state.activeTab === 'favorites') renderPrompts();
  else if (state.activeTab === 'folders') renderFoldersView();
  else if (state.activeTab === 'projects') renderProjectsView();
  else if (state.activeTab === 'categories') renderCategoriesView();
}

// ==================== 1. HOME DASHBOARD ====================

function renderHomeView() {
  renderHomeProjectsList();
  renderHomeFoldersList();
  renderHomeRecentPrompts();
}

function renderHomeProjectsList() {
  const container = document.getElementById('home-projects-list');
  if (!container) return;

  if (state.projects.length === 0) {
    container.innerHTML = '<div class="text-xs text-slate-400 py-3 text-center">No projects yet. Click "+ New Project" above.</div>';
    return;
  }

  container.innerHTML = state.projects.map(pr => `
    <div 
      onclick="filterByProject(${pr.id})" 
      class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 hover:border-indigo-500/50 cursor-pointer transition-all flex items-center justify-between group"
    >
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-8 h-8 rounded-xl bg-indigo-100 dark:bg-indigo-950/80 text-indigo-600 dark:text-indigo-400 flex items-center justify-center flex-shrink-0">
          <i data-lucide="briefcase" class="w-4 h-4"></i>
        </div>
        <div class="min-w-0">
          <h4 class="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-indigo-500">${escapeHtml(pr.name)}</h4>
          <span class="text-[10px] text-slate-400">${pr.client ? escapeHtml(pr.client) + ' • ' : ''}${pr.prompt_count || 0} prompts</span>
        </div>
      </div>
      <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform"></i>
    </div>
  `).join('');

  lucide.createIcons();
}

function renderHomeFoldersList() {
  const container = document.getElementById('home-folders-list');
  if (!container) return;

  if (state.folders.length === 0) {
    container.innerHTML = '<div class="text-xs text-slate-400 py-3 text-center">No folders yet. Click "+ New Folder" above.</div>';
    return;
  }

  container.innerHTML = state.folders.slice(0, 6).map(f => `
    <div 
      onclick="filterByFolder(${f.id})" 
      class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 hover:border-amber-500/50 cursor-pointer transition-all flex items-center justify-between group"
    >
      <div class="flex items-center gap-2.5 min-w-0">
        <div class="w-8 h-8 rounded-xl bg-amber-100 dark:bg-amber-950/80 text-amber-600 dark:text-amber-400 flex items-center justify-center flex-shrink-0">
          <i data-lucide="${f.parent_id ? 'corner-down-right' : 'folder'}" class="w-4 h-4"></i>
        </div>
        <div class="min-w-0">
          <h4 class="text-xs font-bold text-slate-900 dark:text-slate-100 truncate group-hover:text-amber-500">${escapeHtml(f.name)}</h4>
          <span class="text-[10px] text-slate-400">${f.prompt_count || 0} prompts ${f.project_name ? `• ${escapeHtml(f.project_name)}` : ''}</span>
        </div>
      </div>
      <i data-lucide="chevron-right" class="w-4 h-4 text-slate-400 group-hover:translate-x-0.5 transition-transform"></i>
    </div>
  `).join('');

  lucide.createIcons();
}

function renderHomeRecentPrompts() {
  const container = document.getElementById('home-recent-prompts-grid');
  if (!container) return;

  const recent = [...state.prompts].slice(0, 6);
  container.innerHTML = recent.map(p => renderPromptCard(p)).join('');
  lucide.createIcons();
}

// ==================== 2. PROMPTS LISTING ====================

function getFilteredPrompts() {
  let list = [...state.prompts];

  if (state.activeTab === 'favorites') {
    list = list.filter(p => p.is_favorite === 1);
  }

  if (state.activeFolderId !== null) {
    list = list.filter(p => p.folder_id == state.activeFolderId);
  }

  if (state.activeProjectId !== null) {
    list = list.filter(p => p.project_id == state.activeProjectId);
  }

  if (state.activeCategory !== 'all') {
    list = list.filter(p => p.category.toLowerCase() === state.activeCategory.toLowerCase());
  }

  if (state.activeModel !== 'all') {
    list = list.filter(p => (p.ai_model || '').toLowerCase().includes(state.activeModel.toLowerCase()));
  }

  if (state.activeTag) {
    list = list.filter(p => (p.tags || []).some(t => t.toLowerCase() === state.activeTag.toLowerCase()));
  }

  if (state.searchQuery) {
    const q = state.searchQuery.toLowerCase();
    list = list.filter(p => {
      return (p.title && p.title.toLowerCase().includes(q)) ||
             (p.prompt_text && p.prompt_text.toLowerCase().includes(q)) ||
             (p.system_prompt && p.system_prompt.toLowerCase().includes(q)) ||
             (p.folder_name && p.folder_name.toLowerCase().includes(q)) ||
             (p.project_name && p.project_name.toLowerCase().includes(q)) ||
             (p.tags && p.tags.some(t => t.toLowerCase().includes(q)));
    });
  }

  if (state.sortBy === 'newest') {
    list.sort((a, b) => new Date(b.created_at || b.updated_at) - new Date(a.created_at || a.updated_at));
  } else if (state.sortBy === 'popular') {
    list.sort((a, b) => (b.usage_count || b.copy_count || 0) - (a.usage_count || a.copy_count || 0));
  } else if (state.sortBy === 'alpha') {
    list.sort((a, b) => a.title.localeCompare(b.title));
  } else if (state.sortBy === 'favorites') {
    list.sort((a, b) => (b.is_favorite || 0) - (a.is_favorite || 0));
  }

  return list;
}

function renderPrompts() {
  const filtered = getFilteredPrompts();
  const grid = document.getElementById('prompts-grid');
  const emptyState = document.getElementById('empty-state');
  const countBadge = document.getElementById('results-count-badge');
  const viewTitle = document.getElementById('current-view-title');

  if (countBadge) countBadge.textContent = `${filtered.length} prompt${filtered.length === 1 ? '' : 's'}`;
  
  if (viewTitle) {
    if (state.activeTab === 'favorites') {
      viewTitle.textContent = 'Starred Favorites';
    } else if (state.activeFolderId === 'unassigned') {
      viewTitle.innerHTML = `
        <div class="flex items-center gap-2">
          <i data-lucide="folder-x" class="w-5 h-5 text-amber-500"></i>
          <span>Unassigned Prompts <span class="text-xs font-normal text-slate-400">(Need to be moved into Folders)</span></span>
        </div>
      `;
    } else if (state.activeFolderId) {
      const f = state.folders.find(item => item.id == state.activeFolderId);
      if (f) {
        viewTitle.innerHTML = `
          <div class="flex items-center gap-3 flex-wrap">
            <span class="flex items-center gap-1.5">
              <i data-lucide="folder-open" class="w-5 h-5 text-amber-500"></i>
              <span>Folder: <strong class="text-amber-600 dark:text-amber-400">${escapeHtml(f.name)}</strong></span>
            </span>
            <button onclick="openAddPromptModal(${f.id})" class="text-xs px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold shadow-md flex items-center gap-1.5 transform active:scale-95 transition-all">
              <i data-lucide="plus-circle" class="w-4 h-4"></i>
              <span>+ Add Prompt Here</span>
            </button>
          </div>
        `;
      } else {
        viewTitle.textContent = 'Folder Prompts';
      }
    } else if (state.activeProjectId) {
      const pr = state.projects.find(item => item.id == state.activeProjectId);
      viewTitle.textContent = pr ? `Project: ${pr.name}` : 'Project Prompts';
    } else {
      viewTitle.textContent = 'All Prompts';
    }
  }

  renderActiveFilters();

  if (!grid) return;

  if (filtered.length === 0) {
    grid.innerHTML = '';
    emptyState?.classList.remove('hidden');
    return;
  }

  emptyState?.classList.add('hidden');

  if (state.viewMode === 'grid') {
    grid.className = 'grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5';
    grid.innerHTML = filtered.map(p => renderPromptCard(p)).join('');
  } else {
    grid.className = 'flex flex-col gap-3';
    grid.innerHTML = filtered.map(p => renderPromptListItem(p)).join('');
  }

  lucide.createIcons();
}

function renderPromptCard(p) {
  const hasVars = p.variables && p.variables.length > 0;
  const isFav = p.is_favorite === 1;
  const isExpanded = state.expandedPromptIds.has(p.id);
  const formattedPrompt = highlightVariablesInText(escapeHtml(p.prompt_text));
  const isLong = p.prompt_text.length > 170;
  const versionNum = p.current_version || 1;

  return `
    <div class="prompt-card bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800/90 p-5 flex flex-col justify-between shadow-xs hover:shadow-md hover:border-brand-500/50 dark:hover:border-brand-500/50 transition-all group">
      
      <div>
        <!-- Badges & Action Bar -->
        <div class="flex items-center justify-between gap-2 mb-3">
          <div class="flex items-center gap-1.5 flex-wrap">
            ${p.folder_name ? `
              <span onclick="filterByFolder(${p.folder_id})" class="cursor-pointer text-[10px] font-bold px-2 py-0.5 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200/50 flex items-center gap-1">
                <i data-lucide="folder" class="w-3 h-3"></i>
                <span>${escapeHtml(p.folder_name)}</span>
              </span>
            ` : `
              <button onclick="event.stopPropagation(); openMoveModal(${p.id})" title="Click to assign this prompt to any folder" class="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-amber-50/70 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-dashed border-amber-300 dark:border-amber-700 hover:bg-amber-100 flex items-center gap-1">
                <i data-lucide="folder-plus" class="w-3 h-3"></i>
                <span>+ Add to Folder</span>
              </button>
            `}
            <span class="text-[10px] font-bold px-2 py-0.5 rounded-lg bg-brand-50 dark:bg-brand-950/60 text-brand-700 dark:text-brand-300 border border-brand-200/50">
              ${escapeHtml(p.category)}
            </span>
            <span class="text-[10px] font-mono font-bold px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-800 text-slate-500" title="Version ${versionNum}">
              v${versionNum}
            </span>
          </div>
          
          <!-- Actions -->
          <div class="flex items-center gap-0.5">
            <button onclick="event.stopPropagation(); openMoveModal(${p.id})" title="Move to Folder" class="p-1.5 rounded-lg text-slate-400 hover:text-amber-500">
              <i data-lucide="folder-input" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="event.stopPropagation(); duplicatePrompt(${p.id})" title="Duplicate Prompt" class="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500">
              <i data-lucide="copy-plus" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="event.stopPropagation(); openHistoryModal(${p.id})" title="Revision History" class="p-1.5 rounded-lg text-slate-400 hover:text-brand-500">
              <i data-lucide="history" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="event.stopPropagation(); toggleFavorite(${p.id})" title="${isFav ? 'Unstar' : 'Favorite'}" class="p-1.5 rounded-lg text-slate-400 hover:text-amber-500">
              <i data-lucide="star" class="w-4 h-4 ${isFav ? 'text-amber-500 fill-amber-500' : ''}"></i>
            </button>
            <button onclick="event.stopPropagation(); openEditPromptModal(${p.id})" title="Edit" class="p-1.5 rounded-lg text-slate-400 hover:text-brand-600">
              <i data-lucide="edit" class="w-3.5 h-3.5"></i>
            </button>
            <button onclick="event.stopPropagation(); openDeleteConfirm(${p.id})" title="Delete" class="p-1.5 rounded-lg text-slate-400 hover:text-red-500">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>

        <!-- Title -->
        <h3 class="font-bold text-base text-slate-900 dark:text-slate-100 mb-2 cursor-pointer hover:text-brand-600 transition-colors line-clamp-1" onclick="openViewModal(${p.id})">
          ${escapeHtml(p.title)}
        </h3>

        <!-- Prompt Text with In-Place Expand -->
        <div class="relative mb-2">
          <div onclick="openViewModal(${p.id})" class="p-3.5 rounded-2xl bg-slate-50 dark:bg-slate-950/70 border border-slate-200/80 dark:border-slate-800/80 text-xs font-mono text-slate-700 dark:text-slate-300 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-950 leading-relaxed ${isExpanded ? 'whitespace-pre-wrap' : 'line-clamp-4'}">
            ${formattedPrompt}
          </div>

          ${isLong ? `
            <div class="flex justify-end mt-1">
              <button onclick="event.stopPropagation(); toggleExpandCard(${p.id})" class="text-[11px] font-bold text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-0.5">
                <span>${isExpanded ? 'Show Less' : 'Expand Full'}</span>
                <i data-lucide="${isExpanded ? 'chevron-up' : 'chevron-down'}" class="w-3 h-3"></i>
              </button>
            </div>
          ` : ''}
        </div>

        <!-- Tags List -->
        ${p.tags && p.tags.length > 0 ? `
          <div class="flex flex-wrap gap-1 mb-3">
            ${p.tags.slice(0, 3).map(tag => `
              <span onclick="event.stopPropagation(); filterByTag('${escapeHtml(tag)}')" class="cursor-pointer text-[10px] font-medium px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-brand-600">
                #${escapeHtml(tag)}
              </span>
            `).join('')}
          </div>
        ` : ''}
      </div>

      <!-- Card Footer Actions -->
      <div class="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 mt-auto">
        <span class="text-[11px] text-slate-400 flex items-center gap-1 font-medium" title="${p.usage_count || 0} times used">
          <i data-lucide="zap" class="w-3 h-3 text-amber-500"></i>
          <span>${p.usage_count || p.copy_count || 0}</span>
        </span>

        <div class="flex items-center gap-1.5">
          ${hasVars ? `
            <button onclick="openVariablesRunner(${p.id})" class="px-2.5 py-1.5 rounded-xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 dark:text-indigo-400 border border-indigo-200/60 text-xs font-semibold hover:bg-indigo-100 flex items-center gap-1">
              <i data-lucide="sliders" class="w-3 h-3"></i>
              <span>Fill</span>
            </button>
          ` : ''}

          <button onclick="copyPromptCard(${p.id}, this)" class="px-3.5 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm transition-all transform active:scale-95">
            <i data-lucide="copy" class="w-3.5 h-3.5"></i>
            <span>Copy</span>
          </button>
        </div>
      </div>

    </div>
  `;
}

function renderPromptListItem(p) {
  const isFav = p.is_favorite === 1;
  const versionNum = p.current_version || 1;

  return `
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 p-3.5 flex items-center justify-between gap-4 shadow-xs hover:border-brand-500/40 transition-all">
      <div class="flex items-center gap-3 min-w-0 flex-1 cursor-pointer" onclick="openViewModal(${p.id})">
        <button onclick="event.stopPropagation(); toggleFavorite(${p.id})" class="text-slate-400 hover:text-amber-500">
          <i data-lucide="star" class="w-4 h-4 ${isFav ? 'text-amber-500 fill-amber-500' : ''}"></i>
        </button>
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 mb-0.5">
            <h4 class="font-bold text-sm text-slate-900 dark:text-slate-100 truncate">${escapeHtml(p.title)}</h4>
            ${p.folder_name ? `
              <span class="text-[10px] font-bold px-2 py-0.2 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300">${escapeHtml(p.folder_name)}</span>
            ` : `
              <button onclick="event.stopPropagation(); openMoveModal(${p.id})" class="text-[10px] font-bold px-2 py-0.2 rounded bg-amber-50 dark:bg-amber-950 text-amber-600 dark:text-amber-400 border border-dashed border-amber-300 hover:bg-amber-100 flex items-center gap-0.5" title="Click to assign to a folder">
                <i data-lucide="folder-plus" class="w-3 h-3"></i>
                <span>+ Add Folder</span>
              </button>
            `}
            <span class="text-[10px] font-bold px-2 py-0.2 rounded bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300">${escapeHtml(p.category)}</span>
            <span class="text-[10px] font-mono text-slate-400">v${versionNum}</span>
          </div>
          <p class="text-xs text-slate-400 font-mono truncate">${escapeHtml(p.prompt_text)}</p>
        </div>
      </div>

      <div class="flex items-center gap-1.5 flex-shrink-0">
        <button onclick="openMoveModal(${p.id})" title="Move to Folder" class="p-1.5 rounded-lg text-slate-400 hover:text-amber-500">
          <i data-lucide="folder-input" class="w-4 h-4"></i>
        </button>
        <button onclick="duplicatePrompt(${p.id})" title="Duplicate" class="p-1.5 rounded-lg text-slate-400 hover:text-indigo-500">
          <i data-lucide="copy-plus" class="w-4 h-4"></i>
        </button>
        <button onclick="openHistoryModal(${p.id})" title="History" class="p-1.5 rounded-lg text-slate-400 hover:text-brand-500">
          <i data-lucide="history" class="w-4 h-4"></i>
        </button>
        <button onclick="copyPromptCard(${p.id}, this)" class="px-3 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-semibold flex items-center gap-1.5 ml-1">
          <i data-lucide="copy" class="w-3.5 h-3.5"></i>
          <span>Copy</span>
        </button>
      </div>
    </div>
  `;
}

function toggleExpandCard(promptId) {
  if (state.expandedPromptIds.has(promptId)) state.expandedPromptIds.delete(promptId);
  else state.expandedPromptIds.add(promptId);
  if (state.activeTab === 'home') renderHomeRecentPrompts();
  else renderPrompts();
}

// Filter Actions
function filterByFolder(folderId) {
  state.activeFolderId = folderId;
  setActiveTab('prompts');
}

function filterByProject(projectId) {
  state.activeProjectId = projectId;
  setActiveTab('prompts');
}

function filterByModel(model) {
  state.activeModel = model;
  renderPrompts();
}

function filterByTag(tag) {
  state.activeTag = tag;
  if (state.activeTab === 'home') setActiveTab('prompts');
  renderPrompts();
}

function onFilterFolderChange(val) {
  state.activeFolderId = val === 'all' ? null : parseInt(val);
  renderPrompts();
}

function onFilterProjectChange(val) {
  state.activeProjectId = val === 'all' ? null : parseInt(val);
  renderPrompts();
}

function onSortChange(val) {
  state.sortBy = val;
  renderPrompts();
}

function setViewMode(mode) {
  state.viewMode = mode;
  const gridBtn = document.getElementById('view-grid-btn');
  const listBtn = document.getElementById('view-list-btn');

  if (mode === 'grid') {
    gridBtn.className = 'p-1.5 rounded-lg bg-white dark:bg-slate-700 shadow-xs text-brand-600 dark:text-brand-400';
    listBtn.className = 'p-1.5 rounded-lg text-slate-500 hover:text-slate-800';
  } else {
    listBtn.className = 'p-1.5 rounded-lg bg-white dark:bg-slate-700 shadow-xs text-brand-600 dark:text-brand-400';
    gridBtn.className = 'p-1.5 rounded-lg text-slate-500 hover:text-slate-800';
  }
  renderPrompts();
}

function renderActiveFilters() {
  const container = document.getElementById('active-filters-container');
  const list = document.getElementById('active-filters-list');
  const chips = [];

  if (state.activeFolderId !== null) {
    const f = state.folders.find(item => item.id == state.activeFolderId);
    chips.push({ label: `Folder: ${f ? f.name : state.activeFolderId}`, clear: () => { state.activeFolderId = null; renderPrompts(); } });
  }
  if (state.activeProjectId !== null) {
    const pr = state.projects.find(item => item.id == state.activeProjectId);
    chips.push({ label: `Project: ${pr ? pr.name : state.activeProjectId}`, clear: () => { state.activeProjectId = null; renderPrompts(); } });
  }
  if (state.activeModel !== 'all') {
    chips.push({ label: `Model: ${state.activeModel}`, clear: () => { state.activeModel = 'all'; renderPrompts(); } });
  }
  if (state.activeTag) {
    chips.push({ label: `Tag: #${state.activeTag}`, clear: () => { state.activeTag = null; renderPrompts(); } });
  }
  if (state.searchQuery) {
    chips.push({ label: `Search: "${state.searchQuery}"`, clear: () => {
      const input = document.getElementById('search-input');
      if (input) input.value = '';
      state.searchQuery = '';
      document.getElementById('clear-search-btn')?.classList.add('hidden');
      renderPrompts();
    }});
  }

  if (chips.length > 0) {
    container?.classList.remove('hidden');
    if (list) {
      list.innerHTML = chips.map((c, i) => `
        <span class="inline-flex items-center gap-1 text-xs px-2.5 py-0.5 rounded-lg bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 font-semibold border border-brand-200/50">
          ${escapeHtml(c.label)}
          <button onclick="removeFilter(${i})" class="hover:text-brand-900">
            <i data-lucide="x" class="w-3 h-3"></i>
          </button>
        </span>
      `).join('');
    }
    window._activeFilterCallbacks = chips.map(c => c.clear);
  } else {
    container?.classList.add('hidden');
  }
}

window.removeFilter = function(index) {
  if (window._activeFilterCallbacks && window._activeFilterCallbacks[index]) {
    window._activeFilterCallbacks[index]();
  }
};

function clearAllFilters() {
  state.activeFolderId = null;
  state.activeProjectId = null;
  state.activeModel = 'all';
  state.activeTag = null;
  state.searchQuery = '';
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  document.getElementById('clear-search-btn')?.classList.add('hidden');
  renderPrompts();
}

// ==================== 3. FOLDERS & NESTED SUBFOLDERS ====================

function renderFoldersView() {
  const container = document.getElementById('folders-full-tree');
  if (!container) return;

  if (state.folders.length === 0) {
    container.innerHTML = '<div class="text-center py-12 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 text-slate-400">No folders created yet. Click "New Folder" to start.</div>';
    return;
  }

  const rootFolders = state.folders.filter(f => !f.parent_id);
  const subfoldersMap = {};
  state.folders.filter(f => f.parent_id).forEach(sub => {
    if (!subfoldersMap[sub.parent_id]) subfoldersMap[sub.parent_id] = [];
    subfoldersMap[sub.parent_id].push(sub);
  });

  const html = rootFolders.map(parent => {
    const subList = subfoldersMap[parent.id] || [];

    return `
      <div class="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs space-y-3">
        <div class="flex items-center justify-between flex-wrap gap-2">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-2xl bg-amber-100 dark:bg-amber-950/80 text-amber-600 dark:text-amber-400 flex items-center justify-center font-bold">
              <i data-lucide="folder" class="w-5 h-5"></i>
            </div>
            <div>
              <h3 class="font-bold text-base text-slate-900 dark:text-slate-100 flex items-center gap-2">
                <span>${escapeHtml(parent.name)}</span>
                ${parent.project_name ? `<span class="text-[10px] font-semibold px-2 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600">[${escapeHtml(parent.project_name)}]</span>` : ''}
              </h3>
              <p class="text-xs text-slate-400">${parent.prompt_count || 0} prompts • ${subList.length} subfolders</p>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button onclick="openAddPromptModal(${parent.id})" class="px-3 py-1.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 text-xs font-semibold border border-emerald-200/50 hover:bg-emerald-100 flex items-center gap-1" title="Create prompt inside this folder">
              <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i>
              <span>+ Prompt</span>
            </button>
            <button onclick="openAddSubfolderModal(${parent.id})" class="px-3 py-1.5 rounded-xl bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 text-xs font-semibold border border-amber-200/50 hover:bg-amber-100 flex items-center gap-1">
              <i data-lucide="folder-plus" class="w-3.5 h-3.5"></i>
              <span>+ Subfolder</span>
            </button>
            <button onclick="openMoveFolderModal(${parent.id})" class="p-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-amber-600 border border-slate-200 dark:border-slate-700" title="Move Folder into another Folder">
              <i data-lucide="folder-input" class="w-4 h-4"></i>
            </button>
            <button onclick="openEditFolderModal(${parent.id})" class="p-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:text-brand-600 border border-slate-200 dark:border-slate-700" title="Rename Folder">
              <i data-lucide="edit" class="w-4 h-4"></i>
            </button>
            <button onclick="filterByFolder(${parent.id})" class="px-3.5 py-1.5 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-sm">
              View Prompts
            </button>
            <button onclick="deleteFolderPrompt(${parent.id}, '${escapeHtml(parent.name)}')" class="p-1.5 rounded-lg text-slate-400 hover:text-red-600" title="Delete Folder">
              <i data-lucide="trash-2" class="w-4 h-4"></i>
            </button>
          </div>
        </div>

        ${subList.length > 0 ? `
          <div class="pt-3 border-t border-slate-100 dark:border-slate-800/80 pl-6 space-y-2">
            <span class="text-[11px] font-bold text-slate-400 uppercase">Nested Subfolders:</span>
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
              ${subList.map(sub => `
                <div class="p-3 rounded-2xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700/60 flex items-center justify-between">
                  <div class="flex items-center gap-2 min-w-0">
                    <i data-lucide="corner-down-right" class="w-3.5 h-3.5 text-amber-500"></i>
                    <span class="font-bold text-xs text-slate-800 dark:text-slate-200 truncate">${escapeHtml(sub.name)}</span>
                    <span class="text-[10px] text-slate-400">(${sub.prompt_count || 0})</span>
                  </div>
                  <div class="flex items-center gap-1">
                    <button onclick="openAddPromptModal(${sub.id})" class="p-1 text-slate-400 hover:text-emerald-500" title="Create prompt inside this subfolder">
                      <i data-lucide="plus-circle" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="openMoveFolderModal(${sub.id})" class="p-1 text-slate-400 hover:text-amber-500" title="Move Subfolder">
                      <i data-lucide="folder-input" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="openEditFolderModal(${sub.id})" class="p-1 text-slate-400 hover:text-brand-500" title="Rename Subfolder">
                      <i data-lucide="edit" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="filterByFolder(${sub.id})" class="p-1 text-brand-600 hover:text-brand-500" title="View Prompts">
                      <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
                    </button>
                    <button onclick="deleteFolderPrompt(${sub.id}, '${escapeHtml(sub.name)}')" class="p-1 text-slate-400 hover:text-red-500" title="Delete">
                      <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                    </button>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  lucide.createIcons();
}

// Move Folder Modal Handlers
function openMoveFolderModal(folderId) {
  const f = state.folders.find(item => item.id === folderId);
  if (!f) return;

  state.movingFolderId = folderId;
  const nameEl = document.getElementById('move-folder-target-name');
  if (nameEl) nameEl.textContent = `Moving "${f.name}" to another parent folder or Root`;

  const parentSelect = document.getElementById('move-folder-parent-select');
  const projectSelect = document.getElementById('move-folder-project-select');

  // Filter out the folder itself and its own subfolders to prevent circular nesting
  const validParents = state.folders.filter(item => item.id !== folderId && item.parent_id !== folderId);

  if (parentSelect) {
    parentSelect.innerHTML = `
      <option value="">(Top-Level / Root Folder)</option>
      ${validParents.map(item => `
        <option value="${item.id}" ${f.parent_id == item.id ? 'selected' : ''}>${item.parent_id ? '↳ ' : ''}${escapeHtml(item.name)}</option>
      `).join('')}
    `;
  }

  if (projectSelect) {
    projectSelect.innerHTML = `
      <option value="">(None / General)</option>
      ${state.projects.map(pr => `
        <option value="${pr.id}" ${f.project_id == pr.id ? 'selected' : ''}>${escapeHtml(pr.name)}</option>
      `).join('')}
    `;
  }

  openModal('modal-move-folder');
}

async function executeMoveFolder() {
  if (!state.movingFolderId) return;

  const parentId = document.getElementById('move-folder-parent-select').value || null;
  const projectId = document.getElementById('move-folder-project-select').value || null;

  try {
    const res = await fetch(`${API_BASE}/folders/${state.movingFolderId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_id: parentId ? parseInt(parentId) : null,
        project_id: projectId ? parseInt(projectId) : null
      })
    }).then(r => r.json());

    if (res.status === 'success') {
      showToast('Folder moved successfully!', 'success');
      closeModal('modal-move-folder');
      state.movingFolderId = null;
      loadData();
    } else {
      showToast(res.detail || 'Failed to move folder', 'error');
    }
  } catch (err) {
    showToast('Failed to move folder', 'error');
  }
}

function openEditFolderModal(folderId) {
  const f = state.folders.find(item => item.id === folderId);
  if (!f) return;

  document.getElementById('folder-modal-title').textContent = 'Edit Folder';
  document.getElementById('form-folder-id').value = f.id;
  document.getElementById('form-folder-name').value = f.name;
  document.getElementById('form-folder-parent').value = f.parent_id || '';
  document.getElementById('form-folder-project').value = f.project_id || '';
  openModal('modal-folder-form');
}

function openAddFolderModal() {
  document.getElementById('folder-modal-title').textContent = 'Create Folder / Subfolder';
  document.getElementById('form-folder-id').value = '';
  document.getElementById('folder-form').reset();
  populateFolderDropdowns();
  populateProjectDropdowns();
  openModal('modal-folder-form');
}

function openAddSubfolderModal(parentId) {
  openAddFolderModal();
  document.getElementById('form-folder-parent').value = parentId;
}

async function handleFolderSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('form-folder-name').value.trim();
  const parentId = document.getElementById('form-folder-parent').value || null;
  const projId = document.getElementById('form-folder-project').value || null;

  if (!name) return;

  const payload = {
    name: name,
    parent_id: parentId ? parseInt(parentId) : null,
    project_id: projId ? parseInt(projId) : null
  };

  try {
    const res = await fetch(`${API_BASE}/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json());

    if (res.status === 'success') {
      showToast(`Folder "${name}" created successfully!`, 'success');
      closeModal('modal-folder-form');
      loadData();
    }
  } catch (err) {
    state.offlineQueue.push({ type: 'folder', data: payload });
    showToast(`Folder saved locally (Offline queue)`, 'info');
    closeModal('modal-folder-form');
  }
}

async function deleteFolderPrompt(folderId, name) {
  const confirmDel = confirm(`Delete folder "${name}"? Contained prompts will be safely moved to Root.`);
  if (!confirmDel) return;

  try {
    const res = await fetch(`${API_BASE}/folders/${folderId}`, { method: 'DELETE' }).then(r => r.json());
    if (res.status === 'success') {
      showToast(`Folder "${name}" deleted`, 'success');
      loadData();
    }
  } catch (err) {
    showToast('Failed to delete folder', 'error');
  }
}

// ==================== 4. PROJECTS WORKSPACE ====================

function renderProjectsView() {
  const container = document.getElementById('projects-full-grid');
  if (!container) return;

  if (state.projects.length === 0) {
    container.innerHTML = '<div class="col-span-3 text-center py-12 bg-white dark:bg-slate-900 rounded-3xl border border-slate-200 dark:border-slate-800 text-slate-400">No project workspaces yet. Click "+ New Project" above.</div>';
    return;
  }

  const html = state.projects.map(pr => `
    <div class="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col justify-between space-y-4">
      <div>
        <div class="flex items-start justify-between gap-3 mb-3">
          <div class="w-10 h-10 rounded-2xl bg-indigo-100 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 flex items-center justify-center">
            <i data-lucide="briefcase" class="w-5 h-5"></i>
          </div>
          <button onclick="deleteProjectPrompt(${pr.id}, '${escapeHtml(pr.name)}')" class="p-1.5 rounded-lg text-slate-400 hover:text-red-500">
            <i data-lucide="trash-2" class="w-4 h-4"></i>
          </button>
        </div>

        <h3 class="font-bold text-base text-slate-900 dark:text-slate-100">${escapeHtml(pr.name)}</h3>
        ${pr.client ? `<p class="text-xs font-semibold text-brand-600 dark:text-brand-400 mb-1">Client: ${escapeHtml(pr.client)}</p>` : ''}
        <p class="text-xs text-slate-500 leading-relaxed line-clamp-2">${escapeHtml(pr.description || 'No description.')}</p>
      </div>

      <div class="pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <span class="text-xs text-slate-400 font-medium">${pr.prompt_count || 0} prompts • ${pr.folder_count || 0} folders</span>
        <button onclick="filterByProject(${pr.id})" class="px-3.5 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold shadow-sm">
          Open Project
        </button>
      </div>
    </div>
  `).join('');

  container.innerHTML = html;
  lucide.createIcons();
}

function openAddProjectModal() {
  document.getElementById('project-modal-title').textContent = 'Create Project Workspace';
  document.getElementById('form-project-id').value = '';
  document.getElementById('project-form').reset();
  openModal('modal-project-form');
}

async function handleProjectSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('form-project-name').value.trim();
  const client = document.getElementById('form-project-client').value.trim();
  const desc = document.getElementById('form-project-desc').value.trim();

  if (!name) return;

  const payload = { name, client, description: desc };

  try {
    const res = await fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(r => r.json());

    if (res.status === 'success') {
      showToast(`Project "${name}" created!`, 'success');
      closeModal('modal-project-form');
      loadData();
    }
  } catch (err) {
    showToast('Failed to create project', 'error');
  }
}

async function deleteProjectPrompt(projectId, name) {
  const confirmDel = confirm(`Delete project "${name}"? Contained folders and prompts will become standalone.`);
  if (!confirmDel) return;

  try {
    const res = await fetch(`${API_BASE}/projects/${projectId}`, { method: 'DELETE' }).then(r => r.json());
    if (res.status === 'success') {
      showToast(`Project "${name}" deleted`, 'success');
      loadData();
    }
  } catch (err) {
    showToast('Failed to delete project', 'error');
  }
}

// ==================== 5. CATEGORIES ====================

function renderCategoriesView() {
  const container = document.getElementById('categories-full-grid');
  if (!container) return;

  const html = state.categories.map(cat => `
    <div class="p-5 rounded-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-xs flex flex-col justify-between">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="w-10 h-10 rounded-2xl bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400 flex items-center justify-center">
          <i data-lucide="tag" class="w-5 h-5"></i>
        </div>
      </div>
      <div>
        <h3 class="font-bold text-base text-slate-900 dark:text-slate-100 mb-1">${escapeHtml(cat.name)}</h3>
        <p class="text-xs text-slate-500 mb-4">${cat.prompt_count || 0} prompts in category</p>
      </div>
      <button onclick="filterByCategory('${escapeHtml(cat.name)}')" class="w-full py-2 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-brand-50 hover:text-brand-600 text-xs font-bold transition-all">
        View Category Prompts
      </button>
    </div>
  `).join('');

  container.innerHTML = html;
  lucide.createIcons();
}

function filterByCategory(catName) {
  state.activeCategory = catName;
  setActiveTab('prompts');
}

function openAddCategoryModal() {
  document.getElementById('new-category-name').value = '';
  openModal('modal-category');
}

async function handleCategorySubmit(e) {
  e.preventDefault();
  const name = document.getElementById('new-category-name').value.trim();
  if (!name) return;

  try {
    const res = await fetch(`${API_BASE}/categories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    }).then(r => r.json());

    if (res.status === 'success') {
      showToast(`Category "${name}" created`, 'success');
      closeModal('modal-category');
      loadData();
    }
  } catch (err) {
    showToast('Failed to create category', 'error');
  }
}

// ==================== PROMPT ACTIONS: CREATE, EDIT, DUPLICATE CHECK ====================

function openAddPromptModal(preselectedFolderId = null) {
  document.getElementById('form-modal-title').textContent = 'Add New Prompt';
  document.getElementById('form-prompt-id').value = '';
  document.getElementById('prompt-form').reset();
  document.getElementById('form-vars-preview').classList.add('hidden');
  populateFolderDropdowns();
  populateProjectDropdowns();
  populateCategoryDropdowns();

  // Auto-select folder if specified or if user is currently inside a folder!
  const targetFolderId = preselectedFolderId !== null ? preselectedFolderId : (state.activeFolderId && state.activeFolderId !== 'unassigned' ? state.activeFolderId : null);
  if (targetFolderId) {
    const fSelect = document.getElementById('form-folder');
    if (fSelect) fSelect.value = targetFolderId;
    const folderObj = state.folders.find(f => f.id == targetFolderId);
    if (folderObj) {
      document.getElementById('form-modal-title').innerHTML = `Add Prompt <span class="text-amber-600 dark:text-amber-400 font-bold text-xs">(Saving into: "${escapeHtml(folderObj.name)}")</span>`;
    }
  }

  // Auto-select project if currently filtered
  if (state.activeProjectId) {
    const pSelect = document.getElementById('form-project');
    if (pSelect) pSelect.value = state.activeProjectId;
  }

  openModal('modal-prompt-form');
}

function openEditPromptModal(promptId) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p) return;

  document.getElementById('form-modal-title').textContent = 'Edit Prompt (Auto Version Snapshot)';
  document.getElementById('form-prompt-id').value = p.id;
  document.getElementById('form-title').value = p.title || '';
  document.getElementById('form-folder').value = p.folder_id || '';
  document.getElementById('form-project').value = p.project_id || '';
  document.getElementById('form-category').value = p.category || 'General';
  document.getElementById('form-model').value = p.ai_model || 'General';
  document.getElementById('form-system-prompt').value = p.system_prompt || '';
  document.getElementById('form-prompt-text').value = p.prompt_text || '';
  document.getElementById('form-tags').value = (p.tags || []).join(', ');
  document.getElementById('form-notes').value = p.notes || '';
  document.getElementById('form-is-favorite').checked = p.is_favorite === 1;

  detectVariablesInForm(p.prompt_text);
  openModal('modal-prompt-form');
}

async function handleFormSubmit(e) {
  e.preventDefault();

  const promptId = document.getElementById('form-prompt-id').value;
  const title = document.getElementById('form-title').value.trim();
  const folderId = document.getElementById('form-folder').value || null;
  const projectId = document.getElementById('form-project').value || null;
  const category = document.getElementById('form-category').value.trim();
  const model = document.getElementById('form-model').value.trim() || 'General';
  const systemPrompt = document.getElementById('form-system-prompt').value.trim();
  const promptText = document.getElementById('form-prompt-text').value.trim();
  const rawTags = document.getElementById('form-tags').value;
  const notes = document.getElementById('form-notes').value.trim();
  const isFav = document.getElementById('form-is-favorite').checked;

  const tags = rawTags.split(',').map(t => t.trim().replace(/^#/, '')).filter(t => t.length > 0);

  const payload = {
    title,
    folder_id: folderId ? parseInt(folderId) : null,
    project_id: projectId ? parseInt(projectId) : null,
    category,
    ai_model: model,
    system_prompt: systemPrompt,
    prompt_text: promptText,
    tags,
    notes,
    is_favorite: isFav,
    change_summary: promptId ? 'Edited via web form' : 'Initial creation'
  };

  // Duplicate Check for new prompts
  if (!promptId) {
    try {
      const dupRes = await fetch(`${API_BASE}/prompts/check-duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, prompt_text: promptText })
      }).then(r => r.json());

      if (dupRes.duplicate) {
        state.pendingDuplicatePayload = payload;
        showDuplicateWarningModal(dupRes.duplicate);
        return;
      }
    } catch (err) {
      console.warn('Duplicate check skipped:', err);
    }
  }

  await executeSavePrompt(promptId, payload);
}

async function handleQuickPasteSubmit(e) {
  e.preventDefault();
  const title = document.getElementById('quick-title').value.trim();
  const folderId = document.getElementById('quick-folder').value || null;
  const category = document.getElementById('quick-category').value.trim() || 'General';
  const model = document.getElementById('quick-model').value.trim() || 'General';
  const text = document.getElementById('quick-text').value.trim();
  const isFav = document.getElementById('quick-favorite').checked;

  if (!title || !text) return;

  const payload = {
    title,
    folder_id: folderId ? parseInt(folderId) : null,
    category,
    ai_model: model,
    system_prompt: '',
    prompt_text: text,
    tags: [],
    notes: '',
    is_favorite: isFav
  };

  try {
    const dupRes = await fetch(`${API_BASE}/prompts/check-duplicate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, prompt_text: text })
    }).then(r => r.json());

    if (dupRes.duplicate) {
      state.pendingDuplicatePayload = payload;
      showDuplicateWarningModal(dupRes.duplicate);
      return;
    }
  } catch (err) {}

  await executeSavePrompt(null, payload);
  document.getElementById('quick-title').value = '';
  document.getElementById('quick-text').value = '';
}

function showDuplicateWarningModal(dupInfo) {
  document.getElementById('dup-warning-text').textContent = `Detected a ${dupInfo.similarity_score}% match (${dupInfo.reason}).`;
  document.getElementById('dup-existing-title').textContent = dupInfo.title;

  document.getElementById('dup-btn-view').onclick = () => {
    closeModal('modal-duplicate-warning');
    closeModal('modal-prompt-form');
    openViewModal(dupInfo.id);
  };

  document.getElementById('dup-btn-save-anyway').onclick = async () => {
    closeModal('modal-duplicate-warning');
    await executeSavePrompt(null, state.pendingDuplicatePayload);
  };

  document.getElementById('dup-btn-replace').onclick = async () => {
    closeModal('modal-duplicate-warning');
    await executeSavePrompt(dupInfo.id, state.pendingDuplicatePayload);
  };

  openModal('modal-duplicate-warning');
}

async function executeSavePrompt(promptId, payload) {
  try {
    let res;
    if (promptId) {
      res = await fetch(`${API_BASE}/prompts/${promptId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());
      showToast('Prompt updated! New version archived.', 'success');
    } else {
      res = await fetch(`${API_BASE}/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());
      showToast('Prompt saved to vault!', 'success');
    }

    if (res.status === 'success') {
      closeModal('modal-prompt-form');
      loadData();
    }
  } catch (err) {
    // Offline queue fallback
    state.offlineQueue.push({ type: 'prompt', id: promptId, data: payload });
    updateSyncBadge('offline');
    showToast('Saved to local storage (Queued for sync)', 'info');
    closeModal('modal-prompt-form');
  }
}

// Duplicate Prompt Action
async function duplicatePrompt(promptId) {
  try {
    const res = await fetch(`${API_BASE}/prompts/${promptId}/duplicate`, { method: 'POST' }).then(r => r.json());
    if (res.status === 'success') {
      showToast('Prompt duplicated successfully!', 'success');
      loadData();
    }
  } catch (err) {
    showToast('Failed to duplicate prompt', 'error');
  }
}

// Move Prompt Modal & Execution
function openMoveModal(promptId) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p) return;

  state.movingPromptId = promptId;
  populateFolderDropdowns();
  populateProjectDropdowns();
  document.getElementById('move-folder-select').value = p.folder_id || '';
  document.getElementById('move-project-select').value = p.project_id || '';
  openModal('modal-move-prompt');
}

function openMoveModalFromView() {
  if (!state.viewingPrompt) return;
  const id = state.viewingPrompt.id;
  closeModal('modal-prompt-view');
  openMoveModal(id);
}

async function executeMovePrompt() {
  if (!state.movingPromptId) return;

  const folderId = document.getElementById('move-folder-select').value || null;
  const projectId = document.getElementById('move-project-select').value || null;

  try {
    const res = await fetch(`${API_BASE}/prompts/${state.movingPromptId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        folder_id: folderId ? parseInt(folderId) : null,
        project_id: projectId ? parseInt(projectId) : null
      })
    }).then(r => r.json());

    if (res.status === 'success') {
      showToast('Prompt moved successfully!', 'success');
      closeModal('modal-move-prompt');
      loadData();
    }
  } catch (err) {
    showToast('Failed to move prompt', 'error');
  }
}

// ==================== COPY & USAGE TRACKING ====================

async function copyPromptCard(promptId, buttonEl) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p) return;

  await navigator.clipboard.writeText(p.prompt_text);
  
  const originalHtml = buttonEl.innerHTML;
  buttonEl.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5 text-white"></i><span>Copied!</span>';
  buttonEl.classList.add('bg-emerald-600', 'hover:bg-emerald-500');
  buttonEl.classList.remove('bg-brand-600', 'hover:bg-brand-500');
  lucide.createIcons();

  showToast(`Copied: "${p.title}"`, 'success');

  try {
    const res = await fetch(`${API_BASE}/prompts/${promptId}/use`, { method: 'POST' }).then(r => r.json());
    if (res.status === 'success') {
      p.usage_count = res.data.usage_count;
    }
  } catch (e) {}

  setTimeout(() => {
    buttonEl.innerHTML = originalHtml;
    buttonEl.classList.remove('bg-emerald-600', 'hover:bg-emerald-500');
    buttonEl.classList.add('bg-brand-600', 'hover:bg-brand-500');
    lucide.createIcons();
  }, 1800);
}

// ==================== VERSION HISTORY & RESTORE ====================

async function openHistoryModal(promptId) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p) return;

  state.historyPrompt = p;
  const container = document.getElementById('history-timeline-list');
  container.innerHTML = '<div class="text-center py-6 text-slate-400">Loading revisions...</div>';
  openModal('modal-prompt-history');

  try {
    const res = await fetch(`${API_BASE}/prompts/${promptId}/history`).then(r => r.json());
    if (res.status === 'success' && res.data.length > 0) {
      renderHistoryTimeline(res.data, p);
    } else {
      container.innerHTML = '<div class="text-center py-6 text-slate-400">No revisions found.</div>';
    }
  } catch (err) {
    container.innerHTML = '<div class="text-center py-6 text-red-500">Failed to load history.</div>';
  }
}

function openHistoryFromView() {
  if (!state.viewingPrompt) return;
  const id = state.viewingPrompt.id;
  closeModal('modal-prompt-view');
  openHistoryModal(id);
}

function renderHistoryTimeline(historyList, currentPrompt) {
  const container = document.getElementById('history-timeline-list');
  if (!container) return;

  const currentVer = currentPrompt.current_version || 1;

  const html = historyList.map(v => {
    const isCurrent = v.version_number === currentVer;
    const formattedDate = formatRelativeTime(v.created_at);

    return `
      <div class="relative pl-6 pb-6 border-l-2 ${isCurrent ? 'border-brand-500' : 'border-slate-200 dark:border-slate-800'} last:pb-0">
        <div class="absolute -left-2.5 top-0 w-5 h-5 rounded-full ${isCurrent ? 'bg-brand-500 ring-4 ring-brand-500/20' : 'bg-slate-300 dark:bg-slate-700'} flex items-center justify-center text-white text-[10px] font-bold">
          ${isCurrent ? '✓' : ''}
        </div>

        <div class="bg-slate-50 dark:bg-slate-800/60 p-4 rounded-2xl border border-slate-200 dark:border-slate-700/60 space-y-3">
          <div class="flex items-center justify-between flex-wrap gap-2">
            <div class="flex items-center gap-2">
              <span class="text-xs font-bold px-2 py-0.5 rounded-md bg-brand-100 dark:bg-brand-950 text-brand-700 dark:text-brand-300 font-mono">
                Version ${v.version_number}
              </span>
              ${isCurrent ? '<span class="text-[10px] font-extrabold text-emerald-600 bg-emerald-50 dark:bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-200/50">ACTIVE CURRENT</span>' : ''}
              <span class="text-xs text-slate-400 font-medium">${formattedDate}</span>
            </div>

            ${!isCurrent ? `
              <button onclick="restoreVersion(${currentPrompt.id}, ${v.id}, ${v.version_number})" class="px-3 py-1 rounded-xl bg-brand-600 hover:bg-brand-500 text-white text-xs font-bold shadow-sm flex items-center gap-1">
                <i data-lucide="rotate-ccw" class="w-3 h-3"></i>
                <span>Restore v${v.version_number}</span>
              </button>
            ` : ''}
          </div>

          <div class="p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200/70 dark:border-slate-800 font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap max-h-36 overflow-y-auto leading-relaxed">
            ${escapeHtml(v.prompt_text)}
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
  lucide.createIcons();
}

async function restoreVersion(promptId, versionId, versionNum) {
  const confirmRestore = confirm(`Restore to Version ${versionNum}? Current state will be safely archived.`);
  if (!confirmRestore) return;

  try {
    const res = await fetch(`${API_BASE}/prompts/${promptId}/restore/${versionId}`, { method: 'POST' }).then(r => r.json());
    if (res.status === 'success') {
      showToast(`Restored to Version ${versionNum}!`, 'success');
      closeModal('modal-prompt-history');
      loadData();
    }
  } catch (err) {
    showToast('Failed to restore version', 'error');
  }
}

// ==================== VIEW PROMPT MODAL ====================

function openViewModal(promptId) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p) return;

  state.viewingPrompt = p;

  document.getElementById('view-title').textContent = p.title;
  document.getElementById('view-cat-badge').textContent = p.category;
  document.getElementById('view-folder-badge').textContent = p.folder_name || 'Root Folder';
  document.getElementById('view-model-badge').textContent = p.ai_model || 'General';
  document.getElementById('view-prompt-text').textContent = p.prompt_text;
  
  const dateStr = p.created_at ? new Date(p.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  document.getElementById('view-timestamp').textContent = `Created: ${dateStr} • Version ${p.current_version || 1} • ${p.usage_count || p.copy_count || 0} uses`;

  const sysBox = document.getElementById('view-system-box');
  const sysText = document.getElementById('view-system-text');
  if (p.system_prompt && p.system_prompt.trim()) {
    sysBox.classList.remove('hidden');
    sysText.textContent = p.system_prompt;
  } else {
    sysBox.classList.add('hidden');
  }

  const notesBox = document.getElementById('view-notes-box');
  const notesText = document.getElementById('view-notes-text');
  if (p.notes && p.notes.trim()) {
    notesBox.classList.remove('hidden');
    notesText.textContent = p.notes;
  } else {
    notesBox.classList.add('hidden');
  }

  const tagsContainer = document.getElementById('view-tags-container');
  const tagsList = document.getElementById('view-tags-list');
  if (p.tags && p.tags.length > 0) {
    tagsContainer.classList.remove('hidden');
    tagsList.innerHTML = p.tags.map(t => `<span class="text-xs px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300">#${escapeHtml(t)}</span>`).join('');
  } else {
    tagsContainer.classList.add('hidden');
  }

  const favBtn = document.getElementById('view-fav-btn');
  favBtn.innerHTML = `<i data-lucide="star" class="w-5 h-5 ${p.is_favorite === 1 ? 'text-amber-500 fill-amber-500' : ''}"></i>`;

  const runVarsBtn = document.getElementById('view-run-vars-btn');
  if (p.variables && p.variables.length > 0) runVarsBtn.classList.remove('hidden');
  else runVarsBtn.classList.add('hidden');

  openModal('modal-prompt-view');
}

async function copyPromptFromView() {
  if (!state.viewingPrompt) return;
  const btn = document.getElementById('view-copy-btn');
  await copyPromptCard(state.viewingPrompt.id, btn);
}

function toggleFavoriteFromModal() {
  if (!state.viewingPrompt) return;
  toggleFavorite(state.viewingPrompt.id);
  state.viewingPrompt.is_favorite = state.viewingPrompt.is_favorite === 1 ? 0 : 1;
  const favBtn = document.getElementById('view-fav-btn');
  favBtn.innerHTML = `<i data-lucide="star" class="w-5 h-5 ${state.viewingPrompt.is_favorite === 1 ? 'text-amber-500 fill-amber-500' : ''}"></i>`;
  lucide.createIcons();
}

function editPromptFromView() {
  if (!state.viewingPrompt) return;
  const id = state.viewingPrompt.id;
  closeModal('modal-prompt-view');
  openEditPromptModal(id);
}

function deletePromptFromView() {
  if (!state.viewingPrompt) return;
  openDeleteConfirm(state.viewingPrompt.id);
}

// ==================== DELETE PROMPT ====================

function openDeleteConfirm(promptId) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p) return;

  state.pendingDeleteId = promptId;
  document.getElementById('delete-confirm-prompt-title').textContent = `Permanently delete "${p.title}"?`;
  openModal('modal-delete-confirm');
}

async function executeDeletePrompt() {
  if (!state.pendingDeleteId) return;

  try {
    const res = await fetch(`${API_BASE}/prompts/${state.pendingDeleteId}`, { method: 'DELETE' }).then(r => r.json());
    if (res.status === 'success') {
      showToast('Prompt deleted successfully', 'success');
      closeModal('modal-delete-confirm');
      closeModal('modal-prompt-view');
      state.pendingDeleteId = null;
      loadData();
    }
  } catch (err) {
    showToast('Failed to delete prompt', 'error');
  }
}

async function toggleFavorite(promptId) {
  try {
    const res = await fetch(`${API_BASE}/prompts/${promptId}/favorite`, { method: 'POST' }).then(r => r.json());
    if (res.status === 'success') {
      const idx = state.prompts.findIndex(p => p.id === promptId);
      if (idx !== -1) state.prompts[idx] = res.data;
      if (state.activeTab === 'home') renderHomeRecentPrompts();
      else renderPrompts();
    }
  } catch (err) {
    showToast('Failed to update favorite', 'error');
  }
}

// ==================== SMART VARIABLE RUNNER ====================

function openVariablesRunner(promptId) {
  const p = state.prompts.find(item => item.id === promptId);
  if (!p || !p.variables || p.variables.length === 0) return;

  state.runningPrompt = p;
  const container = document.getElementById('var-inputs-list');
  
  container.innerHTML = p.variables.map(v => `
    <div>
      <label class="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1">
        ${escapeHtml(v)}
      </label>
      <input 
        type="text" 
        data-var-name="${escapeHtml(v)}" 
        placeholder="Enter value for {{${escapeHtml(v)}}}..." 
        oninput="compileVariablesPrompt()"
        class="var-input-field w-full px-3.5 py-2 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500"
      >
    </div>
  `).join('');

  compileVariablesPrompt();
  openModal('modal-variable-runner');
}

function openVariablesRunnerFromView() {
  if (!state.viewingPrompt) return;
  closeModal('modal-prompt-view');
  openVariablesRunner(state.viewingPrompt.id);
}

function compileVariablesPrompt() {
  if (!state.runningPrompt) return;

  let template = state.runningPrompt.prompt_text;
  const inputs = document.querySelectorAll('.var-input-field');

  inputs.forEach(input => {
    const varName = input.getAttribute('data-var-name');
    const val = input.value.trim() || `{{${varName}}}`;
    
    const regex1 = new RegExp(`\\{\\{\\s*${escapeRegExp(varName)}\\s*\\}\\}`, 'g');
    const regex2 = new RegExp(`\\[\\s*${escapeRegExp(varName)}\\s*\\]`, 'g');
    
    template = template.replace(regex1, val).replace(regex2, val);
  });

  document.getElementById('var-compiled-preview').textContent = template;
}

async function copyCompiledPrompt() {
  const text = document.getElementById('var-compiled-preview').textContent;
  if (!text) return;

  await navigator.clipboard.writeText(text);
  const btn = document.getElementById('btn-copy-compiled');
  const original = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="check" class="w-3.5 h-3.5"></i><span>Copied!</span>';
  btn.classList.add('bg-emerald-600');
  lucide.createIcons();

  showToast('Compiled prompt copied to clipboard!', 'success');

  setTimeout(() => {
    btn.innerHTML = original;
    btn.classList.remove('bg-emerald-600');
    lucide.createIcons();
  }, 1800);
}

function detectVariablesInForm(text) {
  const regex = /\{\{([a-zA-Z0-9_\-\s]+)\}\}|\[([a-zA-Z0-9_\-\s]+)\]|\{([a-zA-Z0-9_\-\s]+)\}/g;
  const matches = [...text.matchAll(regex)];
  const vars = [...new Set(matches.map(m => (m[1] || m[2] || m[3]).trim()))];

  const preview = document.getElementById('form-vars-preview');
  const badges = document.getElementById('form-vars-badges');

  if (vars.length > 0) {
    preview.classList.remove('hidden');
    badges.innerHTML = vars.map(v => `<span class="var-pill">{{${escapeHtml(v)}}}</span>`).join('');
  } else {
    preview.classList.add('hidden');
  }
}

// ==================== BACKUP & IMPORT ====================

function openBackupModal() {
  openModal('modal-backup');
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;

  const isCsv = file.name.endsWith('.csv');
  const endpoint = isCsv ? `${API_BASE}/import/csv` : `${API_BASE}/import`;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(endpoint, { method: 'POST', body: formData }).then(r => r.json());
    if (res.status === 'success') {
      showToast('Import completed successfully!', 'success');
      closeModal('modal-backup');
      loadData();
    } else {
      showToast('Import failed. Check file format.', 'error');
    }
  } catch (err) {
    showToast('Invalid backup file format', 'error');
  }

  e.target.value = '';
}

// ==================== MODAL UTILITIES ====================

function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('hidden');
    lucide.createIcons();
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) modal.classList.add('hidden');
}

function closeAllModals() {
  document.querySelectorAll('[id^="modal-"]').forEach(m => m.classList.add('hidden'));
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const colors = {
    success: 'bg-emerald-600 text-white shadow-emerald-500/30',
    error: 'bg-red-600 text-white shadow-red-500/30',
    info: 'bg-slate-800 text-white dark:bg-white dark:text-slate-900 shadow-slate-900/30'
  };

  toast.className = `toast px-4 py-3 rounded-2xl shadow-lg text-xs font-bold flex items-center gap-2.5 transition-all transform translate-y-4 opacity-0 ${colors[type] || colors.info}`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => toast.classList.remove('translate-y-4', 'opacity-0'), 50);
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlightVariablesInText(escapedText) {
  return escapedText.replace(/\{\{([a-zA-Z0-9_\-\s]+)\}\}|\[([a-zA-Z0-9_\-\s]+)\]/g, (match, p1, p2) => {
    const v = p1 || p2;
    return `<span class="var-pill">{{${v}}}</span>`;
  });
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMinutes = Math.floor((now - date) / (1000 * 60));
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
