# Steam 好友游戏状态监视器（node-steam-user）

一个使用 `node-steam-user` 构建的 Steam 好友状态监视服务，支持：

- 自动登录（支持 `refresh token` 或账号密码）
- 自动通过好友请求
- 返回好友具体游玩状态（含富文本信息、组队信息）
- 提供 HTTP API
- 使用 SQLite 记录好友游玩状态变更（记录 `userId`、`gameId`、`changedAt`）

## 1. 安装

```bash
npm install
```

## 2. 配置

复制环境变量模板并填写：

```bash
cp .env.example .env
```

Windows PowerShell 可用：

```powershell
Copy-Item .env.example .env
```

至少配置以下任一登录方式：

- 方式 A：`STEAM_REFRESH_TOKEN`
- 方式 B：`STEAM_ACCOUNT_NAME` + `STEAM_PASSWORD`

## 3. 启动

```bash
npm start
```

启动后默认监听：

- `http://localhost:3000`

## 4. API 说明

### 健康检查

`GET /api/health`

返回示例：

```json
{
  "ok": true,
  "loggedOn": true,
  "botSteamId": "7656119xxxxxxxxxx",
  "friendCount": 12
}
```

### 好友状态列表

`GET /api/friends/status`

返回字段包含：

- `steamId`
- `personaName`
- `personaStateCode`
- `personaStateText`
- `gameId`
- `gameName`
- `richPresence`（富文本相关原始字段 + 文本提示）
- `party`（组队信息：`groupId`、`groupSize`、`connect`）
- `updatedAt`

### 单个好友状态

`GET /api/friends/:steamId/status`

### 游玩状态历史记录

`GET /api/history?limit=200`

只返回历史中的：

- `userId`
- `gameId`
- `changedAt`

> SQLite 数据库默认位于 `data/friend_game_history.db`。

## 5. 行为说明

- 当收到好友请求时，机器人会自动调用 `addFriend` 通过请求。
- 当好友状态变化时，会更新内存状态并在游戏发生变化时写入历史记录。
- 登录成功并获取到新 token 后，会自动更新 `.env` 中的 `STEAM_REFRESH_TOKEN`。
- 历史记录不保存昵称、不保存富文本，仅保存用户 ID、游戏 ID 和时间戳。

## 6. 开发模式

```bash
npm run dev
```
