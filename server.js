// server.js — central web-ready bridge + proxy
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import fs from "fs";
import fetch from "node-fetch";
import multer from "multer";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

// config
const PORT = process.env.PORT ? Number(process.env.PORT) : 5000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:8080";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
const VITS_URL = process.env.VITS_URL || "http://127.0.0.1:7000";
const WHISPER_URL = process.env.WHISPER_URL || "http://127.0.0.1:7001";

const RATE_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_MAX = Number(process.env.RATE_LIMIT_MAX || 60);

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: ALLOWED_ORIGIN }));

// basic rate limiting
const limiter = rateLimit({
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

// simple memory store for conversation history (rotate)
const MEMORY_FILE = "./tts_memory.json";
let memory = { conversationHistory: [], userProfile: {} };

try {
    if (fs.existsSync(MEMORY_FILE)) {
        const raw = fs.readFileSync(MEMORY_FILE, "utf8");
        memory = JSON.parse(raw) || memory;
        console.log("🧠 Loaded memory.");
    }
} catch (e) {
    console.warn("Could not load memory file:", e);
}

function saveMemory() {
    try {
        fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
    } catch (e) {
        console.warn("Failed to save memory:", e);
    }
}

function buildPersona() {
    const devName = "Dev";
    return `You are Meseca, a concise energetic assistant trained by ${devName}. Be helpful and safe.`;
}

function buildContext(message) {
    const history = memory.conversationHistory.slice(-20).map(e => `${e.role}: ${e.content}`).join("\n");
    return `${buildPersona()}\n\nChat history:\n${history}\n\nUser: ${message}\nAssistant:`;
}

// health
app.get("/", (_, res) => res.json({ status: "ok", msg: "Meseca server" }));

// chat endpoint -> queries Ollama/LLM
app.post("/api/chat", async (req, res) => {
    try {
        const { message, max_tokens = 512 } = req.body || {};
        if (!message || typeof message !== "string") return res.status(400).json({ error: "Invalid 'message' field" });

        // save user message
        memory.conversationHistory.push({ role: "user", content: message });
        if (memory.conversationHistory.length > 200) memory.conversationHistory.shift();
        saveMemory();

        const prompt = buildContext(message);

        // call Ollama (assumes an endpoint POST /api/generate that accepts {model, prompt})
        const resp = await fetch(`${OLLAMA_URL}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: "llama3", prompt, max_tokens })
        });

        if (!resp.ok) {
            const txt = await resp.text().catch(() => "");
            return res.status(502).json({ error: "LLM backend error", detail: txt });
        }

        const text = (await resp.text()).trim();
        memory.conversationHistory.push({ role: "assistant", content: text });
        saveMemory();

        return res.json({ reply: text });
    } catch (err) {
        console.error("chat error:", err);
        return res.status(500).json({ error: "Internal error", detail: String(err) });
    }
});

// TTS proxy — receives { text } and forwards to VITS, returns audio blob
app.post("/api/tts", async (req, res) => {
    try {
        const { text } = req.body || {};
        if (!text || typeof text !== "string") return res.status(400).json({ error: "Missing 'text' field" });

        const vResp = await fetch(`${VITS_URL}/tts`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text })
        });

        if (!vResp.ok) {
            const errText = await vResp.text().catch(() => "");
            return res.status(502).json({ error: "TTS backend error", detail: errText });
        }

        // stream audio back to client
        res.setHeader("Content-Type", "audio/wav");
        vResp.body.pipe(res);
    } catch (err) {
        console.error("tts proxy error:", err);
        res.status(500).json({ error: "Internal error", detail: String(err) });
    }
});

// Whisper proxy — accepts multipart form "file" from browser
const upload = multer({ dest: path.join(process.cwd(), "uploads/"), limits: { fileSize: 20 * 1024 * 1024 } });
app.post("/api/whisper", upload.single("file"), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "Missing file field 'file'" });

        // Forward the file to the whisper server as multipart/form-data
        const form = new FormData();
        const fileStream = fs.createReadStream(req.file.path);
        form.append("file", fileStream, req.file.originalname);

        const wResp = await fetch(`${WHISPER_URL}/whisper`, { method: "POST", body: form });

        // cleanup local upload
        fs.unlink(req.file.path, () => { });

        if (!wResp.ok) {
            const txt = await wResp.text().catch(() => "");
            return res.status(502).json({ error: "Whisper backend error", detail: txt });
        }

        const data = await wResp.json();
        return res.json(data);
    } catch (err) {
        console.error("whisper proxy error:", err);
        return res.status(500).json({ error: "Internal error", detail: String(err) });
    }
});

// static (optional) — serve index.html when deploying server-side (if you choose)
app.use("/static", express.static(path.join(process.cwd(), "public")));

// start
app.listen(PORT, () => {
    console.log(`✅ Meseca server listening on http://0.0.0.0:${PORT}`);
    console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
});
