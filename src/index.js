const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const SteamUser = require('steam-user');
const { HttpsProxyAgent } = require('hpagent');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'friend_game_history.db');
const ENV_FILE = path.join(process.cwd(), '.env');
const STEAM_LANGUAGE = process.env.STEAM_LANGUAGE || 'schinese';
const STEAM_STORE_TIMEOUT_MS = Number(process.env.STEAM_STORE_TIMEOUT_MS || 5000);
const STEAM_STORE_RETRY_TIMES = Number(process.env.STEAM_STORE_RETRY_TIMES || 3);
const STEAM_STORE_RETRY_DELAY_MS = Number(process.env.STEAM_STORE_RETRY_DELAY_MS || 800);
const STORE_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;
const STEAM_RECONNECT_BASE_MS = Number(process.env.STEAM_RECONNECT_BASE_MS || 2000);
const STEAM_RECONNECT_MAX_MS = Number(process.env.STEAM_RECONNECT_MAX_MS || 60000);
const STEAM_LOGIN_TIMEOUT_MS = Number(process.env.STEAM_LOGIN_TIMEOUT_MS || 30000);
const STEAM_GUARD_CODE = process.env.STEAM_GUARD_CODE || '';

const app = express();
const client = new SteamUser({
  autoRelogin: true,
  renewRefreshTokens: true,
  enablePicsCache: true,
  language: STEAM_LANGUAGE,
});

const friendStatuses = new Map();
const lastRecordedGameByFriend = new Map();
const gameNameById = new Map();
const gameIconById = new Map();
const proxyAgentByUrl = new Map();
const pendingGameNameFetch = new Set();
let botSteamId = null;
let isLoggedOn = false;
let isLoggingOn = false;
let reconnectTimer = null;
let loginTimeoutTimer = null;
let reconnectAttempt = 0;
let db = null;
let cachedLogOnOptions = null;

const PERSONA_STATE_MAP = {
  0: '离线',
  1: '在线',
  2: '忙碌',
  3: '离开',
  4: '打盹',
  5: '想交易',
  6: '想玩游戏',
  7: '隐身',
};

function normalizeGameIdKey(gameId) {
  if (gameId === undefined || gameId === null) {
    return '';
  }

  const key = String(gameId).trim();
  if (key === '' || key === '0') {
    return '';
  }

  return key;
}

function clearReconnectTimer() {
  if (!reconnectTimer) {
    return;
  }

  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function clearLoginTimeoutTimer() {
  if (!loginTimeoutTimer) {
    return;
  }

  clearTimeout(loginTimeoutTimer);
  loginTimeoutTimer = null;
}

function armLoginTimeout() {
  clearLoginTimeoutTimer();

  loginTimeoutTimer = setTimeout(() => {
    if (isLoggedOn) {
      return;
    }

    isLoggingOn = false;
    console.warn(`Steam 登录超时（>${STEAM_LOGIN_TIMEOUT_MS}ms），准备重试。`);
    scheduleReconnect('login-timeout');
  }, Math.max(5000, STEAM_LOGIN_TIMEOUT_MS));
}

function doLogOn(reason) {
  if (!cachedLogOnOptions) {
    console.warn('未找到登录参数，无法执行自动重连。');
    return;
  }

  if (isLoggedOn || isLoggingOn) {
    return;
  }

  isLoggingOn = true;
  armLoginTimeout();
  try {
    console.log(`正在尝试 Steam 登录: ${reason}`);
    client.logOn(cachedLogOnOptions);
  } catch (err) {
    clearLoginTimeoutTimer();
    isLoggingOn = false;
    console.error('触发登录失败:', err.message);
    scheduleReconnect('logOn异常');
  }
}

function scheduleReconnect(reason) {
  if (isLoggedOn || isLoggingOn || reconnectTimer) {
    return;
  }

  reconnectAttempt += 1;
  const delay = Math.min(STEAM_RECONNECT_BASE_MS * 2 ** (reconnectAttempt - 1), STEAM_RECONNECT_MAX_MS);
  console.warn(`已计划第 ${reconnectAttempt} 次重连，${delay}ms 后执行，原因: ${reason}`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    doLogOn(`重连第${reconnectAttempt}次`);
  }, delay);
}

function getStoreAppId(gameId) {
  const gameIdKey = normalizeGameIdKey(gameId);
  if (!gameIdKey) {
    return null;
  }

  if (!/^\d+$/.test(gameIdKey)) {
    return null;
  }

  const asNumber = Number(gameIdKey);
  if (!Number.isSafeInteger(asNumber) || asNumber <= 0) {
    return null;
  }

  return asNumber;
}

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const instance = new sqlite3.Database(DB_FILE, (err) => {
      if (err) {
        reject(err);
        return;
      }

      db = instance;
      resolve();
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库尚未初始化'));
      return;
    }

    db.run(sql, params, (err) => {
      if (err) {
        reject(err);
        return;
      }

      resolve();
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    if (!db) {
      reject(new Error('数据库尚未初始化'));
      return;
    }

    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

async function initDatabase() {
  await openDatabase();

  const historyTable = await dbAll(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='friend_game_history'"
  );
  if (historyTable.length > 0) {
    const historyColumns = await dbAll('PRAGMA table_info(friend_game_history)');
    const gameIdColumn = historyColumns.find((column) => column.name === 'game_id');
    const needsHistoryRebuild = !gameIdColumn || String(gameIdColumn.type || '').toUpperCase() !== 'TEXT';
    if (needsHistoryRebuild) {
      await dbRun('ALTER TABLE friend_game_history RENAME TO friend_game_history_old');
      await dbRun(`
        CREATE TABLE friend_game_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL,
          game_id TEXT NOT NULL,
          changed_at TEXT NOT NULL
        )
      `);
      await dbRun(`
        INSERT INTO friend_game_history (id, user_id, game_id, changed_at)
        SELECT id, user_id, CAST(game_id AS TEXT), COALESCE(changed_at, datetime('now'))
        FROM friend_game_history_old
      `);
      await dbRun('DROP TABLE friend_game_history_old');
    }
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS friend_game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      game_id TEXT NOT NULL,
      changed_at TEXT NOT NULL
    )
  `);

  const gameMapTable = await dbAll(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='game_name_map'"
  );
  if (gameMapTable.length > 0) {
    const gameMapColumns = await dbAll('PRAGMA table_info(game_name_map)');
    const gameIdColumn = gameMapColumns.find((column) => column.name === 'game_id');
    const hasIconUrl = gameMapColumns.some((column) => column.name === 'icon_url');
    const hasUpdatedAt = gameMapColumns.some((column) => column.name === 'updated_at');
    const needsGameMapRebuild = !gameIdColumn || String(gameIdColumn.type || '').toUpperCase() !== 'TEXT';

    if (needsGameMapRebuild) {
      await dbRun('ALTER TABLE game_name_map RENAME TO game_name_map_old');
      await dbRun(`
        CREATE TABLE game_name_map (
          game_id TEXT PRIMARY KEY,
          game_name TEXT NOT NULL,
          icon_url TEXT,
          updated_at TEXT NOT NULL
        )
      `);

      const iconExpr = hasIconUrl ? 'icon_url' : 'NULL';
      const updatedExpr = hasUpdatedAt ? 'updated_at' : "datetime('now')";

      await dbRun(`
        INSERT INTO game_name_map (game_id, game_name, icon_url, updated_at)
        SELECT CAST(game_id AS TEXT), game_name, ${iconExpr}, COALESCE(${updatedExpr}, datetime('now'))
        FROM game_name_map_old
      `);
      await dbRun('DROP TABLE game_name_map_old');
    }
  }

  await dbRun(`
    CREATE TABLE IF NOT EXISTS game_name_map (
      game_id TEXT PRIMARY KEY,
      game_name TEXT NOT NULL,
      icon_url TEXT,
      updated_at TEXT NOT NULL
    )
  `);

  const columns = await dbAll('PRAGMA table_info(friend_game_history)');
  const hasChangedAt = columns.some((column) => column.name === 'changed_at');
  if (!hasChangedAt) {
    await dbRun('ALTER TABLE friend_game_history ADD COLUMN changed_at TEXT');
    await dbRun('UPDATE friend_game_history SET changed_at = ? WHERE changed_at IS NULL OR changed_at = ""', [
      new Date().toISOString(),
    ]);
  }

  const gameMapColumnsAfterInit = await dbAll('PRAGMA table_info(game_name_map)');
  const hasIconUrlAfterInit = gameMapColumnsAfterInit.some((column) => column.name === 'icon_url');
  if (!hasIconUrlAfterInit) {
    await dbRun('ALTER TABLE game_name_map ADD COLUMN icon_url TEXT');
  }

  await dbRun('CREATE INDEX IF NOT EXISTS idx_history_user_id ON friend_game_history(user_id)');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_game_name_updated_at ON game_name_map(updated_at)');

  // 兼容旧版本数据：将未游玩时的 game_id=0 统一迁移为空字符串
  await dbRun("UPDATE friend_game_history SET game_id = '' WHERE game_id = '0' OR game_id = 0");
  await dbRun("DELETE FROM game_name_map WHERE game_id = '0' OR game_id = 0");

  const existingGameMappings = await dbAll(
    'SELECT game_id AS gameId, game_name AS gameName, icon_url AS iconUrl FROM game_name_map'
  );
  for (const row of existingGameMappings) {
    const gameId = normalizeGameIdKey(row.gameId);
    if (!gameId) {
      continue;
    }
    gameNameById.set(gameId, row.gameName);
    if (row.iconUrl) {
      gameIconById.set(gameId, row.iconUrl);
    }
  }
}

function toSteamId64(steamID) {
  if (!steamID) return null;
  if (typeof steamID === 'string') return steamID;
  if (typeof steamID.getSteamID64 === 'function') return steamID.getSteamID64();
  return String(steamID);
}

function persistRefreshToken(token) {
  if (!token) {
    return;
  }

  let content = '';
  if (fs.existsSync(ENV_FILE)) {
    content = fs.readFileSync(ENV_FILE, 'utf8');
  }

  const tokenLine = `STEAM_REFRESH_TOKEN=${token}`;
  const hasTokenLine = /^STEAM_REFRESH_TOKEN=.*$/m.test(content);

  const nextContent = hasTokenLine
    ? content.replace(/^STEAM_REFRESH_TOKEN=.*$/m, tokenLine)
    : `${content}${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${tokenLine}\n`;

  fs.writeFileSync(ENV_FILE, nextContent, 'utf8');
  process.env.STEAM_REFRESH_TOKEN = token;
  console.log('已自动保存最新 STEAM_REFRESH_TOKEN 到 .env');
}

function readRawEnvValue(key) {
  if (!fs.existsSync(ENV_FILE)) {
    return null;
  }

  const lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/);
  const targetPrefix = `${key}=`;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (!line.startsWith(targetPrefix)) {
      continue;
    }

    const raw = line.slice(targetPrefix.length);
    if (!raw) {
      return '';
    }

    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }

    return raw;
  }

  return null;
}

function getSteamPassword() {
  const rawPassword = readRawEnvValue('STEAM_PASSWORD');
  if (rawPassword !== null) {
    return rawPassword;
  }

  return process.env.STEAM_PASSWORD;
}

function isFriend(steamId64) {
  if (!steamId64 || !client.myFriends) return false;
  return client.myFriends[steamId64] === SteamUser.EFriendRelationship.Friend;
}

function normalizeGameId(user) {
  const value = user?.gameid_real || user?.gameid;
  if (!value) return '0';
  return normalizeGameIdKey(value);
}

function normalizeRichPresenceMap(richPresence) {
  if (!richPresence) {
    return {};
  }

  if (Array.isArray(richPresence)) {
    const mapped = {};
    for (const item of richPresence) {
      if (!item || typeof item.key !== 'string') {
        continue;
      }

      mapped[item.key] = item.value;
    }
    return mapped;
  }

  if (typeof richPresence === 'object') {
    return richPresence;
  }

  return {};
}

function buildPartyInfo(richPresence = {}) {
  const groupSize = Number(richPresence.steam_player_group_size || 0);
  return {
    groupId: richPresence.steam_player_group || null,
    groupSize: Number.isNaN(groupSize) ? null : groupSize,
    connect: richPresence.connect || null,
  };
}

function saveGameMetadata(gameId, gameName, iconUrl = null) {
  if (!gameId || !gameName) {
    return;
  }

  const gameIdKey = normalizeGameIdKey(gameId);
  if (!gameIdKey) {
    return;
  }

  gameNameById.set(gameIdKey, gameName);
  if (iconUrl) {
    gameIconById.set(gameIdKey, iconUrl);
  }

  dbRun(
    'INSERT OR REPLACE INTO game_name_map (game_id, game_name, icon_url, updated_at) VALUES (?, ?, ?, ?)',
    [gameIdKey, gameName, iconUrl, new Date().toISOString()]
  ).catch((err) => {
    console.error('写入游戏元数据映射失败:', err.message);
  });
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getProxyAgent(proxyUrl) {
  if (!proxyUrl) {
    return null;
  }

  if (proxyAgentByUrl.has(proxyUrl)) {
    return proxyAgentByUrl.get(proxyUrl);
  }

  const agent = new HttpsProxyAgent({
    proxy: proxyUrl,
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 32,
    maxFreeSockets: 8,
  });

  proxyAgentByUrl.set(proxyUrl, agent);
  return agent;
}

function fetchGameMetadataFromStoreOnce(gameId, options = {}) {
  const gameIdNumber = getStoreAppId(gameId);
  if (!gameIdNumber) {
    return Promise.resolve(null);
  }

  const url = `https://store.steampowered.com/api/appdetails?appids=${gameIdNumber}&l=${encodeURIComponent(
    STEAM_LANGUAGE
  )}`;

  return new Promise((resolve, reject) => {
    const requestOptions = {};
    if (options.proxy) {
      requestOptions.agent = getProxyAgent(options.proxy);
    }

    const req = https.get(url, requestOptions, (res) => {
      let body = '';

      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });

      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const appNode = parsed[String(gameIdNumber)];
          const gameName = appNode?.data?.name || null;
          const iconUrl = appNode?.data?.capsule_image || appNode?.data?.header_image || null;
          resolve({ gameName, iconUrl });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(options.timeoutMs || STEAM_STORE_TIMEOUT_MS, () => {
      req.destroy(new Error('请求 Steam 商店超时'));
    });
  });
}

async function fetchGameMetadataFromStore(gameId) {
  const retries = Math.max(1, STEAM_STORE_RETRY_TIMES);
  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fetchGameMetadataFromStoreOnce(gameId, {
        proxy: STORE_PROXY,
        timeoutMs: STEAM_STORE_TIMEOUT_MS,
      });
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(STEAM_STORE_RETRY_DELAY_MS * attempt);
      }
    }
  }

  throw lastError || new Error('拉取游戏元数据失败');
}

function backfillGameMetadataToStatuses(gameId, gameName, iconUrl) {
  const gameIdKey = normalizeGameIdKey(gameId);
  for (const [steamId, status] of friendStatuses.entries()) {
    if (status.gameId === gameIdKey && (!status.gameName || !status.gameSmallIcon)) {
      friendStatuses.set(steamId, {
        ...status,
        gameName: status.gameName || gameName,
        gameSmallIcon: status.gameSmallIcon || iconUrl,
        updatedAt: new Date().toISOString(),
      });
    }
  }
}

function ensureGameNameMapping(gameId) {
  const gameIdKey = normalizeGameIdKey(gameId);
  if (!gameIdKey) {
    return;
  }

  if (gameNameById.has(gameIdKey) || pendingGameNameFetch.has(gameIdKey)) {
    return;
  }

  pendingGameNameFetch.add(gameIdKey);
  fetchGameMetadataFromStore(gameIdKey)
    .then((meta) => {
      if (!meta?.gameName) {
        return;
      }

      saveGameMetadata(gameIdKey, meta.gameName, meta.iconUrl || null);
      backfillGameMetadataToStatuses(gameIdKey, meta.gameName, meta.iconUrl || null);
    })
    .catch((err) => {
      console.warn(`拉取游戏名失败 appid=${gameIdKey}:`, err.message);
    })
    .finally(() => {
      pendingGameNameFetch.delete(gameIdKey);
    });
}

function resolveGameName(gameId, directGameName) {
  const gameIdKey = normalizeGameIdKey(gameId);
  if (!gameIdKey) {
    return null;
  }

  if (directGameName) {
    const existingIcon = gameIconById.get(gameIdKey) || null;
    saveGameMetadata(gameIdKey, directGameName, existingIcon);
    return directGameName;
  }

  return gameNameById.get(gameIdKey) || null;
}

function resolveGameIcon(gameId) {
  const gameIdKey = normalizeGameIdKey(gameId);
  if (!gameIdKey) {
    return null;
  }

  return gameIconById.get(gameIdKey) || null;
}

function recordGameChange(steamId, gameId) {
  const lastGameId = lastRecordedGameByFriend.get(steamId);
  if (lastGameId === gameId) {
    return;
  }

  lastRecordedGameByFriend.set(steamId, gameId);

  dbRun('INSERT INTO friend_game_history (user_id, game_id, changed_at) VALUES (?, ?, ?)', [
    steamId,
    gameId,
    new Date().toISOString(),
  ]).catch((err) => {
    console.error('写入游玩记录失败:', err.message);
  });
}

function upsertFriendStatus(steamId, user = {}) {
  const gameId = normalizeGameId(user);
  const richPresence = normalizeRichPresenceMap(user.rich_presence);
  const richPresenceString = user.rich_presence_string || null;

  const gameName = resolveGameName(gameId, user.game_name || null);
  const gameSmallIcon = resolveGameIcon(gameId);

  if (gameId && !gameName) {
    ensureGameNameMapping(gameId);
  }

  const status = {
    steamId,
    personaName: user.player_name || null,
    personaStateCode: user.persona_state ?? 0,
    personaStateText: PERSONA_STATE_MAP[user.persona_state] || '未知',
    gameId,
    gameName,
    gameSmallIcon,
    richPresenceString,
    richPresence,
    party: buildPartyInfo(richPresence),
    updatedAt: new Date().toISOString(),
  };

  friendStatuses.set(steamId, status);
  recordGameChange(steamId, gameId);
}

function normalizeStatusForApi(status) {
  if (!status) {
    return status;
  }

  const normalizedGameId = normalizeGameIdKey(status.gameId);
  return {
    ...status,
    gameId: normalizedGameId,
    gameName: normalizedGameId ? status.gameName : null,
    gameSmallIcon: normalizedGameId ? status.gameSmallIcon : null,
  };
}

async function readHistory(limit = 200) {
  const rows = await dbAll(
    'SELECT user_id AS userId, game_id AS gameId, changed_at AS changedAt FROM friend_game_history ORDER BY id DESC LIMIT ?',
    [Math.max(1, limit)]
  );

  return rows
    .reverse()
    .map((row) => ({
      ...row,
      gameId: normalizeGameIdKey(row.gameId),
    }));
}

function buildLogOnOptions() {
  const accountName = process.env.STEAM_ACCOUNT_NAME;
  const password = getSteamPassword();
  const refreshToken = process.env.STEAM_REFRESH_TOKEN;

  if (!refreshToken && (!accountName || !password)) {
    throw new Error('缺少登录配置：请配置 STEAM_REFRESH_TOKEN，或配置 STEAM_ACCOUNT_NAME + STEAM_PASSWORD');
  }

  const logOnOptions = {
    machineName: process.env.STEAM_MACHINE_NAME || 'steam-monitor-js',
  };

  if (refreshToken) {
    logOnOptions.refreshToken = refreshToken;
  } else {
    logOnOptions.accountName = accountName;
    logOnOptions.password = password;
  }

  return logOnOptions;
}

function hydrateFriendStatuses() {
  if (!client.myFriends) {
    return;
  }

  const friendIds = Object.entries(client.myFriends)
    .filter(([, relationship]) => relationship === SteamUser.EFriendRelationship.Friend)
    .map(([steamId]) => steamId);

  if (friendIds.length === 0) {
    return;
  }

  client.getPersonas(friendIds, () => {
    friendIds.forEach((friendId) => {
      const user = client.users?.[friendId];
      if (user) {
        upsertFriendStatus(friendId, user);
      }
    });
  });
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    loggedOn: isLoggedOn,
    botSteamId,
    friendCount: friendStatuses.size,
  });
});

app.get('/api/friends/status', (req, res) => {
  const statuses = Array.from(friendStatuses.values())
    .map((status) => normalizeStatusForApi(status))
    .sort((a, b) => a.steamId.localeCompare(b.steamId));
  res.json({
    total: statuses.length,
    data: statuses,
  });
});

app.get('/api/friends/:steamId/status', (req, res) => {
  const status = normalizeStatusForApi(friendStatuses.get(req.params.steamId));
  if (!status) {
    return res.status(404).json({
      message: '未找到该好友状态，可能不是好友或尚未收到状态更新',
    });
  }
  return res.json(status);
});

app.get('/api/apps/:gameId/icon', async (req, res) => {
  const gameId = normalizeGameIdKey(req.params.gameId);
  if (!gameId) {
    return res.status(400).json({ message: '无效的 gameId' });
  }

  let gameName = gameNameById.get(gameId) || null;
  let iconUrl = gameIconById.get(gameId) || null;

  if (!gameName || !iconUrl) {
    try {
      const meta = await fetchGameMetadataFromStore(gameId);
      if (meta?.gameName) {
        gameName = meta.gameName;
        iconUrl = meta.iconUrl || null;
        saveGameMetadata(gameId, gameName, iconUrl);
      }
    } catch (err) {
      return res.status(500).json({
        message: '拉取游戏图标失败',
        error: err.message,
      });
    }
  }

  return res.json({
    gameId,
    gameName,
    iconUrl,
  });
});

app.get('/api/history', async (req, res) => {
  const limit = Number(req.query.limit || 200);
  const safeLimit = Number.isNaN(limit) ? 200 : Math.min(Math.max(limit, 1), 2000);

  try {
    const history = await readHistory(safeLimit);
    res.json({
      total: history.length,
      data: history,
    });
  } catch (err) {
    res.status(500).json({
      message: '读取历史记录失败',
      error: err.message,
    });
  }
});

client.on('loggedOn', () => {
  isLoggedOn = true;
  isLoggingOn = false;
  clearLoginTimeoutTimer();
  reconnectAttempt = 0;
  clearReconnectTimer();
  botSteamId = toSteamId64(client.steamID);
  console.log('Steam 登录成功，机器人 SteamID:', botSteamId);

  client.setPersona(SteamUser.EPersonaState.Online);
  hydrateFriendStatuses();
});

client.on('refreshToken', (token) => {
  persistRefreshToken(token);
});

client.on('error', (err) => {
  isLoggingOn = false;
  clearLoginTimeoutTimer();
  console.error('Steam 客户端错误:', err.message);
  scheduleReconnect(`error:${err.message}`);
});

client.on('disconnected', (eresult, msg) => {
  isLoggedOn = false;
  isLoggingOn = false;
  clearLoginTimeoutTimer();
  console.warn(`Steam 连接断开: ${eresult} - ${msg || '无附加信息'}`);
  scheduleReconnect(`disconnected:${eresult}`);
});

client.on('steamGuard', (domain, callback) => {
  const hint = domain || '未知域名';
  if (STEAM_GUARD_CODE) {
    console.warn(`触发 Steam Guard（${hint}），使用 STEAM_GUARD_CODE 提交验证码。`);
    callback(STEAM_GUARD_CODE);
    return;
  }

  console.error(
    `触发 Steam Guard（${hint}），但未配置 STEAM_GUARD_CODE。请改用 STEAM_REFRESH_TOKEN 或在 .env 填写 STEAM_GUARD_CODE。`
  );
  isLoggingOn = false;
  clearLoginTimeoutTimer();
  scheduleReconnect('steam-guard-required');
  callback('');
});

client.on('friendRelationship', (steamID, relationship) => {
  const steamId = toSteamId64(steamID);

  if (relationship === SteamUser.EFriendRelationship.RequestRecipient) {
    console.log('收到好友请求，自动通过:', steamId);
    client.addFriend(steamID, (err) => {
      if (err) {
        console.error('自动通过好友失败:', steamId, err.message);
      }
    });
    return;
  }

  if (relationship === SteamUser.EFriendRelationship.Friend) {
    const user = client.users?.[steamId];
    if (user) {
      upsertFriendStatus(steamId, user);
    } else {
      client.getPersonas([steamId], () => {
        const freshUser = client.users?.[steamId];
        if (freshUser) {
          upsertFriendStatus(steamId, freshUser);
        }
      });
    }
  }
});

client.on('user', (steamID, user) => {
  const steamId = toSteamId64(steamID);
  if (!isFriend(steamId)) {
    return;
  }

  upsertFriendStatus(steamId, user);
});

async function start() {
  ensureStorage();
  await initDatabase();

  cachedLogOnOptions = buildLogOnOptions();
  doLogOn('初次启动');

  app.listen(PORT, () => {
    console.log(`API 服务已启动: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
