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

    /** Label of the call-log tab, in the tab strip and the tab-type menu. */
    const CALLS_TITLE = 'MCP 调用记录';

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

    const MARKET_ROUTE = 'api/mcp-manager/market';
    const MARKET_SEARCH_ROUTE = 'api/mcp-manager/market/search';
    const MARKET_DETAIL_ROUTE = 'api/mcp-manager/market/detail';
    const MARKET_INSTALL_ROUTE = 'api/mcp-manager/market/install';
    const MARKET_UNINSTALL_ROUTE = 'api/mcp-manager/market/uninstall';
    const MARKET_INSTALLED_ROUTE = 'api/mcp-manager/market/installed';
    const MARKET_REFRESH_ROUTE = 'api/mcp-manager/market/refresh';

    const marketStatus = () => call(MARKET_ROUTE);
    const marketInstalled = () => call(MARKET_INSTALLED_ROUTE);
    const marketSearch = (q, kind, sort) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (kind && kind !== 'all') params.set('kind', kind);
      if (sort && sort !== 'relevance') params.set('sort', sort);
      params.set('limit', '30');
      return call(MARKET_SEARCH_ROUTE + '?' + params.toString());
    };
    const marketDetail = (name) => call(MARKET_DETAIL_ROUTE + '?name=' + encodeURIComponent(name));
    const marketRefresh = () => call(MARKET_REFRESH_ROUTE, { method: 'POST' });
    const marketInstall = (name, optionIndex, config) => call(MARKET_INSTALL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, optionIndex, config }),
    });
    const marketUninstall = (slug) => call(MARKET_UNINSTALL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    });

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

    // ------------------------------------------------------------ market: install

    /** How a generated row's live state reads on screen. */
    const STATE_LABEL = {
      active: '运行中',
      failed: '启动失败',
      absent: '未加载',
      'not-loaded': '未加载',
      pending: '等待中',
      loading: '加载中',
      unknown: '状态未知',
      'no-loader': '状态未知',
    };

    /** Human age of the snapshot, for the "offline data" line. */
    function ageText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return minutes + ' 分钟前';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.floor(hours / 24) + ' 天前';
    }

    /** One plan's command line or URL, as the confirmation dialog must show it verbatim. */
    function commandLineOf(option) {
      if (!option) return '';
      if (option.kind === 'http') return option.url;
      const quote = (part) => (/\s/.test(part) ? '"' + part + '"' : part);
      return [option.command, ...(option.args || [])].map(quote).join(' ');
    }

    /**
     * The install confirmation.
     *
     * The user sees, before anything runs: the exact command or URL, where the entry came
     * from, which secrets it wants, and the fact that values are written to the profile's
     * patch file in plain text.
     */
    function InstallDialog(props) {
      const { name, onClose, onDone } = props;
      const [detail, setDetail] = React.useState(null);
      const [optionIndex, setOptionIndex] = React.useState(0);
      const [values, setValues] = React.useState({});
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [result, setResult] = React.useState(null);

      React.useEffect(() => {
        let live = true;
        (async () => {
          try {
            const value = await marketDetail(name);
            if (!live) return;
            setDetail(value);
            const initial = {};
            for (const option of value.options) {
              for (const variable of option.variables) {
                if (variable.default) initial[variable.name] = variable.default;
              }
            }
            setValues(initial);
          } catch (e) {
            if (live) setError(String((e && e.message) || e));
          }
        })();
        return () => { live = false; };
      }, [name]);

      const option = detail && detail.options[optionIndex];
      const install = async () => {
        setBusy(true);
        setError('');
        try {
          const value = await marketInstall(name, optionIndex, values);
          setResult(value);
          if (onDone) onDone();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      if (result !== null) {
        return h('div', { style: { ...S.card, borderColor: 'var(--dsw-alias-border, rgba(128,128,128,.5))' } },
          h('div', { style: S.rowTop },
            h('span', { style: S.name }, '已安装'),
            h('span', { style: S.tag }, result.pkg),
            result.reinstalled ? h('span', { style: S.tag }, '覆盖更新') : null,
          ),
          h('div', { style: { ...S.muted, marginTop: 6 } },
            'MCP 行已写进新组合包 ', h('code', { style: S.mono }, result.dir),
            '，serverName 为 ', h('code', { style: S.mono }, result.serverName), '。'),
          h('div', { style: { ...S.muted, marginTop: 4 } },
            '它出现在「MCP 行」页签里；工具以 ', h('code', { style: S.mono }, 'mcp__' + result.serverName + '__*'), ' 的名字提供给模型。'),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
            h('button', { style: S.btnPrimary, onClick: onClose }, '关闭'),
          ),
        );
      }

      return h('div', { style: { ...S.card, borderColor: 'var(--dsw-alias-border, rgba(128,128,128,.5))' } },
        h('div', { style: S.rowTop },
          h('span', { style: S.name }, detail ? detail.server.title : name),
          h('span', { style: S.tag }, name),
          detail && detail.server.version ? h('span', { style: S.tag }, 'v' + detail.server.version) : null,
          h('span', { style: { ...S.tag, ...S.muted } }, '来源：官方 MCP 注册表'),
          h('span', { style: { flex: 1 } }),
          h('button', { style: S.btn, onClick: onClose }, '取消'),
        ),
        detail && detail.server.description
          ? h('div', { style: { ...S.muted, marginTop: 6 } }, detail.server.description)
          : null,

        !detail && !error ? h('div', { style: { ...S.muted, marginTop: 8 } }, '读取安装方式…') : null,
        error ? h('div', { style: S.err }, error) : null,

        detail && detail.options.length === 0
          ? h('div', { style: S.err }, '这台机器没有能跑它的运行时：',
              (detail.blocked || []).map((item) => item.registryType + '（' + item.reason + '）').join('；'))
          : null,

        detail && detail.options.length > 1
          ? h('div', { style: { marginTop: 8 } },
              h('div', { style: S.label }, '安装方式'),
              detail.options.map((item, index) => h('label', {
                key: item.label,
                style: { display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, cursor: 'pointer' },
              },
                h('input', {
                  type: 'radio',
                  checked: index === optionIndex,
                  onChange: () => setOptionIndex(index),
                }),
                h('span', null, item.label),
              )),
            )
          : null,

        option
          ? h('div', { style: { marginTop: 10 } },
              h('div', { style: S.label }, option.kind === 'http' ? '将连接到的地址' : '将执行的命令'),
              h('pre', { style: S.pre }, commandLineOf(option)),
              h('div', { style: { ...S.muted, marginTop: 4 } }, '⚠️ ' + option.risk),
            )
          : null,

        option && option.variables.length > 0
          ? h('div', { style: { marginTop: 10 } },
              h('div', { style: S.label }, '需要填写'),
              option.variables.map((variable) => h('div', { key: variable.name, style: S.field },
                h('label', { style: { ...S.label, ...S.mono } },
                  variable.name,
                  variable.isRequired ? h('span', { style: S.err }, ' *') : null),
                h('input', {
                  style: S.input,
                  type: variable.isSecret ? 'password' : 'text',
                  placeholder: variable.default || (variable.isRequired ? '必填' : '可留空'),
                  value: values[variable.name] === undefined ? '' : values[variable.name],
                  onChange: (event) => setValues((current) => ({ ...current, [variable.name]: event.target.value })),
                }),
              )),
              h('div', { style: { ...S.muted, marginTop: 4 } },
                '这些值会写进 profile 的 cordis.patch.yml（明文）。'),
            )
          : null,

        option && option.variables.length === 0
          ? h('div', { style: { ...S.muted, marginTop: 10 } }, '这个条目不需要填写任何配置。')
          : null,

        detail && (detail.blocked || []).length > 0
          ? h('div', { style: { ...S.muted, marginTop: 8 } },
              '其它方式：' + detail.blocked.map((item) => item.registryType + '（' + item.reason + '）').join('；'))
          : null,

        option
          ? h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
              h('button', { style: S.btnPrimary, disabled: busy, onClick: install },
                busy ? '安装中…' : '安装'),
              h('button', { style: S.btn, disabled: busy, onClick: onClose }, '取消'),
            )
          : null,
      );
    }

    // -------------------------------------------------------------- market: panel

    /** The market tab: catalog status, installed market bundles, and local search. */
    function MarketPanel(props) {
      const { onInstalled } = props;
      const [status, setStatus] = React.useState(null);
      const [installed, setInstalled] = React.useState({ items: [], toolListing: false });
      const [query, setQuery] = React.useState('');
      const [kind, setKind] = React.useState('all');
      const [sort, setSort] = React.useState('relevance');
      const [results, setResults] = React.useState({ total: 0, results: [] });
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [dialog, setDialog] = React.useState('');

      const loadStatus = React.useCallback(async () => {
        try {
          setStatus(await marketStatus());
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }, []);
      const loadInstalled = React.useCallback(async () => {
        try {
          setInstalled(await marketInstalled());
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      }, []);
      const runSearch = React.useCallback(async (q, k, s) => {
        setBusy('search');
        try {
          setResults(await marketSearch(q, k, s));
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      }, []);

      React.useEffect(() => {
        loadStatus();
        loadInstalled();
        runSearch('', 'all', 'relevance');
      }, [loadStatus, loadInstalled, runSearch]);

      // A refresh runs for minutes on the Host; poll while it does.
      const refreshing = !!(status && status.refreshing && status.refreshing.running);
      React.useEffect(() => {
        if (!refreshing) return undefined;
        const timer = setInterval(() => { loadStatus(); }, 2500);
        return () => clearInterval(timer);
      }, [refreshing, loadStatus]);

      const refresh = async () => {
        setBusy('refresh');
        setError('');
        try {
          await marketRefresh();
          await loadStatus();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const uninstall = async (slug) => {
        setBusy(slug);
        setError('');
        try {
          await marketUninstall(slug);
          await loadInstalled();
          if (onInstalled) onInstalled();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const runtimeLine = status
        ? [
            'npx ' + (status.runtimes.npx.available ? '可用' : '缺失'),
            'uvx ' + (status.runtimes.uvx.available ? '可用' : '缺失'),
            'docker ' + (status.runtimes.docker.available ? '可用' : '缺失'),
          ].join(' · ')
        : '';

      return h('div', null,
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            style: { ...S.input, flex: '1 1 220px' },
            placeholder: '搜索 MCP 服务器（名称 / 描述，本地搜索）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') runSearch(query, kind, sort); },
          }),
          h('select', {
            style: S.input,
            value: kind,
            onChange: (event) => { setKind(event.target.value); runSearch(query, event.target.value, sort); },
          },
            h('option', { value: 'all' }, '全部'),
            h('option', { value: 'local' }, '可本地安装'),
            h('option', { value: 'remote' }, '仅远程'),
          ),
          h('select', {
            style: S.input,
            value: sort,
            onChange: (event) => { setSort(event.target.value); runSearch(query, kind, event.target.value); },
          },
            h('option', { value: 'relevance' }, '相关度'),
            h('option', { value: 'newest' }, '最新上架'),
            h('option', { value: 'name' }, '名称'),
          ),
          h('button', { style: S.btn, onClick: () => runSearch(query, kind, sort) }, busy === 'search' ? '搜索中…' : '搜索'),
          h('button', { style: S.btn, disabled: refreshing, onClick: refresh }, refreshing ? '刷新中…' : '刷新目录'),
        ),

        h('div', { style: { ...S.muted, marginTop: 6, lineHeight: 1.7 } },
          status
            ? '目录：' + status.count + ' 个服务器 · 更新于 ' + ageText(status.ageMs) +
              (status.stale ? '（已过期，建议刷新）' : '') + ' · ' + runtimeLine
            : '读取目录状态…',
          status && status.source === 'none'
            ? h('div', null, '还没有本地快照，点「刷新目录」拉一次全量（约 100 秒，之后都是本地搜索）。')
            : null,
          refreshing
            ? h('div', null, '正在后台拉取：已 ' + status.refreshing.pages + ' 页 / ' +
                status.refreshing.rawEntries + ' 条，保留 ' + status.refreshing.kept + ' 个服务器。')
            : null,
          status && status.refreshing && status.refreshing.error
            ? h('div', { style: S.err }, '上次刷新失败：' + status.refreshing.error + '（继续使用本地快照）')
            : null,
        ),

        error ? h('div', { style: S.err }, error) : null,

        dialog !== ''
          ? h(InstallDialog, {
              name: dialog,
              onClose: () => setDialog(''),
              onDone: () => { loadInstalled(); loadStatus(); },
            })
          : null,

        installed.items.length > 0
          ? h('div', { style: { marginTop: 14 } },
              h('div', { style: { ...S.title, marginBottom: 6 } }, '从市场安装的（' + installed.items.length + '）'),
              installed.items.map((item) => h('div', { key: item.slug, style: S.card },
                h('div', { style: S.rowTop },
                  h('span', { style: S.name }, item.registryTitle || item.registryName),
                  h('span', { style: { ...S.tag, ...S.muted } }, item.kind === 'http' ? '远程' : item.registryType),
                  h('span', { style: { ...S.tag, ...(item.state === 'active' ? S.muted : S.err) } },
                    STATE_LABEL[item.state] || item.state),
                  item.toolCount !== null && item.toolCount !== undefined
                    ? h('span', { style: { ...S.tag, ...S.muted } }, '✓ ' + item.toolCount + ' 个工具')
                    : (installed.toolListing === false
                        ? h('span', { style: { ...S.tag, ...S.muted } }, '工具数未知')
                        : null),
                  item.updateAvailable
                    ? h('span', { style: { ...S.tag, ...S.muted } }, '有新版 v' + item.latestVersion)
                    : null,
                  h('span', { style: { flex: 1 } }),
                  h('button', {
                    style: S.btn,
                    disabled: busy === item.slug,
                    onClick: () => uninstall(item.slug),
                  }, busy === item.slug ? '卸载中…' : '卸载'),
                ),
                h('div', { style: { ...S.mono, ...S.muted, marginTop: 4, wordBreak: 'break-all' } },
                  item.kind === 'http' ? item.url : (item.command || '') + ' ' + ((item.args || []).join(' '))),
                h('div', { style: { ...S.muted, marginTop: 2 } },
                  'serverName ' + item.serverName + ' · 组合包 ' + item.pkg +
                  (item.configKeys && item.configKeys.length > 0 ? ' · 已配置 ' + item.configKeys.join(', ') : '')),
                item.error ? h('div', { style: S.err }, item.error) : null,
              )),
            )
          : null,

        h('div', { style: { marginTop: 14 } },
          h('div', { style: { ...S.title, marginBottom: 6 } },
            '搜索结果（' + results.total + '）'),
          results.results.length === 0
            ? h('div', { style: S.muted }, '没有匹配的条目。')
            : results.results.map((hit) => h('div', { key: hit.name, style: S.card },
                h('div', { style: S.rowTop },
                  h('span', { style: S.name }, hit.title),
                  hit.version ? h('span', { style: { ...S.tag, ...S.muted } }, 'v' + hit.version) : null,
                  h('span', { style: S.tag }, hit.hasLocal ? (hit.types.filter((t) => t === 'npm' || t === 'pypi').join('/') || '本地') : '远程'),
                  hit.hasRemote && hit.hasLocal ? h('span', { style: { ...S.tag, ...S.muted } }, '也可远程') : null,
                  h('span', { style: { flex: 1 } }),
                  h('button', { style: S.btnPrimary, onClick: () => setDialog(hit.name) }, '安装'),
                ),
                h('div', { style: { ...S.mono, ...S.muted, marginTop: 3 } }, hit.name),
                hit.description ? h('div', { style: { ...S.muted, marginTop: 3 } }, hit.description) : null,
              )),
        ),
      );
    }

    // ---------------------------------------------------------------------- page

    function Panel() {
      const [state, setState] = React.useState({ status: 'loading', value: null, error: '' });
      const [tab, setTab] = React.useState('rows');
      const [note, setNote] = React.useState('');

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

        h('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
          h('button', {
            style: tab === 'rows' ? S.btnPrimary : S.btn,
            onClick: () => setTab('rows'),
          }, 'MCP 行'),
          h('button', {
            style: tab === 'market' ? S.btnPrimary : S.btn,
            onClick: () => setTab('market'),
          }, '市场'),
        ),

        note ? h('div', { style: { ...S.muted, marginBottom: 8 } }, note) : null,

        tab === 'market'
          ? h(MarketPanel, { onInstalled: load })
          : h('div', null,
              state.error ? h('div', { style: S.err }, state.error) : null,

              state.status === 'ready' && !state.error && rows.length === 0
                ? h('div', { style: S.muted },
                    '当前 profile 里没有 @deepseek-ai/dsh-mcp-client 行。去「市场」装一个，或装一个 MCP 组合包后回到这里刷新。')
                : null,

              rows.map((row) => h(Row, { key: row.id || Math.random().toString(36), row, onReload: load })),

              h('div', { style: { ...S.muted, marginTop: 12, lineHeight: 1.7 } },
                '改动写进当前 profile 的 cordis.patch.yml（由 DSH 的配置编辑服务落盘并热应用）；',
                '带 * 的字段表示这一行已在 profile 里覆盖过。',
                '「恢复默认」会移除覆盖项、回到组合包声明的值。',
                caps.write === false ? '（注意：本 profile 未挂载 configEditor，只能读。）' : '',
                caps.rowPages === false ? '（有行缺少所属组合包信息，逐行配置页暂不可用。）' : '',
              ),
            ),
      );
    }

    /**
     * Label of one call-log tab in the right dock.
     *
     * The slot passes `useTabInfo` and `useStore` hooks; the label is static, so
     * neither is needed here.
     *
     * @returns the tab title.
     */
    function CallsTitle() {
      return h('span', null, CALLS_TITLE);
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

        // The call log is an optional page in the right dock: one tab type, plus the
        // body and the title registered under that type's id.
        //
        // `sidebarRight` and `sidebarRightTabs` are shipped by
        // dsh-client-ui-sidebar-browser and are absent when the right dock is not
        // mounted, so they are acquired through `ctx.inject`: the child scope
        // activates when they appear and simply never activates when they do not.
        // A plain property read would THROW — Cordis resolves only injected
        // services — and a throw from `apply()` fails the whole web boot rather
        // than just this bundle.
        ctx.inject(['sidebarRight', 'sidebarRightTabs'], (scope) => {
          dock.sidebarRight = scope.sidebarRight;
          scope.effect(() => {
            try {
              return scope.sidebarRightTabs.register({
                id: BUNDLE,
                kind: CALLS_KIND,
                multiple: false,
                title: () => CALLS_TITLE,
                keepMounted: true,
              });
            } catch (error) {
              // A tab type this shell refuses must cost the call-log tab, never the boot.
              console.warn('[mcp-manager] call-log tab type rejected:', error);
              return undefined;
            }
          });
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
            name: 'sidebar.right.pane.tab',
            key: BUNDLE,
          }, CallsPanel)));
          scope.effect(() => scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: BUNDLE,
          }, CallsTitle)));
        });
      },
    };
  },
});
