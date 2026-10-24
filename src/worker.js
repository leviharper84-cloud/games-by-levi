/**
 * Games by Levi - server.
 * A Cloudflare Worker that serves the site from ./public and answers /api/*
 * with accounts, leaderboards and game submissions stored in a D1 database.
 */

const BUILTIN_GAMES = new Set(["snake", "bricks", "pong", "blaster", "flap", "2048", "memory", "runner", "racer", "blocks", "targets", "golf", "pingpong", "void", "muncher", "missile", "storm", "slice", "mines", "slide", "gems", "tunnel", "drift", "hop", "flip", "quest", "hoops", "penalty", "tower", "connect4", "reversi", "beat", "simon"]);
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
