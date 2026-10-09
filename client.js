/**
 * Browser half of dsh-plugin-mcp-manager.
 *
 * Renders the manager on this bundle's own page in the DSH Plugins page, and talks to
 * the Host half over the four exact Fetch routes it registers. Relative route paths
 * and `credentials: 'same-origin'`, matching how a third-party plugin reaches its own
 * Host routes.
 *
 * No build step, no import of any Harness Client package, styling through host theme
 * variables only — a DSH upgrade degrades the look rather than breaking the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BUNDLE = 'dsh-plugin-mcp-manager';
    const SERVERS_ROUTE = 'api/mcp-manager/servers';
    const CONFIG_ROUTE = 'api/mcp-manager/config';
    const ENABLED_ROUTE = 'api/mcp-manager/enabled';
    const SESSIONS_ROUTE = 'api/mcp-manager/sessions';
    const CALLS_ROUTE = 'api/mcp-manager/calls';

    /** The right-dock tab type this bundle contributes. */
    const CALLS_KIND = 'mcp-manager-calls';

    // ------------------------------------------------------------------ transport

    async function call(route, init) {
      const response = await fetch(route, { credentials: 'same-origin', ...init });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || body.ok !== true) {
        const message = (body && body.error && body.error.message) || ('HTTP ' + String(response.status));
        throw new Error(message);
      }
      return body.value;
    }

    const listServers = () => call(SERVERS_ROUTE);
    const saveConfig = (id, config) => call(CONFIG_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, config }),
    });
    const resetConfig = (id) => call(CONFIG_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, reset: true }),
    });
    const setEnabled = (id, enabled) => call(ENABLED_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
    const listSessions = () => call(SESSIONS_ROUTE);
    const listCalls = (sessionId, limit) => {
      const params = new URLSearchParams();
      if (sessionId) params.set('sessionId', sessionId);
      if (limit) params.set('limit', String(limit));
      const query = params.toString();
      return call(CALLS_ROUTE + (query === '' ? '' : '?' + query));
    };

    /**
     * The sidebar controller, captured in `apply`. The manager page uses it to open
     * the call-log tab; the tab itself reads nothing from it.
     */
    const dock = { sidebarRight: null };

    // -------------------------------------------------------------------- helpers

    function serverNameOf(config, fallback) {
      const name = config && config.serverName;
      return typeof name === 'string' && name.length > 0 ? name : fallback;
    }

    function targetOf(config) {
      if (!config || typeof config !== 'object') return '';
      if (typeof config.url === 'string' && config.url.length > 0) return config.url;
      const command = typeof config.command === 'string' ? config.command : '';
      const args = Array.isArray(config.args) ? config.args.join(' ') : '';
      return (command + ' ' + args).trim();
    }

    /** The value kind a control should use for one config field. */
    function kindOf(value) {
      if (typeof value === 'boolean') return 'boolean';
      if (typeof value === 'number') return 'number';
      if (typeof value === 'string') return 'string';
      return 'json';
    }

    function asText(value) {
      return typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
    }

    /** Parse an edited control value back into the shape the field had. */
    function parseValue(kind, text, previous) {
      if (kind === 'number') {
        const n = Number(text);
        if (Number.isNaN(n)) throw new Error('需要一个数字');
        return n;
      }
      if (kind === 'boolean') return text === true || text === 'true';
      if (kind === 'string') return text;
      try {
        return JSON.parse(text);
      } catch (error) {
        throw new Error('JSON 解析失败：' + String((error && error.message) || error));
      }
    }

    // --------------------------------------------------------------------- styles

    const S = {
      page: { color: 'var(--dsw-alias-text-primary, inherit)', fontSize: 13 },
      muted: { color: 'var(--dsw-alias-text-secondary, inherit)' },
      head: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 },
      title: { fontWeight: 600, fontSize: 14 },
      btn: {
        font: 'inherit', cursor: 'pointer', padding: '3px 10px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.35))',
        background: 'transparent', color: 'inherit',
      },
      btnPrimary: {
        font: 'inherit', cursor: 'pointer', padding: '3px 12px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.5))',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.12))', color: 'inherit',
      },
      card: {
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.28))',
        borderRadius: 8, padding: '10px 12px', marginBottom: 10,
      },
      rowTop: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      name: { fontWeight: 600 },
      tag: { fontSize: 11, padding: '1px 7px', borderRadius: 999, border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.35))' },
      field: { display: 'grid', gridTemplateColumns: '150px 1fr', gap: 8, alignItems: 'center', marginTop: 6 },
      label: { fontSize: 12 },
      input: {
        font: 'inherit', width: '100%', boxSizing: 'border-box', padding: '3px 7px', borderRadius: 6,
        border: '1px solid var(--dsw-alias-border, rgba(128,128,128,.4))',
        background: 'var(--dsw-alias-bg-primary, transparent)', color: 'inherit',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 12 },
      pre: {
        margin: '8px 0 0', padding: 8, borderRadius: 6, overflowX: 'auto',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,.08))', fontSize: 12,
      },
      err: { color: 'var(--dsw-alias-text-danger, #c0392b)', marginTop: 6 },
      ok: { marginTop: 6 },
    };

    // ------------------------------------------------------------------- one row

    function Row(props) {
      const { row, onReload } = props;
      const [draft, setDraft] = React.useState(() => ({ ...(row.effective || {}) }));
      const [open, setOpen] = React.useState(false);
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');
      const [error, setError] = React.useState('');

      React.useEffect(() => { setDraft({ ...(row.effective || {}) }); }, [row.effective]);

      const disabled = row.disabled === true;
      const overriddenKeys = Object.keys(row.override || {});

      const run = async (label, action) => {
        setBusy(label); setError(''); setNote('');
        try {
          await action();
          setNote(label + ' 完成');
          if (onReload) await onReload();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const submit = () => run('保存', async () => {
        const next = {};
        for (const key of Object.keys(draft)) {
          const previous = (row.effective || {})[key];
          next[key] = parseValue(kindOf(previous), draft[key], previous);
        }
        await saveConfig(row.id, next);
      });

      const fields = Object.keys(draft);

      return h('div', { style: S.card },
        h('div', { style: S.rowTop },
          h('span', { style: S.name }, serverNameOf(row.effective, row.id || '(未命名)')),
          h('span', { style: { ...S.tag, ...S.muted } }, (row.effective && row.effective.transport) || 'transport?'),
          h('span', { style: { ...S.tag, ...(disabled ? S.muted : {}) } }, disabled ? '停用' : '启用'),
          overriddenKeys.length > 0
            ? h('span', { style: S.tag }, '已覆盖 ' + overriddenKeys.length + ' 项') : null,
        ),
        h('div', { style: { ...S.mono, ...S.muted, marginTop: 4 } },
          row.bundle ? row.bundle + '#' + row.rowId + '   ' : (row.id ? 'id: ' + row.id + '   ' : ''),
          targetOf(row.effective) ? '→  ' + targetOf(row.effective) : ''),

        fields.length === 0
          ? h('div', { style: { ...S.muted, marginTop: 8 } }, '这一行没有可读到的配置（只读来源）。')
          : h('div', { style: { marginTop: 6 } },
              fields.map((key) => {
                const kind = kindOf((row.effective || {})[key]);
                const overridden = overriddenKeys.indexOf(key) >= 0;
                const label = key + (overridden ? ' *' : '');
                if (kind === 'boolean') {
                  return h('div', { key, style: S.field },
                    h('span', { style: S.label }, label),
                    h('input', {
                      type: 'checkbox',
                      checked: draft[key] === true,
                      disabled: row.editable === false,
                      onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.checked })),
                    }));
                }
                if (kind === 'json') {
                  return h('div', { key, style: { ...S.field, alignItems: 'start' } },
                    h('span', { style: S.label }, label + ' (JSON)'),
                    h('textarea', {
                      style: { ...S.input, ...S.mono, minHeight: 54 },
                      value: asText(draft[key]),
                      disabled: row.editable === false,
                      onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })),
                    }));
                }
                return h('div', { key, style: S.field },
                  h('span', { style: S.label }, label),
                  h('input', {
                    style: { ...S.input, ...(kind === 'number' ? S.mono : {}) },
                    type: kind === 'number' ? 'number' : 'text',
                    value: draft[key] === undefined || draft[key] === null ? '' : String(draft[key]),
                    disabled: row.editable === false,
                    onChange: (e) => setDraft((d) => ({ ...d, [key]: e.target.value })),
                  }));
              })),

        h('div', { style: { display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' } },
          h('button', {
            style: S.btnPrimary,
            disabled: row.editable === false || busy !== '',
            onClick: submit,
          }, busy === '保存' ? '保存中…' : '保存'),
          h('button', {
            style: S.btn,
            disabled: row.editable === false || busy !== '',
            onClick: () => run('恢复默认', () => resetConfig(row.id)),
          }, '恢复默认'),
          h('button', {
            style: S.btn,
            disabled: row.editable === false || busy !== '',
            onClick: () => run(disabled ? '启用' : '停用', () => setEnabled(row.id, disabled)),
          }, disabled ? '启用' : '停用'),
          h('button', { style: S.btn, onClick: () => setOpen(!open) }, open ? '收起原始数据' : '原始数据'),
        ),

        note ? h('div', { style: { ...S.muted, ...S.ok } }, note) : null,
        error ? h('div', { style: S.err }, error) : null,
        open ? h('pre', { style: S.pre }, JSON.stringify(row, null, 2)) : null,
      );
    }

    // ------------------------------------------------------- call log (side dock)

    /**
     * The right-dock page: one session's MCP tool calls, newest first.
     *
     * Sessions come from the host's `listSessions()` (lightweight — it does not
     * replay a log), and the newest is selected by default so the page is useful
     * without any interaction.
     */
    function CallsPanel() {
      const [sessions, setSessions] = React.useState([]);
      const [sessionId, setSessionId] = React.useState('');
      const [state, setState] = React.useState({ status: 'loading', calls: [], total: 0, error: '' });
      const [open, setOpen] = React.useState({});

      const loadCalls = React.useCallback(async (id) => {
        if (!id) return;
        setState((s) => ({ ...s, status: 'loading', error: '' }));
        try {
          const value = await listCalls(id, 200);
          setState({
            status: 'ready',
            calls: (value && value.calls) || [],
            total: (value && value.total) || 0,
            error: '',
          });
        } catch (e) {
          setState({ status: 'ready', calls: [], total: 0, error: String((e && e.message) || e) });
        }
      }, []);

      const boot = React.useCallback(async () => {
        try {
          const value = await listSessions();
          const list = (value && value.sessions) || [];
          setSessions(list);
          const first = (list[0] && list[0].id) || '';
          setSessionId(first);
          if (first) await loadCalls(first);
          else setState({ status: 'ready', calls: [], total: 0, error: '没有可读的会话' });
        } catch (e) {
          setState({ status: 'ready', calls: [], total: 0, error: String((e && e.message) || e) });
        }
      }, [loadCalls]);

      React.useEffect(() => { boot(); }, [boot]);

      const pick = async (id) => { setSessionId(id); await loadCalls(id); };
      const ms = (v) => (typeof v === 'number' ? (v >= 1000 ? (v / 1000).toFixed(2) + ' s' : v + ' ms') : '—');
      const bytes = (v) => (typeof v === 'number' ? (v >= 1024 ? (v / 1024).toFixed(1) + ' KB' : v + ' B') : '—');
      const clock = (v) => (typeof v === 'number' ? new Date(v).toLocaleTimeString() : '—');

      return h('div', { style: { ...S.page, padding: '8px 10px' } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
          h('select', {
            style: { ...S.input, flex: 1 },
            value: sessionId,
            onChange: (e) => pick(e.target.value),
          }, sessions.length === 0
            ? h('option', { value: '' }, '（没有会话）')
            : sessions.map((s) => h('option', { key: s.id, value: s.id },
                (s.title ? String(s.title).slice(0, 60) + ' · ' : '') +
                s.id.slice(0, 8) + (s.live ? ' · 活动' : '')))),
          h('button', { style: S.btn, onClick: () => loadCalls(sessionId) }, '刷新'),
        ),

        state.error ? h('div', { style: S.err }, state.error) : null,
        state.status === 'loading' ? h('div', { style: S.muted }, '读取中…') : null,
        state.status === 'ready' && !state.error
          ? h('div', { style: { ...S.muted, marginBottom: 6 } },
              state.calls.length + ' / ' + state.total + ' 次 MCP 调用')
          : null,
        state.status === 'ready' && !state.error && state.calls.length === 0
          ? h('div', { style: S.muted }, '这个会话里没有 MCP 工具调用。')
          : null,

        state.calls.map((call, index) => {
          const key = call.callId || String(index);
          const isOpen = !!open[key];
          return h('div', {
            key,
            style: { ...S.card, padding: '7px 9px', marginBottom: 6, cursor: 'pointer' },
            onClick: () => setOpen((o) => ({ ...o, [key]: !isOpen })),
          },
            h('div', { style: { display: 'flex', gap: 6, alignItems: 'baseline', flexWrap: 'wrap' } },
              h('span', { style: { ...S.mono, fontWeight: 600 } }, call.tool || '?'),
              h('span', { style: { ...S.tag, ...S.muted } }, call.server || '—'),
              h('span', { style: { ...S.tag, ...(call.ok === false ? S.err : S.muted) } },
                call.ok === false ? '失败' : (call.ok === true ? '成功' : '未完成')),
              h('span', { style: { ...S.muted, ...S.mono } },
                ms(call.durationMs) + ' · ' + bytes(call.resultBytes)),
            ),
            h('div', { style: { ...S.mono, ...S.muted, marginTop: 3 } },
              clock(call.at) + '  ' + String(call.args || '').slice(0, 120)),
            isOpen ? h('pre', { style: S.pre }, JSON.stringify(call, null, 2)) : null,
            isOpen && call.error ? h('div', { style: S.err }, call.error) : null,
          );
        }),
      );
    }

    // ---------------------------------------------------------------------- page

    function Panel() {
      const [state, setState] = React.useState({ status: 'loading', value: null, error: '' });

      const load = React.useCallback(async () => {
        try {
          const value = await listServers();
          setState({ status: 'ready', value, error: '' });
        } catch (e) {
          setState({ status: 'ready', value: null, error: String((e && e.message) || e) });
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const value = state.value;
      const rows = (value && value.rows) || [];
      const caps = (value && value.capabilities) || {};

      const openCalls = () => {
        const controller = dock.sidebarRight;
        if (!controller || typeof controller.openTab !== 'function') {
          setNote('本部署没有右侧停靠栏，调用记录页打不开。');
          return;
        }
        try {
          controller.openTab(CALLS_KIND);
        } catch (e) {
          setNote('打开失败：' + String((e && e.message) || e));
        }
      };

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('div', { style: S.title }, 'MCP 管理器'),
          h('div', { style: S.muted },
            state.status === 'loading' ? '读取中…'
              : rows.length + ' 条 MCP 行' + (value && value.source ? '（来源：' + value.source + '）' : '')),
          h('button', { style: S.btn, onClick: openCalls }, '调用记录'),
          h('button', { style: S.btn, onClick: load }, '刷新'),
        ),

        note ? h('div', { style: { ...S.muted, marginBottom: 8 } }, note) : null,

        state.error ? h('div', { style: S.err }, state.error) : null,

        state.status === 'ready' && !state.error && rows.length === 0
          ? h('div', { style: S.muted },
              '当前 profile 里没有 @deepseek-ai/dsh-mcp-client 行。装一个 MCP 组合包后回到这里刷新。')
          : null,

        rows.map((row) => h(Row, { key: row.id || Math.random().toString(36), row, onReload: load })),

        h('div', { style: { ...S.muted, marginTop: 12, lineHeight: 1.7 } },
          '改动写进当前 profile 的 cordis.patch.yml（由 DSH 的配置编辑服务落盘并热应用）；',
          '带 * 的字段表示这一行已在 profile 里覆盖过。',
          '「恢复默认」会移除覆盖项、回到组合包声明的值。',
          caps.write === false ? '（注意：本 profile 未挂载 configEditor，只能读。）' : '',
          caps.rowPages === false ? '（有行缺少所属组合包信息，逐行配置页暂不可用。）' : '',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The manager page lives on this bundle's own page in the Plugins page.
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({
            name: 'plugins.bundle.config',
            key: BUNDLE,
            view: 'page',
          }, Panel));

        // The call log is a page of its own in the right dock: one tab type, plus the
        // body registered under that type's id. Both live in an effect so they are
        // disposed with the plugin.
        dock.sidebarRight = ctx.sidebarRight || null;
        if (ctx.sidebarRightTabs && typeof ctx.sidebarRightTabs.register === 'function') {
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: BUNDLE,
            kind: CALLS_KIND,
            title: () => 'MCP 调用记录',
            keepMounted: true,
          }));
        }
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: BUNDLE }, CallsPanel));
      },
    };
  },
});
