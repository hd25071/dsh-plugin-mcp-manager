# dsh-plugin-mcp-manager

> MCP server manager and call inspector for **DeepSeek Harness (DSH)**.
> DeepSeek Harness 的 **MCP 管理器**：把当前 profile 里的每一条 MCP 服务器行集中到一个页面里，看状态、改配置、盯调用。

---

## 为什么需要它

DSH 里"MCP 服务器"并不是一个独立的配置对象，而是 **profile 里的一条插件行**：

```yaml
- id: my-server
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: my
    transport: stdio
    command: 'python'
    args: ['server.py', 'mcp']
```

于是它天然缺三样东西：

| 缺什么 | 现状 |
| --- | --- |
| **集中视图** | 想知道"现在挂了几个 MCP、各自什么状态"，只能逐个组合包翻 patch |
| **参数编辑** | 配置写死在 `cordis.patch.yml` 里，改一次要动文件 + 重启 |
| **调用可见** | 只能靠对话里的通用工具卡片，看不出检索词/耗时/结果规模这类细节 |

本插件把这三件事补上：**一个页面，列出所有 MCP 行，可编辑、可观察**。

## 功能

- **总览**：列出当前 profile 中所有 `@deepseek-ai/dsh-mcp-client` 行 —— 所属组合包、行 id、`serverName`、传输方式（stdio / streamable-http）、命令或 URL、启用状态、工具数量。
- **编辑**：在页面上直接改 `command` / `args` / `env` / `cwd` / `url` / `headers` / 超时 / 重连参数，保存后写回 profile patch 并由 Loader 应用（配置编辑走 DSH 的配置编辑服务，不是本插件自己写文件）。
- **调用记录**：按会话列出 `mcp__<serverName>__*` 工具的调用 —— 工具名、参数摘要、耗时、结果字节数、是否报错。

> 状态：**开发中**。见下方 [Roadmap](#roadmap)。装之前请先读 [兼容性](#兼容性)。

## 安装

DSH 侧边栏 **设置 → 插件 → 添加插件**，填入下列任一种 spec：

```text
# 本地目录（开发时）
link:/absolute/path/to/dsh-plugin-mcp-manager

# GitHub（公开仓库）
https://github.com/hd25071/dsh-plugin-mcp-manager

# npm（若已发布）
dsh-plugin-mcp-manager
```

安装后它会作为一条组合包出现在插件页的**已安装**分组里，卡片上就是管理器界面。

> 手工等价操作（没有 `dsh` CLI 时）：在 profile 目录用 DSH 自带 pnpm `add` 该 spec，再把包名追加到 profile `package.json` 的 `dsh.profile.bundles`。

## 它是怎么挂上去的

```text
package.json
  dsh.bundle.patch  → cordis.patch.yml   插入一行 Host 插件（id: mcp-manager）
  dsh.client        → client.js          浏览器半侧，注册进插件页的配置 slot
```

- **Host 半侧**（`index.js`）：读取当前 profile 的 MCP 行与它们的配置、订阅工具调用事件。
- **浏览器半侧**（`client.js`）：用 `window.__ModuleLoader__.load({ id, factory })` 注册，向插件页的 `plugins.bundle.config` slot 提供本组合包的配置视图。

两半侧都不 import DSH 的客户端组件库，样式只依赖宿主主题变量（`--dsw-alias-*`），因此在 DSH 升级后不容易碎。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | 44.0.0（Electron）/ 运行时 0.2.0-rc.2 |
| peer | `@deepseek-ai/dsh-mcp-client`、`@deepseek-ai/dsh-plugin-manager`、`@deepseek-ai/dsh-config-editor`（均由 DSH 自身提供） |
| 平台 | Web UI（Desktop 与服务器版 DSH 共用同一套客户端） |

DSH 的插件 API 仍在演进。本插件只使用**文档化的 slot 与宿主服务**；遇到 API 变更时会以"页面显示不可用"而不是崩溃的方式降级。

## Roadmap

- [x] 组合包骨架（Host 行 + 浏览器半侧 + 插件页卡片）
- [ ] MCP 行总览（列表 + 状态 + 工具数）
- [ ] 配置编辑（表单 + 保存 + 恢复默认 + 连通性自测）
- [ ] 调用记录（工具名 / 参数摘要 / 耗时 / 结果规模 / 错误）
- [ ] 一键启停单条 MCP 行
- [ ] 导出/导入 MCP 配置片段（便于换机）

## 开发

无构建步骤：直接改 `index.js` / `client.js`，因为是 `link:` 安装，改完**完全退出 DSH（含托盘）再启动**即可生效。

验证要点：

1. 插件页里出现本组合包卡片，且卡片上的管理器界面能渲染；
2. 总览里能看到 profile 中真实存在的 MCP 行；
3. 改一个字段保存后，profile 的 `cordis.patch.yml` 里对应行出现覆盖项；
4. 调用一次 MCP 工具后，调用记录里出现该次调用。

## 许可

MIT
