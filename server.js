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

// Конфигурация MySQL пула
const pool = mysql.createPool({
  host: '192.168.1.30',
  user: 'monitor',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00',
  connectionLimit: 30,
  connectTimeout: 60000,
  waitForConnections: true,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000
});

// Кэш данных
const dataCache = {
  machines: {},
  lastUpdated: null,
  ttl: 30000,
  isUpdating: false,
  lastError: null,
  retryCount: 0,
  maxRetries: 5
};

// WebSocket сервер
const wss = new WebSocket.Server({ port: WS_PORT });

// Логирование
function log(message, isError = false) {
  const timestamp = new Date().toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow',
    hour12: false
  });
  const logMessage = `[${timestamp}] ${message}`;
  console[isError ? 'error' : 'log'](logMessage);
  if (isError) console.error(new Error().stack);
}

// Определение статуса станка
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

// Генерация случайных данных для графика
function generateRandomData(count, max) {
  return Array.from({length: count}, () => Math.floor(Math.random() * max));
}

// Получение данных о времени работы станка за текущий день
async function getMachineWorkingTime(machineId) {
  const connection = await pool.getConnection();
  
  try {
    // Получаем начало текущего дня (00:00:00)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Получаем данные о статусе станка за текущий день
    const [statusHistory] = await connection.query(`
      SELECT timestamp, event_type, value 
      FROM bit8_data 
      WHERE machine_id = ? 
        AND event_type IN (7, 21)
        AND timestamp >= ?
      ORDER BY timestamp ASC
    `, [machineId, today]);
    
    // Если данных нет, возвращаем значения по умолчанию
    if (statusHistory.length === 0) {
      return {
        workingMinutes: 0,
        stoppedMinutes: 0,
        shutdownMinutes: 0,
        lastUpdate: new Date().toISOString(),
        chartData: generateDefaultChartData()
      };
    }
    
    // Анализируем временные отрезки
    let workingTime = 0;
    let stoppedTime = 0;
    let shutdownTime = 0;
    let lastTimestamp = today;
    let lastStatus = { status: 'shutdown', statusText: 'Выключено' };
    
    statusHistory.forEach(record => {
      const currentTimestamp = new Date(record.timestamp);
      const timeDiff = (currentTimestamp - lastTimestamp) / 60000; // в минутах
      
      // Добавляем время предыдущего статуса
      if (lastStatus.status === 'working') {
        workingTime += timeDiff;
      } else if (lastStatus.status === 'stopped') {
        stoppedTime += timeDiff;
      } else {
        shutdownTime += timeDiff;
      }
      
      // Обновляем последний статус
      lastStatus = determineMachineStatus({
        SystemState: record.event_type === 7 ? record.value : undefined,
        MUSP: record.event_type === 21 ? record.value : undefined
      });
      
      lastTimestamp = currentTimestamp;
    });
    
    // Добавляем время от последней записи до текущего момента
    const finalTimeDiff = (new Date() - lastTimestamp) / 60000;
    if (lastStatus.status === 'working') {
      workingTime += finalTimeDiff;
    } else if (lastStatus.status === 'stopped') {
      stoppedTime += finalTimeDiff;
    } else {
      shutdownTime += finalTimeDiff;
    }
    
    // Генерируем данные для графиков
    chartData: {
    labels: Array.from({length: 24}, (_, i) => `${i}:00`),
    datasets [
        {
            label: 'Работает',
            data: generateHourlyData(workingTime),
            backgroundColor: 'rgba(46, 204, 113, 0.2)', // Зеленый
            borderColor: 'rgba(46, 204, 113, 1)',
            borderWidth: 1
        },
        {
            label: 'Остановлен',
            data: generateHourlyData(stoppedTime),
            backgroundColor: 'rgba(231, 76, 60, 0.2)', // Красный
            borderColor: 'rgba(231, 76, 60, 1)',
            borderWidth: 1
        },
        {
            label: 'Выключен',
            data: generateHourlyData(shutdownTime),
            backgroundColor: 'rgba(149, 165, 166, 0.2)', // Серый
            borderColor: 'rgba(149, 165, 166, 1)',
            borderWidth: 1
        }
    ]
};
    
    return {
      workingMinutes: Math.round(workingTime),
      stoppedMinutes: Math.round(stoppedTime),
      shutdownMinutes: Math.round(shutdownTime),
      lastUpdate: new Date().toISOString(),
      chartData: chartData
    };
    
  } catch (error) {
    log(`Ошибка при получении времени работы станка ${machineId}: ${error.message}`, true);
    return {
      workingMinutes: 0,
      stoppedMinutes: 0,
      shutdownMinutes: 0,
      lastUpdate: new Date().toISOString(),
      chartData: generateDefaultChartData()
    };
  } finally {
    connection.release();
  }
}

// Генерация данных по часам
function generateHourlyData(totalMinutes) {
  const data = Array(24).fill(0);
  const remainingMinutes = totalMinutes;
  
  // Распределяем минуты по часам
  for (let i = 0; i < 24 && remainingMinutes > 0; i++) {
    const maxForHour = Math.min(60, remainingMinutes);
    data[i] = Math.floor(maxForHour * Math.random());
  }
  
  return data;
}

// Генерация данных графика по умолчанию
function generateDefaultChartData() {
  return {
    labels: Array.from({length: 24}, (_, i) => `${i}:00`),
    datasets: [
      {
        label: 'Работает',
        data: Array(24).fill(0),
        backgroundColor: 'rgba(40, 167, 69, 0.2)',
        borderColor: 'rgba(40, 167, 69, 1)',
        borderWidth: 1
      },
      {
        label: 'Остановлен',
        data: Array(24).fill(0),
        backgroundColor: 'rgba(255, 193, 7, 0.2)',
        borderColor: 'rgba(255, 193, 7, 1)',
        borderWidth: 1
      },
      {
        label: 'Выключен',
        data: Array(24).fill(0),
        backgroundColor: 'rgba(220, 53, 69, 0.2)',
        borderColor: 'rgba(220, 53, 69, 1)',
        borderWidth: 1
      }
    ]
  };
}

// Получение данных станков
async function getMachineData() {
  // Проверка кэша
  const cacheAge = Date.now() - (dataCache.lastUpdated || 0);
  if (cacheAge < dataCache.ttl && !dataCache.isUpdating && dataCache.retryCount === 0) {
    log(`Используем кэшированные данные (возраст: ${cacheAge}ms)`);
    return dataCache.machines;
  }

  if (dataCache.isUpdating) {
    log('Обновление уже выполняется, возвращаем кэшированные данные');
    return dataCache.machines;
  }

  dataCache.isUpdating = true;
  const connection = await pool.getConnection();

  try {
    log('Начало загрузки данных из БД...');
    const startTime = Date.now();

    // Установка увеличенного таймаута выполнения запроса
    await connection.query('SET SESSION max_execution_time = 120000');

    // Получаем список всех станков
    const [machines] = await connection.query(`
      SELECT machine_id, cnc_name 
      FROM cnc_id_mapping 
      ORDER BY machine_id
    `);

    // Получаем последние параметры
    const [paramsData] = await connection.query(`
      SELECT fd.machine_id, fd.event_type, fd.value
      FROM float_data fd
      JOIN (
        SELECT machine_id, event_type, MAX(timestamp) as max_ts
        FROM float_data
        WHERE event_type IN (5, 6, 10, 11, 12, 40)
        GROUP BY machine_id, event_type
      ) latest ON fd.machine_id = latest.machine_id 
                AND fd.event_type = latest.event_type
                AND fd.timestamp = latest.max_ts
      ORDER BY fd.id DESC
    `);

    // Получаем статусы
    const [statusData] = await connection.query(`
      SELECT bd.machine_id, bd.event_type, bd.value
      FROM bit8_data bd
      JOIN (
        SELECT machine_id, event_type, MAX(timestamp) as max_ts
        FROM bit8_data
        WHERE event_type IN (7, 21)
        GROUP BY machine_id, event_type
      ) latest ON bd.machine_id = latest.machine_id 
                AND bd.event_type = latest.event_type
                AND bd.timestamp = latest.max_ts
      ORDER BY bd.id DESC
    `);

    // Группировка данных
    const statusMap = statusData.reduce((acc, row) => {
      if (!acc[row.machine_id]) acc[row.machine_id] = {};
      acc[row.machine_id][row.event_type] = row.value;
      return acc;
    }, {});

    const paramsMap = paramsData.reduce((acc, row) => {
      if (!acc[row.machine_id]) acc[row.machine_id] = {};
      acc[row.machine_id][row.event_type] = row.value;
      return acc;
    }, {});

    // Формирование данных станков
    const machinesData = {};
    for (const machine of machines) {
      const machineId = machine.machine_id;
      const status = determineMachineStatus({
        SystemState: statusMap[machineId]?.[7],
        MUSP: statusMap[machineId]?.[21]
      });

      const params = paramsMap[machineId] || {};
      const spindlePower = params[40] || 0;

      machinesData[machineId] = {
        internalId: machineId,
        displayName: machine.cnc_name,
        status: status.status,
        statusText: status.statusText,
        currentPerformance: Math.min(100, Math.max(0, Math.round(spindlePower))),
        lastUpdate: new Date().toISOString(),
        params: {
          feedRate: params[5] || 0,
          spindleSpeed: params[6] || 0,
          jogSwitch: params[10] || 0,
          fSwitch: params[11] || 0,
          sSwitch: params[12] || 0,
          spindlePower: spindlePower
        },
        workingTime: await getMachineWorkingTime(machineId)
      };
    }

    // Обновление кэша
    dataCache.machines = machinesData;
    dataCache.lastUpdated = Date.now();
    dataCache.lastError = null;
    dataCache.isUpdating = false;
    dataCache.retryCount = 0;

    log(`Данные загружены за ${Date.now() - startTime}ms. Всего станков: ${machines.length}`);
    return machinesData;
  } catch (error) {
    dataCache.isUpdating = false;
    dataCache.lastError = error.message;
    dataCache.retryCount++;
    
    log(`Ошибка загрузки данных (попытка ${dataCache.retryCount}/${dataCache.maxRetries}): ${error.message}`, true);
    throw error;
  } finally {
    connection.release();
  }
}

// Рассылка обновлений через WebSocket
function broadcastUpdate() {
  if (wss.clients.size === 0) {
    log('Нет активных WebSocket подключений');
    return;
  }

  const updateData = {
    type: 'UPDATE',
    data: dataCache.machines,
    timestamp: dataCache.lastUpdated,
    cacheAge: Date.now() - (dataCache.lastUpdated || 0)
  };

  let sentCount = 0;
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(updateData));
      sentCount++;
    }
  });

  log(`Обновление отправлено ${sentCount} клиентам`);
}

// Планировщик обновлений
function scheduleUpdate() {
  const update = async () => {
    try {
      await getMachineData();
      broadcastUpdate();
      dataCache.retryCount = 0;
    } catch (error) {
      const delay = Math.min(120000, dataCache.ttl * (dataCache.retryCount + 1));
      log(`Ошибка обновления. Повтор через ${delay}ms`, true);
      
      if (dataCache.retryCount >= dataCache.maxRetries) {
        log(`Достигнуто максимальное количество попыток (${dataCache.maxRetries}). Сервер продолжит работу с устаревшими данными.`);
        dataCache.retryCount = 0;
      }
      
      setTimeout(update, delay);
      return;
    }
    setTimeout(update, dataCache.ttl);
  };

  setTimeout(update, 1000);
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: dataCache.lastError ? 'error' : 'ok',
    lastUpdate: dataCache.lastUpdated,
    lastError: dataCache.lastError,
    machinesCount: Object.keys(dataCache.machines).length,
    wsClients: wss.clients.size,
    memoryUsage: process.memoryUsage(),
    uptime: process.uptime(),
    retryCount: dataCache.retryCount
  });
});

// API для получения данных станков
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await getMachineData();
    res.json({
      success: true,
      machines: machines,
      fromCache: Date.now() - dataCache.lastUpdated < dataCache.ttl,
      lastUpdated: dataCache.lastUpdated
    });
  } catch (error) {
    log(`API Error: ${error.message}`, true);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      cachedData: dataCache.machines,
      retryCount: dataCache.retryCount
    });
  }
});

// WebSocket обработчики
wss.on('connection', (ws) => {
  log(`Новое WebSocket подключение. Всего клиентов: ${wss.clients.size}`);

  // Отправляем текущие данные при подключении
  ws.send(JSON.stringify({ 
    type: 'INITIAL_DATA',
    data: dataCache.machines,
    timestamp: dataCache.lastUpdated
  }));

  // Проверка активности
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('close', () => {
    log(`WebSocket отключен. Осталось клиентов: ${wss.clients.size}`);
  });

  ws.on('error', (error) => {
    log(`WebSocket ошибка: ${error.message}`, true);
  });
});

// Проверка активности клиентов
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      log(`Отключаем неактивного клиента`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// Обработка ошибок процесса
process.on('uncaughtException', (err) => {
  log(`Неперехваченное исключение: ${err.message}`, true);
});

process.on('unhandledRejection', (err) => {
  log(`Необработанный rejection: ${err.message}`, true);
});

// Запуск сервера
app.listen(HTTP_PORT, async () => {
  log(`HTTP сервер запущен на порту ${HTTP_PORT}`);
  log(`WebSocket сервер запущен на порту ${WS_PORT}`);

  try {
    // Проверка подключения к MySQL
    const conn = await pool.getConnection();
    conn.release();
    log('Подключение к MySQL успешно');

    // Первоначальная загрузка данных
    try {
      await getMachineData();
      log('Первоначальная загрузка данных успешна');
      scheduleUpdate();
    } catch (error) {
      log(`Первоначальная загрузка данных не удалась: ${error.message}`, true);
      scheduleUpdate();
    }
  } catch (error) {
    log(`Критическая ошибка запуска: ${error.message}`, true);
    setTimeout(() => {
      log('Повторная попытка подключения к MySQL...');
      app.listen(HTTP_PORT);
    }, 10000);
  }
});

module.exports = { app, pool, wss, dataCache };