// localStorage.js - ИСПРАВЛЕННАЯ ВЕРСИЯ для системы мониторинга станков
// Версия 3.1 - Адаптировано для работы с единым методом сохранения

// Конфигурация приложения
const APP_CONFIG = {
    APP_NAME: 'CNCMonitoring',
    API_BASE_URL: 'http://localhost:3004/api',
    ENDPOINTS: {
        SETTINGS: '/settings',
        SAVE_SETTINGS: '/settings/save', // ЕДИНЫЙ метод сохранения
        IMPORT_SETTINGS: '/settings/import',
        BACKUPS: '/settings/backups',
        RESTORE: '/settings/restore',
        HEALTH: '/health',
        DISTRIBUTION: '/settings/distribution',
        WORKSHOPS: '/settings/workshops',
        STATS: '/settings/stats',
        DEBUG: '/settings/debug',
        VERIFY: '/settings/verify'
    },
    SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24 часа
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_TIME: 15 * 60 * 1000, // 15 минут блокировки
    DEFAULT_REQUEST_HEADERS: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
    }
};

// Менеджер хранилища с улучшенной безопасностью
const StorageManager = {
    // Получить данные с проверкой срока действия
    getItem: function(key) {
        try {
            const item = localStorage.getItem(`${APP_CONFIG.APP_NAME}_${key}`);
            if (!item) return null;

            const data = JSON.parse(item);
            
            // Проверка срока действия
            if (data.expires && Date.now() > data.expires) {
                this.removeItem(key);
                return null;
            }
            
            return data.value;
        } catch (e) {
            console.error('StorageManager.getItem error:', e);
            this.removeItem(key); // Удаляем поврежденные данные
            return null;
        }
    },

    // Сохранить данные с временем жизни
    setItem: function(key, value, ttl = null) {
        try {
            const item = {
                value: value,
                timestamp: Date.now()
            };

            if (ttl) {
                item.expires = Date.now() + ttl;
            }

            localStorage.setItem(`${APP_CONFIG.APP_NAME}_${key}`, JSON.stringify(item));
            return true;
        } catch (e) {
            console.error('StorageManager.setItem error:', e);
            return false;
        }
    },

    // Удалить данные
    removeItem: function(key) {
        try {
            localStorage.removeItem(`${APP_CONFIG.APP_NAME}_${key}`);
            return true;
        } catch (e) {
            console.error('StorageManager.removeItem error:', e);
            return false;
        }
    },

    // Очистить все данные приложения
    clearAll: function() {
        try {
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith(APP_CONFIG.APP_NAME)) {
                    localStorage.removeItem(key);
                }
            });
            console.log('✅ Все данные приложения очищены из localStorage');
            return true;
        } catch (e) {
            console.error('StorageManager.clearAll error:', e);
            return false;
        }
    },

    // Получить все ключи приложения
    getAllKeys: function() {
        try {
            return Object.keys(localStorage).filter(key => 
                key.startsWith(APP_CONFIG.APP_NAME)
            );
        } catch (e) {
            console.error('StorageManager.getAllKeys error:', e);
            return [];
        }
    },

    // Проверить существование ключа
    hasItem: function(key) {
        return localStorage.getItem(`${APP_CONFIG.APP_NAME}_${key}`) !== null;
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
            console.log(`🌐 API Request: ${method} ${endpoint}`);
            
            const response = await fetch(url, requestOptions);
            
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
            console.log(`✅ API Response: ${endpoint}`, responseData.success);
            return responseData;

        } catch (error) {
            console.error(`❌ API Request failed: ${method} ${endpoint}`, error);
            throw error;
        }
    },

    // Получить настройки
    getSettings: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.SETTINGS);
    },

    // ЕДИНЫЙ МЕТОД: Сохранить ВСЕ настройки
    saveSettings: async function(settings) {
        return await this.request(APP_CONFIG.ENDPOINTS.SAVE_SETTINGS, 'POST', { settings });
    },

    // УДАЛЕН МЕТОД saveWorkshops() - больше не нужен!

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

    // Проверка сохраненных данных
    verifyData: async function() {
        return await this.request(APP_CONFIG.ENDPOINTS.VERIFY);
    }
};

// Менеджер настроек для работы с данными
const SettingsManager = {
    // Загрузить настройки с сервера или из кэша
    loadSettings: async function() {
        try {
            // Сначала пробуем загрузить с сервера
            const response = await SettingsApiClient.getSettings();
            
            if (response.success && response.settings) {
                // Сохраняем в localStorage
                StorageManager.setItem('settings', response.settings, APP_CONFIG.SESSION_TIMEOUT);
                StorageManager.setItem('lastUpdate', new Date().toISOString());
                
                console.log('✅ Настройки загружены с сервера:', {
                    workshops: response.settings.workshops.length,
                    machines: response.settings.machines.length,
                    workshopsList: response.settings.workshops.map(w => w.name)
                });
                
                return response.settings;
            } else {
                throw new Error('Invalid server response');
            }
        } catch (error) {
            console.error('❌ Ошибка загрузки настроек с сервера:', error);
            
            // Пробуем загрузить из кэша
            const cachedSettings = StorageManager.getItem('settings');
            if (cachedSettings) {
                console.log('📦 Настройки загружены из кэша');
                return cachedSettings;
            }
            
            // Используем настройки по умолчанию
            console.log('⚙️ Используем настройки по умолчанию');
            return this.getDefaultSettings();
        }
    },

    // ЕДИНЫЙ МЕТОД: Сохранить ВСЕ настройки
    saveSettings: async function(settings) {
        try {
            console.log('💾 Сохранение ВСЕХ настроек:', {
                workshops: settings.workshops.length,
                machines: settings.machines.length
            });
            
            const response = await SettingsApiClient.saveSettings(settings);
            
            if (response.success) {
                // Обновляем кэш
                StorageManager.setItem('settings', settings, APP_CONFIG.SESSION_TIMEOUT);
                StorageManager.setItem('lastUpdate', new Date().toISOString());
                
                console.log('✅ Все настройки сохранены:', {
                    workshops: settings.workshops.length,
                    machines: settings.machines.length
                });
                
                return true;
            } else {
                throw new Error(response.message || 'Save failed');
            }
        } catch (error) {
            console.error('❌ Ошибка сохранения настроек:', error);
            
            // Сохраняем в кэш даже при ошибке сети
            StorageManager.setItem('settings', settings, APP_CONFIG.SESSION_TIMEOUT);
            StorageManager.setItem('lastUpdate', new Date().toISOString());
            
            throw error;
        }
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
        return StorageManager.getItem('lastUpdate');
    },

    // Очистить кэш настроек
    clearCache: function() {
        StorageManager.removeItem('settings');
        StorageManager.removeItem('lastUpdate');
        console.log('🧹 Кэш настроек очищен');
    },

    // Проверить целостность данных
    verifyDataIntegrity: async function() {
        try {
            const response = await SettingsApiClient.verifyData();
            
            if (response.success) {
                console.log('🔍 Проверка целостности данных:', response.analysis);
                return response;
            } else {
                throw new Error('Data verification failed');
            }
        } catch (error) {
            console.error('❌ Ошибка проверки целостности данных:', error);
            throw error;
        }
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
    }
};

// Инициализация приложения
const AppInitializer = {
    // Инициализировать приложение
    initialize: async function() {
        try {
            console.log('🚀 Инициализация приложения...');

            // Проверяем здоровье сервера
            const healthResponse = await SettingsApiClient.checkHealth();
            const isServerHealthy = healthResponse.success && healthResponse.database === 'connected';

            if (!isServerHealthy) {
                console.warn('⚠️ Сервер недоступен, работаем в оффлайн режиме');
                UIManager.showInfo('Сервер недоступен. Работаем в оффлайн режиме.');
            }

            // Загружаем настройки
            const settings = await SettingsManager.loadSettings();
            
            console.log('✅ Приложение инициализировано:', {
                server: isServerHealthy ? 'online' : 'offline',
                workshops: settings.workshops.length,
                machines: settings.machines.length
            });

            return {
                settings: settings,
                serverStatus: isServerHealthy ? 'online' : 'offline',
                lastUpdate: SettingsManager.getLastUpdate()
            };

        } catch (error) {
            console.error('❌ Ошибка инициализации приложения:', error);
            UIManager.showError('Ошибка инициализации приложения');
            
            // Возвращаем настройки по умолчанию
            return {
                settings: SettingsManager.getDefaultSettings(),
                serverStatus: 'error',
                lastUpdate: null
            };
        }
    },

    // Проверить состояние БД
    checkDatabaseState: async function() {
        try {
            console.log('🔍 Проверка состояния БД...');
            
            const debugResponse = await SettingsApiClient.debugDatabase();
            
            if (debugResponse.success) {
                const debugInfo = debugResponse.debug;
                const latest = debugInfo.latest_settings;
                
                console.log('📊 Состояние БД:', debugInfo);
                
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
            console.error('❌ Ошибка проверки состояния БД:', error);
            UIManager.showError('Ошибка проверки состояния БД: ' + error.message);
            
            return {
                success: false,
                error: error.message
            };
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
    
    // Проверка целостности данных
    verifyData: SettingsManager.verifyDataIntegrity,
    
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
        
        console.log('🎉 Приложение готово к работе');
        
    } catch (error) {
        console.error('💥 Критическая ошибка инициализации:', error);
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