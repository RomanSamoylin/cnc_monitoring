const express = require('express');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const HTTP_PORT = 3000;
const WS_PORT = 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Конфигурация MySQL с улучшенными параметрами
const pool = mysql.createPool({
  host: '192.168.1.79',
  user: 'monitorl',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00',
  connectionLimit: 30, // Увеличено количество соединений
  queueLimit: 0,
  waitForConnections: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

// Улучшенный кэш данных
const dataCache = {
  machines: {},
  lastUpdated: null,
  ttl: 15000, // 15 секунд (уменьшено для более частых обновлений)
  isUpdating: false,
  lastError: null
};

// Создаем WebSocket сервер с улучшенной обработкой соединений
const wss = new WebSocket.Server({ port: WS_PORT });

// Функция для логирования с временными метками
function log(message, isError = false) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  if (isError) {
    console.error(logMessage);
  } else {
    console.log(logMessage);
  }
}

// Улучшенная функция определения статуса станка
function determineMachineStatus(statusData) {
  if (statusData.MUSP === 1) {
    return { status: 'shutdown', statusText: 'Выключено (MUSP)' };
  }
  
  if (statusData.SystemState === undefined || statusData.SystemState === null) {
    return { status: 'shutdown', statusText: 'Нет данных' };
  }
  
  const systemState = parseInt(statusData.SystemState);
  
  switch (systemState) {
    case 0: return { status: 'shutdown', statusText: 'Выключено' };
    case 1:
    case 3: return { status: 'stopped', statusText: 'Остановлено' };
    case 2:
    case 4: return { status: 'working', statusText: 'Работает' };
    default: return { status: 'shutdown', statusText: 'Неизвестный статус' };
  }
}

// Оптимизированная функция получения данных станков с таймаутом
async function getMachineData() {
  // Если данные актуальны и не в процессе обновления
  const cacheAge = dataCache.lastUpdated ? Date.now() - dataCache.lastUpdated : Infinity;
  if (cacheAge < dataCache.ttl && !dataCache.isUpdating) {
    log(`Используются кэшированные данные (возраст: ${cacheAge}ms)`);
    return dataCache.machines;
  }

  // Если уже идет обновление - возвращаем текущие данные
  if (dataCache.isUpdating) {
    log('Обновление уже выполняется, возвращаем кэшированные данные');
    return dataCache.machines;
  }

  dataCache.isUpdating = true;
  const connection = await pool.getConnection();

  try {
    log('Начало обновления данных из БД...');
    const startTime = Date.now();

    // Установка таймаута для запроса (10 секунд)
    await connection.query('SET SESSION max_execution_time = 10000');

    const [results] = await connection.query(`
      SELECT 
        m.machine_id,
        m.cnc_name,
        MAX(CASE WHEN b.event_type = 7 THEN b.value END) as system_state,
        MAX(CASE WHEN b.event_type = 21 THEN b.value END) as musp_state,
        MAX(CASE WHEN f.event_type = 5 THEN f.value END) as feed_rate,
        MAX(CASE WHEN f.event_type = 6 THEN f.value END) as spindle_speed,
        MAX(CASE WHEN f.event_type = 10 THEN f.value END) as jog_switch,
        MAX(CASE WHEN f.event_type = 11 THEN f.value END) as f_switch,
        MAX(CASE WHEN f.event_type = 12 THEN f.value END) as s_switch,
        MAX(CASE WHEN f.event_type = 40 THEN f.value END) as spindle_power,
        GREATEST(
          MAX(b.timestamp),
          MAX(f.timestamp)
        ) as last_update
      FROM cnc_id_mapping m
      LEFT JOIN (
        SELECT machine_id, event_type, value, timestamp
        FROM bit8_data
        WHERE (machine_id, event_type, timestamp) IN (
          SELECT machine_id, event_type, MAX(timestamp)
          FROM bit8_data
          WHERE event_type IN (7, 21)
          GROUP BY machine_id, event_type
        )
      ) b ON m.machine_id = b.machine_id
      LEFT JOIN (
        SELECT machine_id, event_type, value, timestamp
        FROM float_data
        WHERE (machine_id, event_type, timestamp) IN (
          SELECT machine_id, event_type, MAX(timestamp)
          FROM float_data
          WHERE event_type IN (5, 6, 10, 11, 12, 40)
          GROUP BY machine_id, event_type
        )
      ) f ON m.machine_id = f.machine_id
      GROUP BY m.machine_id
      ORDER BY m.machine_id
    `);

    const machinesData = {};
    const updateTime = new Date();

    results.forEach(row => {
      const status = determineMachineStatus({
        SystemState: row.system_state,
        MUSP: row.musp_state
      });

      machinesData[row.machine_id] = {
        internalId: row.machine_id,
        displayName: row.cnc_name,
        status: status.status,
        statusText: status.statusText,
        currentPerformance: row.spindle_power ? 
          Math.min(100, Math.max(0, Math.round(row.spindle_power))) : 0,
        lastUpdate: row.last_update ? row.last_update.toISOString() : updateTime.toISOString(),
        params: {
          feedRate: row.feed_rate || 0,
          spindleSpeed: row.spindle_speed || 0,
          jogSwitch: row.jog_switch || 0,
          fSwitch: row.f_switch || 0,
          sSwitch: row.s_switch || 0,
          spindlePower: row.spindle_power || 0
        }
      };
    });

    // Обновляем кэш
    dataCache.machines = machinesData;
    dataCache.lastUpdated = Date.now();
    dataCache.lastError = null;
    dataCache.isUpdating = false;

    log(`Обновление данных завершено за ${Date.now() - startTime}ms. Обновлено станков: ${results.length}`);
    return machinesData;
  } catch (error) {
    dataCache.isUpdating = false;
    dataCache.lastError = error.message;
    log(`Ошибка при обновлении данных: ${error.message}`, true);
    throw error;
  } finally {
    connection.release();
  }
}

// Улучшенная функция рассылки обновлений через WebSocket
function broadcastUpdate() {
  if (wss.clients.size === 0) {
    log('Нет подключенных WebSocket клиентов для рассылки');
    return;
  }

  const data = {
    type: 'UPDATE',
    data: dataCache.machines,
    timestamp: new Date().toISOString(),
    cacheAge: dataCache.lastUpdated ? Date.now() - dataCache.lastUpdated : 0
  };

  let sentCount = 0;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
      sentCount++;
    }
  });

  log(`Разослано обновление ${sentCount} клиентам. Возраст данных: ${data.cacheAge}ms`);
}

// Надежный планировщик обновлений
function scheduleUpdate() {
  const update = async () => {
    try {
      await getMachineData();
      broadcastUpdate();
    } catch (error) {
      log(`Ошибка при плановом обновлении: ${error.message}`, true);
      // Экспоненциальная задержка при ошибках (макс 1 минута)
      const delay = Math.min(60000, dataCache.ttl * (dataCache.lastError ? 2 : 1));
      log(`Повторная попытка через ${delay}ms`);
      setTimeout(update, delay);
      return;
    }
    setTimeout(update, dataCache.ttl);
  };

  // Первый запуск с небольшой задержкой для инициализации сервера
  setTimeout(update, 1000);
}

// Health check endpoint с подробной информацией
app.get('/health', (req, res) => {
  res.json({
    status: dataCache.lastError ? 'error' : 'ok',
    lastUpdate: dataCache.lastUpdated,
    lastError: dataCache.lastError,
    machinesCount: Object.keys(dataCache.machines).length,
    wsClients: wss.clients.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
    mysqlStats: pool.pool.config.connectionConfig
  });
});

// API endpoint для получения данных станков
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await getMachineData();
    res.json({
      success: true,
      machines: machines,
      fromCache: Date.now() - dataCache.lastUpdated < dataCache.ttl,
      lastUpdated: dataCache.lastUpdated,
      cacheAge: Date.now() - dataCache.lastUpdated
    });
  } catch (error) {
    log(`API error: ${error.message}`, true);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      cachedData: dataCache.machines,
      cacheAge: dataCache.lastUpdated ? Date.now() - dataCache.lastUpdated : null
    });
  }
});

// Улучшенный WebSocket обработчик
wss.on('connection', (ws) => {
  log(`Новое WebSocket подключение. Всего клиентов: ${wss.clients.size}`);

  // Отправляем текущие данные при подключении
  ws.send(JSON.stringify({ 
    type: 'INITIAL_DATA',
    data: dataCache.machines,
    timestamp: dataCache.lastUpdated,
    cacheAge: dataCache.lastUpdated ? Date.now() - dataCache.lastUpdated : 0
  }));

  // Ping/pong для проверки активности
  ws.isAlive = true;
  ws.on('pong', () => { 
    ws.isAlive = true;
    log(`Получен pong от клиента`);
  });

  ws.on('close', () => {
    log(`WebSocket отключен. Осталось клиентов: ${wss.clients.size}`);
  });

  ws.on('error', (error) => {
    log(`WebSocket ошибка: ${error.message}`, true);
  });
});

// Ping клиентов каждые 30 секунд
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log(`Отключение неактивного клиента`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Обработка ошибок сервера
process.on('uncaughtException', (err) => {
  log(`Неперехваченное исключение: ${err.message}`, true);
  // Не завершаем процесс, чтобы сервер продолжал работать
});

process.on('unhandledRejection', (err) => {
  log(`Необработанный rejection: ${err.message}`, true);
});

// Запуск сервера
app.listen(HTTP_PORT, () => {
  log(`HTTP сервер запущен на порту ${HTTP_PORT}`);
  log(`WebSocket сервер запущен на порту ${WS_PORT}`);
  log(`Время сервера: ${new Date()}`);

  // Проверка соединения с MySQL перед загрузкой данных
  pool.getConnection()
    .then(conn => {
      log('Успешное подключение к MySQL');
      conn.release();
      
      // Первоначальная загрузка данных
      getMachineData()
        .then(() => {
          log('Первоначальная загрузка данных завершена успешно');
          // Запускаем планировщик обновлений
          scheduleUpdate();
        })
        .catch(err => {
          log(`Ошибка при первоначальной загрузке данных: ${err.message}`, true);
          // Сервер продолжает работу с возможностью повтора
          setTimeout(scheduleUpdate, 10000);
        });
    })
    .catch(err => {
      log(`Ошибка подключения к MySQL: ${err.message}`, true);
      process.exit(1);
    });
});

module.exports = {
  app,
  pool,
  wss,
  getMachineData,
  dataCache
};