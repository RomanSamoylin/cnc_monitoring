const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
const PORT = 3002;

// Middleware
app.use(cors());
app.use(express.json());
app.use(cors({
  origin: 'http://localhost', // или ваш домен
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// MySQL конфигурация
const dbConfig = {
  host: '192.168.1.79',
  user: 'monitor',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00'
};

// Кэш данных
let machinesCache = {
  data: null,
  lastUpdate: null
};
const CACHE_TTL = 20000; // 20 секунд

// Функция для получения данных о станках
async function getMachinesData() {
  // Если данные в кэше еще актуальны, возвращаем их
  if (machinesCache.data && machinesCache.lastUpdate && 
      (Date.now() - machinesCache.lastUpdate) < CACHE_TTL) {
    return machinesCache.data;
  }

  const connection = await mysql.createConnection(dbConfig);
  
  try {
    // Получаем список всех станков
    const [machines] = await connection.execute(`
      SELECT 
        m.machine_id AS id,
        m.cnc_name AS name,
        m.machine_id AS internalId
      FROM 
        cnc_id_mapping m
    `);

    // Получаем последние статусы станков (event_type = 7 - SystemState)
    const [statusData] = await connection.execute(`
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

    // Получаем последние статусы MUSP (event_type = 21)
    const [muspData] = await connection.execute(`
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

    // Получаем последние данные о скорости шпинделя
    const [spindleData] = await connection.execute(`
      SELECT 
        machine_id,
        value,
        timestamp
      FROM 
        float_data
      WHERE 
        event_type = 6
        AND name = 'Скорость шпинделя'
        AND (machine_id, timestamp) IN (
          SELECT 
            machine_id, 
            MAX(timestamp) as max_timestamp
          FROM 
            float_data
          WHERE 
            event_type = 6
            AND name = 'Скорость шпинделя'
          GROUP BY 
            machine_id
        )
    `);

    // Получаем историю скорости шпинделя за последние 12 записей
    const [spindleHistory] = await connection.execute(`
      SELECT 
        fd.machine_id,
        fd.value,
        fd.timestamp
      FROM 
        float_data fd
      INNER JOIN (
        SELECT 
          machine_id, 
          MAX(timestamp) as max_timestamp
        FROM 
          float_data
        WHERE 
          event_type = 6
          AND name = 'Скорость шпинделя'
        GROUP BY 
          machine_id
      ) latest ON fd.machine_id = latest.machine_id AND fd.timestamp = latest.max_timestamp
      ORDER BY 
        fd.timestamp DESC
      LIMIT 12
    `);

    // Формируем данные для ответа
    const result = {};
    
    machines.forEach(machine => {
      const status = statusData.find(s => s.machine_id === machine.id);
      const musp = muspData.find(m => m.machine_id === machine.id);
      const spindle = spindleData.find(s => s.machine_id === machine.id);
      
      // Определяем статус станка
      let machineStatus = 'shutdown';
      let statusText = 'Выключен';
      
      if (musp && parseInt(musp.value) === 0) {
        if (status) {
          const systemState = parseInt(status.value);
          if (systemState === 2 || systemState === 4) {
            machineStatus = 'working';
            statusText = 'Работает';
          } else if (systemState === 1 || systemState === 3) {
            machineStatus = 'stopped';
            statusText = 'Остановлен';
          }
        }
      }
      
      // Получаем данные о скорости шпинделя
      const spindleSpeed = spindle ? parseFloat(spindle.value) : 0;
      
      result[machine.id] = {
        id: machine.id,
        internalId: machine.internalId,
        name: machine.name,
        status: machineStatus,
        statusText,
        spindleSpeed,
        lastUpdate: spindle ? spindle.timestamp : new Date().toISOString(),
        spindleHistory: spindleHistory
          .filter(item => item.machine_id === machine.id)
          .map(item => parseFloat(item.value))
      };
    });

    // Обновляем кэш
    machinesCache = {
      data: result,
      lastUpdate: Date.now()
    };

    return result;
  } finally {
    await connection.end();
  }
}

// API endpoint для получения данных о станках
app.get('/api/machines', async (req, res) => {
  try {
    const machinesData = await getMachinesData();
    res.json({
      success: true,
      machines: machinesData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error fetching machines data:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Запуск HTTP сервера
app.listen(PORT, () => {
  console.log(`Сервер мониторинга станков запущен на порту ${PORT}`);
  console.log(`Текущее время сервера: ${new Date()}`);
  console.log(`Доступные endpoint:`);
  console.log(`- GET /api/machines - получение данных о станках`);
});

module.exports = {
  app,
  getMachinesData
};