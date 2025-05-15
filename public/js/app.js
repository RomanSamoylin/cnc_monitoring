class MonitoringClient {
    constructor() {
      this.socket = null;
      this.state = {
        machines: [],
        workshops: {},
        filters: {
          workshop: 'all',
          status: 'all'
        }
      };
      
      this.init();
    }
    
    async init() {
      this.initWebSocket();
      this.loadInitialData();
      this.setupEventListeners();
      this.render();
    }
    
    initWebSocket() {
      this.socket = new WebSocket(`ws://${window.location.host}`);
      
      this.socket.onopen = () => {
        console.log('WebSocket connected');
        this.showNotification('Соединение с сервером установлено', 'success');
      };
      
      this.socket.onmessage = (event) => {
        const data = JSON.parse(event.data);
        switch(data.type) {
          case 'INITIAL_DATA':
            this.handleInitialData(data.data);
            break;
          case 'STATUS_UPDATE':
            this.handleStatusUpdate(data.data);
            break;
        }
      };
      
      this.socket.onclose = () => {
        console.log('WebSocket disconnected');
        this.showNotification('Соединение с сервером потеряно', 'error');
        // Пытаемся переподключиться
        setTimeout(() => this.initWebSocket(), 5000);
      };
    }
    
    async loadInitialData() {
      try {
        const response = await fetch('/api/machines');
        if (!response.ok) throw new Error('Network error');
        
        const data = await response.json();
        if (data.success) {
          this.state.machines = data.machines;
          this.render();
        }
      } catch (error) {
        console.error('Error loading initial data:', error);
        this.showNotification('Ошибка загрузки данных', 'error');
      }
    }
    
    handleInitialData(data) {
      this.state.machines = data;
      this.render();
    }
    
    handleStatusUpdate(updates) {
      updates.forEach(update => {
        const machine = this.state.machines.find(m => m.machine_id === update.machine_id);
        if (machine) {
          machine.status = update.status;
          machine.lastUpdate = new Date().toISOString();
        }
      });
      this.render();
    }
    
    setupEventListeners() {
      // Фильтры
      document.getElementById('workshopFilter').addEventListener('change', (e) => {
        this.state.filters.workshop = e.target.value;
        this.render();
      });
      
      document.getElementById('statusFilter').addEventListener('change', (e) => {
        this.state.filters.status = e.target.value;
        this.render();
      });
      
      // Кнопка обновления
      document.getElementById('refreshBtn').addEventListener('click', () => {
        this.loadInitialData();
      });
    }
    
    render() {
      this.renderSummary();
      this.renderMachines();
    }
    
    renderSummary() {
      const total = this.state.machines.length;
      const working = this.state.machines.filter(m => m.status === 'working').length;
      
      document.getElementById('totalMachines').textContent = total;
      document.getElementById('workingMachines').textContent = working;
    }
    
    renderMachines() {
      const container = document.getElementById('machinesContainer');
      container.innerHTML = '';
      
      const filteredMachines = this.state.machines.filter(machine => {
        const workshopMatch = this.state.filters.workshop === 'all' || 
                             machine.workshop_id === this.state.filters.workshop;
        const statusMatch = this.state.filters.status === 'all' || 
                           machine.status === this.state.filters.status;
        return workshopMatch && statusMatch;
      });
      
      filteredMachines.forEach(machine => {
        const card = document.createElement('div');
        card.className = `machine-card ${machine.status}`;
        card.innerHTML = `
          <h3>${machine.cnc_name}</h3>
          <p>ID: ${machine.machine_id}</p>
          <p>Статус: ${this.getStatusText(machine.status)}</p>
          <p>Обновлено: ${new Date(machine.lastUpdate).toLocaleTimeString()}</p>
        `;
        container.appendChild(card);
      });
    }
    
    getStatusText(status) {
      const statuses = {
        working: 'Работает',
        stopped: 'Остановлен',
        shutdown: 'Выключен',
        unknown: 'Неизвестен'
      };
      return statuses[status] || status;
    }
    
    showNotification(message, type) {
      const notification = document.getElementById('notification');
      notification.textContent = message;
      notification.className = `notification ${type} show`;
      
      setTimeout(() => {
        notification.classList.remove('show');
      }, 3000);
    }
  }
  
  // Инициализация приложения при загрузке страницы
  document.addEventListener('DOMContentLoaded', () => {
    new MonitoringClient();
  });