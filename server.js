require("module-alias/register");
require("dotenv").config();
const path = require("path");
const moduleAlias = require("module-alias");
moduleAlias.addAlias("@project", path.resolve(__dirname));

const express = require("express");
const chatRoutes = require("@project/modules/chat");
const userRoutes = require("@project/modules/user");
const connectDB = require("@project/config/connection");
const cors = require("cors");
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 5001;
const allowedOrigins = process.env.CORS_ORIGINS.split(",");
const http = require("http");
const socketIo = require("socket.io");
const setupSocketHandlers = require("./socket/socketHandler");
const { createAdapter } = require("@socket.io/redis-adapter");
const { pubClient, subClient, perfSubClient, connectRedis } = require("@project/config/redis");
const { setPerformanceMode } = require("@project/utils/perfomance_config");

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
  })
);
app.use("/api/next/chat", chatRoutes);
app.use("/api/next/user", userRoutes);

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
  })
);

app.use("/api/chat/chat", chatRoutes);
app.use("/api/chat/user", userRoutes);
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

    server.listen(PORT, async () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server failed to start:", err);
    process.exit(1);
  }
})();
