const express = require('express');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MySQL конфигурация
const dbConfig = {
  host: '192.168.1.79',
  user: 'monitorl',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00'
};

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ port: 8080 });

// Функция для получения данных станков
async function getMachineData() {
  const connection = await mysql.createConnection(dbConfig);
  
  try {
    // Получаем список всех станков
    const [machines] = await connection.execute('SELECT machine_id, cnc_name FROM cnc_id_mapping');
    
    // Получаем последние статусы станков (event_type = 7 - Состояние системы)
    const [systemStates] = await connection.execute(`
      SELECT machine_id, value, timestamp
      FROM bit8_data
      WHERE event_type = 7
      AND (machine_id, timestamp) IN (
        SELECT machine_id, MAX(timestamp)
        FROM bit8_data
        WHERE event_type = 7
        GROUP BY machine_id
      )
    `);

    // Получаем последние статусы MUSP (event_type = 21 - MUSP)
    const [muspStates] = await connection.execute(`
      SELECT machine_id, value, timestamp
      FROM bit8_data
      WHERE event_type = 21
      AND (machine_id, timestamp) IN (
        SELECT machine_id, MAX(timestamp)
        FROM bit8_data
        WHERE event_type = 21
        GROUP BY machine_id
      )
    `);

    // Получаем параметры станков из float_data с новыми event_type
    const [floatParams] = await connection.execute(`
      SELECT machine_id, event_type, value, timestamp
      FROM float_data
      WHERE (machine_id, event_type, timestamp) IN (
        SELECT machine_id, event_type, MAX(timestamp)
        FROM float_data
        WHERE event_type IN (
          5,  -- Подача
          6,  -- Скорость шпинделя
          10, -- Переключатель JOG
          11, -- Переключатель F
          12, -- Переключатель S
          40  -- Мощность шпинделя
        )
        GROUP BY machine_id, event_type
      )
      ORDER BY machine_id, event_type
    `);

    // Создаем объект с данными станков
    const machinesData = {};
    
    machines.forEach(machine => {
      const systemState = systemStates.find(s => s.machine_id === machine.machine_id);
      const muspState = muspStates.find(s => s.machine_id === machine.machine_id);
      
      // Инициализируем параметры
      const params = {
        feedRate: null,       // 5
        spindleSpeed: null,   // 6
        jogSwitch: null,     // 10
        fSwitch: null,       // 11
        sSwitch: null,       // 12
        spindlePower: null    // 40
      };

      // Заполняем параметры из float_data
      floatParams
        .filter(p => p.machine_id === machine.machine_id)
        .forEach(param => {
          const value = parseFloat(param.value);
          switch(param.event_type) {
            case 5: params.feedRate = isNaN(value) ? null : value; break;
            case 6: params.spindleSpeed = isNaN(value) ? null : value; break;
            case 10: params.jogSwitch = isNaN(value) ? null : value; break;
            case 11: params.fSwitch = isNaN(value) ? null : value; break;
            case 12: params.sSwitch = isNaN(value) ? null : value; break;
            case 40: params.spindlePower = isNaN(value) ? null : value; break;
          }
        });

      // Определяем статус станка
      const status = determineMachineStatus({
        SystemState: systemState ? parseInt(systemState.value) : null,
        MUSP: muspState ? parseInt(muspState.value) : null
      });

      // Рассчитываем текущую производительность (на основе мощности шпинделя)
      const currentPerformance = params.spindlePower !== null ? 
        Math.min(100, Math.max(0, Math.round(params.spindlePower))) : 0;

      machinesData[machine.machine_id] = {
        internalId: machine.machine_id,
        displayName: machine.cnc_name,
        status: status.status,
        statusText: status.statusText,
        currentPerformance: currentPerformance,
        lastUpdate: systemState ? systemState.timestamp : 
                   muspState ? muspState.timestamp : 
                   new Date().toISOString(),
        params: params
      };
    });

    return machinesData;
  } finally {
    await connection.end();
  }
}

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

// Функция для получения исторических данных по станкам
async function getMachineHistoryData(machineId, startDate, endDate) {
  const connection = await mysql.createConnection(dbConfig);
  
  try {
    const localStartDate = new Date(startDate);
    const localEndDate = new Date(endDate);

    // Получаем исторические данные статусов (event_type = 7 и 21)
    const [historyData] = await connection.execute(`
      SELECT event_type, value, timestamp
      FROM bit8_data
      WHERE machine_id = ?
      AND event_type IN (7, 21)
      AND timestamp BETWEEN ? AND ?
      ORDER BY timestamp ASC
    `, [
      machineId,
      localStartDate.toISOString().slice(0, 19).replace('T', ' '),
      localEndDate.toISOString().slice(0, 19).replace('T', ' ')
    ]);

    // Удаляем дубликаты
    const uniqueData = [];
    const seen = new Set();
    
    historyData.forEach(item => {
      const key = `${item.timestamp}_${item.event_type}_${item.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueData.push({
          ...item,
          value: parseInt(item.value),
          eventType: parseInt(item.event_type)
        });
      }
    });

    return uniqueData;
  } catch (error) {
    console.error('Ошибка при запросе исторических данных:', error);
    throw error;
  } finally {
    await connection.end();
  }
}

// Endpoint для получения списка станков
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await getMachineData();
    res.json({
      success: true,
      machines: machines
    });
  } catch (error) {
    console.error('Error fetching machines list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Новый endpoint для получения сводных данных по цехам
app.get('/api/machines', async (req, res) => {
  const connection = await mysql.createConnection(dbConfig);
  
  try {
    // 1. Получаем базовую информацию о станках
    const [machines] = await connection.execute(
      'SELECT machine_id, cnc_name FROM cnc_id_mapping'
    );

    // 2. Получаем статусы станков (SystemState и MUSP)
    const [statusData] = await connection.execute(`
      SELECT 
        b.machine_id,
        MAX(CASE WHEN b.event_type = 7 THEN b.value END) as SystemState,
        MAX(CASE WHEN b.event_type = 21 THEN b.value END) as MUSP,
        MAX(b.timestamp) as lastUpdate
      FROM bit8_data b
      WHERE b.event_type IN (7, 21)
      GROUP BY b.machine_id
    `);

    // 3. Получаем параметры станков из float_data
    const [paramsData] = await connection.execute(`
      SELECT 
        f.machine_id,
        MAX(CASE WHEN f.event_type = 5 THEN f.value END) as feedRate,
        MAX(CASE WHEN f.event_type = 6 THEN f.value END) as spindleSpeed,
        MAX(CASE WHEN f.event_type = 10 THEN f.value END) as jogSwitch,
        MAX(CASE WHEN f.event_type = 11 THEN f.value END) as fSwitch,
        MAX(CASE WHEN f.event_type = 12 THEN f.value END) as sSwitch,
        MAX(CASE WHEN f.event_type = 40 THEN f.value END) as spindlePower,
        MAX(f.timestamp) as paramsUpdate
      FROM float_data f
      WHERE f.event_type IN (5, 6, 10, 11, 12, 40)
      GROUP BY f.machine_id
    `);

    // 4. Формируем итоговый ответ
    const machinesData = {};
    
    machines.forEach(machine => {
      const machineId = machine.machine_id;
      const status = statusData.find(s => s.machine_id === machineId) || {};
      const params = paramsData.find(p => p.machine_id === machineId) || {};

      machinesData[machineId] = {
        internalId: machineId,
        displayName: machine.cnc_name,
        status: {
          SystemState: status.SystemState ? parseInt(status.SystemState) : null,
          MUSP: status.MUSP ? parseInt(status.MUSP) : null
        },
        currentPerformance: params.spindlePower ? Math.round(params.spindlePower) : 0,
        lastUpdate: status.lastUpdate || new Date().toISOString(),
        params: {
          feedRate: params.feedRate ? parseFloat(params.feedRate) : null,
          spindleSpeed: params.spindleSpeed ? parseFloat(params.spindleSpeed) : null,
          jogSwitch: params.jogSwitch ? parseFloat(params.jogSwitch) : null,
          fSwitch: params.fSwitch ? parseFloat(params.fSwitch) : null,
          sSwitch: params.sSwitch ? parseFloat(params.sSwitch) : null,
          spindlePower: params.spindlePower ? parseFloat(params.spindlePower) : null
        }
      };
    });

    // 5. Добавляем лог для отладки
    console.log('Отправляемые данные:', {
      machinesCount: Object.keys(machinesData).length,
      sampleMachine: machinesData[1] // Пример данных первого станка
    });

    res.json({
      success: true,
      machines: machinesData
    });

  } catch (error) {
    console.error('Ошибка при запросе данных станков:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: 'Проверьте соединение с БД и наличие данных в таблицах'
    });
  } finally {
    await connection.end();
  }
});


// Новый endpoint для получения детальных данных по станку
app.get('/api/machines/:id/history/detailed', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Необходимо указать startDate и endDate' 
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Получаем исторические данные для станка
      const [historyData] = await connection.execute(`
        SELECT event_type, value, timestamp
        FROM bit8_data
        WHERE machine_id = ?
        AND event_type IN (7, 21)
        AND timestamp BETWEEN ? AND ?
        ORDER BY timestamp ASC
      `, [
        id,
        new Date(startDate).toISOString().slice(0, 19).replace('T', ' '),
        new Date(endDate).toISOString().slice(0, 19).replace('T', ' ')
      ]);

      // Обрабатываем данные для временной шкалы
      const timelineData = [];
      let currentStatus = 'off'; // Статус по умолчанию

      // Сортируем события по времени
      historyData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Обрабатываем каждое событие
      for (const event of historyData) {
        const timestamp = new Date(event.timestamp);
        
        // Определяем новый статус
        if (event.event_type === 21) { // MUSP
          if (event.value === 1) {
            currentStatus = 'off';
          } else if (currentStatus !== 'off') {
            // MUSP=0 (включено), но статус может быть либо active, либо idle
            // Оставляем текущий статус, если он не off
          }
        } else if (event.event_type === 7) { // SystemState
          if (currentStatus !== 'off') {
            if (event.value === 2 || event.value === 4) {
              currentStatus = 'active';
            } else if (event.value === 1 || event.value === 3) {
              currentStatus = 'idle';
            } else if (event.value === 0) {
              currentStatus = 'off';
            }
          }
        }

        // Добавляем точку данных
        timelineData.push({
          timestamp: timestamp.toISOString(),
          status: currentStatus,
          eventType: event.event_type,
          value: event.value
        });
      }

      res.json({
        success: true,
        data: timelineData
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching machine detailed history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// WebSocket обработчик
wss.on('connection', (ws) => {
  console.log('Новый клиент подключен');
  
  getMachineData().then(machines => {
    ws.send(JSON.stringify({ 
      type: 'INITIAL_DATA', 
      data: machines 
    }));
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

// Периодическое обновление данных
setInterval(async () => {
  try {
    const machines = await getMachineData();
    console.log('Параметры из БД:', floatParams);
    console.log('Отправка обновления данных:', {
      time: new Date().toISOString(),
      machinesCount: Object.keys(machines).length
    });
    
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ 
          type: 'UPDATE', 
          data: machines,
          timestamp: new Date().toISOString()
        }));
      }
    });
  } catch (error) {
    console.error('Update error:', error);
  }
}, 20000);

// Запуск HTTP сервера
app.listen(PORT, () => {
  console.log(`HTTP сервер запущен на порту ${PORT}`);
  console.log(`WebSocket сервер запущен на порту 8080`);
  console.log(`Текущее время сервера: ${new Date()}`);
});

module.exports = {
  app,
  getMachineData,
  getMachineHistoryData
};