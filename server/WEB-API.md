# InfoHub Web API v1

本文件是浏览器客户端与 Web 服务之间的接口契约，随 work-ontology 代码维护。入口为 `node server/web.mjs`。所有路径相对于同一站点根地址，例如 `https://infohub.example.com`。浏览器前端由独立项目构建，通过可选 `staticDir` 由 Web 服务同源托管；未配置时 `/` 显示服务就绪占位页。

## 通用约定

- JSON 请求/响应使用 UTF-8。除文件读取和 SSE 外，响应为 `application/json; charset=utf-8`，包含数字 `version`。客户端须检查版本，未知版本提示升级，不能当成空数据。
- 浏览器与 API 同源；没有跨源 CORS。`fetch` 可使用默认的同源 cookie 策略，显式设 `credentials: 'same-origin'` 也可。每个 POST、PUT、DELETE 请求都要求 `Origin` 精确等于服务器配置的 `origin`。浏览器会自动提供；脚本客户端必须提供。
- 用户名和工作区由会话决定；请求不能指定其他用户或根目录。所有 `/api` 和 `/api/` 路径均需有效会话，只有 `POST /api/login` 例外。`GET /health`、静态前端与未配置静态目录的占位 `/` 不需会话。
- 读来源参数 `source` 必填：`workspace`、`main`、`draft:<id>`。`/api/session`、`/api/sources`、`/api/events` 是会话级接口，无需 `source`。
- `workspace` 是此用户的普通 Git clone，可读写；`main`、草稿只读。它们来自该 clone 后台同步 fetch 的私有引用 `refs/infohub/remote/*`，不是直接读取其他用户的工作目录。更新速度由同步周期决定，刚上传的草稿在下一次 fetch 后出现。
- 非 workspace 文件读取响应的 `commit` 标识该次请求冻结的 Git 提交。不同请求间来源可能前进；某份草稿被清理后再次读取会 404。
- 路径用 `/` 分隔，相对库根，保留大小写。通过 `URLSearchParams` 编码 Unicode、空格、`#` 等字符。禁止绝对路径、反斜杠、控制字符、空路径段、以 `.` 开头的路径段、符号链接、Git 子模块。目录树不含隐藏文件、空目录或符号链接。
- 文件 HTTP ETag 是原字节的 SHA-256：`"sha256-<64 位小写十六进制>"`，包括双引号。相同字节在不同来源有相同 ETag。它不是 Git blob ID。
- 文件读写保留全部字节，不解析或序列化 YAML，不改换行、BOM、编码、引号、注释。前端也须保留原文，仅替换用户修改的片段；服务端无法修复前端已经改写的格式。未编辑就保存时，直接回传读取到的字节。
- 不存放外观设置、会话布局或当前项目；这些由浏览器本地存储拥有。

错误统一为：

```json
{"version":1,"error":{"code":"VERSION_CONFLICT","message":"文件已变化，请重新读取","path":"docs/a.md","currentVersion":"\"sha256-...\""}}
```

`message` 可用于展示；逻辑分支按 HTTP 状态和 `error.code`。常用状态：

| HTTP | code / 含义 |
| --- | --- |
| 400 | `SOURCE_REQUIRED`、`INVALID_PATH`、`INVALID_JSON`、`INVALID_VERSION`、`QUERY_ERROR`、`INVALID_SEARCH` 等输入错误 |
| 401 | `UNAUTHENTICATED` / 会话缺失、过期；`INVALID_CREDENTIALS` / 登录失败 |
| 403 | `ORIGIN_REJECTED` / 写请求来源不匹配；`READ_ONLY_SOURCE` / 修改只读来源；`UNSAFE_PATH` / 符号链接 |
| 404 | `FILE_NOT_FOUND`、`SOURCE_NOT_FOUND`、`NOT_FOUND` |
| 409 | `VERSION_CONFLICT`，`currentVersion` 为当前 ETag；文件已不存在时为 `null`。当前 ETag 非空时也放在响应头 |
| 413 | `BODY_TOO_LARGE` / 文件写入超过 32 MiB，JSON 请求超过 16 KiB |
| 428 | `VERSION_REQUIRED` / 写、删、移缺少版本条件 |
| 429 | `LOGIN_RATE_LIMITED` / 同一连接地址和用户名一分钟内失败 10 次，稍后重试 |
| 503 | `WORKSPACE_BUSY` / 工作区被同步或 Git 操作占用，稍后重试；`SOURCE_UNAVAILABLE` / Git 读取暂时失败 |
| 500 | 服务器读取/内部错误，不返回本机路径或秘密。保留用户正在编辑的内容并展示错误 |

409 后应保留浏览器内容，让用户选择重新载入或用最新版本明确重试。禁止自动取新 ETag 后无提示覆盖。503 可以延时重试，依然使用原版本条件。

## 登录与会话

### `POST /api/login`

```json
{"username":"alice","password":"用户输入的密码"}
```

成功 200：

```json
{"version":1,"username":"alice","expiresAt":"2026-11-09T12:00:00.000Z"}
```

设置 `infohub_session` cookie：`HttpOnly; SameSite=Strict; Path=/`；HTTPS 配置另加 `Secure`。会话默认有效 24 小时，固定到期，不滑动续期。令牌只存服务端内存中的哈希；服务重启会注销全部会话。用户名区分大小写。登录错误不会区分用户名不存在与密码错误。失败记录最多保留 1000 个地址/用户名组合；满额时新失败记录淘汰最早插入的记录，不阻止其他组合尝试登录。

### `GET /api/session`

200 形状与登录成功相同；401 时显示登录界面。

### `POST /api/logout`

200 `{"version":1,"ok":true}`；服务端立即撤销令牌并清除 cookie。没有有效会话时返回 401。

## 来源与文件

### `GET /api/sources`

```json
{"version":1,"sources":[
  {"id":"workspace","writable":true,"label":"我的工作区"},
  {"id":"main","writable":false,"label":"main","commit":"<40 位 SHA>"},
  {"id":"draft:01234567-89ab-cdef-0123-456789abcdef","writable":false,"label":"Source: alice@web","commit":"<SHA>","draft":null}
]}
```

`draft` 为 `sync status.server.drafts` 中相同 ID 的完整条目，没有扫描结果时为 `null`。`label` 是展示文字，不能代替稳定 `id`。同步尚未首次 fetch 时，列表只有 workspace。

### `GET /api/tree?source=workspace`

完整目录树的扁平表示，按路径排序；客户端按 `/` 构建嵌套视图：

```json
{"version":1,"source":"workspace","commit":null,"entries":[
  {"path":"docs","type":"directory"},
  {"path":"docs/a.md","type":"file","size":123}
]}
```

`size` 为字节数；目录无 size。只读来源的 `commit` 为该请求读取的提交 SHA。合法空库返回 `entries: []`；读取失败返回错误，不伪装成空树。

### `GET /api/file?source=workspace&path=docs%2Fa.md`

200 返回原始文件体，响应头包括 ETag、Content-Length、按扩展名指定的 Content-Type。Markdown 是 `text/markdown; charset=utf-8`；PNG/JPEG/GIF/WebP/SVG/AVIF/BMP/ICO、PDF、JSON、YAML、TXT、CSV 有对应类型；其他为 `application/octet-stream`。图片可直接用此 URL 作为同源 `img.src`，会话 cookie 自动发送。

可带 `If-None-Match: <先前 ETag>`，完全一致时返回 304，无体。文件响应带 `nosniff` 和 sandbox CSP，避免文档中的活动内容取得站点权限。

相对图片、文档链接由前端基于当前文档路径解析，保留 source；标题锚点由 Markdown 渲染器处理。API 不接受 fragment 作为文件路径的一部分。

### `PUT /api/file?source=workspace&path=docs%2Fa.md`

请求体是原始文件字节，不是 JSON 包装。编辑已有文件必须带 `If-Match: <读取的 ETag>`。新建必须带 `If-None-Match: *`，只在目标不存在时成功。不能同时带两种条件，不能用 `If-Match: *`，不能传多个或弱 ETag。

已有文件 200，新建 201。父目录按需创建。示例响应：

```json
{"version":1,"path":"docs/a.md","etag":"\"sha256-...\"","unchanged":false}
```

响应头 ETag 与 `etag` 相同。原字节完全相同则 `unchanged: true`，不重新落盘。条件不符为 409，文件不会被改写。

### `DELETE /api/file?source=workspace&path=docs%2Fa.md`

必须带文件当前 `If-Match`。200：

```json
{"version":1,"path":"docs/a.md","etag":null}
```

不存在的文件和旧 ETag 都返回 409；不会把“没删到”冒充成功。只删除普通文件，不递归删除目录。

### `POST /api/move?source=workspace`

`If-Match` 是源文件版本。JSON 体：

```json
{"path":"docs/a.md","destination":"archive/a.md","destinationVersion":null}
```

`destinationVersion` 必填：`null` 表示目标必须不存在；明确替换目标时传目标当前 ETag。源和目标都在同一用户工作区。200：

```json
{"version":1,"path":"archive/a.md","previousPath":"docs/a.md","etag":"\"sha256-...\""}
```

任一条件不符为 409，错误中的 `path` 指明冲突的是源还是目标；双方文件保持原样。只移动普通文件，父目录自动创建，不支持移动目录。

## 批注与对象链接

规范批注单独成行，位于正文（整篇批注放在一级标题后）：

```markdown
<!-- 批注 2026-11-09 lpmasser：这里需要核实 -->

<!-- 批注 2026-11-09 GPT-6.1 Sol：第一行
第二行 -->
```

写入统一使用全角 `：`；解析也接受半角 `:`。日期是有效日历日期 `YYYY-MM-DD`，作者必须非空、不能跨行或包含冒号；作者可有内部空格。内容非空、可多行，不能嵌套 HTML 注释或包含 `-->`。开始标记前和闭合标记后只允许行内空白，禁止把批注塞在正文行中。前后空白从作者和内容的返回值裁掉，内部换行归一为 `\n`，磁盘原字节始终不改。普通 HTML 注释和 fenced code（至少三个反引号或波浪线，闭合符须同字符且不少于开头长度）中的样例不算批注；YAML 属性头和嵌在正文行内的示例不算正文批注。

`infohub check`、提交前校验与服务器推送校验共用 core：未闭合、日期非法、缺作者/分隔冒号、空内容或闭合标记后还有正文均报带路径/行号的问题。模型目录内文档按现有范围整体校验，模型目录外显式指定或推送改动的 Markdown 也会校验批注格式。列表保留其他合法批注，并把坏格式列在 issues，不把非法批注当作有效记录。

### `GET /api/annotations?source=workspace`

需要会话，source 同样支持 `workspace` / `main` / `draft:<id>`。扫描指定来源全部可见 Markdown（包括没有属性头的普通文档和模型目录外的文件），不读取其他用户工作区。返回：

```json
{"version":1,"source":"workspace","commit":null,"annotations":[
  {"path":"docs/a.md","objectId":"work_item-12345678","title":"示例工作","line":12,"endLine":13,"date":"2026-11-09","author":"lpmasser","content":"第一行\n第二行"}
],"issues":[]}
```

`path` 是库内原路径。`objectId` 来自文档头的 ontology_id，`title` 来自 title；没有对应字符串时为 null。它们是文档声明的元数据，不证明对象唯一有效；对象解析错误仍由查询接口的 issues 提供。`line` / `endLine` 为完整原文件的 1 起始行号（包含 YAML 与 BOM，闭合行包含在内），可定位标记/选择范围；不是稳定批注 ID。按路径再按出现顺序返回。列表字段 content 是解析后的展示文本，**不要用它重新序列化未改正文**。

批注新增/删除仍用现有带版本条件 PUT 原文，未提供独立写接口。删除前先以原文件和当前 ETag 确认行号与作者；列表可能落后于文件，不得拿旧行号直接删新文件。普通文件变更 SSE 已覆盖批注，前端收到相关变化或 ready/reset 时刷新列表。只读来源在请求中固定 commit；workspace 与搜索一样不是多文件事务，遇到并发删除/读取失败返回 503 让客户端重读。Git 读取沿用单次输出 64 MiB 上限。

### overview 和 brief 的作者规则

Web overview 的“卡住了”只由工作对象（work_item）上的 **非用户批注** 触发：作者精确匹配服务器用户表任一 username 时视为用户本人，其批注不会触发“卡住了”。不是只比当前登录用户。其他非用户作者视为 Agent/来源。原有归档过滤、待澄清和停滞规则继续，所以用户批注不会消除同一工作本来就有的待澄清/停滞提醒。非工作对象的批注只在批注列表和 CLI brief 中显示。overview v3 的外层形状保持；卡住了的 reason 是第一条非用户批注的内容摘要（50 个 Unicode 字符，多行压成空格）。不再读取 frontmatter attention，没有兼容路径。

CLI 从 `~/.config/infohub/config.json` 的可选 `webUser`（单个用户名或用户名数组）取得相同排除集合；缺省为空，全部作者按非用户处理，不猜系统用户名。用安装器 `--web-user lpmasser` 设置；多用户本地配置可写数组。`brief` 的“需关注”包含本项目及项目本身的全部有批注对象，不按作者过滤，每行标题、条数、第一条摘要、路径及已配置网页链接。

### 深链接

`/o/<ontology_id>` 与 `/f/<path>` 由前端解析；服务端静态托管返回同一个 index.html，支持中文、空格、字面百分号的 URL 编码，查询 `source` 与 `#标题` 由前端保留。`/f/` 的任一以点开头路径段仍拒绝，含 `%2e` 编码也不会绕过。对象还没同步等业务状态由前端查询后展示，SPA fallback 的 HTTP 200 不证明该对象存在。

Web 的 find/get/around 返回的每个 Object/ObjectInfo 都增加 `url: <origin>/o/<encodeURIComponent(id)>`；overview 的工作对象及 references 也提供 url。CLI 配置可选 `webUrl` 后，find/get/around 的 JSON 采用同样字段，文本和 brief 各对象处附链接；没配置不增加字段或空 url。CLI 用 `node scripts/install.mjs --web-url https://infohub.example.com --web-user alice` 设置，重复安装保留。webUrl 只接受不含凭据、查询、fragment 的 HTTP(S) 基地址，尾斜杠去掉；对象 ID 按单个路径段编码。

## 全文搜索

### `GET /api/search?source=main&q=关键词&limit=100`

按路径顺序、从第一行开始搜索。`q` 为长度 1–200 的字面子串，忽略大小写，不解释为正则或命令。`limit` 默认为 100，范围 1–500。每个命中的行返回一次，行号从 1 开始。

```json
{"version":1,"source":"main","commit":"<SHA>","matches":[
  {"path":"docs/a.md","line":12,"snippet":"包含关键词的一段文本"}
],"truncated":false,"skipped":["assets/image.png"]}
```

片段最多 240 个 JavaScript UTF-16 code units，从命中位置之前最多 80 个开始。含 NUL、非 UTF-8 或大于 5 MiB 的文件跳过并列入 `skipped`。并发中删除的文件也记入 skipped。`truncated` 表示还有命中没返回；没有分页。workspace 搜索反映读取期间的文件状态，跨多文件不是一个事务；只读来源在请求内固定 commit。

## InfoHub 查询（仅 workspace）

这些接口直接调用 core，与同版本 CLI 完全相同，不增加 Web 包装层或额外 Git 推算。每个请求从一次 `loadVault` 快照构建查询；文件含无效元数据时沿用 CLI 的 `issues`，不能吞掉。

| HTTP GET | 等价 CLI |
| --- | --- |
| `/api/overview?source=workspace` | `infohub overview` |
| `/api/sync/status?source=workspace` | `infohub sync status` |
| `/api/find?source=workspace&arg=--type&arg=work_item` | `infohub find --type work_item --json` |
| `/api/get?source=workspace&target=work_item-12345678` | `infohub get work_item-12345678 --json` |
| `/api/around?source=workspace&arg=work_item-12345678&arg=--direction&arg=outgoing` | `infohub around work_item-12345678 --direction outgoing --json` |

find/around 的 `arg` 按 URL 出现顺序组成 CLI 参数数组，传每个选项和值为独立 arg。不是 shell 字符串。示例：

```js
const params = new URLSearchParams({ source: 'workspace' });
for (const arg of ['--type', 'work_item', '--where-not', 'progress=已取消', '--has', 'updated']) params.append('arg', arg);
const result = await fetch(`/api/find?${params}`).then(r => r.json());
```

find 支持文本、`--type`、`--project`（项目 ID 或标题）、重复 `--where field=value`、`--where-not field=value`、`--has field`，条件取交集，至少一个条件。`--json` 可省略。get 的 target 支持对象 ID 或库内 Markdown 路径。around 接受一个以上 ID/路径、可选 `--relation <模型关系名>` 和 `--direction outgoing|incoming`，默认双向。

共同数据形状：

- `Issue = {path: string, message: string}`。
- `Object = {id, type, title, path, frontmatter, progress?}`。frontmatter 保留完整解析属性，包括未知字段；读取不是编辑序列化入口。
- `ObjectInfo = Object` 去掉 `frontmatter`，用于 around。

find v1：`{version:1, objects:Object[], issues:Issue[]}`。

get v1：`{version:1, object:Object, issues:Issue[]}`。找不到有效对象为 400 `QUERY_ERROR`，沿用 CLI 查询错误语义。

around v1：

```json
{"version":1,"from":[{"id":"work-1","type":"work_item","title":"工作","path":"docs/work.md"}],"groups":[
  {"relation":"belongs_to","direction":"out","label":"所属项目","type":"project","total":1,"objects":[{"id":"project-1","type":"project","title":"项目","path":"docs/project.md"}]}
],"issues":[]}
```

`direction` 为 `out|in`；group 保留 total=0 的合法组，客户端按需要展示；无适用关系时可为空数组。对象定义还可能带 progress。

overview v3：

```text
{
  version: 3,
  references: { [objectId]: {title, path} },
  needsAction: [{ object: Object, category: "卡住了" | "等我拍板" | "停滞", reason: string }],
  projects: [{id, title, ongoingCount, deliveredCount, work: Object[]}],
  deliveryWindowDays: number,
  issues: Issue[]
}
```

sync status v1（HTTP 和 SSE 的 status 字段是同一投影）：

```text
{
  version: 1, manager: "docker" | "on-demand" | "foreground", running: boolean,
  installed: boolean | null, pid: number | null,
  settings: {fetchSeconds, draftSeconds, idleSeconds} | null,
  log, clone: {id, machine, user, root} | null,
  startedAt, checkedAt, finishedAt, idleSince,
  lastFetch, lastPull, lastDraft, lastCommit, lastPush, lastDraftCleanup,
  draft: {tree, commit, base, ref} | null,
  cleanedDraft: {ref, commit, reason} | null,
  dirtyFiles: string[], blockedFiles: string[],
  pending: { [kind]: string },
  backoff: { [kind]: {failures, retryAt, error} },
  server: {checkedAt, main, drafts: Draft[]} | null
}
```

上述时间和 log 字段均为 string 或 null，时间为 ISO 8601。`installed` 表示副本有有效同步配置，不代表系统登记存在或进程存活；`installed: null` 表示配置/状态读取失败，原因在 pending。`manager` 表示当前或最近运行的进程模式；未运行过的本地副本默认 `on-demand`，空闲退出是正常状态，`foreground` 是手动前台运行，`docker` 是服务器持续托管。`running` 独立读取 PID lease，不再读取旧系统服务登记。Draft 的字段：`ref,id,commit,updatedAt,stale,source?,base?,changedPaths?,conflicts?,error?,overlaps?`；`overlaps` 条目为 `{ref,source,paths,mergeable,conflicts,error?}`。直接显示 pending 的中文原因；running 只表示同一 PID namespace 中的同步进程存活，不表示最近网络操作成功。前端不自行推算 ahead/dirty/同步健康状态。

## SSE 变更事件

### `GET /api/events`

同源 `new EventSource('/api/events')`，使用会话 cookie。响应 `text/event-stream`，每 15 秒一条注释心跳。会话失效后连接在下次事件/心跳时关闭，重连会收到 401；客户端应请求 session 并回到登录页。

每个事件带 `id: <进程启动 UUID>:<单调序号>`。事件名与 JSON data：

| event | data |
| --- | --- |
| `ready` | `{version:1, source:"workspace", reset:true}` |
| `files` | `{version:1, source:"workspace", changes:[{path,version: ETag或null}]}` |
| `sync` | `{version:1, status: <sync status v1>}` |
| `resync` | `{version:1, source:"workspace", reason:string}` |

files 中的 `version` 是文件 ETag，删除为 null；最外层 `version` 是协议版本。移动表现为旧路径删除和新路径增加，没有独立 move 事件。事件只表示需要刷新，不包含全文。

连接建立时发 ready 和当前 sync；收到 ready/reset 或 resync 时重新读取 tree、正在显示的文档、查询结果与 sources。**没有事件历史重放**，`Last-Event-ID` 不作为增量恢复承诺；每次重连都必须按 ready 重建快照。在重新读取期间缓冲或继续处理随后到来的失效事件，避免把旧读取结果当新快照。

files 事件覆盖 HTTP 写入、外部文件变更以及同一后台同步的 Git 快进。文件系统通知是主通道，默认每 30 秒一次 stat 扫描兜底；比较 size、mtime、ctime、inode、device、mode，仅元数据变化的文件才读原字节并重算 ETag。内容不变不发 files 事件。同步状态独立观察，每 2 秒读取小型状态投影兜底，不遍历文档内容；客户端无需轮询全库。连续短暂变化可能合并，只承诺反映最终状态。sync 变化时刷新来源列表，以便发现新草稿、清理和 main 更新。接收缓慢、缓存超过 1 MiB 的连接关闭，客户端按 ready 重新同步。

## 前端构建产物部署

`staticDir` 是可选的绝对目录，必须存在、可读，并与全部用户 workspace 分离。文件公开提供，无需会话；该目录只放前端构建产物，不放凭据或 InfoHub 内容。未配置时保持 `/` 占位页和其他非 API 路径 404。配置后：

- `GET /` 读取 `index.html`，非 `/api`、`/api/` 的 GET 按 URL 路径读取静态文件；找不到文件或路径是目录时回退到根 `index.html`，支持 SPA 深层路由和尾斜杠。
- `/health` 始终返回健康 JSON，API 始终校验会话，API 错误不会回退成 HTML。只支持 GET 静态读取。
- JS、CSS、HTML、字体、WASM、图片等按扩展名提供 Content-Type，响应有 `nosniff`、原字节 ETag、`Cache-Control: no-cache`；客户端可用 If-None-Match 得到 304。静态资源不附加文档内容接口的 sandbox CSP，以便前端脚本正常运行。
- 禁止隐藏路径、反斜杠、穿越目录与符号链接。没有 `index.html` 且请求也没有对应文件时返回 404，明确表示产物未部署。

netcup 已配置 `staticDir: "/server/data/infohub-web/static"`，同名宿主机目录只读挂入 Web 容器；不会挂进同步容器。批次 2 在前端仓库执行浏览器构建，将输出目录中的 **index.html 和 assets 等内容** 上传到该宿主目录（不要多套一层 dist）。构建产物目录和文件至少应允许容器 UID 1000 读取/遍历，通常目录 0755、文件 0644。使用 Netcatty SSH/SFTP 操作，凭据方式见 server 仓库约定。

部署产物无需重建镜像或重启容器。先上传带内容哈希的新资源，最后通过同一目录下的临时文件 rename 更新 `index.html`；回退 SPA 路由和新资源随下一次请求立即生效。保持宿主机 static 目录本身不变（不要替换目录 inode），并保留仍可能被已打开页面引用的旧哈希资源，确认无需回退后再清理。初次未放前端时已有占位 index.html，可由真实构建入口替换。

## 服务配置与运行

`INFOHUB_WEB_CONFIG` 指向权限受限的 JSON 文件：

```json
{
  "version": 1,
  "origin": "https://infohub.example.com",
  "host": "0.0.0.0",
  "port": 3000,
  "sessionTtlSeconds": 86400,
  "staticDir": "/persistent/static",
  "users": [
    {"username":"alice","passwordHash":"scrypt:<32 hex salt>:<128 hex digest>","workspace":"/persistent/workspaces/alice"}
  ]
}
```

passwordHash 用 `hashPassword`（`server/web-auth.mjs`）生成，Node scrypt 默认参数 N=16384、r=8、p=1、64 字节派生键。明文密码不写入 Web 配置或命令参数；运维按自己的秘密管理工具保存初始密码。每个用户名唯一，每个 workspace 是独立普通 clone，路径不可重叠或嵌套。

启动 Web 前，为每个服务器副本创建 `.git/infohub-sync/config.json`：

```json
{
  "fetchSeconds":5,
  "draftSeconds":180,
  "idleSeconds":1800,
  "identity":{"user":"alice","machine":"网页/netcup"},
  "workspaceLock":true
}
```

identity 可选，不配置时保留原有系统用户名、主机名及持久副本 UUID 行为。配置后 user 用于草稿/自动提交作者，`user@machine` 用于提交说明和来源；不改 Git main 规则、草稿、校验或推送流程。workspaceLock 是服务器副本显式选项，不改变本地默认路径。Web 启动要求此项为 true。

Web 与同步需使用相同的绝对挂载路径和共享 PID namespace（例如 Web 使用 Compose `pid: service:sync` 加入同步容器），让 PID lease 和 `sync status.running` 有真实含义。独立 namespace 也避免其他服务的 Git 进程因权限不足让本副本保守暂停。共享锁覆盖 Web 的核对版本与原子落盘、同步快进、自动提交；不覆盖不遵守该锁的外部编辑器/Agent。服务器用户副本只由 Web 和配套同步写入；本地 Agent 继续使用各自本地 clone。

Web 默认监听 3000；通过反代提供 HTTPS，只在宿主机 loopback 映射应用端口。读写 JSON 请求最长 30 秒；Git 来源读取最长 15 秒、单次输出上限 64 MiB；工作区写锁最多等 5 秒后返回 503。生产新建/修改/冲突测试必须在临时仓库执行，防止闲置自动提交测试内容。
