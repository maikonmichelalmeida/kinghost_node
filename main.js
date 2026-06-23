//Maikon Michel, 2026
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const mysql = require("mysql2/promise");
const path = require("path");

loadLocalEnv();

const DEPLOY_CHECK = "node-2026-06-23-vocabulary-level-4";
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
const DOMINO_PLAYERS = 4;
const DOMINO_INPUT_SIZE = 203;
const DOMINO_LAYER_SIZES = [DOMINO_INPUT_SIZE, 96, 64, 32, 16, 1];
const DOMINO_TILE_COUNT = 28;
const DOMINO_BELIEF_INPUT_SIZE = 165;
const DOMINO_BELIEF_OUTPUT_SIZE = DOMINO_PLAYERS * 7 + DOMINO_PLAYERS * DOMINO_TILE_COUNT;
const DOMINO_BELIEF_LAYER_SIZES = [DOMINO_BELIEF_INPUT_SIZE, 96, 64, DOMINO_BELIEF_OUTPUT_SIZE];
const DOMINO_DEFAULT_BRAIN_BASE = "basico";

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
  try {
    await ensureTable();
  } catch (error) {
    console.error("Nao foi possivel garantir as tabelas:", error.message);
  }
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

  if (apiPath === "/api/health" && request.method === "GET") {
    sendJson(response, 200, { ok: true, deployCheck: DEPLOY_CHECK });
    return;
  }

  if (apiPath === "/api/domino/brains" && request.method === "GET") {
    const connection = await openDb();
    try {
      await ensureDominoDefaultBrains(connection);
      const [rows] = await connection.execute(
        "SELECT id, nome, json_conteudo, data_ultima_atualizacao, data_inclusao, tempo_treino FROM JSON_conteudos ORDER BY nome"
      );
      sendJson(response, 200, { brains: dominoBrainOptions(rows) });
    } finally {
      await connection.end();
    }
    return;
  }

  const dominoBrainMatch = apiPath.match(/^\/api\/domino\/brains\/([1-4])\/([^/]+)$/);
  if (dominoBrainMatch && request.method === "GET") {
    const player = Number(dominoBrainMatch[1]);
    const baseName = sanitizeDominoBrainBase(decodeURIComponent(dominoBrainMatch[2]));
    const nome = `${baseName}J${player}`;
    const connection = await openDb();
    try {
      await ensureDominoDefaultBrains(connection);
      const row = await readDominoBrainRow(connection, nome);
      if (!row) {
        sendJson(response, 404, { error: "Cerebro nao encontrado." });
        return;
      }
      sendJson(response, 200, dominoBrainPayload(row));
    } finally {
      await connection.end();
    }
    return;
  }

  if (apiPath === "/api/domino/brains" && request.method === "POST") {
    const body = await readJsonBody(request);
    const player = clampInteger(body.player, 1, DOMINO_PLAYERS, 1);
    const baseName = sanitizeDominoBrainBase(body.nome || body.baseName || "");
    const nome = `${baseName}J${player}`;
    const connection = await openDb();
    try {
      await ensureDominoDefaultBrains(connection);
      const existing = await readDominoBrainRow(connection, nome);
      if (existing) {
        sendJson(response, 409, { error: "Esse cerebro ja existe.", brain: dominoBrainPayload(existing) });
        return;
      }
      const brain = createDominoBrain();
      await insertDominoBrain(connection, nome, brain, 0);
      const row = await readDominoBrainRow(connection, nome);
      const parsed = parseDominoBrainName(row.nome);
      sendJson(response, 201, {
        id: row.id,
        nome: row.nome,
        baseName: parsed.baseName,
        player: parsed.player,
        tempoTreino: Number(row.tempo_treino) || 0,
        dataUltimaAtualizacao: row.data_ultima_atualizacao,
        dataInclusao: row.data_inclusao
      });
    } finally {
      await connection.end();
    }
    return;
  }

  if (apiPath === "/api/domino/brains" && request.method === "PUT") {
    const body = await readJsonBody(request);
    const items = Array.isArray(body.items) ? body.items : [];
    if (items.length === 0) {
      sendJson(response, 400, { error: "Nenhum cerebro informado." });
      return;
    }
    const connection = await openDb();
    try {
      await ensureDominoDefaultBrains(connection);
      await connection.beginTransaction();
      for (const item of items) {
        const player = clampInteger(item.player, 1, DOMINO_PLAYERS, 1);
        const baseName = sanitizeDominoBrainBase(item.baseName || baseNameFromDominoBrainName(item.nome));
        const nome = `${baseName}J${player}`;
        const brain = normalizeDominoBrainForStorage(item.brain);
        const tempoTreino = Math.max(0, Number.parseInt(item.tempoTreino, 10) || 0);
        await connection.execute(
          `UPDATE JSON_conteudos
             SET json_conteudo = ?, tempo_treino = ?, data_ultima_atualizacao = CURRENT_TIMESTAMP
           WHERE nome = ?`,
          [JSON.stringify(brain), tempoTreino, nome]
        );
      }
      await connection.commit();
      sendJson(response, 200, { ok: true });
    } catch (error) {
      try {
        await connection.rollback();
      } catch {
        // Keep the original database error visible to the caller.
      }
      throw error;
    } finally {
      await connection.end();
    }
    return;
  }

  if (apiPath === "/api/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    if (!body.password || body.password !== ADMIN_PASSWORD) {
      sendJson(response, 401, { error: "Chave invalida." });
      return;
    }
    sendJson(response, 200, { token: createFactoryToken() });
    return;
  }

  if (apiPath === "/api/user/login" && request.method === "POST") {
    const body = await readJsonBody(request);
    const nick = String(body.nick || "").trim();
    const password = String(body.password || "");
    if (!nick || !password) {
      sendJson(response, 400, { error: "Informe usuario e senha." });
      return;
    }

    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT id, nick, senha FROM usuario WHERE nick = ? LIMIT 1",
      [nick]
    );
    await connection.end();

    const user = rows[0];
    if (!user || !safeTextEqual(password, user.senha)) {
      sendJson(response, 401, { error: "Usuario ou senha invalidos." });
      return;
    }

    sendJson(response, 200, {
      token: createUserToken(user),
      user: { id: user.id, nick: user.nick }
    });
    return;
  }

  if (apiPath === "/api/user/session" && request.method === "GET") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }

    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT id, nick FROM usuario WHERE id = ? LIMIT 1",
      [userToken.userId]
    );
    await connection.end();
    if (!rows.length) {
      sendJson(response, 401, { error: "Usuario nao encontrado." });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      exp: userToken.exp,
      user: rows[0]
    });
    return;
  }

  if (apiPath === "/api/user/context" && request.method === "GET") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }

    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT json_contexto FROM usuario WHERE id = ? LIMIT 1",
      [userToken.userId]
    );
    await connection.end();
    if (!rows.length) {
      sendJson(response, 401, { error: "Usuario nao encontrado." });
      return;
    }

    sendJson(response, 200, { context: parseUserContext(rows[0].json_contexto) });
    return;
  }

  if (apiPath === "/api/user/context" && request.method === "PUT") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }

    const { context } = await readJsonBody(request);
    if (context !== null && (!context || typeof context !== "object" || Array.isArray(context))) {
      sendJson(response, 400, { error: "Contexto invalido." });
      return;
    }

    const serialized = context === null ? null : JSON.stringify(context);
    if (serialized && Buffer.byteLength(serialized, "utf8") > 2 * 1024 * 1024) {
      sendJson(response, 413, { error: "Contexto grande demais." });
      return;
    }

    const connection = await openDb();
    const [result] = await connection.execute(
      "UPDATE usuario SET json_contexto = ? WHERE id = ?",
      [serialized, userToken.userId]
    );
    await connection.end();
    if (!result.affectedRows) {
      sendJson(response, 401, { error: "Usuario nao encontrado." });
      return;
    }

    sendJson(response, 200, { ok: true });
    return;
  }

  if (apiPath === "/api/user/vocabulary" && request.method === "POST") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }

    const body = await readJsonBody(request);
    const writing = normalizeVocabularyWriting(body.writing);
    if (!writing || !/[\p{L}\p{N}]/u.test(writing)) {
      sendJson(response, 400, { error: "Informe uma palavra ou expressao valida." });
      return;
    }
    if (writing.length > 255) {
      sendJson(response, 400, { error: "A palavra ou expressao deve ter no maximo 255 caracteres." });
      return;
    }

    const connection = await openDb();
    try {
      await connection.beginTransaction();
      const [userRows] = await connection.execute(
        "SELECT id FROM usuario WHERE id = ? LIMIT 1",
        [userToken.userId]
      );
      if (!userRows.length) {
        await connection.rollback();
        sendJson(response, 401, { error: "Usuario nao encontrado." });
        return;
      }

      const resolution = await resolveVocabularyForStudy(connection, writing);
      const vocabulary = resolution.vocabulary;
      const [existingLinks] = await connection.execute(
        "SELECT 1 FROM estuda_palavra WHERE usuario_id = ? AND vocabulario_id = ? LIMIT 1",
        [userToken.userId, vocabulary.id]
      );
      const restarted = existingLinks.length > 0;
      await connection.execute(
        `INSERT INTO estuda_palavra
          (usuario_id, vocabulario_id, nivel, score, created_at, updated_at)
        VALUES (?, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          nivel = 0,
          score = 0,
          created_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP`,
        [userToken.userId, vocabulary.id]
      );
      await connection.execute(
        "UPDATE usuario SET contexto_vocabulario_json = NULL, data_ultimo_treino = '2000-01-01 00:00:00' WHERE id = ?",
        [userToken.userId]
      );

      const [studyQueue] = await connection.execute(
        `SELECT
          v.id,
          v.escrita,
          ep.nivel,
          ep.score,
          ep.created_at
        FROM estuda_palavra ep
        INNER JOIN vocabulario v ON v.id = ep.vocabulario_id
        WHERE ep.usuario_id = ? AND ep.nivel < ?
        ORDER BY ep.nivel ASC, ep.score ASC, ep.created_at ASC, v.id ASC`,
        [userToken.userId, VOCABULARY_GRADUATED_LEVEL]
      );

      await connection.commit();
      sendJson(response, resolution.created ? 201 : 200, {
        ok: true,
        created: resolution.created,
        queued: resolution.queued,
        linked: !restarted,
        restarted,
        requestedWriting: writing,
        resolvedFromDerivative: resolution.resolvedFromDerivative,
        vocabulary: {
          id: vocabulary.id,
          writing: vocabulary.escrita,
          ready: vocabulary.significado !== null
        },
        studyQueue: studyQueue.map((item) => ({
          id: item.id,
          writing: item.escrita,
          level: item.nivel,
          score: item.score,
          createdAt: item.created_at
        }))
      });
      return;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  const publicLessonIdMatch = apiPath.match(/^\/api\/public\/lessons\/(\d+)$/);
  const publicLeituraIdMatch = apiPath.match(/^\/api\/public\/leitura\/(\d+)$/);

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

  if (apiPath === "/api/public/leituras" && request.method === "GET") {
    const connection = await openDb();
    const [rows] = await connection.query(
      "SELECT id, titulo FROM leitura ORDER BY id DESC"
    );
    await connection.end();
    sendJson(response, 200, rows);
    return;
  }

  if ((apiPath === "/api/public/leitura" || publicLeituraIdMatch) && request.method === "GET") {
    const requestUrl = new URL(request.url, "http://localhost");
    const id = publicLeituraIdMatch
      ? Number(publicLeituraIdMatch[1])
      : Number(requestUrl.searchParams.get("id") || 0);
    const titulo = String(requestUrl.searchParams.get("titulo") || "").trim();
    const connection = await openDb();
    let rows = [];

    if (id > 0) {
      [rows] = await connection.execute(
        "SELECT id, titulo, json_content FROM leitura WHERE id = ? LIMIT 1",
        [id]
      );
    } else if (titulo) {
      [rows] = await connection.execute(
        "SELECT id, titulo, json_content FROM leitura WHERE titulo = ? LIMIT 1",
        [titulo]
      );
    } else {
      [rows] = await connection.query(
        "SELECT id, titulo, json_content FROM leitura ORDER BY id DESC LIMIT 1"
      );
    }

    await connection.end();
    if (!rows.length) {
      sendJson(response, 404, { error: "Leitura nao encontrada." });
      return;
    }

    sendJson(response, 200, formatLeituraRow(rows[0]));
    return;
  }

  const isUserTrainingRoute = apiPath === "/api/user/vocabulary-training" ||
    apiPath === "/api/user/vocabulary-training/answer" ||
    apiPath === "/api/user/vocabulary-training/reveal" ||
    apiPath === "/api/user/vocabulary-settings";
  const tokenPayload = isUserTrainingRoute ? null : readAuthToken(request);
  if (!isUserTrainingRoute && !tokenPayload) {
    sendJson(response, 401, { error: "Login necessario." });
    return;
  }

  if (apiPath === "/api/session" && request.method === "GET") {
    sendJson(response, 200, { ok: true, exp: tokenPayload.exp });
    return;
  }

  if (apiPath === "/api/vocabulary/pending" && request.method === "GET") {
    const connection = await openDb();
    const [rows] = await connection.query(
      "SELECT id, escrita, created_at FROM fila_vocabulario ORDER BY created_at ASC, id ASC"
    );
    await connection.end();
    sendJson(response, 200, {
      items: rows.map((item) => ({
        id: item.id,
        writing: item.escrita,
        createdAt: item.created_at
      }))
    });
    return;
  }

  if (apiPath === "/api/user/vocabulary-training" && request.method === "GET") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }

    const connection = await openDb();
    try {
      await connection.beginTransaction();
      const training = await getOrBuildVocabularyTraining(connection, userToken.userId);
      await connection.commit();
      sendJson(response, 200, { training: publicVocabularyTraining(training) });
      return;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
  }

  if (apiPath === "/api/user/vocabulary-training/answer" && request.method === "POST") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }

    const body = await readJsonBody(request);
    const exerciseId = String(body.exerciseId || "").trim();
    const answer = String(body.answer || "").trim();
    if (!exerciseId || !answer) {
      sendJson(response, 400, { error: "Informe o exercicio e a resposta." });
      return;
    }

    const connection = await openDb();
    try {
      await connection.beginTransaction();
      const result = await answerVocabularyExercise(connection, userToken.userId, exerciseId, answer);
      await connection.commit();
      sendJson(response, 200, result);
      return;
    } catch (error) {
      await connection.rollback();
      const status = Number(error.statusCode || 500);
      if (status < 500) {
        sendJson(response, status, { error: error.message });
        return;
      }
      throw error;
    } finally {
      await connection.end();
    }
  }

  if (apiPath === "/api/user/vocabulary-training/reveal" && request.method === "POST") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }
    const body = await readJsonBody(request);
    const exerciseId = String(body.exerciseId || "").trim();
    if (!exerciseId) {
      sendJson(response, 400, { error: "Informe o exercicio." });
      return;
    }

    const connection = await openDb();
    try {
      await connection.beginTransaction();
      const result = await revealVocabularyExercise(connection, userToken.userId, exerciseId);
      await connection.commit();
      sendJson(response, 200, result);
      return;
    } catch (error) {
      await connection.rollback();
      const status = Number(error.statusCode || 500);
      if (status < 500) {
        sendJson(response, status, { error: error.message });
        return;
      }
      throw error;
    } finally {
      await connection.end();
    }
  }

  if (apiPath === "/api/user/vocabulary-settings" && request.method === "GET") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }
    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT palavras_por_dia, narracao_feedback FROM usuario WHERE id = ? LIMIT 1",
      [userToken.userId]
    );
    await connection.end();
    if (!rows.length) {
      sendJson(response, 401, { error: "Usuario nao encontrado." });
      return;
    }
    sendJson(response, 200, {
      wordsPerDay: Number(rows[0].palavras_por_dia),
      narrationEnabled: Boolean(rows[0].narracao_feedback)
    });
    return;
  }

  if (apiPath === "/api/user/vocabulary-settings" && request.method === "PUT") {
    const userToken = readUserAuthToken(request);
    if (!userToken) {
      sendJson(response, 401, { error: "Login necessario." });
      return;
    }
    const body = await readJsonBody(request);
    const hasWordsPerDay = Object.prototype.hasOwnProperty.call(body, "wordsPerDay");
    const hasNarration = Object.prototype.hasOwnProperty.call(body, "narrationEnabled");
    const wordsPerDay = Number(body.wordsPerDay);
    if (hasWordsPerDay && (!Number.isInteger(wordsPerDay) || wordsPerDay < 1 || wordsPerDay > 50)) {
      sendJson(response, 400, { error: "Escolha entre 1 e 50 palavras por nivel." });
      return;
    }
    if (hasNarration && typeof body.narrationEnabled !== "boolean") {
      sendJson(response, 400, { error: "Preferencia de narracao invalida." });
      return;
    }
    if (!hasWordsPerDay && !hasNarration) {
      sendJson(response, 400, { error: "Nenhuma preferencia informada." });
      return;
    }
    const connection = await openDb();
    const [rows] = await connection.execute(
      "SELECT palavras_por_dia, narracao_feedback FROM usuario WHERE id = ? LIMIT 1",
      [userToken.userId]
    );
    if (!rows.length) {
      await connection.end();
      sendJson(response, 401, { error: "Usuario nao encontrado." });
      return;
    }
    const nextWordsPerDay = hasWordsPerDay ? wordsPerDay : Number(rows[0].palavras_por_dia);
    const nextNarration = hasNarration ? body.narrationEnabled : Boolean(rows[0].narracao_feedback);
    const wordsChanged = nextWordsPerDay !== Number(rows[0].palavras_por_dia);
    await connection.execute(
      `UPDATE usuario
      SET palavras_por_dia = ?,
        narracao_feedback = ?,
        contexto_vocabulario_json = CASE WHEN ? THEN NULL ELSE contexto_vocabulario_json END,
        data_ultimo_treino = CASE WHEN ? THEN '2000-01-01 00:00:00' ELSE data_ultimo_treino END
      WHERE id = ?`,
      [nextWordsPerDay, nextNarration ? 1 : 0, wordsChanged ? 1 : 0, wordsChanged ? 1 : 0, userToken.userId]
    );
    await connection.end();
    sendJson(response, 200, {
      ok: true,
      wordsPerDay: nextWordsPerDay,
      narrationEnabled: nextNarration,
      trainingReset: wordsChanged
    });
    return;
  }

  if (apiPath === "/api/vocabulary/process" && request.method === "POST") {
    const { jsonContent } = await readJsonBody(request);
    let payload = null;
    try {
      payload = parseVocabularyProcessingJson(jsonContent);
    } catch (error) {
      sendJson(response, 400, { error: error.message });
      return;
    }

    const connection = await openDb();
    try {
      await connection.beginTransaction();
      const result = await processVocabularyPayload(connection, payload);
      const pendingItems = await readPendingVocabulary(connection);
      await connection.commit();
      sendJson(response, 200, { ok: true, ...result, pendingItems });
      return;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.end();
    }
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
    pathname === "/user/login" ||
    pathname === "/user/session" ||
    pathname === "/user/context" ||
    pathname === "/user/vocabulary" ||
    pathname === "/user/vocabulary-training" ||
    pathname === "/user/vocabulary-training/answer" ||
    pathname === "/user/vocabulary-training/reveal" ||
    pathname === "/user/vocabulary-settings" ||
    pathname === "/vocabulary/pending" ||
    pathname === "/vocabulary/process" ||
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
    path.resolve(__dirname, "..", "www", "domino"),
    path.join(__dirname, "outputs"),
    path.resolve(__dirname, ".."),
    path.join(process.cwd(), "outputs"),
    process.cwd()
  ];

  const root = candidates.find((candidate) => {
    return fs.existsSync(path.join(candidate, "app.js")) &&
      (fs.existsSync(path.join(candidate, "style.css")) || fs.existsSync(path.join(candidate, "styles.css")));
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
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS leitura (
      id INT AUTO_INCREMENT PRIMARY KEY,
      titulo VARCHAR(255) NOT NULL,
      json_content LONGTEXT NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS JSON_conteudos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(255) NOT NULL,
      json_conteudo LONGTEXT NOT NULL,
      data_ultima_atualizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      data_inclusao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      tempo_treino BIGINT UNSIGNED NOT NULL DEFAULT 0,
      UNIQUE KEY uq_JSON_conteudos_nome (nome)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS derivados (
      id INT AUTO_INCREMENT PRIMARY KEY,
      derivado VARCHAR(255) NOT NULL,
      primitivo_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_derivados_derivado (derivado),
      KEY idx_derivados_primitivo (primitivo_id),
      CONSTRAINT fk_derivados_primitivo
        FOREIGN KEY (primitivo_id) REFERENCES vocabulario(id)
        ON DELETE CASCADE ON UPDATE CASCADE
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
  `);
  await connection.execute(`
    ALTER TABLE usuario
      ADD COLUMN IF NOT EXISTS palavras_por_dia SMALLINT UNSIGNED NOT NULL DEFAULT 5,
      ADD COLUMN IF NOT EXISTS data_ultimo_treino DATETIME NOT NULL DEFAULT '2000-01-01 00:00:00',
      ADD COLUMN IF NOT EXISTS contexto_vocabulario_json LONGTEXT NULL,
      ADD COLUMN IF NOT EXISTS narracao_feedback TINYINT(1) NOT NULL DEFAULT 1
  `);
  await connection.execute(`
    ALTER TABLE exemplo
      ADD COLUMN IF NOT EXISTS resposta LONGTEXT NULL AFTER traducao
  `);
  await connection.execute(`
    ALTER TABLE estuda_palavra
      MODIFY COLUMN score SMALLINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS ultima_revisao DATETIME NULL AFTER score
  `);
  await connection.execute(`
    ALTER TABLE estuda_palavra
      DROP CONSTRAINT IF EXISTS chk_estuda_palavra_score
  `);
  await connection.execute(`
    ALTER TABLE estuda_palavra
      ADD CONSTRAINT chk_estuda_palavra_score CHECK (score BETWEEN -1000 AND 100)
  `);
  await connection.execute(`
    ALTER TABLE estuda_palavra
      DROP CONSTRAINT IF EXISTS chk_estuda_palavra_nivel
  `);
  await connection.execute(`
    ALTER TABLE estuda_palavra
      ADD CONSTRAINT chk_estuda_palavra_nivel CHECK (nivel BETWEEN 0 AND 4)
  `);
  await connection.end();
}

async function ensureDominoDefaultBrains(connection) {
  for (let player = 1; player <= DOMINO_PLAYERS; player += 1) {
    const nome = `${DOMINO_DEFAULT_BRAIN_BASE}J${player}`;
    const existing = await readDominoBrainRow(connection, nome);
    if (!existing) {
      await insertDominoBrain(connection, nome, createDominoBrain(), 0);
    }
  }
}

async function readDominoBrainRow(connection, nome) {
  const [rows] = await connection.execute(
    "SELECT id, nome, json_conteudo, data_ultima_atualizacao, data_inclusao, tempo_treino FROM JSON_conteudos WHERE nome = ? LIMIT 1",
    [nome]
  );
  return rows[0] || null;
}

async function insertDominoBrain(connection, nome, brain, tempoTreino) {
  await connection.execute(
    `INSERT INTO JSON_conteudos (nome, json_conteudo, tempo_treino, data_ultima_atualizacao, data_inclusao)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [nome, JSON.stringify(brain), tempoTreino]
  );
}

function dominoBrainOptions(rows) {
  return rows
    .map((row) => {
      const parsed = parseDominoBrainName(row.nome);
      if (!parsed) return null;
      return {
        id: row.id,
        nome: row.nome,
        baseName: parsed.baseName,
        player: parsed.player,
        tempoTreino: Number(row.tempo_treino) || 0,
        dataUltimaAtualizacao: row.data_ultima_atualizacao,
        dataInclusao: row.data_inclusao
      };
    })
    .filter(Boolean);
}

function dominoBrainPayload(row) {
  const parsed = parseDominoBrainName(row.nome);
  let brain = null;
  try {
    brain = JSON.parse(String(row.json_conteudo || ""));
  } catch {
    brain = createDominoBrain();
  }
  return {
    id: row.id,
    nome: row.nome,
    baseName: parsed ? parsed.baseName : baseNameFromDominoBrainName(row.nome),
    player: parsed ? parsed.player : null,
    tempoTreino: Number(row.tempo_treino) || 0,
    dataUltimaAtualizacao: row.data_ultima_atualizacao,
    dataInclusao: row.data_inclusao,
    brain: normalizeDominoBrainForStorage(brain)
  };
}

function parseDominoBrainName(nome) {
  const match = String(nome || "").match(/^(.+)J([1-4])$/);
  if (!match) return null;
  return {
    baseName: match[1],
    player: Number(match[2])
  };
}

function baseNameFromDominoBrainName(nome) {
  const parsed = parseDominoBrainName(nome);
  return parsed ? parsed.baseName : sanitizeDominoBrainBase(nome);
}

function sanitizeDominoBrainBase(value) {
  const cleaned = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/J[1-4]$/i, "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return cleaned || DOMINO_DEFAULT_BRAIN_BASE;
}

function createDominoBrain() {
  return {
    layers: createNetworkLayers(DOMINO_LAYER_SIZES),
    belief: { layers: createNetworkLayers(DOMINO_BELIEF_LAYER_SIZES) },
    beliefStats: createDominoBeliefStats(),
    games: 0,
    roundsTrained: 0,
    treinosRealizados: 0,
    generation: 0
  };
}

function createNetworkLayers(layerSizes) {
  return layerSizes.slice(1).map((outputSize, index) => {
    const inputSize = layerSizes[index];
    return {
      weights: Array.from({ length: outputSize }, () =>
        Array.from({ length: inputSize }, () => (Math.random() * 2 - 1) * Math.sqrt(2 / inputSize))
      ),
      biases: Array.from({ length: outputSize }, () => 0)
    };
  });
}

function createDominoBeliefStats() {
  return {
    trainSteps: 0,
    lastLoss: 1,
    avgLoss: 1,
    numberAccuracy: 0,
    tileAccuracy: 0,
    numberPrecision: 0,
    numberRecall: 0,
    tilePrecision: 0,
    tileRecall: 0,
    positiveCloseness: 0,
    positiveMetricsReady: false,
    closeness: 0,
    baselineCloseness: null,
    bestCloseness: 0,
    history: []
  };
}

function normalizeDominoBrainForStorage(brain) {
  if (!isValidDominoBrain(brain)) return createDominoBrain();
  const roundsTrained = Number(brain.roundsTrained ?? brain.treinosRealizados) || 0;
  return {
    layers: brain.layers,
    belief: isValidDominoBeliefNetwork(brain.belief) ? brain.belief : { layers: createNetworkLayers(DOMINO_BELIEF_LAYER_SIZES) },
    beliefStats: { ...createDominoBeliefStats(), ...(brain.beliefStats || {}) },
    games: Number(brain.games) || 0,
    roundsTrained,
    treinosRealizados: roundsTrained,
    generation: Number(brain.generation) || 0
  };
}

function isValidDominoBrain(brain) {
  return (
    brain &&
    Array.isArray(brain.layers) &&
    brain.layers.length === DOMINO_LAYER_SIZES.length - 1 &&
    brain.layers.every((layer, index) => {
      const outputSize = DOMINO_LAYER_SIZES[index + 1];
      const inputSize = DOMINO_LAYER_SIZES[index];
      return (
        Array.isArray(layer.weights) &&
        layer.weights.length === outputSize &&
        layer.weights.every((weights) => Array.isArray(weights) && weights.length === inputSize) &&
        Array.isArray(layer.biases) &&
        layer.biases.length === outputSize
      );
    })
  );
}

function isValidDominoBeliefNetwork(network) {
  return (
    network &&
    Array.isArray(network.layers) &&
    network.layers.length === DOMINO_BELIEF_LAYER_SIZES.length - 1 &&
    network.layers.every((layer, index) => {
      const outputSize = DOMINO_BELIEF_LAYER_SIZES[index + 1];
      const inputSize = DOMINO_BELIEF_LAYER_SIZES[index];
      return (
        Array.isArray(layer.weights) &&
        layer.weights.length === outputSize &&
        layer.weights.every((weights) => Array.isArray(weights) && weights.length === inputSize) &&
        Array.isArray(layer.biases) &&
        layer.biases.length === outputSize
      );
    })
  );
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
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

function formatLeituraRow(row) {
  let content = null;
  try {
    content = JSON.parse(stripBom(String(row.json_content || "").trim()));
  } catch {
    content = null;
  }

  return {
    id: row.id,
    titulo: row.titulo,
    json_content: row.json_content,
    content
  };
}

function parseUserContext(value) {
  if (!value) {
    return null;
  }
  try {
    const context = JSON.parse(String(value));
    return context && typeof context === "object" && !Array.isArray(context) ? context : null;
  } catch {
    return null;
  }
}

function normalizeVocabularyWriting(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s*\*\s*/g, " * ")
    .replace(/\s+/g, " ");
}

async function resolveVocabularyForStudy(connection, requestedWriting) {
  const [derivedRows] = await connection.execute(
    `SELECT v.id, v.escrita, v.significado
    FROM derivados d
    INNER JOIN vocabulario v ON v.id = d.primitivo_id
    WHERE d.derivado = ?
    LIMIT 1
    FOR UPDATE`,
    [requestedWriting]
  );

  let vocabulary = derivedRows[0];
  let created = false;
  let resolvedFromDerivative = Boolean(vocabulary);

  if (!vocabulary) {
    const [vocabularyRows] = await connection.execute(
      "SELECT id, escrita, significado FROM vocabulario WHERE escrita = ? LIMIT 1 FOR UPDATE",
      [requestedWriting]
    );
    vocabulary = vocabularyRows[0];
  }

  if (!vocabulary) {
    const [insertResult] = await connection.execute(
      "INSERT INTO vocabulario (escrita, significado) VALUES (?, NULL)",
      [requestedWriting]
    );
    vocabulary = { id: insertResult.insertId, escrita: requestedWriting, significado: null };
    created = true;
    resolvedFromDerivative = false;
  }

  let queued = false;
  if (vocabulary.significado === null) {
    const [queueResult] = await connection.execute(
      "INSERT IGNORE INTO fila_vocabulario (escrita) VALUES (?)",
      [vocabulary.escrita]
    );
    queued = queueResult.affectedRows > 0;
  }

  return { vocabulary, created, queued, resolvedFromDerivative };
}

function parseVocabularyProcessingJson(jsonContent) {
  if (typeof jsonContent !== "string" || !jsonContent.trim()) {
    throw new Error("Cole o JSON antes de processar.");
  }

  let text = stripBom(jsonContent.trim());
  const fenced = text.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced) {
    text = fenced[1].trim();
  }

  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("O texto informado nao e um JSON valido.");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("O JSON precisa ter um objeto na raiz.");
  }
  return payload;
}

async function processVocabularyPayload(connection, payload) {
  const errors = [];
  const derivatives = [];
  const invalidWords = [];
  const validWords = [];
  const categories = new Map();

  const registerCategory = (writing, category) => {
    if (!writing) {
      return;
    }
    const current = categories.get(writing) || new Set();
    current.add(category);
    categories.set(writing, current);
  };

  const derivativeMap = new Map();
  const addDerivative = (primitive, derived, label) => {
    registerCategory(derived, "derivada");
    if (!primitive || !derived) {
      errors.push({ writing: label, message: "Informe primitivo e derivado." });
      return;
    }
    if (primitive === derived) {
      errors.push({ writing: label, message: "Primitivo e derivado nao podem ser iguais." });
      return;
    }
    const previous = derivativeMap.get(derived);
    if (previous && previous !== primitive) {
      errors.push({ writing: derived, message: `A derivada aponta para dois primitivos: ${previous} e ${primitive}.` });
      return;
    }
    derivativeMap.set(derived, primitive);
  };

  const derivativeItems = Array.isArray(payload.derivados) ? payload.derivados : [];
  derivativeItems.forEach((item, index) => {
    const primitive = normalizeVocabularyWriting(item?.primitivo);
    const derived = normalizeVocabularyWriting(item?.derivado);
    const label = derived || `derivados[${index}]`;
    addDerivative(primitive, derived, label);
  });

  const invalidItems = Array.isArray(payload.invalidas) ? payload.invalidas : [];
  invalidItems.forEach((item, index) => {
    const writing = normalizeVocabularyWriting(item?.palavra);
    const label = writing || `invalidas[${index}]`;
    registerCategory(writing, "invalida");
    if (!writing) {
      errors.push({ writing: label, message: "Informe a palavra invalida." });
      return;
    }
    invalidWords.push({ writing });
  });

  Object.entries(payload).forEach(([rawWriting, details]) => {
    if (rawWriting === "derivados" || rawWriting === "invalidas") {
      return;
    }

    const writing = normalizeVocabularyWriting(rawWriting);
    registerCategory(writing, "valida");
    const meaning = typeof details?.significado === "string" ? details.significado.trim() : "";
    const examples = Array.isArray(details?.frases) ? details.frases : [];
    const invalidExampleIndex = examples.findIndex((item) =>
      !item || typeof item.ingles !== "string" || !item.ingles.trim() ||
      typeof item.traducao !== "string" || !item.traducao.trim() ||
      typeof item.resposta !== "string" || !item.resposta.trim()
    );

    const nestedDerivatives = Array.isArray(details?.derivadas) ? details.derivadas : [];
    nestedDerivatives.forEach((value, index) => {
      const derived = normalizeVocabularyWriting(value);
      addDerivative(writing, derived, `${writing}.derivadas[${index}]`);
    });

    if (!writing) {
      errors.push({ writing: rawWriting || "palavra sem nome", message: "Nome da palavra vazio." });
      return;
    }
    if (!meaning) {
      errors.push({ writing, message: "Significado ausente." });
      return;
    }
    if (examples.length !== 10) {
      errors.push({ writing, message: `Esperados 10 exemplos; recebidos ${examples.length}.` });
      return;
    }
    if (invalidExampleIndex !== -1) {
      errors.push({ writing, message: `Exemplo ${invalidExampleIndex + 1} sem ingles, traducao ou resposta.` });
      return;
    }

    validWords.push({
      writing,
      meaning,
      examples: examples.map((item) => ({
        text: item.ingles.trim(),
        translation: item.traducao.trim(),
        answer: item.resposta.trim()
      }))
    });
  });

  derivativeMap.forEach((primitive, derived) => {
    derivatives.push({ primitive, derived });
  });

  const conflicts = new Set();
  categories.forEach((value, writing) => {
    if (value.size > 1) {
      conflicts.add(writing);
      errors.push({
        writing,
        message: `A palavra aparece em categorias conflitantes: ${Array.from(value).join(", ")}.`
      });
    }
  });

  let processedDerivatives = 0;
  let processedInvalid = 0;
  let processedValid = 0;

  for (const item of derivatives) {
    if (conflicts.has(item.derived)) {
      continue;
    }
    await processDerivedVocabulary(connection, item);
    processedDerivatives += 1;
  }

  for (const item of invalidWords) {
    if (conflicts.has(item.writing)) {
      continue;
    }
    await processInvalidVocabulary(connection, item.writing);
    processedInvalid += 1;
  }

  for (const item of validWords) {
    if (conflicts.has(item.writing)) {
      continue;
    }
    const error = await processValidVocabulary(connection, item);
    if (error) {
      errors.push({ writing: item.writing, message: error });
      continue;
    }
    processedValid += 1;
  }

  return {
    processed: {
      valid: processedValid,
      derivatives: processedDerivatives,
      invalid: processedInvalid
    },
    errors
  };
}

async function processDerivedVocabulary(connection, item) {
  let primitive = await findVocabularyByWriting(connection, item.primitive);
  if (!primitive) {
    const [result] = await connection.execute(
      "INSERT INTO vocabulario (escrita, significado) VALUES (?, NULL)",
      [item.primitive]
    );
    primitive = { id: result.insertId, escrita: item.primitive, significado: null };
  }
  if (primitive.significado === null) {
    await connection.execute("INSERT IGNORE INTO fila_vocabulario (escrita) VALUES (?)", [primitive.escrita]);
  }

  const derivedVocabulary = await findVocabularyByWriting(connection, item.derived);
  if (derivedVocabulary && derivedVocabulary.id !== primitive.id) {
    await connection.execute(
      `INSERT INTO estuda_palavra
        (usuario_id, vocabulario_id, nivel, score, created_at, updated_at)
      SELECT usuario_id, ?, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM estuda_palavra
      WHERE vocabulario_id = ?
      ON DUPLICATE KEY UPDATE
        nivel = 0,
        score = 0,
        created_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP`,
      [primitive.id, derivedVocabulary.id]
    );
    await connection.execute("DELETE FROM estuda_palavra WHERE vocabulario_id = ?", [derivedVocabulary.id]);
    await connection.execute("UPDATE derivados SET primitivo_id = ? WHERE primitivo_id = ?", [primitive.id, derivedVocabulary.id]);
    await connection.execute("DELETE FROM exemplo WHERE vocabulario_id = ?", [derivedVocabulary.id]);
    await connection.execute("DELETE FROM vocabulario WHERE id = ?", [derivedVocabulary.id]);
  }

  await connection.execute(
    `INSERT INTO derivados (derivado, primitivo_id)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE primitivo_id = VALUES(primitivo_id), updated_at = CURRENT_TIMESTAMP`,
    [item.derived, primitive.id]
  );
  await connection.execute("DELETE FROM fila_vocabulario WHERE escrita = ?", [item.derived]);
}

async function processInvalidVocabulary(connection, writing) {
  await connection.execute("DELETE FROM fila_vocabulario WHERE escrita = ?", [writing]);
  await connection.execute("DELETE FROM derivados WHERE derivado = ?", [writing]);
  const vocabulary = await findVocabularyByWriting(connection, writing);
  if (!vocabulary) {
    return;
  }
  await connection.execute("DELETE FROM exemplo WHERE vocabulario_id = ?", [vocabulary.id]);
  await connection.execute("DELETE FROM estuda_palavra WHERE vocabulario_id = ?", [vocabulary.id]);
  await connection.execute("DELETE FROM vocabulario WHERE id = ?", [vocabulary.id]);
}

async function processValidVocabulary(connection, item) {
  const vocabulary = await findVocabularyByWriting(connection, item.writing);
  if (!vocabulary) {
    return "A palavra nao esta em vocabulario aguardando processamento.";
  }
  if (vocabulary.significado !== null) {
    return "A palavra ja possui significado e nao pode ser processada novamente.";
  }

  const [queueRows] = await connection.execute(
    "SELECT id FROM fila_vocabulario WHERE escrita = ? LIMIT 1",
    [item.writing]
  );
  if (!queueRows.length) {
    return "A palavra nao esta na fila de processamento.";
  }

  const [derivedRows] = await connection.execute(
    "SELECT id FROM derivados WHERE derivado = ? LIMIT 1",
    [item.writing]
  );
  if (derivedRows.length) {
    return "A palavra esta registrada como derivada.";
  }

  await connection.execute("UPDATE vocabulario SET significado = ? WHERE id = ?", [item.meaning, vocabulary.id]);
  await connection.execute("DELETE FROM exemplo WHERE vocabulario_id = ?", [vocabulary.id]);
  for (let index = 0; index < item.examples.length; index += 1) {
    const example = item.examples[index];
    await connection.execute(
      "INSERT INTO exemplo (vocabulario_id, ordem, texto, traducao, resposta) VALUES (?, ?, ?, ?, ?)",
      [vocabulary.id, index + 1, example.text, example.translation, example.answer]
    );
  }
  await connection.execute(
    `UPDATE usuario u
    INNER JOIN estuda_palavra ep ON ep.usuario_id = u.id
    SET u.contexto_vocabulario_json = NULL,
      u.data_ultimo_treino = '2000-01-01 00:00:00'
    WHERE ep.vocabulario_id = ?`,
    [vocabulary.id]
  );
  await connection.execute("DELETE FROM fila_vocabulario WHERE escrita = ?", [item.writing]);
  return "";
}

async function findVocabularyByWriting(connection, writing) {
  const [rows] = await connection.execute(
    "SELECT id, escrita, significado FROM vocabulario WHERE escrita = ? LIMIT 1 FOR UPDATE",
    [writing]
  );
  return rows[0] || null;
}

async function readPendingVocabulary(connection) {
  const [rows] = await connection.query(
    "SELECT id, escrita, created_at FROM fila_vocabulario ORDER BY created_at ASC, id ASC"
  );
  return rows.map((item) => ({
    id: item.id,
    writing: item.escrita,
    createdAt: item.created_at
  }));
}

const VOCABULARY_TRAINING_VERSION = 8;
const VOCABULARY_TRAINING_INTERVAL_MS = 23 * 60 * 60 * 1000;
const VOCABULARY_GRADUATED_LEVEL = 4;
const LEVEL_RULES = [
  { waitMs: 0, exampleCount: 10, maxDelta: 10 },
  { waitMs: 23 * 60 * 60 * 1000, exampleCount: 7, maxDelta: 20 },
  { waitMs: 7 * 24 * 60 * 60 * 1000, exampleCount: 5, maxDelta: 30 },
  { waitMs: 25 * 24 * 60 * 60 * 1000, exampleCount: 4, maxDelta: 40 }
];

async function getOrBuildVocabularyTraining(connection, userId) {
  const [userRows] = await connection.execute(
    `SELECT id, palavras_por_dia, data_ultimo_treino, contexto_vocabulario_json
    FROM usuario WHERE id = ? LIMIT 1 FOR UPDATE`,
    [userId]
  );
  if (!userRows.length) {
    const error = new Error("Usuario nao encontrado.");
    error.statusCode = 401;
    throw error;
  }

  const user = userRows[0];
  const saved = parseUserContext(user.contexto_vocabulario_json);
  const lastBuild = new Date(user.data_ultimo_treino || 0).getTime();
  const canBuildAgain = !Number.isFinite(lastBuild) || Date.now() - lastBuild >= VOCABULARY_TRAINING_INTERVAL_MS;
  if (saved?.version === VOCABULARY_TRAINING_VERSION && saved.status === "active") {
    return saved;
  }
  if (saved?.version === VOCABULARY_TRAINING_VERSION && saved.status !== "empty" && !canBuildAgain) {
    return saved;
  }

  const training = await buildVocabularyTraining(connection, userId, Math.max(1, Number(user.palavras_por_dia) || 5));
  await saveVocabularyTraining(connection, userId, training);
  await connection.execute(
    "UPDATE usuario SET data_ultimo_treino = CURRENT_TIMESTAMP WHERE id = ?",
    [userId]
  );
  return training;
}

async function buildVocabularyTraining(connection, userId, wordsPerLevel) {
  const now = new Date();
  const [studyRows] = await connection.execute(
    `SELECT ep.vocabulario_id, ep.nivel, ep.score, ep.created_at, ep.ultima_revisao,
      v.escrita, v.significado
    FROM estuda_palavra ep
    INNER JOIN vocabulario v ON v.id = ep.vocabulario_id
    WHERE ep.usuario_id = ? AND v.significado IS NOT NULL AND ep.nivel < ?
    ORDER BY ep.nivel ASC, ep.score ASC, COALESCE(ep.ultima_revisao, ep.created_at) ASC, ep.vocabulario_id ASC
    FOR UPDATE`,
    [userId, VOCABULARY_GRADUATED_LEVEL]
  );

  for (const word of studyRows) {
    if (Number(word.score) < 0) {
      const nextLevel = Math.max(0, Number(word.nivel) - 1);
      const nextScore = nextLevel === Number(word.nivel) ? 0 : Math.max(0, Number(word.score) + 80);
      word.nivel = nextLevel;
      word.score = nextScore;
      await connection.execute(
        "UPDATE estuda_palavra SET nivel = ?, score = ? WHERE usuario_id = ? AND vocabulario_id = ?",
        [nextLevel, nextScore, userId, word.vocabulario_id]
      );
    }
  }

  studyRows.sort((left, right) => {
    const levelDifference = Number(left.nivel) - Number(right.nivel);
    if (levelDifference) return levelDifference;
    const scoreDifference = Number(left.score) - Number(right.score);
    if (scoreDifference) return scoreDifference;
    const leftDate = new Date(left.ultima_revisao || left.created_at || 0).getTime();
    const rightDate = new Date(right.ultima_revisao || right.created_at || 0).getTime();
    if (leftDate !== rightDate) return leftDate - rightDate;
    return Number(left.vocabulario_id) - Number(right.vocabulario_id);
  });

  const selected = [];
  for (let level = 0; level < LEVEL_RULES.length; level += 1) {
    const rule = LEVEL_RULES[level];
    const eligible = studyRows.filter((word) => {
      if (Number(word.nivel) !== level) return false;
      if (!rule.waitMs) return true;
      const reviewedAt = new Date(word.ultima_revisao || word.created_at || 0).getTime();
      return Number.isFinite(reviewedAt) && now.getTime() - reviewedAt >= rule.waitMs;
    });
    selected.push(...eligible.slice(0, wordsPerLevel));
  }

  const groups = [];
  for (const word of selected) {
    const level = Number(word.nivel);
    const rule = LEVEL_RULES[level];
    const [exampleRows] = await connection.execute(
      `SELECT id, texto, traducao, resposta
      FROM exemplo
      WHERE vocabulario_id = ? AND resposta IS NOT NULL AND resposta <> ''
      ORDER BY ordem ASC, id ASC`,
      [word.vocabulario_id]
    );
    if (exampleRows.length < 10) continue;

    const wordKey = crypto.randomUUID();
    const score = Number(word.score);
    const exercises = [];
    if (score >= 0 && score <= 5) {
      exercises.push({
        id: crypto.randomUUID(),
        wordKey,
        vocabularyId: Number(word.vocabulario_id),
        writing: word.escrita,
        type: "meaning",
        prompt: word.significado,
        translation: "Digite a palavra ou expressao descrita acima.",
        expectedAnswer: word.escrita,
        promptParts: buildHintedPromptParts(word.significado, word.escrita, word.escrita, score),
        level,
        maxDelta: rule.maxDelta,
        answered: false
      });
    }

    shuffleArray(exampleRows).slice(0, rule.exampleCount).forEach((example) => {
      exercises.push({
        id: crypto.randomUUID(),
        wordKey,
        vocabularyId: Number(word.vocabulario_id),
        writing: word.escrita,
        type: "example",
        prompt: example.texto,
        translation: example.traducao || "",
        expectedAnswer: example.resposta,
        promptParts: buildHintedPromptParts(example.texto, example.resposta, word.escrita, score),
        level,
        maxDelta: rule.maxDelta,
        answered: false
      });
    });

    groups.push({
      word: {
        key: wordKey,
        vocabularyId: Number(word.vocabulario_id),
        writing: word.escrita,
        level,
        score,
        status: "active"
      },
      exercises
    });
  }

  const shuffledGroups = shuffleArray(groups);
  const exercises = shuffleVocabularyExercises(shuffledGroups);
  return {
    version: VOCABULARY_TRAINING_VERSION,
    id: crypto.randomUUID(),
    createdAt: now.toISOString(),
    status: exercises.length ? "active" : "empty",
    currentIndex: 0,
    wordsPerLevel,
    words: shuffledGroups.map((group) => group.word),
    exercises
  };
}

async function answerVocabularyExercise(connection, userId, exerciseId, rawAnswer) {
  const [userRows] = await connection.execute(
    "SELECT contexto_vocabulario_json FROM usuario WHERE id = ? LIMIT 1 FOR UPDATE",
    [userId]
  );
  if (!userRows.length) {
    const error = new Error("Usuario nao encontrado.");
    error.statusCode = 401;
    throw error;
  }

  const training = parseUserContext(userRows[0].contexto_vocabulario_json);
  if (!training || training.version !== VOCABULARY_TRAINING_VERSION || training.status !== "active") {
    const error = new Error("Nao ha treinamento ativo.");
    error.statusCode = 409;
    throw error;
  }

  const exercise = training.exercises.find((item) => item.id === exerciseId);
  if (!exercise) {
    const error = new Error("Exercicio nao pertence ao treinamento atual.");
    error.statusCode = 404;
    throw error;
  }
  if (exercise.answered) {
    return { ok: true, repeated: true, result: publicExerciseResult(exercise), training: publicVocabularyTraining(training) };
  }

  const current = training.exercises[training.currentIndex];
  if (!current || current.id !== exercise.id) {
    const error = new Error("Responda o exercicio atual antes de continuar.");
    error.statusCode = 409;
    throw error;
  }

  const accuracy = calculateAnswerAccuracy(rawAnswer, exercise.expectedAnswer, exercise.writing);
  const delta = calculateExerciseDelta(accuracy, Number(exercise.maxDelta));
  exercise.answered = true;
  exercise.response = rawAnswer;
  exercise.accuracy = accuracy;
  exercise.delta = delta;
  exercise.correctAnswer = exercise.expectedAnswer;
  exercise.completedPromptParts = buildCompletedPromptParts(exercise);
  exercise.spokenText = buildSpokenExerciseText(exercise);
  exercise.answeredAt = new Date().toISOString();

  const word = training.words.find((item) => item.key === exercise.wordKey);
  if (!word) throw new Error("Palavra do exercicio nao encontrada no contexto.");
  word.score = Number(word.score) + delta;

  let promoted = false;
  let graduated = false;
  if (word.score > 99) {
    promoted = true;
    word.status = "promoted";
    training.exercises.forEach((item) => {
      if (item.wordKey === word.key && !item.answered) item.skipped = true;
    });
    if (Number(word.level) >= LEVEL_RULES.length - 1) {
      graduated = true;
      word.status = "graduated";
      word.level = VOCABULARY_GRADUATED_LEVEL;
      word.score = 100;
      await connection.execute(
        `UPDATE estuda_palavra
        SET nivel = ?, score = 100, ultima_revisao = CURRENT_TIMESTAMP
        WHERE usuario_id = ? AND vocabulario_id = ?`,
        [VOCABULARY_GRADUATED_LEVEL, userId, word.vocabularyId]
      );
    } else {
      word.level = Number(word.level) + 1;
      word.score = 0;
      await connection.execute(
        `UPDATE estuda_palavra
        SET nivel = ?, score = 0, ultima_revisao = CURRENT_TIMESTAMP
        WHERE usuario_id = ? AND vocabulario_id = ?`,
        [word.level, userId, word.vocabularyId]
      );
    }
  } else {
    await connection.execute(
      "UPDATE estuda_palavra SET score = ? WHERE usuario_id = ? AND vocabulario_id = ?",
      [word.score, userId, word.vocabularyId]
    );
    refreshPendingWordHints(training, word);
  }

  training.currentIndex = findNextVocabularyExerciseIndex(training.exercises, training.currentIndex + 1);
  const wordHasPendingExercises = training.exercises.some((item) => item.wordKey === word.key && !item.answered && !item.skipped);
  if (!wordHasPendingExercises && !promoted) {
    word.status = "completed";
    await connection.execute(
      "UPDATE estuda_palavra SET ultima_revisao = CURRENT_TIMESTAMP WHERE usuario_id = ? AND vocabulario_id = ?",
      [userId, word.vocabularyId]
    );
  }
  if (training.currentIndex >= training.exercises.length) {
    training.status = "completed";
    training.completedAt = new Date().toISOString();
  }

  await saveVocabularyTraining(connection, userId, training);
  return {
    ok: true,
    result: {
      ...publicExerciseResult(exercise),
      promoted,
      graduated,
      writing: word.writing,
      wordScore: Number(word.score),
      wordLevel: Number(word.level)
    },
    training: publicVocabularyTraining(training)
  };
}

async function revealVocabularyExercise(connection, userId, exerciseId) {
  const [userRows] = await connection.execute(
    "SELECT contexto_vocabulario_json FROM usuario WHERE id = ? LIMIT 1 FOR UPDATE",
    [userId]
  );
  if (!userRows.length) {
    const error = new Error("Usuario nao encontrado.");
    error.statusCode = 401;
    throw error;
  }

  const training = parseUserContext(userRows[0].contexto_vocabulario_json);
  if (!training || training.version !== VOCABULARY_TRAINING_VERSION || training.status !== "active") {
    const error = new Error("Nao ha treinamento ativo.");
    error.statusCode = 409;
    throw error;
  }

  const exercise = training.exercises.find((item) => item.id === exerciseId);
  if (!exercise || exercise.type !== "meaning") {
    const error = new Error("Esta opcao existe apenas no exercicio de definicao.");
    error.statusCode = 400;
    throw error;
  }
  if (exercise.answered && exercise.neutral) {
    return {
      ok: true,
      repeated: true,
      result: neutralVocabularyResult(exercise, training),
      training: publicVocabularyTraining(training)
    };
  }

  const current = training.exercises[training.currentIndex];
  if (!current || current.id !== exercise.id || exercise.answered) {
    const error = new Error("Este nao e mais o exercicio atual.");
    error.statusCode = 409;
    throw error;
  }

  exercise.answered = true;
  exercise.neutral = true;
  exercise.response = "";
  exercise.correctAnswer = exercise.expectedAnswer;
  exercise.accuracy = null;
  exercise.delta = 0;
  exercise.answeredAt = new Date().toISOString();

  const word = training.words.find((item) => item.key === exercise.wordKey);
  if (!word) throw new Error("Palavra do exercicio nao encontrada no contexto.");
  training.currentIndex = findNextVocabularyExerciseIndex(training.exercises, training.currentIndex + 1);
  const wordHasPendingExercises = training.exercises.some((item) => item.wordKey === word.key && !item.answered && !item.skipped);
  if (!wordHasPendingExercises) {
    word.status = "completed";
    await connection.execute(
      "UPDATE estuda_palavra SET ultima_revisao = CURRENT_TIMESTAMP WHERE usuario_id = ? AND vocabulario_id = ?",
      [userId, word.vocabularyId]
    );
  }
  if (training.currentIndex >= training.exercises.length) {
    training.status = "completed";
    training.completedAt = new Date().toISOString();
  }

  await saveVocabularyTraining(connection, userId, training);
  return {
    ok: true,
    result: neutralVocabularyResult(exercise, training),
    training: publicVocabularyTraining(training)
  };
}

function neutralVocabularyResult(exercise, training) {
  const word = training.words.find((item) => item.key === exercise.wordKey);
  return {
    exerciseId: exercise.id,
    neutral: true,
    correctAnswer: exercise.correctAnswer,
    writing: exercise.writing,
    wordScore: word ? Number(word.score) : null,
    wordLevel: word ? Number(word.level) : null,
    delta: 0
  };
}

function findNextVocabularyExerciseIndex(exercises, startIndex) {
  for (let index = startIndex; index < exercises.length; index += 1) {
    if (!exercises[index].answered && !exercises[index].skipped) return index;
  }
  return exercises.length;
}

async function saveVocabularyTraining(connection, userId, training) {
  const serialized = JSON.stringify(training);
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Contexto do treinamento ficou grande demais.");
  }
  await connection.execute(
    "UPDATE usuario SET contexto_vocabulario_json = ? WHERE id = ?",
    [serialized, userId]
  );
}

function publicVocabularyTraining(training) {
  if (!training) return null;
  const copy = JSON.parse(JSON.stringify(training));
  copy.exercises = (copy.exercises || []).map((exercise) => {
    delete exercise.expectedAnswer;
    if (!exercise.answered) delete exercise.correctAnswer;
    return exercise;
  });
  copy.totalExercises = copy.exercises.filter((item) => !item.skipped).length;
  copy.answeredExercises = copy.exercises.filter((item) => item.answered).length;
  return copy;
}

function publicExerciseResult(exercise) {
  return {
    exerciseId: exercise.id,
    response: exercise.response,
    correctAnswer: exercise.correctAnswer,
    accuracy: exercise.accuracy,
    delta: exercise.delta,
    spokenText: exercise.spokenText || "",
    completedPromptParts: exercise.completedPromptParts || []
  };
}

function buildCompletedPromptParts(exercise) {
  return buildHintedPromptParts(
    exercise.prompt,
    exercise.expectedAnswer,
    exercise.writing,
    75
  ).map((part) => {
    if (part.type !== "slot") return part;
    return {
      ...part,
      characters: Array.from(part.answerText || "").map((character) => ({
        text: character,
        hint: true
      }))
    };
  });
}

function buildSpokenExerciseText(exercise) {
  if (exercise.type === "meaning") return String(exercise.expectedAnswer || "").trim();
  const parts = buildHintedPromptParts(
    exercise.prompt,
    exercise.expectedAnswer,
    exercise.writing,
    75
  );
  return parts
    .map((part) => part.type === "slot" ? part.answerText || "" : part.text || "")
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function buildHintedPromptParts(prompt, answer, writing, score) {
  const answerSegments = getScoredAnswerSegments(answer, writing, true);
  const candidates = [];
  answerSegments.forEach((segment, segmentIndex) => {
    Array.from(segment).forEach((character, characterIndex) => {
      if (/[\p{L}\p{N}]/u.test(character)) candidates.push(`${segmentIndex}:${characterIndex}`);
    });
  });
  const revealCount = calculateHintCharacterCount(candidates.length, score);
  const revealed = new Set(shuffleArray(candidates).slice(0, revealCount));
  const parts = [];
  const blankPattern = /_+(?:[ \t]_+)*/g;
  let cursor = 0;
  let segmentIndex = 0;
  let match = null;
  while ((match = blankPattern.exec(String(prompt || ""))) !== null) {
    if (match.index > cursor) parts.push({ type: "text", text: prompt.slice(cursor, match.index) });
    const segment = answerSegments[segmentIndex];
    if (segment === undefined) {
      parts.push({ type: "text", text: match[0] });
    } else {
      const characters = Array.from(segment).map((character, characterIndex) => {
        const isLetter = /[\p{L}\p{N}]/u.test(character);
        const isRevealed = isLetter && revealed.has(`${segmentIndex}:${characterIndex}`);
        return {
          text: isLetter ? (isRevealed ? character : "_") : character,
          hint: isRevealed
        };
      });
      parts.push({ type: "slot", expectedLength: characters.length, answerText: segment, characters });
    }
    cursor = match.index + match[0].length;
    segmentIndex += 1;
  }
  if (cursor < String(prompt || "").length) parts.push({ type: "text", text: prompt.slice(cursor) });
  return parts.length ? parts : [{ type: "text", text: String(prompt || "") }];
}

function calculateHintCharacterCount(characterCount, score) {
  const total = Math.max(0, Math.floor(Number(characterCount) || 0));
  const boundedScore = Math.max(0, Math.min(80, Number(score) || 0));
  const revealRatio = 0.5 * (1 - boundedScore / 80);
  return Math.min(total, Math.max(0, Math.round(total * revealRatio)));
}

function refreshPendingWordHints(training, word) {
  training.exercises.forEach((exercise) => {
    if (exercise.wordKey !== word.key || exercise.answered || exercise.skipped) return;
    exercise.promptParts = buildHintedPromptParts(
      exercise.prompt,
      exercise.expectedAnswer,
      exercise.writing,
      Number(word.score)
    );
  });
}

function calculateExerciseDelta(accuracy, maximumDelta) {
  const precision = Math.max(0, Math.min(1, Number(accuracy) || 0));
  const maximum = Math.max(0, Number(maximumDelta) || 0);
  if (precision <= 0.5) return -Math.round(maximum);
  const normalized = (precision - 0.5) / 0.5;
  return Math.round(-maximum + normalized * maximum * 2);
}

function calculateAnswerAccuracy(actual, expected, writing) {
  const left = normalizeTrainingAnswer(getScoredAnswerSegments(actual, writing, false).join(" "));
  const right = normalizeTrainingAnswer(getScoredAnswerSegments(expected, writing, false).join(" "));
  if (!left && !right) return 1;
  const longest = Math.max(left.length, right.length, 1);
  return Math.max(0, Math.min(1, 1 - levenshteinDistance(left, right) / longest));
}

function getScoredAnswerSegments(answer, writing, splitForPrompt) {
  const answerWords = normalizeTrainingAnswer(answer).split(" ").filter(Boolean);
  const pattern = normalizeVocabularyWriting(writing);
  if (!pattern.includes("*")) return splitForPrompt ? answerWords : [answerWords.join(" ")];

  const [leftPattern = "", rightPattern = ""] = pattern.split("*");
  const leftCount = normalizeTrainingAnswer(leftPattern).split(" ").filter(Boolean).length;
  const rightCount = normalizeTrainingAnswer(rightPattern).split(" ").filter(Boolean).length;
  const left = answerWords.slice(0, leftCount);
  const right = rightCount ? answerWords.slice(Math.max(leftCount, answerWords.length - rightCount)) : [];
  const fixed = [...left, ...right];
  return splitForPrompt ? fixed : [fixed.join(" ")];
}

function normalizeTrainingAnswer(value) {
  return String(value || "").normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/g, " ");
}

function levenshteinDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function shuffleArray(items) {
  const copy = Array.from(items || []);
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const randomIndex = crypto.randomInt(index + 1);
    [copy[index], copy[randomIndex]] = [copy[randomIndex], copy[index]];
  }
  return copy;
}

function shuffleVocabularyExercises(groups) {
  const allExercises = groups.flatMap((group) => group.exercises || []);
  const exercises = shuffleArray(allExercises.filter((exercise) => exercise.type !== "meaning"));
  const introductions = shuffleArray(allExercises.filter((exercise) => exercise.type === "meaning"));

  introductions.forEach((introduction) => {
    const firstWordExercise = exercises.findIndex((exercise) => exercise.wordKey === introduction.wordKey);
    if (firstWordExercise === -1) {
      exercises.push(introduction);
      return;
    }
    exercises.splice(firstWordExercise, 0, introduction);
  });

  return exercises;
}

function createFactoryToken() {
  const payload = {
    sub: "factory",
    exp: Date.now() + TOKEN_TTL_MS,
    nonce: crypto.randomBytes(12).toString("hex")
  };
  return encryptToken(JSON.stringify(payload));
}

function createUserToken(user) {
  const payload = {
    sub: "user",
    userId: Number(user.id),
    nick: String(user.nick),
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

function readUserAuthToken(request) {
  const header = request.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }

  try {
    const payload = JSON.parse(decryptToken(match[1]));
    if (
      !payload ||
      payload.sub !== "user" ||
      !Number.isInteger(Number(payload.userId)) ||
      Number(payload.exp) < Date.now()
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function safeTextEqual(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
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
// maikon m. 2026
