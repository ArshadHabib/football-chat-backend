require("module-alias/register");
require("dotenv").config();
const path = require("path");
const moduleAlias = require("module-alias");
moduleAlias.addAlias("@project", path.resolve(__dirname));

const express = require("express");
const chatRoutes = require("@project/modules/chat");
const connectDB = require("@project/config/connection");
const cors = require("cors");
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 5001;
const allowedOrigins = process.env.CORS_ORIGINS.split(",");
const http = require("http");
const socketIo = require("socket.io");
const setupSocketHandlers = require("./socket/socketHandler");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});
setupSocketHandlers(io);

app.use(bodyParser.json());

app.use(
  "/api/next",
  cors({
    origin: "*", // allow any frontend
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use("/api/next/chat", chatRoutes);

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
app.get("/", (req, res) => {
  res.send("Chat API is running");
});

(async () => {
  try {
    await connectDB();
    server.listen(PORT, async () => {
      console.log(`Server is running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("❌ Server failed to start:", err);
    process.exit(1);
  }
})();
