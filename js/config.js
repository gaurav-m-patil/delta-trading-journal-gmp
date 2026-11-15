/**
 * Delta Trading Journal & AI Coach - Configuration
 * Adheres to standard GP_ prefix for Firebase Firestore Collections
 * Optimized for Spark Free Tier with IndexedDB Local-First Caching
 */

window.DeltaConfig = {
  APP_NAME: "Delta Trading Journal & AI Coach",
  APP_VERSION: "3.6.1",

  // Local Seed / Raw Data URL
  RAW_DATA_URL: "./data/raw_data.json",

  // Active Firebase Configuration (Spark Free-Tier Project: physio-clinic-730a1)
  // Shared across Gaurav Patil's productivity ecosystem with standardized GP_ namespaces
  FIREBASE_CONFIG: {
    apiKey: (function() { return atob("QUl6YVN5RGRwcUFIRlJCQWliN3dYRmczZmcySUNrWFVFZTlIV184"); })(),
    authDomain: "physio-clinic-730a1.firebaseapp.com",
    projectId: "physio-clinic-730a1",
    storageBucket: "physio-clinic-730a1.firebasestorage.app",
    messagingSenderId: "62153353894",
    appId: "1:62153353894:web:c4947660badbbb23d66267",
    measurementId: "G-HJV7MLKWCK"
  },

  // Standardized Firestore Collection Names (GP_DTJ Prefix)
  FIRESTORE_COLLECTIONS: {
    TRADES: "GP_DTJ_trades",              // Closed & open positions with SMC tags & screenshots
    DAILY_METRICS: "GP_DTJ_daily_metrics",// Aggregated daily performance summaries (0-cost reads)
    TAGS: "GP_DTJ_tags",                  // Strategy tag catalog
    SETTINGS: "GP_DTJ_settings",          // User preferences, capital, and risk limits
    SIGNALS: "GP_DTJ_signal_trades"       // Institutional SMC signal trades with frozen option pricing
  },

  // Standard Smart Money Concepts (SMC) & Trading Setup Presets
  SMC_TAG_PRESETS: [
    { name: "Asian Range Sweep", category: "SMC", color: "#6366f1" },
    { name: "15m Order Block", category: "SMC", color: "#3b82f6" },
    { name: "FVG Mitigation", category: "SMC", color: "#06b6d4" },
    { name: "VWAP Pullback", category: "INDICATOR", color: "#10b981" },
    { name: "Liquidity Grab (BSL/SSL)", category: "SMC", color: "#8b5cf6" },
    { name: "Break of Structure (BOS)", category: "SMC", color: "#ec4899" },
    { name: "London Open Expansion", category: "SESSION", color: "#f59e0b" },
    { name: "NY Session Momentum", category: "SESSION", color: "#f97316" },
    { name: "0-DTE Delta Scalp", category: "OPTIONS", color: "#14b8a6" },
    { name: "Theta Decay Harvest", category: "OPTIONS", color: "#84cc16" },
    // Behavioral Leaks / Mistakes to flag
    { name: "FOMO / Chasing", category: "LEAK", color: "#ef4444" },
    { name: "Revenge / Tilt", category: "LEAK", color: "#dc2626" },
    { name: "Theta Trap (Held Too Long)", category: "LEAK", color: "#b91c1c" },
    { name: "Cut Winner Too Early", category: "LEAK", color: "#e11d48" }
  ],

  // Storage Keys for Browser Local Persistence
  STORAGE_KEYS: {
    THEME: "dtj_theme",
    GH_PAT: "gh_pat_token",
    GH_OWNER: "gh_owner",
    GH_REPO: "gh_repo",
    GEMINI_KEY: "gemini_api_key",
    FIREBASE_CONFIG: "dtj_firebase_config",
    ACTIVE_BACKEND: "dtj_active_backend", // 'firebase' | 'local'
    LAST_SYNC: "dtj_last_sync_timestamp",
    CURRENT_TAB: "dtj_active_tab",
    MAX_DAILY_LOSS: "dtj_max_daily_loss",
    MAX_CONSEC_LOSSES: "dtj_max_consec_losses",
    SENTINEL_ACKNOWLEDGED: "dtj_sentinel_acknowledged",
    TELEGRAM_BOT_TOKEN: "dtj_telegram_bot_token",
    TELEGRAM_CHAT_ID: "dtj_telegram_chat_id",
    TELEGRAM_ENABLED: "dtj_telegram_enabled",
    LOCKED_ACTIVE_PLAN: "dtj_locked_active_plan"
  },

  // Default Tax & Brokerage Parameters for Delta India
  BROKERAGE: {
    GST_RATE: 0.18 // 18% GST on brokerage fees
  }
};
