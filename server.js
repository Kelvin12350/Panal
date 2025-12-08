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

// --- CONFIGURATION ---
const PORT = 8080;
const USERNAME = "admin";
const PASSWORD = "password123"; 
const MAIN_DIR = "/home/opc";
const PANEL_DIR = path.join(MAIN_DIR, "panels");

// Ensure directories
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
// 1. DASHBOARD & BOT STATUS
// ==========================================
app.get('/api/status', (req, res) => {
    pm2.list((err, list) => {
        if (err) return res.status(500).json([]);
        const bots = list.map(proc => ({
            name: proc.name,
            id: proc.pm_id,
            status: proc.pm2_env.status,
            memory: (proc.monit.memory / 1024 / 1024).toFixed(1) + ' MB'
        }));
        res.json(bots);
    });
});

app.post('/api/action', (req, res) => {
    const { name, action } = req.body;
    if (!['start', 'stop', 'restart', 'delete'].includes(action)) return res.status(400).json({ error: "Invalid Action" });
    pm2[action](name, (err) => res.json({ success: !err }));
});

// ==========================================
// 2. FILE MANAGER & UPLOAD (The Missing Part)
// ==========================================

// --- DEPLOY (Upload Zip -> Unzip -> Delete Zip) ---
app.post('/api/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });
        if (!req.body.folderName) return res.status(400).json({ error: "No folder name" });

        const zip = new AdmZip(req.file.path);
        const targetPath = path.join(MAIN_DIR, req.body.folderName);

        // Create folder and unzip
        await fs.ensureDir(targetPath);
        zip.extractAllTo(targetPath, true);
        
        // Delete the temp zip file
        await fs.remove(req.file.path);

        res.json({ success: true, message: "Deployed Successfully" });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// --- LIST FILES ---
app.get('/api/files', (req, res) => {
    // Check folder sizes
    exec(`du -sh ${MAIN_DIR}/*`, (err, stdout) => {
        if (err) return res.json([]);
        const lines = stdout.trim().split('\n');
        const files = lines.map(line => {
            const [size, fullPath] = line.split('\t');
            return { 
                name: path.basename(fullPath), 
                size: size,
                // Check if autodelete is on (simple check for now)
                autoDelete: fs.existsSync(path.join(fullPath, '.autodelete'))
            };
        }).filter(f => f.name !== 'Panal' && f.name !== 'panels');
        res.json(files);
    });
});

// --- DELETE BOT ---
app.post('/api/delete-bot', (req, res) => {
    const { name } = req.body;
    if(name === 'Panal') return res.status(403).json({ error: "Cannot delete panel" });
    const target = path.join(MAIN_DIR, name);

    pm2.delete(name, () => {
        fs.remove(target)
            .then(() => {
                pm2.save();
                res.json({ success: true });
            })
            .catch(e => res.status(500).json({ error: e.message }));
    });
});

// --- CLEAR FILES ---
app.post('/api/clear-bot', (req, res) => {
    const { name } = req.body;
    const target = path.join(MAIN_DIR, name);
    fs.emptyDir(target)
        .then(() => res.json({ success: true }))
        .catch(e => res.status(500).json({ error: e.message }));
});

// ==========================================
// 3. VM MANAGER & TERMINAL
// ==========================================
app.post('/api/vm/power', (req, res) => {
    const { action } = req.body;
    let cmd = action === 'reboot' ? "sudo reboot" : "sudo shutdown now";
    exec(cmd, (err) => {
        res.json({ success: true, message: "Signal Sent" });
    });
});

app.post('/api/terminal', (req, res) => {
    exec(req.body.command, { cwd: MAIN_DIR }, (error, stdout, stderr) => {
        res.json({ output: stdout || stderr || error?.message || "Done" });
    });
});

// ==========================================
// 4. SUB-PANELS
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
    } catch(e) { res.json([]); }
});

app.post('/api/create-panel', async (req, res) => {
    const { name, password, port, limit } = req.body;
    const newPath = path.join(PANEL_DIR, name);
    if(fs.existsSync(newPath)) return res.status(400).json({ error: "Exists" });

    try {
        await fs.ensureDir(newPath);
        await fs.ensureDir(path.join(newPath, 'public'));
        await fs.writeJson(path.join(newPath, 'config.json'), { port, password, limit });
        
        // Generate Lite Server
        const liteCode = `
const express = require('express');
const auth = require('basic-auth');
const app = express();
app.use(express.static('public'));
app.use((req, res, next) => {
    const u = auth(req);
    if(!u || u.name !== '${name}' || u.pass !== '${password}') {
        res.set('WWW-Authenticate', 'Basic realm="User Panel"');
        return res.status(401).send('Access Denied');
    }
    next();
});
app.listen(${port}, () => console.log('Panel ${port}'));
`;
        await fs.writeFile(path.join(newPath, 'server.js'), liteCode);
        await fs.copy(path.join(__dirname, 'public/index.html'), path.join(newPath, 'public/index.html'));

        pm2.start({ script: path.join(newPath, 'server.js'), name: `panel-${name}` }, (err) => {
            pm2.save();
            res.json({ success: true, url: `http://${req.hostname}:${port}` });
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/delete-panel', async (req, res) => {
    const { name } = req.body;
    pm2.delete(`panel-${name}`, () => {
        fs.remove(path.join(PANEL_DIR, name)).then(() => {
            pm2.save();
            res.json({ success: true });
        });
    });
});

// ==========================================
// 5. REAL-TIME SOCKETS
// ==========================================
io.on('connection', (socket) => {
    const interval = setInterval(async () => {
        const mem = await si.mem();
        const cpu = await si.currentLoad();
        socket.emit('sys-stats', {
            ram: (mem.active/1073741824).toFixed(2) + ' / ' + (mem.total/1073741824).toFixed(2) + ' GB',
            cpu: cpu.currentLoad.toFixed(0) + '%'
        });
    }, 2000);

    pm2.launchBus((err, bus) => {
        bus.on('log:out', (p) => socket.emit('log', { type: 'out', data: p.data, app: p.process.name }));
        bus.on('log:err', (p) => socket.emit('log', { type: 'err', data: p.data, app: p.process.name }));
    });

    socket.on('disconnect', () => clearInterval(interval));
});

server.listen(PORT, () => console.log(`🚀 Master Panel on ${PORT}`));


