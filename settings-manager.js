// settings-manager.js - ПОЛНОСТЬЮ ОБНОВЛЕННАЯ ВЕРСИЯ
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
            console.log('🔄 Загрузка настроек с сервера...');
            
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

            this.settings = data.settings;
            this.isLoaded = true;
            this.updateDistributionFromMachines();
            this.saveToLocalStorage();
            
            console.log('✅ Настройки загружены:', {
                workshops: this.settings.workshops.length,
                machines: this.settings.machines.length,
                workshopsList: this.settings.workshops.map(w => w.name)
            });
            
            this.dispatchSettingsLoaded();
            this.retryCount = 0; // Сброс счетчика попыток при успехе
            return true;
            
        } catch (error) {
            console.error('❌ Ошибка загрузки настроек с сервера:', error);
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
            console.log('🔄 Принудительное обновление настроек...');
            
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
            
            this.settings = data.settings;
            this.isLoaded = true;
            this.updateDistributionFromMachines();
            this.saveToLocalStorage();
            
            console.log('✅ Настройки обновлены:', {
                workshops: this.settings.workshops.length,
                machines: this.settings.machines.length
            });
            
            this.dispatchSettingsUpdated();
            return true;
            
        } catch (error) {
            console.error('❌ Ошибка принудительного обновления:', error);
            this.dispatchSettingsError(error);
            return false;
        }
    }

    // Сохранение настроек на сервер
    async saveSettings(settings) {
        try {
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
                this.settings.workshops = data.settings.workshops;
                this.settings.machines = data.settings.machines;
                this.updateDistributionFromMachines();
            }
            
            this.saveToLocalStorage();
            console.log('💾 Настройки сохранены на сервер');
            
            this.dispatchSettingsUpdated();
            return true;
            
        } catch (error) {
            console.error('❌ Ошибка сохранения настроек на сервер:', error);
            this.dispatchSettingsError(error);
            throw error;
        }
    }

    // Сохранение только цехов
    async saveWorkshops(workshops) {
        try {
            const response = await fetch(`${this.SERVER_URL}/api/settings/save-workshops`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ workshops })
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('💾 Цехи сохранены на сервер:', workshops.length, 'цехов');
            return true;
            
        } catch (error) {
            console.error('❌ Ошибка сохранения цехов:', error);
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
            console.log('📦 Настройки сохранены в localStorage');
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
                    this.settings = parsed.settings;
                    this.isLoaded = true;
                    this.updateDistributionFromMachines();
                    
                    console.log('📦 Настройки загружены из localStorage:', {
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
    }

    // Получение цеха для станка
    getWorkshopForMachine(machineId) {
        return this.settings.distribution[machineId] || 1;
    }

    // Получение списка цехов
    getWorkshops() {
        return this.settings.workshops;
    }

    // Получение цеха по ID
    getWorkshopById(workshopId) {
        return this.settings.workshops.find(w => w.id == workshopId);
    }

    // Получение названия цеха по ID
    getWorkshopNameById(workshopId) {
        const workshop = this.getWorkshopById(workshopId);
        return workshop ? workshop.name : `ЦЕХ-${workshopId}`;
    }

    // Получение списка станков для цеха
    getMachinesForWorkshop(workshopId) {
        return this.settings.machines.filter(machine => {
            const machineWorkshop = machine.workshopId || this.getWorkshopForMachine(machine.id);
            return machineWorkshop == workshopId;
        });
    }

    // Получение всех станков
    getAllMachines() {
        return this.settings.machines;
    }

    // Получение станка по ID
    getMachineById(machineId) {
        return this.settings.machines.find(m => m.id == machineId);
    }

    // Получение названия станка по ID
    getMachineNameById(machineId) {
        const machine = this.getMachineById(machineId);
        return machine ? machine.name : `Станок-${machineId}`;
    }

    // Перемещение станка в другой цех
    async moveMachineToWorkshop(machineId, workshopId) {
        try {
            // Обновляем локальные данные
            const machine = this.getMachineById(machineId);
            if (machine) {
                machine.workshopId = workshopId;
                this.settings.distribution[machineId] = workshopId;
            }

            // Сохраняем на сервер
            const settingsToSave = {
                workshops: this.settings.workshops,
                machines: this.settings.machines
            };
            
            await this.saveSettings(settingsToSave);
            console.log(`➡️ Станок ${machineId} перемещен в цех ${workshopId}`);
            
            return true;
        } catch (error) {
            console.error('❌ Ошибка перемещения станка:', error);
            return false;
        }
    }

    // Получение быстрого распределения
    async getQuickDistribution() {
        try {
            const response = await fetch(`${this.SERVER_URL}/api/settings/quick-distribution`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            return data.distribution;
        } catch (error) {
            console.error('❌ Ошибка получения распределения:', error);
            return null;
        }
    }

    // Получение статистики
    async getStats() {
        try {
            const response = await fetch(`${this.SERVER_URL}/api/settings/stats`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            return data.stats;
        } catch (error) {
            console.error('❌ Ошибка получения статистики:', error);
            return null;
        }
    }

    // Диагностика БД
    async debugDatabase() {
        try {
            console.log('🔍 Запуск диагностики БД...');
            
            const response = await fetch(`${this.SERVER_URL}/api/settings/debug`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (!data.success) {
                throw new Error('Server response indicates failure');
            }
            
            console.log('📊 Диагностика БД:', data.debug);
            return data.debug;
            
        } catch (error) {
            console.error('❌ Ошибка диагностики БД:', error);
            throw error;
        }
    }

    // Проверка здоровья сервера
    async checkHealth() {
        try {
            const response = await fetch(`${this.SERVER_URL}/api/health`);
            if (!response.ok) return false;
            
            const data = await response.json();
            return data.success && data.database === 'connected';
        } catch (error) {
            console.error('❌ Ошибка проверки здоровья:', error);
            return false;
        }
    }

    // Генерация событий
    dispatchSettingsLoaded() {
        window.dispatchEvent(new CustomEvent('settingsLoaded', {
            detail: this.settings
        }));
    }

    dispatchSettingsUpdated() {
        window.dispatchEvent(new CustomEvent('settingsUpdated', {
            detail: this.settings
        }));
    }

    dispatchSettingsError(error) {
        window.dispatchEvent(new CustomEvent('settingsError', {
            detail: {
                message: error.message,
                timestamp: new Date().toISOString()
            }
        }));
    }

    // Проверка, загружены ли настройки
    isSettingsLoaded() {
        return this.isLoaded;
    }

    // Получение временной метки последнего обновления
    getLastUpdateTime() {
        try {
            const saved = localStorage.getItem('cnc_settings_v2');
            if (saved) {
                const parsed = JSON.parse(saved);
                return new Date(parsed.timestamp);
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
        
        this.autoRefreshInterval = setInterval(async () => {
            try {
                const isHealthy = await this.checkHealth();
                if (isHealthy) {
                    await this.refreshSettings();
                } else {
                    console.warn('⚠️ Сервер недоступен, пропускаем автоматическое обновление');
                }
            } catch (error) {
                console.error('❌ Ошибка автоматического обновления:', error);
            }
        }, interval);
        
        console.log(`🔄 Автоматическое обновление запущено с интервалом ${interval}ms`);
    }

    // Остановка автоматического обновления
    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
            console.log('⏹️ Автоматическое обновление остановлено');
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

    // Деструктор
    destroy() {
        this.stopAutoRefresh();
        this.clearLocalStorage();
    }
}

// Создаем глобальный экземпляр с улучшенной обработкой ошибок
window.SettingsManager = new Proxy(new SettingsManager(), {
    get(target, prop) {
        if (typeof target[prop] === 'function') {
            return function(...args) {
                try {
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
        console.log('🚀 Инициализация SettingsManager...');
        
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
        
        console.log('✅ SettingsManager инициализирован');
        
    } catch (error) {
        console.error('❌ Ошибка инициализации SettingsManager:', error);
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
            alert(`📊 Диагностика БД:\n\n` +
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

window.getSettingsManager = function() {
    return window.SettingsManager;
};