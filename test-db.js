const mysql = require('mysql2/promise');

async function testConnection() {
  try {
    const connection = await mysql.createConnection({
      host: '192.168.1.30',
      user: 'monitor',
      password: 'victoria123',
      database: 'cnc_monitoring'
    });
    
    console.log('Успешное подключение к MySQL');
    const [rows] = await connection.execute('SELECT 1 + 1 AS result');
    console.log('Результат запроса:', rows);
    await connection.end();
  } catch (err) {
    console.error('Ошибка подключения:', err);
  }
}

testConnection();