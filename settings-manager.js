// settings-manager.js - ПОЛНОСТЬЮ ИСПРАВЛЕННАЯ ВЕРСИЯ С ПРАВИЛЬНОЙ ЗАГРУЗКОЙ ВСЕХ ДАННЫХ
class SettingsManager {
    constructor() {
        this.settings = {
            workshops: [],
            machines: [],
            distribution: {}
        };
        this.isLoaded = false;
        this.autoRefreshInterval = null;
        this.SERVER_URL = 'http://localhost:3004';
        this.retryCount = 0;
        this.maxRetries = 3;
    }

    // Основная функция загрузки настроек
    async loadSettings() {
        try {
            console.log('🔄 ЗАГРУЗКА НАСТРОЕК С СЕРВЕРА...');
            
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
                machines: data.settings.machines ? [...data.settings.machines] : [],
                distribution: {}
            };

            this.isLoaded = true;
            this.updateDistributionFromMachines();
            this.saveToLocalStorage();
            
            console.log('✅ НАСТРОЙКИ ЗАГРУЖЕНЫ:', {
                workshops: this.settings.workshops.length,
                machines: this.settings.machines.length,
                workshopsList: this.settings.workshops.map(w => `${w.name}(id:${w.id}, count:${w.machinesCount})`)
            });
            
            this.dispatchSettingsLoaded();
            this.retryCount = 0; // Сброс счетчика попыток при успехе
            return true;
            
        } catch (error) {
            console.error('❌ ОШИБКА ЗАГРУЗКИ НАСТРОЕК С СЕРВЕРА:', error);
            this.retryCount++;
            
            // Пробуем загрузить из localStorage
            if (this.loadFromLocalStorage()) {
                console.log('📦 Настройки загружены из localStorage');
                return true;
            }
            
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
            machines: [],
            distribution: {}
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
                machines: data.settings.machines ? [...data.settings.machines] : [],
                distribution: {}
            };
            
            this.isLoaded = true;
            this.updateDistributionFromMachines();
            this.saveToLocalStorage();
            
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
                this.updateDistributionFromMachines();
            }
            
            this.saveToLocalStorage();
            console.log('💾 ВСЕ НАСТРОЙКИ СОХРАНЕНЫ НА СЕРВЕР');
            
            this.dispatchSettingsUpdated();
            return true;
            
        } catch (error) {
            console.error('❌ ОШИБКА СОХРАНЕНИЯ НАСТРОЕК НА СЕРВЕР:', error);
            this.dispatchSettingsError(error);
            throw error;
        }
    }

    // Сохранение в localStorage
    saveToLocalStorage() {
        try {
            const dataToSave = {
                settings: this.settings,
                timestamp: new Date().toISOString(),
                version: '2.1'
            };
            localStorage.setItem('cnc_settings_v2', JSON.stringify(dataToSave));
            console.log('📦 Настройки сохранены в localStorage:', {
                workshops: this.settings.workshops.length,
                machines: this.settings.machines.length
            });
        } catch (e) {
            console.error('❌ Ошибка сохранения в localStorage:', e);
        }
    }

    // Загрузка из localStorage
    loadFromLocalStorage() {
        try {
            const saved = localStorage.getItem('cnc_settings_v2');
            if (saved) {
                const parsed = JSON.parse(saved);
                
                // Проверяем версию и актуальность данных
                const savedTime = new Date(parsed.timestamp);
                const currentTime = new Date();
                const hoursDiff = (currentTime - savedTime) / (1000 * 60 * 60);
                
                if (hoursDiff < 24) { // Используем данные если им меньше 24 часов
                    console.log('📦 ЗАГРУЗКА ИЗ LOCALSTORAGE:', {
                        workshops: parsed.settings.workshops.length,
                        machines: parsed.settings.machines.length,
                        workshopsList: parsed.settings.workshops.map(w => `${w.name}(id:${w.id})`)
                    });
                    
                    this.settings = {
                        workshops: parsed.settings.workshops ? [...parsed.settings.workshops] : [],
                        machines: parsed.settings.machines ? [...parsed.settings.machines] : [],
                        distribution: {}
                    };
                    this.isLoaded = true;
                    this.updateDistributionFromMachines();
                    
                    console.log('📦 НАСТРОЙКИ ЗАГРУЖЕНЫ ИЗ LOCALSTORAGE:', {
                        workshops: this.settings.workshops.length,
                        machines: this.settings.machines.length
                    });
                    
                    this.dispatchSettingsLoaded();
                    return true;
                } else {
                    console.log('🕒 Данные в localStorage устарели');
                    localStorage.removeItem('cnc_settings_v2');
                }
            }
        } catch (e) {
            console.error('❌ Ошибка загрузки из localStorage:', e);
            localStorage.removeItem('cnc_settings_v2');
        }
        return false;
    }

    // Обновление распределения из данных машин
    updateDistributionFromMachines() {
        this.settings.distribution = {};
        this.settings.machines.forEach(machine => {
            this.settings.distribution[machine.id] = machine.workshopId;
        });
        console.log('🗺️ Обновлена карта распределения:', this.settings.distribution);
    }

    // Получение цеха для станка
    getWorkshopForMachine(machineId) {
        return this.settings.distribution[machineId] || 1;
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
                this.settings.distribution[machineId] = workshopId;
                
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

    // Диагностика БД
    async debugDatabase() {
        try {
            console.log('🔍 ЗАПУСК ДИАГНОСТИКИ БД...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/debug`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('📊 ДИАГНОСТИКА БД:', data.debug);
            return data.debug;
            
        } catch (error) {
            console.error('❌ ОШИБКА ДИАГНОСТИКИ БД:', error);
            throw error;
        }
    }

    // Глубокая диагностика
    async deepDebug() {
        try {
            console.log('🔍 ЗАПУСК ГЛУБОКОЙ ДИАГНОСТИКИ...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/debug-detailed`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('📊 ГЛУБОКАЯ ДИАГНОСТИКА:', data);
            
            // Сравниваем с текущим состоянием
            const latestSettings = data.all_settings[0];
            console.log('🔄 СРАВНЕНИЕ СОСТОЯНИЙ:', {
                server: latestSettings.data.workshops ? latestSettings.data.workshops.map(w => `${w.name}(id:${w.id})`) : [],
                client: this.settings.workshops.map(w => `${w.name}(id:${w.id})`)
            });
            
            return data;
            
        } catch (error) {
            console.error('❌ ОШИБКА ГЛУБОКОЙ ДИАГНОСТИКИ:', error);
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

    // Проверка сохраненных данных
    async verifySavedData() {
        try {
            console.log('🔍 Проверка сохраненных данных...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/verify`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('✅ Проверка сохраненных данных:', data.analysis);
            return data;
        } catch (error) {
            console.error('❌ Ошибка проверки сохраненных данных:', error);
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

    // Получение временной метки последнего обновления
    getLastUpdateTime() {
        try {
            const saved = localStorage.getItem('cnc_settings_v2');
            if (saved) {
                const parsed = JSON.parse(saved);
                const time = new Date(parsed.timestamp);
                console.log('🕒 Время последнего обновления:', time);
                return time;
            }
        } catch (e) {
            console.error('❌ Ошибка получения времени обновления:', e);
        }
        return null;
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

    // Очистка localStorage
    clearLocalStorage() {
        try {
            localStorage.removeItem('cnc_settings_v2');
            console.log('🧹 Локальное хранилище очищено');
        } catch (e) {
            console.error('❌ Ошибка очистки localStorage:', e);
        }
    }

    // Получение текущего состояния
    getCurrentState() {
        return {
            workshops: [...this.settings.workshops],
            machines: [...this.settings.machines],
            distribution: {...this.settings.distribution},
            isLoaded: this.isLoaded,
            lastUpdate: this.getLastUpdateTime()
        };
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
                this.updateDistributionFromMachines();
                this.saveToLocalStorage();
                
                console.log('✅ Цехи принудительно перезагружены:', data.workshops.length);
                this.dispatchSettingsUpdated();
            }
            
            return true;
        } catch (error) {
            console.error('❌ Ошибка принудительной перезагрузки цехов:', error);
            return false;
        }
    }

    // Деструктор
    destroy() {
        this.stopAutoRefresh();
        this.clearLocalStorage();
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
        console.log('🚀 ИНИЦИАЛИЗАЦИЯ SETTINGSMANAGER...');
        
        // Проверяем доступность сервера перед загрузкой
        const isHealthy = await window.SettingsManager.checkHealth();
        if (!isHealthy) {
            console.warn('⚠️ Сервер недоступен, пробуем загрузить из localStorage');
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
        const debugInfo = await window.SettingsManager.debugDatabase();
        
        if (debugInfo) {
            const latest = debugInfo.latest_settings;
            const message = `БД: ${latest.workshops_count} цехов, ${latest.machines_count} станков`;
            
            // Показываем детальную информацию
            alert(`📊 ДИАГНОСТИКА БД:\n\n` +
                  `Цехов в БД: ${latest.workshops_count}\n` +
                  `Станков в БД: ${latest.machines_count}\n` +
                  `Распределение: ${debugInfo.distribution_count} записей\n` +
                  `Всего станков в системе: ${debugInfo.machines_count}\n\n` +
                  `Последние цехи: ${latest.workshops_list.map(w => w.name).join(', ')}`);
            
            return message;
        }
    } catch (error) {
        console.error('❌ Ошибка проверки состояния БД:', error);
        throw error;
    }
};

window.deepDebug = async function() {
    try {
        const debugInfo = await window.SettingsManager.deepDebug();
        
        if (debugInfo) {
            const latestSettings = debugInfo.all_settings[0];
            let message = `🔍 ГЛУБОКАЯ ДИАГНОСТИКА:\n\n`;
            message += `Последние настройки (ID: ${latestSettings.id}):\n`;
            message += `- Цехов: ${latestSettings.data.workshops ? latestSettings.data.workshops.length : 'N/A'}\n`;
            if (latestSettings.data.workshops) {
                message += `- Список: ${latestSettings.data.workshops.map(w => w.name).join(', ')}\n`;
            }
            message += `- Станков: ${latestSettings.data.machines ? latestSettings.data.machines.length : 'N/A'}\n\n`;
            
            message += `Распределение: ${debugInfo.distribution.length} записей\n`;
            message += `Станки в системе: ${debugInfo.machines.length} шт.\n\n`;
            
            message += `Всего записей в БД: ${debugInfo.all_settings.length}`;
            
            alert(message);
        }
    } catch (error) {
        console.error('❌ Ошибка глубокой диагностики:', error);
        alert('Ошибка глубокой диагностики: ' + error.message);
    }
};

window.getSettingsManager = function() {
    return window.SettingsManager;
};

window.verifySavedData = async function() {
    try {
        const result = await window.SettingsManager.verifySavedData();
        if (result) {
            alert(`Проверка данных:\n\n` +
                  `Последние настройки: ${result.latest.workshops_count} цехов\n` +
                  `Цехи: ${result.latest.workshops.join(', ')}\n` +
                  `Всего записей в БД: ${result.total_records}`);
        }
    } catch (error) {
        console.error('❌ Ошибка проверки данных:', error);
        alert('Ошибка проверки данных: ' + error.message);
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