document.addEventListener('DOMContentLoaded', () => {
    fetch('/data')
        .then(response => response.json())
        .then(data => {
            // Извлекаем данные для графиков
            const labels = data.map(entry => entry.timestamp); // Временные метки
            const spindeleSpeed = data.map(entry => entry.SPINDELE_SPEED); // Скорость шпинделя
            const feed = data.map(entry => entry.FEED); // Подача

            // Создаем график
            const ctx = document.getElementById('cncChart').getContext('2d');
            new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels, // Временные метки для оси X
                    datasets: [
                        {
                            label: 'Скорость шпинделя (SPINDELE_SPEED)',
                            data: spindeleSpeed,
                            borderColor: 'rgba(75, 192, 192, 1)', // Цвет линии
                            borderWidth: 2,
                            fill: false
                        },
                        {
                            label: 'Подача (FEED)',
                            data: feed,
                            borderColor: 'rgba(153, 102, 255, 1)', // Цвет линии
                            borderWidth: 2,
                            fill: false
                        }
                    ]
                },
                options: {
                    responsive: true,
                    plugins: {
                        title: {
                            display: true,
                            text: 'Мониторинг работы УЧПУ'
                        }
                    },
                    scales: {
                        x: {
                            display: true,
                            title: {
                                display: true,
                                text: 'Время'
                            }
                        },
                        y: {
                            display: true,
                            title: {
                                display: true,
                                text: 'Значение'
                            }
                        }
                    }
                }
            });
        })
        .catch(error => {
            console.error('Ошибка при загрузке данных:', error);
        });
});
