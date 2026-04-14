// performance_config.js

// Default values (normal mode)
let BATCH_FLUSH_INTERVAL = 1000; //How often messages are saved from memory to database (ms)
let MAX_BATCH_SIZE = 50; //Maximum messages accumulated before forced database save
let BATCH_PROCESSING_INTERVAL = 100; //How often admin events are processed and sent out (ms)
let ADMIN_UPDATE_DEBOUNCE = 500; //How frequently admins get room statistics updates (ms)
let USERS_COUNT_UPDATE_DEBOUNCE = 1000; //How frequently users get views updates (ms)
let CACHE_TTL = 2000; //How long room data is cached before recalculation (ms)

const performanceMode = {
  level: "normal", // 'normal', 'peak', 'extreme'
  settings: {
    normal: {
      batchFlush: 1000,
      maxBatchSize: 50,
      batchProcessing: 100,
      adminDebounce: 500,
      userCountUpdateDebounce: 1000,
      cacheTTL: 2000,
      rateLimitMax: 1,
      rateLimitWindowSeconds: 5,
    },
    peak: {
      batchFlush: 3000,
      maxBatchSize: 100,
      batchProcessing: 200,
      adminDebounce: 2000,
      userCountUpdateDebounce: 3000,
      cacheTTL: 10000,
      rateLimitMax: 1,
      rateLimitWindowSeconds: 5,
    },
    extreme: {
      batchFlush: 5000,
      maxBatchSize: 150,
      batchProcessing: 500,
      adminDebounce: 5000,
      userCountUpdateDebounce: 5000,
      cacheTTL: 30000,
      rateLimitMax: 1,
      rateLimitWindowSeconds: 5,
    },
  },
};

function setPerformanceMode(mode) {
  if (!performanceMode.settings[mode]) {
    console.error(`❌ Unknown performance mode: ${mode}`);
    return;
  }

  performanceMode.level = mode;
  const settings = performanceMode.settings[mode];

  // Update all variables
  BATCH_FLUSH_INTERVAL = settings.batchFlush;
  MAX_BATCH_SIZE = settings.maxBatchSize;
  BATCH_PROCESSING_INTERVAL = settings.batchProcessing;
  ADMIN_UPDATE_DEBOUNCE = settings.adminDebounce;
  USERS_COUNT_UPDATE_DEBOUNCE = settings.userCountUpdateDebounce;
  CACHE_TTL = settings.cacheTTL;

  console.log(`🚀 Performance mode set to: ${mode}`);
  console.log(`   💬 Batch flush: ${BATCH_FLUSH_INTERVAL}ms`);
  console.log(`   📦 Max batch: ${MAX_BATCH_SIZE} messages`);
  console.log(`   ⚡ Batch processing: ${BATCH_PROCESSING_INTERVAL}ms`);
  console.log(`   📊 Admin updates: ${ADMIN_UPDATE_DEBOUNCE}ms`);
  console.log(`   📊 User Count updates: ${USERS_COUNT_UPDATE_DEBOUNCE}ms`);
  console.log(`   💾 Cache TTL: ${CACHE_TTL}ms`);
}

// Optional: Get current mode info
function getCurrentPerformanceMode() {
  return {
    level: performanceMode.level,
    settings: performanceMode.settings[performanceMode.level],
  };
}

module.exports = {
  // Export all variables
  BATCH_FLUSH_INTERVAL,
  MAX_BATCH_SIZE,
  BATCH_PROCESSING_INTERVAL,
  ADMIN_UPDATE_DEBOUNCE,
  CACHE_TTL,
  USERS_COUNT_UPDATE_DEBOUNCE,
  // Export functions
  setPerformanceMode,
  getCurrentPerformanceMode,

  // Export the mode object for reference
  performanceMode,
};
