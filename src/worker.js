/**
 * Games by Levi - server.
 * A Cloudflare Worker that serves the site from ./public and answers /api/*
 * with accounts, leaderboards and game submissions stored in a D1 database.
 */

const BUILTIN_GAMES = new Set(["snake", "bricks", "pong", "blaster", "flap", "2048", "memory", "runner", "racer", "blocks", "targets", "golf", "pingpong", "void", "muncher", "missile", "storm", "slice", "mines", "slide", "gems", "tunnel", "drift", "hop", "flip", "quest", "hoops", "penalty", "tower", "connect4", "reversi", "beat", "simon", "chess", "guesswho", "slither", "orbit", "vortex", "evader", "laser", "bitshift", "core", "overdrive", "squash", "curling", "math", "clash", "thief", "stack", "crossing", "airhockey", "whack", "bowling", "merge", "colordash", "blades", "ttt", "dots", "solitaire", "fighters", "bossrush", "pinball", "bubbles", "words", "platformer"]);
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
  "CREATE TABLE IF NOT EXISTS friends (a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL, asker INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (a, b))",
  "CREATE TABLE IF NOT EXISTS playdates (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, pet TEXT NOT NULL, at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE IF NOT EXISTS challenges (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, score INTEGER NOT NULL, reply INTEGER, status TEXT NOT NULL DEFAULT 'open', at INTEGER NOT NULL, done_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS tours (code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, games TEXT NOT NULL, players TEXT NOT NULL DEFAULT '[]', scores TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'lobby', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS diag (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, who TEXT, body TEXT NOT NULL)",
  "CREATE TABLE IF NOT EXISTS likes (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, PRIMARY KEY (user_id, game))",
  "CREATE TABLE IF NOT EXISTS help_requests (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, username TEXT NOT NULL DEFAULT 'Guest', msg TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new', admin_note TEXT NOT NULL DEFAULT '')",
  "CREATE INDEX IF NOT EXISTS help_by_ts ON help_requests(ts DESC)",
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

  if (path === "/api/friends" && method === "GET") return getFriends(env, user);
  if (path === "/api/friends" && method === "POST") return addFriend(request, env, user);
  if ((m = path.match(/^\/api\/friends\/(\d+)\/(accept|remove)$/)) && method === "POST") return friendAction(env, user, +m[1], m[2]);
  if (path === "/api/challenges" && method === "POST") return createChallenge(request, env, user);
  if (path === "/api/playdates" && method === "POST") return createPlaydate(request, env, user);
  if (path === "/api/playdates/seen" && method === "POST") return seenPlaydates(env, user);
  if ((m = path.match(/^\/api\/challenges\/(\d+)\/answer$/)) && method === "POST") return answerChallenge(request, env, user, +m[1]);
  if (path === "/api/tours" && method === "POST") return createTour(env, user);
  if ((m = path.match(/^\/api\/tours\/([A-Z]{4})$/)) && method === "GET") return getTour(env, user, m[1]);
  if ((m = path.match(/^\/api\/tours\/([A-Z]{4})\/(join|start|score|leave)$/)) && method === "POST") return tourAction(request, env, user, m[1], m[2]);
  if (path === "/api/scores" && method === "GET") return getScores(env, user);
  if (path === "/api/scores" && method === "POST") return postScores(request, env, user);

  if (path === "/api/config" && method === "GET") return getConfig(env);
  if (path === "/api/diag" && method === "POST") return postDiag(request, env, user);
  if (path === "/api/diag" && method === "GET") return getDiag(env);
  if (path === "/api/likes" && method === "GET") return getLikes(env, user);
  if (path === "/api/likes" && method === "POST") return postLike(request, env, user);
  if (path === "/api/help" && method === "POST") return submitHelp(request, env, user);
  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(user, env)) fail(403, "Only the admin can do that.");
    if (path === "/api/admin/config" && method === "PUT") return putConfig(request, env);
    if (path === "/api/admin/overview" && method === "GET") return adminOverview(env);
    if (path === "/api/admin/users" && method === "GET") return adminUsers(env, url);
    if (path === "/api/admin/scores" && method === "DELETE") return adminDeleteScores(request, env);
    if (path === "/api/admin/help" && method === "GET") return adminListHelp(env);
    if ((m = path.match(/^\/api\/admin\/help\/(\d+)$/)) && method === "PATCH") return adminPatchHelp(request, env, +m[1]);
    if ((m = path.match(/^\/api\/admin\/help\/(\d+)$/)) && method === "DELETE") return adminDeleteHelp(env, +m[1]);
    if ((m = path.match(/^\/api\/admin\/users\/(\d+)$/))) {
      if (method === "GET") return adminUser(env, +m[1]);
      if (method === "PATCH") return adminEditUser(request, env, user, +m[1]);
      if (method === "DELETE") return adminDeleteUser(env, user, +m[1]);
    }
    if ((m = path.match(/^\/api\/admin\/users\/(\d+)\/reset$/)) && method === "POST") return adminReset(request, env, +m[1]);
    fail(404, "Not found.");
  }
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
      if (isAdminName(lc, env)) fail(409, `"${username}" is taken. Try another name.`);
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
  if (text.length > 120000) fail(413, "That's too much data.");
  const old = await env.DB.prepare("SELECT data FROM progress WHERE user_id = ?").bind(user.id).first();
  if (old) { let o = null; try { o = JSON.parse(old.data); } catch {} if (o && +o.adminAt > (+(b.progress || {}).adminSeen || 0)) return json({ ok: false, reload: true }); }
  await env.DB.prepare("INSERT INTO progress (user_id, data, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, at = excluded.at").bind(user.id, text, Date.now()).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Daily challenge: one game per day (UTC), its own leaderboard        */
/* ------------------------------------------------------------------ */

const DAILY_POOL = ["snake", "bricks", "blaster", "flap", "2048", "memory", "runner", "racer", "blocks", "targets", "golf", "void", "muncher", "missile", "storm", "slice", "mines", "slide", "gems", "tunnel", "drift", "hop", "flip", "quest", "hoops", "penalty", "tower", "beat", "simon", "orbit", "vortex", "evader", "laser", "bitshift", "core", "overdrive", "squash", "curling", "stack", "crossing", "whack", "bowling", "merge", "colordash", "blades", "solitaire", "fighters"];
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

const ONLINE_GAMES = new Set(["ttt", "dots", "connect4", "reversi", "chess", "penalty", "memory", "guesswho", "golf", "hoops", "bowling"]);
async function createRoom(request, env, user) {
  if (!user) fail(401, "Log in to play online.");
  await limit(env, "room:" + user.id, 20, 10 * MIN, "You've made a lot of rooms. Try again in a few minutes.");
  const b = await readJson(request);
  const duel = typeof b.game === "string" && b.game.startsWith("duel:") && BUILTIN_GAMES.has(b.game.slice(5));
  if (!ONLINE_GAMES.has(b.game) && !duel) fail(400, "That game can't be played online yet.");
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
/* Friends and "beat my score" challenges                              */
/* ------------------------------------------------------------------ */

const pair = (x, y) => (x < y ? [x, y] : [y, x]);
const PUBLIC_COLS = "u.id, u.username, u.avatar_i, u.avatar_c, json_extract(p.data, '$.equip.title') AS title, json_extract(p.data, '$.equip.pet') AS pet, json_extract(p.data, '$.stats.xp') AS xp";
const itemId = (v, pre) => (typeof v === "string" && v.startsWith(pre) && v.length < 40 && /^[a-z0-9-]+$/.test(v) ? v : null);
const pubRow = (r) => ({ id: r.id, name: r.username, av: { i: r.avatar_i, c: r.avatar_c }, title: itemId(r.title, "t-"), pet: itemId(r.pet, "pet-"), lv: Math.floor(Math.sqrt(Math.max(0, +r.xp || 0) / 40)) + 1 });
async function areFriends(env, x, y) { const [a, b] = pair(x, y); const r = await env.DB.prepare("SELECT status FROM friends WHERE a = ? AND b = ?").bind(a, b).first(); return r && r.status === "ok"; }
async function getFriends(env, user) {
  if (!user) fail(401, "Log in to see your friends.");
  const { results: rows } = await env.DB.prepare(`SELECT f.status, f.asker, ${PUBLIC_COLS} FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ? THEN f.b ELSE f.a END LEFT JOIN progress p ON p.user_id = u.id WHERE f.a = ? OR f.b = ?`).bind(user.id, user.id, user.id).all();
  const friends = [], incoming = [], outgoing = [];
  for (const r of rows) { const o = pubRow(r); if (r.status === "ok") friends.push(o); else if (r.asker === user.id) outgoing.push(o); else incoming.push(o); }
  if (friends.length) {
    const ids = friends.map((f) => f.id);
    const { results: recent } = await env.DB.prepare(`SELECT user_id, game, score, at FROM (SELECT user_id, game, score, at, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY at DESC) AS rn FROM scores WHERE user_id IN (${ids.map(() => "?").join(",")})) WHERE rn <= 3`).bind(...ids).all();
    for (const f of friends) f.recent = recent.filter((r) => r.user_id === f.id).map((r) => ({ game: r.game, score: r.score, at: r.at }));
  }
  const { results: ch } = await env.DB.prepare(`SELECT c.*, fu.username AS from_name, tu.username AS to_name FROM challenges c JOIN users fu ON fu.id = c.from_id JOIN users tu ON tu.id = c.to_id WHERE (c.from_id = ? OR c.to_id = ?) AND c.at > ? ORDER BY c.at DESC LIMIT 60`).bind(user.id, user.id, Date.now() - 14 * DAY).all();
  const challenges = ch.map((c) => ({ id: c.id, from: c.from_id, fromName: c.from_name, to: c.to_id, toName: c.to_name, game: c.game, score: c.score, reply: c.reply, status: c.status, at: c.at, doneAt: c.done_at }));
  const { results: vis } = await env.DB.prepare("SELECT pd.id, pd.pet, pd.at, u.username AS from_name FROM playdates pd JOIN users u ON u.id = pd.from_id WHERE pd.to_id = ? AND pd.seen = 0 ORDER BY pd.at DESC LIMIT 10").bind(user.id).all();
  const visits = vis.map((v) => ({ id: v.id, fromName: v.from_name, pet: itemId(v.pet, "pet-"), at: v.at }));
  return json({ friends, incoming, outgoing, challenges, visits });
}
async function addFriend(request, env, user) {
  if (!user) fail(401, "Log in to add friends.");
  await limit(env, "friend:" + user.id, 30, HOUR, "You've sent a lot of friend requests. Try again later.");
  const b = await readJson(request), name = cleanName(b.username).toLowerCase();
  if (!name) fail(400, "Type your friend's username.");
  const them = await env.DB.prepare("SELECT id, username FROM users WHERE username_lc = ?").bind(name).first();
  if (!them) fail(404, "No player called \"" + cleanName(b.username) + "\". Check the spelling.");
  if (them.id === user.id) fail(400, "That's you! Add someone else.");
  const [a, c] = pair(user.id, them.id), row = await env.DB.prepare("SELECT status, asker FROM friends WHERE a = ? AND b = ?").bind(a, c).first();
  if (row && row.status === "ok") return json({ ok: true, msg: "You're already friends with " + them.username + "." });
  if (row && row.asker !== user.id) { await env.DB.prepare("UPDATE friends SET status = 'ok', at = ? WHERE a = ? AND b = ?").bind(Date.now(), a, c).run(); return json({ ok: true, msg: "You and " + them.username + " are now friends!" }); }
  if (row) return json({ ok: true, msg: "Request already sent to " + them.username + "." });
  const { results: cnt } = await env.DB.prepare("SELECT COUNT(*) AS n FROM friends WHERE a = ? OR b = ?").bind(user.id, user.id).all();
  if (cnt[0].n >= 200) fail(409, "You've reached the friend limit (200).");
  await env.DB.prepare("INSERT INTO friends (a, b, status, asker, at) VALUES (?, ?, 'pending', ?, ?)").bind(a, c, user.id, Date.now()).run();
  return json({ ok: true, msg: "Friend request sent to " + them.username + "!" });
}
async function friendAction(env, user, id, act) {
  if (!user) fail(401, "Log in first.");
  const [a, b] = pair(user.id, id), row = await env.DB.prepare("SELECT status, asker FROM friends WHERE a = ? AND b = ?").bind(a, b).first();
  if (!row) fail(404, "That request is gone.");
  if (act === "accept") { if (row.asker === user.id) fail(400, "Wait for them to accept."); await env.DB.prepare("UPDATE friends SET status = 'ok', at = ? WHERE a = ? AND b = ?").bind(Date.now(), a, b).run(); }
  else await env.DB.prepare("DELETE FROM friends WHERE a = ? AND b = ?").bind(a, b).run();
  return json({ ok: true });
}
async function createChallenge(request, env, user) {
  if (!user) fail(401, "Log in to send challenges.");
  await limit(env, "chal:" + user.id, 40, HOUR, "That's a lot of challenges! Try again later.");
  const b = await readJson(request), to = Math.floor(Number(b.to)), game = String(b.game || "");
  if (!BUILTIN_GAMES.has(game)) fail(400, "Pick a game to challenge them in.");
  if (!(await areFriends(env, user.id, to))) fail(403, "You can only challenge friends.");
  const best = await env.DB.prepare("SELECT score FROM scores WHERE user_id = ? AND game = ?").bind(user.id, game).first();
  if (!best || best.score <= 0) fail(400, "Set a score in that game first, then challenge them to beat it.");
  const open = await env.DB.prepare("SELECT id FROM challenges WHERE from_id = ? AND to_id = ? AND game = ? AND status = 'open'").bind(user.id, to, game).first();
  if (open) fail(409, "You already have an open challenge with them in that game.");
  await env.DB.prepare("INSERT INTO challenges (from_id, to_id, game, score, at) VALUES (?, ?, ?, ?, ?)").bind(user.id, to, game, best.score, Date.now()).run();
  return json({ ok: true, score: best.score });
}
async function createPlaydate(request, env, user) {
  if (!user) fail(401, "Log in first.");
  await limit(env, "play:" + user.id, 30, HOUR, "That's a lot of playdates! Try again later.");
  const b = await readJson(request), to = Math.floor(Number(b.to)), pet = itemId(b.pet, "pet-");
  if (!pet) fail(400, "You need a pet for a playdate.");
  if (!(await areFriends(env, user.id, to))) fail(403, "Playdates are only with friends.");
  const recent = await env.DB.prepare("SELECT id FROM playdates WHERE from_id = ? AND to_id = ? AND at > ?").bind(user.id, to, Date.now() - 20 * HOUR).first();
  if (recent) fail(409, "You already had a playdate with them today. Try again tomorrow!");
  await env.DB.prepare("INSERT INTO playdates (from_id, to_id, pet, at) VALUES (?, ?, ?, ?)").bind(user.id, to, pet, Date.now()).run();
  return json({ ok: true });
}
async function seenPlaydates(env, user) {
  if (!user) fail(401, "Log in first.");
  await env.DB.prepare("UPDATE playdates SET seen = 1 WHERE to_id = ? AND seen = 0").bind(user.id).run();
  return json({ ok: true });
}
async function answerChallenge(request, env, user, id) {
  if (!user) fail(401, "Log in first.");
  const c = await env.DB.prepare("SELECT * FROM challenges WHERE id = ?").bind(id).first();
  if (!c || c.to_id !== user.id) fail(404, "That challenge isn't for you.");
  if (c.status !== "open") return json({ status: c.status, reply: c.reply, score: c.score });
  const b = await readJson(request), score = Math.floor(Number(b.score));
  if (!Number.isFinite(score) || score < 0 || score > 1e7) fail(400, "That score isn't valid.");
  const status = score > c.score ? "won" : "lost";
  await env.DB.prepare("UPDATE challenges SET reply = ?, status = ?, done_at = ? WHERE id = ? AND status = 'open'").bind(score, status, Date.now(), id).run();
  return json({ status, reply: score, score: c.score });
}

/* ------------------------------------------------------------------ */
/* Online tournaments: 2-5 players, the same 5 quick games, ranked     */
/* ------------------------------------------------------------------ */

const TOUR_GAMES = ["snake", "bricks", "flap", "blaster", "memory", "runner", "racer", "targets", "hop", "flip", "hoops", "beat", "simon", "stack", "crossing", "whack", "colordash", "blades", "math", "slice", "tunnel", "orbit"];
const TOUR_MAX = 5, TOUR_ROUNDS = 5;
const tourView = (t, user) => {
  const players = JSON.parse(t.players), scores = JSON.parse(t.scores);
  const me = user ? players.findIndex((p) => p.id === user.id) : -1;
  const done = t.status !== "lobby" && players.length > 0 && players.every((p) => (scores[p.id] || []).filter((v) => v != null).length >= TOUR_ROUNDS);
  return { code: t.code, games: JSON.parse(t.games), players: players.map((p) => ({ id: p.id, name: p.name, scores: scores[p.id] || [] })), status: done ? "done" : t.status, host: players[0] ? players[0].id : t.host_id, me: me >= 0 ? players[me].id : null, max: TOUR_MAX };
};
async function tourFor(env, code) {
  const t = await env.DB.prepare("SELECT * FROM tours WHERE code = ?").bind(code).first();
  if (!t) fail(404, "No tournament with that code. Check the letters and try again.");
  return t;
}
async function createTour(env, user) {
  if (!user) fail(401, "Log in to play an online tournament.");
  await limit(env, "tour:" + user.id, 10, 10 * MIN, "You've made a lot of tournaments. Try again in a few minutes.");
  const now = Date.now();
  await env.DB.prepare("DELETE FROM tours WHERE updated_at < ?").bind(now - 12 * HOUR).run();
  const pool = TOUR_GAMES.filter((k) => BUILTIN_GAMES.has(k)), games = [];
  while (games.length < TOUR_ROUNDS && pool.length) games.push(pool.splice(crypto.getRandomValues(new Uint32Array(1))[0] % pool.length, 1)[0]);
  const players = JSON.stringify([{ id: user.id, name: user.username }]);
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  for (let i = 0; i < 8; i++) {
    const code = [...crypto.getRandomValues(new Uint8Array(4))].map((x) => A[x % A.length]).join("");
    try {
      await env.DB.prepare("INSERT INTO tours (code, host_id, games, players, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(code, user.id, JSON.stringify(games), players, now, now).run();
      return json(tourView(await tourFor(env, code), user));
    } catch (e) { if (!/UNIQUE|PRIMARY/i.test(String(e))) throw e; }
  }
  fail(500, "Couldn't make a tournament. Try again.");
}
async function getTour(env, user, code) { return json(tourView(await tourFor(env, code), user)); }
async function tourAction(request, env, user, code, act) {
  if (!user) fail(401, "Log in to play an online tournament.");
  await limit(env, "touract:" + user.id, 60, MIN, "Slow down a little.");
  for (let attempt = 0; attempt < 4; attempt++) {
    const t = await tourFor(env, code), players = JSON.parse(t.players), scores = JSON.parse(t.scores);
    const idx = players.findIndex((p) => p.id === user.id);
    let status = t.status;
    if (act === "join") {
      if (idx < 0) {
        if (status !== "lobby") fail(409, "That tournament has already started.");
        if (players.length >= TOUR_MAX) fail(409, "That tournament is full (" + TOUR_MAX + " players).");
        players.push({ id: user.id, name: user.username });
      }
    } else if (act === "leave") {
      if (idx < 0) return json(tourView(t, user));
      if (status === "lobby") players.splice(idx, 1);
      else { scores[user.id] = Array.from({ length: TOUR_ROUNDS }, (_, i) => (scores[user.id] || [])[i] ?? 0); }
    } else if (act === "start") {
      if (idx !== 0) fail(403, "Only the host can start the tournament.");
      if (players.length < 2) fail(409, "Wait for at least one more player to join.");
      status = "playing";
    } else if (act === "score") {
      if (idx < 0) fail(403, "You're not in this tournament.");
      if (status !== "playing") fail(409, "The tournament hasn't started yet.");
      const b = await readJson(request), round = Math.floor(Number(b.round)), score = Math.floor(Number(b.score));
      if (!(round >= 0 && round < TOUR_ROUNDS)) fail(400, "That round doesn't exist.");
      if (!Number.isFinite(score) || score < 0 || score > 1e7) fail(400, "That score isn't valid.");
      const mine = scores[user.id] || [];
      if (mine[round] != null) return json(tourView(t, user));
      mine[round] = score; scores[user.id] = mine;
    }
    const res = await env.DB.prepare("UPDATE tours SET players = ?, scores = ?, status = ?, updated_at = ? WHERE code = ? AND players = ? AND scores = ? AND status = ?")
      .bind(JSON.stringify(players), JSON.stringify(scores), status, Date.now(), code, t.players, t.scores, t.status).run();
    if (res.meta && res.meta.changes) return json(tourView(await tourFor(env, code), user));
  }
  fail(409, "Lots happening at once. Try again.");
}

/* ------------------------------------------------------------------ */
/* Leaderboards                                                        */
/* ------------------------------------------------------------------ */

async function getScores(env, user) {
  // Top 100 per game, plus every score of the signed-in player.
  const { results } = await env.DB.prepare(`
    SELECT s.user_id, s.game, s.score, s.at, u.username, u.avatar_i, u.avatar_c, u.created_at,
           json_extract(p.data, '$.equip.title') AS eq_title, json_extract(p.data, '$.equip.pet') AS eq_pet, json_extract(p.data, '$.stats.xp') AS xp
    FROM (
      SELECT user_id, game, score, at,
             ROW_NUMBER() OVER (PARTITION BY game ORDER BY score DESC, at ASC) AS rn
      FROM scores
    ) s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN progress p ON p.user_id = s.user_id
    WHERE s.rn <= 100 OR s.user_id = ?
  `).bind(user ? user.id : -1).all();

  const players = new Map();
  for (const r of results) {
    let p = players.get(r.user_id);
    if (!p) {
      const item = (v, pre) => (typeof v === "string" && v.startsWith(pre) && v.length < 40 && /^[a-z0-9-]+$/.test(v) ? v : null);
      p = { uid: r.user_id, tag: r.username, av: { i: r.avatar_i, c: r.avatar_c }, joined: r.created_at, title: item(r.eq_title, "t-"), pet: item(r.eq_pet, "pet-"), lv: Math.floor(Math.sqrt(Math.max(0, +r.xp || 0) / 40)) + 1, best: {} };
      players.set(r.user_id, p);
    }
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
    if (!(BUILTIN_GAMES.has(game) || approved.has(game) || (game.endsWith("-qp") && BUILTIN_GAMES.has(game.slice(0, -3))))) continue;
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

// ADMIN_USERNAME can list several owner names, separated by commas.
const adminNames = (env) => String(env.ADMIN_USERNAME || "").split(",").map((n) => n.trim().toLowerCase()).filter(Boolean);
const isAdminName = (name, env) => adminNames(env).includes(String(name || "").toLowerCase());
const isAdmin = (u, env) => !!(u && isAdminName(u.username_lc, env));
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

/* ------------------------------------------------------------------ */
/* Admin: game settings for everyone, and player management            */
/* ------------------------------------------------------------------ */

const num = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
function cleanConfig(c) {
  c = c && typeof c === "object" ? c : {};
  const out = {
    announce: String(c.announce || "").slice(0, 200),
    priceMult: num(c.priceMult, 0.25, 10, 1),
    coinMult: num(c.coinMult, 0, 10, 1),
    off: Array.isArray(c.off) ? [...new Set(c.off.map(String).filter((k) => BUILTIN_GAMES.has(k)))] : [],
    gift: null,
    featured: BUILTIN_GAMES.has(String(c.featured || "")) ? String(c.featured) : "",
    event: ["auto", "none", "halloween", "harvest", "winter", "summer", "aprilfools", "easter"].includes(String(c.event || "")) ? String(c.event) : "auto",
    doubleCoins: !!c.doubleCoins,
    bossRush: !!c.bossRush,
  };
  if (c.gift && typeof c.gift === "object" && (+c.gift.c || +c.gift.d || +c.gift.g)) {
    out.gift = { id: String(c.gift.id || Date.now()).slice(0, 20), c: Math.floor(num(c.gift.c, 0, 100000, 0)), d: Math.floor(num(c.gift.d, 0, 10000, 0)), g: Math.floor(num(c.gift.g, 0, 1000, 0)), msg: String(c.gift.msg || "").slice(0, 120) };
  }
  return out;
}
async function readConfig(env) {
  const row = await env.DB.prepare("SELECT v FROM config WHERE k = 'game'").first();
  let c = null; try { c = row ? JSON.parse(row.v) : null; } catch {}
  return cleanConfig(c);
}
async function getConfig(env) { return json({ config: await readConfig(env) }); }
async function putConfig(request, env) {
  const b = await readJson(request), c = cleanConfig(b.config);
  await env.DB.prepare("INSERT INTO config (k, v) VALUES ('game', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(JSON.stringify(c)).run();
  return json({ config: c });
}
async function adminOverview(env) {
  const q = (sql) => env.DB.prepare(sql).first();
  const [u, sc, pend, act, newHelp] = await Promise.all([
    q("SELECT COUNT(*) AS n FROM users"), q("SELECT COUNT(*) AS n FROM scores"),
    q("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'"),
    env.DB.prepare("SELECT COUNT(*) AS n FROM progress WHERE at > ?").bind(Date.now() - DAY).first(),
    q("SELECT COUNT(*) AS n FROM help_requests WHERE status = 'new'"),
  ]);
  const [gs, lk] = await Promise.all([
    env.DB.prepare("SELECT game, COUNT(*) AS n FROM scores GROUP BY game").all(),
    env.DB.prepare("SELECT game, COUNT(*) AS n FROM likes GROUP BY game").all(),
  ]);
  const games = {};
  for (const r of gs.results) (games[r.game] = games[r.game] || { players: 0, hearts: 0 }).players = r.n;
  for (const r of lk.results) (games[r.game] = games[r.game] || { players: 0, hearts: 0 }).hearts = r.n;
  return json({ users: u.n, scores: sc.n, pending: pend.n, activeToday: act.n, newHelp: newHelp.n, games });
}
function progSummary(data) {
  let p = null; try { p = JSON.parse(data || "null"); } catch {}
  const st = (p && p.stats) || {};
  const xp = +st.xp || 0;
  return {
    coins: +st.coins || 0, cash: +st.cash || 0, gems: +st.gems || 0, xp, level: Math.floor(Math.sqrt(xp / 40)) + 1,
    played: Object.values((p && p.played) || {}).reduce((a, b) => a + (+b || 0), 0),
    badges: Object.keys((p && p.ach) || {}).length, items: ((p && p.owned) || []).length,
  };
}
async function adminUsers(env, url) {
  const q = "%" + String(url.searchParams.get("q") || "").toLowerCase().replace(/[%_]/g, "") + "%";
  const { results } = await env.DB.prepare(`
    SELECT u.id, u.username, u.created_at, u.avatar_i, u.avatar_c, p.data, p.at,
      (SELECT COUNT(*) FROM scores s WHERE s.user_id = u.id) AS nscores
    FROM users u LEFT JOIN progress p ON p.user_id = u.id
    WHERE u.username_lc LIKE ? ORDER BY COALESCE(p.at, u.created_at) DESC LIMIT 300
  `).bind(q).all();
  return json({ users: results.map((r) => ({ id: r.id, username: r.username, joined: r.created_at, av: { i: r.avatar_i, c: r.avatar_c }, lastSeen: r.at || r.created_at, scores: r.nscores, admin: isAdminName(r.username, env), ...progSummary(r.data) })) });
}
async function adminUser(env, id) {
  const u = await env.DB.prepare("SELECT id, username, created_at, avatar_i, avatar_c FROM users WHERE id = ?").bind(id).first();
  if (!u) fail(404, "That player doesn't exist.");
  const p = await env.DB.prepare("SELECT data, at FROM progress WHERE user_id = ?").bind(id).first();
  const { results } = await env.DB.prepare("SELECT game, score, at FROM scores WHERE user_id = ? ORDER BY score DESC").bind(id).all();
  let data = null; try { data = p ? JSON.parse(p.data) : null; } catch {}
  return json({ user: { id: u.id, username: u.username, joined: u.created_at, av: { i: u.avatar_i, c: u.avatar_c }, admin: isAdminName(u.username, env) }, progress: data, summary: progSummary(p && p.data), lastSeen: p ? p.at : null, scores: results });
}
async function adminEditUser(request, env, me, id) {
  const b = await readJson(request);
  const u = await env.DB.prepare("SELECT id, username_lc FROM users WHERE id = ?").bind(id).first();
  if (!u) fail(404, "That player doesn't exist.");
  if (b.username != null) {
    const name = cleanName(b.username); checkName(name);
    if (isAdminName(u.username_lc, env) && name.toLowerCase() !== u.username_lc) fail(400, "The admin account keeps its name.");
    const lc = name.toLowerCase();
    if (lc !== u.username_lc && (isAdminName(lc, env) || await env.DB.prepare("SELECT 1 FROM users WHERE username_lc = ?").bind(lc).first())) fail(409, `"${name}" is taken.`);
    await env.DB.prepare("UPDATE users SET username = ?, username_lc = ? WHERE id = ?").bind(name, lc, id).run();
  }
  const keys = ["coins", "cash", "gems", "xp"].filter((k) => b[k] != null);
  if (keys.length || b.giveItems || b.takeItems) {
    const row = await env.DB.prepare("SELECT data FROM progress WHERE user_id = ?").bind(id).first();
    let p = {}; try { p = row ? JSON.parse(row.data) || {} : {}; } catch {}
    p.stats = p.stats || {};
    for (const k of keys) p.stats[k] = Math.floor(num(b[k], 0, 1e9, 0));
    if (Array.isArray(b.giveItems)) p.owned = [...new Set([...(p.owned || []), ...b.giveItems.map(String).slice(0, 300)])];
    if (b.takeItems) { p.owned = []; p.equip = {}; }
    const now = Date.now(); p.stats.wAt = now; p.adminAt = now;
    await env.DB.prepare("INSERT INTO progress (user_id, data, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data").bind(id, JSON.stringify(p), now).run();
  }
  return adminUser(env, id);
}
async function adminReset(request, env, id) {
  const b = await readJson(request), what = String(b.what || "");
  const now = Date.now(), ops = [];
  if (what === "progress" || what === "all") ops.push(env.DB.prepare("INSERT INTO progress (user_id, data, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data").bind(id, JSON.stringify({ adminAt: now, stats: { wAt: now } }), now));
  if (what === "scores" || what === "all") ops.push(env.DB.prepare("DELETE FROM scores WHERE user_id = ?").bind(id), env.DB.prepare("DELETE FROM daily WHERE user_id = ?").bind(id));
  if (!ops.length) fail(400, "Pick what to reset.");
  await env.DB.batch(ops);
  return adminUser(env, id);
}
async function adminDeleteUser(env, me, id) {
  if (id === me.id) fail(400, "You can't delete your own admin account.");
  const u = await env.DB.prepare("SELECT username_lc FROM users WHERE id = ?").bind(id).first();
  if (!u) fail(404, "That player doesn't exist.");
  await env.DB.batch(["sessions", "scores", "progress", "settings", "daily", "submissions", "likes"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE user_id = ?`).bind(id))
    .concat([env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id)]));
  return json({ ok: true });
}
async function adminDeleteScores(request, env) {
  const b = await readJson(request), game = String(b.game || "");
  if (!game) fail(400, "Pick a game.");
  if (b.user) await env.DB.prepare("DELETE FROM scores WHERE game = ? AND user_id = ?").bind(game, +b.user).run();
  else await env.DB.prepare("DELETE FROM scores WHERE game = ?").bind(game).run();
  return json({ ok: true });
}

/* ------------------------------------------------------------------ */
/* Likes: the hearts players give games                                */
/* ------------------------------------------------------------------ */

async function getLikes(env, user) {
  const { results } = await env.DB.prepare("SELECT game, COUNT(*) AS n FROM likes GROUP BY game").all();
  const counts = {}; for (const r of results) counts[r.game] = r.n;
  let mine = [];
  if (user) mine = (await env.DB.prepare("SELECT game FROM likes WHERE user_id = ?").bind(user.id).all()).results.map((r) => r.game);
  return json({ counts, mine });
}
// Helper notes from games about touches (to fix phone and iPad problems). Only the newest 80 are kept.
async function postDiag(request, env, user) {
  await limit(env, "diag:" + clientIp(request), 120, HOUR, "Slow down a little.");
  const text = await request.text();
  if (text.length > 4000) fail(413, "Too big.");
  await env.DB.prepare("INSERT INTO diag (at, who, body) VALUES (?, ?, ?)").bind(Date.now(), user ? user.username : null, text).run();
  await env.DB.prepare("DELETE FROM diag WHERE id <= (SELECT MAX(id) FROM diag) - 80").run();
  return json({ ok: true });
}
async function getDiag(env) {
  const r = await env.DB.prepare("SELECT id, at, who, body FROM diag ORDER BY id DESC LIMIT 40").all();
  return json({ notes: r.results || [] }, 200, { "cache-control": "no-store" });
}

async function postLike(request, env, user) {
  if (!user) fail(401, "Log in to heart games.");
  await limit(env, "like:" + user.id, 60, MIN, "Slow down a little.");
  const b = await readJson(request), game = String(b.game || "");
  if (!BUILTIN_GAMES.has(game)) fail(400, "Unknown game.");
  if (b.on) await env.DB.prepare("INSERT OR IGNORE INTO likes (user_id, game) VALUES (?, ?)").bind(user.id, game).run();
  else await env.DB.prepare("DELETE FROM likes WHERE user_id = ? AND game = ?").bind(user.id, game).run();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM likes WHERE game = ?").bind(game).first();
  return json({ game, n: r.n });
}

/* ------------------------------------------------------------------ */
/* Help / Requests                                                      */
/* ------------------------------------------------------------------ */
async function submitHelp(request, env, user) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const rk = "help:" + (user ? "u" + user.id : "ip" + ip);
  await limit(env, rk, 5, 60 * 60 * 1000, "You've sent too many requests lately. Try again in an hour.");
  const b = await readJson(request);
  const msg = String(b.msg || "").trim().slice(0, 500);
  if (msg.length < 3) fail(400, "Please type your request.");
  const username = user ? user.username : (String(b.name || "").trim().slice(0, 30) || "Guest");
  const uid = user ? user.id : null;
  await env.DB.prepare("INSERT INTO help_requests (user_id, username, msg, ts, status, admin_note) VALUES (?, ?, ?, ?, 'new', '')").bind(uid, username, msg, Date.now()).run();
  return json({ ok: true });
}
async function adminListHelp(env) {
  const r = await env.DB.prepare("SELECT id, user_id, username, msg, ts, status, admin_note FROM help_requests ORDER BY ts DESC LIMIT 200").all();
  return json({ requests: r.results || [] });
}
async function adminPatchHelp(request, env, id) {
  const b = await readJson(request);
  const status = ["new", "seen", "done", "dismissed"].includes(b.status) ? b.status : null;
  const note = b.admin_note !== undefined ? String(b.admin_note).trim().slice(0, 300) : null;
  if (status) await env.DB.prepare("UPDATE help_requests SET status = ? WHERE id = ?").bind(status, id).run();
  if (note !== null) await env.DB.prepare("UPDATE help_requests SET admin_note = ? WHERE id = ?").bind(note, id).run();
  return json({ ok: true });
}
async function adminDeleteHelp(env, id) {
  await env.DB.prepare("DELETE FROM help_requests WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
