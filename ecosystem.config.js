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
        MYSQL_USER: "monitor",
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
      max_memory_restart: "600M",
      env: {
        NODE_ENV: "production",
        PORT: 3001,
        MYSQL_HOST: "192.168.1.30",
        MYSQL_USER: "monitor",
        MYSQL_PASSWORD: "victoria123",
        MYSQL_DATABASE: "cnc_monitoring",
        JWT_SECRET: "your-secret-key",
        // Добавьте таймауты
        MYSQL_CONNECT_TIMEOUT: 10000,
        MYSQL_ACQUIRE_TIMEOUT: 10000
      },
      node_args: [
        "--max-old-space-size=500",
        "--optimize-for-size"
      ],
      error_file: "./logs/analytics-error.log",
      out_file: "./logs/analytics-out.log",
      // Добавьте задержку перед рестартом
      min_uptime: "10s",
      restart_delay: 5000
    },
    {
      name: "settings-server",
      script: "./server4.js",
      instances: 1, // Меняем на 1 инстанса для cluster режима
      exec_mode: "cluster", // Меняем с "fork" на "cluster"
      autorestart: true,
      watch: false,
      max_memory_restart: "500M", // Увеличиваем память для cluster
      min_uptime: "30s",
      max_restarts: 10,
      restart_delay: 10000,
      kill_timeout: 15000, // Увеличиваем для graceful shutdown
      listen_timeout: 10000,
      env: {
        NODE_ENV: "production",
        PORT: 3004,
        MYSQL_HOST: "192.168.1.30",
        MYSQL_USER: "monitor",
        MYSQL_PASSWORD: "victoria123",
        MYSQL_DATABASE: "cnc_monitoring",
        MYSQL_TIMEZONE: "+03:00",
        MYSQL_CONNECTION_LIMIT: 20, // Увеличиваем для cluster
        MYSQL_CONNECT_TIMEOUT: 30000,
        MYSQL_ACQUIRE_TIMEOUT: 30000,
        CLUSTER_MODE: "true" // Добавляем флаг cluster режима
      },
      env_production: {
        NODE_ENV: "production",
        PM2_GRACEFUL_LISTEN_TIMEOUT: 15000
      },
      node_args: [
        "--max-old-space-size=400", // Увеличиваем лимит памяти
        "--optimize-for-size"
      ],
      error_file: "./logs/settings-error.log",
      out_file: "./logs/settings-out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss.SSS",
      // Cluster-specific settings
      instance_var: 'INSTANCE_ID', // Для идентификации инстансов
      combine_logs: true // Объединять логи всех инстансов
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