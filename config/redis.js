const { createClient } = require("redis");

const pubClient = createClient({ url: process.env.REDIS_URL || "redis://127.0.0.1:6379" });
const subClient = pubClient.duplicate();         // used exclusively by Socket.io adapter
const perfSubClient = pubClient.duplicate();     // used exclusively for __perf_mode__ channel
const featuresSubClient = pubClient.duplicate(); // used exclusively for __feature_change__ channel
const rateLimitSubClient = pubClient.duplicate(); // used exclusively for __rate_limit_change__ channel

pubClient.on("error", (err) => console.error("Redis pub error:", err));
subClient.on("error", (err) => console.error("Redis sub error:", err));
perfSubClient.on("error", (err) => console.error("Redis perf-sub error:", err));
featuresSubClient.on("error", (err) => console.error("Redis features-sub error:", err));
rateLimitSubClient.on("error", (err) => console.error("Redis rate-limit-sub error:", err));

async function connectRedis() {
  await Promise.all([
    pubClient.connect(),
    subClient.connect(),
    perfSubClient.connect(),
    featuresSubClient.connect(),
    rateLimitSubClient.connect(),
  ]);
  console.log("✅ Redis connected...");
}

module.exports = { pubClient, subClient, perfSubClient, featuresSubClient, rateLimitSubClient, connectRedis };
