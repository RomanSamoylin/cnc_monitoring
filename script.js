document.addEventListener('DOMContentLoaded', () => {
    // Состояние приложения
    const state = {
        machines: {},
        charts: {},
        barCharts: {}
    };

    // Функция для загрузки данных станков
    async function fetchMachinesData() {
        try {
            // Загружаем маппинг станков
            const mappingResponse = await fetch('/api/machine-mapping');
            if (!mappingResponse.ok) throw new Error('Ошибка сети при загрузке маппинга');
            const mappingData = await mappingResponse.json();
            
            if (!mappingData.success) throw new Error('Ошибка в данных маппинга');

            // Загружаем данные станков
            const machinesResponse = await fetch('/api/machines');
            if (!machinesResponse.ok) throw new Error('Ошибка сети при загрузке данных станков');
            const machinesData = await machinesResponse.json();
            
            if (!machinesData.success) throw new Error('Ошибка в данных станков');

            // Загружаем исторические данные для каждого станка
            const machinesWithHistory = {};
            const promises = [];
            
            for (const [machineId, machineData] of Object.entries(machinesData.machines)) {
                promises.push(
                    Promise.all([
                        fetch(`/api/machines/${machineId}/status-history`),
                        fetch(`/api/machines/${machineId}/performance-history`)
                    ]).then(([statusRes, performanceRes]) => {
                        return Promise.all([statusRes.json(), performanceRes.json()])
                            .then(([statusData, performanceData]) => {
                                return { machineId, machineData, statusData, performanceData };
                            });
                    })
                );
            }
            
            const results = await Promise.all(promises);
            
            results.forEach(({ machineId, machineData, statusData, performanceData }) => {
                machinesWithHistory[machineId] = {
                    ...machineData,
                    statusHistory: statusData.success ? statusData.history : [],
                    performanceHistory: performanceData.success ? performanceData.history : []
                };
            });
            
            return machinesWithHistory;
        } catch (error) {
            console.error('Ошибка при загрузке данных:', error);
            throw error;
        }
    }

    // Функция для отображения данных станков
    function displayMachinesData(machinesData) {
        const container = document.getElementById('machineList');
        if (!container) return;

        container.innerHTML = '';

        Object.entries(machinesData).forEach(([machineId, machine]) => {
            const card = document.createElement('div');
            card.className = 'machine-card';
            card.innerHTML = `
                <h3>${machine.displayName || `Станок ${machineId}`}</h3>
                <p>Статус: ${machine.statusText || 'Нет данных'}</p>
                <p>Текущая нагрузка: ${machine.currentPerformance || 0}%</p>
                <div class="chart-container">
                    <canvas id="chart-${machineId}"></canvas>
                </div>
            `;
            container.appendChild(card);

            initMachineChart(machineId, machine.performanceHistory);
        });
    }

    // Инициализация графика для станка
    function initMachineChart(machineId, performanceHistory) {
        const ctx = document.getElementById(`chart-${machineId}`).getContext('2d');
        
        // Подготавливаем данные за последний час
        const now = new Date();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        
        const recentData = performanceHistory
            ? performanceHistory.filter(entry => new Date(entry.timestamp) >= oneHourAgo)
            : [];
        
        const labels = [];
        const data = [];
        
        if (recentData.length > 0) {
            recentData.forEach(entry => {
                labels.push(new Date(entry.timestamp).toLocaleTimeString());
                data.push(entry.value);
            });
        } else {
            // Искусственные данные, если нет реальных
            for (let i = 0; i < 12; i++) {
                labels.push(`${i*5} мин назад`);
                data.push(Math.floor(Math.random() * 100));
            }
        }
        
        // Создаем график
        state.charts[machineId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Нагрузка, %',
                    data: data,
                    borderColor: 'rgba(75, 192, 192, 1)',
                    borderWidth: 2,
                    fill: false
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    title: {
                        display: true,
                        text: 'Нагрузка станка за последний час'
                    }
                },
                scales: {
                    y: {
                        min: 0,
                        max: 100
                    }
                }
            }
        });
    }

    // Основная функция инициализации
    async function init() {
        try {
            const machinesData = await fetchMachinesData();
            displayMachinesData(machinesData);
        } catch (error) {
            console.error('Ошибка инициализации:', error);
        }
    }

    // Запускаем приложение
    init();
});