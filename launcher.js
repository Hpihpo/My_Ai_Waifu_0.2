// launcher.js - smart launcher to start local processes (dev convenience)
import express from "express";
import cors from "cors";
import { spawn, exec } from "child_process";
import path from "path";
import http from "http";
import os from "os";

const app = express();
app.use(cors());
app.use(express.static(process.cwd()));

function isPortBusy(port) {
    return new Promise(resolve => {
        const server = http.createServer().listen(port, () => {
            server.close(() => resolve(false));
        }).on("error", () => resolve(true));
    });
}

function killPort(port) {
    return new Promise((resolve) => {
        if (os.platform() === "win32") {
            exec(`for /f "tokens=5" %a in ('netstat -aon ^| find ":${port}" ^| find "LISTENING"') do taskkill /F /PID %a`, () => resolve());
        } else {
            exec(`lsof -ti:${port} | xargs -r kill -9`, () => resolve());
        }
    });
}

function runCommand(name, command, args = []) {
    const proc = spawn(command, args, { shell: true, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    console.log(`🚀 Starting ${name} — PID ${proc.pid}`);
    proc.stdout.on("data", d => process.stdout.write(`[${name}] ${d}`));
    proc.stderr.on("data", d => process.stderr.write(`[${name} ERROR] ${d}`));
    proc.on("close", code => console.log(`❌ ${name} exited with code ${code}`));
    return proc;
}

async function startAllServers() {
    const services = [
        { name: "Node Server", port: 5000, cmd: "node", args: ["server.js"] },
        { name: "VITS Server", port: 7000, cmd: "python", args: ["vits_server.py"] },
        { name: "Whisper Server", port: 7001, cmd: "python", args: ["whisper_server.py"] }
    ];

    for (const s of services) {
        try {
            const busy = await isPortBusy(s.port);
            if (busy) {
                console.log(`⚠️ ${s.name} port ${s.port} busy — attempting to kill old process`);
                await killPort(s.port);
            }
            runCommand(s.name, s.cmd, s.args);
        } catch (e) {
            console.error(`Failed to start ${s.name}:`, e);
        }
    }
    console.log("✅ Start sequence complete.");
}

const PORT = 3000;
app.get("/start-all", async (_, res) => {
    await startAllServers();
    res.json({ message: "Launch requested" });
});

app.listen(PORT, () => {
    console.log(`🌐 Launcher web UI (static) on http://localhost:${PORT}`);
    startAllServers();
});
