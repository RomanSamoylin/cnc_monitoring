const express = require('express');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MySQL конфигурация с пулом соединений
const pool = mysql.createPool({
  host: '192.168.1.79',
  user: 'monitorl',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00',
  connectionLimit: 5,
  queueLimit: 0,
  waitForConnections: true
});

// Кэш данных с TTL (Time-To-Live)
const dataCache = {
  machines: {},
  lastUpdated: null,
  ttl: 20000, // 20 секунд
  isUpdating: false
};

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ port: 8080 });

// Функция определения статуса станка
function determineMachineStatus(statusData) {
  if (statusData.MUSP === 1) {
    return { status: 'shutdown', statusText: 'Выключено (MUSP)' };
  }
  
  if (!statusData.SystemState && statusData.SystemState !== 0) {
    return { status: 'shutdown', statusText: 'Нет данных' };
  }
  
  const systemState = statusData.SystemState;
  
  if (systemState === 0) {
    return { status: 'shutdown', statusText: 'Выключено' };
  }
  
  if (systemState === 1 || systemState === 3) {
    return { status: 'stopped', statusText: 'Остановлено' };
  }
  
  if (systemState === 2 || systemState === 4) {
    return { status: 'working', statusText: 'Работает' };
  }
  
  return { status: 'shutdown', statusText: 'Неизвестный статус' };
}

// Оптимизированная функция получения данных станков
async function getMachineData() {
  // Если данные актуальны и не в процессе обновления
  if (dataCache.lastUpdated && Date.now() - dataCache.lastUpdated < dataCache.ttl && !dataCache.isUpdating) {
    return dataCache.machines;
  }

  // Если уже идет обновление - возвращаем текущие данные
  if (dataCache.isUpdating) {
    return dataCache.machines;
  }

  dataCache.isUpdating = true;
  const connection = await pool.getConnection();

  try {
    console.log('Starting database update...');
    const startTime = Date.now();

    // Один комплексный запрос вместо нескольких
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
    `);

    const machinesData = {};
    const updateTime = new Date();

    results.forEach(row => {
      const status = determineMachineStatus({
        SystemState: row.system_state ? parseInt(row.system_state) : null,
        MUSP: row.musp_state ? parseInt(row.musp_state) : null
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
          feedRate: row.feed_rate,
          spindleSpeed: row.spindle_speed,
          jogSwitch: row.jog_switch,
          fSwitch: row.f_switch,
          sSwitch: row.s_switch,
          spindlePower: row.spindle_power
        }
      };
    });

    // Обновляем кэш
    dataCache.machines = machinesData;
    dataCache.lastUpdated = Date.now();
    dataCache.isUpdating = false;

    console.log(`Database update completed in ${Date.now() - startTime}ms`);
    return machinesData;
  } catch (error) {
    console.error('Database update error:', error);
    dataCache.isUpdating = false;
    throw error;
  } finally {
    connection.release();
  }
}

// Функция рассылки обновлений через WebSocket
function broadcastUpdate() {
  if (!wss.clients.size) return;

  const data = {
    type: 'UPDATE',
    data: dataCache.machines,
    timestamp: new Date().toISOString()
  };

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

// Планировщик обновлений с защитой от накладок
function scheduleUpdate() {
  setTimeout(async () => {
    try {
      await getMachineData();
      broadcastUpdate();
    } catch (error) {
      console.error('Scheduled update failed:', error);
      // Увеличиваем интервал при ошибках
      setTimeout(scheduleUpdate, 30000);
      return;
    }
    scheduleUpdate();
  }, dataCache.ttl); // Используем TTL из кэша
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    lastUpdate: dataCache.lastUpdated,
    machinesCount: Object.keys(dataCache.machines).length,
    memoryUsage: process.memoryUsage()
  });
});

// API endpoint для получения данных станков
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await getMachineData();
    res.json({
      success: true,
      machines: machines,
      fromCache: Date.now() - dataCache.lastUpdated < dataCache.ttl
    });
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      cachedData: dataCache.machines 
    });
  }
});

// WebSocket обработчик
wss.on('connection', (ws) => {
  console.log('New WebSocket client connected');
  
  // Отправляем текущие данные при подключении
  ws.send(JSON.stringify({ 
    type: 'INITIAL_DATA',
    data: dataCache.machines,
    timestamp: dataCache.lastUpdated
  }));

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });
});

// Обработка ошибок сервера
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`HTTP server started on port ${PORT}`);
  console.log(`WebSocket server started on port 8080`);
  console.log(`Server time: ${new Date()}`);
  
  // Первоначальная загрузка данных
  getMachineData()
    .then(() => {
      console.log('Initial data loaded successfully');
      // Запускаем планировщик обновлений
      scheduleUpdate();
    })
    .catch(err => {
      console.error('Initial data load failed:', err);
      process.exit(1);
    });
});

// Экспорт для тестирования
module.exports = {
  app,
  pool,
  getMachineData,
  dataCache
};