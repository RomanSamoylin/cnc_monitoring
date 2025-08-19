const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const moment = require('moment');
const { body, query, param, validationResult } = require('express-validator');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Конфигурация базы данных
const dbConfig = {
  host: '192.168.1.30',
  user: 'monitor',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00',
  connectionLimit: 15,
  connectTimeout: 30000,
  acquireTimeout: 30000,
  waitForConnections: true,
  queueLimit: 0
};

// Пул соединений с БД
let pool = mysql.createPool(dbConfig);

// Обработчики событий пула
pool.on('connection', (connection) => {
  console.log('Новое подключение MySQL создано');
});

pool.on('error', (err) => {
  console.error('Ошибка пула MySQL:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.log('Пересоздаем пул соединений...');
    pool = mysql.createPool(dbConfig);
  }
});

// Константы статусов
const STATUS = {
  WORKING: 'working',
  STOPPED: 'stopped',
  SHUTDOWN: 'shutdown'
};

// Кэш данных
const cache = {
  machines: null,
  workshopSummaries: {},
  machineHourlyData: {},
  machineHistory: {},
  lastUpdate: {},
  ttl: {
    machines: 30000,
    workshopSummary: 60000,
    hourlyData: 300000,
    history: 300000
  }
};

/**
 * Получает соединение из пула с обработкой ошибок
 */
async function getConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.ping();
    console.log('Успешное подключение к MySQL');
    return connection;
  } catch (error) {
    console.error('Ошибка подключения к БД:', error);
    throw new Error('Не удалось подключиться к базе данных');
  }
}

/**
 * Проверяет валидность даты
 */
function isValidDate(dateString) {
  return moment(dateString, 'YYYY-MM-DD', true).isValid();
}

/**
 * Определяет статус станка на основе данных
 */
function determineMachineStatus(statusData) {
  if (statusData.MUSP === 1) {
    return STATUS.SHUTDOWN;
  }
  
  if (statusData.SystemState === undefined || statusData.SystemState === null) {
    return STATUS.SHUTDOWN;
  }
  
  const systemState = parseInt(statusData.SystemState);
  
  if (systemState === 0) {
    return STATUS.SHUTDOWN;
  } else if (systemState === 1 || systemState === 3) {
    return STATUS.STOPPED;
  } else if (systemState === 2 || systemState === 4) {
    if (statusData.CONP === 1 && statusData.COMU === 1) {
      return STATUS.WORKING;
    }
    return STATUS.STOPPED;
  }
  return STATUS.SHUTDOWN;
}

/**
 * Получает список всех станков с обработкой ошибок
 */
async function getAllMachines(connection) {
  try {
    console.log('Запрос списка станков из БД');
    const [machines] = await connection.execute(`
      SELECT machine_id, cnc_name 
      FROM cnc_id_mapping 
      ORDER BY machine_id
    `);
    
    return machines.map(machine => ({
      id: machine.machine_id,
      name: machine.cnc_name,
      workshop: machine.machine_id <= 16 ? '1' : '2'
    }));
  } catch (error) {
    console.error('Ошибка получения списка станков:', error);
    throw new Error('Не удалось получить список станков');
  }
}

/**
 * Рассчитывает время в разных статусах для станка
 */
async function calculateMachineStatusTime(connection, machineId, startDate, endDate) {
  try {
    const start = moment(startDate);
    const end = moment(endDate);
    const totalDays = Math.ceil(end.diff(start, 'days', true));
    
    console.log(`Расчет времени для станка ${machineId} с ${start.format('YYYY-MM-DD')} по ${end.format('YYYY-MM-DD')}, дней: ${totalDays}`);

    // Получаем данные за весь период
    const [rows] = await connection.execute(`
      SELECT 
        timestamp,
        event_type,
        value
      FROM bit8_data
      FORCE INDEX (idx_bit8_data_machine_timestamp)
      WHERE 
        machine_id = ?
        AND timestamp BETWEEN ? AND ?
        AND event_type IN (7, 21, 32, 19)
      ORDER BY timestamp ASC
    `, [machineId, start.format('YYYY-MM-DD HH:mm:ss'), end.format('YYYY-MM-DD HH:mm:ss')]);

    if (rows.length === 0) {
      console.warn(`Нет данных для станка ${machineId} за период ${start.format('YYYY-MM-DD')} - ${end.format('YYYY-MM-DD')}`);
      const totalMinutes = end.diff(start, 'minutes');
      // Ограничиваем максимальное время 24 часами (1440 минут) в сутки
      const maxDailyMinutes = 1440 * totalDays;
      const actualMinutes = Math.min(totalMinutes, maxDailyMinutes);
      return {
        working: 0,
        stopped: 0,
        shutdown: actualMinutes
      };
    }

    let working = 0, stopped = 0, shutdown = 0;
    let lastStatus = STATUS.SHUTDOWN;
    let lastTime = start.clone();

    // Группируем данные по дням и timestamp
    const dailyData = {};
    rows.forEach(row => {
      const date = moment(row.timestamp).format('YYYY-MM-DD');
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      
      if (!dailyData[date]) {
        dailyData[date] = {};
      }
      
      if (!dailyData[date][timestamp]) {
        dailyData[date][timestamp] = {};
      }
      
      dailyData[date][timestamp][row.event_type] = row.value;
    });

    // Обрабатываем данные по дням
    for (const [date, dayData] of Object.entries(dailyData)) {
      const dayStart = moment(date).startOf('day');
      const dayEnd = moment(date).endOf('day');
      let dayWorking = 0, dayStopped = 0, dayShutdown = 0;
      let dayLastStatus = lastStatus;
      let dayLastTime = dayStart.clone();

      // Обрабатываем записи за день
      for (const [timestamp, data] of Object.entries(dayData)) {
        const currentTime = moment(timestamp);
        const minutes = currentTime.diff(dayLastTime, 'minutes');

        // Добавляем время к соответствующему статусу
        if (dayLastStatus === STATUS.WORKING) dayWorking += minutes;
        else if (dayLastStatus === STATUS.STOPPED) dayStopped += minutes;
        else dayShutdown += minutes;

        // Обновляем текущий статус
        dayLastStatus = determineMachineStatus({
          SystemState: data[7],
          MUSP: data[21],
          CONP: data[32],
          COMU: data[19]
        });
        
        dayLastTime = currentTime;
      }

      // Добавляем время после последней записи до конца дня
      const finalMinutes = dayEnd.diff(dayLastTime, 'minutes');
      if (dayLastStatus === STATUS.WORKING) dayWorking += finalMinutes;
      else if (dayLastStatus === STATUS.STOPPED) dayStopped += finalMinutes;
      else dayShutdown += finalMinutes;

      // Проверяем, чтобы сумма по дням не превышала 24 часа (1440 минут)
      const dayTotal = dayWorking + dayStopped + dayShutdown;
      if (dayTotal > 1440) {
        const ratio = 1440 / dayTotal;
        dayWorking = Math.round(dayWorking * ratio);
        dayStopped = Math.round(dayStopped * ratio);
        dayShutdown = Math.round(dayShutdown * ratio);
      }

      // Суммируем результаты по дням
      working += dayWorking;
      stopped += dayStopped;
      shutdown += dayShutdown;
      lastStatus = dayLastStatus;
    }

    return { 
      working: Math.round(working),
      stopped: Math.round(stopped),
      shutdown: Math.round(shutdown)
    };
  } catch (error) {
    console.error(`Ошибка расчета для станка ${machineId}:`, error);
    throw new Error('Не удалось рассчитать время статусов');
  }
}

/**
 * Генерирует данные для почасового графика
 */
async function generateHourlyChartData(connection, machineId, date) {
  const cacheKey = `${machineId}_${date}`;
  
  if (cache.machineHourlyData[cacheKey] && 
      Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.hourlyData) {
    console.log(`Использование кэшированных данных для станка ${machineId}`);
    return cache.machineHourlyData[cacheKey];
  }

  try {
    const start = moment(date).startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const end = moment(date).endOf('day').format('YYYY-MM-DD HH:mm:ss');
    
    console.log(`Генерация почасовых данных для станка ${machineId} за ${date}`);
    
    const [rows] = await connection.execute(`
      SELECT 
        timestamp,
        event_type,
        value
      FROM bit8_data
      FORCE INDEX (idx_bit8_data_machine_timestamp)
      WHERE 
        machine_id = ?
        AND timestamp BETWEEN ? AND ?
        AND event_type IN (7, 21, 32, 19)
      ORDER BY timestamp ASC
    `, [machineId, start, end]);

    const hourlyData = Array(24).fill().map(() => ({
      working: 0,
      stopped: 0,
      shutdown: 0
    }));

    if (rows.length === 0) {
      const result = {
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

      cache.machineHourlyData[cacheKey] = result;
      cache.lastUpdate[cacheKey] = Date.now();
      return result;
    }

    let lastStatus = STATUS.SHUTDOWN;
    let lastTime = moment(start);

    // Группируем данные по timestamp
    const groupedData = {};
    rows.forEach(row => {
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!groupedData[timestamp]) {
        groupedData[timestamp] = {};
      }
      groupedData[timestamp][row.event_type] = row.value;
    });

    // Распределяем время по часам
    for (const [timestamp, data] of Object.entries(groupedData)) {
      const currentTime = moment(timestamp);
      
      // Распределяем время между lastTime и currentTime
      while (lastTime.isBefore(currentTime)) {
        const hour = lastTime.hour();
        const minutes = currentTime.diff(lastTime, 'minutes');

        if (lastStatus === STATUS.WORKING) hourlyData[hour].working += minutes;
        else if (lastStatus === STATUS.STOPPED) hourlyData[hour].stopped += minutes;
        else hourlyData[hour].shutdown += minutes;

        lastTime = currentTime;
      }

      // Обновляем текущий статус
      lastStatus = determineMachineStatus({
        SystemState: data[7],
        MUSP: data[21],
        CONP: data[32],
        COMU: data[19]
      });
    }

    // Обрабатываем оставшееся время
    while (lastTime.isBefore(end)) {
      const hour = lastTime.hour();
      const minutes = moment(end).diff(lastTime, 'minutes');

      if (lastStatus === STATUS.WORKING) hourlyData[hour].working += minutes;
      else if (lastStatus === STATUS.STOPPED) hourlyData[hour].stopped += minutes;
      else hourlyData[hour].shutdown += minutes;

      lastTime = moment(end);
    }

    // Проверяем, чтобы сумма по часам не превышала 60 минут
    hourlyData.forEach(hour => {
      const total = hour.working + hour.stopped + hour.shutdown;
      if (total > 60) {
        const ratio = 60 / total;
        hour.working = Math.round(hour.working * ratio);
        hour.stopped = Math.round(hour.stopped * ratio);
        hour.shutdown = Math.round(hour.shutdown * ratio);
      }
    });

    const result = {
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

    cache.machineHourlyData[cacheKey] = result;
    cache.lastUpdate[cacheKey] = Date.now();
    return result;
  } catch (error) {
    console.error('Ошибка генерации почасовых данных:', error);
    throw new Error('Не удалось сгенерировать почасовые данные');
  }
}

/**
 * Получает детальные данные по истории статусов станка
 */
async function getMachineStatusData(connection, machineId, startDate, endDate) {
  try {
    const start = moment(startDate).format('YYYY-MM-DD HH:mm:ss');
    const end = moment(endDate).format('YYYY-MM-DD HH:mm:ss');
    
    console.log(`Запрос истории статусов для станка ${machineId} с ${start} по ${end}`);

    const [rows] = await connection.execute(`
      SELECT 
        timestamp,
        event_type,
        value
      FROM bit8_data
      FORCE INDEX (idx_bit8_data_machine_timestamp)
      WHERE 
        machine_id = ?
        AND timestamp BETWEEN ? AND ?
        AND event_type IN (7, 21, 32, 19)
      ORDER BY timestamp ASC
    `, [machineId, start, end]);

    const statusHistory = [];
    let lastStatusData = {};
    let lastStatus = STATUS.SHUTDOWN;

    // Группируем данные по timestamp
    const groupedData = {};
    rows.forEach(row => {
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!groupedData[timestamp]) {
        groupedData[timestamp] = {};
      }
      groupedData[timestamp][row.event_type] = row.value;
    });

    // Формируем историю изменений статусов
    for (const [timestamp, data] of Object.entries(groupedData)) {
      lastStatusData = { ...lastStatusData, ...data };
      const newStatus = determineMachineStatus(lastStatusData);
      
      if (newStatus !== lastStatus) {
        statusHistory.push({
          timestamp,
          status: newStatus,
          statusText: newStatus === STATUS.WORKING ? 'Работает' : 
                     newStatus === STATUS.STOPPED ? 'Остановлено' : 'Выключено'
        });
        lastStatus = newStatus;
      }
    }

    return {
      machineId,
      statusHistory,
      currentStatus: lastStatus
    };
  } catch (error) {
    console.error('Ошибка получения истории статусов:', error);
    throw new Error('Не удалось получить историю статусов');
  }
}

function validateErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ 
      success: false, 
      errors: errors.array() 
    });
  }
  next();
}

function errorHandler(err, req, res, next) {
  console.error('Ошибка:', err.stack);
  
  let errorMessage = 'Внутренняя ошибка сервера';
  let statusCode = 500;
  
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    errorMessage = 'Ошибка доступа к базе данных';
  } else if (err.code === 'ECONNREFUSED') {
    errorMessage = 'Не удалось подключиться к базе данных';
  } else if (err.message.includes('Не удалось рассчитать')) {
    errorMessage = err.message;
  }
  
  res.status(statusCode).json({ 
    success: false, 
    error: errorMessage,
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

// API Endpoints

/**
 * Получает список всех станков
 */
app.get('/api/machines', async (req, res, next) => {
  let connection;
  try {
    if (cache.machines && Date.now() - cache.lastUpdate.machines < cache.ttl.machines) {
      return res.json({
        success: true,
        fromCache: true,
        machines: cache.machines
      });
    }

    connection = await getConnection();
    
    try {
      const machines = await getAllMachines(connection);
      const machinesData = {};
      
      machines.forEach(machine => {
        machinesData[machine.id] = {
          name: machine.name,
          workshop: machine.workshop
        };
      });

      cache.machines = machinesData;
      cache.lastUpdate.machines = Date.now();

      res.json({
        success: true,
        fromCache: false,
        machines: machinesData
      });
    } finally {
      if (connection) await connection.release();
    }
  } catch (error) {
    next(error);
  }
});

/**
 * Получает сводку по цехам
 */
app.get('/api/workshops/summary', 
  [
    query('startDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('endDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('startDate').isISO8601().withMessage('Неверный формат начальной даты'),
    query('endDate').isISO8601().withMessage('Неверный формат конечной даты')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const startDate = moment(req.query.startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const endDate = moment(req.query.endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss');
      const cacheKey = `${startDate}_${endDate}`;
      
      if (cache.workshopSummaries[cacheKey] && 
          Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.workshopSummary) {
        return res.json({
          success: true,
          fromCache: true,
          data: cache.workshopSummaries[cacheKey]
        });
      }

      connection = await getConnection();
      
      try {
        console.log(`Загрузка данных цехов с ${startDate} по ${endDate}`);
        const machines = await getAllMachines(connection);
        const workshop1 = { working: 0, stopped: 0, shutdown: 0 };
        const workshop2 = { working: 0, stopped: 0, shutdown: 0 };

        // Обрабатываем станки пачками по 5 для уменьшения нагрузки
        const batchSize = 5;
        for (let i = 0; i < machines.length; i += batchSize) {
          const batch = machines.slice(i, i + batchSize);
          await Promise.all(batch.map(async machine => {
            try {
              console.log(`Обработка станка ${machine.id}`);
              const stats = await calculateMachineStatusTime(
                connection,
                machine.id,
                startDate,
                endDate
              );

              if (machine.workshop === '1') {
                workshop1.working += stats.working;
                workshop1.stopped += stats.stopped;
                workshop1.shutdown += stats.shutdown;
              } else {
                workshop2.working += stats.working;
                workshop2.stopped += stats.stopped;
                workshop2.shutdown += stats.shutdown;
              }
            } catch (error) {
              console.error(`Ошибка обработки станка ${machine.id}:`, error);
              // Продолжаем обработку других станков
            }
          }));
        }

        const result = {
          workshop1,
          workshop2,
          total: {
            working: workshop1.working + workshop2.working,
            stopped: workshop1.stopped + workshop2.stopped,
            shutdown: workshop1.shutdown + workshop2.shutdown
          }
        };

        cache.workshopSummaries[cacheKey] = result;
        cache.lastUpdate[cacheKey] = Date.now();

        res.json({
          success: true,
          fromCache: false,
          data: result
        });
      } finally {
        if (connection) await connection.release();
      }
    } catch (error) {
      console.error('Глобальная ошибка:', error);
      next(error);
    }
  }
);

/**
 * Получает почасовые данные работы станка
 */
app.get('/api/machines/:id/hourly', 
  [
    param('id').isInt().toInt(),
    query('date').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('date').isISO8601().withMessage('Неверный формат даты')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { id } = req.params;
      const { date } = req.query;

      connection = await getConnection();
      
      try {
        const chartData = await generateHourlyChartData(connection, id, date);
        
        res.json({
          success: true,
          data: chartData
        });
      } finally {
        if (connection) await connection.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Получает детальную историю статусов станка
 */
app.get('/api/machines/:id/history/detailed', 
  [
    param('id').isInt().toInt(),
    query('startDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('endDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('startDate').isISO8601().withMessage('Неверный формат начальной даты'),
    query('endDate').isISO8601().withMessage('Неверный формат конечной даты')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { id } = req.params;
      const startDate = moment(req.query.startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const endDate = moment(req.query.endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss');
      const cacheKey = `${id}_${startDate}_${endDate}`;
      
      if (cache.machineHistory[cacheKey] && 
          Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.history) {
        return res.json({
          success: true,
          fromCache: true,
          data: cache.machineHistory[cacheKey]
        });
      }

      connection = await getConnection();
      
      try {
        const data = await getMachineStatusData(connection, id, startDate, endDate);
        
        cache.machineHistory[cacheKey] = data.statusHistory;
        cache.lastUpdate[cacheKey] = Date.now();
        
        res.json({
          success: true,
          fromCache: false,
          data: data.statusHistory
        });
      } finally {
        if (connection) await connection.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * Получает сводку по работе станка за период
 */
app.get('/api/machines/:id/history/summary', 
  [
    param('id').isInt().toInt(),
    query('startDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('endDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('startDate').isISO8601().withMessage('Неверный формат начальной даты'),
    query('endDate').isISO8601().withMessage('Неверный формат конечной даты')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { id } = req.params;
      const startDate = moment(req.query.startDate).startOf('day').format('YYYY-MM-DD HH:mm:ss');
      const endDate = moment(req.query.endDate).endOf('day').format('YYYY-MM-DD HH:mm:ss');
      
      connection = await getConnection();
      
      try {
        console.log(`Загрузка сводки для станка ${id} с ${startDate} по ${endDate}`);
        
        const stats = await calculateMachineStatusTime(connection, id, startDate, endDate);
        
        res.json({
          success: true,
          data: {
            working: stats.working / 60,  // Переводим минуты в часы
            stopped: stats.stopped / 60,
            shutdown: stats.shutdown / 60
          }
        });
      } finally {
        if (connection) await connection.release();
      }
    } catch (error) {
      console.error('Ошибка получения сводки:', error);
      next(error);
    }
  }
);

app.use(errorHandler);

// Запуск сервера с проверкой подключения
async function startServer() {
  try {
    console.log('Проверка подключения к MySQL...');
    const testConn = await pool.getConnection();
    await testConn.query('SELECT 1');
    testConn.release();
    
    console.log('Успешное подключение к MySQL');
    
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Сервер аналитики запущен на порту ${PORT}`);
      console.log(`Текущее время сервера: ${new Date()}`);
    });
  } catch (err) {
    console.error('Не удалось подключиться к MySQL:', err);
    process.exit(1);
  }
}

startServer();

process.on('SIGTERM', async () => {
  console.log('Получен SIGTERM. Закрытие пула соединений...');
  await pool.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Получен SIGINT. Закрытие пула соединений...');
  await pool.end();
  process.exit(0);
});

module.exports = app;