/**
 * Games by Levi - server.
 * A Cloudflare Worker that serves the site from ./public and answers /api/*
 * with accounts, leaderboards and game submissions stored in a D1 database.
 */

const BUILTIN_GAMES = new Set(["snake", "bricks", "pong", "blaster", "flap", "2048", "memory", "runner", "racer", "blocks", "targets", "golf", "pingpong", "void", "muncher", "missile", "storm", "slice", "mines", "slide", "gems", "tunnel", "drift", "hop", "flip", "quest", "hoops", "penalty", "tower", "connect4", "reversi", "beat", "simon", "chess", "guesswho", "slither"]);
const GENRES = new Set(["Arcade", "Action", "Puzzle", "Racing", "Platformer", "Sports", "Strategy", "Other"]);
const USER_RE = /^[A-Za-z0-9 _.\-]{3,16}$/;
const MAX_CODE_BYTES = 200 * 1024;
const MAX_SCORE = 10_000_000;
const MAX_WALL = 1000;
const BUILTIN_COUNT = BUILTIN_GAMES.size;
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // the Workers runtime allows up to 100,000
const COOKIE = "gbl_session";
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

export default {
  async fetch(request, env) {
    await ensureTables(env);
    const url = new URL(request.url);
    if (url.pathname === "/api/slither" || url.pathname === "/api/slither/count") {
      if (!env.ARENA) return json({ error: "The online arena isn't set up." }, 503);
      return env.ARENA.get(env.ARENA.idFromName("main")).fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") return homePage(request, env, url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try {
      return await handle(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e && e.stack ? e.stack : e);
      return json({ error: "Something went wrong on the server. Try again." }, 500);
    }
  },
};

/* The database sets itself up: on first use, create any missing tables. */
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL, avatar_i INTEGER NOT NULL DEFAULT 0, avatar_c INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)",
  "CREATE TABLE IF NOT EXISTS scores (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, game))",
  "CREATE INDEX IF NOT EXISTS scores_by_game ON scores(game, score DESC, at ASC)",
  "CREATE TABLE IF NOT EXISTS submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, creator TEXT NOT NULL, genre TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '', code TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, approved_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS submissions_by_status ON submissions(status, created_at)",
  "CREATE TABLE IF NOT EXISTS settings (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS progress (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL, at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS daily (day TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, score INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (day, user_id))",
  "CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, game TEXT NOT NULL, host_id INTEGER NOT NULL, guest_id INTEGER, moves TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate (key TEXT PRIMARY KEY, count INTEGER NOT NULL, since INTEGER NOT NULL)",
];
let tablesReady = null;
function ensureTables(env) {
  if (!tablesReady) tablesReady = env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))).catch((e) => { tablesReady = null; throw e; });
  return tablesReady;
}

/* Share previews (Discord, iMessage, X...) need full web addresses, so fill them in here. */
async function homePage(request, env, url) {
  const res = await env.ASSETS.fetch(request);
  if (!(res.headers.get("content-type") || "").includes("text/html")) return res;
  const abs = (attr) => ({ element(el) { const v = el.getAttribute(attr); if (v && v.startsWith("/")) el.setAttribute(attr, url.origin + v); } });
  return new HTMLRewriter()
    .on('meta[property="og:image"]', abs("content"))
    .on('meta[name="twitter:image"]', abs("content"))
    .on('meta[property="og:url"]', abs("content"))
    .transform(res);
}

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

async function handle(request, env, url) {
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, "");

  // Block cross-site form posts. Browsers always send Origin on these methods.
  if (method !== "GET" && method !== "HEAD") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) fail(403, "Cross-site requests aren't allowed.");
  }

  const user = await currentUser(request, env);
  let m;

  if (path === "/api/me" && method === "GET") return json({ user: publicUser(user, env) });
  if (path === "/api/me" && method === "PATCH") return updateMe(request, env, user);
  if (path === "/api/signup" && method === "POST") return signup(request, env);
  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return logout(request, env);

  if (path === "/api/settings" && method === "GET") return getSettings(env, user);
  if (path === "/api/settings" && method === "PUT") return putSettings(request, env, user);

  if (path === "/api/progress" && method === "GET") return getProgress(env, user);
  if (path === "/api/progress" && method === "PUT") return putProgress(request, env, user);
  if (path === "/api/daily" && method === "GET") return getDaily(env, user);
  if (path === "/api/daily" && method === "POST") return postDaily(request, env, user);
  if (path === "/api/rooms" && method === "POST") return createRoom(request, env, user);
  if ((m = path.match(/^\/api\/rooms\/([A-Z]{4})$/)) && method === "GET") return getRoom(env, user, m[1], url);
  if ((m = path.match(/^\/api\/rooms\/([A-Z]{4})\/join$/)) && method === "POST") return joinRoom(env, user, m[1]);
  if ((m = path.match(/^\/api\/rooms\/([A-Z]{4})\/move$/)) && method === "POST") return roomMove(request, env, user, m[1]);
  if ((m = path.match(/^\/api\/rooms\/([A-Z]{4})\/leave$/)) && method === "POST") return leaveRoom(env, user, m[1]);

  if (path === "/api/scores" && method === "GET") return getScores(env, user);
  if (path === "/api/scores" && method === "POST") return postScores(request, env, user);

  if (path === "/api/submissions" && method === "GET") return listSubmissions(env);
  if (path === "/api/submissions" && method === "POST") return createSubmission(request, env, user);
  if ((m = path.match(/^\/api\/submissions\/(\d+)\/code$/)) && method === "GET") return getCode(env, user, +m[1]);
  if ((m = path.match(/^\/api\/submissions\/(\d+)\/status$/)) && method === "POST") return setStatus(request, env, user, +m[1]);
  if ((m = path.match(/^\/api\/submissions\/(\d+)$/)) && method === "DELETE") return deleteSubmission(env, user, +m[1]);

  fail(404, "Not found.");
}

/* ------------------------------------------------------------------ */
/* Accounts                                                            */
/* ------------------------------------------------------------------ */

async function signup(request, env) {
  const b = await readJson(request);
  const username = cleanName(b.username);
  const password = String(b.password || "");
  checkName(username);
  checkPassword(password);
  await limit(env, "signup:" + clientIp(request), 6, HOUR, "Too many new accounts from your network. Try again in an hour.");

  const lc = username.toLowerCase();
  if (await env.DB.prepare("SELECT 1 FROM users WHERE username_lc = ?").bind(lc).first()) fail(409, `"${username}" is taken. Try another name.`);

  const av = cleanAvatar(b.av);
  const { hash, salt } = await hashPassword(password);
  const now = Date.now();
  let row;
  try {
    row = await env.DB.prepare(
      "INSERT INTO users (username, username_lc, pass_hash, salt, iterations, avatar_i, avatar_c, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *"
    ).bind(username, lc, hash, salt, PBKDF2_ITERATIONS, av.i, av.c, now).first();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) fail(409, `"${username}" is taken. Try another name.`);
    throw e;
  }
  const cookie = await createSession(env, row.id);
  return json({ user: publicUser(row, env) }, 201, { "set-cookie": cookie });
}

async function login(request, env) {
  const b = await readJson(request);
  const username = cleanName(b.username);
  const password = String(b.password || "");
  const lc = username.toLowerCase();
  await limit(env, "login-ip:" + clientIp(request), 40, 15 * MIN, "Too many login attempts. Wait 15 minutes and try again.");
  await limit(env, "login:" + lc, 10, 15 * MIN, "Too many login attempts for this account. Wait 15 minutes and try again.");

  const row = await env.DB.prepare("SELECT * FROM users WHERE username_lc = ?").bind(lc).first();
  if (!row) {
    await hashPassword(password); // same work either way, so timing doesn't reveal which names exist
    fail(401, "Wrong username or password.");
  }
  const { hash } = await hashPassword(password, row.salt, row.iterations);
  if (!sameString(hash, row.pass_hash)) fail(401, "Wrong username or password.");

  await env.DB.prepare("DELETE FROM rate WHERE key = ?").bind("login:" + lc).run();
  const cookie = await createSession(env, row.id);
  return json({ user: publicUser(row, env) }, 200, { "set-cookie": cookie });
}

async function logout(request, env) {
  const token = readCookie(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256hex(token)).run();
  return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
}

async function updateMe(request, env, user) {
  if (!user) fail(401, "Log in first.");
  const b = await readJson(request);
  const sets = [], vals = [];

  if (b.username !== undefined) {
    const username = cleanName(b.username);
    if (username !== user.username) {
      checkName(username);
      const lc = username.toLowerCase();
      if (isAdmin(user, env)) fail(400, "The admin account keeps its name.");
      if (lc === adminName(env)) fail(409, `"${username}" is taken. Try another name.`);
      const other = await env.DB.prepare("SELECT id FROM users WHERE username_lc = ?").bind(lc).first();
      if (other && other.id !== user.id) fail(409, `"${username}" is taken. Try another name.`);
      sets.push("username = ?", "username_lc = ?"); vals.push(username, lc);
    }
  }
  if (b.av !== undefined) {
    const av = cleanAvatar(b.av);
    sets.push("avatar_i = ?", "avatar_c = ?"); vals.push(av.i, av.c);
  }
  if (b.newPassword) {
    const { hash: cur } = await hashPassword(String(b.currentPassword || ""), user.salt, user.iterations);
    if (!sameString(cur, user.pass_hash)) fail(400, "Your current password isn't right.");
    const pw = String(b.newPassword);
    checkPassword(pw);
    const { hash, salt } = await hashPassword(pw);
    sets.push("pass_hash = ?", "salt = ?", "iterations = ?"); vals.push(hash, salt, PBKDF2_ITERATIONS);
  }
  if (sets.length) {
    try {
      await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, user.id).run();
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) fail(409, "That name is taken. Try another name.");
      throw e;
    }
  }
  const row = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(user.id).first();
  return json({ user: publicUser(row, env) });
}

/* ------------------------------------------------------------------ */
/* Settings (music style and volume), saved per account                */
/* ------------------------------------------------------------------ */

const MUSIC_STYLES = new Set(["synth", "chip", "chill", "hyper", "space", "rock", "off"]);
function cleanSettings(b) {
  const music = MUSIC_STYLES.has(b && b.music) ? b.music : "synth";
  const pct = (x, d) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : d; };
  const flag = (x) => x !== false;
  const theme = ["synthwave", "toxic", "sunset", "ice", "matrix", "gold", "blood", "galaxy"].includes(b && b.theme) ? b.theme : "synthwave";
  return { music, mvol: pct(b && b.mvol, 80), svol: pct(b && b.svol, 80), shake: flag(b && b.shake), flash: flag(b && b.flash), crt: flag(b && b.crt), glow: flag(b && b.glow), theme };
}
async function getSettings(env, user) {
  if (!user) fail(401, "Log in first.");
  const row = await env.DB.prepare("SELECT data FROM settings WHERE user_id = ?").bind(user.id).first();
  let data = null; try { data = row ? JSON.parse(row.data) : null; } catch { data = null; }
  return json({ settings: data ? cleanSettings(data) : null });
}
async function putSettings(request, env, user) {
  if (!user) fail(401, "Log in first.");
  const st = cleanSettings(await readJson(request));
  await env.DB.prepare("INSERT INTO settings (user_id, data, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, at = excluded.at").bind(user.id, JSON.stringify(st), Date.now()).run();
  return json({ settings: st });
}

/* ------------------------------------------------------------------ */
/* Progress: favorites, recently played, achievements                  */
/* ------------------------------------------------------------------ */

async function getProgress(env, user) {
  if (!user) fail(401, "Log in first.");
  const row = await env.DB.prepare("SELECT data FROM progress WHERE user_id = ?").bind(user.id).first();
  let data = null; try { data = row ? JSON.parse(row.data) : null; } catch { data = null; }
  return json({ progress: data });
}
async function putProgress(request, env, user) {
  if (!user) fail(401, "Log in first.");
  await limit(env, "prog:" + user.id, 120, MIN, "Slow down a little.");
  const b = await readJson(request), text = JSON.stringify(b.progress && typeof b.progress === "object" ? b.progress : {});
  if (text.length > 20000) fail(413, "That's too much data.");
  await env.DB.prepare("INSERT INTO progress (user_id, data, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, at = excluded.at").bind(user.id, text, Date.now()).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Daily challenge: one game per day (UTC), its own leaderboard        */
/* ------------------------------------------------------------------ */

const DAILY_POOL = ["snake", "bricks", "blaster", "flap", "2048", "memory", "runner", "racer", "blocks", "targets", "golf", "void", "muncher", "missile", "storm", "slice", "mines", "slide", "gems", "tunnel", "drift", "hop", "flip", "quest", "hoops", "penalty", "tower", "beat", "simon"];
const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
function dailyGame(day) { let h = 7; for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return DAILY_POOL[h % DAILY_POOL.length]; }
async function getDaily(env, user) {
  const day = dayKey(), game = dailyGame(day);
  const { results } = await env.DB.prepare("SELECT d.user_id, d.score, u.username, u.avatar_i, u.avatar_c FROM daily d JOIN users u ON u.id = d.user_id WHERE d.day = ? ORDER BY d.score DESC, d.at ASC LIMIT 20").bind(day).all();
  let mine = null;
  if (user) { const r = await env.DB.prepare("SELECT score FROM daily WHERE day = ? AND user_id = ?").bind(day, user.id).first(); mine = r ? r.score : null; }
  return json({ day, game, endsAt: Date.parse(day + "T00:00:00Z") + DAY, top: results.map((r) => ({ uid: r.user_id, tag: r.username, av: { i: r.avatar_i, c: r.avatar_c }, s: r.score })), mine });
}
async function postDaily(request, env, user) {
  if (!user) fail(401, "Log in to join the daily challenge.");
  await limit(env, "daily:" + user.id, 30, MIN, "Slow down a little.");
  const b = await readJson(request), day = dayKey(), score = Math.floor(Number(b.score));
  if (b.game !== dailyGame(day)) fail(400, "That isn't today's game.");
  if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) fail(400, "That score doesn't look right.");
  await env.DB.prepare("INSERT INTO daily (day, user_id, game, score, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (day, user_id) DO UPDATE SET score = excluded.score, at = excluded.at WHERE excluded.score > daily.score").bind(day, user.id, b.game, score, Date.now()).run();
  return getDaily(env, user);
}

/* ------------------------------------------------------------------ */
/* Online rooms for turn-based 2-player games                          */
/* ------------------------------------------------------------------ */

const ONLINE_GAMES = new Set(["connect4", "reversi", "chess"]);
async function createRoom(request, env, user) {
  if (!user) fail(401, "Log in to play online.");
  await limit(env, "room:" + user.id, 20, 10 * MIN, "You've made a lot of rooms. Try again in a few minutes.");
  const b = await readJson(request);
  if (!ONLINE_GAMES.has(b.game)) fail(400, "That game can't be played online yet.");
  const now = Date.now();
  await env.DB.prepare("DELETE FROM rooms WHERE updated_at < ?").bind(now - 6 * HOUR).run();
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let i = 0; i < 8; i++) {
    const r = crypto.getRandomValues(new Uint8Array(4)), code = [...r].map((x) => A[x % A.length]).join("");
    try {
      await env.DB.prepare("INSERT INTO rooms (code, game, host_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(code, b.game, user.id, now, now).run();
      return json({ code, game: b.game, seat: 1 });
    } catch (e) { if (!/UNIQUE|PRIMARY/i.test(String(e))) throw e; }
  }
  fail(500, "Couldn't make a room. Try again.");
}
async function roomFor(env, code) {
  const r = await env.DB.prepare("SELECT r.*, h.username AS host_name, g.username AS guest_name FROM rooms r JOIN users h ON h.id = r.host_id LEFT JOIN users g ON g.id = r.guest_id WHERE r.code = ?").bind(code).first();
  if (!r) fail(404, "No room with that code. Check the letters and try again.");
  return r;
}
const seatOf = (r, user) => (user && r.host_id === user.id ? 1 : user && r.guest_id === user.id ? 2 : 0);
async function getRoom(env, user, code, url) {
  const r = await roomFor(env, code), since = Math.max(0, Math.floor(Number(url.searchParams.get("since")) || 0));
  const moves = JSON.parse(r.moves || "[]");
  return json({ code, game: r.game, status: r.status, seat: seatOf(r, user), host: r.host_name, guest: r.guest_name || null, count: moves.length, moves: moves.slice(since) });
}
async function joinRoom(env, user, code) {
  if (!user) fail(401, "Log in to play online.");
  const r = await roomFor(env, code);
  if (r.host_id === user.id) return json({ code, game: r.game, seat: 1 });
  if (r.guest_id && r.guest_id !== user.id) fail(409, "That room is already full.");
  if (r.status === "left") fail(410, "That game has ended.");
  await env.DB.prepare("UPDATE rooms SET guest_id = ?, status = 'playing', updated_at = ? WHERE code = ?").bind(user.id, Date.now(), code).run();
  return json({ code, game: r.game, seat: 2, host: r.host_name });
}
async function roomMove(request, env, user, code) {
  if (!user) fail(401, "Log in to play online.");
  await limit(env, "move:" + user.id, 120, MIN, "Slow down a little.");
  const r = await roomFor(env, code), seat = seatOf(r, user);
  if (!seat) fail(403, "You're not in this game.");
  const b = await readJson(request), moves = JSON.parse(r.moves || "[]");
  if (Number(b.n) !== moves.length) fail(409, "Out of sync. Catching up.");
  const mv = JSON.stringify(b.move ?? null); if (mv.length > 200) fail(400, "That move is too big.");
  moves.push({ seat, m: JSON.parse(mv) });
  const res = await env.DB.prepare("UPDATE rooms SET moves = ?, updated_at = ? WHERE code = ? AND moves = ?").bind(JSON.stringify(moves), Date.now(), code, r.moves).run();
  if (!res.meta || !res.meta.changes) fail(409, "Out of sync. Catching up.");
  return json({ count: moves.length });
}
async function leaveRoom(env, user, code) {
  const r = await roomFor(env, code);
  if (seatOf(r, user)) await env.DB.prepare("UPDATE rooms SET status = 'left', updated_at = ? WHERE code = ?").bind(Date.now(), code).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Leaderboards                                                        */
/* ------------------------------------------------------------------ */

async function getScores(env, user) {
  // Top 100 per game, plus every score of the signed-in player.
  const { results } = await env.DB.prepare(`
    SELECT s.user_id, s.game, s.score, s.at, u.username, u.avatar_i, u.avatar_c, u.created_at
    FROM (
      SELECT user_id, game, score, at,
             ROW_NUMBER() OVER (PARTITION BY game ORDER BY score DESC, at ASC) AS rn
      FROM scores
    ) s
    JOIN users u ON u.id = s.user_id
    WHERE s.rn <= 100 OR s.user_id = ?
  `).bind(user ? user.id : -1).all();

  const players = new Map();
  for (const r of results) {
    let p = players.get(r.user_id);
    if (!p) { p = { uid: r.user_id, tag: r.username, av: { i: r.avatar_i, c: r.avatar_c }, joined: r.created_at, best: {} }; players.set(r.user_id, p); }
    p.best[r.game] = { s: r.score, at: r.at };
  }
  return json({ players: [...players.values()] });
}

async function postScores(request, env, user) {
  if (!user) fail(401, "Log in to post scores.");
  await limit(env, "score:" + user.id, 60, MIN, "Slow down a little. Too many scores at once.");
  const b = await readJson(request);
  const entries = Object.entries(b.scores && typeof b.scores === "object" ? b.scores : {}).slice(0, 50);

  const approved = new Set((await env.DB.prepare("SELECT id FROM submissions WHERE status = 'approved'").all()).results.map((r) => "sub-" + r.id));
  const now = Date.now(), games = [], stmts = [];
  for (const [game, raw] of entries) {
    const score = Math.floor(Number(raw));
    if (!(BUILTIN_GAMES.has(game) || approved.has(game))) continue;
    if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) continue;
    games.push(game);
    stmts.push(env.DB.prepare(`
      INSERT INTO scores (user_id, game, score, at) VALUES (?, ?, ?, ?)
      ON CONFLICT (user_id, game) DO UPDATE SET score = excluded.score, at = excluded.at
      WHERE excluded.score > scores.score
    `).bind(user.id, game, score, now));
  }
  if (!stmts.length) return json({ improved: [] });
  const res = await env.DB.batch(stmts);
  const improved = games.filter((g, i) => res[i] && res[i].meta && res[i].meta.changes > 0);
  return json({ improved });
}

/* ------------------------------------------------------------------ */
/* Game submissions                                                    */
/* ------------------------------------------------------------------ */

const subOut = (r) => ({
  id: r.id, userId: r.user_id, title: r.title, creator: r.creator, genre: r.genre, blurb: r.blurb,
  size: r.size, status: r.status, createdAt: r.created_at, approvedAt: r.approved_at,
});

async function listSubmissions(env) {
  const { results } = await env.DB.prepare(`
    SELECT id, user_id, title, creator, genre, blurb, size, status, created_at, approved_at
    FROM submissions
    WHERE status = 'approved' OR id IN (SELECT id FROM submissions ORDER BY created_at DESC LIMIT 300)
    ORDER BY created_at DESC
  `).all();
  return json({ submissions: results.map(subOut) });
}

async function createSubmission(request, env, user) {
  if (!user) fail(401, "Log in to submit games.");
  const b = await readJson(request);
  const title = String(b.title || "").trim().slice(0, 40);
  const creator = String(b.creator || "").trim().slice(0, 30);
  const genre = GENRES.has(b.genre) ? b.genre : "Other";
  const blurb = String(b.blurb || "").trim().slice(0, 90);
  const code = String(b.code || "");
  const size = new TextEncoder().encode(code).length;
  if (!title) fail(400, "Give your game a title.");
  if (!creator) fail(400, "Add a creator name.");
  if (!code.trim()) fail(400, "Paste your game code before submitting.");
  if (size > MAX_CODE_BYTES) fail(413, "The game is over 200 KB. Trim it down and try again.");
  if (!/<(html|body|canvas|script|div)/i.test(code)) fail(400, "That doesn't look like HTML. Games need to be a full HTML page.");

  await limit(env, "sub:" + user.id, 8, HOUR, "You've sent a lot of games this hour. Try again later.");
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE user_id = ? AND status = 'pending'").bind(user.id).first();
  if (pending.n >= 5) fail(429, "You already have 5 games waiting for review. Wait for those first.");

  const row = await env.DB.prepare(`
    INSERT INTO submissions (user_id, title, creator, genre, blurb, code, size, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id, user_id, title, creator, genre, blurb, size, status, created_at, approved_at
  `).bind(user.id, title, creator, genre, blurb, code, size, Date.now()).first();
  return json({ submission: subOut(row) }, 201);
}

async function getCode(env, user, id) {
  const row = await env.DB.prepare("SELECT code, status, user_id FROM submissions WHERE id = ?").bind(id).first();
  const mine = user && row && row.user_id === user.id;
  if (!row || (row.status === "rejected" && !mine && !isAdmin(user, env))) fail(404, "That game isn't available.");
  return json({ code: row.code });
}

async function setStatus(request, env, user, id) {
  if (!isAdmin(user, env)) fail(403, "Only the admin can review games.");
  const b = await readJson(request);
  const status = String(b.status || "");
  if (!["approved", "rejected", "pending"].includes(status)) fail(400, "Unknown status.");
  const row = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?").bind(id).first();
  if (!row) fail(404, "That game doesn't exist.");
  if (status === "approved" && row.status !== "approved") {
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'approved'").first();
    if (n.n + BUILTIN_COUNT >= MAX_WALL) fail(409, "The wall is full. All 1000 slots are taken.");
  }
  await env.DB.prepare(`
    UPDATE submissions
    SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN COALESCE(approved_at, ?) ELSE NULL END
    WHERE id = ?
  `).bind(status, status, Date.now(), id).run();
  return json({ ok: true });
}

async function deleteSubmission(env, user, id) {
  if (!user) fail(401, "Log in first.");
  const row = await env.DB.prepare("SELECT user_id, status FROM submissions WHERE id = ?").bind(id).first();
  if (!row) fail(404, "That game doesn't exist.");
  const admin = isAdmin(user, env);
  if (!admin && !(row.user_id === user.id && row.status === "pending")) fail(403, "You can only withdraw your own games while they're pending.");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM submissions WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM scores WHERE game = ?").bind("sub-" + id),
  ]);
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Sessions, passwords, helpers                                        */
/* ------------------------------------------------------------------ */

async function createSession(env, userId) {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256hex(token), userId, now + SESSION_DAYS * DAY),
  ]);
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
}

function readCookie(request) {
  const m = (request.headers.get("cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,100})`));
  return m ? m[1] : null;
}

async function currentUser(request, env) {
  const token = readCookie(request);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256hex(token), Date.now()).first();
}

async function hashPassword(password, saltB64, iterations = PBKDF2_ITERATIONS) {
  const salt = saltB64 ? b64d(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return { hash: b64e(new Uint8Array(bits)), salt: b64e(salt) };
}

function sameString(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  if (x.length !== y.length) return false;
  if (crypto.subtle.timingSafeEqual) return crypto.subtle.timingSafeEqual(x, y);
  let r = 0; for (let i = 0; i < x.length; i++) r |= x[i] ^ y[i];
  return r === 0;
}

async function limit(env, key, max, windowMs, message) {
  const now = Date.now();
  const row = await env.DB.prepare("SELECT count, since FROM rate WHERE key = ?").bind(key).first();
  if (!row || now - row.since > windowMs) {
    await env.DB.prepare("INSERT INTO rate (key, count, since) VALUES (?, 1, ?) ON CONFLICT (key) DO UPDATE SET count = 1, since = excluded.since").bind(key, now).run();
    return;
  }
  if (row.count >= max) fail(429, message);
  await env.DB.prepare("UPDATE rate SET count = count + 1 WHERE key = ?").bind(key).run();
}

const adminName = (env) => String(env.ADMIN_USERNAME || "").trim().toLowerCase();
const isAdmin = (u, env) => !!(u && adminName(env) && u.username_lc === adminName(env));
const publicUser = (u, env) => (u ? { id: u.id, username: u.username, av: { i: u.avatar_i, c: u.avatar_c }, joined: u.created_at, admin: isAdmin(u, env) } : null);
const cleanName = (v) => String(v || "").trim().replace(/\s+/g, " ");
const clientIp = (request) => request.headers.get("cf-connecting-ip") || "local";

function checkName(name) {
  if (!USER_RE.test(name)) fail(400, "Usernames are 3 to 16 letters, numbers, spaces, dots, dashes or underscores.");
}
function checkPassword(pw) {
  if (pw.length < 8) fail(400, "Passwords need at least 8 characters.");
  if (pw.length > 200) fail(400, "That password is too long.");
}
function cleanAvatar(av) {
  const i = Math.abs(Math.floor(Number(av && av.i))) || 0, c = Math.abs(Math.floor(Number(av && av.c))) || 0;
  return { i: i % 10, c: c % 8 };
}

async function readJson(request) {
  if (!(request.headers.get("content-type") || "").includes("application/json")) fail(415, "Send the request as JSON.");
  const text = await request.text();
  if (text.length > 300 * 1024) fail(413, "That request is too big.");
  try {
    const v = JSON.parse(text || "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    fail(400, "That request wasn't valid JSON.");
  }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

const b64e = (u8) => { let s = ""; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const b64d = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u8) => b64e(u8).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Neon Slither online arena: one shared room that relays snake        */
/* positions between players and keeps the pellets in sync.            */
/* ------------------------------------------------------------------ */

const ARENA_R = 1500, PELLETS = 450, MAX_PLAYERS = 16;
const PCOLS = ["#ff2bd6", "#22e4ff", "#b6ff3b", "#ffc23d", "#a35bff", "#ff4d6d", "#3dffa8", "#ff8a1f"];
export class SlitherArena {
  constructor(state, env) { this.state = state; this.conns = new Map(); this.pel = new Map(); this.pid = 1; this.host = null; }
  addPellet(x, y, v, c) { const id = this.pid++, p = [id, Math.round(x), Math.round(y), v, c]; this.pel.set(id, p); return p; }
  fill() {
    const add = [];
    while (this.pel.size < PELLETS) {
      const a = Math.random() * 6.2832, r = Math.sqrt(Math.random()) * (ARENA_R - 30), v = Date.now() < Date.parse("2026-11-01T00:00:00Z") && Math.random() < .04 ? 5 : Math.random() < .05 ? 8 : Math.random() < .3 ? 3 : 1;
      add.push(this.addPellet(Math.cos(a) * r, Math.sin(a) * r, v, PCOLS[Math.floor(Math.random() * PCOLS.length)]));
    }
    return add;
  }
  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
  bcast(obj, except) { const s = JSON.stringify(obj); for (const [id, ws] of this.conns) if (id !== except) { try { ws.send(s); } catch {} } }
  async fetch(request) {
    if (new URL(request.url).pathname.endsWith("/count")) return new Response(JSON.stringify({ players: this.conns.size }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a websocket", { status: 426 });
    if (this.conns.size >= MAX_PLAYERS) return new Response("The arena is full", { status: 503 });
    const pair = new WebSocketPair(), client = pair[0], ws = pair[1];
    ws.accept();
    const id = Math.random().toString(36).slice(2, 8);
    this.conns.set(id, ws);
    if (!this.host || !this.conns.has(this.host)) this.host = id;
    this.fill();
    this.send(ws, { t: "welcome", id, host: this.host === id, players: this.conns.size, pellets: [...this.pel.values()] });
    this.bcast({ t: "count", players: this.conns.size }, id);
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string" || e.data.length > 24000) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m === "object") this.onMsg(id, m);
    });
    const bye = () => {
      if (!this.conns.has(id)) return;
      this.conns.delete(id);
      this.bcast({ t: "bye", id, players: this.conns.size });
      if (this.host === id) {
        this.host = this.conns.keys().next().value || null;
        if (this.host) this.send(this.conns.get(this.host), { t: "host" });
      }
      if (!this.conns.size) this.pel.clear();
    };
    ws.addEventListener("close", bye);
    ws.addEventListener("error", bye);
    return new Response(null, { status: 101, webSocket: client });
  }
  onMsg(id, m) {
    if (m.t === "st" || m.t === "bots") { if (m.t === "bots" && id !== this.host) return; m.id = id; this.bcast(m, id); }
    else if (m.t === "eat" && Array.isArray(m.ids)) {
      const rm = m.ids.slice(0, 120).filter((i) => this.pel.delete(i));
      if (rm.length) this.bcast({ t: "pe", rm, add: this.fill() });
    } else if (m.t === "drop" && Array.isArray(m.l)) {
      if (this.pel.size > 1800) return;
      const add = m.l.slice(0, 160).map((q) => Array.isArray(q) ? this.addPellet(Math.max(-ARENA_R, Math.min(ARENA_R, +q[0] || 0)), Math.max(-ARENA_R, Math.min(ARENA_R, +q[1] || 0)), [1, 2, 3, 5, 8].includes(q[2]) ? q[2] : 1, typeof q[3] === "string" && q[3].length < 12 ? q[3] : "#22e4ff") : null).filter(Boolean);
      if (add.length) this.bcast({ t: "pe", rm: [], add });
    } else if (m.t === "die") {
      this.bcast({ t: "kill", v: Number.isInteger(m.bot) ? id + ":" + m.bot : id, by: String(m.by || "").slice(0, 24), vn: String(m.vn || "").slice(0, 16), bn: String(m.bn || "").slice(0, 16) });
    }
  }
}
