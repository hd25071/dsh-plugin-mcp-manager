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
| ⏳ | **调用记录** | 规划中：宿主侧已确认可读（`tool/call` + `tool/result` 会话事件带 `time`，可算耗时），缺的是"在插件页里选哪个会话"这一步的交互设计 |

## 它是怎么工作的

```text
package.json
  dsh.bundle.patch  → cordis.patch.yml   插入一行 Host 插件（id: mcp-manager）
  dsh.client        → client.js          浏览器半侧，注册进插件页的 plugins.bundle.config slot
```

**Host 半侧**注册四个精确的 Fetch 路由，**浏览器半侧**用文档相对路径 `fetch()` 调用：

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `api/mcp-manager/servers` | GET | 清单：id / 模块 / disabled / 继承值 / 覆盖值 / 生效值 |
| `api/mcp-manager/config` | POST | 写入一行配置（`{id, config}`），或 `{id, reset:true}` 恢复默认 |
| `api/mcp-manager/enabled` | POST | 启停一行（`{id, enabled}`） |
| `api/mcp-manager/health` | GET | 诊断：本 profile 挂了哪些服务 |

三条实现约束（都是踩过的）：

1. **绝不 import `@deepseek-ai/...`**。第三方组合包由 Node 从自己的真实路径解析，
   `import '@deepseek-ai/dsh-...'` 会以 `ERR_MODULE_NOT_FOUND` 失败，并让该行进入插件页的 error 状态。
   服务一律用 `ctx.get(key)` 取。
2. **兄弟 fiber 的服务不能用属性访问**。`configEditor` / `pluginManager` 与本插件是兄弟关系，
   直接 `ctx.configEditor` 会抛 `cannot get property ... without inject`；`ctx.get()` 是官方为此提供的读取方式，
   服务不存在时返回 `undefined` 而不是抛错 —— 所以每个路由都能降级成可诊断的 HTTP 状态，而不是把页面弄崩。
3. **配置编辑的 `change` 是函数**：`configEditor.edit(entry, (current, inherited) => next)`。
   当 `next` 与 `inherited` 深相等时，编辑器会**删掉** profile 覆盖项 —— 这正是"恢复默认"的语义。

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

## 状态与验证

**尚未在运行中的 DSH 里验证过。** 已做的检查：两个半侧 `node --check` 通过、清单 JSON 合法、
仓库无任何个人/环境内容。已知不确定点：

- `configEditor.configuration()` 与 `loader` entry 的**字段名**在不同版本间可能不同；
  清单路由对 `name`/`module`/`specifier` 做了兼容读取，读不到就退回 `pluginManager.listBundles()` 的只读清单。
- `plugins.bundle.config` 的 slot 描述符（`key` / `view`）以官方插件页文档为准，但本插件是首个非官方使用者，
  首次安装若卡片不出现，先看浏览器控制台是否有 `slot entry crashed`。

## 许可

MIT
