// server4.js - ПОЛНОСТЬЮ ПЕРЕПИСАННАЯ ВЕРСИЯ ДЛЯ НОВОЙ СТРУКТУРЫ БД
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

const pool = mysql.createPool(dbConfig);

async function getConnection() {
  return await pool.getConnection();
}

// Инициализация таблиц настроек
async function initializeSettingsTables() {
  let connection;
  try {
    connection = await getConnection();
    
    // Создаем таблицу цехов
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS workshop_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        workshop_id INT NOT NULL UNIQUE,
        workshop_name VARCHAR(255) NOT NULL,
        machines_count INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    
    // Создаем таблицу распределения станков
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS machine_workshop_assignment (
        machine_id INT PRIMARY KEY,
        workshop_id INT NOT NULL,
        assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workshop_id) REFERENCES workshop_settings(workshop_id) ON DELETE CASCADE
      )
    `);

    // Создаем цех по умолчанию если нет цехов
    const [workshopRows] = await connection.execute('SELECT COUNT(*) as count FROM workshop_settings');
    if (workshopRows[0].count === 0) {
      await connection.execute(
        'INSERT INTO workshop_settings (workshop_id, workshop_name) VALUES (1, "ЦЕХ-1")'
      );
      console.log('✅ Создан цех по умолчанию');
    }

    console.log('✅ Таблицы настроек инициализированы');
    
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц настроек:', error);
  } finally {
    if (connection) connection.release();
  }
}

// ГЛАВНЫЙ ЭНДПОИНТ: Получение настроек
app.get('/api/settings', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        console.log('🔄 ЗАПРОС НАСТРОЕК ОТ КЛИЕНТА');
        
        // Получаем все цехи
        const [workshopsRows] = await connection.execute(
            'SELECT workshop_id, workshop_name, machines_count FROM workshop_settings ORDER BY workshop_id'
        );
        
        // Получаем все станки из системы
        const [machinesRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        // Получаем актуальное распределение
        const [assignmentRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_assignment'
        );

        // Создаем карту распределения
        const assignmentMap = {};
        assignmentRows.forEach(row => {
            assignmentMap[row.machine_id] = row.workshop_id;
        });

        // Формируем настройки
        const settings = {
            workshops: workshopsRows.map(row => ({
                id: row.workshop_id,
                name: row.workshop_name,
                machinesCount: row.machines_count
            })),
            machines: machinesRows.map(row => ({
                id: row.machine_id,
                name: row.cnc_name,
                workshopId: assignmentMap[row.machine_id] || 1 // По умолчанию в цех 1
            }))
        };

        console.log('✅ ФИНАЛЬНЫЕ НАСТРОЙКИ:', {
            workshops: settings.workshops.length,
            machines: settings.machines.length,
            workshopsList: settings.workshops.map(w => `${w.name}(id:${w.id})`),
            distribution: settings.machines.map(m => `${m.name} -> ЦЕХ-${m.workshopId}`)
        });

        res.json({
            success: true,
            settings: settings
        });

    } catch (error) {
        console.error('❌ Ошибка загрузки настроек:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка загрузки настроек: ' + error.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// ЭНДПОИНТ СОХРАНЕНИЯ: Сохраняет настройки
app.post('/api/settings/save', async (req, res) => {
    let connection;
    try {
        const { settings } = req.body;
        
        if (!settings || !Array.isArray(settings.workshops) || !Array.isArray(settings.machines)) {
            return res.status(400).json({
                success: false,
                message: 'Неверный формат данных настроек'
            });
        }

        console.log('💾 СОХРАНЕНИЕ НАСТРОЕК:', {
            workshops: settings.workshops.length,
            machines: settings.machines.length,
            workshopsList: settings.workshops.map(w => `${w.name}(id:${w.id})`)
        });

        connection = await getConnection();
        await connection.beginTransaction();

        try {
            // 1. Сохраняем цехи
            for (const workshop of settings.workshops) {
                await connection.execute(
                    `INSERT INTO workshop_settings (workshop_id, workshop_name, machines_count) 
                     VALUES (?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                     workshop_name = VALUES(workshop_name), 
                     machines_count = VALUES(machines_count)`,
                    [workshop.id, workshop.name, workshop.machinesCount || 0]
                );
            }

            // 2. Сохраняем распределение станков
            console.log('🔄 Обновление распределения станков...');
            
            for (const machine of settings.machines) {
                await connection.execute(
                    `INSERT INTO machine_workshop_assignment (machine_id, workshop_id) 
                     VALUES (?, ?) 
                     ON DUPLICATE KEY UPDATE 
                     workshop_id = VALUES(workshop_id)`,
                    [machine.id, machine.workshopId]
                );
            }

            // 3. Удаляем цехи, которых нет в новых настройках
            const workshopIds = settings.workshops.map(w => w.id);
            if (workshopIds.length > 0) {
                await connection.execute(
                    'DELETE FROM workshop_settings WHERE workshop_id NOT IN (?)',
                    [workshopIds]
                );
            }

            // 4. Обновляем счетчики станков
            await updateWorkshopsMachinesCount(connection);

            await connection.commit();

            // 5. Сохраняем резервную копию
            await saveBackup(settings);

            console.log('✅ НАСТРОЙКИ СОХРАНЕНЫ');

            res.json({
                success: true,
                message: 'Все настройки успешно сохранены',
                settings: settings
            });

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Ошибка сохранения настроек:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка сохранения настроек: ' + error.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// ЭНДПОИНТ ДЛЯ ПОЛУЧЕНИЯ РАСПРЕДЕЛЕНИЯ
app.get('/api/settings/distribution', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [assignmentRows] = await connection.execute(
            'SELECT mwa.machine_id, mwa.workshop_id, cim.cnc_name ' +
            'FROM machine_workshop_assignment mwa ' +
            'JOIN cnc_id_mapping cim ON mwa.machine_id = cim.machine_id ' +
            'ORDER BY mwa.machine_id'
        );

        const [workshopsRows] = await connection.execute(
            'SELECT workshop_id, workshop_name FROM workshop_settings ORDER BY workshop_id'
        );

        const distribution = {};
        const machines = assignmentRows.map(row => {
            distribution[row.machine_id] = row.workshop_id;
            return {
                id: row.machine_id,
                name: row.cnc_name,
                workshop: row.workshop_id
            };
        });

        res.json({
            success: true,
            workshops: workshopsRows,
            machines: machines,
            distribution: distribution
        });

    } catch (error) {
        console.error('❌ Error getting distribution:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения распределения'
        });
    } finally {
        if (connection) connection.release();
    }
});

// ЭНДПОИНТ ИМПОРТА
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

        if (!Array.isArray(settings.workshops) || !Array.isArray(settings.machines)) {
            return res.status(400).json({
                success: false,
                message: 'Неверный формат данных настроек'
            });
        }

        connection = await getConnection();
        await connection.beginTransaction();

        try {
            // Получаем актуальный список станков из БД
            const [machinesRows] = await connection.execute(
                'SELECT machine_id FROM cnc_id_mapping'
            );
            const availableMachineIds = machinesRows.map(row => row.machine_id);

            // Фильтруем импортируемые станки
            const validMachines = settings.machines.filter(machine => 
                availableMachineIds.includes(machine.id)
            );

            // 1. Очищаем текущие настройки
            await connection.execute('DELETE FROM machine_workshop_assignment');
            await connection.execute('DELETE FROM workshop_settings');

            // 2. Сохраняем цехи
            for (const workshop of settings.workshops) {
                await connection.execute(
                    'INSERT INTO workshop_settings (workshop_id, workshop_name, machines_count) VALUES (?, ?, ?)',
                    [workshop.id, workshop.name, workshop.machinesCount || 0]
                );
            }

            // 3. Сохраняем распределение
            for (const machine of validMachines) {
                await connection.execute(
                    'INSERT INTO machine_workshop_assignment (machine_id, workshop_id) VALUES (?, ?)',
                    [machine.id, machine.workshopId]
                );
            }

            // 4. Обновляем счетчики
            await updateWorkshopsMachinesCount(connection);

            await connection.commit();

            const actualSettings = {
                workshops: settings.workshops,
                machines: validMachines
            };

            await saveBackup(actualSettings);

            console.log('✅ Настройки импортированы');

            res.json({
                success: true,
                message: `Настройки успешно импортированы. Загружено ${validMachines.length} станков.`,
                settings: actualSettings
            });

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error importing settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка импорта настроек'
        });
    } finally {
        if (connection) connection.release();
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
            .sort((a, b) => b.date - a.date)
            .slice(0, 10);

        res.json({
            success: true,
            backups: files
        });

    } catch (error) {
        console.error('❌ Error getting backups list:', error);
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
        
        await connection.beginTransaction();

        try {
            // 1. Очищаем текущие настройки
            await connection.execute('DELETE FROM machine_workshop_assignment');
            await connection.execute('DELETE FROM workshop_settings');

            // 2. Восстанавливаем цехи
            for (const workshop of backupData.settings.workshops) {
                await connection.execute(
                    'INSERT INTO workshop_settings (workshop_id, workshop_name, machines_count) VALUES (?, ?, ?)',
                    [workshop.id, workshop.name, workshop.machinesCount || 0]
                );
            }

            // 3. Восстанавливаем распределение
            for (const machine of backupData.settings.machines) {
                if (machine.id && machine.workshopId) {
                    await connection.execute(
                        'INSERT INTO machine_workshop_assignment (machine_id, workshop_id) VALUES (?, ?)',
                        [machine.id, machine.workshopId]
                    );
                }
            }

            // 4. Обновляем счетчики
            await updateWorkshopsMachinesCount(connection);

            await connection.commit();

            console.log('✅ Настройки восстановлены из резервной копии');

            res.json({
                success: true,
                message: 'Настройки успешно восстановлены из резервной копии',
                settings: backupData.settings
            });

        } catch (error) {
            await connection.rollback();
            throw error;
        }

    } catch (error) {
        console.error('❌ Error restoring from backup:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка восстановления из резервной копии'
        });
    } finally {
        if (connection) connection.release();
    }
});

// API для проверки здоровья сервера
app.get('/api/health', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        await connection.execute('SELECT 1');
        
        res.json({
            success: true,
            status: 'OK',
            timestamp: new Date().toISOString(),
            database: 'connected'
        });

    } catch (error) {
        console.error('❌ Health check failed:', error);
        res.status(500).json({
            success: false,
            status: 'ERROR',
            timestamp: new Date().toISOString(),
            database: 'disconnected',
            error: error.message
        });
    } finally {
        if (connection) connection.release();
    }
});

// ЭНДПОИНТ ДЛЯ БЫСТРОГО ПОЛУЧЕНИЯ РАСПРЕДЕЛЕНИЯ
app.get('/api/settings/quick-distribution', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [assignmentRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_assignment ORDER BY machine_id'
        );

        const distribution = {};
        assignmentRows.forEach(row => {
            distribution[row.machine_id] = row.workshop_id;
        });

        res.json({
            success: true,
            distribution: distribution,
            totalMachines: assignmentRows.length,
            lastUpdate: new Date().toISOString()
        });

    } catch (error) {
        console.error('❌ Error getting quick distribution:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения распределения'
        });
    } finally {
        if (connection) connection.release();
    }
});

// API для получения списка цехов
app.get('/api/settings/workshops', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [workshopsRows] = await connection.execute(
            'SELECT workshop_id, workshop_name, machines_count FROM workshop_settings ORDER BY workshop_id'
        );

        const workshops = workshopsRows.map(row => ({
            id: row.workshop_id,
            name: row.workshop_name,
            machinesCount: row.machines_count
        }));

        console.log('✅ Загружено цехов из БД:', workshops.length);

        res.json({
            success: true,
            workshops: workshops
        });

    } catch (error) {
        console.error('❌ Error getting workshops:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения списка цехов'
        });
    } finally {
        if (connection) connection.release();
    }
});

// API для принудительного обновления данных
app.post('/api/settings/refresh', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [mappingRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        const [assignmentRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_assignment'
        );

        const [workshopsRows] = await connection.execute(
            'SELECT workshop_id, workshop_name, machines_count FROM workshop_settings ORDER BY workshop_id'
        );

        const currentAssignment = {};
        assignmentRows.forEach(row => {
            currentAssignment[row.machine_id] = row.workshop_id;
        });

        // Формируем актуальные настройки
        const settings = {
            workshops: workshopsRows.map(row => ({
                id: row.workshop_id,
                name: row.workshop_name,
                machinesCount: row.machines_count
            })),
            machines: mappingRows.map(row => ({
                id: row.machine_id,
                name: row.cnc_name,
                workshopId: currentAssignment[row.machine_id] || 1
            }))
        };

        console.log('✅ Данные обновлены');

        res.json({
            success: true,
            settings: settings,
            message: 'Данные успешно обновлены'
        });

    } catch (error) {
        console.error('❌ Error refreshing data:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка обновления данных'
        });
    } finally {
        if (connection) connection.release();
    }
});

// API для получения статистики
app.get('/api/settings/stats', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [workshopsRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM workshop_settings'
        );

        const [assignmentRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM machine_workshop_assignment'
        );

        const [machinesRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM cnc_id_mapping'
        );

        // Получаем суммарное количество станков по цехам
        const [machinesCountRows] = await connection.execute(
            'SELECT SUM(machines_count) as total FROM workshop_settings'
        );

        res.json({
            success: true,
            stats: {
                workshops: workshopsRows[0].count,
                machines: assignmentRows[0].count,
                distribution: assignmentRows[0].count,
                totalMachinesInDB: machinesRows[0].count,
                totalMachinesAssigned: machinesCountRows[0].total || 0,
                lastUpdate: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('❌ Error getting stats:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения статистики'
        });
    } finally {
        if (connection) connection.release();
    }
});

// ЭНДПОИНТ ДЛЯ ДИАГНОСТИКИ
app.get('/api/settings/debug', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем все цехи
        const [workshopsRows] = await connection.execute(
            'SELECT workshop_id, workshop_name, machines_count, updated_at FROM workshop_settings ORDER BY workshop_id'
        );
        
        // Получаем распределение
        const [assignmentRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM machine_workshop_assignment'
        );

        // Получаем станки
        const [machinesRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM cnc_id_mapping'
        );

        res.json({
            success: true,
            debug: {
                workshops: workshopsRows,
                assignment_count: assignmentRows[0].count,
                machines_count: machinesRows[0].count,
                workshops_count: workshopsRows.length
            }
        });

    } catch (error) {
        console.error('❌ Error in debug endpoint:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка диагностики'
        });
    } finally {
        if (connection) connection.release();
    }
});

// ДЕТАЛЬНАЯ ДИАГНОСТИКА
app.get('/api/settings/debug-detailed', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем все цехи
        const [workshopsRows] = await connection.execute(
            'SELECT * FROM workshop_settings ORDER BY workshop_id'
        );
        
        // Получаем распределение
        const [assignmentRows] = await connection.execute(
            'SELECT mwa.*, cim.cnc_name FROM machine_workshop_assignment mwa JOIN cnc_id_mapping cim ON mwa.machine_id = cim.machine_id ORDER BY mwa.workshop_id, mwa.machine_id'
        );

        // Получаем станки
        const [machinesRows] = await connection.execute(
            'SELECT * FROM cnc_id_mapping ORDER BY machine_id'
        );

        res.json({
            success: true,
            workshops: workshopsRows,
            assignment: assignmentRows,
            machines: machinesRows,
            summary: {
                total_workshops: workshopsRows.length,
                total_assignment: assignmentRows.length,
                total_machines: machinesRows.length
            }
        });

    } catch (error) {
        console.error('❌ Error in detailed debug:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    } finally {
        if (connection) connection.release();
    }
});

// НОВЫЙ ЭНДПОИНТ: Проверка сохраненных данных
app.get('/api/settings/verify', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем цехи
        const [workshopsRows] = await connection.execute(
            'SELECT * FROM workshop_settings ORDER BY workshop_id'
        );

        // Получаем распределение
        const [assignmentRows] = await connection.execute(
            'SELECT * FROM machine_workshop_assignment ORDER BY machine_id'
        );

        // Получаем станки
        const [machinesRows] = await connection.execute(
            'SELECT * FROM cnc_id_mapping ORDER BY machine_id'
        );

        // Анализируем целостность данных
        const analysis = {
            total_workshops: workshopsRows.length,
            total_assignment: assignmentRows.length,
            total_machines: machinesRows.length,
            data_consistency: {
                missing_assignment: [],
                assignment_without_machine: []
            }
        };

        // Проверяем целостность
        const machineIdsInSystem = new Set(machinesRows.map(m => m.machine_id));
        const machineIdsInAssignment = new Set(assignmentRows.map(d => d.machine_id));

        // Станки без распределения
        machineIdsInSystem.forEach(id => {
            if (!machineIdsInAssignment.has(id)) {
                analysis.data_consistency.missing_assignment.push(id);
            }
        });

        // Распределение без станков
        machineIdsInAssignment.forEach(id => {
            if (!machineIdsInSystem.has(id)) {
                analysis.data_consistency.assignment_without_machine.push(id);
            }
        });

        res.json({
            success: true,
            analysis: analysis
        });

    } catch (error) {
        console.error('❌ Error in verification:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    } finally {
        if (connection) connection.release();
    }
});

// Функция для обновления счетчиков станков в цехах
async function updateWorkshopsMachinesCount(connection) {
    try {
        // Обновляем счетчики на основе актуального распределения
        await connection.execute(`
            UPDATE workshop_settings ws
            SET machines_count = (
                SELECT COUNT(*) 
                FROM machine_workshop_assignment mwa 
                WHERE mwa.workshop_id = ws.workshop_id
            )
        `);
        console.log('✅ Счетчики станков обновлены');
    } catch (error) {
        console.error('❌ Ошибка обновления счетчиков:', error);
    }
}

// Функция для сохранения резервной копии
async function saveBackup(settings) {
    try {
        const backupDir = path.join(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) {
            fs.mkdirSync(backupDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = path.join(backupDir, `settings-backup-${timestamp}.json`);
        
        const backupData = {
            timestamp: new Date().toISOString(),
            settings: settings
        };

        fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
        console.log('✅ Резервная копия сохранена');

    } catch (error) {
        console.error('❌ Ошибка сохранения резервной копии:', error);
    }
}

// Запуск сервера
async function startServer() {
    try {
        await initializeSettingsTables();
        
        app.listen(PORT, () => {
            console.log(`🚀 Сервер настроек запущен на порту ${PORT}`);
            console.log(`📊 Используется новая структура БД: workshop_settings + machine_workshop_assignment`);
        });
    } catch (error) {
        console.error('❌ Ошибка запуска сервера:', error);
        process.exit(1);
    }
}

startServer();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down settings server...');
    await pool.end();
    console.log('Database connections closed');
    process.exit(0);
});