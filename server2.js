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
  workshopHourlyData: {},
  partsData: {},
  partsDailyData: {},
  lastUpdate: {},
  ttl: {
    machines: 30000,
    workshopSummary: 60000,
    hourlyData: 300000,
    history: 300000,
    workshopHourly: 300000,
    partsData: 300000,
    partsDailyData: 300000
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
 * Вспомогательная функция для распределения времени по часам
 */
function distributeTimeToHours(startTime, endTime, status, hourlyData) {
  let current = startTime.clone();
  
  while (current.isBefore(endTime)) {
    const hour = current.hour();
    const nextHour = current.clone().add(1, 'hour').startOf('hour');
    const segmentEnd = moment.min(nextHour, endTime);
    
    const minutes = segmentEnd.diff(current, 'minutes');
    
    if (status === STATUS.WORKING) {
      hourlyData[hour].working += minutes;
    } else if (status === STATUS.STOPPED) {
      hourlyData[hour].stopped += minutes;
    } else {
      hourlyData[hour].shutdown += minutes;
    }
    
    current = segmentEnd;
  }
}

/**
 * Рассчитывает время в разных статусах для станка (исправленная версия)
 */
async function calculateMachineStatusTime(connection, machineId, startDate, endDate) {
  try {
    let start = moment(startDate).startOf('day');
    let end = moment(endDate).endOf('day');
    
    // Если начальная и конечная даты одинаковые (период "День"), используем текущее время вместо конца дня
    if (moment(startDate).isSame(endDate, 'day') && moment().isSame(endDate, 'day')) {
      end = moment();
    }
    
    console.log(`Расчет времени для станка ${machineId} с ${start.format('YYYY-MM-DD HH:mm:ss')} по ${end.format('YYYY-MM-DD HH:mm:ss')}`);

    const [rows] = await connection.execute(`
      SELECT 
        timestamp,
        event_type,
        value
      FROM bit8_data
      WHERE 
        machine_id = ?
        AND timestamp BETWEEN ? AND ?
        AND event_type IN (7, 21, 32, 19)
      ORDER BY timestamp ASC
    `, [machineId, start.format('YYYY-MM-DD HH:mm:ss'), end.format('YYYY-MM-DD HH:mm:ss')]);

    if (rows.length === 0) {
      const totalMinutes = end.diff(start, 'minutes');
      return {
        working: 0,
        stopped: 0,
        shutdown: totalMinutes
      };
    }

    // Группируем данные по timestamp
    const events = {};
    rows.forEach(row => {
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!events[timestamp]) events[timestamp] = {};
      events[timestamp][row.event_type] = row.value;
    });

    const sortedTimestamps = Object.keys(events).sort();
    let totalWorking = 0, totalStopped = 0, totalShutdown = 0;
    let lastStatus = STATUS.SHUTDOWN;
    let lastTime = start.clone();

    // Обрабатываем каждое событие
    for (const timestamp of sortedTimestamps) {
      const currentTime = moment(timestamp);
      const currentData = events[timestamp];
      
      // Определяем статус на основе текущих данных
      const currentStatus = determineMachineStatus({
        SystemState: currentData[7],
        MUSP: currentData[21],
        CONP: currentData[32],
        COMU: currentData[19]
      });

      // Рассчитываем время между событиями
      const minutesDiff = currentTime.diff(lastTime, 'minutes');
      
      // Добавляем время к соответствующему статусу
      if (lastStatus === STATUS.WORKING) totalWorking += minutesDiff;
      else if (lastStatus === STATUS.STOPPED) totalStopped += minutesDiff;
      else totalShutdown += minutesDiff;

      lastStatus = currentStatus;
      lastTime = currentTime;
    }

    // Добавляем время от последнего событий до конца периода
    const finalMinutes = end.diff(lastTime, 'minutes');
    if (lastStatus === STATUS.WORKING) totalWorking += finalMinutes;
    else if (lastStatus === STATUS.STOPPED) totalStopped += finalMinutes;
    else totalShutdown += finalMinutes;

    return { 
      working: Math.round(totalWorking),
      stopped: Math.round(totalStopped),
      shutdown: Math.round(totalShutdown)
    };
  } catch (error) {
    console.error(`Ошибка расчета для станка ${machineId}:`, error);
    throw new Error('Не удалось рассчитать время статусов');
  }
}

/**
 * Генерирует данные для почасового графика (исправленная версия)
 */
async function generateHourlyChartData(connection, machineId, date) {
  try {
    const dayStart = moment(date).startOf('day');
    let dayEnd = moment(date).endOf('day');
    
    // Проверяем, является ли запрашиваемая дата сегодняшней
    const isToday = moment().isSame(dayStart, 'day');
    const currentHour = moment().hour();
    
    // Если дата сегодняшняя, используем текущее время вместо конца дня
    if (isToday) {
      dayEnd = moment();
    }
    
    const [rows] = await connection.execute(`
      SELECT 
        timestamp,
        event_type,
        value
      FROM bit8_data
      WHERE 
        machine_id = ?
        AND timestamp BETWEEN ? AND ?
        AND event_type IN (7, 21, 32, 19)
      ORDER BY timestamp ASC
    `, [machineId, dayStart.format('YYYY-MM-DD HH:mm:ss'), dayEnd.format('YYYY-MM-DD HH:mm:ss')]);

    // Инициализируем данные для каждого часа
    const hourlyData = Array(24).fill().map(() => ({
      working: 0,
      stopped: 0,
      shutdown: 0
    }));

    if (rows.length === 0) {
      // Если нет данных, считаем весь день выключенным
      const totalHours = isToday ? currentHour + 1 : 24;
      const result = {
        labels: Array.from({length: totalHours}, (_, i) => `${i}:00`),
        datasets: [
          {
            label: 'Работает',
            data: Array(totalHours).fill(0),
            backgroundColor: 'rgba(46, 204, 113, 0.7)',
            borderColor: 'rgba(46, 204, 113, 1)',
            borderWidth: 1
          },
          {
            label: 'Остановлен',
            data: Array(totalHours).fill(0),
            backgroundColor: 'rgba(231, 76, 60, 0.7)',
            borderColor: 'rgba(231, 76, 60, 1)',
            borderWidth: 1
          },
          {
            label: 'Выключен',
            data: Array(totalHours).fill(0),
            backgroundColor: 'rgba(149, 165, 166, 0.7)',
            borderColor: 'rgba(149, 165, 166, 1)',
            borderWidth: 1
          }
        ]
      };
      
      return result;
    }

    // Группируем события по timestamp
    const events = {};
    rows.forEach(row => {
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!events[timestamp]) events[timestamp] = {};
      events[timestamp][row.event_type] = row.value;
    });

    const sortedTimestamps = Object.keys(events).sort();
    let lastStatus = STATUS.SHUTDOWN;
    let lastTime = dayStart.clone();

    // Обрабатываем каждое событие
    for (const timestamp of sortedTimestamps) {
      const currentTime = moment(timestamp);
      const currentData = events[timestamp];
      
      // Определяем статус
      const currentStatus = determineMachineStatus({
        SystemState: currentData[7],
        MUSP: currentData[21],
        CONP: currentData[32],
        COMU: currentData[19]
      });

      // Распределяем время по часам
      distributeTimeToHours(lastTime, currentTime, lastStatus, hourlyData);
      
      lastStatus = currentStatus;
      lastTime = currentTime;
    }

    // Обрабатываем оставшееся время до конца дня
    distributeTimeToHours(lastTime, dayEnd, lastStatus, hourlyData);

    // Формируем данные для графика
    const totalHours = isToday ? currentHour + 1 : 24;
    const result = {
      labels: Array.from({length: totalHours}, (_, i) => `${i}:00`),
      datasets: [
        {
          label: 'Работает',
          data: hourlyData.slice(0, totalHours).map(h => Math.round(h.working)),
          backgroundColor: 'rgba(46, 204, 113, 0.7)',
          borderColor: 'rgba(46, 204, 113, 1)',
          borderWidth: 1
        },
        {
          label: 'Остановлен',
          data: hourlyData.slice(0, totalHours).map(h => Math.round(h.stopped)),
          backgroundColor: 'rgba(231, 76, 60, 0.7)',
          borderColor: 'rgba(231, 76, 60, 1)',
          borderWidth: 1
        },
        {
          label: 'Выключен',
          data: hourlyData.slice(0, totalHours).map(h => Math.round(h.shutdown)),
          backgroundColor: 'rgba(149, 165, 166, 0.7)',
          borderColor: 'rgba(149, 165, 166, 1)',
          borderWidth: 1
        }
      ]
    };

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
        let start = moment(startDate).format('YYYY-MM-DD HH:mm:ss');
        let end = moment(endDate).format('YYYY-MM-DD HH:mm:ss');
        
        // Если начальная и конечная даты одинаковые (период "День"), используем текущее время
        if (moment(startDate).isSame(endDate, 'day') && moment().isSame(endDate, 'day')) {
            end = moment().format('YYYY-MM-DD HH:mm:ss');
        }
        
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

        // Если данных нет, создаем запись о выключенном состоянии на весь период
        if (rows.length === 0) {
            statusHistory.push({
                timestamp: start,
                status: STATUS.SHUTDOWN
            });
            statusHistory.push({
                timestamp: end,
                status: STATUS.SHUTDOWN
            });
            
            return {
                machineId,
                statusHistory,
                currentStatus: STATUS.SHUTDOWN
            };
        }

    // Группируем данные по timestamp
    const groupedData = {};
    rows.forEach(row => {
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!groupedData[timestamp]) groupedData[timestamp] = {};
      groupedData[timestamp][row.event_type] = row.value;
    });

     // Формируем историю изменений статусов
        for (const [timestamp, data] of Object.entries(groupedData)) {
            lastStatusData = { ...lastStatusData, ...data };
            const newStatus = determineMachineStatus(lastStatusData);
            
            if (newStatus !== lastStatus) {
                statusHistory.push({
                    timestamp,
                    status: newStatus
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

/**
 * Генерирует агрегированные почасовые данные для всех станков или станков цеха
 */
async function generateWorkshopHourlyData(connection, workshop, date) {
  try {
    const dayStart = moment(date).startOf('day');
    let dayEnd = moment(date).endOf('day');
    
    // Проверяем, является ли запрашиваемая дата сегодняшней
    const isToday = moment().isSame(dayStart, 'day');
    const currentHour = moment().hour();
    
    // Если дата сегодняшняя, используем текущее время вместо конца дня
    if (isToday) {
      dayEnd = moment();
    }
    
    // Определяем условие WHERE в зависимости от параметра workshop
    let whereClause = '';
    let params = [dayStart.format('YYYY-MM-DD HH:mm:ss'), dayEnd.format('YYYY-MM-DD HH:mm:ss')];
    
    if (workshop && workshop !== 'all') {
      if (workshop === '1') {
        whereClause = 'AND machine_id <= 16';
      } else if (workshop === '2') {
        whereClause = 'AND machine_id > 16';
      }
    }
    
    console.log(`Генерация агрегированных почасовых данных для цеха ${workshop || 'all'} на дату ${date}`);
    
    const [rows] = await connection.execute(`
      SELECT 
        machine_id,
        timestamp,
        event_type,
        value
      FROM bit8_data
      WHERE 
        timestamp BETWEEN ? AND ?
        AND event_type IN (7, 21, 32, 19)
        ${whereClause}
      ORDER BY timestamp ASC
    `, params);

    if (rows.length === 0) {
      // Если нет данных, возвращаем пустой результат
      const totalHours = isToday ? currentHour + 1 : 24;
      const result = {
        labels: Array.from({length: totalHours}, (_, i) => `${i}:00`),
        datasets: [
          {
            label: 'Работает',
            data: Array(totalHours).fill(0),
            backgroundColor: 'rgba(46, 204, 113, 0.7)',
            borderColor: 'rgba(46, 204, 113, 1)',
            borderWidth: 1
          },
          {
            label: 'Остановлен',
            data: Array(totalHours).fill(0),
            backgroundColor: 'rgba(231, 76, 60, 0.7)',
            borderColor: 'rgba(231, 76, 60, 1)',
            borderWidth: 1
          },
          {
            label: 'Выключен',
            data: Array(totalHours).fill(0),
            backgroundColor: 'rgba(149, 165, 166, 0.7)',
            borderColor: 'rgba(149, 165, 166, 1)',
            borderWidth: 1
          }
        ]
      };
      
      return result;
    }

    // Группируем данные по machine_id и timestamp
    const machineEvents = {};
    rows.forEach(row => {
      if (!machineEvents[row.machine_id]) {
        machineEvents[row.machine_id] = {};
      }
      
      const timestamp = moment(row.timestamp).format('YYYY-MM-DD HH:mm:ss');
      if (!machineEvents[row.machine_id][timestamp]) {
        machineEvents[row.machine_id][timestamp] = {};
      }
      
      machineEvents[row.machine_id][timestamp][row.event_type] = row.value;
    });

    // Инициализируем данные для каждого часа
    const hourlyData = Array(24).fill().map(() => ({
      working: 0,
      stopped: 0,
      shutdown: 0
    }));

    // Обрабатываем данные для каждого станка
    for (const machineId of Object.keys(machineEvents)) {
      const timestamps = Object.keys(machineEvents[machineId]).sort();
      let lastStatus = STATUS.SHUTDOWN;
      let lastTime = dayStart.clone();

      // Обрабатываем каждое событие для текущего станка
      for (const timestamp of timestamps) {
        const currentTime = moment(timestamp);
        const currentData = machineEvents[machineId][timestamp];
        
        // Определяем статус
        const currentStatus = determineMachineStatus({
          SystemState: currentData[7],
          MUSP: currentData[21],
          CONP: currentData[32],
          COMU: currentData[19]
        });

        // Распределяем время по часам для текущего станка
        distributeTimeToHours(lastTime, currentTime, lastStatus, hourlyData);
        
        lastStatus = currentStatus;
        lastTime = currentTime;
      }

      // Обрабатываем оставшееся время до конца дня для текущего станка
      distributeTimeToHours(lastTime, dayEnd, lastStatus, hourlyData);
    }

    // Формируем данные для графика
    const totalHours = isToday ? currentHour + 1 : 24;
    const result = {
      labels: Array.from({length: totalHours}, (_, i) => `${i}:00`),
      datasets: [
        {
          label: 'Работает',
          data: hourlyData.slice(0, totalHours).map(h => Math.round(h.working)),
          backgroundColor: 'rgba(46, 204, 113, 0.7)',
          borderColor: 'rgba(46, 204, 113, 1)',
          borderWidth: 1
        },
        {
          label: 'Остановлен',
          data: hourlyData.slice(0, totalHours).map(h => Math.round(h.stopped)),
          backgroundColor: 'rgba(231, 76, 60, 0.7)',
          borderColor: 'rgba(231, 76, 60, 1)',
          borderWidth: 1
        },
        {
          label: 'Выключен',
          data: hourlyData.slice(0, totalHours).map(h => Math.round(h.shutdown)),
          backgroundColor: 'rgba(149, 165, 166, 0.7)',
          borderColor: 'rgba(149, 165, 166, 1)',
          borderWidth: 1
        }
      ]
    };

    return result;
  } catch (error) {
    console.error('Ошибка генерации агрегированных почасовых данных:', error);
    throw new Error('Не удалось сгенерировать агрегированные почасовые данные');
  }
}

/**
 * Получает данные о количестве деталей по часам
 */
async function getPartsData(connection, startDate, endDate, workshop = 'all') {
  try {
    const start = moment(startDate).startOf('day');
    const end = moment(endDate).endOf('day');
    
    // Определяем условие WHERE в зависимости от параметра workshop
    let whereClause = '';
    let params = [start.format('YYYY-MM-DD HH:mm:ss'), end.format('YYYY-MM-DD HH:mm:ss')];
    
    if (workshop && workshop !== 'all') {
      if (workshop === '1') {
        whereClause = 'AND machine_id <= 16';
      } else if (workshop === '2') {
        whereClause = 'AND machine_id > 16';
      }
    }
    
    console.log(`Запрос данных о деталях с ${start.format('YYYY-MM-DD')} по ${end.format('YYYY-MM-DD')} для цеха ${workshop}`);
    
    // Запрос для получения количества деталей по часам
    const [rows] = await connection.execute(`
      SELECT 
        DATE_FORMAT(timestamp, '%Y-%m-%d %H:00:00') as hour,
        COUNT(*) as parts_count
      FROM bit8_data
      WHERE 
        timestamp BETWEEN ? AND ?
        AND event_type = 29
        AND value = 0
        ${whereClause}
      GROUP BY DATE_FORMAT(timestamp, '%Y-%m-%d %H')
      ORDER BY hour
    `, params);

    // Запрос для получения общего количества деталей
    const [totalRows] = await connection.execute(`
      SELECT COUNT(*) as total_parts
      FROM bit8_data
      WHERE 
        timestamp BETWEEN ? AND ?
        AND event_type = 29
        AND value = 0
        ${whereClause}
    `, params);

    // Формируем данные для графика
    const hours = [];
    const partsData = [];
    
    // Создаем карту для быстрого доступа к данным по часам
    const dataMap = new Map();
    rows.forEach(row => {
      dataMap.set(moment(row.hour).format('YYYY-MM-DD HH'), row.parts_count);
    });

    // Заполняем все часы в периоде
    let currentHour = start.clone();
    while (currentHour <= end) {
      const hourKey = currentHour.format('YYYY-MM-DD HH');
      hours.push(currentHour.format('DD.MM HH:00'));
      partsData.push(dataMap.get(hourKey) || 0);
      currentHour.add(1, 'hour');
    }

    return {
      labels: hours,
      datasets: [{
        label: 'Количество деталей',
        data: partsData,
        backgroundColor: 'rgba(54, 162, 235, 0.7)',
        borderColor: 'rgba(54, 162, 235, 1)',
        borderWidth: 1
      }],
      total: totalRows[0].total_parts || 0
    };
  } catch (error) {
    console.error('Ошибка получения данных о деталях:', error);
    throw new Error('Не удалось получить данные о деталях');
  }
}

/**
 * Получает данные о количестве деталей по дням - ИСПРАВЛЕННАЯ ВЕРСИЯ
 */
async function getPartsDailyData(connection, startDate, endDate, workshop = 'all') {
    try {
        const start = moment(startDate).startOf('day');
        const end = moment(endDate).endOf('day');
        
        // Определяем условие WHERE в зависимости от параметра workshop
        let whereClause = '';
        let params = [start.format('YYYY-MM-DD HH:mm:ss'), end.format('YYYY-MM-DD HH:mm:ss')];
        
        if (workshop && workshop !== 'all') {
            if (workshop === '1') {
                whereClause = 'AND machine_id <= 16';
            } else if (workshop === '2') {
                whereClause = 'AND machine_id > 16';
            }
        }
        
        console.log(`Запрос данных о деталях по дням с ${start.format('YYYY-MM-DD')} по ${end.format('YYYY-MM-DD')} для цеха ${workshop}`);
        
        // Запрос для получения количества деталей по дням
        const [rows] = await connection.execute(`
            SELECT 
                DATE(timestamp) as date,
                COUNT(*) as parts_count
            FROM bit8_data
            WHERE 
                timestamp BETWEEN ? AND ?
                AND event_type = 29
                AND value = 0
                ${whereClause}
            GROUP BY DATE(timestamp)
            ORDER BY date
        `, params);

        // Запрос для получения общего количества деталей
        const [totalRows] = await connection.execute(`
            SELECT COUNT(*) as total_parts
            FROM bit8_data
            WHERE 
                timestamp BETWEEN ? AND ?
                AND event_type = 29
                AND value = 0
                ${whereClause}
        `, params);

        // Формируем данные для всех дней в периоде
        const allDays = [];
        let currentDate = start.clone();
        while (currentDate <= end) {
            allDays.push(currentDate.format('YYYY-MM-DD'));
            currentDate.add(1, 'day');
        }

        // Создаем карту для быстрого доступа к данным по дням
        const dataMap = new Map();
        rows.forEach(row => {
            dataMap.set(row.date, row.parts_count);
        });

        // Заполняем данные для всех дней
        const dailyData = allDays.map(day => {
            return dataMap.get(day) || 0;
        });

        // Форматируем даты для отображения
        const formattedLabels = allDays.map(day => 
            moment(day).format('DD.MM')
        );

        return {
            labels: formattedLabels,
            datasets: [{
                label: 'Количество деталей',
                data: dailyData,
                backgroundColor: 'rgba(54, 162, 235, 0.7)',
                borderColor: 'rgba(54, 162, 235, 1)',
                borderWidth: 1,
                borderRadius: 3
            }],
            total: totalRows[0].total_parts || 0
        };
    } catch (error) {
        console.error('Ошибка получения данных о деталях по дням:', error);
        throw new Error('Не удалось получить данные о деталях по дням');
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

              // Сохраняем данные в минутах для внутренних вычислений
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

        // Переводим минуты в часы для отдачи клиенту
        const result = {
          workshop1: {
            working: workshop1.working / 60,
            stopped: workshop1.stopped / 60,
            shutdown: workshop1.shutdown / 60
          },
          workshop2: {
            working: workshop2.working / 60,
            stopped: workshop2.stopped / 60,
            shutdown: workshop2.shutdown / 60
          },
          total: {
            working: (workshop1.working + workshop2.working) / 60,
            stopped: (workshop1.stopped + workshop2.stopped) / 60,
            shutdown: (workshop1.shutdown + workshop2.shutdown) / 60
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
 * Получает агрегированные почасовые данные для всех станков или станков цеха
 */
app.get('/api/workshops/hourly', 
  [
    query('date').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('date').isISO8601().withMessage('Неверный формат даты'),
    query('workshop').optional().isIn(['all', '1', '2']).withMessage('Неверный идентификатор цеха')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { date, workshop = 'all' } = req.query;
      const cacheKey = `${workshop}_${date}`;
      
      if (cache.workshopHourlyData[cacheKey] && 
          Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.workshopHourly) {
        return res.json({
          success: true,
          fromCache: true,
          data: cache.workshopHourlyData[cacheKey]
        });
      }

      connection = await getConnection();
      
      try {
        const chartData = await generateWorkshopHourlyData(connection, workshop, date);
        
        cache.workshopHourlyData[cacheKey] = chartData;
        cache.lastUpdate[cacheKey] = Date.now();
        
        res.json({
          success: true,
          fromCache: false,
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
 * Получает данные о количестве деталей по часам
 */
app.get('/api/workshops/parts-hourly', 
  [
    query('startDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('endDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('workshop').optional().isIn(['all', '1', '2']).withMessage('Неверный идентификатор цеха'),
    query('startDate').isISO8601().withMessage('Неверный формат начальной даты'),
    query('endDate').isISO8601().withMessage('Неверный формат конечной даты')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { startDate, endDate, workshop = 'all' } = req.query;
      const cacheKey = `${workshop}_${startDate}_${endDate}`;
      
      if (cache.partsData[cacheKey] && 
          Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.partsData) {
        return res.json({
          success: true,
          fromCache: true,
          data: cache.partsData[cacheKey].chartData,
          total: cache.partsData[cacheKey].total
        });
      }

      connection = await getConnection();
      
      try {
        const partsData = await getPartsData(connection, startDate, endDate, workshop);
        
        cache.partsData[cacheKey] = {
          chartData: {
            labels: partsData.labels,
            datasets: partsData.datasets
          },
          total: partsData.total
        };
        cache.lastUpdate[cacheKey] = Date.now();
        
        res.json({
          success: true,
          fromCache: false,
          data: {
            labels: partsData.labels,
            datasets: partsData.datasets
          },
          total: partsData.total
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
 * Получает данные о количестве деталей по дням - ИСПРАВЛЕННЫЙ ЭНДПОИНТ
 */
app.get('/api/workshops/parts-daily', 
  [
    query('startDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('endDate').customSanitizer(value => moment(value).format('YYYY-MM-DD')),
    query('workshop').optional().isIn(['all', '1', '2']).withMessage('Неверный идентификатор цеха'),
    query('startDate').isISO8601().withMessage('Неверный формат начальной даты'),
    query('endDate').isISO8601().withMessage('Неверный формат конечной даты')
  ],
  validateErrors,
  async (req, res, next) => {
    let connection;
    try {
      const { startDate, endDate, workshop = 'all' } = req.query;
      const cacheKey = `daily_${workshop}_${startDate}_${endDate}`;
      
      if (cache.partsDailyData[cacheKey] && 
          Date.now() - cache.lastUpdate[cacheKey] < cache.ttl.partsDailyData) {
        return res.json({
          success: true,
          fromCache: true,
          data: cache.partsDailyData[cacheKey],
          total: cache.partsDailyData[cacheKey].total
        });
      }

      connection = await getConnection();
      
      try {
        const partsData = await getPartsDailyData(connection, startDate, endDate, workshop);
        
        cache.partsDailyData[cacheKey] = partsData;
        cache.lastUpdate[cacheKey] = Date.now();
        
        res.json({
          success: true,
          fromCache: false,
          data: partsData,
          total: partsData.total
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
    query('startDate').isISO8601().withMessage('Неверный формат начальной дата'),
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
        
        // Переводим минуты в часы для отдачи клиенту
        res.json({
          success: true,
          data: {
            working: stats.working / 60,
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