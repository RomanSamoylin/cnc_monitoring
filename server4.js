// server4.js - ИСПРАВЛЕННАЯ ВЕРСИЯ С ЕДИНЫМ МЕТОДОМ СОХРАНЕНИЯ
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

    // ПРОВЕРЯЕМ СТРУКТУРУ СОХРАНЕННЫХ НАСТРОЕК
    const [latestSettings] = await connection.execute(
      'SELECT data FROM settings ORDER BY id DESC LIMIT 1'
    );
    
    if (latestSettings.length > 0) {
      try {
        const savedData = JSON.parse(latestSettings[0].data);
        // Если в сохраненных данных нет workshops, обновляем структуру
        if (!savedData.workshops || !Array.isArray(savedData.workshops)) {
          console.log('🔄 Обновление структуры настроек...');
          const updatedSettings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: savedData.machines || []
          };
          await connection.execute(
            'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
            [JSON.stringify(updatedSettings)]
          );
          console.log('✅ Структура настроек обновлена');
        }
      } catch (e) {
        console.error('❌ Ошибка проверки структуры настроек:', e);
      }
    }
    
    console.log('✅ Таблицы настроек инициализированы');
    
  } catch (error) {
    console.error('❌ Ошибка инициализации таблиц настроек:', error);
  } finally {
    if (connection) connection.release();
  }
}

// ОСНОВНОЙ ЭНДПОИНТ: Получение настроек с объединением данных из всех таблиц
app.get('/api/settings', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем ПОСЛЕДНИЕ настройки (включая все цехи)
        const [settingsRows] = await connection.execute(
            'SELECT data FROM settings ORDER BY id DESC LIMIT 1'
        );
        
        // Получаем все станки из cnc_id_mapping
        const [machinesRows] = await connection.execute(
            'SELECT machine_id, cnc_name FROM cnc_id_mapping ORDER BY machine_id'
        );

        // Получаем текущее распределение станков по цехам
        const [distributionRows] = await connection.execute(
            'SELECT machine_id, workshop_id FROM machine_workshop_distribution'
        );

        // Базовые настройки по умолчанию
        let settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };

        // ЗАГРУЖАЕМ ВСЕ СОХРАНЕННЫЕ ЦЕХИ
        if (settingsRows.length > 0) {
            try {
                const savedSettings = JSON.parse(settingsRows[0].data);
                
                // ГАРАНТИРУЕМ, что workshops всегда массив
                if (savedSettings.workshops && Array.isArray(savedSettings.workshops)) {
                    settings.workshops = savedSettings.workshops;
                    console.log('✅ Загружено цехов из БД:', settings.workshops.length);
                } else {
                    console.log('⚠️ В сохраненных настройках нет массива workshops');
                }
                
            } catch (e) {
                console.error('❌ Error parsing saved settings:', e);
            }
        }

        // Создаем объект распределения для быстрого доступа
        const distributionMap = {};
        distributionRows.forEach(row => {
            distributionMap[row.machine_id] = row.workshop_id;
        });

        // СОЗДАЕМ АКТУАЛЬНЫЙ СПИСОК СТАНКОВ
        settings.machines = machinesRows.map(row => ({
            id: row.machine_id,
            name: row.cnc_name,
            workshopId: distributionMap[row.machine_id] || 1
        }));

        // ОБНОВЛЯЕМ СЧЕТЧИКИ СТАНКОВ ВО ВСЕХ ЦЕХАХ
        updateWorkshopsMachinesCount(settings);

        // ЛОГИРУЕМ ДЛЯ ОТЛАДКИ
        console.log('📤 Отправляем настройки клиенту:', {
            workshopsCount: settings.workshops.length,
            machinesCount: settings.machines.length,
            workshopsList: settings.workshops.map(w => ({id: w.id, name: w.name, count: w.machinesCount}))
        });

        res.json({
            success: true,
            settings: settings
        });

    } catch (error) {
        console.error('❌ Error fetching settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка загрузки настроек'
        });
    } finally {
        if (connection) connection.release();
    }
});

// ЕДИНЫЙ ЭНДПОИНТ СОХРАНЕНИЯ: Сохраняет ВСЕ настройки (цехи и распределение станков)
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
            // 1. Сохраняем ВСЕ настройки в таблицу settings
            const settingsToSave = {
                workshops: settings.workshops,
                machines: settings.machines
            };
            
            console.log('💾 Сохранение ВСЕХ настроек в БД:', {
                workshops: settings.workshops.length,
                machines: settings.machines.length,
                workshopsList: settings.workshops.map(w => w.name)
            });
            
            await connection.execute(
                'INSERT INTO settings (data, created_at) VALUES (?, NOW())',
                [JSON.stringify(settingsToSave)]
            );

            // 2. ОБНОВЛЯЕМ РАСПРЕДЕЛЕНИЕ СТАНКОВ ПО ЦЕХАМ
            // Сначала очищаем старое распределение
            await connection.execute('DELETE FROM machine_workshop_distribution');
            
            // Затем добавляем новое распределение
            for (const machine of settings.machines) {
                await connection.execute(
                    'INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) VALUES (?, ?, NOW())',
                    [machine.id, machine.workshopId]
                );
            }

            await connection.commit();

            // Сохраняем резервную копию
            await saveBackup(settings);

            console.log('✅ Все настройки сохранены:', {
                workshops: settings.workshops.length,
                machines: settings.machines.length
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
        console.error('❌ Error saving settings:', error);
        res.status(500).json({
            success: false,
            message: 'Ошибка сохранения настроек'
        });
    } finally {
        if (connection) connection.release();
    }
});

// УДАЛЕН ЭНДПОИНТ save-workshops - больше не нужен!

// ЭНДПОИНТ ДЛЯ БЫСТРОГО ПОЛУЧЕНИЯ РАСПРЕДЕЛЕНИЯ (для других серверов)
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

            // 4. Обновляем распределение станков
            await connection.execute('DELETE FROM machine_workshop_distribution');
            
            for (const machine of validMachines) {
                await connection.execute(
                    'INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) VALUES (?, ?, NOW())',
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

            // Обновляем распределение по цехам
            await connection.execute('DELETE FROM machine_workshop_distribution');
            
            for (const machine of backupData.settings.machines) {
                if (machine.id && machine.workshopId) {
                    await connection.execute(
                        'INSERT INTO machine_workshop_distribution (machine_id, workshop_id, updated_at) VALUES (?, ?, NOW())',
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

// НОВЫЙ ЭНДПОИНТ: Проверка сохраненных данных
app.get('/api/settings/verify', async (req, res) => {
    let connection;
    try {
        connection = await getConnection();
        
        // Получаем все записи настроек
        const [allSettings] = await connection.execute(
            'SELECT id, data, created_at FROM settings ORDER BY id DESC LIMIT 10'
        );
        
        const analysis = allSettings.map(row => {
            try {
                const data = JSON.parse(row.data);
                return {
                    id: row.id,
                    created_at: row.created_at,
                    workshops_count: data.workshops ? data.workshops.length : 0,
                    workshops: data.workshops ? data.workshops.map(w => w.name) : [],
                    has_workshops: !!data.workshops,
                    machines_count: data.machines ? data.machines.length : 0
                };
            } catch (e) {
                return { id: row.id, error: 'Parse error' };
            }
        });

        res.json({
            success: true,
            analysis: analysis,
            latest: analysis[0],
            total_records: analysis.length
        });

    } catch (error) {
        console.error('❌ Error in verify endpoint:', error);
        res.status(500).json({ 
            success: false, 
            message: error.message 
        });
    } finally {
        if (connection) connection.release();
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
        
        const backupData = {
            exportDate: new Date().toISOString(),
            version: '2.0',
            settings: settings
        };
        
        fs.writeFileSync(backupFile, JSON.stringify(backupData, null, 2));
        console.log(`✅ Backup saved: ${backupFile}`);

        cleanupOldBackups(backupDir);
    } catch (error) {
        console.error('❌ Error saving backup:', error);
    }
}

function cleanupOldBackups(backupDir) {
    try {
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
                console.log(`🗑️ Old backup deleted: ${files[i].name}`);
            }
        }
    } catch (error) {
        console.error('❌ Error cleaning up old backups:', error);
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
    console.error('❌ Unhandled error:', error);
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
async function startServer() {
    try {
        await initializeSettingsTables();
        
        app.listen(PORT, () => {
            console.log(`=== Settings Server Started ===`);
            console.log(`✅ Server running on port: ${PORT}`);
            console.log(`✅ Database: ${dbConfig.database}@${dbConfig.host}`);
            console.log(`================================`);
            
            console.log('\nAvailable endpoints:');
            console.log('GET  /api/settings                 - Получить все настройки');
            console.log('GET  /api/settings/distribution    - Получить распределение станков');
            console.log('GET  /api/settings/quick-distribution - Быстрое получение распределения');
            console.log('GET  /api/settings/workshops       - Получить список цехов');
            console.log('GET  /api/settings/stats           - Получить статистику');
            console.log('GET  /api/settings/debug           - Диагностика');
            console.log('GET  /api/settings/verify          - Проверка сохраненных данных');
            console.log('POST /api/settings/save            - Сохранить ВСЕ настройки');
            console.log('POST /api/settings/import          - Импортировать настройки');
            console.log('POST /api/settings/refresh         - Принудительно обновить данные');
            console.log('GET  /api/settings/backups         - Получить список резервных копий');
            console.log('POST /api/settings/restore         - Восстановить из резервной копии');
            console.log('GET  /api/health                   - Проверка здоровья сервера');
            console.log('================================\n');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
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

process.on('SIGTERM', async () => {
    console.log('Shutting down settings server...');
    await pool.end();
    console.log('Database connections closed');
    process.exit(0);
});

// Обработка необработанных исключений
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    process.exit(1);
});

module.exports = { app, pool };