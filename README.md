<p align="center"><img src="assets/icon-180.png" width="96" alt="刷抖音"></p>

# 刷抖音 · dsh-douyin-life

> 每天替你刷一轮抖音：挑片、读评论、写日报；值得的点赞、评论并 @ 你；片子那头接你自己的 ComfyUI。
> 介绍片（16 秒，动漫风）：见 Releases 里的 jev-plugin-intro.mp4。
# dsh-douyin-life（刷抖音）

> DSH 插件。每天替使用者刷一轮抖音 —— 看视频、读评论、挑出值得的写一份日报；
> 值得的就**点赞**、并在评论里 **@ 使用者本人**；视频那一头接他自己的 **ComfyUI** 出片，把成片发到抖音。

**host-only**：这一版没有设置页（不要 `dsh.client`）。所有能力都是 dsh 工具 + HTTP 接口 + 谷时定时器。

接口契约见 [`SPEC.md`](./SPEC.md)（**唯一契约**，工具名 / 配置字段 / 家目录布局不得擅自改）。

---

## 1. 装

```bash
# 从源码目录挂进 profile（开发用）
dsh plugin --profile desktop add link:D:/jev-decision-kit/plugins/dsh-douyin-life
# 之后重启一次 dsh 才生效
```

`cordis.patch.yml` 自带的挂载声明：

```yaml
- insert:
    - id: douyin-life        # ← 必须等于 index.js 的 `export const name`
      name: dsh-douyin-life
      config:
        enabled: true
```

## 2. 家目录

`%USERPROFILE%\.dsh\douyin-duty\`（或 `$DSH_HOME/douyin-duty/`）：

| 文件 | 说明 |
|---|---|
| `config.json` | 插件自己那份配置（面板/工具写，`loadCfg` 读） |
| `state.json` | `{day,count,picked,loggedIn,loginCheckedAt,windows}` |
| `duty.log` | 一行一件事（**每条工具调用都有一行**） |
| `out/YYYY-MM-DD.md` | 每轮日报 |
| `duty.md` | 值班章程（从 `prompts/` 铺过来；**用户改过就保留**，新版落 `duty.md.new`） |
| `mcp_server.py` | Python MCP（从 `vendor/` 铺过来；**已存在不覆盖**，新版落 `.new`，`--force` 才硬覆盖） |
| `browser/` | Playwright 持久化 profile（登录态在这里） |
| `login-qr.png` | 最近一次扫码登录截的二维码 |
| `.venv/` | 可选：Python 依赖环境（`pythonPath` 指过来） |
| `headless-overlay.yml` | 跑一轮时临时叠给 headless 的 patch（把抖音 MCP 挂上） |

> ⚠️ 凭证 / 登录态 / 报告**一律落在家里**，绝不写进插件包（装进 `node_modules` 后只读、升级还会被覆盖）。
> 铺 `mcp_server.py` 时：家里没有才铺；内容不一样**不覆盖**（写 `mcp_server.py.new` 并记日志）；
> 传 `--force`（或 `DOUYIN_FORCE_COPY=1`）才强制覆盖。

## 3. 工具（14 个 `dy_*`）

| 工具 | 干什么 | 闸门 |
|---|---|---|
| `dy_status` | 今天跑没跑、挑了几条、额度、报告路径、登录态、家目录、下次窗口 | — |
| `dy_config` | 读 / 改配置（不给 `patch` 就是读） | — |
| `dy_whoami` | 抖音那边登录的是谁（`douyin_check_credential`） | — |
| `dy_login_start` | 出二维码 → 返回 PNG 路径（配 `present` 推给本人） | — |
| `dy_login_poll` | 查扫码结果 | — |
| `dy_search` | 搜视频（keyword / num / order） | — |
| `dy_video` | 单条视频信息 | — |
| `dy_comments` | 热门评论 | — |
| `dy_like` | 点赞 / 取消 | **`autoLike`** 或 `force: true` |
| `dy_comment` | 发评论 / 回复（正文自动补 `@昵称`） | **`autoComment` + `mentionName`** 或 `force: true` |
| `dy_publish` | 投稿（`video_path` 或 `latest: true` 取 ComfyUI 最新成片） | **`autoPublish`** 或 `force: true`；默认 `draft: true` |
| `dy_comfy_list` | 列 ComfyUI 输出目录里最近的 `.mp4`（递归、按 mtime） | — |
| `dy_run` | 立刻跑一轮（`dsh --profile headless <prompt>`） | — |
| `dy_selfcheck` | 真跑一次：环境四项 + 一次 `douyin_selfcheck` | — |

### 闸门（SPEC 3.3，默认全关）

- `autoLike=false` / `autoComment=false` / `autoPublish=false`：**拿使用者的号动手的事，默认一律不做**。
- `mentionName` 空 ⇒ `dy_comment` 直接拒（评论存在的意义就是 @ 那一下）。
- 越闸只能靠调用方传 `force: true`（= 本人当场让你做）。

## 4. HTTP（给以后设置页用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/douyin-duty/status` | 状态（含 `config`、`windows`、`nextWindow`、`gates`） |
| GET / POST | `/api/douyin-duty/config` | 读 / 写配置（POST 体可以直接是 patch，也可以是 `{patch:{...}}`） |
| POST | `/api/douyin-duty/login/qr` | 出码（返回 `png` 路径 + `qr` data URL） |
| POST | `/api/douyin-duty/login/poll` | 查扫码结果 |
| POST | `/api/douyin-duty/run` | 立刻跑一轮 |
| GET | `/api/douyin-duty/report/latest` | 最近一份日报（`out/` 里最新的 `YYYY-MM-DD.md`） |

## 5. 定时器

`lib/state.mjs` 的 `WINDOWS`：**中午 12:00–14:00**、**夜间 00:30–08:30**（工作日 9–12 / 14–18 是高峰不跑）。
`peakValley` 是总开关，`noon` / `night` 是子开关，`perDay` 是**每天总量上限**（数今天报告里 `### <视频id>` 的行）。
定时器回调自己兜住所有异常（未捕获异常会杀掉整个宿主进程），`ctx.effect` 收摊时 `clearInterval`。

## 6. ComfyUI 桥（宿主侧，纯 HTTP）

- `comfyUrl` 默认 `http://127.0.0.1:8188`。
- `dy_comfy_list`：读 `comfyOutputDir`（默认 `E:\Comfy-Desktop\ComfyUI-Shared\output`）里最近 N 个 `.mp4`（按 mtime，递归）。
- `dy_publish(latest: true)`：取最新一个 mp4 → 调 `douyin_publish`。
- `comfyWorkflow` 非空时：先 `POST {comfyUrl}/prompt` 排队 → 轮询 `/history/<prompt_id>` 等 `completed` → 再取最新文件。
  ⚠️ 只排队和读文件，**不做转码**；显卡在采样时别做重活。

## 7. 配置字段

| 字段 | 默认 | 说明 |
|---|---|---|
| `perDay` | `5` | 每天最多挑几条（全天总量） |
| `peakValley` | `false` | 谷时自动刷（总开关） |
| `noon` / `night` | `true` | 中午 / 夜间两个窗口 |
| `autoLike` | `false` | 自动点赞 |
| `autoComment` | `false` | 自动评论并 @ |
| `autoPublish` | `false` | 自动投稿 |
| `mentionName` | `''` | 要 @ 谁（空 = 不发评论） |
| `commentPerRound` | `1` | 每轮最多几条评论（钳 0–20） |
| `keywords` | `[]` | 关注关键词（空 = 用章程默认那几组） |
| `pythonPath` | `python` | 优先级：`pythonPath` → 家里 `.venv` → `uv` → `python` |
| `dshBin` | `''` | dsh 的 bin.js（空 = 自动探测） |
| `headlessProfile` | `headless` | 跑一轮用的 profile |
| `overlayMcp` | `true` | 跑一轮时把抖音 MCP 挂上（写 overlay） |
| `workspace` | `''` | 那一轮的工作目录（空 = 插件家） |
| `reportLevel` | `full` | `full` / `brief` / `off` |
| `comfyUrl` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `comfyOutputDir` | `E:\Comfy-Desktop\ComfyUI-Shared\output` | 成片目录 |
| `comfyWorkflow` | `''` | 可选 workflow（JSON 正文或 `.json` 路径） |
| `comfyWaitSeconds` | `900` | 等出片上限（钳 30–7200） |
| `comfyListLimit` | `20` | `dy_comfy_list` 默认列几条 |
| `publishDraft` | `true` | 投稿默认存草稿 |

> 每个字段都带 `.extra('volatile', true)` —— 没有它，DSH 的 `settings.update()` 会报
> `has no volatile fields`。范围钳制只有 `clampPatch` 一份（写和读两头都过）。

## 8. 环境问题怎么降级

| 情况 | 表现 |
|---|---|
| `@deepseek-ai/schemastery` 拿不到 | `Config` 是 `undefined`，**插件照常加载**，只是没有设置表单 |
| `@deepseek-ai/dsh-tools` 拿不到 | `lib/hostdeps.mjs` 用**本地等价 defineTool** 顶上（一样校验 `additionalProperties`） |
| `vendor/douyin-mcp/mcp_server.py` 还没写 | 启动只记一行"缺文件"，工具照常注册；调 MCP 的工具返回 `ok:false` + 怎么修 |
| Python 缺失 / MCP 起不来 | `dy_whoami` / `dy_login_*` / `dy_search` … 返回 `{ok:false, error, hint}`，**不抛异常** |
| 抖音没登录 | Python 半边返回 `{ok:false, needLogin:true, hint}`，宿主原样带出来 |
| ComfyUI 目录不存在 | `dy_comfy_list` 返回 `ok:true, exists:false, items:[]` + hint |
| ComfyUI 出片超时 / 报错 | `dy_publish` 返回 `ok:false, error` + "清空 comfyWorkflow 直接投已有文件" |
| 找不到 dsh | `dy_run` 返回 `started:false` + 怎么填 `dshBin`，并补一份占位日报 |
| 配置写不进 DSH 设置层 | 本地 `config.json` 仍然生效（`touchedKeys` 优先），日志里说明 |

整条 `apply` 的每一步都包了 `try/catch`：**插件加载失败比少个功能糟得多**。

## 9. 自检

```bash
node --check index.js
node --check lib/state.mjs
node --check lib/mcp.mjs
node --check lib/hostdeps.mjs
node selfcheck.mjs      # 假 ctx 跑一遍：14 个工具 + 路由 + dy_status 结构 + 闸门
```

`selfcheck.mjs` 把 `DSH_HOME` 指到临时目录，**不碰真实的 `.dsh`**；没装 Python / 没有 ComfyUI 的机器也能全绿。

## 10. 目录

```
index.js              宿主半边：14 个工具 + HTTP + 定时器 + 配置 + ComfyUI 桥
cordis.patch.yml      bundle patch（id: douyin-life）
lib/hostdeps.mjs      从宿主树取 @deepseek-ai/*（拿不到就降级）
lib/mcp.mjs           极简 MCP stdio 客户端
lib/state.mjs         家目录 / 谷时窗口 / 铺文件 / 章程升级
prompts/duty.md       一轮要做的事（用户可改）
vendor/douyin-mcp/    Python MCP（Playwright 驱动真实网页；另一个实现方负责）
selfcheck.mjs         冒烟测试
```

---

## 复用「本人已经登录的 Chrome」（CDP，2026-10-23 加）

插件默认走**两个浏览器模式**，由 `cdpUrl` 决定：

| 模式 | 触发 | 登录态从哪来 |
|---|---|---|
| **cdp** | `cdpUrl` 非空（默认 `http://127.0.0.1:9222`）且端口通 | 那个 Chrome 自己的 profile |
| **profile** | CDP 连不上 | 插件家目录的 `browser/`，首次扫码一次 |

`dy_chrome_open` 负责把带调试端口的 Chrome 拉起来：

1. **Chrome 136+ 在默认 `user-data-dir` 上会静默忽略 `--remote-debugging-port`**（安全策略）——
   所以不能直接对日常 profile 开调试端口（实测：端口文件里是随机端口，实际没监听）。
2. 它的做法是**把日常 profile 的登录态拷一份**到 `%USERPROFILE%\.dsh\douyin-duty\chrome-profile\`
   （`Local State` + `Default\Network\Cookies` + `Default\Preferences`，约 0.1MB），
   再用 `--user-data-dir=<那份拷贝> --remote-debugging-port=9222` 起 Chrome。Cookie 用 DPAPI 解，同一个用户下有效。
3. Chrome 正在跑的时候就**先让他关掉**（`needClose:true` + `command` 里给完整命令），否则同一个 profile 拉起来的实例不开调试端口。

> 本机实测（2026-10-23）：Chrome 默认 profile 里 **douyin 的 cookie 是 0 条**（他日常用 Edge 开的抖音），
> 所以 CDP 连上了但这个浏览器本身没登录抖音 —— `dy_selfcheck` 会如实报 `loggedIn:false`，
> 接着跑 `dy_login_start` 扫一次码，登录态就落进 `chrome-profile/` 里，以后都算"已登录"。

## 家目录（宿主与 Python 必须同一个）

`%USERPROFILE%\.dsh\douyin-duty`，只有 `DSH_DOUYIN_HOME` 能改。
**不要跟 `DSH_HOME` 走**：本机 `DSH_HOME=D:\dsh`，跟着走会出现"宿主算 D:\dsh、Python 写 ~/.dsh"，
二维码和 profile 分家，登录态永远对不上（已修，见 `lib/state.mjs` 的注释）。

## 依赖（Python 半边）

`mcp>=1.9,<2`（2.x 把 FastMCP 改名成 MCPServer，直接 ImportError）+ `playwright>=1.45`。
插件按优先级找解释器：`config.pythonPath` → 家里 `.venv\Scripts\python.exe` → `uv` → `python`。
家里那份 venv 已建好并装齐（`.venv`）。

## 本机装法（已完成）

```powershell
# profile 的 package.json：dependencies 加 link:，dsh.profile.bundles 加 dsh-douyin-life
# node_modules 里建 junction
New-Item -ItemType Junction -Path "D:\dsh\profiles\desktop\node_modules\dsh-douyin-life" `
  -Target "D:\jev-decision-kit\plugins\dsh-douyin-life"
```

⚠️ **bundle 层要重启一次 dsh 才组装**：重启后 `dy_*` 这 15 个工具才会出现在工具表里。

## 2026-10-23 实测（真跑，不是设计稿）

- `node selfcheck.mjs`：54 条断言 / 53 PASS / 1 SKIP / 0 FAIL
- 端到端（真 import 插件 → 真起 Python MCP → 真连 CDP Chrome）：
  - 15 个工具全部注册；`/api/douyin-duty/*` 路由挂上
  - `dy_status`：home/py=venv/scriptReady/CDP(Chrome 155, ok)/ComfyUI 输出目录 全对
  - `dy_selfcheck`：`ok:true`，`mode:cdp`
  - `dy_video`（未登录也能读详情）：孙策那条，3.0 万赞 / 166 评论 / 2120 分享，来源 `xhr`
  - `dy_comments`：5 条真实评论，cid 从 `/comment/list/` XHR 拿
  - `dy_like`：默认被闸门挡住（`autoLike=false`），文案对
- **还没验证**：登录后的搜索 / 点赞切换 / 发评论回执 / 投稿上传（要人扫一次码）

---

## 设置页（`client.js`，2026-10-23 加）

装好重启后：**设置 → 刷抖音**（跟「刷B站」并排，order=31）。

顶部一排状态徽章 + 「现在跑一轮」：

```
今天已挑 0/5 条 · 环境已就绪 · 抖音未登录 · CDP 已连 · v0.1.0        [现在跑一轮]
```

四个 tab（每页顶上都有「保存」）：

| tab | 内容 |
|---|---|
| **日常** | 峰谷时段自动刷（总开关 → 中午 12:00–14:00 / 夜间 00:30–08:30 子开关）、每天最多挑几条、它刷过的视频（看报告 / 打开报告文件夹） |
| **偏好** | 关注关键词、日报形态（完整 / 每条一两行 / 不写）、人设提示词 |
| **互动** | 自动点赞、自动评论并 @ 你（→ @谁的昵称、每轮最多几条）、自动发布视频（→ 只存草稿） |
| **高级** | 环境自检、拉起 Chrome、看日志、扫码登录（二维码直接显示在页里）+ 我扫完了、ComfyUI 地址/输出目录/工作流、CDP 地址+端口、打开家目录/报告文件夹 |

对应接口（都在 `/api/douyin-duty` 前缀下）：

```
GET  /status            GET/POST /config        POST /run
POST /login/qr          POST /login/poll        GET  /report/latest
POST /selfcheck         POST /chrome/open       GET  /log/tail        POST /open
```

### 页面自检（不需要 dsh 重启也能跑）

```powershell
node tools/smoke-client.mjs
# 期望最后一行：PASS client registers 设置 → 刷抖音
```

它用假 `window.__ModuleLoader__` + 假 React 跑一遍 bundle，断言：

- 包名（`id`）与 package.json 一致；
- `factory` 返回 `{ inject: ['slots'], apply }`；
- `apply` 真的往 `settings.section` 注册了一项，`label === '刷抖音'`；
- CSS 注入成功。

⚠️ **页面要重启一次 dsh 才会出现**（client bundle 是启动时组装的）。
重启后如果「刷抖音」这一页是空白，把浏览器 console 的报错发来 —— 那是 React 渲染期的问题，`tools/smoke-client.mjs` 查不出来。

---

## 「自己做」那两件事（2026-10-23 加：自己发评论 / 自己发视频）

使用者原话：**"还会自己发评论和发视频，这个也要做进去"**。做进去的不是一句话，是四道闸 + 一本账：

| 机制 | 位置 | 行为 |
|---|---|---|
| **闸门** | utoComment / utoPublish 默认 alse | 关着时 dy_comment / dy_publish 直接返回 locked；本人当场让你做时传 orce: true |
| **配额** | commentPerDay（默认 3）/ publishPerDay（默认 1） | 按天算，到量就挡；  = 一条都不发 |
| **防重复** | <家>/ledger.json | 视频按「路径+大小+mtime」认；同一条已投过 ⇒ 返回 lready: true（除非 orce） |
| **@ 兜底** | 宿主层 | 正文里没有 @昵称 就替它补在开头（不改说法）；超 300 字截断 |
| **记账** | ledger.json | 只有**真成功**才写（
eedLogin / 报错不写），设置页那两个「今天评论 x/y · 今天投稿 x/y」就是从这儿数的 |

顺序也是想过的：先判 lready 再判配额 —— 不然"这条投过了"会被"今天超量了"盖住，人看不出到底哪件事。

发视频这条路：dy_comfy_list（列 ComfyUI 最近成片）→ dy_publish(latest: true)（取最新那条）→ 标题用 publishTitle 模板（{date} 替换）+ publishTags 默认话题 → **默认 draft: true 只存草稿**，设置页那个按钮（你自己点的）也是草稿优先。

### 这一块的验证（
ode tools/verify-doing.mjs，11 条断言全绿）

`
PASS  评论：autoComment 关着 => 挡住
PASS  投稿：autoPublish 关着 => 挡住
PASS  评论：每天上限 0 => 挡住
PASS  评论：漏了 @ 会补在开头            --- @测试人 这段不错
PASS  评论：没登录时不记账（今天仍 0 条）
PASS  投稿：每天上限 0 => 挡住
PASS  投稿：会挑到 ComfyUI 最新那条 mp4   --- …\outfit-spin-v21_00001_.mp4
PASS  投稿：未登录 => 不记成功账
PASS  投稿：同一条片子不重复投（already）
PASS  投稿：force 才允许再投一次
PASS  duty.log 记下了这两件事
`

⚠️ **这条路径的最后一步（真发出去）没验过**：要登录才能提交，目前 
eedLogin=true。
登录后跑一次 dy_comment(..., force:true) / dy_publish(latest:true) 就能确认抖音那边真收下了。

---

## 短信验证码登录（2026-10-23 加，使用者要求）

抖音除了扫码，新设备上还会要短信验证码。现在有两条工具能走完这一步：

| 工具 | 作用 |
|---|---|
| dy_login_sms(phone) | 切到「验证码登录」tab → 填手机号 → 点「获取验证码」；返回 
eedCode: true、sent（有没有看到倒计时） |
| dy_login_sms_submit(code) | 把 6 位验证码填进去、点「登录」，最多等 15 秒确认登录态；成功返回 loggedIn: true |

MCP 侧对应 douyin_login_sms / douyin_login_sms_submit，选择器多套候选（input[placeholder*='手机号']、input[maxlength='6'] 等），
「验证码登录」tab 用文案点（验证码登录 / 短信验证登录）。

口径：手机号只用**本人当场给的那个**，不猜不存；短信只发一次，验证码用完即弃（只在内存里过一遍，不落盘）。

⚠️ 还没在真机上跑过这一步（要真发一条短信到本人手机）—— 第一次用会出现两种结果之一：
sent: true（短信到了，把 6 位给 dy_login_sms_submit）或 sent: false（点了但没看到倒计时，说明按钮文案/结构变了，把页面文案发来我改选择器）。
