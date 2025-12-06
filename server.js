const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const pm2 = require('pm2');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const auth = require('basic-auth');
const si = require('systeminformation');

// --- CONFIGURATION ---
const PORT = 8080; // Panel runs on port 8080
const USERNAME = "admin";
const PASSWORD = "password123"; // CHANGE THIS!
const BOT_DIR = "/home/opc";    // Where bots live

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const upload = multer({ dest: 'uploads/' });

// --- SECURITY: BASIC AUTH ---
app.use((req, res, next) => {
    const user = auth(req);
    if (!user || user.name !== USERNAME || user.pass !== PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="Orion Panel"');
        return res.status(401).send('Access Denied');
    }
    next();
});

app.use(express.static('public'));
app.use(express.json());

// --- 1. PM2 CONTROLS ---
app.get('/api/status', (req, res) => {
    pm2.list((err, list) => {
        if (err) return res.status(500).json({ error: err });
        // Filter only our bots
        const bots = list.map(proc => ({
            name: proc.name,
            id: proc.pm_id,
            status: proc.pm2_env.status,
            memory: (proc.monit.memory / 1024 / 1024).toFixed(1) + ' MB',
            cpu: proc.monit.cpu + ' %',
            uptime: (Date.now() - proc.pm2_env.pm_uptime) / 1000
        }));
        res.json(bots);
    });
});

app.post('/api/action', (req, res) => {
    const { name, action } = req.body;
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) return res.status(400).send("Invalid action");

    pm2[action](name, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// --- 2. FILE MANAGER (Upload & Unzip) ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).send('No file uploaded.');
        
        const zip = new AdmZip(req.file.path);
        const targetFolder = path.join(BOT_DIR, req.body.folderName || 'new-bot');
        
        // Ensure folder exists
        await fs.ensureDir(targetFolder);
        
        // Extract
        zip.extractAllTo(targetFolder, true);
        
        // Clean up zip
        await fs.remove(req.file.path);
        
        res.json({ success: true, message: `Deployed to ${targetFolder}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files', async (req, res) => {
    try {
        const files = await fs.readdir(BOT_DIR);
        // Filter to only show folders (potential bots)
        const dirs = [];
        for (const f of files) {
            const stat = await fs.stat(path.join(BOT_DIR, f));
            if (stat.isDirectory() && !f.startsWith('.')) dirs.push(f);
        }
        res.json(dirs);
    } catch (e) {
        res.json([]);
    }
});

// --- 3. SETTINGS (.env Editor) ---
app.post('/api/save-env', async (req, res) => {
    const { folder, content } = req.body;
    const envPath = path.join(BOT_DIR, folder, '.env');
    try {
        await fs.writeFile(envPath, content);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- REAL-TIME SOCKETS ---
io.on('connection', (socket) => {
    // Stream System Stats
    const statInterval = setInterval(async () => {
        const mem = await si.mem();
        const cpu = await si.currentLoad();
        socket.emit('sys-stats', {
            ramUsed: (mem.active / 1024 / 1024 / 1024).toFixed(2),
            ramTotal: (mem.total / 1024 / 1024 / 1024).toFixed(2),
            cpu: cpu.currentLoad.toFixed(1)
        });
    }, 2000);

    // Stream PM2 Logs
    pm2.launchBus((err, bus) => {
        bus.on('log:out', (packet) => socket.emit('log', { type: 'out', data: packet.data, app: packet.process.name }));
        bus.on('log:err', (packet) => socket.emit('log', { type: 'err', data: packet.data, app: packet.process.name }));
    });

    socket.on('disconnect', () => clearInterval(statInterval));
});

server.listen(PORT, () => console.log(`🚀 ORION Panel running on port ${PORT}`));


