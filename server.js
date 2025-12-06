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
const MAIN_DIR = "/home/opc";
const PANEL_DIR = path.join(MAIN_DIR, "panels"); // Where sub-panels live
const CONFIG_FILE = './admin-config.json';

// Ensure directories
fs.ensureDirSync(PANEL_DIR);

// Load or Create Admin Config
let adminConfig = { username: "admin", password: "password123" };
if (fs.existsSync(CONFIG_FILE)) {
    adminConfig = fs.readJsonSync(CONFIG_FILE);
} else {
    fs.writeJsonSync(CONFIG_FILE, adminConfig);
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const upload = multer({ dest: 'temp_uploads/' });

app.use(express.json());
app.use(express.static('public'));

// --- AUTH MIDDLEWARE ---
const checkAuth = (req, res, next) => {
    const user = auth(req);
    if (!user || user.name !== adminConfig.username || user.pass !== adminConfig.password) {
        res.set('WWW-Authenticate', 'Basic realm="Orion Master"');
        return res.status(401).send('Access Denied');
    }
    next();
};
app.use(checkAuth);

// ==========================================
// 1. VM MANAGER & TERMINAL
// ==========================================

app.post('/api/vm/power', (req, res) => {
    const { action } = req.body;
    let cmd = "";
    if (action === 'reboot') cmd = "sudo reboot";
    if (action === 'shutdown') cmd = "sudo shutdown now";
    
    if (cmd) {
        exec(cmd, (err) => {
            if (err) return res.status(500).json({ error: "Command failed. Do I have sudo?" });
            res.json({ success: true, message: "Signal sent." });
        });
    } else {
        res.status(400).json({ error: "Invalid action" });
    }
});

app.post('/api/terminal', (req, res) => {
    const { command } = req.body;
    // SECURITY WARNING: This executes root commands
    exec(command, { cwd: MAIN_DIR }, (error, stdout, stderr) => {
        res.json({ output: stdout || stderr || error?.message || "Done." });
    });
});

// ==========================================
// 2. FILE & BOT MANAGER
// ==========================================

app.get('/api/files', async (req, res) => {
    try {
        // Get all PM2 processes to know what is running
        pm2.list((err, list) => {
            const runningPaths = list ? list.map(p => p.pm2_env.pm_cwd) : [];
            
            exec(`du -sh ${MAIN_DIR}/*`, async (err, stdout) => {
                if (err) return res.json([]);
                const lines = stdout.trim().split('\n');
                
                const files = lines.map(line => {
                    const [size, fullPath] = line.split('\t');
                    const name = path.basename(fullPath);
                    const isRunning = runningPaths.some(p => p.includes(name));
                    return { name, size, isRunning };
                }).filter(f => f.name !== 'Panal' && f.name !== 'panels'); // Hide system folders
                
                res.json(files);
            });
        });
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/delete-bot', async (req, res) => {
    const { name } = req.body;
    if(!name || name.includes('..')) return res.status(400).send("Invalid name");

    const targetPath = path.join(MAIN_DIR, name);

    // 1. Stop & Delete from PM2 if running
    pm2.list((err, list) => {
        const proc = list.find(p => p.name === name || p.pm2_env.pm_cwd.includes(name));
        if (proc) {
            pm2.delete(proc.pm_id, () => {});
        }
        
        // 2. Delete Files
        fs.remove(targetPath)
            .then(() => res.json({ success: true }))
            .catch(err => res.status(500).json({ error: err.message }));
    });
});

// ==========================================
// 3. SUB-PANEL CREATOR
// ==========================================

app.get('/api/panels', async (req, res) => {
    try {
        const panels = await fs.readdir(PANEL_DIR);
        const data = [];
        for (const p of panels) {
            const conf = await fs.readJson(path.join(PANEL_DIR, p, 'config.json')).catch(()=>({}));
            data.push({ name: p, port: conf.port, limit: conf.limit });
        }
        res.json(data);
    } catch (e) { res.json([]); }
});

app.post('/api/create-panel', async (req, res) => {
    const { name, password, port, limit } = req.body;
    const newPanelPath = path.join(PANEL_DIR, name);

    if (fs.existsSync(newPanelPath)) return res.status(400).json({ error: "Panel exists" });

    try {
        await fs.ensureDir(newPanelPath);
        await fs.ensureDir(path.join(newPanelPath, 'uploads'));
        
        // 1. Generate Lite Server Script
        const liteServerCode = generateLiteServer(port, name, password, limit);
        await fs.writeFile(path.join(newPanelPath, 'server.js'), liteServerCode);
        
        // 2. Copy Frontend
        await fs.copy(path.join(__dirname, 'public'), path.join(newPanelPath, 'public'));
        
        // 3. Save Config
        await fs.writeJson(path.join(newPanelPath, 'config.json'), { port, password, limit });

        // 4. Start with PM2
        pm2.start({
            script: path.join(newPanelPath, 'server.js'),
            name: `panel-${name}`
        }, (err) => {
            if (err) throw err;
            pm2.save();
            res.json({ success: true, url: `http://${req.hostname}:${port}` });
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
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

// ==========================================
// 4. SETTINGS
// ==========================================
app.post('/api/change-password', async (req, res) => {
    const { newPassword } = req.body;
    adminConfig.password = newPassword;
    await fs.writeJson(CONFIG_FILE, adminConfig);
    res.json({ success: true });
});

// --- HELPER: GENERATE LITE SERVER CODE ---
function generateLiteServer(port, user, pass, limitMB) {
    return `
const express = require('express');
const multer = require('multer');
const AdmZip = require('adm-zip');
const fs = require('fs-extra');
const path = require('path');
const auth = require('basic-auth');
const pm2 = require('pm2');

const APP_DIR = __dirname;
const UPLOAD_DIR = path.join(APP_DIR, 'bots');
const LIMIT_BYTES = ${limitMB} * 1024 * 1024;

fs.ensureDirSync(UPLOAD_DIR);

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

// Check Storage Limit
const checkLimit = async () => {
    const size = await getDirSize(UPLOAD_DIR);
    return size < LIMIT_BYTES;
};

// Simplified API for Users
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!(await checkLimit())) return res.status(400).json({ error: "Storage Limit Reached (${limitMB}MB)" });
    
    const zip = new AdmZip(req.file.path);
    const name = req.body.folderName || 'bot-' + Date.now();
    const target = path.join(UPLOAD_DIR, name);
    
    fs.ensureDirSync(target);
    zip.extractAllTo(target, true);
    fs.removeSync(req.file.path);
    
    res.json({ success: true });
});

app.get('/api/status', (req, res) => {
    // Only show bots belonging to this user context if possible, 
    // or just show all but allow limited control. 
    // For simplicity, this lite panel lists bots in its folder.
    res.json([]); 
});

// Users can only start/stop bots inside their folder
// This requires complex PM2 linking, simplified here:
app.listen(${port}, () => console.log('Sub-panel running on ${port}'));

async function getDirSize(dir) {
    // fast size check logic
    return 0; // Placeholder
}
`;
}

// --- SYSTEM STATS SOCKET ---
io.on('connection', (socket) => {
    setInterval(async () => {
        const mem = await si.mem();
        const cpu = await si.currentLoad();
        socket.emit('sys-stats', {
            ram: (mem.active/1073741824).toFixed(2) + ' / ' + (mem.total/1073741824).toFixed(2) + ' GB',
            cpu: cpu.currentLoad.toFixed(0) + '%'
        });
    }, 2000);
});

server.listen(PORT, () => console.log(`MASTER ORION RUNNING ON ${PORT}`));


