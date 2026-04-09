module.exports = {
  apps: [
    {
      name: "chat-backend",
      script: "./server.js",
      instances: 5, // 1 core reserved for Redis + MongoDB on same server
      exec_mode: "cluster",
      max_memory_restart: "800M", // 5 × 800MB = 4GB for Node.js, leaves ~7GB for OS/Redis/MongoDB
      node_args: "--max-old-space-size=700", // V8 heap cap slightly below restart threshold, gives GC room
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
