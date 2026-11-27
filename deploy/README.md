# 后端部署（Docker）

后端是一个 Node.js 服务（`server/`），依赖 PostgreSQL 和 Redis，全部用 Docker Compose 启动。

| 文件 | 作用 |
|---|---|
| `compose.yml` | 基础：API 服务、PostgreSQL、Redis |
| `compose.dev.yml` | 本地开发：API 暴露在 `127.0.0.1:8787`，加 Mailpit 收所有邮件 |
| `compose.prod.yml` | 线上：Caddy（自动 HTTPS）+ 每日数据库备份 |
| `.env.example` | 配置项说明，复制成 `.env` 填写（`.env` 不进 git） |

## 本地开发

```bash
cp deploy/.env.example deploy/.env   # 把两个 change-me 改成随机字符串
npm run server:up                     # 构建并启动
```

- API：<http://localhost:8787>（`/health` 返回 `{"ok":true}`）
- 邮件：<http://localhost:8025>，注册、找回密码的验证码都在这里看
- 桌面端开发版默认连 `http://localhost:8787`

常用命令（在仓库根目录）：

| 命令 | 作用 |
|---|---|
| `npm run server:up` | 构建并启动（改了后端代码再跑一次即可） |
| `npm run server:logs` | 看 API 日志 |
| `npm run server:test` | 跑后端测试（单元 + 端到端，需要先 `server:up`，约 1 分钟） |
| `npm run server:down` | 停止（数据保留） |

清空本地数据（删除数据库和 Redis 的 Docker 卷，不可恢复）：

```bash
docker compose -f deploy/compose.yml -f deploy/compose.dev.yml --env-file deploy/.env down -v
```

## 上线

需要：一台装了 Docker 的 Linux 服务器、一个指向它的域名（如 `api.example.com`）、一个 SMTP 发信服务。

1. 把仓库放到服务器上，复制并填写配置：
   ```bash
   cp deploy/.env.example deploy/.env
   ```
   - `POSTGRES_PASSWORD`、`JWT_SECRET`：用 `openssl rand -base64 48` 生成
   - `SMTP_URL`、`MAIL_FROM`：发信服务给的 SMTP 地址和发件人
   - `DOMAIN`：API 域名
2. 防火墙放行 80、443 端口，然后启动：
   ```bash
   docker compose -f deploy/compose.yml -f deploy/compose.prod.yml --env-file deploy/.env up -d --build
   ```
   Caddy 会自动申请 HTTPS 证书。打开 `https://<DOMAIN>/health` 应返回 `{"ok":true}`。
3. 打包桌面端时指定服务器地址：
   ```bash
   VITE_API_URL=https://api.example.com npm run tauri build
   ```

**升级**：拉取新代码后重新执行第 2 步的命令。数据库结构变更（`server/migrations/*.sql`）在 API 启动时自动执行。

### 备份与恢复

`backup` 服务每天把数据库导出到 `deploy/backups/`，保留 14 天。建议再定期把这个目录同步到别的机器或对象存储。

恢复（会覆盖当前数据）：

```bash
gunzip -c deploy/backups/patpattap-YYYYMMDD-HHMMSS.sql.gz | \
  docker compose -f deploy/compose.yml -f deploy/compose.prod.yml --env-file deploy/.env exec -T postgres psql -U patpattap -d patpattap
```

Redis 里只有排行榜缓存、验证码和频率限制，丢了也没关系：排行榜会从数据库自动重建。

### 日志

```bash
docker compose -f deploy/compose.yml -f deploy/compose.prod.yml --env-file deploy/.env logs -f server
```

每个容器的日志最多保留 5 × 10 MB。

## 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `POSTGRES_PASSWORD` | 必填 | 数据库密码 |
| `JWT_SECRET` | 必填 | 登录令牌签名密钥，至少 32 个字符；更换后所有人需重新登录 |
| `SMTP_URL` | `smtp://mailpit:1025` | 发信地址，如 `smtps://user:pass@smtp.example.com:465` |
| `MAIL_FROM` | `PatPatTap <no-reply@patpattap.local>` | 发件人 |
| `DOMAIN` | 线上必填 | API 域名 |
| `CORS_ORIGINS` | 桌面端的几个来源 | 允许访问 API 的页面来源，一般不用改 |
| `DAILY_TZ_OFFSET_MIN` | `480` | 每日挑战按哪个时区换天（分钟，480 = 北京时间） |
