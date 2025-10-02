// server4.js - ПОЛНОСТЬЮ ПЕРЕРАБОТАННАЯ ВЕРСИЯ С ПРАВИЛЬНЫМ ОБЪЕДИНЕНИЕМ ДАННЫХ
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
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        data JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS machine_workshop_distribution (
        machine_id INT PRIMARY KEY,
        workshop_id INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Создаем начальные настройки если их нет
    const [settingsRows] = await connection.execute('SELECT COUNT(*) as count FROM settings');
    if (settingsRows[0].count === 0) {
      const initialSettings = {
        workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
        machines: []
      };
      await connection.execute(
        'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
        [JSON.stringify(initialSettings)]
      );
      console.log('✅ Созданы начальные настройки');
    }

    console.log('✅ Таблицы настроек инициализированы');
    
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц настроек:', error);
  } finally {
    if (connection) connection.release();
  }
}

// ГЛАВНЫЙ ЭНДПОИНТ: Получение настроек с правильным объединением данных
app.get('/api/settings', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        console.log('🔄 ЗАПРОС НАСТРОЕК ОТ КЛИЕНТА');
        
        // Получаем ПОСЛЕДНИЕ настройки
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY id DESC LIMIT 1'
        );
        
        // Получаем все станки из системы
        const [machinesRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        // Получаем актуальное распределение
        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution'
        );

        // Создаем карту распределения
        const distributionMap = {};
        distributionRows.forEach(row => {
            distributionMap[row.machine_id] = row.workshop_id;
        });

        console.log('📊 ДАННЫЕ ДЛЯ ОБЪЕДИНЕНИЯ:', {
            settingsRecords: settingsRows.length,
            machinesInSystem: machinesRows.length,
            distributionRecords: distributionRows.length,
            distributionMap: distributionMap
        });

        // Базовые настройки
        let settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };

        // Загружаем сохраненные настройки если есть
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                
                console.log('💾 СОХРАНЕННЫЕ ДАННЫЕ:', {
                    workshops: savedSettings.workshops ? savedSettings.workshops.length : 0,
                    machines: savedSettings.machines ? savedSettings.machines.length : 0,
                    workshopsList: savedSettings.workshops ? savedSettings.workshops.map(w => `${w.name}(id:${w.id})`) : []
                });
                
                // ЗАГРУЖАЕМ ВСЕ ЦЕХИ ИЗ СОХРАНЕННЫХ НАСТРОЕК
                if (savedSettings.workshops && Array.isArray(savedSettings.workshops)) {
                    settings.workshops = savedSettings.workshops.map(workshop => ({
                        id: workshop.id,
                        name: workshop.name,
                        machinesCount: 0 // Сбросим счетчики, обновим позже
                    }));
                    console.log('✅ Загружено цехов из сохраненных настроек:', settings.workshops.length);
                }
                
                // ВАЖНОЕ ИСПРАВЛЕНИЕ: Объединяем данные станков
                // Сначала создаем массив всех станков из системы
                const allMachinesFromSystem = machinesRows.map(row => ({
                    id: row.machine_id,
                    name: row.cnc_name,
                    // Приоритет 1: Распределение из таблицы распределения
                    // Приоритет 2: Сохраненные данные
                    // Приоритет 3: Цех по умолчанию (1)
                    workshopId: distributionMap[row.machine_id] !== undefined ? 
                                distributionMap[row.machine_id] : 
                                (savedSettings.machines ? 
                                    (savedSettings.machines.find(m => m.id === row.machine_id)?.workshopId || 1) : 
                                    1)
                }));
                
                settings.machines = allMachinesFromSystem;
                console.log('✅ Объединены данные станков:', settings.machines.length);
                
            } catch (e) {
                console.error('❌ Ошибка парсинга сохраненных настроек:', e);
                // Используем данные по умолчанию
                settings.machines = machinesRows.map(row => ({
                    id: row.machine_id,
                    name: row.cnc_name,
                    workshopId: distributionMap[row.machine_id] || 1
                }));
            }
        } else {
            // Нет сохраненных настроек, используем системные данные
            console.log('⚠️ Нет сохраненных настроек, используем системные данные');
            settings.machines = machinesRows.map(row => ({
                id: row.machine_id,
                name: row.cnc_name,
                workshopId: distributionMap[row.machine_id] || 1
            }));
        }

        // Обновляем счетчики станков в цехах
        updateWorkshopsMachinesCount(settings);

        console.log('✅ ФИНАЛЬНЫЕ НАСТРОЙКИ:', {
            workshops: settings.workshops.length,
            machines: settings.machines.length,
            workshopsList: settings.workshops.map(w => `${w.name}(id:${w.id}, машин:${w.machinesCount})`),
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

// ЭНДПОИНТ СОХРАНЕНИЯ: Сохраняет настройки и обновляет распределение
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
            // Обновляем счетчики перед сохранением
            updateWorkshopsMachinesCount(settings);

            // 1. Сохраняем настройки в таблицу settings
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify(settings)]
            );

            // 2. Обновляем распределение станков (UPSERT)
            console.log('🔄 Обновление распределения станков...');
            
            for (const machine of settings.machines) {
                await connection.execute(
                    `INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) 
                     VALUES (?, ?, NOW()) 
                     ON DUPLICATE KEY UPDATE 
                     workshop_id = VALUES(workshop_id), 
                     updated_at = VALUES(updated_at)`,
                    [machine.id, machine.workshopId]
                );
            }

            await connection.commit();

            // Сохраняем резервную копию
            await saveBackup(settings);

            console.log('✅ НАСТРОЙКИ СОХРАНЕНЫ:', {
                workshops: settings.workshops.length,
                machines: settings.machines.length,
                distributionUpdated: settings.machines.length
            });

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

// ЭНДПОИНТ ДЛЯ БЫСТРОГО ПОЛУЧЕНИЯ РАСПРЕДЕЛЕНИЯ
app.get('/api/settings/distribution', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем распределение станков
        const [distributionRows] = await connection.execute(
            'SELECT mwd.machine_id, mwd.workshop_id, cim.cnc_name ' +
            'FROM machine_workshop_distribution mwd ' +
            'JOIN cnc_id_mapping cim ON mwd.machine_id = cim.machine_id ' +
            'ORDER BY mwd.machine_id'
        );

        // Получаем настройки цехов
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );

        let workshops = [{ id: 1, name: "ЦЕХ-1" }];
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) {
                    workshops = savedSettings.workshops;
                    console.log('✅ Загружено цехов для распределения:', workshops.length);
                }
            } catch (e) {
                console.error('❌ Error parsing saved settings:', e);
            }
        }

        // Формируем ответ
        const distribution = {};
        const machines = distributionRows.map(row => {
            distribution[row.machine_id] = row.workshop_id;
            return {
                id: row.machine_id,
                name: row.cnc_name,
                workshop: row.workshop_id
            };
        });

        res.json({
            success: true,
            workshops: workshops,
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

// ЭНДПОИНТ ИМПОРТА: Импорт настроек с валидацией
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

        // Валидация данных
        if (!Array.isArray(settings.workshops) || !Array.isArray(settings.machines)) {
            return res.status(400).json({
                success: false,
                message: 'Неверный формат данных настроек'
            });
        }

        connection = await getConnection();
        await connection.beginTransaction();

        try {
            // 1. Получаем актуальный список станков из БД
            const [machinesRows] = await connection.execute(
                'SELECT machine_id, cnc_name FROM cnc_id_mapping'
            );
            const availableMachineIds = machinesRows.map(row => row.machine_id);

            // 2. Фильтруем импортируемые станки - оставляем только те, что есть в БД
            const validMachines = settings.machines.filter(machine => 
                availableMachineIds.includes(machine.id)
            );

            // 3. Сохраняем ВСЕ настройки
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify({
                    workshops: settings.workshops,
                    machines: validMachines
                })]
            );

            // 4. Обновляем распределение станков (UPSERT)
            for (const machine of validMachines) {
                await connection.execute(
                    `INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) 
                     VALUES (?, ?, NOW()) 
                     ON DUPLICATE KEY UPDATE 
                     workshop_id = VALUES(workshop_id), 
                     updated_at = VALUES(updated_at)`,
                    [machine.id, machine.workshopId]
                );
            }

            await connection.commit();

            // 5. Формируем актуальные настройки для ответа
            const actualSettings = {
                workshops: settings.workshops,
                machines: validMachines
            };
            updateWorkshopsMachinesCount(actualSettings);

            await saveBackup(actualSettings);

            console.log('✅ Настройки импортированы:', {
                workshops: actualSettings.workshops.length,
                machines: actualSettings.machines.length
            });

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
            // Сохраняем настройки из резервной копии
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify(backupData.settings)]
            );

            // Обновляем распределение по цехам (UPSERT)
            for (const machine of backupData.settings.machines) {
                if (machine.id && machine.workshopId) {
                    await connection.execute(
                        `INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) 
                         VALUES (?, ?, NOW()) 
                         ON DUPLICATE KEY UPDATE 
                         workshop_id = VALUES(workshop_id), 
                         updated_at = VALUES(updated_at)`,
                        [machine.id, machine.workshopId]
                    );
                }
            }

            await connection.commit();

            console.log('✅ Настройки восстановлены из резервной копии:', {
                workshops: backupData.settings.workshops.length,
                machines: backupData.settings.machines.length
            });

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

// API для получения текущих настроек для экспорта
app.get('/api/settings/current', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );
        
        const [mappingRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        let settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };

        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) settings.workshops = savedSettings.workshops;
                if (savedSettings.machines) settings.machines = savedSettings.machines;
            } catch (e) {
                console.error('❌ Error parsing saved settings:', e);
            }
        }

        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution'
        );

        const currentDistribution = {};
        distributionRows.forEach(row => {
            currentDistribution[row.machine_id] = row.workshop_id;
        });

        // Объединяем данные с актуальным распределением
        const machinesFromDB = mappingRows.map(row => ({
            id: row.machine_id,
            name: row.cnc_name,
            workshopId: currentDistribution[row.machine_id] || 1
        }));

        settings.machines = machinesFromDB;
        updateWorkshopsMachinesCount(settings);

        const exportData = {
            exportDate: new Date().toISOString(),
            version: '2.0',
            settings: settings
        };

        res.json({
            success: true,
            data: exportData
        });

    } catch (error) {
        console.error('❌ Error getting current settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка получения текущих настроек'
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
        
        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution ORDER BY machine_id'
        );

        const distribution = {};
        distributionRows.forEach(row => {
            distribution[row.machine_id] = row.workshop_id;
        });

        res.json({
            success: true,
            distribution: distribution,
            totalMachines: distributionRows.length,
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
        
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );

        let workshops = [{ id: 1, name: "ЦЕХ-1" }];
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) {
                    workshops = savedSettings.workshops;
                    console.log('✅ Загружено цехов из БД:', workshops.length);
                }
            } catch (e) {
                console.error('❌ Error parsing saved settings:', e);
            }
        }

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

        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution'
        );

        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );

        let settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };

        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) settings.workshops = savedSettings.workshops;
                if (savedSettings.machines) settings.machines = savedSettings.machines;
            } catch (e) {
                console.error('❌ Error parsing saved settings:', e);
            }
        }

        const currentDistribution = {};
        distributionRows.forEach(row => {
            currentDistribution[row.machine_id] = row.workshop_id;
        });

        // Объединяем данные с актуальным распределением
        const machinesFromDB = mappingRows.map(row => ({
            id: row.machine_id,
            name: row.cnc_name,
            workshopId: currentDistribution[row.machine_id] || 1
        }));

        settings.machines = machinesFromDB;
        updateWorkshopsMachinesCount(settings);

        console.log('✅ Данные обновлены:', {
            workshops: settings.workshops.length,
            machines: settings.machines.length
        });

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
        
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY created_at DESC LIMIT 1'
        );

        let workshopsCount = 1;
        let machinesCount = 0;
        
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                if (savedSettings.workshops) workshopsCount = savedSettings.workshops.length;
                if (savedSettings.machines) machinesCount = savedSettings.machines.length;
            } catch (e) {
                console.error('❌ Error parsing saved settings:', e);
            }
        }

        const [distributionRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM machine_workshop_distribution'
        );

        const [machinesRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM cnc_id_mapping'
        );

        res.json({
            success: true,
            stats: {
                workshops: workshopsCount,
                machines: machinesCount,
                distribution: distributionRows[0].count,
                totalMachinesInDB: machinesRows[0].count,
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
        
        // Получаем все записи из settings
        const [settingsRows] = await connection.execute(
            'SELECT id, data, created_at FROM settings ORDER BY id DESC LIMIT 5'
        );
        
        // Анализируем структуру данных
        const settingsAnalysis = settingsRows.map(row => {
            try {
                const data = JSON.parse(row.data);
                return {
                    id: row.id,
                    created_at: row.created_at,
                    workshops_count: data.workshops ? data.workshops.length : 0,
                    machines_count: data.machines ? data.machines.length : 0,
                    has_workshops: !!data.workshops,
                    workshops_list: data.workshops ? data.workshops.map(w => ({id: w.id, name: w.name})) : []
                };
            } catch (e) {
                return {
                    id: row.id,
                    created_at: row.created_at,
                    error: 'Parse error'
                };
            }
        });

        // Получаем распределение
        const [distributionRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM machine_workshop_distribution'
        );

        // Получаем станки
        const [machinesRows] = await connection.execute(
            'SELECT COUNT(*) as count FROM cnc_id_mapping'
        );

        res.json({
            success: true,
            debug: {
                settings_records: settingsAnalysis,
                distribution_count: distributionRows[0].count,
                machines_count: machinesRows[0].count,
                latest_settings: settingsAnalysis[0]
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
        
        console.log('🔍 ДЕТАЛЬНАЯ ДИАГНОСТИКА НАСТРОЕК:');
        
        // 1. Получаем ВСЕ записи настроек
        const [allSettings] = await connection.execute(
            'SELECT id, data, created_at FROM settings ORDER BY id DESC LIMIT 10'
        );
        
        console.log('📋 Все записи в таблице settings:');
        allSettings.forEach((row, index) => {
            try {
                const data = JSON.parse(row.data);
                console.log(`Запись ${index + 1} (ID: ${row.id}, created: ${row.created_at}):`);
                console.log(`  - Цехов: ${data.workshops ? data.workshops.length : 'N/A'}`);
                console.log(`  - Станков: ${data.machines ? data.machines.length : 'N/A'}`);
                if (data.workshops) {
                    console.log(`  - Список цехов: ${data.workshops.map(w => `${w.name}(id:${w.id})`).join(', ')}`);
                }
            } catch (e) {
                console.log(`  - Ошибка парсинга: ${e.message}`);
            }
        });

        // 2. Получаем распределение
        const [distributionRows] = await connection.execute(
            'SELECT * FROM machine_workshop_distribution ORDER BY machine_id'
        );
        console.log('📊 Распределение станков:', distributionRows);

        // 3. Получаем станки
        const [machinesRows] = await connection.execute(
            'SELECT * FROM cnc_id_mapping ORDER BY machine_id'
        );
        console.log('🔧 Станки в системе:', machinesRows);

        res.json({
            success: true,
            all_settings: allSettings.map(row => {
                try {
                    return {
                        id: row.id,
                        created_at: row.created_at,
                        data: JSON.parse(row.data)
                    };
                } catch (e) {
                    return { id: row.id, error: e.message };
                }
            }),
            distribution: distributionRows,
            machines: machinesRows
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

// Функция для обновления счетчиков станков в цехах
function updateWorkshopsMachinesCount(settings) {
    // Сбрасываем счетчики
    settings.workshops.forEach(workshop => {
        workshop.machinesCount = 0;
    });

    // Считаем станки по цехам
    settings.machines.forEach(machine => {
        const workshop = settings.workshops.find(w => w.id === machine.workshopId);
        if (workshop) {
            workshop.machinesCount++;
        }
    });
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
        console.log('✅ Резервная копия сохранена:', backupFile);

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
            console.log('📊 Доступные эндпоинты:');
            console.log('   GET  /api/settings                 - Получить все настройки');
            console.log('   POST /api/settings/save            - Сохранить настройки');
            console.log('   GET  /api/settings/distribution    - Получить распределение');
            console.log('   POST /api/settings/import          - Импорт настроек');
            console.log('   GET  /api/settings/backups         - Список резервных копий');
            console.log('   POST /api/settings/restore         - Восстановить из резервной копии');
            console.log('   GET  /api/health                   - Проверка здоровья');
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