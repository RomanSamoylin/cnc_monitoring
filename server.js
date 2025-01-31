const express = require('express');
const mysql = require('mysql2');
const app = express();
const port = 3000;

const connection = mysql.createConnection({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'victoria123',
    database: 'cnc_monitoring'
});

connection.connect((err) => {
    if (err) {
        console.error('Ошибка подключения к базе данных:', err);
        return;
    }
    console.log('Подключение к базе данных успешно установлено');
});

app.get('/data', (req, res) => {
    const query = 'SELECT * FROM cnc_monitoring';
    connection.query(query, (error, results) => {
        if (error) {
            console.error('Ошибка выполнения запроса:', error);
            res.status(500).send('Ошибка сервера');
            return;
        }
        res.json(results);
    });
});

app.listen(3000, () => {
    console.log(`Сервер запущен на http://localhost:3000`);
});
