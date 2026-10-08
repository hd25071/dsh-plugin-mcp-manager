# dsh-plugin-mcp-manager

> MCP server control panel for **DeepSeek Harness (DSH)**.
> DeepSeek Harness 的 **MCP 管理器**：把当前 profile 里的每一条 MCP 服务器行集中到一个页面，看状态、启停、取配置。

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

DSH 44.0.0 没有"MCP 管理器"页面（`dsh-client-ui-*` 的 48 个包里没有任何 MCP 面板）。
本插件补上这个视图。

## 能做什么 / 不能做什么

| | 能力 | 说明 |
| --- | --- | --- |
| ✅ | **总览** | 列出当前 profile 里所有 `@deepseek-ai/dsh-mcp-client` 行：`serverName`、传输方式、连接目标（命令+参数 / URL）、启用状态、所属组合包、行 id |
| ✅ | **启停** | 逐行启用/停用（写 profile patch 的 `disabled` 覆盖，走 DSH 官方的 `pluginManager` 服务） |
| ✅ | **看原始数据** | 展开任意一行，直接看它真实的 entry 对象（不猜字段、不美化） |
| ✅ | **取 patch 片段** | 一键复制该行的 YAML 片段，粘进 profile 的 `cordis.patch.yml` 即可改参数 |
| ❌ | **在 UI 里直接改参数** | 见下节：这是 DSH 44.0.0 的架构边界，不是本插件没做 |
| ⏳ | **调用记录** | 规划中（需要确认会话侧的读取通道） |

## 为什么不能在 UI 里改 MCP 参数（DSH 44.0.0 的架构边界）

三条互相独立的限制，任一条都足以挡住"第三方插件从界面写 MCP 行配置"：

1. **MCP 行的 Config 字段不是 volatile。**
   `@deepseek-ai/dsh-mcp-client` 的 schema 里 `volatile` 出现 **0 次**；
   而 `@deepseek-ai/dsh-settings` 的规则是"表单只展示活动且可唯一定位的 profile 条目中的
   **volatile 字段**；**普通配置仍通过 Cordis 配置文件编辑**"。
   ⇒ 官方设置表单本身就不会把 MCP 参数渲染成可编辑控件。

2. **客户端可用的 Remote 能力集在构建时固定。**
   `@deepseek-ai/dsh-api-remotes` 明确写着"能力集合由构建时显式导入的值固定确定；
   Client 不会在运行时发现 Host 中已启用的服务或 Remote 定义"。
   应用实际挂载给浏览器侧的只有 `pluginManager`、`pluginInventory`、`settings`、
   `credentials`、`pluginRegistryProbe` —— **没有 `configEditor`**（写 profile patch 的宿主服务）。
   ⇒ 第三方插件既不能新增 Remote，也没有现成的写入通道。

3. **配置页 slot 只服务于"自己声明的行"。**
   插件页的 `plugins.row.config` 以 `<包名>#<行 id>` 为键，且要求
   "**组合包的 patch 必须以该 id 声明这一行**"。
   ⇒ 一个第三方组合包无法为别的组合包（例如 `dsh-plugin-kb`）的行注册配置页。

### 三条出路（按推荐顺序）

- **A. 上游改一行**：请 DSH 把 `dsh-mcp-client` 的 Config 字段标为 `volatile()`。
  一旦如此，**官方设置页会自动**为每条 MCP 行渲染出可编辑表单，本插件只需链接过去。
  这是代价最小、收益最大的做法。
- **B. 本插件改成"自己声明 MCP 行"的形态**：让管理器自己 patch 里声明这些行，
  于是 `plugins.row.config` 对它生效，配置页与 `form.mutate()` 就能用了。
  代价：MCP 服务器的声明位置从"各组合包"搬到"管理器"，用户要接受这个约定。
- **C. 宿主半侧提供 agent 工具**：用 `ctx.configEditor` 做写入，暴露成 `mcp_config_set` 之类的工具，
  由模型代劳；界面仍然只读。适合"能改就行、不挑入口"的场景。

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

## 它是怎么挂上去的

```text
package.json
  dsh.bundle.patch  → cordis.patch.yml   插入一行 Host 插件（id: mcp-manager）
  dsh.client        → client.js          浏览器半侧，注册进插件页的 plugins.bundle.config slot
```

- **Host 半侧**（`index.js`）：本插件不需要宿主状态，它是空的 —— 存在的意义是让组合包占一条 Loader 行，
  客户端模块系统据此把浏览器半侧送进页面。
- **浏览器半侧**（`client.js`）：`window.__ModuleLoader__.load({ id, factory })` 注册，
  用 `ctx.remote.pluginManager` 读清单、启停行 —— 与官方插件页**同一套**通道。

不 import 任何 Harness Client 包，样式只依赖宿主主题变量（`--dsw-alias-*`），
因此 DSH 升级时最坏是外观退化，不会把页面弄崩。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | 44.0.0（Electron）/ 运行时 0.2.0-rc.2 |
| 依赖的宿主能力 | `remote.pluginManager`（`listBundles` / `listPlugins` / `setPluginEnabled`） |
| 平台 | Web UI（Desktop 与服务器版 DSH 共用同一套客户端） |

## 状态

**未在运行中的 DSH 里验证过**（v0.1 骨架 + 界面代码已提交，但尚未安装运行）。
已知的不确定点：`listBundles()` / `listPlugins()` 返回对象的**字段名**在不同版本间可能不同，
因此界面按"多字段名兼容 + 原始 JSON 兜底"来写，保证显示真实数据而不是猜。

## 许可

MIT
