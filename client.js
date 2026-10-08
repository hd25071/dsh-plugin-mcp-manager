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

      return h('div', { style: S.page },
        h('div', { style: S.head },
          h('div', { style: S.title }, 'MCP 管理器'),
          h('div', { style: S.muted },
            state.status === 'loading' ? '读取中…'
              : rows.length + ' 条 MCP 行' + (value && value.source ? '（来源：' + value.source + '）' : '')),
          h('button', { style: S.btn, onClick: load }, '刷新'),
        ),

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
