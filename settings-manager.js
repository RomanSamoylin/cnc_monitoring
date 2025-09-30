// settings-manager.js
class SettingsManager {
    constructor() {
        this.settings = {
            workshops: [{ id: 1, name: "ЦЕХ-1" }],
            machines: [],
            distribution: {}
        };
        this.isLoaded = false;
        this.autoRefreshInterval = null;
    }

    // Загрузка настроек с сервера
    async loadSettings() {
        try {
            const response = await fetch('http://localhost:3004/api/settings/distribution');
            if (!response.ok) throw new Error('Ошибка загрузки настроек');
            
            const data = await response.json();
            if (data.success) {
                this.settings = data;
                this.isLoaded = true;
                this.saveToLocalStorage();
                console.log('Настройки загружены:', this.settings.workshops.length, 'цехов,', this.settings.machines.length, 'станков');
                return true;
            }
            return false;
        } catch (error) {
            console.error('Ошибка загрузки настроек:', error);
            // Пробуем загрузить из localStorage
            return this.loadFromLocalStorage();
        }
    }

    // Сохранение в localStorage
    saveToLocalStorage() {
        try {
            localStorage.setItem('cnc_settings', JSON.stringify(this.settings));
            localStorage.setItem('cnc_settings_timestamp', new Date().toISOString());
        } catch (e) {
            console.error('Ошибка сохранения в localStorage:', e);
        }
    }

    // Загрузка из localStorage
    loadFromLocalStorage() {
        try {
            const saved = localStorage.getItem('cnc_settings');
            if (saved) {
                this.settings = JSON.parse(saved);
                this.isLoaded = true;
                console.log('Настройки загружены из localStorage:', this.settings.workshops.length, 'цехов');
                return true;
            }
        } catch (e) {
            console.error('Ошибка загрузки из localStorage:', e);
        }
        return false;
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

    // Получение списка станков для цеха
getMachinesForWorkshop(workshopId) {
    return this.settings.machines.filter(machine => 
        this.getWorkshopForMachine(machine.id) == workshopId
    );
}
    // Получение всех станков
    getAllMachines() {
        return this.settings.machines;
    }

    // Получение станка по ID
    getMachineById(machineId) {
        return this.settings.machines.find(m => m.id == machineId);
    }

    // Проверка, загружены ли настройки
    isSettingsLoaded() {
        return this.isLoaded;
    }

    // Автоматическое обновление настроек
    startAutoRefresh() {
        // Останавливаем предыдущий интервал, если он был
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
        }
        
        this.autoRefreshInterval = setInterval(async () => {
            try {
                const response = await fetch('http://localhost:3004/api/settings/distribution');
                if (response.ok) {
                    const data = await response.json();
                    if (data.success) {
                        this.settings = data;
                        this.saveToLocalStorage();
                        console.log('Настройки автоматически обновлены:', this.settings.workshops.length, 'цехов');
                        
                        // Генерируем событие для обновления интерфейса
                        window.dispatchEvent(new CustomEvent('settingsUpdated', {
                            detail: this.settings
                        }));
                    }
                }
            } catch (error) {
                console.error('Ошибка автоматического обновления настроек:', error);
            }
        }, 30000); // 30 секунд
    }

    // Остановка автоматического обновления
    stopAutoRefresh() {
        if (this.autoRefreshInterval) {
            clearInterval(this.autoRefreshInterval);
            this.autoRefreshInterval = null;
        }
    }
}

// Создаем глобальный экземпляр
window.SettingsManager = SettingsManager;