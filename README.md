# dsh-plugin-mcp-manager

> MCP server manager for **DeepSeek Harness (DSH)**.
> DeepSeek Harness 的 **MCP 管理器**：把当前 profile 里的每一条 MCP 服务器行集中到一个页面，**读配置、改配置、启停**。

---

## 为什么需要它

DSH 里"MCP 服务器"不是一个独立配置对象，而是 **profile 里的一条插件行**：

```yaml
- id: my-server
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: my
    transport: stdio
    command: 'python'
    args: ['server.py', 'mcp']
```

DSH 44.0.0 没有"MCP 管理器"页面（`dsh-client-ui-*` 的 48 个包里没有任何 MCP 面板），
而官方设置页**也不会**给这些行渲染表单 —— 因为 `dsh-mcp-client` 的 Config 字段
没有声明为 `.volatile()`，而设置服务只投影 volatile 字段
（`@deepseek-ai/dsh-settings`："表单只展示活动且可唯一定位的 profile 条目中的 volatile 字段"）。
于是改一个 MCP 参数只能手写 `cordis.patch.yml`。

本插件把这块补上。

## 能做什么

| | 能力 | 说明 |
| --- | --- | --- |
| ✅ | **总览** | 列出 profile 中所有 `@deepseek-ai/dsh-mcp-client` 行：`serverName`、传输方式、连接目标（命令+参数 / URL）、启用状态、行 id |
| ✅ | **读配置** | 每行显示**生效值**（组合包声明的继承值 + 本 profile 的覆盖值），并标出哪些字段被覆盖过（`*`） |
| ✅ | **改配置** | 就地编辑字符串/数字/布尔/JSON 字段，保存后写进 profile 的 `cordis.patch.yml` 并由 DSH 热应用 |
| ✅ | **恢复默认** | 移除该行的 profile 覆盖项，回到组合包声明的值（不是填一份副本） |
| ✅ | **启停** | 逐行启用/停用（写 `disabled` 覆盖） |
| ✅ | **调用记录** | **右侧停靠栏里的独立页**：按会话列出每次 `mcp__*` 调用 —— 工具名、所属服务器、参数摘要、**耗时**、结果规模、成功/失败，点开看完整记录 |
| ✅ | **MCP 市场** | 从**官方 MCP 注册表**（`registry.modelcontextprotocol.io`）拉全量快照到本地，**本地搜索/筛选/排序**；点「安装」即生成组合包并调官方安装接口落地成一行 MCP |
| ✅ | **安装即配置** | 按 registry 的 `environmentVariables`（`isRequired`/`isSecret`/默认值）自动生成表单；安装前**明文展示将执行的命令或 URL**、要哪些密钥、来源与风险 |
| ✅ | **安装后自检** | 已装列表显示该行的**实时状态**（运行中/启动失败+错误原文），并在能读到工具清单时显示「✓ N 个工具」 |
| ✅ | **卸载 / 更新** | 卸载先走官方 `removeBundle` 再删生成目录；同一条目重复安装走**覆盖更新**，并对比 registry 版本提示「有新版」 |

## 它是怎么工作的

```text
package.json
  dsh.bundle.patch  → cordis.patch.yml   插入一行 Host 插件（id: mcp-manager）
  dsh.client        → client.js          浏览器半侧，注册进插件页的 plugins.bundle.config slot
```

**Host 半侧**注册十三个精确的 Fetch 路由，**浏览器半侧**用文档相对路径 `fetch()` 调用：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `api/mcp-manager/servers` | GET | 清单：id / 模块 / disabled / 继承值 / 覆盖值 / 生效值 |
| `api/mcp-manager/config` | POST | 写入一行配置（`{id, config}`），或 `{id, reset:true}` 恢复默认 |
| `api/mcp-manager/enabled` | POST | 启停一行（`{id, enabled}`） |
| `api/mcp-manager/sessions` | GET | 会话列表（`listSessions()`，最新在前，带 live/persisted） |
| `api/mcp-manager/calls` | GET | 某个会话的 MCP 调用记录（`?sessionId=&limit=`，缺省取最新会话） |
| `api/mcp-manager/market` | GET | 目录状态：条数、更新时间、是否过期、**刷新进度**、本机运行时（npx/uvx/docker）、缓存路径 |
| `api/mcp-manager/market/refresh` | POST | 启动一次全量拉取（后台跑，立即返回；前端轮询上面的状态） |
| `api/mcp-manager/market/search` | GET | **本地**搜索 + 分页：`?q=&kind=all\|local\|remote&sort=relevance\|newest\|name&limit=&offset=`；**每张卡片自带状态**（能否安装/是否需要密钥/是否已装/是否有新版），网格只需一次请求 |
| `api/mcp-manager/market/detail` | GET | 一个条目的全部安装方式（`?name=`）+ 需要填的变量与命令参数 + 风险说明 |
| `api/mcp-manager/market/install` | POST | 安装：`{name, optionIndex, config, arguments}` → 写组合包 → `pluginManager.installBundle()` |
| `api/mcp-manager/market/uninstall` | POST | 卸载：`{slug}` → `removeBundle()` → 删生成目录 |
| `api/mcp-manager/market/installed` | GET | 已装列表：manifest + 行实时状态 + 工具数 + 是否有新版 |
| `api/mcp-manager/health` | GET | 诊断：本 profile 挂了哪些服务 |

### 三个界面分别挂在哪

| 界面 | 位置 | 注册方式 |
| --- | --- | --- |
| **MCP 市场** | **左侧导航的一级入口**（排在「插件」下面） | `ctx.slots.register({name:'sidebar.panellist', id:'mcp-market', order:5, label}, Icon)` + 同 id 的 `{name:'main', key:'mcp-market'}` 正文 |
| MCP 行管理 + 配置编辑 | 插件页里本组合包自己的页面 | `plugins.bundle.config`（key = 包名，`view: 'page'`） |
| 调用记录 | 右侧停靠栏的独立页 | `sidebarRightTabs.register(...)` + `sidebar.right.pane.tab` |

**为什么市场不放在管理器的页签里**：管理器面向"已经装好、要改字段"的人（逐字段表单、密度高），市场面向"还没装、在逛"的人
（卡片流、一键装、密度低）。两者的心智模型相反，挤在一个页签容器里，市场永远像一张配置表。
现在安装配置表单只在**点「安装」之后**出现——那才是它该出现的地方。

左侧导航是**公开席位**，不是宿主写死的：官方「插件」入口自己就是用 `sidebar.panellist` 注册的
（`dsh-client-ui-plugin-manager/lib/client.js:3769`，`order: 0`），本 profile 里第三方插件也在用
（技能中心 `skill-explorer`、记忆系统 `mnemon`，都是 `order: 30`）。**本插件占用 `order: 5`**——
后来者请避开这个号。

### 市场页骨架的样式契约

视觉规范要能"只换一层"，骨架阶段就必须守住三条（都有用例把守）：

1. **样式只挂语义 class，组件里没有任何内联 style**：`mcpm-page` / `mcpm-toolbar` / `mcpm-grid` / `mcpm-card` /
   `mcpm-card__{icon,name,desc,badges,actions}` / `mcpm-badge` / `mcpm-btn(--primary)` / `mcpm-pager` / `mcpm-dialog`…
   整张表是 `client.js` 里**一个 `MARKET_CSS` 常量**，注入为一个 `<style id="mcpm-styles">`；换规范 = 换这一块。
   用例会遍历市场页的渲染树，断言**零个 `style` prop**。
2. **按钮状态走 `data-state`，不靠 class 堆叠**：`idle` / `needs-config` / `installed` / `update` / `unavailable`（另有 `busy`），
   样式侧用 `[data-state="…"]` 选择器映射颜色。用例断言状态枚举与语义 class 齐备。
3. **卡片层级靠结构，不靠样式**：图标 → 名称 → 描述 → 徽章 → 动作，五块顺序与包含关系固定；
   规范只改它们怎么排（网格/字号/截断），不改 JSX。

**分页而不是虚拟滚动**：约 1.4 万条卡片全量渲染必卡，而市场带排序/筛选，虚拟滚动与之联动最容易出 bug。
每页 60，`limit`/`offset` 走宿主路由，页码与总数显示在页脚。

### 视觉层用的都是宿主 token（不是自编色板）

先 grep 过 DSH 的 token 表，这些**确实存在**，所以颜色第一优先级全部走宿主变量，自编色值只作为 `var()` 兜底：

| 用途 | token |
| --- | --- |
| 主按钮（安装）底色 / 字色 | `--dsw-alias-button-primary-fill`（兜底 `--dsw-alias-brand-primary`）/ `--dsw-alias-label-primary-foreground` |
| 成功（已安装） | `--dsw-alias-state-success-primary` |
| 警告（运行时缺失） | `--dsw-alias-state-warn-primary` |
| 危险（不可用/错误） | `--dsw-alias-state-error-primary` |
| 边框（**0.5px 发丝**，与官方 UI 一致） | `--dsw-alias-border-l1` / `--dsw-alias-border-l2` |
| 次级文字 | `--dsw-alias-label-secondary` |
| 圆角 | `--dsw-radius-md` |

**字母头像**：上万张卡片若都是同一个图标就毫无区分度，而远程图标 URL 是不可信内容、绝不自动加载。
折中是"名称首字母 + 名称哈希选 12 个预设色相"（`.mcpm-avatar--h0`…`h11`，各用 `color-mix` 出 14% 背景），
**色相以 class 形式出现，markup 里仍然零内联 style**。

### 刷新策略：增量为主，全量为次

「刷新目录」默认**增量**：带 `updated_since=<上次成功拉取时间 − 10 分钟>` 只拉变更再**合并**进快照，
几秒钟出结果；「全量重拉」是次级按钮，点了先确认「重新拉取全部 N 条，约需 2 分钟」才动手。

`updated_since` **是实测确认被支持的**，判据不是状态码（未知参数也会回 200）：加 `updated_since=今天`
后首条变成今天发布的条目，加 `10-01` 首条变 10-02，加 `2020` 回到最早——说明它真按更新时间过滤，
且结果按更新时间升序。10 分钟余量是因为拉取途中被更新的条目可能落在已读过的页后面。

增量与全量的**失败语义相反**：全量拉回不足 `MIN_SNAPSHOT_ENTRIES`（1000）视为故障、保留旧快照；
增量拉回 0 条是**正常答案**（没有变更），同样不动快照。合并只增不减——已知道的条目一条都不会丢。

### 已安装条目 → 跳回管理视图

插件页把导航**发布成了服务**（`dsh-client-ui-plugin-manager/lib/client.js:3758`）：

```js
ctx.reflect.provide("pluginNavigation", {
  openBundle: (packageName) => { ctx.layout.selectPanel(PANEL_ID); instance.actions.setView({ kind: "package", name: packageName }); },
});
```

反射发布的值就是普通服务（`loader` 也是这么发布的，`cordis-plugin-loader:603`，全项目都用 `ctx.get`/`inject` 读），
所以本插件用 `ctx.get('pluginNavigation')` 拿它、点已安装卡片时调 `openBundle('@dsh-mcp-market/<slug>')`：
**切到「插件」面板并打开该组合包页**。取不到时降级成一行文字提示，不碰宿主内部 API。

### 自建条目（local entries）

市场"逛"的是官方注册表，但有些东西**只在这台机器上**：自己写的 MCP 服务、指向内网端点的转发。
`~/.dsh/mcp-market/local-entries.json` 就是给这些用的——它不伪装成注册表包，直接写清楚怎么装：

```json
{
  "cacheVersion": 1,
  "entries": [
    {
      "name": "local.example/demo",
      "title": "示例服务",
      "description": "本地示例服务（server.py mcp）",
      "install": {
        "kind": "stdio",
        "command": "C:\\Windows\\py.exe",
        "args": ["D:\\tools\\demo\\server.py", "mcp"],
        "env": [
          { "name": "PYTHONUTF8", "value": "1" },
          { "name": "DEMO_API_KEY", "description": "示例 API Key", "isRequired": true, "isSecret": true }
        ]
      }
    },
    { "name": "local.example/hub", "install": { "kind": "http", "url": "http://127.0.0.1:8080/mcp" } }
  ]
}
```

**文件怎么生效**：按 `mtime + 文件大小` 做缓存，**改完存盘、重开市场页就生效，不用重启 DSH**。

**字段规则**

| 字段 | 规则 |
| --- | --- |
| `name` | 必填，文件内唯一。与注册表同名时**自建赢**，卡片与确认框都会明示覆盖 |
| `install.kind` | `stdio` 或 `http`；`sse` 等按二期拒绝 |
| `command` | 必填且**必须是绝对路径**（`sh`/`cmd`/`python` 这种裸命令名直接拒绝） |
| `args` | 字符串数组。含 shell 元字符**只警告不拒绝**（合法参数也可能带 `&`），警告会把原文显示在安装确认框里 |
| `env` / `headers` | `{name, value?, description?, isRequired?, isSecret?}`。有 `value` 就不问、直接写；无 `value` + `isRequired` 表单必填；`isSecret` 打码 |
| `version` | 可选。自建条目**不参与版本比较**，不会出现「更新 ↑」或「目录版本 vX（不同）」 |

**⚠️ 明文警告**：`value` + `isSecret` 是允许的（例如 `"value": "sk-…"`），但那个值会**以明文写进 profile 的 `cordis.patch.yml`**——
和注册表条目的密钥现状一样。安装确认框里会明确写出这句话。想让密钥不进 profile，等二期的凭据域。

**校验失败长什么样**：错误带条目序号和字段名，例如 `第 2 条缺 command`、`第 3 条：command 必须是绝对路径（收到 "sh"）`；
坏条目被跳过，好条目照常加载（不会因为一条写错就整份失效）。

**卸载**：与注册表条目**走完全相同的路径**（`removeBundle` → 删生成目录 → 清 manifest），没有简化分支。

### 市场是怎么落地的（设计要点）

```text
官方 registry ──全量拉取(~140 页 / ~1.4 万条 / ~100 秒, 后台跑)──▶ ~/.dsh/mcp-market/market-cache.json
                                                                        │  本地搜索，永不联网
                    点「安装」                                          ▼
   ~/.dsh/mcp-servers/<slug>/{package.json, cordis.patch.yml, market.meta.json}
                                    │
                                    ▼  pluginManager.installBundle(<绝对路径>)
                        profile 多一条依赖 + 组合包 → 一条 dsh-mcp-client 行
```

- **快照而非边搜边请求**：registry 全量约 1.4 万个唯一 server（2026-10-10 快照），一次拉完落一个 JSON（实测 6.4 MiB），
  搜索/筛选/排序全在本地做（**实测 3–25 ms** —— 1.4 万条快照上，7 组关键词 × 3 种排序各跑 12 次取中位数；最慢的是空查询按相关度/名称全量排序，约 25 ms），天然离线可用，也不受 registry 限流影响。
  TTL 24h + 手动「刷新目录」；刷新失败保留旧快照并标注「离线数据，更新于 xx」。
- **只保留 `isLatest` 且 `status === 'active'`**：registry 每个版本一条记录，不过滤会出现大量重复行。
- **安装走官方接口**：生成的组合包是**真包**（`dsh.bundle.patch` 指向它的 patch），
  所以用 `pluginManager.installBundle(绝对路径)` 完成 profile 变更 —— 依赖、组合包选择、软链都由 DSH 自己写，
  而不是本插件绕过管理器去改 profile 配置。卸载同理先 `removeBundle` 再删目录（顺序反了会留下指向空目录的依赖）。
- **`market.meta.json` 是关键件**：已装列表、版本对比、卸载清理都读它，不靠扫目录猜。

### registry 条目 → MCP 行的映射

| registry 字段 | 生成 |
| --- | --- |
| `packages[].registryType === 'npm'` | stdio 行：`<node.exe> <npm>/bin/npx-cli.js …` |
| `packages[].registryType === 'pypi'` | stdio 行：`uvx …`（本机没装 uv 时标记为不可用并说明原因） |
| `packages[].registryType === 'oci'` | 标记「容器方式二期支持」 |
| 只有 `remotes[]` | http 行：`transport: streamable-http` + `url`（**`sse` 明确标记「暂不支持」，绝不生成注定连不上的行**） |
| `packages[].runtimeArguments[]` | **跑运行器自己的参数**（`npx -y`、`npx --package`），排在包名之前；registry 已给 `-y` 时不重复添加 |
| `packages[].packageArguments[]`（`positional` / 带值的 `named`） | 追加在包名之后 |
| `packages[].packageArguments[]`（**不带值的 `named`**，如 `--out <dir>`） | **命令参数表单**：安装框里多一个字段，填了才拼进 argv；`isRequired` 的留空则拒绝安装（不是静默丢掉） |
| `packages[].registryBaseUrl` | npm 加 `--registry=<url>`、uv 加 `--index-url <url>`（私有 registry 条目） |
| `packages[].runtimeHint` | 仅作展示提示，实际运行器仍按 `registryType` + 本机能力决定 |
| `packages[].environmentVariables[]` | 安装表单的 schema（`name`/`description`/`isRequired`/`isSecret`/默认值），填完写进行 `env` |
| `remotes[].headers[]` | http 行的 `headers`（同上） |

**为什么 npm 包不用 `command: npx`**：MCP SDK 的 `StdioClientTransport` 用 **`shell: false`** 起进程，
而 Windows 上 `npx` 是 `.cmd` 垫片 —— 无 shell 直接执行 `.cmd` 会被 Node 拒绝，所以一律用
`node.exe + npm/bin/npx-cli.js`。实测 `npx --version` → 11.19.0。

### 生成的命令是**本机解析**的，这是设计而非缺陷

装一个 npm 条目后，生成的 `cordis.patch.yml` 里是一条**绝对路径**，例如（本机实测）：

```yaml
command: "C:\\Program Files\\nodejs\\node.exe"
args:
  - "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"
  - "-y"
  - "pretrip-mcp"
```

- **不是** `process.execPath`：DSH 里那是 `electron.exe`，spawn 它（不带 `ELECTRON_RUN_AS_NODE=1`）会**弹出新窗口而不是跑脚本**。
  探测时按文件名排除 `electron*`，并且**只接受自带 npm 的 Node**——DSH 自带运行时只有 `node.exe`（没有 npm），
  拿它拼 npx 命令装完必挂，所以宁可不选。
- **不依赖 PATH**：命令是绝对路径；`scrubbedParentEnv()` 本来就保留 `PATH`，所以只有当挑中的 Node 不在继承来的 PATH 里时，
  才把**那一个目录**写进 `env.PATH`（早期版本把整条父 PATH 写进配置，会把一台机器的目录布局烙进 profile，已改）。
- **本机没有 Node 时**：不生成行，而是明确回「需要带 npm 的 Node.js：没有找到 Node.js / 只找到 …（不带 npm）」。
- **代价**：这条行是**给装它的那台机器**的；把 profile 原样拷到另一台机器，路径可能失效（那台机器重装一次即可）。

三条实现约束（都是踩过的）：

1. **绝不 import `@deepseek-ai/...`**。第三方组合包由 Node 从自己的真实路径解析，
   `import '@deepseek-ai/dsh-...'` 会以 `ERR_MODULE_NOT_FOUND` 失败，并让该行进入插件页的 error 状态。
   服务一律用 `ctx.get(key)` 取。
2. **兄弟 fiber 的服务不能用属性访问**。`configEditor` / `pluginManager` 与本插件是兄弟关系，
   直接 `ctx.configEditor` 会抛 `cannot get property ... without inject`；`ctx.get()` 是官方为此提供的读取方式，
   服务不存在时返回 `undefined` 而不是抛错 —— 所以每个路由都能降级成可诊断的 HTTP 状态，而不是把页面弄崩。
3. **配置编辑的 `change` 是函数**：`configEditor.edit(entry, (current, inherited) => next)`。
   当 `next` 与 `inherited` 深相等时，编辑器会**删掉** profile 覆盖项 —— 这正是"恢复默认"的语义。
4. **POST 路由的响应体不许 cancel**。`requestBody` 只管请求；把非 GET 的响应 `body.cancel()` 掉看着"干净"，
   实际会把 JSON 吞掉，前端只看到 `HTTP 200` 却解析不出内容（保存配置曾因此一直报错）。

### 已核对的实现事实（DSH 44.0.0）

写这个插件时逐条核对过的平台事实，附出处（包 / 文件 / 行号），省得下一个人再挖一遍：

| 事实 | 出处 |
| --- | --- |
| `dsh.client` 的权威校验：`platform` 必填字符串，`inject`/`external` 必须字符串数组，`immediately` 必须布尔，**未知键被静默丢弃** | `dsh-client-modules/lib/client.js:61-75` |
| client.js 的 `id` **必须等于包名**；写错的症状是 `loaded without registering "<行id>"`，而且**注册时不报错、到到达阶段才失败** | 同上 `:569-576`、`:625`、`:739` |
| 客户端半侧**不需要**在 patch 里单独加 row：它挂在"说明符等于包名"的那一行上（所以行 id 可以≠包名） | 官方第三方样板 `cordis.patch.yml` 的注释 |
| `factory(require)` 只能拿到种子表（`react` / `react-dom` / `react/jsx-runtime` / `cordis` / `ui-slots` / `ui-primitives`）或已注册的 factory | 同上 |
| `configEditor` 只有 `documentPath`(getter) / `entries()` / `configuration()` / `edit(entry, change)`，**没有 read/get** | `dsh-config-editor/lib/index.js:24-135` |
| `edit` 的 `change` 是函数 `(current, inherited) => next`；`next` 与 `inherited` 深相等时编辑器**删除**覆盖项 | 同上 `:69-110` |
| `plugins.row.config` 的 key 是 `<组合包名>#<行id>`，且**可以为别的组合包的行注册**（账本只比对 key 集合）——所以能给原本没有配置页的 MCP 行"凭空造出行页" | `dsh-client-ui-plugin-manager/lib/client.js:48`、`:3356-3357` |
| `form.mutate(ops, expectedRevision)` 返回 `Promise<boolean>`；ops 词表是 `[{op:'set',path,value},{op:'unset',path}]`（**不是** `plugin-manager/lib/types/operations.js` 里那套 pnpm 操作） | `dsh-client-ui-settings/lib/client.js:1177-1194` |
| MCP 行的判据是 `listBundles().rows[].moduleName === '@deepseek-ai/dsh-mcp-client'`，元素形如 `{rowId, moduleName, entryId?, meta?}`；启停用 `setPluginEnabled(entryId, enabled)` | `dsh-plugin-manager` 的清单类型 |
| 工具事件载荷里**没有耗时**；要耗时得用持久会话事件的 `time`：`result.time − call.time` | `dsh-session-stats/lib/types/projection.js:123-135` |
| 配对的权威写法：`tool/call` 用 `data.callId` 开启一次调用；`tool/result` 的调用 id 在 **`data.message.source.callId`**（嵌套），`turn/end` 丢弃没有结果的遗留调用 | 同上 |
| `sessionQuery` 有 `listSessions()`（轻量、不重放日志）与 `readSession(id)`（重放整份日志）；事件形如 `{type, data, time}`，`tool/call` 的名字在 `data.name` | `dsh-session-query/README.zh.md` |
| 右侧停靠栏的 tab 类型是**两阶段注册**：先 `ctx.sidebarRightTabs.register({id, kind, ...})` 声明类型，再 `ctx.slots.register({name:'sidebar.right.pane.tab', key: <type id>}, Body)`；`id` 在全部注册中必须唯一 | `dsh-client-ui-sidebar-right/README.zh.md` §扩展席位 |
| 会话投影的 schema **必须是 Zod**（schemastery 无 `.parse()`，纯 JSON Schema 也不行）；`link:` 安装的包解析不到 `zod`，需自己 vendor 到插件目录的 `node_modules` | 本机另一插件的 vendor 先例 |
| `dsh-mcp-client` 的 Config 是**判别联合**：`transport: 'stdio'`（`command` 必填 / `args` / `env` / `cwd`）或 `transport: 'streamable-http'`（`url` 必填 / `headers`）；`serverName` 必须匹配 `^[A-Za-z0-9_-]{1,32}$` 且**全局唯一**（重复会抛） | `dsh-mcp-client/lib/index.js:780-800`、`:818` |
| MCP SDK 的 `StdioClientTransport` 用 **`shell: false`** 起进程 —— 所以 Windows 上 `command` 不能是 `.cmd` 垫片（`npx`），要用 `node.exe + npm/bin/npx-cli.js` | `@modelcontextprotocol/client/dist/stdio.mjs:68-79` |
| stdio 子进程的环境是 `scrubbedParentEnv()`：**保留 `PATH`/`HOME`/locale/代理**，只去掉凭据形状的名字与全部 `DSH_*` | `dsh-subprocess/lib/index.js:33-56` |
| `installBundle(spec, options)` 接受**本地绝对路径**；`options = {activateNewBundles(默认 true), requestId, approvedBuilds, registry}`；`removeBundle(name)` 对称 | `dsh-plugin-manager/lib/index.js:1691`、`:1844`、`lib/typert.host.js:796` |
| 官方 registry 的真实字段：`{servers:[{server, _meta}], metadata:{nextCursor}}`；server 里是 `packages[].{registryType, identifier, packageArguments, environmentVariables[{name, description, isRequired, isSecret}]}` 与 `remotes[].{type, url}`；**`status`/`publishedAt`/`isLatest` 在 `_meta["io.modelcontextprotocol.registry/official"]` 里** | `registry.modelcontextprotocol.io/v0/servers` 实测 |
| `ConnectionRequestBodyMode = 'buffered' \| 'streaming'` **只约束请求体**；响应体没有任何"必须抽干"的要求 | `dsh-tool-cordis/lib/types/api-catalog.js:4752` |
| 客户端入口激活失败会**中止整个 web boot**（`web boot: N entry did not activate`），并连带让别的插件的「为当前 Web 部署授权设置 RPC」跑不完 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-web-boot.log` 实测 |

## 安装

DSH 侧边栏 **设置 → 插件 → 添加插件**，填：

```text
# 本地目录（开发时）
link:/absolute/path/to/dsh-plugin-mcp-manager

# GitHub
https://github.com/hd25071/dsh-plugin-mcp-manager
```

安装后它作为一条组合包出现在插件页的**已安装**分组，卡片上就是管理器界面。

> 带 JS 的插件是"选择加入"的模块根：**必须完全退出 DSH（含托盘）再启动**才生效。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | 44.0.0（Electron）/ 运行时 0.2.0-rc.2 |
| 依赖的宿主服务 | `connection`（路由）、`configEditor`（读/写配置）、`pluginManager`（启停） |
| 平台 | Web UI（Desktop 与服务器版 DSH 共用同一套客户端） |
| 无构建步骤 | 纯 JS，改完重启 DSH 即生效 |

## Roadmap

- [x] 组合包骨架（Host 行 + 浏览器半侧 + 插件页卡片）
- [x] MCP 行总览（清单 + 生效值 + 覆盖标记）
- [x] 配置编辑（保存 / 恢复默认）+ 启停
- [x] 诊断路由（本 profile 挂了哪些服务）
- [x] 调用记录（右侧停靠栏独立页，按会话，含耗时与结果规模）
- [x] **MCP 市场**（官方注册表快照 + 本地搜索 + 一键安装 + 安装即配置 + 自检 + 卸载/更新）
- [x] **已装卡片显示真实的连接/工具状态**：实测某个"无需配置"的条目，端点在 `initialize` 就回 **401**，而注册表条目声明"不需要任何配置"；DSH 的 `syncTools` 里 `listTools()` 抛错后**只写日志、注册 0 个工具**（`dsh-mcp-client/lib/index.js:127-159`），界面却仍显示「运行中」⇒ **"装了但用不了"是静默失败**。现在卡片读 `tools.schemas()`，给不出清单就显示 `⚠ 0 个工具`
- [ ] **安装前加一层端点探测**（`initialize` 是否 401、是否声明 tools 能力），把这类条目在装之前就标成「需要鉴权（注册表未声明）」。实测抽查 14 个"无需配置"条目，**4 个是 401**
- [x] **二期已完成**：自建条目（local entries）、`mcpb` 包（下载 → 校验 → 解压 → 按包内 manifest 起进程，含"必填配置随拒绝一起返回"的两段式安装）、uv 运行时、卸载残留链接清理、本地条目优先排序、以及目录里"无安装方式"条目的成因审计（结论见 [已知限制](#已知限制)）
- [ ] **冻结项**（都要 DSH 或上游 SDK 先动，见下）：`sse` 远程传输、密钥改走 DSH 凭据域（不再明文落在 patch 里）
- [ ] **未支持的包类型**：`oci`（三期随第三方目录一起做）、`nuget`、`cargo`
- [ ] **三期**：第三方目录合并（**先普查源、再定实现范围**）、本地「收藏 + 备注」（单机插件没有共享后端，不做社交化评分）、自研条目上架表单、把 `~/.dsh/mcp-servers` 加进 `hmr.root` 让生成的组合包也能热应用
- [ ] **每条 MCP 行自己的配置页**：注册 `plugins.row.config`（key = `<bundle>#<rowId>`），
      让配置控件出现在该行自己的页面上，而不是只在本组合包的卡片里 —— 需要先在一个跑着的 DSH 上验证动态 key 集的注册时机
- [ ] 调用记录的**跨会话汇总**（当前一次只看一个会话）

## 状态与验证

**已在真实 DSH 里跑起来**（2026-10-09）：插件作为组合包装进 profile，web boot 干净、卡片显示「运行中」。
自动化检查：`npm test` **98 个用例全过**（客户端激活契约 7 + 深渲染冒烟 17 + 自建条目 22 + 市场核心 15 +
市场路由 15 + mcpb 单元 16 + mcpb 路由 4 + 源码卫生 2），
两个半侧 `node --check` 通过，仓库无任何个人/环境内容。测试逼出来的真 bug 已有四个：
`metaOf` 引用了不存在的常量（刷新目录必崩）、**POST 响应体被 cancel 掉**（保存配置只报 `HTTP 200`）、
`Panel` 里 `note` 状态漏声明（管理器卡片一渲染就抛错）、生成的行把整条父 `PATH` 写进配置。
一轮代码审查后又补了这些（每条都有对应用例）：

| 审查项 | 处理 |
| --- | --- |
| 命令路径从哪来 | 排除 `electron*`；只接受自带 npm 的 Node；无 Node 时明确拒绝而不是生成坏行；用例断言命令是绝对路径的 node 可执行文件 |
| 参数映射不全 | 补 `runtimeArguments`（含去重 `-y`）、`named` 参数槽位（必填留空即拒绝）、`registryBaseUrl`、`runtimeHint` |
| SSE-only 条目 | 明确标记「暂不支持 sse 远程传输（二期）」，`options` 为空、安装返回 409，**不生成行** |
| 缓存非原子/坏数据 | 临时文件 + rename；**条目数 < 1000 视为失败拉取**，保留旧快照并报错；缓存带 `cacheVersion`，格式不符即忽略 |
| 覆盖更新丢配置 | 重装时从当前行读回 `env`/`headers` 合并，只覆盖用户新填的；已配置项在表单里标注「留空则保留原值」 |
| 不可信文本渲染 | 全部走 React 文本子节点；用例扫描 `innerHTML`/`dangerouslySetInnerHTML`/`new Image(`/`iconUrl` 等一律不得出现 |
| 行名冲突 | 行 id 为 `mcp-<slug>`（slug 带名字哈希），`serverName` 在安装时对本 profile 已有名字去重 |
| 版本对比语义 | 只做「不等 → 提示」，不做新旧判断；UI 文案为「目录版本 vX（不同）」 |
| 缓存位置 | 快照移到 `~/.dsh/mcp-market/`，**不在** `~/.dsh/mcp-servers/`（后者是未来 `hmr.root` 的候选，几 MiB 的缓存重写会触发 HMR） |

已知不确定点：

- **工具数**依赖 `ctx.get('tools')` 上是否存在可读的工具集合；`dsh-tools` 只公开 `register/restrict/guard`，
  没有列表接口，所以本插件用防御式探测，读不到就显示「工具数未知」而不是编一个数。
- `configEditor.configuration()` 与 `loader` entry 的**字段名**在不同版本间可能不同；
  清单路由对 `name`/`module`/`specifier` 做了兼容读取，读不到就退回 `pluginManager.listBundles()` 的只读清单。
- `listSessions()` 返回对象的字段名（`id` / `title` / `live` / `persisted`）按文档推断并对常见别名做了兜底；
  若会话下拉为空，看 `/api/mcp-manager/sessions` 的原始返回。
- `plugins.bundle.config` 的 slot 描述符（`key` / `view`）以官方插件页文档为准，但本插件是首个非官方使用者，
  首次安装若卡片不出现，先看浏览器控制台是否有 `slot entry crashed`。
- 右侧停靠栏的两阶段注册（`sidebarRightTabs.register` + `sidebar.right.pane.tab`）按官方 README 实现；
  若 tab 打不开，先看 `ctx.sidebarRight` 是否存在（插件页上的按钮会提示）。
- **重新安装同一条目**会重写生成的 patch；生成的组合包不在 `hmr.root` 里，所以改动通常要等下次加载才生效
  （三期会把它加进 `hmr.root`）。

## 已知限制

- **约 85 条（占目录 0.6%，2026-10-10 快照）因上游数据缺失无法安装。** 这些条目在 registry 里声明了
  `packages: []` **且** `remotes: []`，也就是"没有任何安装方式"。**这不是本插件的判据太严，而是上游数据问题**——
  点「安装」得到的那句拒绝，陈述的就是这个事实。

  判定方法（只读、可复跑）：

  1. 取本机快照里所有"无可用安装方式"的条目（`~/.dsh/mcp-market/market-cache.json`）；
  2. 逐条读注册表上**该服务器的全部版本**（不是只有最新版）：
     `GET https://registry.modelcontextprotocol.io/v0/servers/{urlencode(name)}/versions`；
  3. 比对每个版本的 `_meta["io.modelcontextprotocol.registry/official"].{status, isLatest}`
     与 `server.packages` / `server.remotes`。

  当日 88 条的分布：**85 条**的**每一个版本**（含 `isLatest: true` 且 `status: active`）两者都是 `[]`，
  属永久性上游缺失；**1 条**是本机快照过期（注册表当天已补上，刷新目录即消失）；**2 条**是发布方在最新版里
  删掉了安装声明（更早的版本曾声明过）。

  > 这个数字**随快照变动**（24 小时内已有 1 条自愈），请按"类别"理解而不是记固定条数。

## 许可

MIT
