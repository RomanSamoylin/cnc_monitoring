// settings-manager.js - Обновленная версия
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
    }

    // Загрузка настроек с сервера
    async loadSettings() {
        try {
            console.log('Загрузка настроек с сервера...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/distribution`);
            if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
            
            const data = await response.json();
            if (!data.success) throw new Error('Ошибка в данных сервера');
            
            this.settings = data;
            this.isLoaded = true;
            this.saveToLocalStorage();
            console.log('Настройки загружены:', this.settings.workshops.length, 'цехов,', this.settings.machines.length, 'станков');
            
            // Генерируем событие об успешной загрузке
            this.dispatchSettingsLoaded();
            return true;
        } catch (error) {
            console.error('Ошибка загрузки настроек с сервера:', error);
            // Пробуем загрузить из localStorage
            return this.loadFromLocalStorage();
        }
    }

    // Принудительное обновление данных с сервера
    async refreshSettings() {
        try {
            console.log('Принудительное обновление настроек...');
            const response = await fetch(`${this.SERVER_URL}/api/settings/refresh`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                }
            });
            
            if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
            
            const data = await response.json();
            if (!data.success) throw new Error('Ошибка обновления данных');
            
            this.settings = data.settings;
            this.isLoaded = true;
            this.saveToLocalStorage();
            
            console.log('Настройки обновлены:', this.settings.workshops.length, 'цехов,', this.settings.machines.length, 'станков');
            
            // Генерируем событие об обновлении
            this.dispatchSettingsUpdated();
            return true;
        } catch (error) {
            console.error('Ошибка принудительного обновления:', error);
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
            
            if (!response.ok) throw new Error(`Ошибка сети: ${response.status}`);
            
            const data = await response.json();
            if (!data.success) throw new Error('Ошибка сохранения на сервере');
            
            // Обновляем локальные настройки данными с сервера
            if (data.settings) {
                this.settings.workshops = data.settings.workshops;
                this.settings.machines = data.settings.machines;
                this.updateDistributionFromMachines();
            }
            
            this.saveToLocalStorage();
            console.log('Настройки сохранены на сервер');
            return true;
        } catch (error) {
            console.error('Ошибка сохранения настроек на сервер:', error);
            throw error;
        }
    }

    // Сохранение в localStorage
    saveToLocalStorage() {
        try {
            const dataToSave = {
                settings: this.settings,
                timestamp: new Date().toISOString(),
                version: '2.0'
            };
            localStorage.setItem('cnc_settings_v2', JSON.stringify(dataToSave));
            console.log('Настройки сохранены в localStorage');
        } catch (e) {
            console.error('Ошибка сохранения в localStorage:', e);
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
                    console.log('Настройки загружены из localStorage:', this.settings.workshops.length, 'цехов');
                    
                    // Генерируем событие
                    this.dispatchSettingsLoaded();
                    return true;
                } else {
                    console.log('Данные в localStorage устарели');
                    localStorage.removeItem('cnc_settings_v2');
                }
            }
        } catch (e) {
            console.error('Ошибка загрузки из localStorage:', e);
            localStorage.removeItem('cnc_settings_v2');
        }
        return false;
    }

    // Обновление распределения из данных машин
    updateDistributionFromMachines() {
        this.settings.distribution = {};
        this.settings.machines.forEach(machine => {
            this.settings.distribution[machine.id] = machine.workshop;
        });
    }

    // Получение цеха для станка
    getWorkshopForMachine(machineId) {
        // Сначала проверяем distribution
        if (this.settings.distribution[machineId]) {
            return this.settings.distribution[machineId];
        }
        
        // Затем проверяем machines
        const machine = this.settings.machines.find(m => m.id == machineId);
        if (machine && machine.workshop) {
            return machine.workshop;
        }
        
        // Возвращаем цех по умолчанию
        return 1;
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
            const machineWorkshop = machine.workshop || this.getWorkshopForMachine(machine.id);
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
                machine.workshop = workshopId;
                this.settings.distribution[machineId] = workshopId;
            }

            // Сохраняем на сервер
            const settingsToSave = {
                workshops: this.settings.workshops,
                machines: this.settings.machines
            };
            
            await this.saveSettings(settingsToSave);
            console.log(`Станок ${machineId} перемещен в цех ${workshopId}`);
            
            // Генерируем событие об обновлении
            this.dispatchSettingsUpdated();
            return true;
        } catch (error) {
            console.error('Ошибка перемещения станка:', error);
            return false;
        }
    }

    // Добавление нового цеха
    async addWorkshop(workshopName = null) {
        try {
            const newId = this.settings.workshops.length > 0 
                ? Math.max(...this.settings.workshops.map(w => w.id)) + 1 
                : 1;
            
            const newWorkshop = {
                id: newId,
                name: workshopName || `ЦЕХ-${newId}`,
                machinesCount: 0
            };
            
            this.settings.workshops.push(newWorkshop);
            
            // Сохраняем на сервер
            const settingsToSave = {
                workshops: this.settings.workshops,
                machines: this.settings.machines
            };
            
            await this.saveSettings(settingsToSave);
            console.log(`Добавлен новый цех: ${newWorkshop.name}`);
            
            this.dispatchSettingsUpdated();
            return newWorkshop;
        } catch (error) {
            console.error('Ошибка добавления цеха:', error);
            throw error;
        }
    }

    // Удаление цеха
    async removeWorkshop(workshopId) {
        try {
            if (this.settings.workshops.length <= 1) {
                throw new Error('Нельзя удалить единственный цех');
            }
            
            const workshopIndex = this.settings.workshops.findIndex(w => w.id === workshopId);
            if (workshopIndex === -1) {
                throw new Error('Цех не найден');
            }
            
            const removedWorkshop = this.settings.workshops.splice(workshopIndex, 1)[0];
            
            // Перемещаем станки удаленного цеха в первый цех
            this.settings.machines.forEach(machine => {
                if (machine.workshop === workshopId) {
                    machine.workshop = 1;
                }
            });
            
            // Обновляем распределение
            this.updateDistributionFromMachines();
            
            // Сохраняем на сервер
            const settingsToSave = {
                workshops: this.settings.workshops,
                machines: this.settings.machines
            };
            
            await this.saveSettings(settingsToSave);
            console.log(`Удален цех: ${removedWorkshop.name}`);
            
            this.dispatchSettingsUpdated();
            return removedWorkshop;
        } catch (error) {
            console.error('Ошибка удаления цеха:', error);
            throw error;
        }
    }

    // Получение статистики
    async getStats() {
        try {
            const response = await fetch(`${this.SERVER_URL}/api/settings/stats`);
            if (!response.ok) throw new Error('Ошибка получения статистики');
            
            const data = await response.json();
            if (!data.success) throw new Error('Ошибка в данных статистики');
            
            return data.stats;
        } catch (error) {
            console.error('Ошибка получения статистики:', error);
            return null;
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
            console.error('Ошибка проверки здоровья:', error);
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
            detail: error
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
            console.error('Ошибка получения времени обновления:', e);
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
                    console.warn('Сервер недоступен, пропускаем автоматическое обновление');
                }
            } catch (error) {
                console.error('Ошибка автоматического обновления:', error);
            }
        }, interval);
        
        console.log(`Автоматическое обновление запущено с интервалом ${interval}ms`);
    }

    // Остановка автоматического обновления
    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
            console.log('Автоматическое обновление остановлено');
        }
    }

    // Очистка localStorage
    clearLocalStorage() {
        try {
            localStorage.removeItem('cnc_settings_v2');
            console.log('Локальное хранилище очищено');
        } catch (e) {
            console.error('Ошибка очистки localStorage:', e);
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
                    return target[prop].apply(target, args);
                } catch (error) {
                    console.error(`Ошибка в SettingsManager.${prop}:`, error);
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
        console.log('Инициализация SettingsManager...');
        await window.SettingsManager.loadSettings();
        
        // Запускаем автоматическое обновление для дашбордов и других страниц
        if (!window.location.pathname.includes('settings.html')) {
            window.SettingsManager.startAutoRefresh();
        }
    } catch (error) {
        console.error('Ошибка инициализации SettingsManager:', error);
    }
});

// Обработка событий видимости страницы для оптимизации
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        window.SettingsManager.stopAutoRefresh();
    } else {
        // Перезагружаем настройки при возвращении на страницу
        window.SettingsManager.refreshSettings().then(() => {
            window.SettingsManager.startAutoRefresh();
        });
    }
});