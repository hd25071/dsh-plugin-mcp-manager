/**
 * Browser half of dsh-plugin-mcp-manager.
 *
 * Registers the manager view on this bundle's own page in the DSH Plugins page.
 * Plain JS on purpose: no build step, no import of any Harness Client package, and
 * styling through host theme variables only, so a DSH upgrade degrades the look
 * rather than breaking the page.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-mcp-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const BUNDLE = 'dsh-plugin-mcp-manager';

    function Panel() {
      return h(
        'div',
        { style: { padding: '4px 0', color: 'var(--dsw-alias-text-secondary, inherit)' } },
        h('div', { style: { fontWeight: 600, marginBottom: 6, color: 'var(--dsw-alias-text-primary, inherit)' } },
          'MCP 管理器'),
        h('div', null, '正在接线：总览、配置编辑与调用记录。'),
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
