module.exports = {
  apps: [
    {
      name: "chat-backend",
      script: "./server.js",
      instances: "max",
      exec_mode: "cluster",
      max_memory_restart: "512M",
      env_production: {
        NODE_ENV: "production",
      },
    },
  ],
};
