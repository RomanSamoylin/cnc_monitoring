// server4.js
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3004;

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

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

// Создаем пул соединений
const pool = mysql.createPool(dbConfig);

// Функция для получения соединения из пула
async function getConnection() {
  return await pool.getConnection();
}

// API для получения настроек
app.get('/api/settings', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем настройки из таблицы settings
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );
        
        // Получаем маппинг станков из cnc_id_mapping
        const [mappingRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        let settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };

        // Если есть сохраненные настройки
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) settings.workshops = savedSettings.workshops;
                if (savedSettings.machines) settings.machines = savedSettings.machines;
            } catch (e) {
                console.error('Error parsing saved settings:', e);
            }
        }

        // Получаем текущее распределение станков по цехам
        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution'
        );

        const currentDistribution = {};
        distributionRows.forEach(row => {
            currentDistribution[row.machine_id] = row.workshop_id;
        });

        // Создаем массив станков из cnc_id_mapping
        const machinesFromDB = mappingRows.map(row => ({
            id: row.machine_id,
            name: row.cnc_name,
            workshopId: currentDistribution[row.machine_id] || 1 // Используем сохраненное распределение или цех по умолчанию
        }));

        // Обновляем данные станков
        settings.machines = machinesFromDB;

        // Обновляем счетчики станков в цехах
        updateWorkshopsMachinesCount(settings);

        res.json({
            success: true,
            settings: settings
        });

    } catch (error) {
        console.error('Error fetching settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка загрузки настроек'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// API для сохранения настроек
app.post('/api/settings/save', async (req, res) => {
    let connection;
    try {
        const { settings } = req.body;
        
        if (!settings) {
            return res.status(400).json({
                success: false,
                message: 'Отсутствуют данные настроек'
            });
        }

        connection = await getConnection();
        
        // Начинаем транзакцию
        await connection.beginTransaction();

        try {
            // Сохраняем в таблицу settings
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify(settings)]
            );

            // Обновляем распределение по цехам в machine_workshop_distribution
            await connection.execute('DELETE FROM machine_workshop_distribution');
            
            for (const machine of settings.machines) {
                await connection.execute(
                    'INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) VALUES (?, ?, NOW())',
                    [machine.id, machine.workshopId]
                );
            }

            // Фиксируем транзакцию
            await connection.commit();

            // Также сохраняем в файл для резервной копии
            await saveBackup(settings);

            res.json({
                success: true,
                message: 'Настройки успешно сохранены'
            });

        } catch (error) {
            // Откатываем транзакцию в случае ошибки
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error saving settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка сохранения настроек'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// API для импорта настроек
app.post('/api/settings/import', async (req, res) => {
    let connection;
    try {
        const { settings } = req.body;
        
        if (!settings) {
            return res.status(400).json({
                success: false,
                message: 'Отсутствуют данные для импорта'
            });
        }

        // Валидация импортируемых данных
        if (!Array.isArray(settings.workshops) || !Array.isArray(settings.machines)) {
            return res.status(400).json({
                success: false,
                message: 'Неверный формат данных настроек'
            });
        }

        connection = await getConnection();
        
        // Начинаем транзакцию
        await connection.beginTransaction();

        try {
            // Сохраняем импортированные настройки
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify(settings)]
            );

            // Обновляем распределение по цехам
            await connection.execute('DELETE FROM machine_workshop_distribution');
            
            for (const machine of settings.machines) {
                if (machine.id && machine.workshopId) {
                    await connection.execute(
                        'INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) VALUES (?, ?, NOW())',
                        [machine.id, machine.workshopId]
                    );
                }
            }

            // Фиксируем транзакцию
            await connection.commit();

            // Сохраняем резервную копию
            await saveBackup(settings);

            // Возвращаем импортированные настройки для обновления интерфейса
            res.json({
                success: true,
                message: 'Настройки успешно импортированы',
                settings: settings // Добавляем настройки в ответ
            });

        } catch (error) {
            // Откатываем транзакцию в случае ошибки
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error importing settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка импорта настроек'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// API для получения списка резервных копий
app.get('/api/settings/backups', async (req, res) => {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            return res.json({
                success: true,
                backups: []
            });
        }

        const files = fs.readdirSync(backupDir)
            .filter(file => file.endsWith('.json'))
            .map(file => {
                const filePath = path.join(backupDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    date: stats.mtime,
                    size: stats.size
                };
            })
            .sort((a, b) => b.date - a.date) // Сортировка по дате (новые сверху)
            .slice(0, 10); // Последние 10 файлов

        res.json({
            success: true,
            backups: files
        });

    } catch (error) {
        console.error('Error getting backups list:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения списка резервных копий'
        });
    }
});

// API для восстановления из резервной копии
app.post('/api/settings/restore', async (req, res) => {
    let connection;
    try {
        const { filename } = req.body;
        
        if (!filename) {
            return res.status(400).json({
                success: false,
                message: 'Не указано имя файла для восстановления'
            });
        }

        const backupFile = path.join(__dirname, 'backups', filename);
        if (!fs.existsSync(backupFile)) {
            return res.status(404).json({
                success: false,
                message: 'Файл резервной копии не найден'
            });
        }

        const backupData = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

        connection = await getConnection();
        
        // Начинаем транзакцию
        await connection.beginTransaction();

        try {
            // Сохраняем настройки из резервной копии
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify(backupData)]
            );

            // Обновляем распределение по цехам
            await connection.execute('DELETE FROM machine_workshop_distribution');
            
            for (const machine of backupData.machines) {
                if (machine.id && machine.workshopId) {
                    await connection.execute(
                        'INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) VALUES (?, ?, NOW())',
                        [machine.id, machine.workshopId]
                    );
                }
            }

            // Фиксируем транзакцию
            await connection.commit();

            // Возвращаем восстановленные настройки для обновления интерфейса
            res.json({
                success: true,
                message: 'Настройки успешно восстановлены из резервной копии',
                settings: backupData // Добавляем настройки в ответ
            });

        } catch (error) {
            // Откатываем транзакцию в случае ошибки
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('Error restoring from backup:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка восстановления из резервной копии'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// API для проверки здоровья сервера
app.get('/api/health', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Простой запрос для проверки соединения с БД
        await connection.execute('SELECT 1');
        
        res.json({
            success: true,
            status: 'OK',
            timestamp: new Date().toISOString(),
            database: 'connected'
        });

    } catch (error) {
        console.error('Health check failed:', error);
        res.status(500).json({
            success: false,
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            database: 'disconnected',
            error: error.message
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// API для получения текущих настроек для экспорта (опционально)
app.get('/api/settings/current', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем настройки из таблицы settings
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );
        
        // Получаем маппинг станков из cnc_id_mapping
        const [mappingRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        let settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };

        // Если есть сохраненные настройки
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) settings.workshops = savedSettings.workshops;
                if (savedSettings.machines) settings.machines = savedSettings.machines;
            } catch (e) {
                console.error('Error parsing saved settings:', e);
            }
        }

        // Получаем текущее распределение станков по цехам
        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution'
        );

        const currentDistribution = {};
        distributionRows.forEach(row => {
            currentDistribution[row.machine_id] = row.workshop_id;
        });

        // Создаем массив станков из cnc_id_mapping
        const machinesFromDB = mappingRows.map(row => ({
            id: row.machine_id,
            name: row.cnc_name,
            workshopId: currentDistribution[row.machine_id] || 1
        }));

        // Обновляем данные станков
        settings.machines = machinesFromDB;

        // Обновляем счетчики станков в цехах
        updateWorkshopsMachinesCount(settings);

        const exportData = {
            exportDate: new Date().toISOString(),
            version: '1.0',
            settings: settings
        };

        res.json({
            success: true,
            data: exportData
        });

    } catch (error) {
        console.error('Error getting current settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения текущих настроек'
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Функция для сохранения резервной копии
async function saveBackup(settings) {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupDir, `settings_backup_${timestamp}.json`);
        fs.writeFileSync(backupFile, JSON.stringify(settings, null, 2));

        console.log(`Backup saved: ${backupFile}`);

        // Удаляем старые резервные копии (оставляем только последние 20)
        const files = fs.readdirSync(backupDir)
            .filter(file => file.endsWith('.json'))
            .map(file => ({
                name: file,
                path: path.join(backupDir, file),
                time: fs.statSync(path.join(backupDir, file)).mtime.getTime()
            }))
            .sort((a, b) => b.time - a.time);

        if (files.length > 20) {
            for (let i = 20; i < files.length; i++) {
                fs.unlinkSync(files[i].path);
                console.log(`Old backup deleted: ${files[i].name}`);
            }
        }
    } catch (error) {
        console.error('Error saving backup:', error);
    }
}

// Функция для обновления счетчиков станков в цехах
function updateWorkshopsMachinesCount(settings) {
    settings.workshops.forEach(workshop => {
        workshop.machinesCount = settings.machines.filter(m => m.workshopId === workshop.id).length;
    });
}

// Middleware для обработки ошибок
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({
        success: false,
        message: 'Внутренняя ошибка сервера'
    });
});

// Обработка несуществующих маршрутов
app.use('*', (req, res) => {
    res.status(404).json({
        success: false,
        message: 'Маршрут не найден'
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`=== Settings Server Started ===`);
    console.log(`Server running on port: ${PORT}`);
    console.log(`Database host: ${dbConfig.host}`);
    console.log(`Database: ${dbConfig.database}`);
    console.log(`Timezone: ${dbConfig.timezone}`);
    console.log(`================================`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down settings server...');
    await pool.end();
    console.log('Database connections closed');
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down settings server...');
    await pool.end();
    console.log('Database connections closed');
    process.exit(0);
});

// Обработка необработанных исключений
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});