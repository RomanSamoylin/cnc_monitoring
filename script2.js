document.addEventListener('DOMContentLoaded', () => {
    // Состояние приложения
    const state = {
        machines: {},
        statusHistory: {},
        summary: {
            total: 0,
            working: 0,
            stopped: 0,
            shutdown: 0,
            avg24hLoad: 0
        },
        filters: {
            workshop: 'all',
            machine: 'all',
            status: 'all'
        },
        refreshInterval: null
    };

    // Функция для показа уведомления
    function showNotification(message, isError = false) {
        const notification = document.getElementById('notification');
        notification.textContent = message;
        notification.className = isError ? 'notification error show' : 'notification show';
        
        setTimeout(() => {
            notification.classList.remove('show');
        }, 3000);
    }

    // Функция для сохранения текущих фильтров
    function saveFilters() {
        state.filters = {
            workshop: document.getElementById('workshopFilter').value,
            machine: document.getElementById('machineFilter').value,
            status: document.querySelector('.filter-btn[data-status].active')?.dataset.status || 'all'
        };
    }

    // Функция для восстановления фильтров
    function restoreFilters() {
        document.getElementById('workshopFilter').value = state.filters.workshop;
        document.getElementById('machineFilter').value = state.filters.machine;
        
        document.querySelectorAll('.filter-btn[data-status]').forEach(btn => {
            btn.classList.remove('active');
        });
        
        const statusBtn = document.querySelector(`.filter-btn[data-status="${state.filters.status}"]`);
        if (statusBtn) {
            statusBtn.classList.add('active');
        } else {
            document.querySelector('.filter-btn[data-status="all"]').classList.add('active');
            state.filters.status = 'all';
        }
    }

    // Функция для загрузки данных с сервера
    async function fetchData() {
        saveFilters();
        
        try {
            // Загружаем текущие данные станков
            const machinesResponse = await fetch('http://localhost:3000/api/machines');
            if (!machinesResponse.ok) throw new Error('Ошибка сети');
            const machinesData = await machinesResponse.json();
            
            if (!machinesData.success) throw new Error('Ошибка в данных станков');
            
            // Загружаем исторические данные за 24 часа для каждого станка
            const now = new Date();
            const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            
            const historyPromises = Object.keys(machinesData.machines).map(async machineId => {
                const response = await fetch(`http://localhost:3000/api/machines/${machineId}/history/detailed?startDate=${twentyFourHoursAgo.toISOString()}&endDate=${now.toISOString()}`);
                if (!response.ok) throw new Error(`Ошибка загрузки истории для станка ${machineId}`);
                return response.json();
            });
            
            const historyResults = await Promise.all(historyPromises);
            
            // Обрабатываем данные
            processMachineData(machinesData.machines, historyResults);
            populateFilters();
            restoreFilters();
            renderMachines();
            showNotification('Данные успешно обновлены');
        } catch (error) {
            console.error('Ошибка при загрузке данных:', error);
            showNotification('Ошибка при обновлении данных', true);
        }
    }

    // Обработка данных станков
    function processMachineData(machinesData, historyResults) {
        state.machines = {};
        state.statusHistory = {};
        
        // Обрабатываем текущие данные станков
        Object.entries(machinesData).forEach(([machineId, machineData]) => {
            const status = determineMachineStatus(machineData.status);
            
            state.machines[machineId] = {
                internalId: machineData.internalId,
                displayName: machineData.displayName,
                status: status.status,
                statusText: status.statusText,
                lastUpdate: machineData.lastUpdate
            };
        });
        
        // Обрабатываем исторические данные
        historyResults.forEach((result, index) => {
            const machineId = Object.keys(machinesData)[index];
            if (result.success) {
                state.statusHistory[machineId] = result.data;
            }
        });
        
        // Обновляем сводку
        updateSummary();
    }

    // Определение статуса станка
    function determineMachineStatus(statusData) {
        // event_type = 7 - Состояние системы:
        // value:
        // 0 - Выключено
        // 1 - Остановлено
        // 3 - Остановлено
        // 2 - Работает
        // 4 - Работает
        
        // event_type = 21 - MUSP:
        // value:
        // 0 - Включено
        // 1 - Выключено
        
        // Приоритет статусов:
        // 1. Если MUSP = 1 (Выключено) - станок выключен
        // 2. Иначе смотрим SystemState
        
        if (statusData.MUSP === 1) {
            return { status: 'shutdown', statusText: 'Выключено (MUSP)' };
        }
        
        if (!statusData.SystemState && statusData.SystemState !== 0) {
            return { status: 'shutdown', statusText: 'Нет данных' };
        }
        
        const systemState = statusData.SystemState;
        
        if (systemState === 0) {
            return { status: 'shutdown', statusText: 'Выключено' };
        }
        
        if (systemState === 1 || systemState === 3) {
            return { status: 'stopped', statusText: 'Остановлено' };
        }
        
        if (systemState === 2 || systemState === 4) {
            return { status: 'working', statusText: 'Работает' };
        }
        
        return { status: 'shutdown', statusText: 'Неизвестный статус' };
    }

    // Функция для запуска периодического обновления
    function startAutoRefresh() {
        if (state.refreshInterval) {
            clearInterval(state.refreshInterval);
        }
        
        state.refreshInterval = setInterval(fetchData, 20000);
        fetchData();
    }

    // Функция для заполнения фильтров
    function populateFilters() {
        const workshopFilter = document.getElementById('workshopFilter');
        const machineFilter = document.getElementById('machineFilter');
        
        const currentWorkshop = workshopFilter.value;
        const currentMachine = machineFilter.value;
        
        machineFilter.innerHTML = '<option value="all">Все станки</option>';
        
        Object.values(state.machines).forEach(machine => {
            const option = document.createElement('option');
            option.value = machine.internalId;
            option.textContent = `${machine.displayName} (ID: ${machine.internalId})`;
            machineFilter.appendChild(option);
        });

        if (currentMachine && machineFilter.querySelector(`option[value="${currentMachine}"]`)) {
            machineFilter.value = currentMachine;
        }
    }

    // Функция применения фильтров
    function applyFilters() {
        saveFilters();
        updateMachinesDisplay();
    }

    // Функция обновления отображения карточек
    function updateMachinesDisplay() {
        const cards = document.querySelectorAll('.machine-card');
        if (cards.length === 0) return;

        cards.forEach(card => {
            const cardMachineId = card.id.split('-')[1];
            const machine = state.machines[cardMachineId];
            if (!machine) return;

            const cardWorkshopId = machine.internalId <= 16 ? '1' : '2';
            
            const workshopMatch = state.filters.workshop === 'all' || cardWorkshopId === state.filters.workshop;
            const machineMatch = state.filters.machine === 'all' || cardMachineId === state.filters.machine;
            const statusMatch = state.filters.status === 'all' || machine.status === state.filters.status;
            
            card.style.display = (workshopMatch && machineMatch && statusMatch) ? 'block' : 'none';
        });

        updateFilteredSummary();
    }

    // Обновление сводной информации с учетом фильтров
    function updateFilteredSummary() {
        const filteredMachines = Object.values(state.machines).filter(machine => {
            const workshopId = machine.internalId <= 16 ? '1' : '2';
            
            const workshopMatch = state.filters.workshop === 'all' || workshopId === state.filters.workshop;
            const machineMatch = state.filters.machine === 'all' || machine.internalId.toString() === state.filters.machine;
            const statusMatch = state.filters.status === 'all' || machine.status === state.filters.status;
            
            return workshopMatch && machineMatch && statusMatch;
        });

        document.getElementById('totalMachines').textContent = filteredMachines.length;
        document.getElementById('workingMachines').textContent = filteredMachines.filter(m => m.status === 'working').length;
        document.getElementById('stoppedMachines').textContent = filteredMachines.filter(m => m.status === 'stopped').length;
        document.getElementById('shutdownMachines').textContent = filteredMachines.filter(m => m.status === 'shutdown').length;
        
        const avg24hLoad = calculateAverage24hLoad(filteredMachines);
        document.getElementById('avg24hLoad').textContent = `${avg24hLoad}%`;
    }

    // Обновление сводной статистики
    function updateSummary() {
        const machines = Object.values(state.machines);
        
        state.summary = {
            total: machines.length,
            working: machines.filter(m => m.status === 'working').length,
            stopped: machines.filter(m => m.status === 'stopped').length,
            shutdown: machines.filter(m => m.status === 'shutdown').length,
            avg24hLoad: calculateAverage24hLoad(machines)
        };
        
        document.getElementById('totalMachines').textContent = state.summary.total;
        document.getElementById('workingMachines').textContent = state.summary.working;
        document.getElementById('stoppedMachines').textContent = state.summary.stopped;
        document.getElementById('shutdownMachines').textContent = state.summary.shutdown;
        document.getElementById('avg24hLoad').textContent = `${state.summary.avg24hLoad}%`;
    }
    
    // Расчет средней загрузки за 24 часа (времени работы)
    function calculateAverage24hLoad(machines) {
        let totalLoad = 0;
        let count = 0;
        
        machines.forEach(machine => {
            const history = state.statusHistory[machine.internalId];
            if (history && history.length > 0) {
                const statusStats = calculate24hStatusStats(machine.internalId);
                totalLoad += statusStats.workingPercent;
                count++;
            }
        });
        
        return count > 0 ? Math.round(totalLoad / count) : 0;
    }

    // Полная отрисовка всех станков
    function renderMachines() {
        const container = document.getElementById('machineList');
        const summaryCard = document.getElementById('summaryInfo');
        container.innerHTML = '';
        container.appendChild(summaryCard);

        const sortedMachines = Object.values(state.machines).sort((a, b) => a.internalId - b.internalId);
        
        sortedMachines.forEach(machine => {
            const card = document.createElement('div');
            card.className = `machine-card ${machine.status}`;
            card.id = `machine-${machine.internalId}`;
            
            const workshopId = machine.internalId <= 16 ? 1 : 2;
            
            // Рассчитываем статистику за 24 часа
            const statusStats = calculate24hStatusStats(machine.internalId);
            
            card.innerHTML = `
                <div class="machine-header">
                    <div class="machine-name">${machine.displayName}</div>
                    <div class="machine-status">
                        <span class="status-indicator ${machine.status}"></span>
                        ${machine.statusText}
                    </div>
                </div>
                <div class="machine-details">
                    <div>ID: ${machine.internalId}</div>
                    <div>Цех: ЦЕХ-${workshopId}</div>
                    <div class="last-update">Обновлено: ${new Date(machine.lastUpdate).toLocaleTimeString()}</div>
                </div>
                <div class="status-container">
                    <div class="status-title">Статус за 24 часа</div>
                    <div class="status-summary">
                        <div class="status-item working">
                            <span>Работал</span>
                            <span class="status-value">${statusStats.workingHours}ч (${statusStats.workingPercent}%)</span>
                        </div>
                        <div class="status-item stopped">
                            <span>Остановлен</span>
                            <span class="status-value">${statusStats.stoppedHours}ч (${statusStats.stoppedPercent}%)</span>
                        </div>
                        <div class="status-item shutdown">
                            <span>Выключен</span>
                            <span class="status-value">${statusStats.shutdownHours}ч (${statusStats.shutdownPercent}%)</span>
                        </div>
                    </div>
                </div>
            `;
            
            container.appendChild(card);
        });
        
        applyFilters();
    }
    
    // Расчет статистики статусов за 24 часа
    function calculate24hStatusStats(machineId) {
        const history = state.statusHistory[machineId];
        const result = {
            workingHours: 0,
            stoppedHours: 0,
            shutdownHours: 0,
            workingPercent: 0,
            stoppedPercent: 0,
            shutdownPercent: 0
        };
        
        if (!history || history.length === 0) {
            return result;
        }
        
        let lastStatus = null;
        let lastTimestamp = new Date(history[0].timestamp);
        
        // Инициализируем первый статус
        if (history[0].eventType === 21) { // MUSP
            lastStatus = history[0].value === 1 ? 'shutdown' : 'stopped';
        } else if (history[0].eventType === 7) { // SystemState
            lastStatus = determineStatusFromSystemState(history[0].value);
        }
        
        for (let i = 1; i < history.length; i++) {
            const event = history[i];
            const currentTimestamp = new Date(event.timestamp);
            const timeDiff = (currentTimestamp - lastTimestamp) / (1000 * 60 * 60); // в часах
            
            // Добавляем время к соответствующему статусу
            if (lastStatus === 'working') {
                result.workingHours += timeDiff;
            } else if (lastStatus === 'stopped') {
                result.stoppedHours += timeDiff;
            } else if (lastStatus === 'shutdown') {
                result.shutdownHours += timeDiff;
            }
            
            // Обновляем статус
            if (event.eventType === 21) { // MUSP
                if (event.value === 1) {
                    lastStatus = 'shutdown';
                } else if (lastStatus !== 'shutdown') {
                    // Если MUSP=0 и станок не выключен, статус может быть working или stopped
                    // Оставляем текущий статус (он может измениться только при событии SystemState)
                }
            } else if (event.eventType === 7) { // SystemState
                if (lastStatus !== 'shutdown') {
                    lastStatus = determineStatusFromSystemState(event.value);
                }
            }
            
            lastTimestamp = currentTimestamp;
        }
        
        // Добавляем оставшееся время до текущего момента
        const now = new Date();
        const finalTimeDiff = (now - lastTimestamp) / (1000 * 60 * 60);
        if (lastStatus === 'working') {
            result.workingHours += finalTimeDiff;
        } else if (lastStatus === 'stopped') {
            result.stoppedHours += finalTimeDiff;
        } else if (lastStatus === 'shutdown') {
            result.shutdownHours += finalTimeDiff;
        }
        
        // Нормализуем до 24 часов (на случай, если данные не покрывают полные 24 часа)
        const totalHours = result.workingHours + result.stoppedHours + result.shutdownHours;
        if (totalHours > 0) {
            const scaleFactor = 24 / totalHours;
            result.workingHours = result.workingHours * scaleFactor;
            result.stoppedHours = result.stoppedHours * scaleFactor;
            result.shutdownHours = result.shutdownHours * scaleFactor;
        }
        
        // Рассчитываем проценты
        result.workingPercent = Math.round((result.workingHours / 24) * 100);
        result.stoppedPercent = Math.round((result.stoppedHours / 24) * 100);
        result.shutdownPercent = Math.round((result.shutdownHours / 24) * 100);
        
        // Округляем часы до 1 знака после запятой
        result.workingHours = Math.round(result.workingHours * 10) / 10;
        result.stoppedHours = Math.round(result.stoppedHours * 10) / 10;
        result.shutdownHours = Math.round(result.shutdownHours * 10) / 10;
        
        return result;
    }

    // Определение статуса из SystemState
    function determineStatusFromSystemState(value) {
        if (value === 2 || value === 4) {
            return 'working';
        } else if (value === 1 || value === 3) {
            return 'stopped';
        } else if (value === 0) {
            return 'shutdown';
        }
        return 'shutdown'; // По умолчанию
    }

    // Первоначальная загрузка
    startAutoRefresh();

    document.getElementById('workshopFilter').addEventListener('change', applyFilters);
    document.getElementById('machineFilter').addEventListener('change', applyFilters);

    document.querySelectorAll('.filter-btn[data-status]').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('.filter-btn[data-status]').forEach(b => 
                b.classList.remove('active'));
            this.classList.add('active');
            applyFilters();
        });
    });

    document.querySelectorAll('.filter-btn[data-sort]').forEach(btn => {
        btn.addEventListener('click', function() {
            console.log('Сортировка по:', this.dataset.sort);
        });
    });
});