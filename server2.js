const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const dbConfig = {
  host: '192.168.1.30',
  user: 'monitor',
  password: 'victoria123',
  database: 'cnc_monitoring',
  timezone: '+03:00'
};

function determineStatus(eventType, value, currentStatus) {
  if (eventType === 21) { // MUSP
    return value === 1 ? 'off' : (currentStatus === 'off' ? 'idle' : currentStatus);
  } else if (eventType === 7) { // SystemState
    if (value === 0) return 'off';
    if (value === 1 || value === 3) return 'idle';
    if (value === 2 || value === 4) return 'active';
  }
  return currentStatus || 'off';
}

// Получение списка всех станков
async function getAllMachines(connection) {
  const [machines] = await connection.execute('SELECT machine_id, cnc_name FROM cnc_id_mapping');
  return machines.map(machine => ({
    id: machine.machine_id,
    name: machine.cnc_name,
    workshop: parseInt(machine.machine_id) <= 16 ? '1' : '2'
  }));
}

// Расчет времени в статусах для одного станка
async function calculateMachineStatusTime(connection, machineId, startDate, endDate) {
  // Получаем исторические данные для станка
  const [historyData] = await connection.execute(`
    SELECT 
      event_type,
      value,
      timestamp
    FROM 
      bit8_data
    WHERE 
      machine_id = ?
      AND event_type IN (7, 21)
      AND timestamp BETWEEN ? AND ?
    ORDER BY 
      timestamp ASC
  `, [
    machineId,
    new Date(startDate).toISOString().slice(0, 19).replace('T', ' '),
    new Date(endDate).toISOString().slice(0, 19).replace('T', ' ')
  ]);

  let offTime = 0, idleTime = 0, activeTime = 0;
  let currentStatus = 'off';
  let lastTimestamp = new Date(startDate);

  // Сортируем события по времени
  historyData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  // Обрабатываем каждое событие
  for (const event of historyData) {
    const eventTime = new Date(event.timestamp);
    const timeDiffHours = (eventTime - lastTimestamp) / (1000 * 60 * 60);

    // Добавляем время к текущему статусу
    if (currentStatus === 'off') offTime += timeDiffHours;
    else if (currentStatus === 'idle') idleTime += timeDiffHours;
    else if (currentStatus === 'active') activeTime += timeDiffHours;

    // Обновляем статус
    currentStatus = determineStatus(event.event_type, event.value, currentStatus);
    lastTimestamp = eventTime;
  }

  // Добавляем оставшееся время до endDate
  const finalTimeDiff = (new Date(endDate) - lastTimestamp) / (1000 * 60 * 60);
  if (currentStatus === 'off') offTime += finalTimeDiff;
  else if (currentStatus === 'idle') idleTime += finalTimeDiff;
  else if (currentStatus === 'active') activeTime += finalTimeDiff;

  return { off: offTime, idle: idleTime, active: activeTime };
}

// Endpoint для получения сводных данных по цехам
app.get('/api/workshops/summary', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Необходимо указать startDate и endDate' 
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const allMachines = await getAllMachines(connection);
      const workshop1Data = { off: 0, idle: 0, active: 0 };
      const workshop2Data = { off: 0, idle: 0, active: 0 };

      // Рассчитываем время для каждого станка
      for (const machine of allMachines) {
        const statusTime = await calculateMachineStatusTime(
          connection, 
          machine.id, 
          startDate, 
          endDate
        );

        if (machine.workshop === '1') {
          workshop1Data.off += statusTime.off;
          workshop1Data.idle += statusTime.idle;
          workshop1Data.active += statusTime.active;
        } else {
          workshop2Data.off += statusTime.off;
          workshop2Data.idle += statusTime.idle;
          workshop2Data.active += statusTime.active;
        }
      }

      res.json({
        success: true,
        data: {
          workshop1: workshop1Data,
          workshop2: workshop2Data,
          total: {
            off: workshop1Data.off + workshop2Data.off,
            idle: workshop1Data.idle + workshop2Data.idle,
            active: workshop1Data.active + workshop2Data.active
          }
        }
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching workshop summary:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint для получения сводных данных по конкретному станку
app.get('/api/machines/:id/history/summary', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Необходимо указать startDate и endDate' 
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const statusTime = await calculateMachineStatusTime(connection, id, startDate, endDate);
      
      res.json({
        success: true,
        data: {
          off: statusTime.off,
          idle: statusTime.idle,
          active: statusTime.active,
          machineId: id
        }
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching machine history summary:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint для получения детальных данных по станку (для временной шкалы)
app.get('/api/machines/:id/history/detailed', async (req, res) => {
  try {
    const { id } = req.params;
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json({ 
        success: false, 
        error: 'Необходимо указать startDate и endDate' 
      });
    }

    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const [historyData] = await connection.execute(`
        SELECT 
          event_type,
          value,
          timestamp
        FROM 
          bit8_data
        WHERE 
          machine_id = ?
          AND event_type IN (7, 21)
          AND timestamp BETWEEN ? AND ?
        ORDER BY 
          timestamp ASC
      `, [
        id,
        new Date(startDate).toISOString().slice(0, 19).replace('T', ' '),
        new Date(endDate).toISOString().slice(0, 19).replace('T', ' ')
      ]);

      const timelineData = [];
      let currentStatus = 'off';
      let lastTimestamp = new Date(startDate);

      historyData.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      // Добавляем начальное состояние
      timelineData.push({
        timestamp: lastTimestamp.toISOString(),
        status: currentStatus
      });

      for (const event of historyData) {
        const eventTime = new Date(event.timestamp);
        currentStatus = determineStatus(event.event_type, event.value, currentStatus);
        
        timelineData.push({
          timestamp: eventTime.toISOString(),
          status: currentStatus
        });
        
        lastTimestamp = eventTime;
      }

      // Добавляем конечное состояние
      timelineData.push({
        timestamp: new Date(endDate).toISOString(),
        status: currentStatus
      });

      res.json({
        success: true,
        data: timelineData
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching machine detailed history:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Endpoint для получения списка станков
app.get('/api/machines', async (req, res) => {
  try {
    const connection = await mysql.createConnection(dbConfig);
    
    try {
      const allMachines = await getAllMachines(connection);
      const machinesData = {};
      
      allMachines.forEach(machine => {
        machinesData[machine.id] = {
          name: machine.name,
          workshop: machine.workshop
        };
      });

      res.json({
        success: true,
        machines: machinesData
      });
    } finally {
      await connection.end();
    }
  } catch (error) {
    console.error('Error fetching machines list:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Analytics server running on port ${PORT}`);
  console.log(`Current server time: ${new Date()}`);
});

module.exports = app;