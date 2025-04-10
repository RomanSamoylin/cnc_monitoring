const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Настройка CORS
app.use(cors());

const WebSocket = require('ws');

// Создаем WebSocket сервер
const wss = new WebSocket.Server({ port: 8080 });

// Функция для оповещения клиентов об изменении данных
async function notifyClients() {
  const connection = await getDbConnection();
  const [rows] = await connection.execute('SELECT machine_id, MUSP FROM bit8_data');
  await connection.end();
  
  const machines = {};
  rows.forEach(row => {
    machines[row.machine_id] = {
      status: row.MUSP == 1 ? 'shutdown' : 'working',
      statusText: row.MUSP == 1 ? 'Выключен' : 'Работает'
    };
  });
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(machines));
    }
  });
}

// Периодическая проверка изменений (каждые 5 секунд)
setInterval(notifyClients, 5000);

// Обработка подключений WebSocket
wss.on('connection', ws => {
  console.log('Новый клиент подключен');
});

// Конфигурация подключения к MySQL
const dbConfig = {
  host: '192.168.1.79',
  user: 'root',
  password: 'victoria1234',
  database: 'cnc_monitoring'
};

// Функция для создания соединения с БД
async function getDbConnection() {
  return await mysql.createConnection(dbConfig);
}

// Маршрут для получения данных о станках
app.get('/api/machines', async (req, res) => {
  try {
    const connection = await getDbConnection();
    
    // Запрос данных из таблицы bit8_data
    const [rows] = await connection.execute(
      'SELECT machine_id, MUSP FROM bit8_data'
    );
    
    await connection.end();
    
    // Преобразование данных в нужный формат
    const machines = {};
    rows.forEach(row => {
      machines[row.machine_id] = {
        status: row.MUSP == 1 ? 'shutdown' : 'working',
        statusText: row.MUSP == 1 ? 'Выключен' : 'Работает'
      };
    });
    
    res.json({
      success: true,
      machines
    });
    
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      success: false,
      error: 'Ошибка при получении данных из БД'
    });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
  console.log(`Доступно по адресу: http://localhost:${PORT}/api/machines`);
});