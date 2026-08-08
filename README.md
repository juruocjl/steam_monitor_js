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

如果 `STEAM_PASSWORD` 中包含 `#`，当前程序会按 `.env` 原始值读取，不会被当成注释截断。

可选语言配置：

- `STEAM_LANGUAGE=schinese`（默认，简体中文）

这会影响 `rich_presence_string` 等本地化文本。

登录稳定性配置：

- `STEAM_LOGIN_TIMEOUT_MS`：登录超时自动重试阈值（默认 30000）
- `STEAM_SOCKS_PROXY`：Steam 登录连接使用的 SOCKS4/5 代理
- `STEAM_WEB_COMPATIBILITY_MODE`：强制使用 WebSocket 443；配置 SOCKS 代理时默认启用
- `CLASH_AUTO_FAILOVER_ENABLED`：连接失败时先探测并切换 Clash 节点，再进行一次受控重连
- `CLASH_FAILOVER_GROUP` / `CLASH_FAILOVER_CANDIDATES`：要切换的选择器及按顺序尝试的候选组
- `STEAM_GUARD_CODE`：可选，一次性 Steam Guard 验证码（更推荐使用 `STEAM_REFRESH_TOKEN`）
- `STEAM_AUTO_RELOGIN`：是否启用 `steam-user` 内建自动重连（默认 `false`，建议使用本项目自定义重连）
- `STEAM_CRASH_ON_ERROR`：Steam 客户端出错时是否直接退出进程（默认 `false`，使用进程内分级重试和自动恢复）
- `STEAM_RECOVERY_BASE_MS` / `STEAM_RECOVERY_MAX_MS`：连接连续失败后的恢复探测退避范围，默认从 1 分钟指数增长并封顶 30 分钟

如果网络环境导致 Steam 商店接口超时，可配置：

- `HTTPS_PROXY`：请求代理地址
- `STEAM_STORE_TIMEOUT_MS`：单次超时（毫秒）
- `STEAM_STORE_RETRY_TIMES`：重试次数
- `STEAM_STORE_RETRY_DELAY_MS`：重试间隔基准（毫秒）

## 3. 启动

```bash
npm start
```

启动后默认监听：

- `http://localhost:3000`

### Docker 部署

服务端推荐使用 Docker Compose 运行，让 Docker 负责自动重启：

```bash
mkdir -p data
docker compose up -d --build
```

Compose 使用 host 网络访问宿主机上仅监听回环地址的 Clash SOCKS 端口，并将 API 仅监听在宿主机本地：

- `http://127.0.0.1:5555`

默认代理地址为 `socks5://127.0.0.1:7891`。如果服务器没有本机 Clash/Mihomo，删除 `compose.yaml` 中的 `STEAM_SOCKS_PROXY`、`STEAM_WEB_COMPATIBILITY_MODE` 和 `network_mode`，恢复端口映射部署。

连接类错误（如 `NoConnection`、`ServiceUnavailable`、连接超时）发生时，服务会通过 Mihomo 控制接口测试候选节点，切换成功后再尝试登录。短重试达到上限后不会退出或永久熔断，而是按 1、2、4、8、16、30、30... 分钟自动恢复；每轮先探测 Steam CM，探测失败时不会发送登录请求，探测成功才尝试一次登录。认证拒绝、限流和 Steam Guard 仍会硬熔断，避免无效凭证造成登录风暴。

容器会挂载宿主机的 `.env` 和 `data/`。程序登录成功后更新的 `STEAM_REFRESH_TOKEN` 会立即用于后续重连并写回宿主机 `.env`；容器进程重启时也会直接读取该文件中的最新 token。SQLite 历史会保存在宿主机 `data/friend_game_history.db`。

## 4. API 说明

### 健康检查

`GET /api/health`

返回示例：

```json
{
  "ok": true,
  "loggedOn": true,
  "friendStatusReady": true,
  "reconnectStopped": false,
  "consecutiveLoginFailures": 0,
  "maxConsecutiveLoginFailures": 3,
  "lastLoginError": null,
  "steamProxyEnabled": true,
  "steamWebCompatibilityMode": true,
  "botSteamId": "7656119xxxxxxxxxx",
  "friendRelationshipCount": 12,
  "friendCount": 12
}
```

仅当 Steam 已登录且好友状态完成首次加载时，健康检查返回 HTTP 200；未就绪或重连已熔断时返回 HTTP 503。`friendRelationshipCount` 是 Steam 返回的完整好友关系数量，`friendCount` 是已缓存状态数量。

连接错误连续失败次数达到 `STEAM_MAX_CONSECUTIVE_FAILURES`（默认 3）后会进入低频自动恢复，不需要人工重启。`AccessDenied`、`RateLimitExceeded`、Steam Guard 或连续未知错误仍会停止自动重连；这类凭证/策略错误需要人工处理。健康接口会返回 `recoveryMode`、`recoveryAttempt`、`nextRecoveryAt` 和最近一次 `lastRecoveryProbe`，便于区分“正在恢复”和“永久停止”。

### 好友状态列表

`GET /api/friends/status`

返回字段包含：

- `steamId`
- `personaName`
- `personaStateCode`
- `personaStateText`
- `gameId`
- `gameName`
- `gameSmallIcon`（小图标 URL）
- `richPresenceString`（即 `rich_presence_string`，可直接用于展示）
- `richPresence`（即 `user.rich_presence` 原样返回）
- `party`（组队信息：`groupId`、`groupSize`、`connect`）
- `updatedAt`

说明：当 `gameName` 或 `gameSmallIcon` 为空时，服务会根据 `gameId` 自动维护映射（本地 SQLite 缓存 + Steam 商店接口补全）。

### 按游戏获取小图标

`GET /api/apps/:gameId/icon`

返回示例：

```json
{
  "gameId": 570,
  "gameName": "Dota 2",
  "iconUrl": "https://cdn.cloudflare.steamstatic.com/steam/apps/570/capsule_184x69.jpg"
}
```

说明：如果 `user.rich_presence` 是 `[{ key, value }]` 数组格式，服务会先自动转换成字典对象，再用于 `richPresence` 返回和 `party` 解析。

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
