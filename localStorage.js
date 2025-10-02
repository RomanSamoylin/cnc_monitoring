// localStorage.js - ПОЛНОСТЬЮ ИСПРАВЛЕННАЯ ВЕРСИЯ для системы мониторинга станков
// Версия 4.0 - С улучшенной обработкой данных и диагностикой

// Конфигурация приложения
const APP_CONFIG = {
    APP_NAME: 'CNCMonitoring',
    API_BASE_URL: 'http://localhost:3004/api',
    ENDPOINTS: {
        SETTINGS: '/settings',
        SAVE_SETTINGS: '/settings/save',
        IMPORT_SETTINGS: '/settings/import',
        BACKUPS: '/settings/backups',
        RESTORE: '/settings/restore',
        HEALTH: '/health',
        DISTRIBUTION: '/settings/distribution',
        WORKSHOPS: '/settings/workshops',
        STATS: '/settings/stats',
        DEBUG: '/settings/debug',
        DEBUG_DETAILED: '/settings/debug-detailed',
        VERIFY: '/settings/verify',
        REFRESH: '/settings/refresh',
        QUICK_DISTRIBUTION: '/settings/quick-distribution',
        CURRENT: '/settings/current'
    },
    SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24 часа
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_TIME: 15 * 60 * 1000, // 15 минут блокировки
    DEFAULT_REQUEST_HEADERS: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    },
    STORAGE_KEYS: {
        SETTINGS: 'settings',
        LAST_UPDATE: 'lastUpdate',
        SERVER_STATUS: 'serverStatus',
        CACHE_TIMESTAMP: 'cacheTimestamp',
        WORKSHOPS_CACHE: 'workshopsCache',
        MACHINES_CACHE: 'machinesCache'
    }
};

// Менеджер хранилища с улучшенной безопасностью и диагностикой
const StorageManager = {
    // Получить данные с проверкой срока действия
    getItem: function(key) {
        try {
            const fullKey = `${APP_CONFIG.APP_NAME}_${key}`;
            const item = localStorage.getItem(fullKey);
            
            if (!item) {
                console.log(`📦 StorageManager: ключ "${key}" не найден`);
                return null;
            }

            const data = JSON.parse(item);
            
            // Проверка срока действия
            if (data.expires && Date.now() > data.expires) {
                console.log(`🕒 StorageManager: данные для ключа "${key}" устарели`);
                this.removeItem(key);
                return null;
            }
            
            console.log(`📦 StorageManager: данные для ключа "${key}" загружены`, {
                size: JSON.stringify(data.value).length,
                hasValue: !!data.value,
                timestamp: new Date(data.timestamp).toLocaleString()
            });
            
            return data.value;
        } catch (e) {
            console.error(`❌ StorageManager.getItem error for key "${key}":`, e);
            this.removeItem(key); // Удаляем поврежденные данные
            return null;
        }
    },

    // Сохранить данные с временем жизни
    setItem: function(key, value, ttl = null) {
        try {
            const fullKey = `${APP_CONFIG.APP_NAME}_${key}`;
            const item = {
                value: value,
                timestamp: Date.now()
            };

            if (ttl) {
                item.expires = Date.now() + ttl;
            }

            localStorage.setItem(fullKey, JSON.stringify(item));
            
            console.log(`💾 StorageManager: данные для ключа "${key}" сохранены`, {
                size: JSON.stringify(value).length,
                ttl: ttl ? `${ttl / 1000} сек` : 'нет',
                valueType: Array.isArray(value) ? `массив[${value.length}]` : typeof value
            });
            
            return true;
        } catch (e) {
            console.error(`❌ StorageManager.setItem error for key "${key}":`, e);
            return false;
        }
    },

    // Удалить данные
    removeItem: function(key) {
        try {
            const fullKey = `${APP_CONFIG.APP_NAME}_${key}`;
            localStorage.removeItem(fullKey);
            console.log(`🗑️ StorageManager: ключ "${key}" удален`);
            return true;
        } catch (e) {
            console.error(`❌ StorageManager.removeItem error for key "${key}":`, e);
            return false;
        }
    },

    // Очистить все данные приложения
    clearAll: function() {
        try {
            const keys = this.getAllKeys();
            keys.forEach(key => {
                localStorage.removeItem(key);
            });
            console.log(`🧹 StorageManager: очищено ${keys.length} ключей`);
            return true;
        } catch (e) {
            console.error('❌ StorageManager.clearAll error:', e);
            return false;
        }
    },

    // Получить все ключи приложения
    getAllKeys: function() {
        try {
            const keys = Object.keys(localStorage).filter(key => 
                key.startsWith(APP_CONFIG.APP_NAME)
            );
            console.log(`🔑 StorageManager: найдено ${keys.length} ключей приложения`);
            return keys;
        } catch (e) {
            console.error('❌ StorageManager.getAllKeys error:', e);
            return [];
        }
    },

    // Проверить существование ключа
    hasItem: function(key) {
        const exists = localStorage.getItem(`${APP_CONFIG.APP_NAME}_${key}`) !== null;
        console.log(`❓ StorageManager: ключ "${key}" ${exists ? 'существует' : 'не существует'}`);
        return exists;
    },

    // Получить информацию о хранилище
    getStorageInfo: function() {
        try {
            const keys = this.getAllKeys();
            let totalSize = 0;
            const info = {};

            keys.forEach(key => {
                const value = localStorage.getItem(key);
                const size = value ? new Blob([value]).size : 0;
                totalSize += size;
                
                const shortKey = key.replace(`${APP_CONFIG.APP_NAME}_`, '');
                info[shortKey] = {
                    size: size,
                    sizeFormatted: this._formatBytes(size),
                    value: value ? JSON.parse(value) : null
                };
            });

            return {
                totalKeys: keys.length,
                totalSize: totalSize,
                totalSizeFormatted: this._formatBytes(totalSize),
                keys: info
            };
        } catch (e) {
            console.error('❌ StorageManager.getStorageInfo error:', e);
            return null;
        }
    },

    // Вспомогательная функция для форматирования байтов
    _formatBytes: function(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }
};

// API клиент для взаимодействия с сервером настроек
const SettingsApiClient = {
    // Базовый метод для отправки запросов
    request: async function(endpoint, method = 'GET', data = null, options = {}) {
        const url = APP_CONFIG.API_BASE_URL + endpoint;
        const requestOptions = {
            method: method,
            headers: { ...APP_CONFIG.DEFAULT_REQUEST_HEADERS, ...options.headers },
            credentials: 'include',
            timeout: options.timeout || 30000
        };

        if (data && (method === 'POST' || method === 'PUT')) {
            requestOptions.body = JSON.stringify(data);
        }

        try {
            console.log(`🌐 API Request: ${method} ${endpoint}`, data ? { dataSize: JSON.stringify(data).length } : '');
            
            const startTime = Date.now();
            const response = await fetch(url, requestOptions);
            const responseTime = Date.now() - startTime;
            
            if (!response.ok) {
                const errorText = await response.text();
                let errorData;
                try {
                    errorData = JSON.parse(errorText);
                } catch {
                    errorData = { message: errorText || `HTTP error! status: ${response.status}` };
                }
                throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
            }

            const responseData = await response.json();
            console.log(`✅ API Response: ${endpoint}`, {
                success: responseData.success,
                responseTime: `${responseTime}ms`,
                dataSize: JSON.stringify(responseData).length
            });
            
            return responseData;

        } catch (error) {
            console.error(`❌ API Request failed: ${method} ${endpoint}`, {
                error: error.message,
                url: url
            });
            throw error;
        }
    },

    // Получить настройки
    getSettings: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.SETTINGS);
    },

    // Сохранить ВСЕ настройки
    saveSettings: async function(settings) {
        return await this.request(APP_CONFIG.ENDPOINTS.SAVE_SETTINGS, 'POST', { settings });
    },

    // Импорт настроек
    importSettings: async function(settings) {
        return await this.request(APP_CONFIG.ENDPOINTS.IMPORT_SETTINGS, 'POST', { settings });
    },

    // Получить список резервных копий
    getBackups: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.BACKUPS);
    },

    // Восстановить из резервной копии
    restoreFromBackup: async function(filename) {
        return await this.request(APP_CONFIG.ENDPOINTS.RESTORE, 'POST', { filename });
    },

    // Проверить здоровье сервера
    checkHealth: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.HEALTH);
    },

    // Получить распределение
    getDistribution: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.DISTRIBUTION);
    },

    // Получить список цехов
    getWorkshops: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.WORKSHOPS);
    },

    // Получить статистику
    getStats: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.STATS);
    },

    // Диагностика
    debugDatabase: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.DEBUG);
    },

    // Глубокая диагностика
    debugDatabaseDetailed: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.DEBUG_DETAILED);
    },

    // Проверка сохраненных данных
    verifyData: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.VERIFY);
    },

    // Принудительное обновление
    refreshData: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.REFRESH, 'POST');
    },

    // Быстрое распределение
    getQuickDistribution: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.QUICK_DISTRIBUTION);
    },

    // Текущие настройки для экспорта
    getCurrentSettings: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.CURRENT);
    }
};

// Менеджер настроек для работы с данными
const SettingsManager = {
    // Загрузить настройки с сервера или из кэша
    loadSettings: async function() {
        try {
            console.log('🔄 ЗАГРУЗКА НАСТРОЕК...');
            
            // Сначала пробуем загрузить с сервера
            const response = await SettingsApiClient.getSettings();
            
            if (response.success && response.settings) {
                console.log('✅ ДАННЫЕ С СЕРВЕРА:', {
                    workshops: response.settings.workshops.length,
                    machines: response.settings.machines.length,
                    workshopsList: response.settings.workshops.map(w => `${w.name}(id:${w.id})`)
                });
                
                // ВАЖНО: Гарантируем правильную структуру данных
                const validatedSettings = this._validateAndFixSettings(response.settings);
                
                // Сохраняем в localStorage
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SETTINGS, validatedSettings, APP_CONFIG.SESSION_TIMEOUT);
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.LAST_UPDATE, new Date().toISOString());
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS, 'connected');
                
                console.log('💾 НАСТРОЙКИ СОХРАНЕНЫ В КЭШ:', {
                    workshops: validatedSettings.workshops.length,
                    machines: validatedSettings.machines.length
                });
                
                return validatedSettings;
            } else {
                throw new Error('Invalid server response');
            }
        } catch (error) {
            console.error('❌ ОШИБКА ЗАГРУЗКИ НАСТРОЕК С СЕРВЕРА:', error);
            
            // Пробуем загрузить из кэша
            const cachedSettings = StorageManager.getItem(APP_CONFIG.STORAGE_KEYS.SETTINGS);
            if (cachedSettings) {
                console.log('📦 ЗАГРУЗКА ИЗ КЭША:', {
                    workshops: cachedSettings.workshops.length,
                    machines: cachedSettings.machines.length
                });
                
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS, 'cached');
                return cachedSettings;
            }
            
            // Используем настройки по умолчанию
            console.log('⚙️ ИСПОЛЬЗУЕМ НАСТРОЙКИ ПО УМОЛЧАНИЮ');
            StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS, 'default');
            return this.getDefaultSettings();
        }
    },

    // Сохранить ВСЕ настройки
    saveSettings: async function(settings) {
        try {
            console.log('💾 СОХРАНЕНИЕ ВСЕХ НАСТРОЕК:', {
                workshops: settings.workshops.length,
                machines: settings.machines.length,
                workshopsList: settings.workshops.map(w => `${w.name}(id:${w.id})`)
            });
            
            // Валидация данных перед сохранением
            const validatedSettings = this._validateAndFixSettings(settings);
            
            const response = await SettingsApiClient.saveSettings(validatedSettings);
            
            if (response.success) {
                // Обновляем кэш
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SETTINGS, validatedSettings, APP_CONFIG.SESSION_TIMEOUT);
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.LAST_UPDATE, new Date().toISOString());
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS, 'connected');
                
                console.log('✅ ВСЕ НАСТРОЙКИ СОХРАНЕНЫ:', {
                    workshops: validatedSettings.workshops.length,
                    machines: validatedSettings.machines.length
                });
                
                return {
                    success: true,
                    settings: validatedSettings
                };
            } else {
                throw new Error(response.message || 'Save failed');
            }
        } catch (error) {
            console.error('❌ ОШИБКА СОХРАНЕНИЯ НАСТРОЕК:', error);
            
            // Сохраняем в кэш даже при ошибке сети
            StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SETTINGS, settings, APP_CONFIG.SESSION_TIMEOUT);
            StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.LAST_UPDATE, new Date().toISOString());
            StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS, 'offline');
            
            throw error;
        }
    },

    // Валидация и исправление структуры настроек
    _validateAndFixSettings: function(settings) {
        console.log('🔍 ВАЛИДАЦИЯ СТРУКТУРЫ НАСТРОЕК...');
        
        const fixedSettings = {
            workshops: [],
            machines: []
        };

        // Валидация цехов
        if (settings.workshops && Array.isArray(settings.workshops)) {
            fixedSettings.workshops = settings.workshops.map(workshop => ({
                id: workshop.id || this._generateId(),
                name: workshop.name || `ЦЕХ-${workshop.id || this._generateId()}`,
                machinesCount: workshop.machinesCount || 0
            }));
            console.log(`✅ Цехов после валидации: ${fixedSettings.workshops.length}`);
        } else {
            console.warn('⚠️ В настройках нет массива workshops, создаем по умолчанию');
            fixedSettings.workshops = [{ id: 1, name: "ЦЕХ-1", machinesCount: 0 }];
        }

        // Валидация станков
        if (settings.machines && Array.isArray(settings.machines)) {
            fixedSettings.machines = settings.machines.map(machine => ({
                id: machine.id || this._generateId(),
                name: machine.name || `Станок-${machine.id || this._generateId()}`,
                workshopId: machine.workshopId || 1
            }));
            console.log(`✅ Станков после валидации: ${fixedSettings.machines.length}`);
        } else {
            console.warn('⚠️ В настройках нет массива machines, создаем пустой массив');
            fixedSettings.machines = [];
        }

        // Обновляем счетчики станков в цехах
        this._updateWorkshopsMachinesCount(fixedSettings);

        console.log('🎯 РЕЗУЛЬТАТ ВАЛИДАЦИИ:', {
            workshops: fixedSettings.workshops.length,
            machines: fixedSettings.machines.length
        });

        return fixedSettings;
    },

    // Обновление счетчиков станков в цехах
    _updateWorkshopsMachinesCount: function(settings) {
        settings.workshops.forEach(workshop => {
            workshop.machinesCount = settings.machines.filter(m => m.workshopId === workshop.id).length;
        });
    },

    // Генерация ID
    _generateId: function() {
        return Date.now().toString(36) + Math.random().toString(36).substr(2);
    },

    // Получить настройки по умолчанию
    getDefaultSettings: function() {
        return {
            workshops: [
                { 
                    id: 1, 
                    name: "ЦЕХ-1", 
                    machinesCount: 0 
                }
            ],
            machines: []
        };
    },

    // Получить последнее время обновления
    getLastUpdate: function() {
        return StorageManager.getItem(APP_CONFIG.STORAGE_KEYS.LAST_UPDATE);
    },

    // Получить статус сервера
    getServerStatus: function() {
        return StorageManager.getItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS) || 'unknown';
    },

    // Очистить кэш настроек
    clearCache: function() {
        StorageManager.removeItem(APP_CONFIG.STORAGE_KEYS.SETTINGS);
        StorageManager.removeItem(APP_CONFIG.STORAGE_KEYS.LAST_UPDATE);
        StorageManager.removeItem(APP_CONFIG.STORAGE_KEYS.SERVER_STATUS);
        console.log('🧹 КЭШ НАСТРОЕК ОЧИЩЕН');
    },

    // Проверить целостность данных
    verifyDataIntegrity: async function() {
        try {
            const response = await SettingsApiClient.verifyData();
            
            if (response.success) {
                console.log('🔍 ПРОВЕРКА ЦЕЛОСТНОСТИ ДАННЫХ:', response.analysis);
                return response;
            } else {
                throw new Error('Data verification failed');
            }
        } catch (error) {
            console.error('❌ ОШИБКА ПРОВЕРКИ ЦЕЛОСТНОСТИ ДАННЫХ:', error);
            throw error;
        }
    },

    // Глубокая диагностика
    deepDebug: async function() {
        try {
            const response = await SettingsApiClient.debugDatabaseDetailed();
            
            if (response.success) {
                console.log('🔍 ГЛУБОКАЯ ДИАГНОСТИКА:', response);
                return response;
            } else {
                throw new Error('Deep debug failed');
            }
        } catch (error) {
            console.error('❌ ОШИБКА ГЛУБОКОЙ ДИАГНОСТИКИ:', error);
            throw error;
        }
    },

    // Принудительная перезагрузка цехов
    forceReloadWorkshops: async function() {
        try {
            const response = await SettingsApiClient.getWorkshops();
            
            if (response.success && response.workshops) {
                // Обновляем кэш цехов
                const currentSettings = StorageManager.getItem(APP_CONFIG.STORAGE_KEYS.SETTINGS) || this.getDefaultSettings();
                currentSettings.workshops = response.workshops;
                
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.SETTINGS, currentSettings, APP_CONFIG.SESSION_TIMEOUT);
                StorageManager.setItem(APP_CONFIG.STORAGE_KEYS.LAST_UPDATE, new Date().toISOString());
                
                console.log('✅ ЦЕХИ ПЕРЕЗАГРУЖЕНЫ:', response.workshops.length);
                return response.workshops;
            } else {
                throw new Error('Workshops reload failed');
            }
        } catch (error) {
            console.error('❌ ОШИБКА ПЕРЕЗАГРУЗКИ ЦЕХОВ:', error);
            throw error;
        }
    },

    // Получить информацию о хранилище
    getStorageInfo: function() {
        return StorageManager.getStorageInfo();
    }
};

// Функции для работы с интерфейсом
const UIManager = {
    // Показать уведомление
    showNotification: function(message, type = 'info', duration = 4000) {
        // Создаем или находим контейнер для уведомлений
        let notificationContainer = document.getElementById('notificationContainer');
        if (!notificationContainer) {
            notificationContainer = document.createElement('div');
            notificationContainer.id = 'notificationContainer';
            notificationContainer.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                max-width: 400px;
            `;
            document.body.appendChild(notificationContainer);
        }

        const notification = document.createElement('div');
        const types = {
            success: { bg: '#2ecc71', icon: 'fa-check' },
            error: { bg: '#e74c3c', icon: 'fa-exclamation-circle' },
            warning: { bg: '#f39c12', icon: 'fa-exclamation-triangle' },
            info: { bg: '#3498db', icon: 'fa-info-circle' }
        };

        const config = types[type] || types.info;

        notification.innerHTML = `
            <div style="
                background: ${config.bg};
                color: white;
                padding: 12px 16px;
                margin-bottom: 10px;
                border-radius: 4px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                display: flex;
                align-items: center;
                gap: 10px;
                animation: slideIn 0.3s ease-out;
            ">
                <i class="fas ${config.icon}" style="font-size: 16px;"></i>
                <span>${message}</span>
            </div>
        `;

        notificationContainer.appendChild(notification);

        console.log(`📢 Уведомление [${type}]: ${message}`);

        // Автоматическое скрытие
        setTimeout(() => {
            if (notification.parentNode) {
                notification.style.animation = 'slideOut 0.3s ease-in';
                setTimeout(() => {
                    if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                    }
                }, 300);
            }
        }, duration);

        // Добавляем CSS анимации
        if (!document.getElementById('notificationStyles')) {
            const style = document.createElement('style');
            style.id = 'notificationStyles';
            style.textContent = `
                @keyframes slideIn {
                    from { transform: translateX(100%); opacity: 0; }
                    to { transform: translateX(0); opacity: 1; }
                }
                @keyframes slideOut {
                    from { transform: translateX(0); opacity: 1; }
                    to { transform: translateX(100%); opacity: 0; }
                }
            `;
            document.head.appendChild(style);
        }
    },

    // Показать ошибку
    showError: function(message, duration = 5000) {
        this.showNotification(message, 'error', duration);
    },

    // Показать успех
    showSuccess: function(message, duration = 3000) {
        this.showNotification(message, 'success', duration);
    },

    // Показать информацию
    showInfo: function(message, duration = 4000) {
        this.showNotification(message, 'info', duration);
    },

    // Показать диалог с информацией о хранилище
    showStorageInfo: function() {
        const info = StorageManager.getStorageInfo();
        if (!info) {
            this.showError('Не удалось получить информацию о хранилище');
            return;
        }

        let message = `📊 ИНФОРМАЦИЯ О ХРАНИЛИЩЕ:\n\n`;
        message += `Всего ключей: ${info.totalKeys}\n`;
        message += `Общий размер: ${info.totalSizeFormatted}\n\n`;
        
        Object.keys(info.keys).forEach(key => {
            const keyInfo = info.keys[key];
            message += `${key}: ${keyInfo.sizeFormatted}\n`;
        });

        alert(message);
    }
};

// Инициализация приложения
const AppInitializer = {
    // Инициализировать приложение
    initialize: async function() {
        try {
            console.log('🚀 ИНИЦИАЛИЗАЦИЯ ПРИЛОЖЕНИЯ...');

            // Проверяем здоровье сервера
            const healthResponse = await SettingsApiClient.checkHealth();
            const isServerHealthy = healthResponse.success && healthResponse.database === 'connected';

            if (!isServerHealthy) {
                console.warn('⚠️ Сервер недоступен, работаем в оффлайн режиме');
                UIManager.showInfo('Сервер недоступен. Работаем в оффлайн режиме.');
            }

            // Загружаем настройки
            const settings = await SettingsManager.loadSettings();
            
            console.log('✅ ПРИЛОЖЕНИЕ ИНИЦИАЛИЗИРОВАНО:', {
                server: isServerHealthy ? 'online' : 'offline',
                workshops: settings.workshops.length,
                machines: settings.machines.length,
                serverStatus: SettingsManager.getServerStatus()
            });

            return {
                settings: settings,
                serverStatus: isServerHealthy ? 'online' : 'offline',
                storageStatus: SettingsManager.getServerStatus(),
                lastUpdate: SettingsManager.getLastUpdate()
            };

        } catch (error) {
            console.error('❌ ОШИБКА ИНИЦИАЛИЗАЦИИ ПРИЛОЖЕНИЯ:', error);
            UIManager.showError('Ошибка инициализации приложения');
            
            // Возвращаем настройки по умолчанию
            return {
                settings: SettingsManager.getDefaultSettings(),
                serverStatus: 'error',
                storageStatus: 'error',
                lastUpdate: null
            };
        }
    },

    // Проверить состояние БД
    checkDatabaseState: async function() {
        try {
            console.log('🔍 ПРОВЕРКА СОСТОЯНИЯ БД...');
            
            const debugResponse = await SettingsApiClient.debugDatabase();
            
            if (debugResponse.success) {
                const debugInfo = debugResponse.debug;
                const latest = debugInfo.latest_settings;
                
                console.log('📊 СОСТОЯНИЕ БД:', debugInfo);
                
                return {
                    success: true,
                    workshops: latest.workshops_count,
                    machines: latest.machines_count,
                    distribution: debugInfo.distribution_count,
                    totalMachines: debugInfo.machines_count,
                    workshopsList: latest.workshops_list
                };
            } else {
                throw new Error(debugResponse.message || 'Debug request failed');
            }
        } catch (error) {
            console.error('❌ ОШИБКА ПРОВЕРКИ СОСТОЯНИЯ БД:', error);
            UIManager.showError('Ошибка проверки состояния БД: ' + error.message);
            
            return {
                success: false,
                error: error.message
            };
        }
    },

    // Глубокая диагностика
    deepDiagnostics: async function() {
        try {
            console.log('🔍 ЗАПУСК ГЛУБОКОЙ ДИАГНОСТИКИ...');
            
            const debugResponse = await SettingsManager.deepDebug();
            
            if (debugResponse.success) {
                const storageInfo = StorageManager.getStorageInfo();
                
                console.log('📊 ГЛУБОКАЯ ДИАГНОСТИКА ЗАВЕРШЕНА');
                
                return {
                    server: debugResponse,
                    storage: storageInfo,
                    settings: StorageManager.getItem(APP_CONFIG.STORAGE_KEYS.SETTINGS)
                };
            } else {
                throw new Error('Deep diagnostics failed');
            }
        } catch (error) {
            console.error('❌ ОШИБКА ГЛУБОКОЙ ДИАГНОСТИКИ:', error);
            throw error;
        }
    }
};

// Глобальные функции для использования в HTML
window.CNCMonitoring = {
    // API
    api: SettingsApiClient,
    
    // Хранилище
    storage: StorageManager,
    
    // Настройки
    settings: SettingsManager,
    
    // UI
    ui: UIManager,
    
    // Инициализация
    init: AppInitializer.initialize,
    
    // Проверка БД
    checkDB: AppInitializer.checkDatabaseState,
    
    // Диагностика
    deepDiagnostics: AppInitializer.deepDiagnostics,
    
    // Проверка целостности данных
    verifyData: SettingsManager.verifyDataIntegrity,
    
    // Перезагрузка цехов
    reloadWorkshops: SettingsManager.forceReloadWorkshops,
    
    // Информация о хранилище
    storageInfo: SettingsManager.getStorageInfo,
    
    // Вспомогательные функции
    utils: {
        // Форматирование размера файла
        formatFileSize: function(bytes) {
            if (bytes === 0) return '0 Bytes';
            const k = 1024;
            const sizes = ['Bytes', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        },
        
        // Форматирование даты
        formatDate: function(dateString) {
            return new Date(dateString).toLocaleString('ru-RU');
        },
        
        // Генерация ID
        generateId: function() {
            return Date.now().toString(36) + Math.random().toString(36).substr(2);
        },
        
        // Показать информацию о хранилище
        showStorageInfo: function() {
            UIManager.showStorageInfo();
        }
    }
};

// Автоматическая инициализация при загрузке страницы
document.addEventListener('DOMContentLoaded', async function() {
    try {
        // Инициализируем приложение
        const appState = await window.CNCMonitoring.init();
        
        // Генерируем событие об успешной инициализации
        window.dispatchEvent(new CustomEvent('appInitialized', {
            detail: appState
        }));
        
        console.log('🎉 ПРИЛОЖЕНИЕ ГОТОВО К РАБОТЕ', appState);
        
    } catch (error) {
        console.error('💥 КРИТИЧЕСКАЯ ОШИБКА ИНИЦИАЛИЗАЦИИ:', error);
        window.CNCMonitoring.ui.showError('Критическая ошибка инициализации приложения');
    }
});

// Экспорт для использования в других модулях
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        StorageManager,
        SettingsApiClient,
        SettingsManager,
        UIManager,
        AppInitializer,
        APP_CONFIG
    };
}