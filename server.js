const express = require('express');
const mysql = require('mysql2/promise');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());

// MySQL конфигурация
const dbConfig = {
  host: '192.168.1.79',
  user: 'monitor',
  password: 'victoria123',
  database: 'cnc_monitoring'
};

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ port: 8080 });

// Функция для получения данных станков
async function getMachineData() {
  const connection = await mysql.createConnection(dbConfig);
  
  try {
    // Получаем список всех станков
    const [machines] = await connection.execute('SELECT machine_id, cnc_name FROM cnc_id_mapping');
    
    // Получаем последние значения параметров для каждого станка
    const [params] = await connection.execute(`
      SELECT 
        b1.machine_id,
        MAX(CASE WHEN b1.name = 'MUSP' THEN b1.event_type END) as MUSP,
        MAX(CASE WHEN b1.name = 'SystemState' THEN b1.event_type END) as SystemState,
        MAX(b1.timestamp) as last_update
      FROM 
        (SELECT machine_id, name, event_type, timestamp
         FROM bit8_data
         WHERE name IN ('MUSP', 'SystemState')
         ORDER BY timestamp DESC) b1
      GROUP BY b1.machine_id
    `);

    const machinesData = {};
    machines.forEach(machine => {
      // Находим статус для текущего станка
      const status = params.find(p => p.machine_id === machine.machine_id);
      
      let state = 'unknown';
      let stateText = 'Нет данных';
      
      if (status) {
        if (status.MUSP == 1) {
          state = 'shutdown';
          stateText = 'Выключен';
        } else if (status.SystemState == 2) {
          state = 'working';
          stateText = 'Работает';
        } else if (status.SystemState == 3) {
          state = 'stopped';
          stateText = 'Остановлен';
        }
      }

      machinesData[machine.machine_id] = {
        internalId: machine.machine_id,
        displayName: machine.cnc_name,
        status,
        statusText: stateText,
        lastUpdate: status?.last_update || new Date().toISOString()
      };
    });

    return machinesData;
  } finally {
    await connection.end();
  }
}

// HTTP API endpoint
app.get('/api/machines', async (req, res) => {
  try {
    const machines = await getMachineData();
    res.json({ success: true, machines });
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// WebSocket обработчик
wss.on('connection', (ws) => {
  console.log('Новый клиент подключен');
  
  // Отправляем данные при подключении
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
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ 
          type: 'UPDATE', 
          data: machines 
        }));
      }
    });
  } catch (error) {
    console.error('Update error:', error);
  }
}, 10000); // Обновление каждые 10 секунд

// Запуск HTTP сервера
app.listen(PORT, () => {
  console.log(`HTTP сервер запущен на порту ${PORT}`);
  console.log(`WebSocket сервер запущен на порту 8080`);
});