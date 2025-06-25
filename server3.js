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
  user: 'monitor',
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
      SELECT 
        machine_id,
        value,
        timestamp
      FROM 
        bit8_data
      WHERE 
        event_type = 7
        AND (machine_id, timestamp) IN (
          SELECT 
            machine_id, 
            MAX(timestamp) as max_timestamp
          FROM 
            bit8_data
          WHERE 
            event_type = 7
          GROUP BY 
            machine_id
        )
    `);

    // Получаем последние статусы MUSP (event_type = 21 - MUSP)
    const [muspStates] = await connection.execute(`
      SELECT 
        machine_id,
        value,
        timestamp
      FROM 
        bit8_data
      WHERE 
        event_type = 21
        AND (machine_id, timestamp) IN (
          SELECT 
            machine_id, 
            MAX(timestamp) as max_timestamp
          FROM 
            bit8_data
          WHERE 
            event_type = 21
          GROUP BY 
            machine_id
        )
    `);

    // Создаем объект с данными станков
    const machinesData = {};
    machines.forEach(machine => {
      const systemState = systemStates.find(s => s.machine_id === machine.machine_id);
      const muspState = muspStates.find(s => s.machine_id === machine.machine_id);
      
      machinesData[machine.machine_id] = {
        internalId: machine.machine_id,
        displayName: machine.cnc_name,
        status: {
          SystemState: systemState ? parseInt(systemState.value) : null,
          MUSP: muspState ? parseInt(muspState.value) : null
        },
        lastUpdate: systemState ? systemState.timestamp : 
                   muspState ? muspState.timestamp : 
                   new Date().toISOString()
      };
    });

    return machinesData;
  } finally {
    await connection.end();
  }
}

// Функция для получения исторических данных по станкам
async function getMachineHistoryData(machineId, startDate, endDate) {
  const connection = await mysql.createConnection(dbConfig);
  
  try {
    const localStartDate = new Date(startDate);
    const localEndDate = new Date(endDate);

    // Получаем исторические данные статусов (event_type = 7 и 21)
    const [historyData] = await connection.execute(`
      SELECT 
        machine_id,
        event_type,
        value,
        timestamp
      FROM 
        bit8_data
      WHERE 
        machine_id = ?
        AND event_type IN (7, 21)
        AND timestamp BETWEEN ? AND ?
      ORDER BY 
        timestamp ASC
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

// Новый endpoint для получения сводных данных по цехам
app.get('/api/workshops/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Необходимо указать startDate и endDate' 
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Получаем данные по всем станкам за период
      const [historyData] = await connection.execute(`
        SELECT 
          machine_id,
          event_type,
          value,
          timestamp
        FROM 
          bit8_data
        WHERE 
          event_type IN (7, 21)
          AND timestamp BETWEEN ? AND ?
        ORDER BY 
          machine_id, timestamp ASC
      `, [
        new Date(startDate).toISOString().slice(0, 19).replace('T', ' '),
        new Date(endDate).toISOString().slice(0, 19).replace('T', ' ')
      ]);

      // Обрабатываем данные
      const workshop1Data = { off: 0, idle: 0, active: 0 };
      const workshop2Data = { off: 0, idle: 0, active: 0 };

      // Группируем данные по станкам
      const machineGroups = {};
      historyData.forEach(item => {
        if (!machineGroups[item.machine_id]) {
          machineGroups[item.machine_id] = [];
        }
        machineGroups[item.machine_id].push({
          timestamp: item.timestamp,
          eventType: item.event_type,
          value: parseInt(item.value)
        });
      });

      // Рассчитываем время для каждого станка
      Object.entries(machineGroups).forEach(([machineId, events]) => {
        let offTime = 0, idleTime = 0, activeTime = 0;
        let lastStatus = null;
        let lastTimestamp = new Date(startDate);

        // Сортируем события по времени
        events.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Определяем статус для каждого временного отрезка
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          const currentTimestamp = new Date(event.timestamp);
          const timeDiff = (currentTimestamp - lastTimestamp) / (1000 * 60 * 60); // в часах

          if (lastStatus !== null) {
            if (lastStatus === 'off') offTime += timeDiff;
            else if (lastStatus === 'idle') idleTime += timeDiff;
            else if (lastStatus === 'active') activeTime += timeDiff;
          }

          // Обновляем статус
          if (event.eventType === 21) { // MUSP
            lastStatus = event.value === 1 ? 'off' : 
                       (lastStatus === 'active' ? 'active' : 'idle');
          } else if (event.eventType === 7) { // SystemState
            if (lastStatus !== 'off') {
              lastStatus = event.value === 2 || event.value === 4 ? 'active' : 'idle';
            }
          }

          lastTimestamp = currentTimestamp;
        }

        // Добавляем оставшееся время до endDate
        const finalTimeDiff = (new Date(endDate) - lastTimestamp) / (1000 * 60 * 60);
        if (lastStatus === 'off') offTime += finalTimeDiff;
        else if (lastStatus === 'idle') idleTime += finalTimeDiff;
        else if (lastStatus === 'active') activeTime += finalTimeDiff;

        // Распределяем по цехам
        const workshopId = parseInt(machineId) <= 16 ? 'workshop1' : 'workshop2';
        if (workshopId === 'workshop1') {
          workshop1Data.off += offTime;
          workshop1Data.idle += idleTime;
          workshop1Data.active += activeTime;
        } else {
          workshop2Data.off += offTime;
          workshop2Data.idle += idleTime;
          workshop2Data.active += activeTime;
        }
      });

      res.json({
        success: true,
        data: {
          workshop1: workshop1Data,
          workshop2: workshop2Data,
          total: {
            off: workshop1Data.off + workshop2Data.off,
            idle: workshop1Data.idle + workshop2Data.idle,
            active: workshop1Data.active + workshop2Data.active
          }
        }
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching workshop summary:', error);
    res.status(500).json({ success: false, error: error.message });
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
        SELECT 
          event_type,
          value,
          timestamp
        FROM 
          bit8_data
        WHERE 
          machine_id = ?
          AND event_type IN (7, 21)
          AND timestamp BETWEEN ? AND ?
        ORDER BY 
          timestamp ASC
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

// Endpoint для получения списка станков
app.get('/api/machines', async (req, res) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      // Получаем список всех станков
      const [machines] = await connection.execute('SELECT machine_id, cnc_name FROM cnc_id_mapping');
      
      // Получаем последние статусы станков
      const [systemStates] = await connection.execute(`
        SELECT 
          machine_id,
          value,
          timestamp
        FROM 
          bit8_data
        WHERE 
          event_type = 7
          AND (machine_id, timestamp) IN (
            SELECT 
              machine_id, 
              MAX(timestamp) as max_timestamp
            FROM 
              bit8_data
            WHERE 
              event_type = 7
            GROUP BY 
              machine_id
          )
      `);

      // Получаем последние статусы MUSP
      const [muspStates] = await connection.execute(`
        SELECT 
          machine_id,
          value,
          timestamp
        FROM 
          bit8_data
        WHERE 
          event_type = 21
          AND (machine_id, timestamp) IN (
            SELECT 
              machine_id, 
              MAX(timestamp) as max_timestamp
            FROM 
              bit8_data
            WHERE 
              event_type = 21
            GROUP BY 
              machine_id
          )
      `);

      // Создаем объект с данными станков
      const machinesData = {};
      machines.forEach(machine => {
        const systemState = systemStates.find(s => s.machine_id === machine.machine_id);
        const muspState = muspStates.find(s => s.machine_id === machine.machine_id);
        
        machinesData[machine.machine_id] = {
          internalId: machine.machine_id,
          displayName: machine.cnc_name,
          status: {
            SystemState: systemState ? parseInt(systemState.value) : null,
            MUSP: muspState ? parseInt(muspState.value) : null
          },
          lastUpdate: systemState ? systemState.timestamp : 
                     muspState ? muspState.timestamp : 
                     new Date().toISOString()
        };
      });

      res.json({
        success: true,
        machines: machinesData
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching machines list:', error);
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