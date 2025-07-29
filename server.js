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

// Определение статуса станка (исправленная версия)
function determineMachineStatus(statusData) {
  // Приоритет MUSP - если MUSP=1, станок выключен
  if (statusData.MUSP === 1) {
    return { status: 'shutdown', statusText: 'Выключено (MUSP)' };
  }
  
  // Если нет данных о SystemState
  if (statusData.SystemState === undefined || statusData.SystemState === null) {
    return { status: 'shutdown', statusText: 'Нет данных' };
  }
  
  const systemState = parseInt(statusData.SystemState);
  
  // Определение статуса на основе SystemState
  if (systemState === 0) {
    return { status: 'shutdown', statusText: 'Выключено' };
  } else if (systemState === 1 || systemState === 3) {
    return { status: 'stopped', statusText: 'Остановлено' };
  } else if (systemState === 2 || systemState === 4) {
    // Проверяем дополнительные параметры для подтверждения работы
    if (statusData.CONP === 1 && statusData.COMU === 1) {
      return { status: 'working', statusText: 'Работает' };
    }
    return { status: 'stopped', statusText: 'Остановлено (ожидание)' };
  }
  return { status: 'shutdown', statusText: 'Неизвестный статус' };
}

// Генерация данных графика по умолчанию
function generateDefaultChartData() {
  return {
    labels: Array.from({length: 24}, (_, i) => `${i}:00`),
    datasets: [
      {
        label: 'Работает',
        data: Array(24).fill(0),
        backgroundColor: 'rgba(46, 204, 113, 0.7)',
        borderColor: 'rgba(46, 204, 113, 1)',
        borderWidth: 1
      },
      {
        label: 'Остановлен',
        data: Array(24).fill(0),
        backgroundColor: 'rgba(231, 76, 60, 0.7)',
        borderColor: 'rgba(231, 76, 60, 1)',
        borderWidth: 1
      },
      {
        label: 'Выключен',
        data: Array(24).fill(0),
        backgroundColor: 'rgba(149, 165, 166, 0.7)',
        borderColor: 'rgba(149, 165, 166, 1)',
        borderWidth: 1
      }
    ]
  };
}

// Распределение времени по часам между двумя временными метками (исправленная версия)
function distributeTimeAcrossHours(startTime, endTime, status, hourlyData) {
  let currentTime = new Date(startTime);
  const end = new Date(endTime);
  
  while (currentTime < end) {
    const currentHour = currentTime.getHours();
    const nextHourTime = new Date(currentTime);
    nextHourTime.setHours(currentHour + 1, 0, 0, 0);
    
    const segmentEndTime = new Date(Math.min(nextHourTime, end));
    const segmentMinutes = (segmentEndTime - currentTime) / 60000;
    
    // Добавляем минуты к соответствующему статусу
    if (status.status === 'working') {
      hourlyData[currentHour].working += segmentMinutes;
    } else if (status.status === 'stopped') {
      hourlyData[currentHour].stopped += segmentMinutes;
    } else {
      hourlyData[currentHour].shutdown += segmentMinutes;
    }
    
    currentTime = segmentEndTime;
  }
}

// Получение данных о времени работы станка за текущий день (исправленная версия)
async function getMachineWorkingTime(machineId) {
  const connection = await pool.getConnection();
  
  try {
    // Получаем начало текущего дня (00:00:00)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Получаем все статусные данные за текущий день
    const [statusHistory] = await connection.query(`
      SELECT timestamp, event_type, value 
      FROM bit8_data 
      WHERE machine_id = ? 
        AND timestamp >= ?
      ORDER BY timestamp ASC
    `, [machineId, today]);
    
    if (statusHistory.length === 0) {
      return {
        workingMinutes: 0,
        stoppedMinutes: 0,
        shutdownMinutes: 0,
        lastUpdate: new Date().toISOString(),
        chartData: generateDefaultChartData()
      };
    }
    
    // Инициализация данных по часам
    const hourlyData = Array(24).fill().map(() => ({
      working: 0,
      stopped: 0,
      shutdown: 0
    }));
    
    let lastTimestamp = today;
    let lastStatusData = {};
    let lastStatus = { status: 'shutdown', statusText: 'Выключено' };
    
    // Группируем данные по timestamp
    const groupedByTime = {};
    statusHistory.forEach(record => {
      if (!groupedByTime[record.timestamp]) {
        groupedByTime[record.timestamp] = {};
      }
      groupedByTime[record.timestamp][record.event_type] = record.value;
    });
    
    // Обработка истории статусов
    for (const [timestamp, records] of Object.entries(groupedByTime)) {
      const currentTimestamp = new Date(timestamp);
      
      // Формируем полные данные статуса
      const currentStatusData = {
        ...lastStatusData,
        ...records
      };
      
      // Определяем текущий статус
      const currentStatus = determineMachineStatus({
        SystemState: currentStatusData[7],
        MUSP: currentStatusData[21],
        CONP: currentStatusData[32],
        COMU: currentStatusData[19]
      });
      
      // Распределяем время между lastTimestamp и currentTimestamp
      distributeTimeAcrossHours(lastTimestamp, currentTimestamp, lastStatus, hourlyData);
      
      lastStatus = currentStatus;
      lastStatusData = currentStatusData;
      lastTimestamp = currentTimestamp;
    }
    
    // Обработка времени от последней записи до текущего момента
    const now = new Date();
    distributeTimeAcrossHours(lastTimestamp, now, lastStatus, hourlyData);
    
    // Подготовка данных для графика
    const chartData = {
      labels: Array.from({length: 24}, (_, i) => `${i}:00`),
      datasets: [
        {
          label: 'Работает',
          data: hourlyData.map(h => Math.round(h.working)),
          backgroundColor: 'rgba(46, 204, 113, 0.7)',
          borderColor: 'rgba(46, 204, 113, 1)',
          borderWidth: 1
        },
        {
          label: 'Остановлен',
          data: hourlyData.map(h => Math.round(h.stopped)),
          backgroundColor: 'rgba(231, 76, 60, 0.7)',
          borderColor: 'rgba(231, 76, 60, 1)',
          borderWidth: 1
        },
        {
          label: 'Выключен',
          data: hourlyData.map(h => Math.round(h.shutdown)),
          backgroundColor: 'rgba(149, 165, 166, 0.7)',
          borderColor: 'rgba(149, 165, 166, 1)',
          borderWidth: 1
        }
      ]
    };
    
    // Общее время за день
    const totalWorking = hourlyData.reduce((sum, h) => sum + h.working, 0);
    const totalStopped = hourlyData.reduce((sum, h) => sum + h.stopped, 0);
    const totalShutdown = hourlyData.reduce((sum, h) => sum + h.shutdown, 0);
    
    return {
      workingMinutes: Math.round(totalWorking),
      stoppedMinutes: Math.round(totalStopped),
      shutdownMinutes: Math.round(totalShutdown),
      lastUpdate: new Date().toISOString(),
      chartData: chartData
    };
    
  } catch (error) {
    console.error('Ошибка при получении времени работы станка:', error);
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

// Получение данных станков (исправленная версия)
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

    // Получаем статусы и дополнительные параметры
    const [statusData] = await connection.query(`
      SELECT bd.machine_id, bd.event_type, bd.value
      FROM bit8_data bd
      JOIN (
        SELECT machine_id, event_type, MAX(timestamp) as max_ts
        FROM bit8_data
        WHERE event_type IN (7, 21, 32, 19) /* SystemState, MUSP, CONP, COMU */
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
        MUSP: statusMap[machineId]?.[21],
        CONP: statusMap[machineId]?.[32],
        COMU: statusMap[machineId]?.[19]
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

      log(`Сформированы данные для станка ${machineId}: ${JSON.stringify({
        ...machinesData[machineId],
        workingTime: '...' // Не логируем полные данные workingTime для краткости
      })}`);
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