// settings-manager.js - ПОЛНОСТЬЮ ОБНОВЛЕННАЯ ВЕРСИЯ ДЛЯ НОВОЙ СТРУКТУРЫ БД
class SettingsManager {
    constructor() {
        this.settings = {
            workshops: [],
            machines: []
        };
        this.isLoaded = false;
        this.SERVER_URL = 'http://localhost:3004';
        this.retryCount = 0;
        this.maxRetries = 3;
        this.autoRefreshInterval = null;
    }

    // Основная функция загрузки настроек
    async loadSettings() {
        try {
            console.log('🔄 ЗАГРУЗКА НАСТРОЕК С СЕРВЕРА (НОВАЯ СТРУКТУРА)...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            if (!data.settings) {
                throw new Error('No settings data in response');
            }

            console.log('📥 ПОЛУЧЕНЫ ДАННЫЕ ОТ СЕРВЕРА:', {
                workshops: data.settings.workshops.length,
                machines: data.settings.machines.length,
                workshopsList: data.settings.workshops.map(w => `${w.name}(id:${w.id})`),
                machinesDistribution: data.settings.machines.map(m => `${m.name} -> ЦЕХ-${m.workshopId}`)
            });

            // ВАЖНО: Полностью заменяем настройки данными с сервера
            this.settings = {
                workshops: data.settings.workshops ? [...data.settings.workshops] : [],
                machines: data.settings.machines ? [...data.settings.machines] : []
            };

            this.isLoaded = true;
            this.retryCount = 0; // Сброс счетчика попыток при успехе
            
            console.log('✅ НАСТРОЙКИ ЗАГРУЖЕНЫ:', {
                workshops: this.settings.workshops.length,
                machines: this.settings.machines.length,
                workshopsList: this.settings.workshops.map(w => `${w.name}(id:${w.id}, count:${w.machinesCount})`)
            });
            
            this.dispatchSettingsLoaded();
            return true;
            
        } catch (error) {
            console.error('❌ ОШИБКА ЗАГРУЗКИ НАСТРОЕК С СЕРВЕРА:', error);
            this.retryCount++;
            
            // Если превышено количество попыток, используем данные по умолчанию
            if (this.retryCount >= this.maxRetries) {
                console.warn('⚠️ Используем данные по умолчанию после множества неудачных попыток');
                this.useDefaultSettings();
                return true;
            }
            
            return false;
        }
    }

    // Использование настроек по умолчанию
    useDefaultSettings() {
        this.settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }],
            machines: []
        };
        this.isLoaded = true;
        this.dispatchSettingsLoaded();
    }

    // Принудительное обновление данных с сервера
    async refreshSettings() {
        try {
            console.log('🔄 ПРИНУДИТЕЛЬНОЕ ОБНОВЛЕНИЕ НАСТРОЕК...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }

            console.log('🔄 ОБНОВЛЕННЫЕ ДАННЫЕ С СЕРВЕРА:', {
                workshops: data.settings.workshops.length,
                machines: data.settings.machines.length,
                workshopsList: data.settings.workshops.map(w => `${w.name}(id:${w.id})`)
            });
            
            // ВАЖНО: Полностью заменяем настройки
            this.settings = {
                workshops: data.settings.workshops ? [...data.settings.workshops] : [],
                machines: data.settings.machines ? [...data.settings.machines] : []
            };
            
            this.isLoaded = true;
            
            console.log('✅ НАСТРОЙКИ ОБНОВЛЕНЫ:', {
                workshops: this.settings.workshops.length,
                machines: this.settings.machines.length
            });
            
            this.dispatchSettingsUpdated();
            return true;
            
        } catch (error) {
            console.error('❌ ОШИБКА ПРИНУДИТЕЛЬНОГО ОБНОВЛЕНИЯ:', error);
            this.dispatchSettingsError(error);
            return false;
        }
    }

    // ЕДИНЫЙ МЕТОД СОХРАНЕНИЯ: Сохраняет ВСЕ настройки на сервер
    async saveSettings(settings) {
        try {
            console.log('💾 СОХРАНЕНИЕ ВСЕХ НАСТРОЕК НА СЕРВЕР:', {
                workshops: settings.workshops.length,
                machines: settings.machines.length,
                workshopsList: settings.workshops.map(w => `${w.name}(id:${w.id})`),
                machinesDistribution: settings.machines.map(m => `${m.name} -> ЦЕХ-${m.workshopId}`)
            });
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/save`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ settings })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            // Обновляем локальные настройки данными с сервера
            if (data.settings) {
                console.log('🔄 ОБНОВЛЕНИЕ ЛОКАЛЬНЫХ НАСТРОЕК ДАННЫМИ С СЕРВЕРА:', {
                    workshops: data.settings.workshops.length,
                    machines: data.settings.machines.length
                });
                
                this.settings.workshops = data.settings.workshops ? [...data.settings.workshops] : [];
                this.settings.machines = data.settings.machines ? [...data.settings.machines] : [];
            }
            
            console.log('💾 ВСЕ НАСТРОЙКИ СОХРАНЕНЫ НА СЕРВЕР');
            
            this.dispatchSettingsUpdated();
            return true;
            
        } catch (error) {
            console.error('❌ ОШИБКА СОХРАНЕНИЯ НАСТРОЕК НА СЕРВЕР:', error);
            this.dispatchSettingsError(error);
            throw error;
        }
    }

    // Получение цеха для станка
    getWorkshopForMachine(machineId) {
        const machine = this.settings.machines.find(m => m.id === machineId);
        return machine ? machine.workshopId : 1;
    }

    // Получение списка цехов
    getWorkshops() {
        console.log('📋 Запрос списка цехов:', this.settings.workshops.length);
        return this.settings.workshops;
    }

    // Получение цеха по ID
    getWorkshopById(workshopId) {
        const workshop = this.settings.workshops.find(w => w.id == workshopId);
        console.log('🔍 Поиск цеха по ID:', workshopId, 'результат:', workshop);
        return workshop;
    }

    // Получение названия цеха по ID
    getWorkshopNameById(workshopId) {
        const workshop = this.getWorkshopById(workshopId);
        const name = workshop ? workshop.name : `ЦЕХ-${workshopId}`;
        console.log('🏭 Название цеха по ID:', workshopId, '=', name);
        return name;
    }

    // Получение списка станков для цеха
    getMachinesForWorkshop(workshopId) {
        const machines = this.settings.machines.filter(machine => {
            const machineWorkshop = machine.workshopId || this.getWorkshopForMachine(machine.id);
            return machineWorkshop == workshopId;
        });
        console.log('🔧 Станки для цеха', workshopId, ':', machines.length);
        return machines;
    }

    // Получение всех станков
    getAllMachines() {
        console.log('📊 Запрос всех станков:', this.settings.machines.length);
        return this.settings.machines;
    }

    // Получение станка по ID
    getMachineById(machineId) {
        const machine = this.settings.machines.find(m => m.id == machineId);
        console.log('🔍 Поиск станка по ID:', machineId, 'результат:', machine);
        return machine;
    }

    // Получение названия станка по ID
    getMachineNameById(machineId) {
        const machine = this.getMachineById(machineId);
        const name = machine ? machine.name : `Станок-${machineId}`;
        console.log('⚙️ Название станка по ID:', machineId, '=', name);
        return name;
    }

    // Перемещение станка в другой цех
    async moveMachineToWorkshop(machineId, workshopId) {
        try {
            console.log(`➡️ ПЕРЕМЕЩЕНИЕ СТАНКА ${machineId} В ЦЕХ ${workshopId}`);
            
            // Обновляем локальные данные
            const machine = this.getMachineById(machineId);
            if (machine) {
                const oldWorkshopId = machine.workshopId;
                machine.workshopId = workshopId;
                
                console.log(`🔄 Станок "${machine.name}" перемещен из цеха ${oldWorkshopId} в цех ${workshopId}`);
            }

            // Сохраняем на сервер ВСЕ настройки
            const settingsToSave = {
                workshops: this.settings.workshops,
                machines: this.settings.machines
            };
            
            await this.saveSettings(settingsToSave);
            console.log(`✅ Станок ${machineId} перемещен в цех ${workshopId}`);
            
            return true;
        } catch (error) {
            console.error('❌ Ошибка перемещения станка:', error);
            return false;
        }
    }

    // Получение быстрого распределения
    async getQuickDistribution() {
        try {
            console.log('🚀 Запрос быстрого распределения...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/quick-distribution`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('✅ Получено быстрое распределение:', data.distribution);
            return data.distribution;
        } catch (error) {
            console.error('❌ Ошибка получения распределения:', error);
            return null;
        }
    }

    // Получение статистики
    async getStats() {
        try {
            console.log('📈 Запрос статистики...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/stats`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('✅ Получена статистика:', data.stats);
            return data.stats;
        } catch (error) {
            console.error('❌ Ошибка получения статистики:', error);
            return null;
        }
    }

    // Диагностика системы
    async debugSystem() {
        try {
            console.log('🔍 ЗАПУСК ДИАГНОСТИКИ СИСТЕМЫ...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/debug`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('📊 ДИАГНОСТИКА СИСТЕМЫ:', data.debug);
            return data.debug;
            
        } catch (error) {
            console.error('❌ ОШИБКА ДИАГНОСТИКИ СИСТЕМЫ:', error);
            throw error;
        }
    }

    // Детальная диагностика
    async detailedDebug() {
        try {
            console.log('🔍 ЗАПУСК ДЕТАЛЬНОЙ ДИАГНОСТИКИ...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/debug-detailed`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('📊 ДЕТАЛЬНАЯ ДИАГНОСТИКА:', data);
            
            // Сравниваем с текущим состоянием
            console.log('🔄 СРАВНЕНИЕ СОСТОЯНИЙ:', {
                server: data.workshops.map(w => `${w.workshop_name}(id:${w.workshop_id})`),
                client: this.settings.workshops.map(w => `${w.name}(id:${w.id})`)
            });
            
            return data;
            
        } catch (error) {
            console.error('❌ ОШИБКА ДЕТАЛЬНОЙ ДИАГНОСТИКИ:', error);
            throw error;
        }
    }

    // Проверка здоровья сервера
    async checkHealth() {
        try {
            console.log('❤️ Проверка здоровья сервера...');
            const response = await fetch(`${this.SERVER_URL}/api/health`);
            if (!response.ok) return false;
            
            const data = await response.json();
            const isHealthy = data.success && data.database === 'connected';
            console.log('✅ Статус здоровья сервера:', isHealthy);
            return isHealthy;
        } catch (error) {
            console.error('❌ Ошибка проверки здоровья:', error);
            return false;
        }
    }

    // Проверка целостности данных
    async verifyDataIntegrity() {
        try {
            console.log('🔍 Проверка целостности данных...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/verify`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('✅ Проверка целостности данных:', data.analysis);
            return data;
        } catch (error) {
            console.error('❌ Ошибка проверки целостности данных:', error);
            throw error;
        }
    }

    // Принудительная перезагрузка цехов
    async forceReloadWorkshops() {
        try {
            console.log('🔄 ПРИНУДИТЕЛЬНАЯ ПЕРЕЗАГРУЗКА ЦЕХОВ...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/workshops`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            if (data.workshops) {
                this.settings.workshops = [...data.workshops];
                
                console.log('✅ Цехи принудительно перезагружены:', data.workshops.length);
                this.dispatchSettingsUpdated();
            }
            
            return true;
        } catch (error) {
            console.error('❌ Ошибка принудительной перезагрузки цехов:', error);
            return false;
        }
    }

    // Получение списка резервных копий
    async getBackupsList() {
        try {
            console.log('📋 Запрос списка резервных копий...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/backups`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('✅ Получен список резервных копий:', data.backups.length);
            return data.backups;
        } catch (error) {
            console.error('❌ Ошибка получения списка резервных копий:', error);
            throw error;
        }
    }

    // Восстановление из резервной копии
    async restoreFromBackup(filename) {
        try {
            console.log(`🔄 ВОССТАНОВЛЕНИЕ ИЗ РЕЗЕРВНОЙ КОПИИ: ${filename}`);
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/restore`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ filename })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            // Обновляем локальные настройки
            if (data.settings) {
                this.settings = {
                    workshops: data.settings.workshops ? [...data.settings.workshops] : [],
                    machines: data.settings.machines ? [...data.settings.machines] : []
                };
                this.isLoaded = true;
                this.dispatchSettingsUpdated();
            }
            
            console.log('✅ Восстановление из резервной копии завершено');
            return true;
        } catch (error) {
            console.error('❌ Ошибка восстановления из резервной копии:', error);
            throw error;
        }
    }

    // Импорт настроек
    async importSettings(settingsData) {
        try {
            console.log('📥 ИМПОРТ НАСТРОЕК...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/import`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ settings: settingsData })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            // Обновляем локальные настройки
            if (data.settings) {
                this.settings = {
                    workshops: data.settings.workshops ? [...data.settings.workshops] : [],
                    machines: data.settings.machines ? [...data.settings.machines] : []
                };
                this.isLoaded = true;
                this.dispatchSettingsUpdated();
            }
            
            console.log('✅ Импорт настроек завершен');
            return data;
        } catch (error) {
            console.error('❌ Ошибка импорта настроек:', error);
            throw error;
        }
    }

    // Генерация событий
    dispatchSettingsLoaded() {
        console.log('📢 Диспатч события: settingsLoaded');
        window.dispatchEvent(new CustomEvent('settingsLoaded', {
            detail: this.settings
        }));
    }

    dispatchSettingsUpdated() {
        console.log('📢 Диспатч события: settingsUpdated');
        window.dispatchEvent(new CustomEvent('settingsUpdated', {
            detail: this.settings
        }));
    }

    dispatchSettingsError(error) {
        console.log('📢 Диспатч события: settingsError', error);
        window.dispatchEvent(new CustomEvent('settingsError', {
            detail: {
                message: error.message,
                timestamp: new Date().toISOString()
            }
        }));
    }

    // Проверка, загружены ли настройки
    isSettingsLoaded() {
        const loaded = this.isLoaded;
        console.log('❓ Проверка загрузки настроек:', loaded);
        return loaded;
    }

    // Автоматическое обновление настроек
    startAutoRefresh(interval = 30000) {
        // Останавливаем предыдущий интервал, если он был
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }
        
        console.log(`🔄 ЗАПУСК АВТОМАТИЧЕСКОГО ОБНОВЛЕНИЯ С ИНТЕРВАЛОМ ${interval}ms`);
        
        this.autoRefreshInterval = setInterval(async () => {
            try {
                const isHealthy = await this.checkHealth();
                if (isHealthy) {
                    console.log('🔄 Автоматическое обновление настроек...');
                    await this.refreshSettings();
                } else {
                    console.warn('⚠️ Сервер недоступен, пропускаем автоматическое обновление');
                }
            } catch (error) {
                console.error('❌ Ошибка автоматического обновления:', error);
            }
        }, interval);
        
        console.log(`🔄 АВТОМАТИЧЕСКОЕ ОБНОВЛЕНИЕ ЗАПУЩЕНО`);
    }

    // Остановка автоматического обновления
    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
            console.log('⏹️ АВТОМАТИЧЕСКОЕ ОБНОВЛЕНИЕ ОСТАНОВЛЕНО');
        }
    }

    // Получение текущего состояния
    getCurrentState() {
        return {
            workshops: [...this.settings.workshops],
            machines: [...this.settings.machines],
            isLoaded: this.isLoaded,
            lastUpdate: new Date().toISOString()
        };
    }

    // Создание резервной копии настроек
    createBackup() {
        const backupData = {
            timestamp: new Date().toISOString(),
            version: '2.0',
            databaseStructure: 'workshop_settings',
            settings: this.settings
        };
        
        const blob = new Blob([JSON.stringify(backupData, null, 2)], { 
            type: 'application/json' 
        });
        
        return blob;
    }

    // Деструктор
    destroy() {
        this.stopAutoRefresh();
        console.log('🧹 SettingsManager уничтожен');
    }
}

// Создаем глобальный экземпляр с улучшенной обработкой ошибок
window.SettingsManager = new Proxy(new SettingsManager(), {
    get(target, prop) {
        if (typeof target[prop] === 'function') {
            return function(...args) {
                try {
                    console.log(`🔧 Вызов метода SettingsManager.${prop}`, args);
                    const result = target[prop].apply(target, args);
                    
                    // Обработка Promise для лучшего логирования
                    if (result instanceof Promise) {
                        return result.catch(error => {
                            console.error(`❌ Асинхронная ошибка в SettingsManager.${prop}:`, error);
                            target.dispatchSettingsError(error);
                            throw error;
                        });
                    }
                    
                    return result;
                } catch (error) {
                    console.error(`❌ Синхронная ошибка в SettingsManager.${prop}:`, error);
                    target.dispatchSettingsError(error);
                    throw error;
                }
            };
        }
        return target[prop];
    }
});

// Автоматическая инициализация при загрузке
document.addEventListener('DOMContentLoaded', async () => {
    try {
        console.log('🚀 ИНИЦИАЛИЗАЦИЯ SETTINGSMANAGER (НОВАЯ СТРУКТУРА БД)...');
        console.log('📊 Используется структура: workshop_settings + machine_workshop_assignment');
        
        // Проверяем доступность сервера перед загрузкой
        const isHealthy = await window.SettingsManager.checkHealth();
        if (!isHealthy) {
            console.warn('⚠️ Сервер недоступен, пробуем загрузить настройки...');
        }
        
        await window.SettingsManager.loadSettings();
        
        // Запускаем автоматическое обновление для дашбордов и других страниц
        if (!window.location.pathname.includes('settings.html')) {
            window.SettingsManager.startAutoRefresh();
        }
        
        console.log('✅ SETTINGSMANAGER ИНИЦИАЛИЗИРОВАН');
        
    } catch (error) {
        console.error('❌ ОШИБКА ИНИЦИАЛИЗАЦИИ SETTINGSMANAGER:', error);
    }
});

// Обработка событий видимости страницы для оптимизации
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        window.SettingsManager.stopAutoRefresh();
        console.log('👁️ Страница скрыта, остановлено автообновление');
    } else {
        console.log('👁️ Страница видна, перезагружаем настройки...');
        // Перезагружаем настройки при возвращении на страницу
        window.SettingsManager.refreshSettings().then(() => {
            window.SettingsManager.startAutoRefresh();
        });
    }
});

// Глобальные функции для использования в settings.html
window.checkDatabaseState = async function() {
    try {
        const debugInfo = await window.SettingsManager.debugSystem();
        
        if (debugInfo) {
            const message = `Система: ${debugInfo.workshops_count} цехов, ${debugInfo.assignment_count} распределений, ${debugInfo.machines_count} станков`;
            
            // Показываем детальную информацию
            alert(`📊 ДИАГНОСТИКА СИСТЕМЫ:\n\n` +
                  `Цехов в системе: ${debugInfo.workshops_count}\n` +
                  `Распределений: ${debugInfo.assignment_count}\n` +
                  `Всего станков в системе: ${debugInfo.machines_count}\n\n` +
                  `Текущие цехи: ${debugInfo.workshops.map(w => `${w.workshop_name}(id:${w.workshop_id})`).join(', ')}`);
            
            return message;
        }
    } catch (error) {
        console.error('❌ Ошибка проверки состояния системы:', error);
        throw error;
    }
};

window.detailedDebug = async function() {
    try {
        const debugInfo = await window.SettingsManager.detailedDebug();
        
        if (debugInfo) {
            let message = `🔍 ДЕТАЛЬНАЯ ДИАГНОСТИКА:\n\n`;
            message += `Цехов: ${debugInfo.summary.total_workshops}\n`;
            message += `Распределений: ${debugInfo.summary.total_assignment}\n`;
            message += `Станков в системе: ${debugInfo.summary.total_machines}\n\n`;
            
            message += `Список цехов:\n`;
            debugInfo.workshops.forEach(workshop => {
                message += `- ${workshop.workshop_name} (ID: ${workshop.workshop_id}, станков: ${workshop.machines_count})\n`;
            });
            
            alert(message);
        }
    } catch (error) {
        console.error('❌ Ошибка детальной диагностики:', error);
        alert('Ошибка детальной диагностики: ' + error.message);
    }
};

window.getSettingsManager = function() {
    return window.SettingsManager;
};

window.verifyDataIntegrity = async function() {
    try {
        const result = await window.SettingsManager.verifyDataIntegrity();
        if (result) {
            const analysis = result.analysis;
            let message = `Проверка целостности данных:\n\n`;
            message += `Цехов: ${analysis.total_workshops}\n`;
            message += `Распределений: ${analysis.total_assignment}\n`;
            message += `Станков в системе: ${analysis.total_machines}\n\n`;
            
            if (analysis.data_consistency.missing_assignment.length > 0) {
                message += `⚠️ Станки без распределения: ${analysis.data_consistency.missing_assignment.join(', ')}\n`;
            }
            
            if (analysis.data_consistency.assignment_without_machine.length > 0) {
                message += `⚠️ Распределение без станков: ${analysis.data_consistency.assignment_without_machine.join(', ')}\n`;
            }
            
            if (analysis.data_consistency.missing_assignment.length === 0 && 
                analysis.data_consistency.assignment_without_machine.length === 0) {
                message += `✅ Целостность данных: ОТЛИЧНО\n`;
            }
            
            alert(message);
        }
    } catch (error) {
        console.error('❌ Ошибка проверки целостности данных:', error);
        alert('Ошибка проверки целостности данных: ' + error.message);
    }
};

window.forceReloadWorkshops = async function() {
    try {
        await window.SettingsManager.forceReloadWorkshops();
        alert('Цехи успешно перезагружены');
    } catch (error) {
        console.error('❌ Ошибка перезагрузки цехов:', error);
        alert('Ошибка перезагрузки цехов: ' + error.message);
    }
};

window.refreshData = async function() {
    try {
        await window.SettingsManager.refreshSettings();
        alert('Данные успешно обновлены');
    } catch (error) {
        console.error('❌ Ошибка обновления данных:', error);
        alert('Ошибка обновления данных: ' + error.message);
    }
};

window.getBackupsList = async function() {
    try {
        const backups = await window.SettingsManager.getBackupsList();
        return backups;
    } catch (error) {
        console.error('❌ Ошибка получения списка резервных копий:', error);
        throw error;
    }
};

window.restoreFromBackup = async function(filename) {
    try {
        await window.SettingsManager.restoreFromBackup(filename);
        alert('Настройки успешно восстановлены из резервной копии');
    } catch (error) {
        console.error('❌ Ошибка восстановления из резервной копии:', error);
        alert('Ошибка восстановления: ' + error.message);
    }
};