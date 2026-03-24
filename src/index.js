const fs = require('fs');
const path = require('path');
const express = require('express');
const SteamUser = require('steam-user');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(process.cwd(), 'data');
const DB_FILE = process.env.SQLITE_DB_PATH || path.join(DATA_DIR, 'friend_game_history.db');
const ENV_FILE = path.join(process.cwd(), '.env');
const STEAM_LANGUAGE = process.env.STEAM_LANGUAGE || 'schinese';

const app = express();
const client = new SteamUser({
  autoRelogin: true,
  renewRefreshTokens: true,
  enablePicsCache: true,
  language: STEAM_LANGUAGE,
});

const friendStatuses = new Map();
const lastRecordedGameByFriend = new Map();
let botSteamId = null;
let isLoggedOn = false;
let db = null;

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
  await dbRun(`
    CREATE TABLE IF NOT EXISTS friend_game_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      game_id INTEGER NOT NULL,
      changed_at TEXT NOT NULL
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

  await dbRun('CREATE INDEX IF NOT EXISTS idx_history_user_id ON friend_game_history(user_id)');
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
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function buildPartyInfo(richPresence = {}) {
  const groupSize = Number(richPresence.steam_player_group_size || 0);
  return {
    groupId: richPresence.steam_player_group || null,
    groupSize: Number.isNaN(groupSize) ? null : groupSize,
    connect: richPresence.connect || null,
  };
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
  const richPresence = user.rich_presence || {};
  const richPresenceString = user.rich_presence_string || null;

  const status = {
    steamId,
    personaName: user.player_name || null,
    personaStateCode: user.persona_state ?? 0,
    personaStateText: PERSONA_STATE_MAP[user.persona_state] || '未知',
    gameId,
    gameName: user.game_name || null,
    richPresenceString,
    richPresence,
    party: buildPartyInfo(richPresence),
    updatedAt: new Date().toISOString(),
  };

  friendStatuses.set(steamId, status);
  recordGameChange(steamId, gameId);
}

async function readHistory(limit = 200) {
  const rows = await dbAll(
    'SELECT user_id AS userId, game_id AS gameId, changed_at AS changedAt FROM friend_game_history ORDER BY id DESC LIMIT ?',
    [Math.max(1, limit)]
  );

  return rows.reverse();
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
  console.log(logOnOptions);
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
  const statuses = Array.from(friendStatuses.values()).sort((a, b) => a.steamId.localeCompare(b.steamId));
  res.json({
    total: statuses.length,
    data: statuses,
  });
});

app.get('/api/friends/:steamId/status', (req, res) => {
  const status = friendStatuses.get(req.params.steamId);
  if (!status) {
    return res.status(404).json({
      message: '未找到该好友状态，可能不是好友或尚未收到状态更新',
    });
  }
  return res.json(status);
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
  botSteamId = toSteamId64(client.steamID);
  console.log('Steam 登录成功，机器人 SteamID:', botSteamId);

  client.setPersona(SteamUser.EPersonaState.Online);
  hydrateFriendStatuses();
});

client.on('refreshToken', (token) => {
  persistRefreshToken(token);
});

client.on('error', (err) => {
  console.error('Steam 客户端错误:', err.message);
});

client.on('disconnected', (eresult, msg) => {
  isLoggedOn = false;
  console.warn(`Steam 连接断开: ${eresult} - ${msg || '无附加信息'}`);
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

  const logOnOptions = buildLogOnOptions();
  console.log('正在登录 Steam...');
  client.logOn(logOnOptions);

  app.listen(PORT, () => {
    console.log(`API 服务已启动: http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('启动失败:', err.message);
  process.exit(1);
});
