/**
 * Hộp thoại vẽ trong trang thay cho alert / confirm / prompt của trình duyệt
 * (một số trình duyệt nhúng – vd khung xem trong app – chặn các hộp thoại gốc).
 *   uiAlert(msg)                         → Promise<void>
 *   uiConfirm(msg, { ok, cancel, danger }) → Promise<boolean>
 *   uiPrompt(msg, { type, value, placeholder, readOnly }) → Promise<string|null>
 * Các hộp mở cùng lúc được xếp hàng, hiện lần lượt.
 */
(function () {
  const css = `
.ui-dlg-backdrop{position:fixed;inset:0;background:rgba(2,6,23,.6);display:flex;align-items:center;justify-content:center;z-index:100000;padding:16px}
.ui-dlg{background:#fff;color:#0f172a;border-radius:14px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.35);padding:18px 18px 14px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.ui-dlg-msg{white-space:pre-wrap;word-break:break-word;margin:0 0 12px;max-height:50vh;overflow:auto}
.ui-dlg input,.ui-dlg textarea{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #cbd5e1;border-radius:9px;font:inherit;margin-bottom:12px;color:#0f172a;background:#fff}
.ui-dlg-actions{display:flex;justify-content:flex-end;gap:8px}
.ui-dlg button{border:0;border-radius:9px;padding:8px 16px;font:600 14px system-ui,sans-serif;cursor:pointer}
.ui-dlg .ui-ok{background:#f97316;color:#fff}.ui-dlg .ui-ok.danger{background:#dc2626}
.ui-dlg .ui-cancel{background:#e2e8f0;color:#0f172a}
@media (prefers-color-scheme:dark){.ui-dlg{background:#0f172a;color:#e2e8f0}.ui-dlg input,.ui-dlg textarea{background:#1e293b;color:#e2e8f0;border-color:#334155}.ui-dlg .ui-cancel{background:#334155;color:#e2e8f0}}`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  let queue = Promise.resolve();

  function open(kind, message, opts = {}) {
    const run = () => new Promise(resolve => {
      const back = document.createElement('div');
      back.className = 'ui-dlg-backdrop';
      back.setAttribute('role', 'dialog');
      back.setAttribute('aria-modal', 'true');
      const box = document.createElement('div');
      box.className = 'ui-dlg';
      const msg = document.createElement('p');
      msg.className = 'ui-dlg-msg';
      msg.textContent = String(message ?? '');
      box.appendChild(msg);

      let input = null;
      if (kind === 'prompt') {
        input = document.createElement(opts.readOnly && String(opts.value || '').includes('\n') ? 'textarea' : 'input');
        if (input.tagName === 'INPUT') input.type = opts.type || 'text';
        else input.rows = 5;
        input.value = opts.value || '';
        input.placeholder = opts.placeholder || '';
        input.readOnly = !!opts.readOnly;
        input.autocomplete = opts.type === 'password' ? 'current-password' : 'off';
        box.appendChild(input);
      }

      const actions = document.createElement('div');
      actions.className = 'ui-dlg-actions';
      const done = value => {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(value);
      };
      if (kind !== 'alert' && !opts.readOnly) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'ui-cancel';
        cancel.textContent = opts.cancel || 'Huỷ';
        cancel.onclick = () => done(kind === 'confirm' ? false : null);
        actions.appendChild(cancel);
      }
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'ui-ok' + (opts.danger ? ' danger' : '');
      ok.textContent = opts.ok || (opts.readOnly ? 'Đóng' : 'OK');
      ok.onclick = () => done(kind === 'confirm' ? true : kind === 'prompt' && !opts.readOnly ? input.value : undefined);
      actions.appendChild(ok);
      box.appendChild(actions);

      const onKey = e => {
        if (e.key === 'Escape') { e.preventDefault(); done(kind === 'confirm' ? false : kind === 'prompt' ? null : undefined); }
        else if (e.key === 'Enter' && (!input || input.tagName === 'INPUT')) { e.preventDefault(); ok.click(); }
      };
      document.addEventListener('keydown', onKey, true);
      back.appendChild(box);
      document.body.appendChild(back);
      (input && !opts.readOnly ? input : ok).focus();
      if (input && opts.readOnly) input.select();
    });
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  window.uiAlert = (message, opts) => open('alert', message, opts);
  window.uiConfirm = (message, opts) => open('confirm', message, opts);
  window.uiPrompt = (message, opts) => open('prompt', message, opts);
})();
