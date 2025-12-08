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
const { exec } = require('child_process');

// ==========================================
// ⚙️ CONFIGURATION
// ==========================================
const PORT = 8080;
const USERNAME = "admin";
const PASSWORD = "password123"; // CHANGE THIS FOR SECURITY!
const MAIN_DIR = "/home/opc";
const PANEL_DIR = path.join(MAIN_DIR, "panels"); // Sub-panels live here

// Ensure sub-panel directory exists
fs.ensureDirSync(PANEL_DIR);

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const upload = multer({ dest: 'temp_uploads/' });

app.use(express.static('public'));
app.use(express.json());

// --- SECURITY: LOGIN SYSTEM ---
app.use((req, res, next) => {
    const user = auth(req);
    if (!user || user.name !== USERNAME || user.pass !== PASSWORD) {
        res.set('WWW-Authenticate', 'Basic realm="ORION Master"');
        return res.status(401).send('Access Denied');
    }
    next();
});

// ==========================================
// 1. DASHBOARD & PM2 (Bot Manager)
// ==========================================

app.get('/api/status', (req, res) => {
    pm2.list((err, list) => {
        if (err) return res.status(500).json([]);
        
        const bots = list.map(proc => ({
            name: proc.name,
            id: proc.pm_id,
            status: proc.pm2_env.status,
            memory: (proc.monit.memory / 1024 / 1024).toFixed(1) + ' MB',
            cpu: proc.monit.cpu + ' %'
        }));
        res.json(bots);
    });
});

app.post('/api/action', (req, res) => {
    const { name, action } = req.body;
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) return res.status(400).json({ error: "Invalid Action" });

    pm2[action](name, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// ==========================================
// 2. VM MANAGER (Power Controls)
// ==========================================

app.post('/api/vm/power', (req, res) => {
    const { action } = req.body;
    let cmd = "";
    
    if (action === 'reboot') cmd = "sudo reboot";
    if (action === 'shutdown') cmd = "sudo shutdown now";
    
    if (cmd) {
        exec(cmd, (err) => {
            if (err) return res.status(500).json({ error: "Command Failed (Sudo issue?)" });
            res.json({ success: true, message: "Signal Sent to Oracle Cloud." });
        });
    } else {
        res.status(400).json({ error: "Unknown Action" });
    }
});

// ==========================================
// 3. FILE MANAGER & CLEANER
// ==========================================

app.get('/api/files', (req, res) => {
    // Uses Linux 'du' to check folder sizes in /home/opc
    exec(`du -sh ${MAIN_DIR}/*`, (err, stdout) => {
        if (err) return res.json([]);
        
        const lines = stdout.trim().split('\n');
        const files = lines.map(line => {
            const [size, fullPath] = line.split('\t');
            return { 
                name: path.basename(fullPath), 
                size: size,
                // Check if this folder has a running bot
                isRunning: false // Simplified for speed
            };
        }).filter(f => f.name !== 'Panal' && f.name !== 'panels'); 
        
        res.json(files);
    });
});

app.post('/api/delete-bot', (req, res) => {
    const { name } = req.body;
    if (!name || name.includes('..') || name === 'Panal') return res.status(403).json({ error: "Protected" });

    const targetPath = path.join(MAIN_DIR, name);

    // 1. Delete from PM2
    pm2.delete(name, () => {
        // 2. Delete Files
        fs.remove(targetPath)
            .then(() => {
                pm2.save(); // Save the new list
                res.json({ success: true });
            })
            .catch(e => res.status(500).json({ error: e.message }));
    });
});

app.post('/api/clear-bot', (req, res) => {
    const { name } = req.body;
    const targetPath = path.join(MAIN_DIR, name);
    
    // Deletes contents but keeps folder
    fs.emptyDir(targetPath)
        .then(() => res.json({ success: true }))
        .catch(e => res.status(500).json({ error: e.message }));
});

// --- UPLOAD & DEPLOY ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file" });
        
        const zip = new AdmZip(req.file.path);
        const folderName = req.body.folderName || 'new-bot';
        const targetPath = path.join(MAIN_DIR, folderName);

        await fs.ensureDir(targetPath);
        zip.extractAllTo(targetPath, true);
        await fs.remove(req.file.path);

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// 4. TERMINAL (Command Runner)
// ==========================================

app.post('/api/terminal', (req, res) => {
    const { command } = req.body;
    // Executes command in /home/opc
    exec(command, { cwd: MAIN_DIR }, (error, stdout, stderr) => {
        res.json({ 
            output: stdout || stderr || (error ? error.message : "Done.") 
        });
    });
});

// ==========================================
// 5. SETTINGS (Password & Env)
// ==========================================

app.post('/api/save-env', async (req, res) => {
    const { folder, content } = req.body;
    try {
        await fs.writeFile(path.join(MAIN_DIR, folder, '.env'), content);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ==========================================
// 6. PANEL CREATOR (Sub-Panels)
// ==========================================

app.get('/api/panels', async (req, res) => {
    try {
        const panels = await fs.readdir(PANEL_DIR);
        const data = [];
        for (const p of panels) {
            try {
                const conf = await fs.readJson(path.join(PANEL_DIR, p, 'config.json'));
                data.push({ name: p, port: conf.port, limit: conf.limit });
            } catch(e){}
        }
        res.json(data);
    } catch (e) { res.json([]); }
});

app.post('/api/create-panel', async (req, res) => {
    const { name, password, port, limit } = req.body;
    const newPath = path.join(PANEL_DIR, name);

    if (fs.existsSync(newPath)) return res.status(400).json({ error: "Panel Exists" });

    try {
        await fs.ensureDir(newPath);
        await fs.ensureDir(path.join(newPath, 'public'));
        
        // 1. Save Config
        await fs.writeJson(path.join(newPath, 'config.json'), { port, password, limit });

        // 2. Create Lite Server File
        const liteServer = generateLiteServer(port, name, password, limit);
        await fs.writeFile(path.join(newPath, 'server.js'), liteServer);

        // 3. Copy Frontend (Reuse current frontend)
        await fs.copy(path.join(__dirname, 'public/index.html'), path.join(newPath, 'public/index.html'));

        // 4. Start New Panel
        pm2.start({
            script: path.join(newPath, 'server.js'),
            name: `panel-${name}`
        }, (err) => {
            pm2.save();
            res.json({ success: true, url: `http://${req.hostname}:${port}` });
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/delete-panel', async (req, res) => {
    const { name } = req.body;
    pm2.delete(`panel-${name}`, () => {
        fs.remove(path.join(PANEL_DIR, name))
            .then(() => {
                pm2.save();
                res.json({ success: true });
            });
    });
});

// Helper: Generates code for sub-panels
function generateLiteServer(port, user, pass, limit) {
    return `
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const auth = require('basic-auth');
const app = express();
const upload = multer({ dest: 'temp/' });

app.use(express.static('public'));
app.use(express.json());

app.use((req, res, next) => {
    const u = auth(req);
    if (!u || u.name !== '${user}' || u.pass !== '${pass}') {
        res.set('WWW-Authenticate', 'Basic realm="User Panel"');
        return res.status(401).send('Access Denied');
    }
    next();
});

app.listen(${port}, () => console.log('Sub-panel running'));
`;
}

// --- REAL-TIME STATS ---
io.on('connection', (socket) => {
    // Send Stats every 2 seconds
    const interval = setInterval(async () => {
        const mem = await si.mem();
        const cpu = await si.currentLoad();
        socket.emit('sys-stats', {
            ram: (mem.active / 1024 / 1024 / 1024).toFixed(2) + ' / ' + (mem.total / 1024 / 1024 / 1024).toFixed(2) + ' GB',
            cpu: cpu.currentLoad.toFixed(0) + '%'
        });
    }, 2000);

    // Stream PM2 Logs
    pm2.launchBus((err, bus) => {
        bus.on('log:out', (p) => socket.emit('log', { type: 'out', data: p.data, app: p.process.name }));
        bus.on('log:err', (p) => socket.emit('log', { type: 'err', data: p.data, app: p.process.name }));
    });

    socket.on('disconnect', () => clearInterval(interval));
});

server.listen(PORT, () => {
    console.log(`🚀 ORION Master running on PORT ${PORT}`);
});


