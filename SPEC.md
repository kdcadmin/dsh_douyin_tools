# dsh-douyin-life 契约（SPEC）

插件中文名「**刷抖音**」。一句话：每天替使用者刷一轮抖音 —— 看视频、读评论、挑值得的写一份日报，值得的就点赞并在评论里 **@ 使用者**；
视频那一头接他自己的 **ComfyUI**（出片），把成片发到抖音。

本文件是**唯一接口契约**。两个实现方（MCP 半边 / 宿主半边）都按它写，不得擅自改名字。

## 0.2.1 当前约束（优先于下方历史说明）

- 宿主公开 31 个 dy_* 工具；客户端设置页使用相同的受控入口。
- 写动作需要 ok=true 且 verified=true。pending/unknown 保留额度且不自动重发；明确失败才允许重试。
- headless 的 MCP 受白名单与 DOUYIN_ALLOW_WRITES 控制，并经 DOUYIN_PROXY_URL 的带凭证回环入口执行；宿主重新核对开关、完整昵称、作品所有权、额度和幂等性。headless 不能传 force 绕过检查。
- 账本 schemaVersion=2，保留 published/comments/replies/shares/plainComments/dm/actions/picks。JSON 原子替换；并发跨入口使用账号锁。
- 报告是展示文件；picks 是选择事实。首次迁移旧报告时按日期+视频 ID 去重，之后编辑报告不影响额度。state.count 是轮数。
- 评论确认需要本次提交后请求的 POST 回执、匹配的作品/父评论 ID 和 CID；私信、表情和分享需要新增出站消息证据。
- 公开普通评论、自动私信在新安装中默认关闭。已有显式设置保留。
- 本机使用转写摘录模板；persona.md 与 personaPrompt 用于模型模式。@豆包和本机自动投稿暂未接线。草稿转发布当前要求在创作者中心人工确认，不重新上传同一素材。
- 临时音轨在任务结束清理；Whisper 在可终止子进程中运行；缓存 v2 按视频、取样预算和模型区分。
- 代码修复与线上进程加载分开验收，状态 build.loadedMcp 返回实际进程 PID、脚本路径、源码 hash。没有调用过新版 MCP 时该项可能为空。

## 0. 目录

```
<插件根>/
  package.json          # dsh 插件包（host-only，不要 dsh.client）
  cordis.patch.yml      # bundle patch，insert id: douyin-life
  index.js              # 宿主半边：工具 + HTTP + 定时器 + 配置
  lib/hostdeps.mjs      # 从宿主树取 @deepseek-ai/*，拿不到退化（照抄 dsh-bili-scroll 同名文件）
  lib/mcp.mjs           # 极简 MCP stdio 客户端（照抄）
  lib/state.mjs         # 家目录 / 谷时窗口 / 配置读写（改常量）
  prompts/duty.md       # 一轮要做的事（用户可改）
  vendor/douyin-mcp/mcp_server.py   # Python MCP（Playwright 驱动真实网页）
  vendor/douyin-mcp/requirements.txt
  README.md
```

参考实现（**只读，不要改**）：`<DSH_HOME>\profiles\desktop\node_modules\dsh-bili-scroll\`
其中 `package.json` / `cordis.patch.yml` / `lib/hostdeps.mjs` / `lib/mcp.mjs` / `lib/state.mjs` / `prompts/duty.md`
可以直接照搬改名字，`index.js` 只照**骨架**（工具注册、HTTP、定时器），不要照搬 B站 业务。

## 1. 家目录

`%USERPROFILE%\.dsh\douyin-duty\`（Windows）或 `~/.dsh/douyin-duty/`，仅 DSH_DOUYIN_HOME 可显式覆盖

```
config.json            # 宿主写；loadCfg 读
state.json             # {day, count}
duty.log               # 一行一件事
out/YYYY-MM-DD.md      # 每轮日报
duty.md                # 从 prompts/ 铺过来（用户改过要保留，新版落 duty.md.new）
mcp_server.py          # 从 vendor/ 铺过来（凭证就落在家里，别落进插件包）
browser/               # Playwright 持久化 profile（登录态在这里）
login-qr.png           # 最近一次扫码登录的二维码
.venv/                 # Python 依赖环境
```

## 2. Python MCP（`vendor/douyin-mcp/mcp_server.py`）

- **协议**：MCP over stdio，用 `mcp` 包（`FastMCP`）。**stdout 只能出协议帧**，日志一律 `stderr`。
- **打印**：`ensure_ascii=False` 的中文必须配 `PYTHONUTF8=1`（宿主已设）。
- **浏览器**：`playwright` + **`channel="chrome"`**（用系统 Chrome，不下载 Chromium）；
  `launch_persistent_context(<家>/browser, headless=True, locale="zh-CN", viewport 1440x900)`，
  UA 用真实桌面 Chrome UA。**默认 headless**。
- **反爬现实**（已实测）：`www.douyin.com` 首页能开；**搜索/点赞/评论/投稿都要登录**
  （未登录时搜索页正文写着「登录后即可搜索更多精彩视频」，页面里有「扫码登录」弹层）。
  ⇒ 所有工具在未登录时必须返回 `{"ok": false, "needLogin": true, "hint": ...}`，**不许抛异常崩掉**。
- **每个工具都要有超时**（默认 45s），失败返回 `{"ok": false, "error": "..."}`。

### 工具清单（名字固定）

| 工具 | 入参 | 出参（关键字段） |
|---|---|---|
| `douyin_check_credential` | — | `{ok, loggedIn, nickname?, uid?}` |
| `douyin_login_qr` | — | `{ok, png: "<家>/login-qr.png", hint}` 截二维码图存盘并返回路径 |
| `douyin_login_poll` | — | `{ok, loggedIn}` 检测登录态（昵称头像出现 / cookie 里有 `sessionid`） |
| `douyin_search` | `keyword`, `num=10`, `order="general"` | `{ok, items:[{aweme_id,title,author,digg,comment,share,duration,url,cover}]}` |
| `douyin_video` | `aweme_id` | `{ok, aweme_id,title,desc,author,digg,comment_count,url,publish_time}` |
| `douyin_comments` | `aweme_id`, `num=30` | `{ok, items:[{cid,user,text,digg,time}]}` |
| `douyin_like` | `aweme_id`, `undo=False` | `{ok, liked}` |
| `douyin_comment` | `aweme_id`, `text`, `reply_cid=""` | `{ok, cid, text}` |
| `douyin_publish` | `video_path`, `title`, `tags=""`, `draft=True` | `{ok, url, draft}` |
| `douyin_selfcheck` | — | `{ok, chrome, profile, loggedIn, searched, notes[]}` |

`aweme_id` = 抖音视频数字 id（`https://www.douyin.com/video/<id>`）。`douyin_search` 也要接受整条链接并抽 id。

- `douyin_publish`：走 `https://creator.douyin.com/creator-micro/content/upload`，`set_input_files` 塞 `video_path`，
  填标题/话题，`draft=True` 时**存草稿不点发布**（默认），`draft=False` 才点「发布」。
  ⚠️ 未登录或页面结构变化 ⇒ 返回 `{ok:false, needLogin|error}`。
- 选择器一律**多套候选**（`data-e2e` 优先，其次文案/结构），写成一个 `first_of(page, [...])` 帮助函数。
- 取不到就**如实返回空数组 + notes**，不要编数据。

## 3. 宿主半边（`index.js`）

### 3.1 模块头（照 bili 的骨架）

```js
export const name = 'douyin-life'
export const inject = ['webServer', 'tools', 'settings']
export const Config = !z ? undefined : z.object({ ...每个字段 .extra('volatile', true) })
export function apply(ctx, config) { ... }
```

- `defineTool` / `z` 从 `./lib/hostdeps.mjs` 取（拿不到必须降级，**不许裸 import `@deepseek-ai/*`**）。
- loader entry 的 id 必须等于 `douyin-life`（见 cordis.patch.yml）。
- 工具返回值必须过 `safe()`（JSON 无损）。

### 3.2 工具清单（`dy_` 前缀）

| 工具 | 说明 |
|---|---|
| `dy_status` | 今天跑没跑、额度、报告路径、登录没、家目录、下次窗口 |
| `dy_config` | 不给 `patch` 就是读；给了就改（只认 Config 里的字段） |
| `dy_whoami` | 抖音那边登录的是谁 |
| `dy_login_start` | 出二维码 → 返回 PNG 路径（配 `present` 推给使用者） |
| `dy_login_poll` | 查扫码结果 |
| `dy_search` | 搜视频（keyword/num/order） |
| `dy_video` | 单条视频信息 |
| `dy_comments` | 热门评论 |
| `dy_like` | 点赞（受 `autoLike` 闸控制，`force` 可越） |
| `dy_comment` | 发评论 / 回复（受 `autoComment && mentionName` 闸控制，`force` 可越） |
| `dy_publish` | 发一条视频（`video_path` 或 `latest=true` 取 ComfyUI 最新成片；受 `autoPublish` 闸控制） |
| `dy_comfy_list` | 列 ComfyUI 输出目录里最近的成片（`comfyOutputDir`） |
| `dy_run` | 立刻跑一轮（起 `dsh --profile headless <prompt>`，把 duty.md 交过去） |
| `dy_selfcheck` | 真跑一次：登录检查 + 一次搜索，直接回答"能不能用" |

### 3.3 闸门（默认全部关）

- `autoLike=false`、`autoComment=false`、`autoPublish=false`：拿使用者的号动手的事，**默认一律不做**。
- `mentionName` 空 ⇒ `dy_comment` 直接拒（理由：评论存在的意义就是 @ 那一下）。
- 越闸只能靠调用方传 `force: true`（= 本人当场让你做）。

### 3.4 HTTP（给以后设置页用）

`/api/douyin-duty/status`、`/config`(GET/POST)、`/login/qr`、`/login/poll`、`/run`、`/report/latest`。
用 `ctx.webServer.register({...})`，照 bili 的写法。

### 3.5 定时器

照 `lib/state.mjs` 的 `WINDOWS`（谷时：12:00–14:00 / 00:30–08:30，工作日 9–12、14–18 是高峰不跑），
`ctx.effect(() => () => clearInterval(timer))` 收摊。`perDay` 是**每天总量上限**。

## 4. ComfyUI 桥（宿主侧，纯 HTTP）

- 地址 `comfyUrl`（默认 `http://127.0.0.1:8188`）。
- `dy_comfy_list`：读 `comfyOutputDir`（默认 `E:\Comfy-Desktop\ComfyUI-Shared\output`）里最近 N 个 `.mp4`（按 mtime）。
- `dy_publish(latest: true)`：取最新一个 mp4 → 调 `douyin_publish`。
- 可选 `comfyWorkflow`：给了就先 `POST /prompt` 排队、轮询 `/history/<id>` 等出片，只取该 prompt_id 的唯一有效 MP4 输出。
  ⚠️ 显卡在采样时不要做重活；这里只排队和读文件，不做转码。

## 5. duty.md 口径

一轮 = 搜关键词 → 逐条看（标题/作者/评论）→ 挑 1–5 条 → 写日报（`out/<日期>.md`）→ 值得的：
- `autoLike` 开 ⇒ 点赞；
- `autoComment` 开且 `mentionName` 非空 ⇒ 发一条短评论，正文里 `@昵称`（**纯文本**，别堆 emoji、别写敏感词）；
- 都不开 ⇒ 只写日报，**不许动手**。
- **发布视频只有 `autoPublish` 开才做，且默认 `draft=True`（存草稿），等本人过一眼**。

## 6. 验收

1. `node --check index.js`、`python -m py_compile vendor/douyin-mcp/mcp_server.py` 通过。
2. `python vendor/douyin-mcp/mcp_server.py --selftest` 能在没有登录的情况下跑完并打印 JSON（`needLogin`）。
3. 宿主半边能用 stub ctx 冒烟：注册出 31 个工具、HTTP 路由挂上、`dy_status` 返回结构正确。
4. 装进 `<DSH_HOME>\profiles\desktop`：`dependencies` 加 `link:D:/jev-decision-kit/plugins/dsh-douyin-life`，
   `dsh.profile.bundles` 加 `dsh-douyin-life`，`node_modules` 里建到源码目录的 junction。**重启 dsh 后生效。**
