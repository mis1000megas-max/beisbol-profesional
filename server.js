/* ============================================================
   BÉISBOL PROFESIONAL — Servidor (Node.js puro, sin dependencias)
   Iniciar:  node server.js
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3001;
const DATA_FILE = path.join(__dirname, 'data.json');
const INDEX_FILE = path.join(__dirname, 'index.html');

/* ---------- cuentas: Turso (libSQL) con respaldo a archivo local ---------- */
const TURSO_URL = process.env.TURSO_URL || 'libsql://juego-benito-4.aws-us-west-2.turso.io';
const TURSO_TOKEN = process.env.TURSO_TOKEN || '';
let turso = null;
try { if (TURSO_TOKEN) { const { createClient } = require('@libsql/client'); turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN }); } }
catch (e) { console.log('No se cargó @libsql/client (' + e.message + '). Uso archivo local.'); turso = null; }

let DB = { users: {} };
try { if (fs.existsSync(DATA_FILE)) DB = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { DB = { users: {} }; }
function saveDB() { try { const t = DATA_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(DB, null, 2)); fs.renameSync(t, DATA_FILE); } catch (e) {} }

async function storeInit() {
  if (!turso) { console.log('Base de datos: archivo local data.json'); return; }
  try {
    await turso.execute('CREATE TABLE IF NOT EXISTS users (user TEXT PRIMARY KEY, name TEXT, salt TEXT, passHash TEXT, careerWins INTEGER DEFAULT 0, plays INTEGER DEFAULT 0, bestRuns INTEGER DEFAULT 0, updated INTEGER)');
    console.log('Base de datos: Turso conectado ✅');
  } catch (e) { console.log('Error conectando a Turso (' + e.message + '). Uso archivo local.'); turso = null; }
}
function rowToRec(r) { return { user: r.user, name: r.name, salt: r.salt, passHash: r.passHash, careerWins: Number(r.careerWins || 0), plays: Number(r.plays || 0), bestRuns: Number(r.bestRuns || 0), updated: Number(r.updated || 0) }; }
async function storeGet(u) { if (turso) { const r = await turso.execute({ sql: 'SELECT * FROM users WHERE user=?', args: [u] }); return r.rows[0] ? rowToRec(r.rows[0]) : null; } return DB.users[u] || null; }
async function storeCreate(rec) { if (turso) { await turso.execute({ sql: 'INSERT INTO users(user,name,salt,passHash,careerWins,plays,bestRuns,updated) VALUES(?,?,?,?,?,?,?,?)', args: [rec.user, rec.name, rec.salt, rec.passHash, 0, 0, 0, rec.updated] }); return; } DB.users[rec.user] = rec; saveDB(); }
async function storeUpdate(rec) { if (turso) { await turso.execute({ sql: 'UPDATE users SET name=?,careerWins=?,plays=?,bestRuns=?,updated=? WHERE user=?', args: [rec.name, rec.careerWins || 0, rec.plays || 0, rec.bestRuns || 0, rec.updated, rec.user] }); return; } DB.users[rec.user] = rec; saveDB(); }
async function storeAll() { if (turso) { const r = await turso.execute('SELECT user,name,careerWins,plays,bestRuns FROM users'); return r.rows.map(rowToRec); } return Object.values(DB.users); }

const tokens = new Map();
function newToken(u) { const t = crypto.randomBytes(16).toString('hex'); tokens.set(t, u); return t; }
function userFromToken(t) { return t && tokens.get(t); }
function makeSalt() { return crypto.randomBytes(8).toString('hex'); }
function hashPass(p, s) { return crypto.createHash('sha256').update(s + p).digest('hex'); }
function publicProfile(r) { return { user: r.user, name: r.name, careerWins: r.careerWins || 0, plays: r.plays || 0, bestRuns: r.bestRuns || 0 }; }

/* ---------- utilidades HTTP ---------- */
function sendJSON(res, code, obj) { const b = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); res.end(b); }
function readBody(req) { return new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); }); }

/* ---------- moderación ---------- */
const BAD_WORDS = ['mierda','idiota','estupido','imbecil','pendejo','cabron','maldito','puto','puta','culo','cono','carajo','marica','baboso','estupida'];
function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
function profane(t) { const n = norm(t); return BAD_WORDS.some(w => new RegExp('(^|[^a-z])' + w + '([^a-z]|$)').test(n)); }

/* ---------- salas de equipos ---------- */
const rooms = {};
function roomCode() { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)]; return rooms[c] ? roomCode() : c; }
const BOT_POOL = [['Robo-Bate','🤖'],['Chispa','⚡'],['Tornillo','🔩'],['Rayo-Bot','🦾'],['Tuerca','⚙️'],['Pixel','👾'],['Circuito','🔋'],['Antena','📡']];

function teamLists(room) { const t = [[], []]; room.players.forEach(p => { if (p.team === 0 || p.team === 1) t[p.team].push(p.id); }); return t; }

function startTeamGame(room) {
  // equilibrar equipos con bots (cada equipo igual, mínimo 1, máximo 4)
  let t = teamLists(room);
  let target = Math.min(4, Math.max(1, t[0].length, t[1].length));
  let botN = 0;
  for (let team = 0; team < 2; team++) {
    while (teamLists(room)[team].length < target) {
      const b = BOT_POOL[botN % BOT_POOL.length]; botN++;
      room.players.push({ id: 'b' + (botN), name: b[0], pelotero: b[1], team, isBot: true, warns: 0, banned: false });
    }
  }
  t = teamLists(room);
  room.game = { inning: 1, batTeam: 0, outs: 0, bases: [false, false, false], scores: [0, 0],
    teams: t, idx: [0, 0], pitch: Math.floor(Math.random() * 3), swing: null,
    lastResult: '¡Play ball!', log: [], over: false, winner: null, currentBatterId: t[0][0] };
  room.started = true;
  autoPlay(room);
}
function advanceBases(g, adv) { let runs = 0; const nb = [false, false, false];
  for (let b = 2; b >= 0; b--) { if (g.bases[b]) { const np = b + adv; if (np >= 3) runs++; else nb[np] = true; } }
  const bp = adv - 1; if (bp >= 3) runs++; else nb[bp] = true; g.bases = nb; g.scores[g.batTeam] += runs; return runs; }
function resolveTeam(g) { const diff = Math.abs(g.pitch - g.swing); let res;
  if (diff === 0) { const r = Math.random(); let hit, name;
    if (r < 0.58) { hit = 1; name = '¡Sencillo! 🟢'; } else if (r < 0.83) { hit = 2; name = '¡Doble! 🔵'; } else if (r < 0.94) { hit = 3; name = '¡Triple! 🟣'; } else { hit = 4; name = '¡JONRÓN! 💥'; }
    const runs = advanceBases(g, hit); res = name + (runs ? ` (+${runs})` : ''); }
  else if (diff === 1) { g.outs++; res = '¡Elevado, out! 🧤'; }
  else { g.outs++; res = '¡Ponche! ⚾'; }
  g.lastResult = res; g.log.unshift(res); if (g.log.length > 8) g.log.pop(); }
function advanceTeam(g) {
  if (g.outs >= 3) { g.outs = 0; g.bases = [false, false, false];
    if (g.batTeam === 1) {
      if (g.inning >= 3 && g.scores[0] !== g.scores[1]) { g.over = true; g.winner = g.scores[0] > g.scores[1] ? 0 : 1; return; }
      if (g.inning >= 9) { g.over = true; g.winner = g.scores[0] > g.scores[1] ? 0 : (g.scores[1] > g.scores[0] ? 1 : -1); return; }
      g.inning++;
    }
    g.batTeam = 1 - g.batTeam;
  } else { g.idx[g.batTeam]++; }
  const team = g.teams[g.batTeam];
  g.currentBatterId = team[g.idx[g.batTeam] % team.length];
  g.pitch = Math.floor(Math.random() * 3); g.swing = null;
}
function autoPlay(room) { const g = room.game; let safety = 0;
  while (!g.over && safety++ < 300) {
    const cur = room.players.find(p => p.id === g.currentBatterId);
    if (!cur || !cur.isBot) break;
    g.swing = Math.floor(Math.random() * 3); resolveTeam(g); advanceTeam(g);
  }
}
function roomPublic(room) { const g = room.game;
  return { code: room.code, started: room.started, version: room.version,
    players: room.players.map(p => ({ id: p.id, name: p.name, pelotero: p.pelotero, team: p.team, isBot: p.isBot, banned: p.banned })),
    messages: room.messages || [],
    game: g ? { inning: g.inning, batTeam: g.batTeam, outs: g.outs, bases: g.bases, scores: g.scores,
      currentBatterId: g.currentBatterId, over: g.over, winner: g.winner, lastResult: g.lastResult, log: g.log } : null };
}
setInterval(() => { const now = Date.now(); for (const c in rooms) if (now - rooms[c].touched > 30 * 60 * 1000) delete rooms[c]; }, 5 * 60 * 1000);

/* ---------- API ---------- */
async function handleAPI(req, res, url) {
  const route = url.pathname;

  // cuentas
  if (req.method === 'POST' && route === '/api/register') {
    const b = await readBody(req); let u = (b.user || '').trim().toLowerCase(); const p = b.pass || '', name = (b.name || '').trim();
    if (!u || !p) return sendJSON(res, 400, { err: 'Escribe usuario y contraseña.' });
    if (u.length < 3) return sendJSON(res, 400, { err: 'El usuario debe tener 3+ letras.' });
    if (await storeGet(u)) return sendJSON(res, 400, { err: 'Ese usuario ya existe.' });
    const salt = makeSalt(); const rec = { user: u, name: name || u, salt, passHash: hashPass(p, salt), careerWins: 0, plays: 0, bestRuns: 0, updated: Date.now() };
    await storeCreate(rec);
    return sendJSON(res, 200, { ok: publicProfile(rec), token: newToken(u) });
  }
  if (req.method === 'POST' && route === '/api/login') {
    const b = await readBody(req); const u = (b.user || '').trim().toLowerCase(), p = b.pass || ''; const rec = await storeGet(u);
    if (!rec) return sendJSON(res, 400, { err: 'Usuario no encontrado.' });
    if (rec.passHash !== hashPass(p, rec.salt)) return sendJSON(res, 400, { err: 'Contraseña incorrecta.' });
    return sendJSON(res, 200, { ok: publicProfile(rec), token: newToken(u) });
  }
  if (req.method === 'GET' && route === '/api/me') {
    const u = userFromToken(url.searchParams.get('token')); const rec = u && await storeGet(u);
    if (!rec) return sendJSON(res, 401, { err: 'Sesión no válida.' });
    return sendJSON(res, 200, { ok: publicProfile(rec) });
  }
  if (req.method === 'POST' && route === '/api/careerwin') {
    const b = await readBody(req); const u = userFromToken(b.token); const rec = u && await storeGet(u);
    if (!rec) return sendJSON(res, 401, { err: 'Sesión no válida.' });
    rec.careerWins = (rec.careerWins || 0) + 1; rec.plays = (rec.plays || 0) + 1;
    if (typeof b.runs === 'number') rec.bestRuns = Math.max(rec.bestRuns || 0, b.runs); rec.updated = Date.now();
    await storeUpdate(rec);
    return sendJSON(res, 200, { ok: publicProfile(rec) });
  }
  if (req.method === 'GET' && route === '/api/leaderboard') {
    const all = await storeAll();
    const arr = all.map(publicProfile).sort((a, b) => (b.careerWins || 0) - (a.careerWins || 0)).slice(0, 20);
    return sendJSON(res, 200, { ok: arr });
  }

  // salas
  if (req.method === 'POST' && route === '/api/room/create') {
    const b = await readBody(req); const code = roomCode();
    const host = { id: 'p1', name: (b.name || 'Anfitrión').slice(0, 14), pelotero: b.pelotero || '⚾', team: 0, isBot: false, warns: 0, banned: false };
    rooms[code] = { code, players: [host], started: false, game: null, messages: [], version: 1, touched: Date.now() };
    return sendJSON(res, 200, { ok: { code, playerId: 'p1' } });
  }
  if (req.method === 'POST' && route === '/api/room/join') {
    const b = await readBody(req); const code = (b.code || '').toUpperCase().trim(); const room = rooms[code];
    if (!room) return sendJSON(res, 404, { err: 'No existe esa sala.' });
    if (room.started) return sendJSON(res, 400, { err: 'El partido ya empezó.' });
    if (room.players.length >= 8) return sendJSON(res, 400, { err: 'La sala está llena (8).' });
    const id = 'p' + (room.players.length + 1);
    const team = room.players.filter(p => p.team === 0).length <= room.players.filter(p => p.team === 1).length ? 0 : 1;
    room.players.push({ id, name: (b.name || 'Jugador').slice(0, 14), pelotero: b.pelotero || '⚾', team, isBot: false, warns: 0, banned: false });
    room.version++; room.touched = Date.now();
    return sendJSON(res, 200, { ok: { code, playerId: id } });
  }
  if (req.method === 'POST' && route === '/api/room/start') {
    const b = await readBody(req); const room = rooms[(b.code || '').toUpperCase()];
    if (!room) return sendJSON(res, 404, { err: 'La sala se cerró.' });
    if (b.playerId !== 'p1') return sendJSON(res, 403, { err: 'Solo el anfitrión inicia el juego.' });
    if (!room.started) { startTeamGame(room); room.version++; room.touched = Date.now(); }
    return sendJSON(res, 200, { ok: roomPublic(room) });
  }
  if (req.method === 'GET' && route === '/api/room/state') {
    const code = (url.searchParams.get('code') || '').toUpperCase(); const room = rooms[code];
    if (!room) return sendJSON(res, 404, { err: 'La sala se cerró.' });
    room.touched = Date.now(); return sendJSON(res, 200, { ok: roomPublic(room) });
  }
  if (req.method === 'POST' && route === '/api/room/swing') {
    const b = await readBody(req); const room = rooms[(b.code || '').toUpperCase()];
    if (!room || !room.game) return sendJSON(res, 404, { err: 'La sala se cerró.' });
    const g = room.game, pid = b.playerId, zone = parseInt(b.zone, 10);
    const me = room.players.find(p => p.id === pid);
    if (me && me.banned) return sendJSON(res, 403, { err: 'Fuiste expulsado de la sala.' });
    if (g.over) return sendJSON(res, 400, { err: 'El partido terminó.' });
    if (!(zone >= 0 && zone <= 2)) return sendJSON(res, 400, { err: 'Zona inválida.' });
    if (pid !== g.currentBatterId) return sendJSON(res, 400, { err: 'No es tu turno de batear.' });
    g.swing = zone; resolveTeam(g); advanceTeam(g); autoPlay(room);
    room.version++; room.touched = Date.now();
    return sendJSON(res, 200, { ok: roomPublic(room) });
  }
  if (req.method === 'POST' && route === '/api/room/msg') {
    const b = await readBody(req); const room = rooms[(b.code || '').toUpperCase()];
    if (!room) return sendJSON(res, 404, { err: 'La sala se cerró.' });
    const me = room.players.find(p => p.id === b.playerId);
    if (!me) return sendJSON(res, 400, { err: 'Jugador no válido.' });
    if (me.banned) return sendJSON(res, 403, { err: 'Estás vetado.' });
    const text = (b.text || '').toString().slice(0, 120);
    if (text.trim()) {
      if (profane(text)) { me.warns = (me.warns || 0) + 1;
        if (me.warns >= 3) { me.banned = true; room.messages.push({ from: 'sistema', name: 'Sistema', pelotero: '🚫', text: me.name + ' fue expulsado por groserías.' }); }
        else room.messages.push({ from: 'sistema', name: 'Sistema', pelotero: '⚠️', text: 'Aviso ' + me.warns + '/3 a ' + me.name + ': cuida tu lenguaje.' });
      } else room.messages.push({ from: me.id, name: me.name, pelotero: me.pelotero, text });
      if (room.messages.length > 14) room.messages.shift();
      room.version++; room.touched = Date.now();
    }
    return sendJSON(res, 200, { ok: roomPublic(room) });
  }
  if (req.method === 'POST' && route === '/api/room/kick') {
    const b = await readBody(req); const room = rooms[(b.code || '').toUpperCase()];
    if (!room) return sendJSON(res, 404, { err: 'La sala se cerró.' });
    if (b.playerId !== 'p1') return sendJSON(res, 403, { err: 'Solo el admin puede expulsar.' });
    const tgt = room.players.find(p => p.id === b.target);
    if (tgt && !tgt.isBot && tgt.id !== 'p1') { tgt.banned = true; room.messages.push({ from: 'sistema', name: 'Sistema', pelotero: '🚫', text: tgt.name + ' fue expulsado por el admin.' }); room.version++; room.touched = Date.now(); }
    return sendJSON(res, 200, { ok: roomPublic(room) });
  }
  if (req.method === 'POST' && route === '/api/room/leave') {
    const b = await readBody(req); const room = rooms[(b.code || '').toUpperCase()];
    if (room && !room.started) { room.players = room.players.filter(p => p.id !== b.playerId); room.version++; if (!room.players.length) delete rooms[(b.code || '').toUpperCase()]; }
    return sendJSON(res, 200, { ok: true });
  }

  return sendJSON(res, 404, { err: 'Ruta no encontrada.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  if (url.pathname.startsWith('/api/')) return handleAPI(req, res, url);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    fs.readFile(INDEX_FILE, (err, data) => { if (err) { res.writeHead(500); return res.end('Falta index.html junto a server.js'); } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data); });
    return;
  }
  res.writeHead(404); res.end('No encontrado');
});
server.listen(PORT, '0.0.0.0', () => {
  storeInit();
  const ips = []; const ifaces = os.networkInterfaces();
  for (const n in ifaces) for (const i of ifaces[n]) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  console.log('\n=============================================');
  console.log('  BÉISBOL PROFESIONAL — servidor encendido ✅');
  console.log('=============================================');
  console.log('  En esta PC:        http://localhost:' + PORT);
  ips.forEach(ip => console.log('  Otros dispositivos: http://' + ip + ':' + PORT));
  console.log('  (todos en la misma red Wi-Fi)');
  console.log('  Para apagar:        Ctrl + C');
  console.log('=============================================\n');
});
