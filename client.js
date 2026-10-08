/**
 * Browser half of dsh-plugin-mcp-manager.
 *
 * Renders the manager on this bundle's own page in the DSH Plugins page.
 *
 * Everything it needs already exists in the page: the app mounts the `pluginManager`
 * Remote capability for its own Plugins page, and a third-party client module reaches
 * it through the same `ctx.remote.<name>` convention. No build step, no import of any
 * Harness Client package, and styling through host theme variables only, so a DSH
 * upgrade degrades the look rather than breaking the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BUNDLE = 'dsh-plugin-mcp-manager';
    const MCP_MODULE = '@deepseek-ai/dsh-mcp-client';

    // ---------------------------------------------------------------- helpers

    /** Text of the module specifier a row or entry resolves to, if the shape exposes one. */
    function moduleOf(entry) {
      if (!entry || typeof entry !== 'object') return '';
      for (const key of ['module', 'name', 'plugin', 'specifier', 'package']) {
        const value = entry[key];
        if (typeof value === 'string' && value.length > 0) return value;
      }
      return '';
    }

    /** Stable identifier the plugin manager accepts for enable/disable. */
    function idOf(entry) {
      if (!entry || typeof entry !== 'object') return '';
      for (const key of ['id', 'entryId', 'rowId', 'entry']) {
        const value = entry[key];
        if (typeof value === 'string' && value.length > 0) return value;
      }
      return '';
    }

    function isMcp(entry) {
      return moduleOf(entry) === MCP_MODULE;
    }

    /** One-line description of where an MCP server connects to. */
    function targetOf(config) {
      if (!config || typeof config !== 'object') return '';
      if (typeof config.url === 'string' && config.url.length > 0) return config.url;
      const command = typeof config.command === 'string' ? config.command : '';
      const args = Array.isArray(config.args) ? config.args.join(' ') : '';
      return (command + ' ' + args).trim();
    }

    function serverNameOf(config, fallback) {
      if (config && typeof config.serverName === 'string' && config.serverName.length > 0) {
        return config.serverName;
      }
      return fallback;
    }

    /**
     * Collect MCP rows from the two listings the plugin manager answers.
     *
     * The listings are merged rather than assumed: a row may arrive attached to its
     * bundle, from the flat plugin listing, or from both, and the shapes differ
     * between DSH versions. Anything unrecognised is still shown, so the page tells
     * the truth about the profile even when a field is renamed.
     */
    function collect(bundles, plugins) {
      const found = new Map();
      const add = (entry, bundle) => {
        const id = idOf(entry) || (bundle ? bundle + '#' + moduleOf(entry) : '');
        if (found.has(id)) return;
        found.set(id, { id, entry, bundle: bundle || '' });
      };
      const bundleList = Array.isArray(bundles) ? bundles : [];
      for (const bundle of bundleList) {
        const name = (bundle && (bundle.name || bundle.package || bundle.pkg)) || '';
        const rows = (bundle && (bundle.rows || bundle.plugins || bundle.entries)) || [];
        for (const row of Array.isArray(rows) ? rows : []) if (isMcp(row)) add(row, name);
      }
      const pluginList = Array.isArray(plugins) ? plugins : [];
      for (const entry of pluginList) if (isMcp(entry)) add(entry, '');
      return Array.from(found.values());
    }

    /** YAML a user can paste into the profile patch to reproduce this row. */
    function patchSnippet(row) {
      const config = configOf(row.entry);
      const lines = [];
      lines.push('- id: ' + (idOf(row.entry) || 'my-mcp'));
      lines.push("  name: '" + MCP_MODULE + "'");
      lines.push('  config:');
      const keys = config && typeof config === 'object' ? Object.keys(config) : [];
      if (keys.length === 0) {
        lines.push('    serverName: my');
        lines.push("    transport: 'stdio'");
        lines.push("    command: 'python'");
        lines.push("    args: ['server.py', 'mcp']");
      } else {
        for (const key of keys) {
          const value = config[key];
          if (value === undefined) continue;
          lines.push('    ' + key + ': ' + JSON.stringify(value));
        }
      }
      return lines.join('\n');
    }

    function configOf(entry) {
      if (!entry || typeof entry !== 'object') return null;
      const direct = entry.config;
      if (direct && typeof direct === 'object') return direct;
      const nested = entry.entry && entry.entry.config;
      if (nested && typeof nested === 'object') return nested;
      return null;
    }

    function enabledOf(entry) {
      if (!entry || typeof entry !== 'object') return null;
      for (const key of ['enabled', 'active', 'selected']) {
        if (typeof entry[key] === 'boolean') return entry[key];
      }
      if (typeof entry.disabled === 'boolean') return !entry.disabled;
      if (typeof entry.phase === 'string') return entry.phase === 'active' || entry.phase === 'done';
      return null;
    }

    // ------------------------------------------------------------------ styles

    const S = {
      page: { padding: '2px 0', color: 'var(--dsw-alias-text-primary, inherit)', fontSize: 13 },
      muted: { color: 'var(--dsw-alias-text-secondary, inherit)' },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 },
      title: { fontWeight: 600, fontSize: 14 },
      btn: {
        font: 'inherit', cursor: 'pointer', padding: '3px 10px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.35))',
        background: 'transparent', color: 'inherit',
      },
      card: {
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.28))',
        borderRadius: 8, padding: '10px 12px', marginBottom: 8,
      },
      rowTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      name: { fontWeight: 600 },
      tag: {
        fontSize: 11, padding: '1px 7px', borderRadius: 999,
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.35))',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      pre: {
        margin: '8px 0 0', padding: 8, borderRadius: 6, overflowX: 'auto',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.08))', fontSize: 12,
      },
      err: { color: 'var(--dsw-alias-text-danger, #c0392b)', marginTop: 6 },
    };

    // -------------------------------------------------------------------- view

    // `apply` receives the plugin context; the component closes over it so the page
    // can call the same Remote capability the official Plugins page uses.
    const panel = { ctx: null };

    function Panel() {
      const [state, setState] = React.useState({ status: 'loading', rows: [], error: '' });
      const [open, setOpen] = React.useState({});
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');

      const load = React.useCallback(async () => {
        setState((s) => ({ ...s, status: 'loading', error: '' }));
        try {
          const manager = panel.ctx && panel.ctx.remote && panel.ctx.remote.pluginManager;
          if (!manager) throw new Error('pluginManager Remote 不可用（本部署未挂载该能力）');
          const [bundles, plugins] = await Promise.all([
            manager.listBundles(),
            manager.listPlugins(),
          ]);
          setState({ status: 'ready', rows: collect(bundles, plugins), error: '' });
        } catch (error) {
          setState({ status: 'ready', rows: [], error: String((error && error.message) || error) });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const toggle = async (row, next) => {
        const manager = panel.ctx && panel.ctx.remote && panel.ctx.remote.pluginManager;
        if (!manager || !row.id) return;
        setBusy(row.id); setNote('');
        try {
          const result = await manager.setPluginEnabled(row.id, next);
          const applied = result && (result.application || result.applied);
          setNote('已提交：' + row.id + (applied ? '（' + applied + '）' : ''));
          await load();
        } catch (error) {
          setNote('失败：' + row.id + ' — ' + String((error && error.message) || error));
        } finally {
          setBusy('');
        }
      };

      const copy = async (row) => {
        const text = patchSnippet(row);
        try {
          await navigator.clipboard.writeText(text);
          setNote('已复制该行的 patch 片段');
        } catch (_) {
          setNote('复制失败，展开后手动选取');
        }
        setOpen((o) => ({ ...o, [row.id]: true }));
      };

      const rows = state.rows;
      const on = rows.filter((r) => enabledOf(r.entry) === true).length;

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('div', { style: S.title }, 'MCP 管理器'),
          h('div', { style: S.muted },
            state.status === 'loading' ? '读取中…'
              : rows.length + ' 条 MCP 行' + (rows.length ? '（启用 ' + on + '）' : '')),
          h('button', { style: S.btn, onClick: load }, '刷新'),
        ),

        state.error ? h('div', { style: S.err }, state.error) : null,
        note ? h('div', { style: { ...S.muted, marginBottom: 8 } }, note) : null,

        state.status === 'ready' && rows.length === 0 && !state.error
          ? h('div', { style: S.muted },
              '当前 profile 里没有 ' + MCP_MODULE + ' 行。装一个 MCP 组合包后回到这里刷新。')
          : null,

        rows.map((row) => {
          const config = configOf(row.entry);
          const enabled = enabledOf(row.entry);
          const id = row.id;
          const isOpen = !!open[id];
          return h('div', { key: id || Math.random(), style: S.card },
            h('div', { style: S.rowTop },
              h('span', { style: S.name }, serverNameOf(config, id || '(未命名)')),
              h('span', { style: { ...S.tag, ...S.muted } },
                (config && config.transport) || 'transport?'),
              enabled === null ? null
                : h('span', { style: { ...S.tag, ...(enabled ? {} : S.muted) } },
                    enabled ? '启用' : '停用'),
              row.bundle ? h('span', { style: { ...S.tag, ...S.muted } }, row.bundle) : null,
            ),

            h('div', { style: { ...S.mono, ...S.muted, marginTop: 4 } },
              id ? 'id: ' + id : '', targetOf(config) ? '  →  ' + targetOf(config) : ''),

            h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } },
              h('button', {
                style: S.btn,
                disabled: busy === id || enabled === null,
                onClick: () => toggle(row, !enabled),
              }, busy === id ? '提交中…' : (enabled ? '停用' : '启用')),
              h('button', { style: S.btn, onClick: () => setOpen((o) => ({ ...o, [id]: !isOpen })) },
                isOpen ? '收起' : '查看配置'),
              h('button', { style: S.btn, onClick: () => copy(row) }, '复制 patch 片段'),
            ),

            isOpen ? h('pre', { style: S.pre }, JSON.stringify(row.entry, null, 2)) : null,
          );
        }),

        h('div', { style: { ...S.muted, marginTop: 12, lineHeight: 1.7 } },
          '说明：MCP 服务器的参数由 DSH 的 ' + MCP_MODULE + ' 行声明。',
          '该行的 Config 字段没有声明为 volatile，因此 DSH 的设置表单不把它当作可编辑字段，',
          '第三方插件也没有写入 profile patch 的客户端通道 —— 所以本页提供的是「读 + 启停 + 复制 patch 片段」，',
          '参数改动请在 profile 的 cordis.patch.yml 里完成（复制片段可直接粘）。',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        panel.ctx = ctx;
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE,
            view: 'page',
          }, Panel));
      },
    };
  },
});
