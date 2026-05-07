module.exports = {
  apps: [
    {
      name: "chat-backend",
      script: "./server.js",
      instances: 5, // 1 core reserved for Redis + MongoDB on same server
      exec_mode: "cluster",
      max_memory_restart: "1500M", // 5 × 1500MB = 7.5GB for Node.js; Redis+MongoDB+OS ~3GB = ~10.5GB total on 12GB server
      node_args: "--max-old-space-size=1200", // V8 heap cap 300MB below restart threshold — room for Socket.io buffers and message batch under burst load
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
