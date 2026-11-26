import { escapeHtml } from '/js/utils.js';

function mountDialog({ title, message = '', label = '', value = '', inputType = 'text', confirmLabel = 'Continue', showInput = false }) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.style.cssText = 'position:fixed;inset:0;z-index:109999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(15,23,42,.62);backdrop-filter:blur(4px);';
    const input = showInput
      ? `<div class="form-group" style="margin:14px 0 18px;"><label class="form-label" for="lumina-voice-dialog-input">${escapeHtml(label)}</label><input id="lumina-voice-dialog-input" class="form-input" type="${inputType}" data-voice-name="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" value="${escapeHtml(value)}" autofocus></div>`
      : '';
    root.innerHTML = `<section class="modal card" role="dialog" aria-modal="true" aria-labelledby="lumina-voice-dialog-title" style="width:min(100%,520px);padding:22px;border-radius:16px;background:var(--surface,#fff);">
      <h3 id="lumina-voice-dialog-title" style="margin:0 0 8px;font-size:1.05rem;">${escapeHtml(title)}</h3>
      ${message ? `<p style="margin:0;color:var(--text-secondary,#475569);line-height:1.5;">${escapeHtml(message)}</p>` : ''}
      ${input}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:16px;">
        <button type="button" class="btn btn-secondary" data-voice-dialog-cancel data-voice-name="Cancel" data-voice-confirm="false" aria-label="Cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-voice-dialog-confirm data-voice-name="${escapeHtml(confirmLabel)}" data-voice-confirm="false" aria-label="${escapeHtml(confirmLabel)}">${escapeHtml(confirmLabel)}</button>
      </div>
    </section>`;
    document.body.appendChild(root);
    let finished = false;
    const finish = result => {
      if (finished) return;
      finished = true;
      root.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
      resolve(result);
    };
    root.querySelector('[data-voice-dialog-cancel]')?.addEventListener('click', () => finish(null));
    root.querySelector('[data-voice-dialog-confirm]')?.addEventListener('click', () => {
      finish(showInput ? root.querySelector('#lumina-voice-dialog-input')?.value ?? '' : true);
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') finish(null);
      if (event.key === 'Enter' && showInput && inputType !== 'textarea') {
        event.preventDefault();
        root.querySelector('[data-voice-dialog-confirm]')?.click();
      }
    });
    const inputElement = root.querySelector('#lumina-voice-dialog-input');
    if (inputElement) {
      inputElement.focus();
      inputElement.select?.();
    } else root.querySelector('[data-voice-dialog-confirm]')?.focus();
  });
}

export function confirmVoiceAction(message, confirmLabel = 'Confirm action') {
  return mountDialog({ title: 'Confirm this action', message, confirmLabel }).then(Boolean);
}

export function requestVoiceInput({ title, label, value = '', inputType = 'text', confirmLabel = 'Continue' }) {
  return mountDialog({ title, label, value, inputType, confirmLabel, showInput: true });
}
