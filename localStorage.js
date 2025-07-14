// Пример с использованием localStorage для "Запомнить меня"
document.getElementById("loginForm").addEventListener("submit", function (event) {
    event.preventDefault();

    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;
    const rememberMe = document.getElementById("rememberMe").checked; // Добавьте чекбокс "Запомнить меня"

    if (username === "admin" && password === "victoria123") {
        if (rememberMe) {
            localStorage.setItem("username", username); // Сохраняем логин
        } else {
            localStorage.removeItem("username"); // Удаляем логин
        }
        window.location.href = "dashboard.html";
    } else {
        document.getElementById("errorMessage").style.display = "block";
    }
});

// При загрузке страницы проверяем сохраненный логин
window.onload = function () {
    const savedUsername = localStorage.getItem("username");
    if (savedUsername) {
        document.getElementById("username").value = savedUsername;
    }
};
/**
 * Модуль для работы с localStorage и взаимодействия с сервером
 * Версия 2.0
 */

// Конфигурация приложения
const APP_CONFIG = {
    APP_NAME: 'MachineMonitoring',
    API_BASE_URL: 'https://api.machine-monitoring.com/v1',
    ENDPOINTS: {
        LOGIN: '/auth/login',
        LOGOUT: '/auth/logout',
        VERIFY_SESSION: '/auth/verify',
        GET_SETTINGS: '/settings',
        UPDATE_SETTINGS: '/settings/update'
    },
    SESSION_TIMEOUT: 30 * 60 * 1000, // 30 минут
    MAX_LOGIN_ATTEMPTS: 5,
    LOCKOUT_TIME: 15 * 60 * 1000, // 15 минут блокировки
    ENCRYPTION_PREFIX: 'ENC_',
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
        localStorage.removeItem(`${APP_CONFIG.APP_NAME}_${key}`);
    },

    // Очистить все данные приложения
    clearAll: function() {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith(APP_CONFIG.APP_NAME)) {
                localStorage.removeItem(key);
            }
        });
    },

    // Базовое "шифрование" (не для production!)
    encrypt: function(data) {
        if (!data) return data;
        return APP_CONFIG.ENCRYPTION_PREFIX + btoa(unescape(encodeURIComponent(data)));
    },

    decrypt: function(data) {
        if (!data || !data.startsWith(APP_CONFIG.ENCRYPTION_PREFIX)) return data;
        try {
            return decodeURIComponent(escape(atob(data.substring(APP_CONFIG.ENCRYPTION_PREFIX.length))));
        } catch (e) {
            return data;
        }
    }
};

// API клиент для взаимодействия с сервером
const ApiClient = {
    // Отправить запрос к API
    request: async function(endpoint, method = 'GET', data = null, headers = {}) {
        const url = APP_CONFIG.API_BASE_URL + endpoint;
        const requestOptions = {
            method: method,
            headers: { ...APP_CONFIG.DEFAULT_REQUEST_HEADERS, ...headers },
            credentials: 'include'
        };

        if (data) {
            requestOptions.body = JSON.stringify(data);
        }

        try {
            const response = await fetch(url, requestOptions);
            
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('API request failed:', error);
            throw error;
        }
    },

    // Авторизация пользователя
    login: async function(username, password) {
        try {
            const response = await this.request(APP_CONFIG.ENDPOINTS.LOGIN, 'POST', {
                username: username,
                password: password
            });

            if (response.success) {
                // Сохраняем токен и данные пользователя
                StorageManager.setItem('authToken', response.data.token, APP_CONFIG.SESSION_TIMEOUT);
                StorageManager.setItem('userData', response.data.user);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Login failed:', error);
            return false;
        }
    },

    // Выход из системы
    logout: async function() {
        try {
            await this.request(APP_CONFIG.ENDPOINTS.LOGOUT, 'POST');
            StorageManager.clearAll();
            return true;
        } catch (error) {
            console.error('Logout failed:', error);
            return false;
        }
    },

    // Проверка активной сессии
    verifySession: async function() {
        try {
            const token = StorageManager.getItem('authToken');
            if (!token) return false;

            const response = await this.request(
                APP_CONFIG.ENDPOINTS.VERIFY_SESSION, 
                'GET',
                null,
                { 'Authorization': `Bearer ${token}` }
            );

            return response.success;
        } catch (error) {
            console.error('Session verification failed:', error);
            return false;
        }
    },

    // Получить настройки с сервера
    getSettings: async function() {
        try {
            const token = StorageManager.getItem('authToken');
            if (!token) throw new Error('Not authenticated');

            const response = await this.request(
                APP_CONFIG.ENDPOINTS.GET_SETTINGS,
                'GET',
                null,
                { 'Authorization': `Bearer ${token}` }
            );

            if (response.success) {
                StorageManager.setItem('appSettings', response.data.settings);
                return response.data.settings;
            }
            return null;
        } catch (error) {
            console.error('Failed to get settings:', error);
            throw error;
        }
    },

    // Обновить настройки на сервере
    updateSettings: async function(settings) {
        try {
            const token = StorageManager.getItem('authToken');
            if (!token) throw new Error('Not authenticated');

            const response = await this.request(
                APP_CONFIG.ENDPOINTS.UPDATE_SETTINGS,
                'POST',
                { settings },
                { 'Authorization': `Bearer ${token}` }
            );

            if (response.success) {
                StorageManager.setItem('appSettings', settings);
                return true;
            }
            return false;
        } catch (error) {
            console.error('Failed to update settings:', error);
            throw error;
        }
    }
};

// Обработчик формы входа
document.getElementById("loginForm")?.addEventListener("submit", async function(event) {
    event.preventDefault();

    // Проверка блокировки
    const loginAttempts = StorageManager.getItem('loginAttempts') || 0;
    const lastAttemptTime = StorageManager.getItem('lastAttemptTime');
    
    if (loginAttempts >= APP_CONFIG.MAX_LOGIN_ATTEMPTS && 
        lastAttemptTime && 
        (Date.now() - lastAttemptTime) < APP_CONFIG.LOCKOUT_TIME) {
        const minutesLeft = Math.ceil((APP_CONFIG.LOCKOUT_TIME - (Date.now() - lastAttemptTime)) / 60000);
        showError(`Слишком много попыток входа. Попробуйте через ${minutesLeft} минут.`);
        return;
    }

    const username = document.getElementById("username").value.trim();
    const password = document.getElementById("password").value;
    const rememberMe = document.getElementById("rememberMe")?.checked;

    try {
        const loginSuccess = await ApiClient.login(username, password);
        
        if (loginSuccess) {
            // Сброс счетчика попыток
            StorageManager.removeItem('loginAttempts');
            StorageManager.removeItem('lastAttemptTime');

            // Сохранение для "запомнить меня"
            if (rememberMe) {
                StorageManager.setItem('rememberedUser', StorageManager.encrypt(username));
            } else {
                StorageManager.removeItem('rememberedUser');
            }

            // Загрузка начальных настроек
            await ApiClient.getSettings();
            
            window.location.href = "dashboard.html";
        } else {
            handleFailedLogin(loginAttempts);
        }
    } catch (error) {
        handleFailedLogin(loginAttempts);
        showError(error.message || 'Ошибка при входе в систему');
    }
});

// Обработка неудачного входа
function handleFailedLogin(attempts) {
    const newAttempts = attempts + 1;
    StorageManager.setItem('loginAttempts', newAttempts);
    StorageManager.setItem('lastAttemptTime', Date.now());

    const attemptsLeft = APP_CONFIG.MAX_LOGIN_ATTEMPTS - newAttempts;
    showError(`Неверные данные. Осталось попыток: ${attemptsLeft}`);

    if (newAttempts >= APP_CONFIG.MAX_LOGIN_ATTEMPTS) {
        showError(`Вы превысили количество попыток. Аккаунт заблокирован на ${APP_CONFIG.LOCKOUT_TIME / 60000} минут.`);
    }
}

// Показать сообщение об ошибке
function showError(message) {
    const errorElement = document.getElementById("errorMessage");
    if (errorElement) {
        errorElement.textContent = message;
        errorElement.style.display = "block";
    }
}

// Проверка авторизации при загрузке страницы
async function checkAuth() {
    try {
        const isVerified = await ApiClient.verifySession();
        if (isVerified) {
            // Продление сессии
            const token = StorageManager.getItem('authToken');
            if (token) {
                StorageManager.setItem('authToken', token, APP_CONFIG.SESSION_TIMEOUT);
            }
            return true;
        }
    } catch (error) {
        console.error('Auth check failed:', error);
    }
    
    StorageManager.clearAll();
    return false;
}

// Выход из системы
async function logout() {
    await ApiClient.logout();
    window.location.href = "login.html";
}

// Инициализация при загрузке страницы
async function initialize() {
    // Автозаполнение для "запомнить меня"
    const rememberedUser = StorageManager.getItem('rememberedUser');
    if (rememberedUser) {
        const usernameInput = document.getElementById("username");
        if (usernameInput) {
            usernameInput.value = StorageManager.decrypt(rememberedUser);
            document.getElementById("rememberMe").checked = true;
        }
    }

    // Проверка авторизации для защищенных страниц
    if (!window.location.pathname.includes('login.html')) {
        const isAuthenticated = await checkAuth();
        if (!isAuthenticated) {
            window.location.href = "login.html";
        } else {
            // Загрузка данных приложения
            try {
                await ApiClient.getSettings();
                console.log('Application initialized');
            } catch (error) {
                console.error('Initialization error:', error);
            }
        }
    }
}

// Инициализация приложения
window.addEventListener('DOMContentLoaded', initialize);

// Экспорт для использования в других модулях
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        StorageManager,
        ApiClient,
        checkAuth,
        logout,
        initialize
    };
}