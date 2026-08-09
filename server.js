require("module-alias/register");
require("dotenv").config();
const path = require("path");
const moduleAlias = require("module-alias");
moduleAlias.addAlias("@project", path.resolve(__dirname));

const express = require("express");
const chatRoutes = require("@project/modules/chat");
const userRoutes = require("@project/modules/user");
const moderationRoutes = require("@project/modules/moderation");
const connectDB = require("@project/config/connection");
const cors = require("cors");
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 5001;
const allowedOrigins = process.env.CORS_ORIGINS.split(",");
const http = require("http");
const socketIo = require("socket.io");
const setupSocketHandlers = require("./socket/socketHandler");
const { createAdapter } = require("@socket.io/redis-adapter");
const {
  pubClient,
  subClient,
  perfSubClient,
  connectRedis,
} = require("@project/config/redis");
const { setPerformanceMode } = require("@project/utils/perfomance_config");
const { validateCounts } = require("@project/socket/roomManager");
const { warmBanCaches } = require("@project/modules/user/warmup");
const { startDrainLoop } = require("@project/modules/chat/service");
const featureFlags = require("@project/utils/feature_flags");
const rateLimitConfig = require("@project/utils/rate_limit_config");
const racismPolicy = require("@project/utils/racism_policy");
const reporterConfig = require("@project/utils/aimod_reporter_config");

const app = express();
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = socketIo(server, {
  transports: ["websocket"],
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
setupSocketHandlers(io);

// app.set("trust proxy", true);
app.use(bodyParser.json({ limit: "50mb" }));

app.use(
  "/api/next",
  cors({
    origin: "*", // allow any frontend
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use("/api/next/chat", chatRoutes);
app.use("/api/next/user", userRoutes);
app.use("/api/next/moderation", moderationRoutes);

app.use(
  "/api",
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true); // Allow requests with no origin (like mobile apps or curl requests)
      if (allowedOrigins?.indexOf(origin) !== -1) {
        return callback(null, true);
      } else {
        return callback(new Error("Not allowed by CORS"));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

app.use("/api/chat/chat", chatRoutes);
app.use("/api/chat/user", userRoutes);
app.use("/api/chat/moderation", moderationRoutes);
app.get("/", (req, res) => {
  res.send("Chat API is running");
});

(async () => {
  try {
    await connectDB();
    await connectRedis();
    io.adapter(createAdapter(pubClient, subClient));

    // Receive performance mode changes broadcast from other processes
    perfSubClient.subscribe("__perf_mode__", (mode) => {
      setPerformanceMode(mode);
    });

    // Hydrate perf mode from Redis at boot. Without this, a worker that
    // crashes and respawns boots back to "normal" regardless of cluster
    // state — silent desync from the rest of the cluster until the next
    // admin click. The companion SET runs in changeServerModeController.
    const persistedMode = await pubClient.get("__perf_mode_current__");
    if (persistedMode) setPerformanceMode(persistedMode);

    // Hydrate feature flags from Redis (or seed defaults on first cluster
    // boot) and start listening for cross-instance toggle changes. Must run
    // before warmBanCaches/startDrainLoop because subsequent code paths
    // (registration, room_message) read the flags.
    await featureFlags.loadFromRedis();
    await featureFlags.subscribeToChanges();

    // Same Redis-source-of-truth lifecycle for the dynamic message rate-limit
    // config. Must run before accepting traffic — room_message reads it.
    await rateLimitConfig.loadFromRedis();
    await rateLimitConfig.subscribeToChanges();

    // Same lifecycle for the AI-moderation racism-strictness mode (read once
    // per report by the classifier). Cheap; load before traffic for determinism.
    await racismPolicy.loadFromRedis();
    await racismPolicy.subscribeToChanges();

    // Same lifecycle for the AI-moderation reporter-limit config (read once per
    // report by the pipeline). Cheap; load before traffic for determinism.
    await reporterConfig.loadFromRedis();
    await reporterConfig.subscribeToChanges();

    // Startup sweep — reconciles __socket_website__ and __room_counts__ against
    // the live socket state across all instances. Catches stale entries left by
    // a previously crashed/restarted instance within seconds of this process
    // booting, instead of waiting for the 2-minute periodic validation.
    await validateCounts({ deleteStaleSockets: true });

    // Seed ban Sets from MongoDB before accepting traffic.
    await warmBanCaches();
    startDrainLoop();
    // Re-warm on Redis reconnect (Redis crash while PM2 stays running).
    // Registered after connectRedis() so only catches future reconnects.
    pubClient.on("ready", () => {
      warmBanCaches().catch((err) =>
        console.error("Ban cache re-warm failed:", err),
      );
      // Re-hydrate perf mode in case Redis was wiped or recovered to a
      // different state while this worker was disconnected. Idempotent —
      // applying the same mode is a no-op.
      pubClient
        .get("__perf_mode_current__")
        .then((m) => {
          if (m) setPerformanceMode(m);
        })
        .catch((err) => console.error("Perf mode re-hydrate failed:", err));
      // Re-hydrate feature flags too, mirroring the same pattern.
      featureFlags
        .loadFromRedis()
        .catch((err) => console.error("Feature flags re-hydrate failed:", err));
      // Re-hydrate rate-limit config, same pattern.
      rateLimitConfig
        .loadFromRedis()
        .catch((err) =>
          console.error("Rate-limit config re-hydrate failed:", err),
        );
      // Re-hydrate AI racism mode, same pattern.
      racismPolicy
        .loadFromRedis()
        .catch((err) => console.error("Racism mode re-hydrate failed:", err));
      // Re-hydrate AI reporter-limit config, same pattern.
      reporterConfig
        .loadFromRedis()
        .catch((err) =>
          console.error("Reporter-limit config re-hydrate failed:", err),
        );
    });

    server.listen(PORT, async () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server failed to start:", err);
    process.exit(1);
  }
})();
