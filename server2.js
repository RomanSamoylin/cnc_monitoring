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
  connectionLimit: 10,
  connectTimeout: 10000,
  waitForConnections: true,
  queueLimit: 0
};

// Пул соединений с БД
const pool = mysql.createPool(dbConfig);

// Обработчики событий пула
pool.on('connection', (connection) => {
  console.log('New MySQL connection created');
});

pool.on('error', (err) => {
  console.error('MySQL pool error:', err);
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
    console.log('Successfully connected to MySQL');
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
 * Получает данные о статусах станка за период с оптимизацией для больших диапазонов
 */
async function getMachineStatusData(connection, machineId, startDate, endDate) {
  try {
    const daysDiff = moment(endDate).diff(moment(startDate), 'days');
    const sampleInterval = daysDiff > 7 ? 'HOUR' : 'MINUTE';
    
    const [statusData] = await connection.execute(`
      SELECT 
        event_type,
        value,
        DATE_FORMAT(timestamp, '%Y-%m-%d %H:%i:00') as timestamp
      FROM bit8_data
      WHERE 
        machine_id = ?
        AND event_type IN (7, 21, 32, 19) /* SystemState, MUSP, CONP, COMU */
        AND timestamp BETWEEN ? AND ?
      GROUP BY 
        event_type, 
        DATE_FORMAT(timestamp, ?)
      ORDER BY timestamp ASC
    `, [machineId, startDate, endDate, sampleInterval === 'HOUR' ? '%Y-%m-%d %H:00:00' : '%Y-%m-%d %H:%i:00']);

    const groupedData = {};
    statusData.forEach(record => {
      const timestamp = moment(record.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!groupedData[timestamp]) {
        groupedData[timestamp] = {};
      }
      groupedData[timestamp][record.event_type] = record.value;
    });

    const statusHistory = [];
    let lastStatus = STATUS.SHUTDOWN;
    let lastStatusData = {};

    Object.entries(groupedData).forEach(([timestamp, records]) => {
      lastStatusData = { ...lastStatusData, ...records };
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
    });

    return {
      machineId,
      statusHistory,
      currentStatus: lastStatus
    };
  } catch (error) {
    console.error('Ошибка получения данных статуса:', error);
    throw new Error('Не удалось получить данные статуса станка');
  }
}

/**
 * Рассчитывает время в разных статусах для станка с оптимизацией
 */
async function calculateMachineStatusTime(connection, machineId, startDate, endDate) {
  try {
    const daysDiff = moment(endDate).diff(moment(startDate), 'days');
    
    if (daysDiff > 30) {
      return approximateStatusTime(connection, machineId, startDate, endDate);
    }
    
    const data = await getMachineStatusData(connection, machineId, startDate, endDate);
    
    let workingMinutes = 0;
    let stoppedMinutes = 0;
    let shutdownMinutes = 0;
    let lastStatus = data.statusHistory.length > 0 ? 
      data.statusHistory[0].status : STATUS.SHUTDOWN;
    let lastTimestamp = moment(startDate);

    for (const event of data.statusHistory) {
      const eventTime = moment(event.timestamp);
      const minutesDiff = eventTime.diff(lastTimestamp, 'minutes');

      if (lastStatus === STATUS.WORKING) workingMinutes += minutesDiff;
      else if (lastStatus === STATUS.STOPPED) stoppedMinutes += minutesDiff;
      else shutdownMinutes += minutesDiff;

      lastStatus = event.status;
      lastTimestamp = eventTime;
    }

    const finalMinutes = moment(endDate).diff(lastTimestamp, 'minutes');
    if (lastStatus === STATUS.WORKING) workingMinutes += finalMinutes;
    else if (lastStatus === STATUS.STOPPED) stoppedMinutes += finalMinutes;
    else shutdownMinutes += finalMinutes;

    return {
      working: workingMinutes,
      stopped: stoppedMinutes,
      shutdown: shutdownMinutes
    };
  } catch (error) {
    console.error('Ошибка расчета времени статусов:', error);
    throw new Error('Не удалось рассчитать время статусов');
  }
}

/**
 * Приблизительный расчет времени статусов для больших диапазонов
 */
async function approximateStatusTime(connection, machineId, startDate, endDate) {
  try {
    const [dailyData] = await connection.execute(`
      SELECT 
        DATE(timestamp) as day,
        AVG(CASE WHEN event_type = 7 THEN value ELSE NULL END) as SystemState,
        AVG(CASE WHEN event_type = 21 THEN value ELSE NULL END) as MUSP,
        AVG(CASE WHEN event_type = 32 THEN value ELSE NULL END) as CONP,
        AVG(CASE WHEN event_type = 19 THEN value ELSE NULL END) as COMU
      FROM bit8_data
      WHERE 
        machine_id = ?
        AND timestamp BETWEEN ? AND ?
      GROUP BY DATE(timestamp)
      ORDER BY day
    `, [machineId, startDate, endDate]);

    let workingDays = 0;
    let stoppedDays = 0;
    let shutdownDays = 0;

    dailyData.forEach(day => {
      const status = determineMachineStatus(day);
      if (status === STATUS.WORKING) workingDays++;
      else if (status === STATUS.STOPPED) stoppedDays++;
      else shutdownDays++;
    });

    const totalDays = moment(endDate).diff(moment(startDate), 'days') + 1;
    const minutesPerDay = 1440;

    return {
      working: Math.round(workingDays / totalDays * minutesPerDay),
      stopped: Math.round(stoppedDays / totalDays * minutesPerDay),
      shutdown: Math.round(shutdownDays / totalDays * minutesPerDay)
    };
  } catch (error) {
    console.error('Ошибка приблизительного расчета:', error);
    throw new Error('Не удалось выполнить приблизительный расчет');
  }
}

/**
 * Генерирует данные для почасового графика с кэшированием
 */
async function generateHourlyChartData(connection, machineId, date) {
  const cacheKey = `${machineId}_${date}`;
  
  if (cache.machineHourlyData[cacheKey] && 
      Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.hourlyData) {
    return cache.machineHourlyData[cacheKey];
  }

  try {
    const startDate = moment(date).startOf('day').format('YYYY-MM-DD HH:mm:ss');
    const endDate = moment(date).endOf('day').format('YYYY-MM-DD HH:mm:ss');
    
    const data = await getMachineStatusData(connection, machineId, startDate, endDate);
    
    const hourlyData = Array(24).fill().map(() => ({
      working: 0,
      stopped: 0,
      shutdown: 0
    }));

    let lastStatus = data.statusHistory.length > 0 ? 
      data.statusHistory[0].status : STATUS.SHUTDOWN;
    let lastTimestamp = moment(startDate);

    for (const event of data.statusHistory) {
      const eventTime = moment(event.timestamp);
      distributeTime(lastTimestamp, eventTime, lastStatus, hourlyData);
      lastStatus = event.status;
      lastTimestamp = eventTime;
    }

    distributeTime(lastTimestamp, moment(endDate), lastStatus, hourlyData);

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

function distributeTime(startTime, endTime, status, hourlyData) {
  let currentTime = moment(startTime);
  
  while (currentTime.isBefore(endTime)) {
    const currentHour = currentTime.hour();
    const nextHour = moment(currentTime).add(1, 'hour').startOf('hour');
    const segmentEnd = moment.min(nextHour, endTime);
    const minutes = segmentEnd.diff(currentTime, 'minutes');

    if (status === STATUS.WORKING) {
      hourlyData[currentHour].working += minutes;
    } else if (status === STATUS.STOPPED) {
      hourlyData[currentHour].stopped += minutes;
    } else {
      hourlyData[currentHour].shutdown += minutes;
    }

    currentTime = segmentEnd;
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
  res.status(500).json({ 
    success: false, 
    error: 'Внутренняя ошибка сервера' 
  });
}

// API Endpoints
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
      await connection.release();
    }
  } catch (error) {
    next(error);
  }
});

app.get('/api/workshops/summary', 
  [
    query('startDate').isISO8601().toDate(),
    query('endDate').isISO8601().toDate()
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { startDate, endDate } = req.query;
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
        const machines = await getAllMachines(connection);
        const workshop1 = { working: 0, stopped: 0, shutdown: 0 };
        const workshop2 = { working: 0, stopped: 0, shutdown: 0 };

        const promises = machines.map(async machine => {
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
        });

        await Promise.all(promises);

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
        await connection.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

app.get('/api/machines/:id/hourly', 
  [
    param('id').isInt().toInt(),
    query('date').isISO8601().toDate()
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
        await connection.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

app.get('/api/machines/:id/history/detailed', 
  [
    param('id').isInt().toInt(),
    query('startDate').isISO8601().toDate(),
    query('endDate').isISO8601().toDate()
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { id } = req.params;
      const { startDate, endDate } = req.query;
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
        await connection.release();
      }
    } catch (error) {
      next(error);
    }
  }
);

app.use(errorHandler);

// Запуск сервера с проверкой подключения
async function startServer() {
  try {
    const testConn = await pool.getConnection();
    await testConn.ping();
    testConn.release();
    
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