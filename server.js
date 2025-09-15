import express from "express";
import path from "path";
import fs from "fs";
import { connect, StringCodec, credsAuthenticator } from "nats";
import multer from "multer";
import { WebSocketServer } from "ws";
import Redis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { fileURLToPath } from "url";
import cors from "cors";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REDIS_HOST = process.env.REDIS_HOST || "127.0.0.1";
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "change_this_jwt_secret";
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 2000);
const PORT = Number(process.env.PORT || 3000);

// Redis clients
const redisMain = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD || undefined });
const redisSub = new Redis({ host: REDIS_HOST, port: REDIS_PORT, password: REDIS_PASSWORD || undefined });

const app = express();
app.use(express.json());
app.use(cors({ origin: "*" }));
app.use(express.static("public"));
// app.use(express.urlencoded({ extended: true }));

// const upload = multer({ dest: "uploads/" });

// NATS connection
let nc = null;
let subscriptions = [];

// JWT helpers
const ACCESS_MAP = (() => { try { return JSON.parse(process.env.ACCESS_MAP || "{}"); } catch { return {}; } })();
const ACCESS_KEYS = (() => { try { return JSON.parse(process.env.ACCESS_KEYS || "{}"); } catch { return {}; } })();

function generateToken(accessKey) { return jwt.sign({ accessKey }, JWT_SECRET, { expiresIn: "2h" }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } }


// ------------------- ROUTES -------------------
// Login
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public/login.html")));
app.post("/login", (req, res) => {
  const { accessKey, secret } = req.body;
  if (!accessKey || !secret) return res.status(400).json({ error: "missing credentials" });
  const expected = ACCESS_KEYS[accessKey];
  if (!expected || expected !== secret) return res.status(401).json({ error: "invalid credentials" });
  const token = generateToken(accessKey);
  res.json({ token, expiresIn: 2 * 60 * 60 });
});

// NATS dashboard
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

// Redis dashboard
app.get("/redispage", (req, res) => res.sendFile(path.join(__dirname, "public/viewer.html")));

// Protected: allowed-keys
app.get("/allowed-keys", (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "missing auth" });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: "invalid token" });
  const allowed = (ACCESS_MAP[payload.accessKey] || "").split(",").map(s => s.trim()).filter(Boolean);
  res.json({ allowed });
});

// Get Redis data
app.get("/get-data", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) return res.status(401).json({ error: "missing auth" });
  const payload = verifyToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: "invalid token" });
  const { pattern } = req.query;
  if (!pattern) return res.status(400).json({ error: "pattern required" });
  try {
    let keys = [], cursor = "0";
    do {
      const r = await redisMain.scan(cursor, "MATCH", pattern, "COUNT", 1000);
      cursor = r[0]; keys.push(...r[1]);
    } while (cursor !== "0");
    const values = keys.length ? await redisMain.mget(keys) : [];
    res.json({ pattern, count: keys.length, data: keys.map((k, i) => ({ key: k, value: values[i] })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ------------------- NATS API -------------------
app.post("/api/nats/connect", async (req, res) => {
  try {
      console.log("Content-Type:", req.headers["content-type"]);

    console.log("request body", req.body);
    const { serverUrl, subjectFilter, credsFile } = req.body;
    if (nc) { await nc.close(); nc = null; subscriptions = []; }
    const options = { servers: serverUrl };
    if (credsFile) options.authenticator = credsAuthenticator(fs.readFileSync(path.join(__dirname, "uploads", credsFile)));
    nc = await connect(options);

    if (subjectFilter) {
      const sub = nc.subscribe(subjectFilter);
      (async () => {
        const sc = StringCodec();
        for await (const msg of sub) {
          console.log(`NATS: ${msg.subject} -> ${sc.decode(msg.data)}`);
          natsClients.forEach(ws => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "nats_message", subject: msg.subject, data: sc.decode(msg.data), timestamp: Date.now() }));
          });
        }
      })();
      subscriptions.push(sub);
    }
    res.json({ success: true, message: "Connected to NATS" });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.post("/api/nats/disconnect", async (req, res) => {
  try { if (nc) { for (const sub of subscriptions) sub.unsubscribe(); await nc.close(); nc = null; subscriptions = []; } res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// JetStream
app.post("/api/jetstream/publish", async (req, res) => {
  if (!nc) return res.status(400).json({ success: false, message: "Not connected to NATS" });
  try { const js = nc.jetstream(); const sc = StringCodec(); await js.publish(req.body.subject, sc.encode(req.body.message)); res.json({ success: true }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});
app.get("/api/jetstream/stream/:stream", async (req, res) => {
  if (!nc) return res.status(400).json({ success: false, message: "Not connected to NATS" });
  try { const js = nc.jetstream(); const info = await js.streams.info(req.params.stream); res.json({ success: true, stream: info }); }
  catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ------------------- WEBSOCKET SERVERS -------------------
const server = app.listen(PORT, () => console.log(`Server running on ${PORT}`));
const natsClients = new Set();
const wssNats = new WebSocketServer({ noServer: true });
const wssRedis = new WebSocketServer({ noServer: true });

// Upgrade
server.on("upgrade", (req, socket, head) => {
  const host = req.headers.host; // e.g., "localhost:3000"
  if (!host) {
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${host}`);
  const token = url.searchParams.get("token");
  const payload = verifyToken(token);
  if (!payload) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }

  if (url.pathname === "/ws/nats") {
    wssNats.handleUpgrade(req, socket, head, ws => {
      ws.user = payload; natsClients.add(ws);
      ws.on("close", () => natsClients.delete(ws));
    });
  } else if (url.pathname === "/ws/redis") {
    wssRedis.handleUpgrade(req, socket, head, ws => {
      ws.user = payload;
      ws.patterns = (ACCESS_MAP[payload.accessKey] || "").split(",").map(s => s.trim()).filter(Boolean);
      redisClients.add(ws);
      ws.send(JSON.stringify({ type: "connected", accessKey: payload.accessKey, patterns: ws.patterns }));

      // initial snapshot
      (async () => {
        try {
          let keys = [];
          for (const p of ws.patterns) {
            let cursor = "0";
            do { const r = await redisMain.scan(cursor, "MATCH", p, "COUNT", 1000); cursor = r[0]; keys.push(...r[1]); } while (cursor !== "0");
          }
          ws.send(JSON.stringify({ type: "initial", keys: Array.from(new Set(keys)).sort() }));
        } catch {}
      })();

      ws.on("message", msg => {
        try {
          const data = JSON.parse(msg.toString());
          if (data?.type === "subscribe" && Array.isArray(data.patterns)) ws.patterns = data.patterns.map(s => s.trim()).filter(Boolean);
        } catch {}
      });

      ws.on("close", () => redisClients.delete(ws));
    });
  } else {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy();
  }
});

// ------------------- REDIS LIVE -------------------
const redisClients = new Set();

(async function setupRedisListener() {
  try {
    const conf = await redisMain.config("GET", "notify-keyspace-events");
    if (conf?.[1]) {
      await redisSub.psubscribe("__keyspace@0__:*");
      redisSub.on("pmessage", async (_pat, channel, event) => {
        const key = channel.split(":").slice(1).join(":");
        const value = await redisMain.get(key);
        for (const ws of redisClients) {
          if ((ws.patterns || []).some(p => matchPattern(key, p)) && ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: "update", key, event, value }));
        }
      });
      console.log("Redis keyspace notifications enabled"); return;
    }
  } catch { console.warn("Redis notify failed"); }

  // polling fallback
  const lastValues = new Map();
  setInterval(async () => {
    try {
      const patterns = new Set();
      for (const ws of redisClients) (ws.patterns || []).forEach(p => patterns.add(p));
      if (!patterns.size) return;
      for (const p of patterns) {
        let cursor = "0";
        do {
          const r = await redisMain.scan(cursor, "MATCH", p, "COUNT", 1000);
          cursor = r[0];
          for (const key of r[1]) {
            const val = await redisMain.get(key);
            if (lastValues.get(key) !== val) {
              lastValues.set(key, val);
              for (const ws of redisClients)
                if ((ws.patterns || []).some(pp => matchPattern(key, pp)) && ws.readyState === WebSocket.OPEN)
                  ws.send(JSON.stringify({ type: "update", key, event: "poll", value: val }));
            }
          }
        } while (cursor !== "0");
      }
    } catch {}
  }, POLL_INTERVAL_MS);
})();

function matchPattern(key, pattern) {
  // Convert Redis-style pattern to RegExp
  const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
  return re.test(key);
}