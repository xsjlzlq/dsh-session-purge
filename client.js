/**
 * Client half of the session-purge bundle.
 *
 * Renders one frame-wide context menu into `shell.overlay` and opens it when a
 * sidebar Session row is right-clicked. The row is located through its own
 * `data-row-key="session:<id>"` marker, so no shipped component, class name or
 * module is imported: the plugin only listens on the document and draws its own
 * surface with host theme tokens.
 *
 * The whole bundle is wrapped in an IIFE and every top-level statement ends
 * with a semicolon: several bundles are concatenated into one wire batch, so a
 * file that leaks a declaration or ends without a terminator breaks the batch
 * for every module after it.
 *
 * @module @local/dsh-session-purge/client
 */
;(function () {
  'use strict';

  window.__ModuleLoader__.load({
    id: '@local/dsh-session-purge',
    factory: function (require) {
      var react = require('react');
      var h = react.createElement;
      var Fragment = react.Fragment;
      var useState = react.useState;
      var useEffect = react.useEffect;
      var useCallback = react.useCallback;
      var useRef = react.useRef;

      var NAME = 'session-purge';
      var INJECT = ['slots', 'locale', 'sessions'];

      /** Locale namespace owned by this plugin. */
      var NS = 'sessionPurge';

      /** Host route registered by index.js. */
      var API = '/dsh-session-purge/api';

      /** Menu geometry, used only to keep the card inside the viewport. */
      var MENU_WIDTH = 248;
      var MENU_HEIGHT = 196;

      var ZH = {
        'menu.delete': '删除会话',
        'menu.deleteHint': '日志与缓存永久删除',
        'menu.reveal': '打开文件夹',
        'menu.revealHint': '进入该会话的工作目录',
        'menu.revealing': '正在打开…',
        'menu.cancel': '取消',
        'menu.confirmTitle': '确认删除该会话？',
        'menu.confirmBody': '会话日志、投影缓存和侧栏条目会被永久移除，无法恢复。',
        'menu.confirm': '永久删除',
        'menu.busy': '正在删除…',
        'menu.done': '已删除',
        'menu.partial': '已删除，但部分清理未完成',
        'menu.hideUngrouped': '隐藏未分组会话',
        'menu.hideUngroupedHint': '归位或归档',
        'menu.hiding': '正在处理…',
        'menu.hideResult': '已归位 {a} 个、隐藏 {b} 个',
        'menu.hideRemaining': '，仍有 {n} 个未分组',
        'menu.hideFailed': '隐藏失败',
        'group.ungrouped': '未分组',
        'group.hint': '没有归属工作区的会话',
        'menu.retry': '重试',
        'menu.failed': '删除失败',
        'menu.revealFailed': '打开文件夹失败'
      };

      var EN = {
        'menu.delete': 'Delete session',
        'menu.deleteHint': 'Logs and cache are removed for good',
        'menu.reveal': 'Open folder',
        'menu.revealHint': "Open this session's working directory",
        'menu.revealing': 'Opening…',
        'menu.cancel': 'Cancel',
        'menu.confirmTitle': 'Delete this session?',
        'menu.confirmBody': 'Its log, projection cache and sidebar entry are removed permanently. This cannot be undone.',
        'menu.confirm': 'Delete permanently',
        'menu.busy': 'Deleting…',
        'menu.done': 'Deleted',
        'menu.partial': 'Deleted, though part of the cleanup did not finish',
        'menu.hideUngrouped': 'Hide ungrouped sessions',
        'menu.hideUngroupedHint': 're-home or archive',
        'menu.hiding': 'Working…',
        'menu.hideResult': 'Re-homed {a}, hid {b}',
        'menu.hideRemaining': '; {n} still ungrouped',
        'menu.hideFailed': 'Hide failed',
        'group.ungrouped': 'Ungrouped',
        'group.hint': 'Sessions with no Workspace',
        'menu.retry': 'Retry',
        'menu.failed': 'Delete failed',
        'menu.revealFailed': 'Could not open the folder'
      };

      /** Client context captured at apply, used to re-pull the Session list. */
      var appCtx = null;

      var translate = function (key) {
        return key;
      };

      function t(key, fallback) {
        var value = translate(key);
        return typeof value === 'string' && value.length > 0 && value !== key ? value : (fallback || key);
      }

      /** Re-pull the Client's Session baseline so a removed row cannot linger. */
      function refreshSessionList() {
        try {
          var sessions = appCtx && typeof appCtx.get === 'function' ? appCtx.get('sessions') : undefined;
          if (sessions && typeof sessions.refresh === 'function') sessions.refresh();
        } catch (error) {
          /* a failed refresh leaves the archive-filtered view in place */
        }
      }

      function callApi(payload) {
        return fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload)
        }).then(function (response) {
          return response.json().catch(function () {
            return null;
          }).then(function (data) {
            if (data && data.ok === true) return data;
            var message = data && typeof data.error === 'string' && data.error.length > 0
              ? data.error
              : 'HTTP ' + response.status;
            throw new Error(message);
          });
        });
      }

      /** The Session id of the row containing `target`, if any. */
      function sessionRowOf(target) {
        if (!target || typeof target.closest !== 'function') return null;
        var row = target.closest('[data-row-key^="session:"]');
        if (!row) return null;
        var key = row.getAttribute('data-row-key') || '';
        var id = key.slice('session:'.length).trim();
        return id.length > 0 ? { row: row, id: id } : null;
      }

      /**
       * The Ungrouped group header containing `target`, if any. A real Workspace
       * keys its header as `workspace:<id>`; the Ungrouped bucket keys it as the
       * bare `workspace:` prefix, which is what this matcher recognises.
       */
      function ungroupedHeaderOf(target) {
        if (!target || typeof target.closest !== 'function') return null;
        var row = target.closest('[data-row-key^="workspace:"]');
        if (!row) return null;
        var key = row.getAttribute('data-row-key') || '';
        if (key.slice('workspace:'.length).trim().length > 0) return null;
        return row;
      }

      /** Best-effort row title for the menu header; the id is the fallback. */
      function titleOf(row, id) {
        try {
          var node = row.querySelector('[class*="title"]');
          var text = node && node.textContent ? String(node.textContent).trim() : '';
          if (text.length > 0) return text.length > 60 ? text.slice(0, 60) + '…' : text;
        } catch (error) {
          /* keep the id fallback */
        }
        return id.length > 12 ? id.slice(0, 12) + '…' : id;
      }

      var STYLES = {
        card: {
          position: 'fixed',
          zIndex: 2147483000,
          pointerEvents: 'auto',
          boxSizing: 'border-box',
          width: MENU_WIDTH,
          padding: '6px',
          borderRadius: 10,
          background: 'var(--dsw-alias-bg-overlay)',
          border: '1px solid var(--dsw-alias-border-l2)',
          boxShadow: '0 10px 28px rgba(0, 0, 0, 0.22)',
          color: 'var(--dsw-alias-label-primary)',
          font: '13px/20px system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
          userSelect: 'none'
        },
        header: {
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          padding: '6px 8px 8px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          marginBottom: 4
        },
        headerTitle: {
          fontSize: 13,
          fontWeight: 600,
          color: 'var(--dsw-alias-label-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        },
        headerMeta: {
          fontSize: 11,
          lineHeight: '16px',
          color: 'var(--dsw-alias-label-secondary)'
        },
        item: {
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '7px 8px',
          border: 'none',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          textAlign: 'left',
          cursor: 'pointer'
        },
        itemDanger: {
          color: 'var(--dsw-alias-state-error-primary)'
        },
        hint: {
          marginLeft: 'auto',
          fontSize: 11,
          color: 'var(--dsw-alias-label-secondary)'
        },
        body: {
          padding: '4px 8px 8px',
          fontSize: 12,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)'
        },
        row: {
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 8,
          padding: '4px 8px 6px'
        },
        button: {
          padding: '5px 10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 6,
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          font: 'inherit',
          cursor: 'pointer'
        },
        buttonDanger: {
          border: '1px solid var(--dsw-alias-state-error-primary)',
          color: 'var(--dsw-alias-state-error-primary)'
        },
        status: {
          padding: '6px 8px 8px',
          fontSize: 12,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-secondary)'
        }
      };

      function merge(base, extra) {
        var out = {};
        var key;
        for (key in base) if (Object.prototype.hasOwnProperty.call(base, key)) out[key] = base[key];
        for (key in extra) if (Object.prototype.hasOwnProperty.call(extra, key)) out[key] = extra[key];
        return out;
      }

      function hoverIn(event) {
        event.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)';
      }

      function hoverOut(event) {
        event.currentTarget.style.background = 'transparent';
      }

      /**
       * The context menu itself. It owns its listeners through one effect, so
       * unloading the plugin removes every document handler it added.
       */
      function SessionContextMenu() {
        var state = useState(null);
        var menu = state[0];
        var setMenu = state[1];
        var dismissTimer = useRef(null);

        var clearDismiss = useCallback(function () {
          if (dismissTimer.current !== null) {
            window.clearTimeout(dismissTimer.current);
            dismissTimer.current = null;
          }
        }, []);

        useEffect(function () {
          function onContextMenu(event) {
            var target = event.target;
            if (target && typeof target.closest === 'function' && target.closest('[data-session-purge-menu]')) {
              event.preventDefault();
              return;
            }
            var hit = sessionRowOf(target);
            var groupHit = hit ? null : ungroupedHeaderOf(target);
            if (!hit && !groupHit) {
              setMenu(null);
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            clearDismiss();
            var width = window.innerWidth || 0;
            var height = window.innerHeight || 0;
            var x = Math.max(8, Math.min(event.clientX, Math.max(8, width - MENU_WIDTH - 8)));
            var y = Math.max(8, Math.min(event.clientY, Math.max(8, height - MENU_HEIGHT - 8)));
            if (groupHit) {
              setMenu({
                kind: 'ungrouped',
                sessionId: '',
                title: t('group.ungrouped', 'Ungrouped'),
                x: x,
                y: y,
                phase: 'idle',
                action: 'hide',
                notice: '',
                message: ''
              });
              return;
            }
            setMenu({
              kind: 'session',
              sessionId: hit.id,
              title: titleOf(hit.row, hit.id),
              x: x,
              y: y,
              phase: 'idle',
              action: 'delete',
              notice: '',
              message: ''
            });
          }
          function onPointerDown(event) {
            var target = event.target;
            if (target && typeof target.closest === 'function' && target.closest('[data-session-purge-menu]')) return;
            setMenu(null);
          }
          function onKeyDown(event) {
            if (event.key === 'Escape') setMenu(null);
          }
          function onDismiss() {
            setMenu(null);
          }

          document.addEventListener('contextmenu', onContextMenu, true);
          document.addEventListener('pointerdown', onPointerDown, true);
          document.addEventListener('keydown', onKeyDown, true);
          window.addEventListener('blur', onDismiss);
          window.addEventListener('resize', onDismiss);
          return function () {
            document.removeEventListener('contextmenu', onContextMenu, true);
            document.removeEventListener('pointerdown', onPointerDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('blur', onDismiss);
            window.removeEventListener('resize', onDismiss);
            if (dismissTimer.current !== null) window.clearTimeout(dismissTimer.current);
          };
        }, [clearDismiss]);

        var runDelete = useCallback(function (sessionId) {
          clearDismiss();
          setMenu(function (current) {
            return current ? merge(current, { phase: 'busy', action: 'delete', message: '' }) : current;
          });
          callApi({ op: 'delete', sessionId: sessionId }).then(function (data) {
            // The Host evicts the resident Session, so the row is gone as soon as
            // the list refreshes; a warning means only a partial cleanup happened.
            var warnings = data && data.report && Array.isArray(data.report.warnings) ? data.report.warnings : [];
            var notice = warnings.length > 0 ? 'partial' : '';
            setMenu(function (current) {
              return current ? merge(current, { phase: 'done', message: '', notice: notice }) : current;
            });
            refreshSessionList();
            dismissTimer.current = window.setTimeout(function () {
              dismissTimer.current = null;
              setMenu(null);
            }, notice === 'partial' ? 3200 : 900);
          }).catch(function (error) {
            var message = error && error.message ? String(error.message) : String(error);
            setMenu(function (current) {
              return current ? merge(current, { phase: 'error', action: 'delete', message: message }) : current;
            });
          });
        }, [clearDismiss]);

        var runReveal = useCallback(function (sessionId) {
          clearDismiss();
          setMenu(function (current) {
            return current ? merge(current, { phase: 'busy', action: 'reveal', message: '' }) : current;
          });
          callApi({ op: 'reveal', sessionId: sessionId }).then(function () {
            setMenu(null);
          }).catch(function (error) {
            var message = error && error.message ? String(error.message) : String(error);
            setMenu(function (current) {
              return current ? merge(current, { phase: 'error', action: 'reveal', message: message }) : current;
            });
          });
        }, [clearDismiss]);

        var runHide = useCallback(function () {
          clearDismiss();
          setMenu(function (current) {
            return current ? merge(current, { phase: 'busy', action: 'hide', message: '' }) : current;
          });
          callApi({ op: 'hide-ungrouped' }).then(function (data) {
            var rehomed = Array.isArray(data.rehomed) ? data.rehomed.length : 0;
            var archived = Array.isArray(data.archived) ? data.archived.length : 0;
            var remaining = Array.isArray(data.remaining) ? data.remaining.length : 0;
            var message = t('menu.hideResult', '已归位 {a} 个、隐藏 {b} 个').replace('{a}', String(rehomed)).replace('{b}', String(archived));
            if (remaining > 0) message += t('menu.hideRemaining', '，仍有 {n} 个未分组').replace('{n}', String(remaining));
            setMenu(function (current) {
              return current ? merge(current, { phase: 'done', action: 'hide', message: message, notice: '' }) : current;
            });
            refreshSessionList();
            dismissTimer.current = window.setTimeout(function () {
              dismissTimer.current = null;
              setMenu(null);
            }, 2600);
          }).catch(function (error) {
            var message = error && error.message ? String(error.message) : String(error);
            setMenu(function (current) {
              return current ? merge(current, { phase: 'error', action: 'hide', message: message }) : current;
            });
          });
        }, [clearDismiss]);

        if (!menu) return null;

        var header = h('div', { style: STYLES.header }, [
          h('div', { key: 'title', style: STYLES.headerTitle, title: menu.title }, menu.title),
          menu.sessionId
            ? h('div', { key: 'meta', style: STYLES.headerMeta }, menu.sessionId)
            : h('div', { key: 'meta', style: STYLES.headerMeta }, t('group.hint', '没有归属工作区的会话'))
        ]);

        var body = null;

        if (menu.kind === 'ungrouped') {
          if (menu.phase === 'idle') {
            body = h('button', {
              type: 'button',
              role: 'menuitem',
              style: STYLES.item,
              onMouseEnter: hoverIn,
              onMouseLeave: hoverOut,
              onClick: runHide
            }, [
              h('span', { key: 'label' }, t('menu.hideUngrouped', '隐藏未分组会话')),
              h('span', { key: 'hint', style: STYLES.hint }, t('menu.hideUngroupedHint', '归位或归档'))
            ]);
          } else if (menu.phase === 'busy') {
            body = h('div', { style: STYLES.status }, t('menu.hiding', '正在处理…'));
          } else if (menu.phase === 'done') {
            body = h('div', {
              style: merge(STYLES.status, { color: 'var(--dsw-alias-state-success-primary)' })
            }, menu.message);
          } else {
            body = h(Fragment, null, [
              h('div', {
                key: 'msg',
                style: merge(STYLES.status, { color: 'var(--dsw-alias-state-error-primary)' })
              }, [
                h('div', { key: 'label', style: { fontWeight: 600 } }, t('menu.hideFailed', '隐藏失败')),
                h('div', { key: 'text' }, menu.message)
              ]),
              h('div', { key: 'row', style: STYLES.row }, [
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  style: STYLES.button,
                  onClick: function () {
                    setMenu(null);
                  }
                }, t('menu.cancel', 'Cancel')),
                h('button', {
                  key: 'retry',
                  type: 'button',
                  style: merge(STYLES.button, STYLES.buttonDanger),
                  onClick: runHide
                }, t('menu.retry', 'Retry'))
              ])
            ]);
          }
        } else if (menu.phase === 'idle') {
          body = h(Fragment, null, [
            h('button', {
              key: 'delete',
              type: 'button',
              role: 'menuitem',
              style: merge(STYLES.item, STYLES.itemDanger),
              onMouseEnter: hoverIn,
              onMouseLeave: hoverOut,
              onClick: function () {
                setMenu(function (current) {
                  return current ? merge(current, { phase: 'confirm', action: 'delete' }) : current;
                });
              }
            }, [
              h('span', { key: 'label' }, t('menu.delete', 'Delete session')),
              h('span', { key: 'hint', style: STYLES.hint }, t('menu.deleteHint', 'permanent'))
            ]),
            h('button', {
              key: 'reveal',
              type: 'button',
              role: 'menuitem',
              style: STYLES.item,
              onMouseEnter: hoverIn,
              onMouseLeave: hoverOut,
              onClick: function () {
                runReveal(menu.sessionId);
              }
            }, [
              h('span', { key: 'label' }, t('menu.reveal', 'Open folder')),
              h('span', { key: 'hint', style: STYLES.hint }, t('menu.revealHint', 'working directory'))
            ])
          ]);
        } else if (menu.phase === 'confirm') {
          body = h(Fragment, null, [
            h('div', { key: 'body', style: STYLES.body }, [
              h('div', {
                key: 't',
                style: { color: 'var(--dsw-alias-label-primary)', fontWeight: 600, marginBottom: 2 }
              }, t('menu.confirmTitle', 'Delete this session?')),
              h('div', { key: 'b' }, t('menu.confirmBody', 'This cannot be undone.'))
            ]),
            h('div', { key: 'row', style: STYLES.row }, [
              h('button', {
                key: 'cancel',
                type: 'button',
                style: STYLES.button,
                onClick: function () {
                  setMenu(null);
                }
              }, t('menu.cancel', 'Cancel')),
              h('button', {
                key: 'ok',
                type: 'button',
                style: merge(STYLES.button, STYLES.buttonDanger),
                onClick: function () {
                  runDelete(menu.sessionId);
                }
              }, t('menu.confirm', 'Delete'))
            ])
          ]);
        } else if (menu.phase === 'busy') {
          body = h('div', { style: STYLES.status },
            menu.action === 'reveal' ? t('menu.revealing', 'Opening…') : t('menu.busy', 'Deleting…'));
        } else if (menu.phase === 'done') {
          var notice = menu.notice;
          var label = notice === 'partial'
            ? t('menu.partial', '已删除，但部分清理未完成')
            : t('menu.done', 'Deleted');
          body = h(Fragment, null, [
            h('div', {
              key: 'msg',
              style: merge(STYLES.status, { color: 'var(--dsw-alias-state-success-primary)' })
            }, label)
          ]);
        } else {
          var revealing = menu.action === 'reveal';
          body = h(Fragment, null, [
            h('div', {
              key: 'msg',
              style: merge(STYLES.status, { color: 'var(--dsw-alias-state-error-primary)' })
            }, [
              h('div', { key: 'label', style: { fontWeight: 600 } },
                revealing ? t('menu.revealFailed', 'Could not open the folder') : t('menu.failed', 'Delete failed')),
              h('div', { key: 'text' }, menu.message)
            ]),
            h('div', { key: 'row', style: STYLES.row }, [
              h('button', {
                key: 'cancel',
                type: 'button',
                style: STYLES.button,
                onClick: function () {
                  setMenu(null);
                }
              }, t('menu.cancel', 'Cancel')),
              h('button', {
                key: 'retry',
                type: 'button',
                style: merge(STYLES.button, STYLES.buttonDanger),
                onClick: function () {
                  if (revealing) runReveal(menu.sessionId);
                  else runDelete(menu.sessionId);
                }
              }, t('menu.retry', 'Retry'))
            ])
          ]);
        }

        return h('div', {
          'data-session-purge-menu': '',
          role: 'menu',
          style: merge(STYLES.card, { left: menu.x, top: menu.y })
        }, [header, body]);
      }

      function apply(ctx) {
        appCtx = ctx;
        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: ZH, en: EN });
        }, 'session-purge: dictionaries');
        translate = ctx.locale.bind(NS);
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({
            name: 'shell.overlay',
            id: 'session-purge-menu',
            order: 60
          }, SessionContextMenu);
        });
      }

      return {
        name: NAME,
        inject: INJECT,
        apply: apply
      };
    }
  });
})();
