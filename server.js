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

// HTTP API endpoint для получения данных станков
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await getMachineData();
    res.json({ success: true, machines });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// HTTP API endpoint для получения исторических данных
app.get('/api/machines/:id/history', async (req, res) => {
  try {
    const { id } = req.params;
    let { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Необходимо указать startDate и endDate' 
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime())) {
      return res.status(400).json({ 
        success: false, 
        error: 'Некорректный формат startDate' 
      });
    }

    if (isNaN(end.getTime())) {
      return res.status(400).json({ 
        success: false, 
        error: 'Некорректный формат endDate' 
      });
    }

    if (req.query.period === 'day') {
      start.setHours(0, 0, 0, 0);
      end.setHours(23, 59, 59, 999);
    }

    const historyData = await getMachineHistoryData(id, start, end);
    
    res.json({ 
      success: true, 
      data: historyData,
      query: {
        machineId: id,
        startDate: start.toISOString(),
        endDate: end.toISOString()
      }
    });
  } catch (error) {
    console.error('Database error:', error);
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