module.exports = {
  apps: [
    {
      name: "monitoring-server",  // Основной сервер мониторинга
      script: "./server.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3000
      }
    },
    {
      name: "analytics-server",   // Сервер аналитики
      script: "./server2.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "1G",
      env: {
        NODE_ENV: "production",
        PORT: 3001
      }
    }
  ]
};