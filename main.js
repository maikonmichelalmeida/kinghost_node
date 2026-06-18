//acesso ao banco de dados: mysql2/promise
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const mysql = require("mysql2/promise");
const path = require("path");

loadLocalEnv();

const port = Number(process.env.PORT || process.env.NODE_PORT || process.argv[2] || 21106);
const staticRoot = findStaticRoot();
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const dbConfig = {
  host: process.env.DB_HOST || "mysql.uergs2024.kinghost.net",
  user: process.env.DB_USER || "uergs2024",
  password: requiredEnv("DB_PASSWORD"),
  database: process.env.DB_NAME || "uergs2024",
  port: Number(process.env.DB_PORT || 3306),
  charset: "utf8mb4"
};

const ADMIN_PASSWORD = requiredEnv("ADMIN_PASSWORD");
const TOKEN_SECRET = requiredEnv("TOKEN_SECRET");
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function loadLocalEnv() {
  const envPaths = [
    path.join(__dirname, "config.local.env"),
    path.join(__dirname, ".env")
  ];

  envPaths.forEach((envPath) => {
    if (!fs.existsSync(envPath)) return;
    loadEnvFile(envPath);
  });
}

function loadEnvFile(envPath) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine.startsWith("#")) return;

    const separatorIndex = cleanLine.indexOf("=");
    if (separatorIndex === -1) return;

    const key = cleanLine.slice(0, separatorIndex).trim();
    const rawValue = cleanLine.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) return;

    process.env[key] = unquoteEnvValue(rawValue);
  });
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Variavel de ambiente obrigatoria ausente: ${name}`);
  }
  return value;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const apiPath = getApiPath(url.pathname);

    if (apiPath) {
      await handleApi(request, response, apiPath);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Metodo nao permitido." });
      return;
    }

    await serveStatic(request, response, url.pathname);
  } catch (error) {
    sendJson(response, 500, { error: error.message || "Erro interno." });
  }
});

start();

async function start() {
  ensureTable().catch((error) => {
    console.error("Nao foi possivel garantir a tabela lessons:", error.message);
  });
  server.listen(port, () => {
    console.log(`Aplicacao rodando na porta ${port}`);
    console.log(`Arquivos estaticos: ${staticRoot || "nao encontrados"}`);
  });
}

async function handleApi(request, response, apiPath) {
  if (request.method === "OPTIONS") {
    sendJson(response, 200, { ok: true });
    return;
  }

  if (apiPath === "/api/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body.password || body.password !== ADMIN_PASSWORD) {
      sendJson(response, 401, { error: "Chave invalida." });
      return;
    }
    sendJson(response, 200, { token: createToken() });
    return;
  }

  const publicLessonIdMatch = apiPath.match(/^\/api\/public\/lessons\/(\d+)$/);

  if (apiPath === "/api/public/lessons" && request.method === "GET") {
    const connection = await openDb();
    const [rows] = await connection.query(
      "SELECT id, title, video_url, created_at, updated_at FROM lessons ORDER BY updated_at DESC, id DESC"
    );
    await connection.end();
    sendJson(response, 200, rows);
    return;
  }

  if (publicLessonIdMatch && request.method === "GET") {
    const id = Number(publicLessonIdMatch[1]);
    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT id, title, video_url, json_content, created_at, updated_at FROM lessons WHERE id = ?",
      [id]
    );
    await connection.end();
    if (!rows.length) {
      sendJson(response, 404, { error: "Aula nao encontrada." });
      return;
    }
    sendJson(response, 200, rows[0]);
    return;
  }

  const tokenPayload = readAuthToken(request);
  if (!tokenPayload) {
    sendJson(response, 401, { error: "Login necessario." });
    return;
  }

  if (apiPath === "/api/session" && request.method === "GET") {
    sendJson(response, 200, { ok: true, exp: tokenPayload.exp });
    return;
  }

  const lessonIdMatch = apiPath.match(/^\/api\/lessons\/(\d+)$/);

  if (apiPath === "/api/lessons" && request.method === "GET") {
    const connection = await openDb();
    const [rows] = await connection.query(
      "SELECT id, title, video_url, created_at, updated_at FROM lessons ORDER BY updated_at DESC, id DESC"
    );
    await connection.end();
    sendJson(response, 200, rows);
    return;
  }

  if (apiPath === "/api/lessons" && request.method === "POST") {
    const { jsonContent } = await readJsonBody(request);
    const lesson = extractLessonMetadata(jsonContent);
    const connection = await openDb();
    const [result] = await connection.execute(
      "INSERT INTO lessons (title, video_url, json_content) VALUES (?, ?, ?)",
      [lesson.title, lesson.videoUrl, jsonContent]
    );
    await connection.end();
    sendJson(response, 201, { id: result.insertId, title: lesson.title, video_url: lesson.videoUrl });
    return;
  }

  if (lessonIdMatch && request.method === "GET") {
    const id = Number(lessonIdMatch[1]);
    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT id, title, video_url, json_content, created_at, updated_at FROM lessons WHERE id = ?",
      [id]
    );
    await connection.end();
    if (!rows.length) {
      sendJson(response, 404, { error: "Aula nao encontrada." });
      return;
    }
    sendJson(response, 200, rows[0]);
    return;
  }

  if (lessonIdMatch && request.method === "PUT") {
    const id = Number(lessonIdMatch[1]);
    const { jsonContent } = await readJsonBody(request);
    const lesson = extractLessonMetadata(jsonContent);
    const connection = await openDb();
    const [result] = await connection.execute(
      "UPDATE lessons SET title = ?, video_url = ?, json_content = ? WHERE id = ?",
      [lesson.title, lesson.videoUrl, jsonContent, id]
    );
    await connection.end();
    if (!result.affectedRows) {
      sendJson(response, 404, { error: "Aula nao encontrada." });
      return;
    }
    sendJson(response, 200, { id, title: lesson.title, video_url: lesson.videoUrl });
    return;
  }

  if (lessonIdMatch && request.method === "DELETE") {
    const id = Number(lessonIdMatch[1]);
    const connection = await openDb();
    const [result] = await connection.execute("DELETE FROM lessons WHERE id = ?", [id]);
    await connection.end();
    if (!result.affectedRows) {
      sendJson(response, 404, { error: "Aula nao encontrada." });
      return;
    }
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Endpoint nao encontrado." });
}

function getApiPath(pathname) {
  if (pathname === "/public/lessons" || pathname.startsWith("/public/lessons/")) {
    return `/api${pathname}`;
  }
  if (
    pathname === "/login" ||
    pathname === "/session" ||
    pathname === "/lessons" ||
    pathname.startsWith("/lessons/")
  ) {
    return `/api${pathname}`;
  }

  const index = pathname.indexOf("/api/");
  if (index !== -1) {
    return pathname.slice(index);
  }
  return pathname === "/api" ? "/api" : "";
}

function findStaticRoot() {
  const candidates = [
    path.join(__dirname, "outputs"),
    path.resolve(__dirname, ".."),
    path.join(process.cwd(), "outputs"),
    process.cwd()
  ];

  const root = candidates.find((candidate) => {
    return fs.existsSync(path.join(candidate, "app.js")) && fs.existsSync(path.join(candidate, "style.css"));
  });

  return root ? path.resolve(root) : "";
}

async function serveStatic(request, response, pathname) {
  if (!staticRoot) {
    sendText(response, 404, "Arquivos estaticos nao encontrados.");
    return;
  }

  const filePath = resolveStaticPath(pathname);
  if (!filePath) {
    sendText(response, 403, "Acesso negado.");
    return;
  }

  let stats = null;
  try {
    stats = await fs.promises.stat(filePath);
  } catch {
    const fallbackIndex = isIndexRequest(pathname) ? await findIndexFile(staticRoot) : "";
    if (fallbackIndex) {
      await sendStaticFile(request, response, fallbackIndex);
      return;
    }
    sendText(response, 404, "Arquivo nao encontrado.");
    return;
  }

  const finalPath = stats.isDirectory() ? await findIndexFile(filePath) : filePath;
  if (!finalPath) {
    sendText(response, 404, "Arquivo nao encontrado.");
    return;
  }

  await sendStaticFile(request, response, finalPath);
}

async function sendStaticFile(request, response, filePath) {
  const contentType = contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  fs.createReadStream(filePath).pipe(response);
}

function resolveStaticPath(pathname) {
  let relativePath = decodeURIComponent(pathname).replace(/\\/g, "/");
  if (relativePath === "/" || relativePath === "") {
    relativePath = "/index.htm";
  }
  if (relativePath === "/outputs" || relativePath === "/outputs/") {
    relativePath = "/index.htm";
  }
  if (relativePath.startsWith("/outputs/")) {
    relativePath = relativePath.slice("/outputs".length);
  }

  const filePath = path.resolve(staticRoot, `.${relativePath}`);
  return isInsideStaticRoot(filePath) ? filePath : "";
}

function isIndexRequest(pathname) {
  const normalized = decodeURIComponent(pathname).replace(/\\/g, "/");
  return normalized === "/" ||
    normalized === "/outputs" ||
    normalized === "/outputs/" ||
    normalized.endsWith("/index.htm") ||
    normalized.endsWith("/index.html");
}

function isInsideStaticRoot(filePath) {
  const relative = path.relative(staticRoot, filePath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function findIndexFile(directoryPath) {
  const candidates = ["index.htm", "index.html", "fabrica.htm"];
  for (const filename of candidates) {
    const filePath = path.join(directoryPath, filename);
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.isFile()) {
        return filePath;
      }
    } catch {
      // Try the next conventional entry file.
    }
  }
  return "";
}

async function openDb() {
  return mysql.createConnection(dbConfig);
}

async function ensureTable() {
  const connection = await openDb();
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS lessons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      video_url TEXT NOT NULL,
      json_content LONGTEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await connection.end();
}

async function readJsonBody(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 25 * 1024 * 1024) {
      throw new Error("Conteudo grande demais.");
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function extractLessonMetadata(jsonContent) {
  if (!jsonContent || typeof jsonContent !== "string" || !jsonContent.trim()) {
    throw new Error("Cole um JSON antes de salvar.");
  }

  let parsed = null;
  try {
    parsed = JSON.parse(stripBom(jsonContent.trim()));
  } catch {
    parsed = null;
  }

  const title = parsed && parsed.title ? String(parsed.title).trim() : extractStringField(jsonContent, "title");
  const videoUrl = parsed && parsed.videoUrl
    ? String(parsed.videoUrl).trim()
    : extractStringField(jsonContent, "videoUrl");

  if (!title) {
    throw new Error('Nao encontrei o campo "title" no JSON.');
  }
  if (!videoUrl) {
    throw new Error('Nao encontrei o campo "videoUrl" no JSON.');
  }

  return { title, videoUrl };
}

function extractStringField(text, key) {
  const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]*)"`, "i"));
  return match ? unescapeLooseString(match[1].trim()) : "";
}

function createToken() {
  const payload = {
    sub: "factory",
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: crypto.randomBytes(12).toString("hex")
  };
  return encryptToken(JSON.stringify(payload));
}

function readAuthToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  try {
    const payload = JSON.parse(decryptToken(match[1]));
    if (!payload || payload.sub !== "factory" || Number(payload.exp) < Date.now()) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function encryptToken(text) {
  const iv = crypto.randomBytes(12);
  const key = crypto.createHash("sha256").update(TOKEN_SECRET).digest();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map(base64UrlEncode).join(".");
}

function decryptToken(token) {
  const [ivText, tagText, encryptedText] = token.split(".");
  if (!ivText || !tagText || !encryptedText) {
    throw new Error("Token invalido.");
  }

  const key = crypto.createHash("sha256").update(TOKEN_SECRET).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, base64UrlDecode(ivText));
  decipher.setAuthTag(base64UrlDecode(tagText));
  return Buffer.concat([
    decipher.update(base64UrlDecode(encryptedText)),
    decipher.final()
  ]).toString("utf8");
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(text) {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="), "base64");
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS"
  });
  response.end(JSON.stringify(data));
}

function sendText(response, statusCode, text) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(text);
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unescapeLooseString(value) {
  return String(value)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t");
}
