module.exports = {
  apps: [
    {
      name: "monitoring-server",
      script: "./server.js",
      instances: 1, // Один инстанс, так как есть кэширование и WebSocket
      autorestart: true,
      watch: false,
      max_memory_restart: "800M", // Уменьшен лимит памяти
      min_uptime: "10s", // Минимальное время работы перед рестартом
      max_restarts: 5, // Максимум 5 рестартов за 60 секунд
      restart_delay: 5000, // Задержка перед рестартом
      kill_timeout: 10000, // Время на корректное завершение
      listen_timeout: 5000, // Таймаут ожидания готовности
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        MYSQL_HOST: "192.168.1.30",
        MYSQL_USER: "monitorl",
        MYSQL_PASSWORD: "victoria123",
        MYSQL_DATABASE: "cnc_monitoring",
        WS_PORT: 8080,
        CACHE_TTL: "20000" // 20 секунд
      },
      env_production: {
        NODE_ENV: "production",
        PM2_GRACEFUL_LISTEN_TIMEOUT: 10000
      },
      node_args: [
        "--max-old-space-size=700", // Лимит памяти для Node.js
        "--optimize-for-size",
        "--gc-interval=1000" // Чаще сборка мусора
      ],
      error_file: "./logs/monitoring-error.log",
      out_file: "./logs/monitoring-out.log",
      pid_file: "./pids/monitoring.pid",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS"
    },
    {
      name: "analytics-server",
      script: "./server2.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "600M", // Меньше памяти для аналитики
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        MONITORING_API_URL: "http://localhost:3000"
      },
      node_args: [
        "--max-old-space-size=500",
        "--optimize-for-size"
      ],
      error_file: "./logs/analytics-error.log",
      out_file: "./logs/analytics-out.log"
    }
  ],

  // Настройки деплоя (если используется)
  deploy: {
    production: {
      user: "node",
      host: ["your-production-server"],
      ref: "origin/main",
      repo: "git@github.com:your/repo.git",
      path: "/var/www/monitoring",
      "post-deploy": "npm install && pm2 reload ecosystem.config.js --env production"
    }
  }
};