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
    const marketSearch = (q, kind, sort, offset) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (kind && kind !== 'all') params.set('kind', kind);
      if (sort && sort !== 'relevance') params.set('sort', sort);
      params.set('limit', String(MARKET_PAGE_SIZE));
      params.set('offset', String(offset || 0));
      return call(MARKET_SEARCH_ROUTE + '?' + params.toString());
    };
    const marketDetail = (name) => call(MARKET_DETAIL_ROUTE + '?name=' + encodeURIComponent(name));
    const marketRefresh = () => call(MARKET_REFRESH_ROUTE, { method: 'POST' });
    const marketInstall = (name, optionIndex, config, args) => call(MARKET_INSTALL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, optionIndex, config, arguments: args || {} }),
    });
    const marketUninstall = (slug) => call(MARKET_UNINSTALL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    });

    /**
     * The sidebar controller and the plugin context, captured in `apply`.
     *
     * The manager page uses the controller to open the call-log tab; the market page uses
     * the context to resolve the plugin page's navigation lazily.
     */
    const dock = { sidebarRight: null, ctx: null };

    /**
     * The plugin page's published navigation, when this profile mounts it.
     *
     * `dsh-client-ui-plugin-manager` publishes `pluginNavigation` through the reflection
     * seam (`lib/client.js:3758`): `openBundle(pkg)` switches the left nav to the Plugins
     * panel and opens that bundle's page. Reflection-published values are ordinary
     * services — the loader publishes itself the same way (`cordis-plugin-loader:603`) and
     * every reader reaches it through `ctx.get` / `ctx.inject` — so `ctx.get` is the whole
     * story, and no bare property read is needed.
     *
     * Resolved lazily and defensively: the service may not be mounted when this plugin
     * activates, and a missing service must cost a convenience jump, never a render.
     *
     * @returns the navigation service, or `null`.
     */
    function pluginNavigation() {
      const ctx = dock.ctx;
      if (ctx === null || ctx === undefined) return null;
      try {
        if (typeof ctx.get !== 'function') return null;
        const value = ctx.get('pluginNavigation');
        return value === undefined ? null : value;
      } catch {
        /* not published in this profile */
        return null;
      }
    }

    /** The bundle package name behind one installed market entry. */
    function packageOfSlug(slug) {
      return '@dsh-mcp-market/' + String(slug);
    }

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

    // --------------------------------------------------------- market (nav page)

    /**
     * The nav id. `sidebar.panellist` and the `main` panel are addressed by this same
     * value — the sidebar resolves one from the other.
     */
    const MARKET_PANEL_ID = 'mcp-market';

    /**
     * Nav position. The host's own Plugins entry registers `order: 0` and the third-party
     * panels in this profile sit at 30, so 5 lands directly under Plugins. Recorded in the
     * README so a later plugin does not silently take the same slot.
     */
    const MARKET_PANEL_ORDER = 5;

    /** Cards per page: the catalog holds thousands, and sorting/filtering stays exact. */
    const MARKET_PAGE_SIZE = 60;

    /**
     * The skeleton's entire class table.
     *
     * Every visual value lives here and nowhere else. Components carry semantic class names
     * plus `data-state`, so replacing this block replaces the look without touching a
     * component. Layout values are present so the skeleton is usable; colours are
     * deliberately left to DSH theme variables and to the `data-state` hooks below, which
     * the visual spec fills in.
     */
    const MARKET_CSS = `
/* ---------------------------------------------------------------------------
   MCP market class table. This block is the whole visual layer: components carry
   semantic class names and data-state only, so replacing this replaces the look.

   Colours come from the host's own tokens first (verified present in DSH 44:
   --dsw-alias-button-primary-fill, --dsw-alias-label-primary-foreground,
   --dsw-alias-state-success-primary, --dsw-alias-state-warn-primary,
   --dsw-alias-state-error-primary, --dsw-alias-border-l1, --dsw-alias-label-secondary,
   --dsw-radius-md). The fallbacks are only for rendering outside the app.
   --------------------------------------------------------------------------- */
.mcpm-page {
  --mcpm-accent: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #3b6de0));
  --mcpm-accent-fg: var(--dsw-alias-label-primary-foreground, #ffffff);
  --mcpm-success: var(--dsw-alias-state-success-primary, var(--mcpm-success-fb, #1a7f37));
  --mcpm-warning: var(--dsw-alias-state-warn-primary, var(--mcpm-warning-fb, #9a6700));
  --mcpm-danger: var(--dsw-alias-state-error-primary, #c0392b);
  --mcpm-border: var(--dsw-alias-border-l1, rgba(128, 128, 128, .28));
  --mcpm-border-strong: var(--dsw-alias-border-l2, rgba(128, 128, 128, .4));
  --mcpm-muted: var(--dsw-alias-label-secondary, rgba(128, 128, 128, .95));
  --mcpm-radius: var(--dsw-radius-md, 10px);
  --mcpm-success-fb: #1a7f37;
  --mcpm-warning-fb: #9a6700;
  display: flex; flex-direction: column; gap: 12px; height: 100%; box-sizing: border-box;
  padding: 16px; overflow-y: auto;
  color: var(--dsw-alias-label-primary, inherit); font-size: 13px; line-height: 20px;
}
@media (prefers-color-scheme: dark) {
  .mcpm-page { --mcpm-success-fb: #3fb950; --mcpm-warning-fb: #d29922; }
}

/* toolbar ------------------------------------------------------------------ */
.mcpm-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.mcpm-search { flex: 1 1 220px; min-width: 0; }
@media (max-width: 720px) { .mcpm-search { flex-basis: 100%; } }
.mcpm-filters { display: flex; gap: 4px; }
.mcpm-statusline { font-size: 12px; color: var(--mcpm-muted); }
.mcpm-statusline [data-ok="no"] { color: var(--mcpm-warning); }

/* sections ----------------------------------------------------------------- */
.mcpm-section { display: flex; flex-direction: column; gap: 10px; }
.mcpm-result-title { font-size: 14px; font-weight: 600; margin: 0; }

/* card grid ---------------------------------------------------------------- */
.mcpm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.mcpm-card {
  display: flex; flex-direction: column; gap: 8px; padding: 14px;
  border: .5px solid var(--mcpm-border); border-radius: var(--mcpm-radius);
}
.mcpm-card:hover { border-color: var(--mcpm-accent); }

/* Letter avatar: 12 preset hues, chosen by a hash of the name. No remote icon is ever
   fetched, and the hue arrives as a class so the markup stays style-free. */
.mcpm-card__icon {
  display: flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: var(--mcpm-radius);
  font-weight: 600; text-transform: uppercase;
  border: .5px solid var(--mcpm-border);
}
.mcpm-avatar--h0 { color: hsl(0 65% 45%); background: color-mix(in srgb, hsl(0 65% 45%) 14%, transparent); }
.mcpm-avatar--h1 { color: hsl(30 65% 42%); background: color-mix(in srgb, hsl(30 65% 42%) 14%, transparent); }
.mcpm-avatar--h2 { color: hsl(60 55% 35%); background: color-mix(in srgb, hsl(60 55% 35%) 14%, transparent); }
.mcpm-avatar--h3 { color: hsl(90 55% 33%); background: color-mix(in srgb, hsl(90 55% 33%) 14%, transparent); }
.mcpm-avatar--h4 { color: hsl(120 55% 33%); background: color-mix(in srgb, hsl(120 55% 33%) 14%, transparent); }
.mcpm-avatar--h5 { color: hsl(150 55% 32%); background: color-mix(in srgb, hsl(150 55% 32%) 14%, transparent); }
.mcpm-avatar--h6 { color: hsl(180 55% 32%); background: color-mix(in srgb, hsl(180 55% 32%) 14%, transparent); }
.mcpm-avatar--h7 { color: hsl(210 65% 45%); background: color-mix(in srgb, hsl(210 65% 45%) 14%, transparent); }
.mcpm-avatar--h8 { color: hsl(240 55% 50%); background: color-mix(in srgb, hsl(240 55% 50%) 14%, transparent); }
.mcpm-avatar--h9 { color: hsl(270 55% 50%); background: color-mix(in srgb, hsl(270 55% 50%) 14%, transparent); }
.mcpm-avatar--h10 { color: hsl(300 55% 45%); background: color-mix(in srgb, hsl(300 55% 45%) 14%, transparent); }
.mcpm-avatar--h11 { color: hsl(330 60% 45%); background: color-mix(in srgb, hsl(330 60% 45%) 14%, transparent); }

.mcpm-card__name {
  font-size: 14px; font-weight: 600; margin: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.mcpm-card__desc {
  font-size: 12.5px; color: var(--mcpm-muted); margin: 0;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden; min-height: 2.6em;
}
/* margin-top:auto is what keeps badges and the action on one line across a row. */
.mcpm-card__badges { margin-top: auto; display: flex; flex-wrap: wrap; gap: 6px; }
.mcpm-card__actions { display: flex; gap: 6px; }

/* badges ------------------------------------------------------------------- */
.mcpm-badge {
  font-size: 11px; padding: 1px 8px; border-radius: 999px;
  border: .5px solid var(--mcpm-border); color: var(--mcpm-muted);
}
.mcpm-badge--version { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; opacity: .8; }
.mcpm-badge--installed { color: var(--mcpm-success); border-color: var(--mcpm-success); }
.mcpm-badge--unavailable { color: var(--mcpm-danger); }

/* buttons: the state machine's visual translation --------------------------- */
.mcpm-btn {
  font: inherit; cursor: pointer; padding: 3px 10px; border-radius: var(--mcpm-radius);
  border: .5px solid var(--mcpm-border-strong); background: transparent; color: inherit;
}
/* '--primary' marks the card's main action; the state decides how it looks. */
.mcpm-btn--primary,
.mcpm-btn[data-state="idle"], .mcpm-btn[data-state="needs-config"] {
  background: var(--mcpm-accent); color: var(--mcpm-accent-fg); border: none;
}
.mcpm-btn[data-state="installed"] {
  background: transparent; color: var(--mcpm-success); border: 1px solid var(--mcpm-success);
}
.mcpm-btn[data-state="update"] {
  background: transparent; color: var(--mcpm-accent); border: 1px solid var(--mcpm-accent);
}
.mcpm-btn[data-state="unavailable"] { opacity: .45; cursor: not-allowed; }
.mcpm-chip {
  font: inherit; cursor: pointer; padding: 2px 10px; border-radius: 999px;
  border: .5px solid var(--mcpm-border); background: transparent; color: var(--mcpm-muted);
}
.mcpm-chip[data-active="true"] { color: var(--mcpm-accent); border-color: var(--mcpm-accent); }

/* pager, dialog, misc ------------------------------------------------------ */
.mcpm-pager { display: flex; align-items: center; justify-content: center; gap: 8px; }
.mcpm-dialog {
  display: flex; flex-direction: column; gap: 8px; padding: 14px;
  border: .5px solid var(--mcpm-border-strong); border-radius: var(--mcpm-radius);
}
.mcpm-field { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 8px; }
.mcpm-field__label { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.mcpm-pre {
  margin: 0; padding: 8px; border-radius: var(--mcpm-radius); overflow-x: auto;
  background: var(--dsw-alias-bg-l2, rgba(128, 128, 128, .08));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
}
.mcpm-error { color: var(--mcpm-danger); }
.mcpm-note { color: var(--mcpm-muted); }
.mcpm-required { color: var(--mcpm-danger); }
.mcpm-actions { display: flex; gap: 8px; }
.mcpm-empty { color: var(--mcpm-muted); margin: 0; }
.mcpm-navicon { display: block; }
`;

    /** Human age of the snapshot, for the status line. */
    function ageText(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return '刚刚';
      if (minutes < 60) return minutes + ' 分钟前';
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.floor(hours / 24) + ' 天前';
    }

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

    /** Inject the class table once per document, and hand back the disposer. */
    function installMarketStyles() {
      // No usable document means no page to style (a harness, a future non-DOM host):
      // skip instead of throwing, because a throw out of `apply()` fails the whole web
      // boot. The check is deliberately per-method — a partial `document` shim must not
      // be able to take the boot down either.
      if (typeof document === 'undefined' || document === null) return () => {};
      if (typeof document.getElementById !== 'function'
        || typeof document.createElement !== 'function'
        || document.head === undefined || document.head === null) return () => {};
      const existing = document.getElementById('mcpm-styles');
      if (existing !== null && existing !== undefined) return () => {};
      const element = document.createElement('style');
      element.id = 'mcpm-styles';
      element.textContent = MARKET_CSS;
      document.head.appendChild(element);
      return () => { element.remove(); };
    }

    /**
     * The nav entry's icon.
     *
     * A plain inline SVG with no style props: the panellist decides size and colour.
     */
    function MarketIcon() {
      return h('svg', {
        className: 'mcpm-navicon',
        viewBox: '0 0 24 24',
        width: 16,
        height: 16,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M4 8h16v11H4z' }),
        h('path', { d: 'M4 8l3-4h10l3 4' }),
        h('path', { d: 'M9 12h6' }),
      );
    }

    /** The button state machine's state for one card. */
    function cardStateOf(card) {
      if (card.installedSlug) return card.updateAvailable ? 'update' : 'installed';
      if (!card.installable) return 'unavailable';
      return card.needsConfig ? 'needs-config' : 'idle';
    }

    /** The label that belongs to one card state. */
    const CARD_ACTION = {
      idle: '安装',
      'needs-config': '安装 · 需密钥',
      installed: '已安装 ✓',
      update: '更新 ↑',
      unavailable: '不可用',
    };

    /**
     * The avatar class for one entry.
     *
     * Twelve preset hues, picked by a hash of the name: a wall of identical glyphs gives no
     * sense of which card is which, and a remote icon URL is untrusted content that must
     * never be fetched. The hue travels as a class so the markup stays style-free.
     */
    function avatarClassOf(name) {
      const text = String(name || '?');
      let hash = 0;
      for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) % 1000003;
      return 'mcpm-card__icon mcpm-avatar--h' + (hash % 12);
    }

    /** The single character shown inside the avatar. */
    function avatarLetterOf(name) {
      const text = String(name || '?').replace(/^[^0-9A-Za-z\u4e00-\u9fa5]+/, '');
      return text.slice(0, 1) || '?';
    }

    /**
     * One catalog card.
     *
     * Five semantic blocks in a fixed order — icon, name, description, badges, actions.
     * The visual spec may rearrange them in CSS; the structure does not change.
     */
    function MarketCard(props) {
      const { card, onInstall, onUninstall, onOpenInstalled } = props;
      const state = cardStateOf(card);
      const action = () => {
        if (state === 'unavailable') return;
        if (state === 'installed') { onOpenInstalled(card); return; }
        onInstall(card);
      };
      return h('article', { className: 'mcpm-card', 'data-state': state },
        h('div', { className: avatarClassOf(card.name), 'aria-hidden': 'true' }, avatarLetterOf(card.title || card.name)),
        h('h3', { className: 'mcpm-card__name' }, card.title || card.name),
        h('p', { className: 'mcpm-card__desc' }, card.description || '（无描述）'),
        h('div', { className: 'mcpm-card__badges' },
          h('span', { className: 'mcpm-badge mcpm-badge--kind' }, card.registryType || (card.hasRemote ? 'remote' : '—')),
          (card.kinds || []).map((kind) => h('span', { key: kind, className: 'mcpm-badge mcpm-badge--transport' }, kind)),
          card.version ? h('span', { className: 'mcpm-badge mcpm-badge--version' }, 'v' + card.version) : null,
          card.installedSlug ? h('span', { className: 'mcpm-badge mcpm-badge--installed' }, '已装') : null,
          state === 'unavailable' ? h('span', { className: 'mcpm-badge mcpm-badge--unavailable' }, '不可用') : null,
        ),
        h('div', { className: 'mcpm-card__actions' },
          h('button', {
            type: 'button',
            className: state === 'idle' || state === 'needs-config' ? 'mcpm-btn mcpm-btn--primary' : 'mcpm-btn',
            'data-state': state,
            disabled: state === 'unavailable',
            title: state === 'unavailable' ? card.unsupportedReason : card.name,
            onClick: action,
          }, CARD_ACTION[state]),
        ),
      );
    }

    /** The installed strip: the same card, plus a way out. */
    function InstalledCard(props) {
      const { item, busy, onUninstall } = props;
      const state = item.updateAvailable ? 'update' : 'installed';
      return h('article', { className: 'mcpm-card mcpm-card--installed', 'data-state': state },
        h('div', { className: avatarClassOf(item.registryName), 'aria-hidden': 'true' }, avatarLetterOf(item.registryTitle || item.registryName)),
        h('h3', { className: 'mcpm-card__name' }, item.registryTitle || item.registryName),
        h('p', { className: 'mcpm-card__desc' },
          item.kind === 'http' ? item.url : [item.command, ...(item.args || [])].join(' ')),
        h('div', { className: 'mcpm-card__badges' },
          h('span', { className: 'mcpm-badge mcpm-badge--kind' }, item.kind === 'http' ? 'remote' : item.registryType),
          h('span', { className: 'mcpm-badge mcpm-badge--state' }, STATE_LABEL[item.state] || item.state),
          item.toolCount === null || item.toolCount === undefined
            ? null
            : h('span', { className: 'mcpm-badge mcpm-badge--tools' }, '✓ ' + item.toolCount + ' 个工具'),
          item.updateAvailable
            ? h('span', { className: 'mcpm-badge mcpm-badge--update' }, '目录版本 v' + item.latestVersion)
            : null,
        ),
        h('div', { className: 'mcpm-card__actions' },
          h('button', {
            type: 'button',
            className: 'mcpm-btn',
            'data-state': 'installed',
            disabled: busy === item.slug,
            onClick: () => onUninstall(item),
          }, busy === item.slug ? '卸载中…' : '卸载'),
        ),
        item.error ? h('p', { className: 'mcpm-error' }, item.error) : null,
      );
    }

    /**
     * The market page: the whole body of the「MCP 市场」nav entry.
     *
     * Pagination is deliberate — the catalog holds thousands of entries and the page keeps
     * exact sorting and filtering, which virtual scrolling makes fragile.
     */
    function MarketPage() {
      const [status, setStatus] = React.useState(null);
      const [installed, setInstalled] = React.useState({ items: [], toolListing: false });
      const [query, setQuery] = React.useState('');
      const [kind, setKind] = React.useState('all');
      const [sort, setSort] = React.useState('relevance');
      const [page, setPage] = React.useState(0);
      const [results, setResults] = React.useState({ total: 0, results: [] });
      const [busy, setBusy] = React.useState('');
      const [error, setError] = React.useState('');
      const [dialog, setDialog] = React.useState('');
      const [hint, setHint] = React.useState('');

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
      const runSearch = React.useCallback(async (q, k, s, p) => {
        setBusy('search');
        try {
          setResults(await marketSearch(q, k, s, p * MARKET_PAGE_SIZE));
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      }, []);

      React.useEffect(() => {
        loadStatus();
        loadInstalled();
        runSearch('', 'all', 'relevance', 0);
      }, [loadStatus, loadInstalled, runSearch]);

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

      const apply = (nextKind, nextSort, nextPage) => {
        setKind(nextKind);
        setSort(nextSort);
        setPage(nextPage);
        runSearch(query, nextKind, nextSort, nextPage);
      };

      /**
       * Take the user from a card to the row's management view.
       *
       * The plugin page publishes `openBundle(pkg)`, which switches the left nav to the
       * Plugins panel and opens that bundle's page; when the profile does not mount it, a
       * line of text says where to go instead.
       */
      const openInstalled = (hit) => {
        const pkg = packageOfSlug(hit.installedSlug);
        const navigation = pluginNavigation();
        if (navigation !== null && typeof navigation.openBundle === 'function') {
          try {
            navigation.openBundle(pkg);
            setHint('');
            return;
          } catch (error) {
            setHint('打开管理页失败：' + String((error && error.message) || error));
            return;
          }
        }
        setHint('「' + (hit.title || hit.name) + '」已安装（组合包 ' + pkg + '）。改配置请到左侧「插件」→ dsh-plugin-mcp-manager 的 MCP 行。');
      };

      const uninstall = async (item) => {
        setBusy(item.slug);
        setError('');
        try {
          await marketUninstall(item.slug);
          await loadInstalled();
          await runSearch(query, kind, sort, page);
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy('');
        }
      };

      const pageCount = Math.max(1, Math.ceil(results.total / MARKET_PAGE_SIZE));
      // A runtime this machine lacks is the reason an entry reads 不可用, so it is marked
      // rather than buried in a sentence.
      const runtimeBits = status
        ? [['npx', status.runtimes.npx.available], ['uvx', status.runtimes.uvx.available], ['docker', status.runtimes.docker.available]]
        : [];

      return h('div', { className: 'mcpm-page' },
        h('div', { className: 'mcpm-toolbar' },
          h('input', {
            className: 'mcpm-search',
            placeholder: '搜索 MCP 服务器（名称 / 描述，本地搜索）',
            value: query,
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => { if (event.key === 'Enter') apply(kind, sort, 0); },
          }),
          h('div', { className: 'mcpm-filters' },
            [['all', '全部'], ['local', '本地'], ['remote', '远程']].map(([value, label]) =>
              h('button', {
                key: value,
                type: 'button',
                className: 'mcpm-chip',
                'data-active': kind === value ? 'true' : 'false',
                onClick: () => apply(value, sort, 0),
              }, label)),
          ),
          h('select', {
            className: 'mcpm-select',
            value: sort,
            onChange: (event) => apply(kind, event.target.value, 0),
          },
            h('option', { value: 'relevance' }, '相关度'),
            h('option', { value: 'newest' }, '最新上架'),
            h('option', { value: 'name' }, '名称'),
          ),
          h('button', { type: 'button', className: 'mcpm-btn', 'data-state': 'idle', onClick: () => apply(kind, sort, 0) },
            busy === 'search' ? '搜索中…' : '搜索'),
          h('button', { type: 'button', className: 'mcpm-btn', 'data-state': refreshing ? 'busy' : 'idle', disabled: refreshing, onClick: refresh },
            refreshing ? '刷新中…' : '刷新目录'),
        ),

        h('div', { className: 'mcpm-statusline' },
          status
            ? '目录：' + status.count + ' 个服务器 · 更新于 ' + ageText(status.ageMs) + (status.stale ? '（已过期，建议刷新）' : '') + ' · '
            : '读取目录状态…',
          runtimeBits.map(([name, available]) =>
            h('span', { key: name, 'data-ok': available ? 'yes' : 'no' }, name + (available ? ' 可用' : ' 缺失') + '  ')),
          status && status.source === 'none'
            ? h('div', null, '还没有本地快照，点「刷新目录」拉一次全量（约 100 秒，之后都是本地搜索）。')
            : null,
          refreshing
            ? h('div', null, '正在后台拉取：已 ' + status.refreshing.pages + ' 页 / ' + status.refreshing.rawEntries + ' 条，保留 ' + status.refreshing.kept + ' 个服务器。')
            : null,
          status && status.refreshing && status.refreshing.error
            ? h('div', { className: 'mcpm-error' }, '上次刷新失败：' + status.refreshing.error + '（继续使用本地快照）')
            : null,
        ),

        error ? h('div', { className: 'mcpm-error' }, error) : null,
        hint ? h('div', { className: 'mcpm-note' }, hint) : null,

        dialog !== ''
          ? h(InstallDialog, {
              name: dialog,
              onClose: () => setDialog(''),
              onDone: () => { loadInstalled(); loadStatus(); runSearch(query, kind, sort, page); },
            })
          : null,

        installed.items.length > 0
          ? h('section', { className: 'mcpm-section' },
              h('h2', { className: 'mcpm-result-title' }, '已安装（' + installed.items.length + '）'),
              h('div', { className: 'mcpm-grid' },
                installed.items.map((item) => h(InstalledCard, { key: item.slug, item, busy, onUninstall: uninstall })),
              ),
            )
          : null,

        h('section', { className: 'mcpm-section' },
          // Auxiliary information, so it stays smaller than the card names it labels.
          h('h2', { className: 'mcpm-result-title' },
            (query.trim() === '' ? '全部服务器' : '搜索结果') + '（' + results.total + '）'),
          results.results.length === 0
            ? h('p', { className: 'mcpm-empty' }, '没有匹配的条目。')
            : h('div', { className: 'mcpm-grid' },
                results.results.map((card) => h(MarketCard, {
                  key: card.name,
                  card,
                  onInstall: (hit) => { setHint(''); setDialog(hit.name); },
                  onOpenInstalled: openInstalled,
                  onUninstall: uninstall,
                })),
              ),
        ),

        h('div', { className: 'mcpm-pager' },
          h('button', { type: 'button', className: 'mcpm-btn', 'data-state': page === 0 ? 'unavailable' : 'idle', disabled: page === 0, onClick: () => apply(kind, sort, page - 1) }, '上一页'),
          h('span', { className: 'mcpm-note' }, '第 ' + (page + 1) + ' / ' + pageCount + ' 页 · 每页 ' + MARKET_PAGE_SIZE),
          h('button', { type: 'button', className: 'mcpm-btn', 'data-state': page + 1 >= pageCount ? 'unavailable' : 'idle', disabled: page + 1 >= pageCount, onClick: () => apply(kind, sort, page + 1) }, '下一页'),
        ),
      );
    }

    // ------------------------------------------------------------ market: install

    /** The argv of one plan, with unfilled argument slots shown as placeholders. */
    function argvOf(option, argumentValues) {
      const parts = [];
      for (const entry of option.argv || []) {
        if (entry.kind === 'literal') {
          parts.push(entry.value);
          continue;
        }
        const value = (argumentValues || {})[entry.name];
        parts.push(entry.name);
        parts.push(typeof value === 'string' && value !== '' ? value : '<需要填写>');
      }
      return parts;
    }

    /** One plan's command line or URL, as the confirmation dialog must show it verbatim. */
    function commandLineOf(option, argumentValues) {
      if (!option) return '';
      if (option.kind === 'http') return option.url;
      const quote = (part) => (/\s/.test(part) ? '"' + part + '"' : part);
      return [option.command, ...argvOf(option, argumentValues)].map(quote).join(' ');
    }

    /**
     * The install confirmation.
     *
     * Before anything runs the user sees the exact command or URL, where the entry came
     * from, which secrets it wants, and that values are written to the profile's patch file
     * in plain text. This is the *configuration* form — it belongs to installing, not to
     * browsing.
     */
    function InstallDialog(props) {
      const { name, onClose, onDone } = props;
      const [detail, setDetail] = React.useState(null);
      const [optionIndex, setOptionIndex] = React.useState(0);
      const [values, setValues] = React.useState({});
      const [argValues, setArgValues] = React.useState({});
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
            setArgValues((value.installed && value.installed.argumentValues) || {});
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
          const value = await marketInstall(name, optionIndex, values, argValues);
          setResult(value);
          if (onDone) onDone();
        } catch (e) {
          setError(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      };

      if (result !== null) {
        return h('div', { className: 'mcpm-dialog', 'data-state': 'installed' },
          h('div', { className: 'mcpm-card__badges' },
            h('span', { className: 'mcpm-badge mcpm-badge--installed' }, '已安装'),
            h('span', { className: 'mcpm-badge' }, result.pkg),
            result.reinstalled ? h('span', { className: 'mcpm-badge' }, '覆盖更新') : null,
          ),
          h('p', { className: 'mcpm-note' },
            'MCP 行已写进新组合包 ' + result.dir + '，serverName 为 ' + result.serverName + '。'),
          h('p', { className: 'mcpm-note' },
            '工具以 mcp__' + result.serverName + '__* 的名字提供给模型；改配置到左侧「插件」→ MCP 行。'),
          h('div', { className: 'mcpm-actions' },
            h('button', { type: 'button', className: 'mcpm-btn mcpm-btn--primary', 'data-state': 'idle', onClick: onClose }, '关闭'),
          ),
        );
      }

      return h('div', { className: 'mcpm-dialog' },
        h('div', { className: 'mcpm-card__badges' },
          h('span', { className: 'mcpm-card__name' }, detail ? detail.server.title : name),
          h('span', { className: 'mcpm-badge' }, name),
          detail && detail.server.version ? h('span', { className: 'mcpm-badge' }, 'v' + detail.server.version) : null,
          h('span', { className: 'mcpm-badge mcpm-badge--source' }, '来源：官方 MCP 注册表'),
        ),
        detail && detail.server.description ? h('p', { className: 'mcpm-note' }, detail.server.description) : null,
        !detail && !error ? h('p', { className: 'mcpm-note' }, '读取安装方式…') : null,
        error ? h('div', { className: 'mcpm-error' }, error) : null,

        detail && detail.options.length === 0
          ? h('div', { className: 'mcpm-error' }, '这个条目在这台机器上没有可用的安装方式：' +
              (detail.blocked || []).map((item) => item.registryType + '（' + item.reason + '）').join('；'))
          : null,

        detail && detail.options.length > 1
          ? h('div', null,
              h('div', { className: 'mcpm-note' }, '安装方式'),
              detail.options.map((item, index) => h('label', { key: item.label, className: 'mcpm-field' },
                h('input', { type: 'radio', checked: index === optionIndex, onChange: () => setOptionIndex(index) }),
                h('span', null, item.label),
              )),
            )
          : null,

        option
          ? h('div', null,
              h('div', { className: 'mcpm-note' }, option.kind === 'http' ? '将连接到的地址' : '将执行的命令'),
              h('pre', { className: 'mcpm-pre' }, commandLineOf(option, argValues)),
              h('div', { className: 'mcpm-note' }, '⚠️ ' + option.risk),
            )
          : null,

        option && (option.slots || []).length > 0
          ? h('div', null,
              h('div', { className: 'mcpm-note' }, '命令参数'),
              (option.slots || []).map((slot) => h('div', { key: slot.name, className: 'mcpm-field' },
                h('label', { className: 'mcpm-field__label' }, slot.name, slot.isRequired ? h('span', { className: 'mcpm-required' }, ' *') : null),
                h('input', {
                  type: 'text',
                  placeholder: slot.format || (slot.isRequired ? '必填' : '可留空'),
                  value: argValues[slot.name] === undefined ? '' : argValues[slot.name],
                  onChange: (event) => setArgValues((current) => ({ ...current, [slot.name]: event.target.value })),
                }),
              )),
            )
          : null,

        option && option.variables.length > 0
          ? h('div', null,
              h('div', { className: 'mcpm-note' }, '需要填写'),
              option.variables.map((variable) => h('div', { key: variable.name, className: 'mcpm-field' },
                h('label', { className: 'mcpm-field__label' }, variable.name, variable.isRequired ? h('span', { className: 'mcpm-required' }, ' *') : null),
                h('input', {
                  type: variable.isSecret ? 'password' : 'text',
                  placeholder: variable.default || (variable.isRequired ? '必填' : '可留空'),
                  value: values[variable.name] === undefined ? '' : values[variable.name],
                  onChange: (event) => setValues((current) => ({ ...current, [variable.name]: event.target.value })),
                }),
              )),
              h('div', { className: 'mcpm-note' },
                '这些值会写进 profile 的 cordis.patch.yml（明文）。',
                detail && detail.installed && (detail.installed.configKeys || []).length > 0
                  ? '已配置 ' + detail.installed.configKeys.join('、') + '，留空则保留原值。'
                  : ''),
            )
          : null,

        option && option.variables.length === 0 && (option.slots || []).length === 0
          ? h('div', { className: 'mcpm-note' }, '这个条目不需要填写任何配置。')
          : null,

        detail && (detail.blocked || []).length > 0
          ? h('div', { className: 'mcpm-note' }, '其它方式：' + detail.blocked.map((item) => item.registryType + '（' + item.reason + '）').join('；'))
          : null,

        option
          ? h('div', { className: 'mcpm-actions' },
              h('button', { type: 'button', className: 'mcpm-btn mcpm-btn--primary', 'data-state': busy ? 'busy' : 'idle', disabled: busy, onClick: install }, busy ? '安装中…' : '安装'),
              h('button', { type: 'button', className: 'mcpm-btn', 'data-state': 'idle', disabled: busy, onClick: onClose }, '取消'),
            )
          : null,
      );
    }

    // ---------------------------------------------------------------------- page

    function Panel() {
      const [state, setState] = React.useState({ status: 'loading', value: null, error: '' });
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

        h('div', { style: { ...S.muted, marginBottom: 10 } },
          '安装新的 MCP 服务器请到左侧导航的「MCP 市场」；这里管理已经装好的行。'),

        note ? h('div', { style: { ...S.muted, marginBottom: 8 } }, note) : null,

        state.error ? h('div', { style: S.err }, state.error) : null,

        state.status === 'ready' && !state.error && rows.length === 0
          ? h('div', { style: S.muted },
              '当前 profile 里没有 @deepseek-ai/dsh-mcp-client 行。去左侧「MCP 市场」装一个，或装一个 MCP 组合包后回到这里刷新。')
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

        // The market is its own page in the left navigation, not a tab inside the manager:
        // browsing and configuring are different jobs with different densities. Two slots
        // carry it — `sidebar.panellist` for the nav entry and `main` for the page body,
        // addressed by the same id. Both are declaration-aware, so registration order
        // against the sidebar does not matter.
        dock.ctx = ctx;
        ctx.effect(() => installMarketStyles());
        ctx.slots.inject('main', () => ctx.slots.inject('sidebar.panellist', () => {
          const stopMain = ctx.slots.register({ name: 'main', key: MARKET_PANEL_ID }, MarketPage);
          let stopIcon;
          try {
            stopIcon = ctx.slots.register({
              name: 'sidebar.panellist',
              id: MARKET_PANEL_ID,
              order: MARKET_PANEL_ORDER,
              label: () => 'MCP 市场',
            }, MarketIcon);
          } catch (error) {
            // A nav slot this shell refuses must cost the nav entry, never the boot: a
            // throw out of `apply()` fails the whole web boot.
            console.warn('[mcp-manager] nav entry rejected:', error);
            stopMain();
            return () => {};
          }
          return () => {
            stopIcon?.();
            stopMain();
          };
        }));
      },
    };
  },
});
