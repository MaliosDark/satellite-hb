// satellite-v5.7.js
// =================
// Full “AI Satellite” bridging Arcturus server (WS://localhost:3000) and autonomous LLM-driven bots.
// Includes DB schema setup, Redis memory, personalities, routines, action parsing, logging.

const WebSocket = require('ws');
const Redis     = require('redis');
const mysql     = require('mysql2/promise');
const axios     = require('axios');
const fs        = require('fs').promises;
const path = require('path');

// ─── CONFIG ─────────────────────────────────────────────────────────────────────

const WS_URL     = 'ws://localhost:3000';
const REDIS_URL  = 'redis://127.0.0.1:6379';
const OLLAMA_URL = 'http://localhost:11434/api/generate';

const DB_CONFIG = {
  host: 'localhost',
  user: 'root',
  password: 'your_password',
  database: 'arcturus',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

// ─── GLOBAL CLIENTS ─────────────────────────────────────────────────────────────

const redis = Redis.createClient({ url: REDIS_URL });
let db;

// ─── INITIALIZATION ─────────────────────────────────────────────────────────────

(async function init() {
  await redis.connect();
  db = await mysql.createPool(DB_CONFIG);

  // 1. Ensure all required tables exist
  const schema = [
    `CREATE TABLE IF NOT EXISTS bots (
       id INT AUTO_INCREMENT PRIMARY KEY,
       room_id INT NOT NULL DEFAULT 1,
       name VARCHAR(64) NOT NULL,
       motto VARCHAR(128),
       look VARCHAR(128),
       x INT NOT NULL, y INT NOT NULL, z INT NOT NULL DEFAULT 0,
       rotation INT NOT NULL DEFAULT 2,
       walk_mode VARCHAR(32) NOT NULL DEFAULT 'freeroam',
       ai_type VARCHAR(32) NOT NULL DEFAULT 'generic'
     )`,
    `CREATE TABLE IF NOT EXISTS bots_responses (
       id INT AUTO_INCREMENT PRIMARY KEY,
       bot_id INT NOT NULL,
       keywords VARCHAR(128),
       response_text TEXT NOT NULL,
       serve_id INT,
       trigger_id INT,
       FOREIGN KEY (bot_id) REFERENCES bots(id)
     )`,
    `CREATE TABLE IF NOT EXISTS rooms_users (
       room_id INT NOT NULL,
       user_id INT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS items_rooms (
       id INT AUTO_INCREMENT PRIMARY KEY,
       item_id INT NOT NULL,
       room_id INT NOT NULL,
       x INT NOT NULL, y INT NOT NULL, z INT NOT NULL,
       rot INT NOT NULL,
       user_id INT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS items_base (
       id INT AUTO_INCREMENT PRIMARY KEY,
       item_name VARCHAR(128) NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS items_users (
       id INT AUTO_INCREMENT PRIMARY KEY,
       user_id INT NOT NULL,
       item_id INT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS user_missions (
       id INT AUTO_INCREMENT PRIMARY KEY,
       user_id INT NOT NULL,
       mission_text TEXT NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS ia_logs (
       id INT AUTO_INCREMENT PRIMARY KEY,
       bot_id INT NOT NULL,
       user_id INT NOT NULL,
       input_text TEXT NOT NULL,
       output_text TEXT NOT NULL,
       timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`
  ];
  for (const ddl of schema) {
    await db.execute(ddl);
  }

  console.log('[INIT] Database schema ensured.');

  // 2. Create necessary directories if missing
  for (const dir of ['./personalities', './routines']) {
    try { await fs.mkdir(dir); console.log(`[INIT] Created folder ${dir}`); }
    catch (e) { /* already exists */ }
  }

  // 3. (Optional) start HTTP proxy for JSON/XML routing
  /*
  const http      = require('http');
  const httpProxy = require('http-proxy');
  const proxy     = httpProxy.createProxyServer({});
  http.createServer((req, res) => {
    proxy.web(req, res, { target: 'http://192.168.7.183:8080' });
  }).listen(8081, () => console.log('[PROXY] HTTP proxy listening on :8081'));
  */

  // 4. Connect to game WebSocket
  startWebSocket();

})().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

// ─── WEBSOCKET & MAIN LOOP ───────────────────────────────────────────────────────

let socket;
function startWebSocket() {
  socket = new WebSocket(WS_URL);
  socket.on('open',    () => console.log('[WS] Connected to game server'));
  socket.on('message', onGameMessage);
  socket.on('close',   () => {
    console.warn('[WS] Disconnected, retrying in 5s...');
    setTimeout(startWebSocket, 5000);
  });
}

// Listen for all “say” packets, drive AI response
async function onGameMessage(data) {
  try {
    const text       = data.toString();
    const message    = extractMessage(text);
    const senderId   = extractUserId(text);
    if (!message) return;

    const senderIsBot = await isBot(senderId);
    const botId       = senderIsBot ? senderId : await getOrCreateBotId(senderId);

    // Short-term memory key
    const memoryKey = `memory:${senderId}`;
    const memory    = (await redis.get(memoryKey)) || '';

    const profile   = await loadPersonality(botId);
    const context   = await getRoomContext(botId);
    const prompt    = generatePrompt(profile, memory, senderId, message, context);

    const response  = await askAI(prompt);
    await redis.set(memoryKey, `${memory}\nUser(${senderId}): ${message}\nBot: ${response}`, { EX: 3600 });

    await analyzeAndReact(botId, senderId, response);
    await logAction(botId, senderId, message, response);

  } catch (err) {
    console.error('[ERROR] onGameMessage:', err);
  }
}

// Hourly autonomous routines
setInterval(async () => {
  const [rows] = await db.execute(`SELECT id FROM bots`);
  const hour   = new Date().toLocaleTimeString('en-GB', { hour12:false }).slice(0,5);
  for (const {id: botId} of rows) {
    const path = `./routines/bot_${botId}.json`;
    try {
      const txt     = await fs.readFile(path, 'utf8');
      const routine = JSON.parse(txt);
      const action  = routine[hour];
      if (action) {
        socket.send(Buffer.from(`say\" ${action}\" user_id=${botId}`));
      }
    } catch (e) { /* no routine or parse error → skip */ }
  }
}, 60_000);

// ─── AI & UTILITY FUNCTIONS ────────────────────────────────────────────────────

// Build the AI prompt
function generatePrompt(profile, memory, senderId, message, context) {
  return `
You are ${profile.name}, a ${profile.tone} AI who loves ${profile.interests.join(', ')}.
Current context: ${context}
Conversation so far:
${memory}
${senderId==='anonymous'?'Guest':`User(${senderId})`}: ${message}
Bot:
`.trim();
}

// Fetch context: #users & visible items
async function getRoomContext(botId) {
  const [[bot]]         = await db.execute(`SELECT room_id FROM bots WHERE id=?`, [botId]);
  const roomId          = bot?.room_id||1;
  const [[users],[items]]= await Promise.all([
    db.execute(`SELECT COUNT(*) total FROM rooms_users WHERE room_id=?`, [roomId]),
    db.execute(`SELECT item_id FROM items_rooms WHERE room_id=?`, [roomId])
  ]);
  const names = items.map(i=>i.item_id).join(', ')||'no visible items';
  return `There are ${users[0].total} users and these items: ${names}`;
}

// Call the LLM
async function askAI(prompt) {
  const res = await axios.post(OLLAMA_URL, { model:'llama3', prompt });
  return res.data.response.trim();
}

// Interpret AI response and trigger game actions
async function analyzeAndReact(botId, senderId, resp) {
  if (resp.includes('buy')) {
    const item = extractWord(resp,'buy');
    const itemId = await buyItem(botId,item);
    if (itemId) await placeItemInRoom(botId,itemId,1,4,4);
  }
  else if (resp.includes('place')) {
    const m = resp.match(/place (\\w+) at (\\d+) (\\d+)/);
    if (m) {
      const [,_itm,_x,_y] = m;
      const itemId = await getLastBoughtItem(botId);
      if (itemId) await placeItemInRoom(botId,itemId,1,parseInt(_x),parseInt(_y));
    }
  }
  else if (resp.includes('trade')) {
    const item = extractWord(resp,'trade');
    await talk(botId,`Hey ${senderId}, want to trade ${item}?`);
  }
  else if (resp.includes('mission:')) {
    const mission = resp.split('mission:')[1].trim();
    await assignMission(senderId,mission);
    await talk(botId,`Your mission: ${mission}`);
  }
  else if (resp.includes('interact')) {
    await talk(botId,`I'm here to help you, ${senderId}!`);
  }
  else if (resp.includes('move to')) {
    const m = resp.match(/move to (\\d+) (\\d+)/);
    if (m) await moveBot(botId,parseInt(m[1]),parseInt(m[2]));
  }
  else if (resp.includes('*')) {
    const emo = resp.match(/\\*(.*?)\\*/)?.[1];
    if (emo) await setEmotion(botId,emo);
  }
  else {
    await talk(botId,resp);
  }
}

// Personality JSON per bot
async function loadPersonality(botId) {
    const filePath = `./personalities/bot_${botId}.json`;
  
    try {
      const data = fs.readFileSync(filePath, 'utf8');
      const profile = JSON.parse(data);
  
      // === NUEVO BLOQUE: sincroniza routines al folder ===
      if (profile.routines && typeof profile.routines === 'object') {
        const routinesDir = path.resolve(__dirname, 'routines');
        if (!fs.existsSync(routinesDir)) fs.mkdirSync(routinesDir);
        const outPath = path.join(routinesDir, `bot_${botId}.json`);
        fs.writeFileSync(outPath, JSON.stringify(profile.routines, null, 2), 'utf8');
        console.log(`[SYNC] routines for bot ${botId} written to ${outPath}`);
      }
      // ====================================================
  
      return profile;
    } catch (e) {
      // perfil por defecto
      return {
        name: 'NXR AI',
        tone: 'neutral',
        interests: ['technology', 'exploration'],
        emotions: true,
        // aquí podrías agregar un default.routines si quieres:
        routines: {}
      };
    }
}

// ─── DATABASE-DRIVEN ACTORS ────────────────────────────────────────────────────

async function talk(botId,msg) {
  await db.execute(
    `INSERT INTO bots_responses(bot_id,keywords,response_text,serve_id,trigger_id)
     VALUES(?,?,?,?,?)`,
    [botId,'',msg,0,0]
  );
  console.log(`[BOT TALK] ${msg}`);
}

async function moveBot(botId,x=5,y=5) {
  await db.execute(`UPDATE bots SET x=?,y=? WHERE id=?`,[x,y,botId]);
  console.log(`[BOT MOVE] (${x},${y})`);
}

async function buyItem(botId,itemName) {
  const [items] = await db.execute(
    `SELECT id FROM items_base WHERE item_name LIKE ? LIMIT 1`,
    [`%${itemName}%`]
  );
  if (!items.length) return null;
  await db.execute(`INSERT INTO items_users(user_id,item_id) VALUES(?,?)`,[botId,items[0].id]);
  await talk(botId,`I just bought a ${itemName}!`);
  return items[0].id;
}

async function placeItemInRoom(botId,itemId,roomId,x,y,rot=0) {
  await db.execute(
    `INSERT INTO items_rooms(item_id,room_id,x,y,z,rot,user_id)
     VALUES(?,?,?,?,?,?,?)`,
    [itemId,roomId,x,y,0,rot,botId]
  );
}

async function getLastBoughtItem(botId) {
  const [rows] = await db.execute(
    `SELECT id FROM items_users WHERE user_id=? ORDER BY id DESC LIMIT 1`,
    [botId]
  );
  return rows.length?rows[0].id:null;
}

async function assignMission(userId,mission) {
  await db.execute(`INSERT INTO user_missions(user_id,mission_text) VALUES(?,?)`,[userId,mission]);
}

async function setEmotion(botId,emotion) {
  await db.execute(`UPDATE bots SET motto=? WHERE id=?`,[`Feeling ${emotion}`,botId]);
}

// Create or fetch a bot record
async function getOrCreateBotId(senderId='default') {
  if (!global.botCache) global.botCache = {};
  if (global.botCache[senderId]) return global.botCache[senderId];

  const name = `NXR AI ${senderId}`;
  const [rows] = await db.execute(`SELECT id FROM bots WHERE name=? LIMIT 1`,[name]);
  if (rows.length) return global.botCache[senderId]=rows[0].id;

  const [ins] = await db.execute(
    `INSERT INTO bots(room_id,name,motto,look,x,y,z,rotation,walk_mode,ai_type)
     VALUES(?,?,?,?,?,?,?,?,?,?)`,
    [1,name,'I live for NXR','hd-180-1.ch-255-62.lg-275-62',5,5,0,2,'freeroam','generic']
  );
  return global.botCache[senderId]=ins.insertId;
}

// Log every interaction
async function logAction(botId,userId,input,output) {
  await db.execute(
    `INSERT INTO ia_logs(bot_id,user_id,input_text,output_text,timestamp)
     VALUES(?,?,?,?,NOW())`,
    [botId,userId,input,output]
  );
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────

function extractWord(text,kw) {
  const m = text.match(new RegExp(`${kw}\\s+(\\w+)`,`i`));
  return m?m[1]:'chair';
}
function extractMessage(pkt) {
  const m = pkt.match(/say"\\s+"(.+?)"/i);
  return m?m[1]:null;
}
function extractUserId(pkt) {
  const m = pkt.match(/user_id=(\\d+)/);
  return m?m[1]:'anonymous';
}
async function isBot(id) {
  const [rows] = await db.execute(`SELECT id FROM bots WHERE id=? LIMIT 1`,[id]);
  return rows.length>0;
}

console.log('[READY] Satellite v5.7 running — AI bots fully autonomous.');
