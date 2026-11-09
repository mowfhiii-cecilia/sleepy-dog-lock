# Bark 事件服务

这个 Netlify Function 保存当前睡眠会话和每次触发证据，再代发 Bark。手机不负责算次数，Bark key 也不会下发到手机。

## 环境变量

在 Netlify Site configuration → Environment variables 中设置：

- `SLEEP_GUARD_SHORTCUT_TOKEN`：至少 32 个随机字符；只复制到使用者 iPhone 的快捷指令请求头。
- `BARK_DEVICE_KEY`：Bark 测试 URL 中的设备 key；只保留在 Netlify。
- `BARK_API_ORIGIN`：默认 `https://api.day.app`，只有自建 Bark server 时才修改。
- `BARK_ICON_URL`：可选的公开 HTTPS 头像地址；未设置时使用站点内置的抽象头像。
- `CASPIAN_OPENAI_API_KEY`：Caspian 日间唤醒专用的 OpenAI Project API key；只保留在 Netlify，绝不放进快捷指令或仓库。使用独立名称可避免与托管平台注入的同名令牌冲突。
- `OPENAI_PROJECT_ID`：该 key 所属的 OpenAI Project ID；请求时显式携带，避免多项目账户发生归属歧义。

日间唤醒的可调设置（不填时使用括号内默认值）：

- `CASPIAN_WAKE_MODEL`（`gpt-5.6-terra`）
- `CASPIAN_WAKE_MIN_MINUTES`（`10`）
- `CASPIAN_WAKE_MAX_MINUTES`（`30`）
- `CASPIAN_NOTIFICATION_COOLDOWN_MINUTES`（`360`，即 6 小时）
- `CASPIAN_INPUT_USD_PER_MILLION`（`2`）
- `CASPIAN_CACHED_INPUT_USD_PER_MILLION`（`0.2`）
- `CASPIAN_CACHE_WRITE_USD_PER_MILLION`（`2.5`）
- `CASPIAN_OUTPUT_USD_PER_MILLION`（`12`）

最后四项只是费用估算所用的价格快照；OpenAI 价格变化时可在 Netlify 设置里更新，不需要改代码。把最小和最大唤醒间隔都设为 `10`，即可固定每 10 分钟给 Caspian 一次决定机会。唤醒频率与通知冷却完全独立。

## 部署

把 Netlify 项目的 base directory 指向本仓库的 `netlify` 目录。接口为：

```text
POST https://<site>.netlify.app/api/sleep-guard-event
```

请求头：

```text
Authorization: Bearer <shortcut-token>
Content-Type: application/json
```

三个事件体：

```json
{"event":"sleep_guard_started","source":"ios_shortcuts"}
```

```json
{"event":"blocked_app_opened","app_name":"小红书","source":"ios_automation"}
```

```json
{"event":"sleep_guard_ended","source":"ios_shortcuts"}
```

`sleep_guard_started` 可选传 ISO 8601 格式的 `ends_at`，但必须在当前时间后的 24 小时内；未传时默认在上海时间下一次上午 07:30 自动过期。

如果没有先发送 `sleep_guard_started`，上海时间 23:00 至次日 07:30 的第一次 `blocked_app_opened` 会自动开启守卫、计为第一次偷开，并返回 `auto_started: true`。若使用者已发送 `sleep_guard_ended`，当天上午 07:30 前不会再次自动开启。

## 状态与证据

- 当前会话：`sleep-guard-events/state/current`
- 事件：`sleep-guard-events/events/YYYY-MM-DD/<timestamp>-<uuid>`
- 状态更新使用 ETag 条件写入并在冲突时重试，避免几乎同时打开 App 导致次数被覆盖。
- 事件在 Bark 前写入；Bark 失败时接口返回 `502`，但事件仍保留。

成功响应只包含会话状态、次数、阶段和事件 ID，不包含 Bark key：

```json
{
  "ok": true,
  "event": "blocked_app_opened",
  "active": true,
  "attempts": 1,
  "stage": "first_warning",
  "auto_started": false,
  "ignored": false
}
```

## ChatGPT MCP

远程 MCP 地址：

```text
https://<site>.netlify.app/mcp
```

它提供两个工具：

- `activate_sleep_guard`：使用者在 ChatGPT 明确说晚安或准备睡觉时开启守卫。
- `get_sleep_guard_status`：只读查询当前状态和偷开次数。

MCP 不接受快捷指令 Token。连接使用 OAuth 2.1 Authorization Code + PKCE：ChatGPT 发起连接后，服务会向使用者的 Bark 发送一次授权链接；只有从手机点按该链接，浏览器中的连接才会继续。授权码只能使用一次，访问令牌保存在独立的 `sleep-guard-mcp-auth` Blob store 中并在 90 天后失效。

OAuth 元数据、动态客户端注册、授权与令牌端点均由同一个 Netlify Function 提供。任何未认证的 `/mcp` 请求都会返回带 `resource_metadata` 的 `WWW-Authenticate`，不会调用睡眠状态机。

## Caspian Wake-Up（日间独立功能）

这套功能没有替换、修改或复用原有早安/晚安通知流程。Netlify 每 10 分钟检查一次，但只有到达随机生成的 `next_wake_at` 才真正调用模型。默认实际唤醒间隔从 10、20、30 分钟中随机选择；可用上面的环境变量调整，调度精度为 10 分钟。

一次真正的唤醒会把以下安全上下文交给 `CASPIAN_WAKE_MODEL`：

- 当前上海时间与触发来源（定时或手动测试）；
- 当前是否允许通知、通知冷却时长、上次通知时间；
- 当前睡眠守卫是否有效、次数和起止时间；
- 最近 6 条已有睡眠事件；
- 最近 5 次日间唤醒的决定、理由、是否发出通知及时间。

模型只能选择一个严格定义的 action：

- `send_notification(message, reason)`：生成一条新的 Caspian 消息，并在服务端再次通过冷却检查后用 Bark 发出；
- `do_nothing(reason)`：本次安静结束，不产生任何用户可见通知。

模型不会因为唤醒成功就被迫发消息。若还在 6 小时冷却期内，模型即使请求 `send_notification`，服务端也会将最终动作记作 `do_nothing`，并以 `cooldown_enforced: true` 留痕。23:00–07:30（上海时间）或睡眠守卫仍在有效期时，日间唤醒直接跳过，不调用模型。

### 记录与费用

- 当前状态及累计 token/估算费用：`caspian-wakeup/state/current`
- 每次真实唤醒日志：`caspian-wakeup/logs/YYYY-MM-DD/<timestamp>-<uuid>`
- `do_nothing` 是正式日志结果，不会发送用来“证明运行成功”的通知。
- 每条日志保存 input、cached input、cache-write input、output、reasoning、total token 与按环境变量价格估算的美元费用；状态中同时保存累计值。
- 估算值用于观察实验量级，不代替 OpenAI 账单。

### 手动测试与查看状态

两个入口都复用 `SLEEP_GUARD_SHORTCUT_TOKEN`，不会返回任何 secret：

```text
POST https://<site>.netlify.app/api/caspian-wakeup-test
GET  https://<site>.netlify.app/api/caspian-wakeup-status
```

两者都要带 `Authorization: Bearer <shortcut-token>`。Test Wake-Up 只跳过“尚未到随机唤醒时间”这一项；睡眠窗口、有效睡眠守卫、模型真实选择和通知冷却仍照常生效，因此测试时完全可能得到 `do_nothing`。测试响应显示本次 action、reason、token 和估算费用；status 响应显示当前设置、累计总计及最近 20 次日志。
