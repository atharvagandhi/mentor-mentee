import { getUserProfile } from '/js/auth.js';

const VOICE_CONTAINER_ID = 'lumina-voice-assistant';
const LANGUAGE_MAP = { en: 'en-IN', hi: 'hi-IN', mr: 'mr-IN' };
const NUMBER_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100
};
const DESTRUCTIVE_ACTION = /\b(approve|reject|delete|remove|cancel|end meeting|end call|leave meeting|resolve|escalate|publish|import|assign|send|submit|sign out|log out|mute all|disable cameras|kick|deny|admit)\b/i;
const VOICEABLE_SELECTOR = 'button:not([disabled]), a[href], [role="button"], [role="tab"], [onclick], [data-action], label[data-voice-name], input[type="file"]:not([disabled]), input[type="button"]:not([disabled]), input[type="submit"]:not([disabled]), input[type="reset"]:not([disabled]), input[type="checkbox"]:not([disabled]), input[type="radio"]:not([disabled]), summary, select:not([disabled])';

function numberFromSpeech(value) {
  const tokens = value.toLowerCase().replace(/-/g, ' ').replace(/\b(and|percent|percentage)\b/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every(token => /^\d+(\.\d+)?$/.test(token) || Object.hasOwn(NUMBER_WORDS, token))) return null;
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    if (/^\d+(\.\d+)?$/.test(token)) current += Number(token);
    else if (NUMBER_WORDS[token] === 100) current = Math.max(1, current) * 100;
    else current += NUMBER_WORDS[token];
  }
  total += current;
  return Number.isFinite(total) ? String(total) : null;
}

class VoiceAssistant {
  constructor() {
    this.container = null;
    this.recognition = null;
    this.lastFocusedElement = null;
    this.isListening = false;
    this.voiceSessionActive = false;
    this.isSpeaking = false;
    this.speechMutedUntil = 0;
    this.speakNextAIResponse = false;
    this.pendingAction = null;
    this.bound = false;
  }

  mount() {
    if (document.getElementById(VOICE_CONTAINER_ID)) {
      this.container = document.getElementById(VOICE_CONTAINER_ID);
      return;
    }

    const container = document.createElement('section');
    container.id = VOICE_CONTAINER_ID;
    container.innerHTML = `
      <button type="button" class="lumina-voice-launcher" data-voice-toggle aria-label="Open voice assistant" aria-expanded="false">
        <i class="ph ph-microphone" aria-hidden="true"></i><span>Voice</span>
      </button>
      <div class="lumina-voice-panel" data-voice-panel hidden aria-label="Voice assistant">
        <div class="lumina-voice-heading"><div><strong>Voice assistant</strong><p>Speak a page name, a button or link label, “fill [field] with [text]”, or ask a question.</p></div><button type="button" data-voice-close aria-label="Close voice assistant">×</button></div>
        <div class="lumina-voice-actions">
          <button type="button" class="btn btn-primary" data-voice-listen><i class="ph ph-microphone"></i> Start speaking</button>
          <button type="button" class="btn btn-secondary" data-voice-read><i class="ph ph-speaker-high"></i> Read this page</button>
          <button type="button" class="btn btn-ghost" data-voice-stop><i class="ph ph-stop"></i> Stop</button>
        </div>
        <p class="lumina-voice-status" data-voice-status role="status" aria-live="polite">Press the microphone, then say “open meetings”, “click save”, or “fill topic with exam planning”.</p>
        <p class="lumina-voice-transcript" data-voice-transcript hidden></p>
      </div>`;
    document.body.appendChild(container);
    this.container = container;
    this.bindEvents();
  }

  bindEvents() {
    if (this.bound || !this.container) return;
    this.bound = true;
    this.container.querySelector('[data-voice-toggle]')?.addEventListener('click', () => this.togglePanel());
    this.container.querySelector('[data-voice-close]')?.addEventListener('click', () => this.togglePanel(false));
    this.container.querySelector('[data-voice-listen]')?.addEventListener('click', () => this.startListening());
    this.container.querySelector('[data-voice-read]')?.addEventListener('click', () => this.readPage());
    this.container.querySelector('[data-voice-stop]')?.addEventListener('click', () => this.stopAll());

    document.addEventListener('focusin', event => {
      if (this.isEditable(event.target) && !this.container?.contains(event.target)) this.lastFocusedElement = event.target;
    });
    window.addEventListener('lumina:ai-response', event => {
      if (!this.speakNextAIResponse) return;
      this.speakNextAIResponse = false;
      this.speak(event.detail?.text || 'I could not produce a response.');
    });
    window.addEventListener('lumina:ai-opened', () => this.togglePanel(false));
    window.addEventListener('lumina:speak-text', event => this.speak(event.detail?.text || ''));
  }

  togglePanel(force = null) {
    const panel = this.container?.querySelector('[data-voice-panel]');
    const launcher = this.container?.querySelector('[data-voice-toggle]');
    if (!panel || !launcher) return;
    const open = force === null ? panel.hidden : force;
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      window.dispatchEvent(new CustomEvent('lumina:voice-opened'));
      this.setStatus(this.getRecognition() ? 'Say a page name, button or link label, “fill [field] with [text]”, or ask a question.' : 'Voice input is unavailable in this browser. Read aloud is still available.');
    }
  }

  setStatus(message, state = 'info') {
    const status = this.container?.querySelector('[data-voice-status]');
    if (status) {
      status.textContent = message;
      status.dataset.state = state;
    }
  }

  setTranscript(text) {
    const output = this.container?.querySelector('[data-voice-transcript]');
    if (!output) return;
    output.textContent = text;
    output.hidden = !text;
  }

  language() {
    let locale = 'en';
    try { locale = localStorage.getItem('lumina_locale') || 'en'; } catch (_) {}
    return LANGUAGE_MAP[locale] || 'en-IN';
  }

  getRecognition() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  startListening(resume = false) {
    const SpeechRecognition = this.getRecognition();
    if (!SpeechRecognition) {
      this.setStatus('Voice input is not supported by this browser. Try Chrome or Edge.', 'error');
      return;
    }
    if (!resume) {
      this.voiceSessionActive = true;
      this.stopSpeech();
    }
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onerror = null;
      try { this.recognition.abort(); } catch (_) {}
    }
    const recognition = new SpeechRecognition();
    this.recognition = recognition;
    recognition.lang = this.language();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      this.isListening = true;
      this.container?.classList.add('is-listening');
      this.container?.querySelector('[data-voice-listen]')?.setAttribute('aria-pressed', 'true');
      this.setStatus('Listening… speak now.');
    };
    recognition.onresult = event => {
      let finalText = '';
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const phrase = event.results[index][0]?.transcript || '';
        if (event.results[index].isFinal) finalText += phrase;
        else interimText += phrase;
      }
      if (interimText) this.setTranscript(interimText.trim());
      if (finalText.trim()) {
        if (this.isSpeaking || Date.now() < this.speechMutedUntil) return;
        const text = finalText.trim();
        this.setTranscript(text);
        this.handleTranscript(text);
      }
    };
    recognition.onerror = event => {
      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone access is blocked. Allow it in your browser settings, then try again.'
        : event.error === 'no-speech' ? 'No speech detected. Press the microphone and try again.'
          : 'Voice input stopped. Press the microphone to try again.';
      this.setStatus(message, 'error');
      if (event.error !== 'no-speech') this.voiceSessionActive = false;
    };
    recognition.onend = () => {
      this.isListening = false;
      this.container?.classList.remove('is-listening');
      this.container?.querySelector('[data-voice-listen]')?.setAttribute('aria-pressed', 'false');
      if (this.voiceSessionActive && this.container?.isConnected) {
        this.setStatus('Still listening. Say “stop” to pause voice control.');
        setTimeout(() => {
          if (this.voiceSessionActive && this.container?.isConnected && this.recognition === recognition) this.startListening(true);
        }, 250);
      } else if (this.container?.isConnected && this.container.querySelector('[data-voice-status]')?.textContent === 'Listening… speak now.') {
        this.setStatus('Ready. Press the microphone when you want to speak.');
      }
    };
    this.setTranscript('');
    try { recognition.start(); }
    catch (_) { this.setStatus('Voice input is already active. Wait a moment and try again.', 'error'); }
  }

  isEditable(element) {
    if (!(element instanceof HTMLElement) || element.isContentEditable) return Boolean(element?.isContentEditable);
    if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
    if (element instanceof HTMLSelectElement) return !element.disabled;
    if (!(element instanceof HTMLInputElement) || element.disabled || element.readOnly) return false;
    return ['text', 'search', 'tel', 'email', 'url', 'number', 'date', 'time', 'datetime-local', 'range', 'checkbox', 'radio'].includes((element.type || 'text').toLowerCase());
  }

  getDictationTarget() {
    const active = document.activeElement;
    if (this.isEditable(active) && this.isVisible(active) && !this.container?.contains(active)) return active;
    return this.lastFocusedElement?.isConnected && this.isVisible(this.lastFocusedElement) && this.isEditable(this.lastFocusedElement) ? this.lastFocusedElement : null;
  }

  insertText(target, text) {
    if (target instanceof HTMLSelectElement) {
      const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const options = Array.from(target.options).filter(option => !option.disabled && option.value);
      const matched = options.find(option => option.textContent.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === normalized)
        || options.find(option => option.textContent.toLowerCase().includes(normalized) || normalized.includes(option.textContent.toLowerCase()));
      if (!matched) {
        this.setStatus(`No option matched “${text}”. Say the option name and try again.`, 'error');
        return;
      }
      target.value = matched.value;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus(`Selected ${matched.textContent.trim()}.`);
      return;
    }
    if (target instanceof HTMLInputElement && ['checkbox', 'radio'].includes(target.type)) {
      const answer = text.toLowerCase();
      if (/\b(no|uncheck|disable|off)\b/.test(answer)) target.checked = false;
      else if (/\b(yes|check|enable|on)\b/.test(answer)) target.checked = true;
      else {
        this.setStatus('Say “check” or “uncheck” for this control.', 'error');
        return;
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus(target.checked ? 'Checked.' : 'Unchecked.');
      return;
    }
    if (target instanceof HTMLInputElement && ['number', 'range'].includes(target.type)) {
      const number = numberFromSpeech(text);
      if (number === null) {
        this.setStatus('Say a number, then try again.', 'error');
        return;
      }
      target.value = number;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus(`Entered ${number}.`);
      return;
    }
    if (target instanceof HTMLInputElement && ['date', 'datetime-local', 'time'].includes(target.type)) {
      const direct = text.trim();
      let date;
      target.value = '';
      if (target.type === 'time') {
        const time = direct.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (time) {
          let hours = Number(time[1]);
          const minutes = Number(time[2] || 0);
          if (time[3]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
          if (time[3]?.toLowerCase() === 'am' && hours === 12) hours = 0;
          if (hours < 24 && minutes < 60) target.value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        }
      } else if (target.type === 'datetime-local') {
        const parsed = direct.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
        if (parsed) {
          let hours = Number(parsed[2]);
          const minutes = Number(parsed[3] || 0);
          if (parsed[4]?.toLowerCase() === 'pm' && hours < 12) hours += 12;
          if (parsed[4]?.toLowerCase() === 'am' && hours === 12) hours = 0;
          if (hours < 24 && minutes < 60) target.value = `${parsed[1]}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
        }
        if (!target.value) {
          date = new Date(direct);
          if (!Number.isNaN(date.getTime())) target.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
        }
      } else {
        date = /^\d{4}-\d{2}-\d{2}$/.test(direct) ? new Date(`${direct}T00:00:00`) : new Date(direct);
        if (!Number.isNaN(date.getTime())) target.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      }
      if (!target.value) {
        this.setStatus(target.type === 'time' ? 'Say a time such as “3:30 PM”.' : 'Say a date such as “March 20 2026”; include a time for a date and time field.', 'error');
        return;
      }
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus(`Entered ${target.value}.`);
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'email') {
      text = text.toLowerCase().replace(/\s+at\s+/g, '@').replace(/\s+dot\s+/g, '.').replace(/\s+/g, '');
    } else if (target instanceof HTMLInputElement && target.type === 'tel') {
      const digitWords = { zero: '0', oh: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };
      text = text.toLowerCase().replace(/\bplus\b/g, '+').replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, word => digitWords[word]).replace(/[\s-]+/g, '');
    }
    target.focus();
    if (target.isContentEditable) {
      const selection = window.getSelection();
      if (selection?.rangeCount) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        range.insertNode(document.createTextNode(text));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else target.append(document.createTextNode(text));
    } else {
      let start = target.value.length;
      let end = start;
      try {
        if (Number.isInteger(target.selectionStart)) start = target.selectionStart;
        if (Number.isInteger(target.selectionEnd)) end = target.selectionEnd;
      } catch (_) {}
      try { target.setRangeText(text, start, end, 'end'); }
      catch (_) { target.value += `${target.value ? ' ' : ''}${text}`; }
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    if (target.id === 'lumina-ai-input-textarea') {
      this.speakNextAIResponse = true;
      document.getElementById('lumina-ai-input-form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
    this.setStatus('Dictation added to the focused field.');
    this.announce('Text entered.');
  }

  normalizeForMatch(value) {
    return String(value || '').normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase()
      .replace(/[^\p{L}\p{N}@]+/gu, ' ').trim();
  }

  isVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected || element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }

  voiceScope() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"]'))
      .filter(dialog => this.isVisible(dialog));
    return dialogs[dialogs.length - 1] || document;
  }

  controlName(element) {
    const ownName = this.primaryControlName(element);
    const context = element.closest('tr, [role="row"], [data-voice-context], .participant-item, .rpt-student-row, .notification-item, .student-row')?.innerText || '';
    return `${ownName} ${context}`.replace(/\s+/g, ' ').trim();
  }

  primaryControlName(element) {
    const labels = Array.from(element.labels || []).map(label => label.innerText || label.textContent || '').join(' ');
    return element.getAttribute('data-voice-name') || element.getAttribute('aria-label')
      || element.getAttribute('title') || element.innerText || element.value || labels || element.id || '';
  }

  queryWords(value) {
    const ignored = new Set(['the', 'a', 'an', 'button', 'link', 'tab', 'menu', 'item', 'option', 'please', 'for', 'to', 'on', 'in', 'me', 'my', 'this']);
    return this.normalizeForMatch(value).split(' ').filter(word => word && !ignored.has(word));
  }

  findNamedControls(query, selector = VOICEABLE_SELECTOR) {
    const words = this.queryWords(query);
    if (!words.length) return [];
    return Array.from(this.voiceScope().querySelectorAll(selector))
      .filter(element => this.isVisible(element) && !element.disabled)
      .map(element => ({ element, name: this.controlName(element), normalized: this.normalizeForMatch(this.controlName(element)) }))
      .filter(item => {
        const normalizedQuery = this.normalizeForMatch(query);
        return item.normalized.includes(normalizedQuery) || words.every(word => item.normalized.includes(word));
      });
  }

  fieldName(element) {
    const labels = Array.from(element.labels || []).map(label => label.innerText || label.textContent || '').join(' ');
    const groupLabel = element.closest('.form-group, .field, label')?.querySelector('label')?.innerText || '';
    const context = element.closest('tr, [role="row"], [data-voice-context]')?.innerText || '';
    return [element.getAttribute('data-voice-name'), element.getAttribute('aria-label'), labels, groupLabel,
      element.getAttribute('placeholder'), element.getAttribute('name'), element.id, context].filter(Boolean).join(' ');
  }

  findNamedFields(query) {
    const words = this.queryWords(query);
    const normalizedQuery = this.normalizeForMatch(query);
    if (!words.length) return [];
    return Array.from(this.voiceScope().querySelectorAll('input:not([type="hidden"]):not([type="password"]):not([type="file"]), textarea, select, [contenteditable="true"]'))
      .filter(element => this.isVisible(element) && !element.disabled && !element.readOnly)
      .map(element => ({ element, normalized: this.normalizeForMatch(this.fieldName(element)) }))
      .filter(item => item.normalized.includes(normalizedQuery) || words.every(word => item.normalized.includes(word)));
  }

  parseOrdinal(query) {
    const match = query.match(/\s+(?:number\s+)?(\d+|first|second|third|fourth|fifth)$/i);
    if (!match) return { query, index: null };
    const ordinal = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }[match[1].toLowerCase()];
    const index = ordinal || Number(match[1]);
    return { query: query.slice(0, match.index).trim(), index: index > 0 ? index - 1 : null };
  }

  async handleFieldCommand(command) {
    const search = command.match(/^(?:please\s+)?search(?:\s+for)?\s+(.+)$/i);
    if (search) {
      const matches = this.findNamedFields('search').filter(item => item.element instanceof HTMLInputElement);
      if (matches.length === 1) {
        this.insertText(matches[0].element, search[1]);
        matches[0].element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      } else {
        this.setStatus(matches.length ? 'I found multiple search boxes. Focus the section you want to search.' : 'There is no search box on this page.', 'error');
      }
      return true;
    }

    const fill = command.match(/^(?:please\s+)?(?:fill|enter|type|write|set|put)\s+(.+?)\s+(?:with|to|as)\s+(.+)$/i)
      || command.match(/^(?:please\s+)?(?:enter|type|write)\s+(.+?)\s+in(?:to)?\s+(.+)$/i);
    if (fill) {
      const fieldFirst = /^(?:please\s+)?(?:fill|set|put)\s+/i.test(command) || /\s+(?:with|to|as)\s+/i.test(command);
      const fieldQuery = fieldFirst ? fill[1] : fill[2];
      const value = fieldFirst ? fill[2] : fill[1];
      const matches = this.findNamedFields(fieldQuery);
      if (matches.length !== 1) {
        this.setStatus(matches.length ? `I found ${matches.length} fields named “${fieldQuery}”. Add the form or section name.` : `I could not find a field named “${fieldQuery}”.`, 'error');
        return true;
      }
      this.insertText(matches[0].element, value);
      return true;
    }

    const clear = command.match(/^(?:please\s+)?clear\s+(.+)$/i);
    if (clear) {
      const matches = this.findNamedFields(clear[1]);
      if (matches.length !== 1) {
        this.setStatus(matches.length ? `I found multiple fields named “${clear[1]}”. Add the form name.` : `I could not find a field named “${clear[1]}”.`, 'error');
        return true;
      }
      const field = matches[0].element;
      if (field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(field.type)) field.checked = false;
      else if (field instanceof HTMLSelectElement) field.selectedIndex = 0;
      else if (field.isContentEditable) field.textContent = '';
      else field.value = '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus('Field cleared.');
      return true;
    }

    const focus = command.match(/^(?:please\s+)?(?:focus|move to)\s+(.+)$/i);
    if (focus) {
      const matches = this.findNamedFields(focus[1]);
      if (matches.length !== 1) {
        this.setStatus(matches.length ? `I found multiple fields named “${focus[1]}”. Add the form name.` : `I could not find a field named “${focus[1]}”.`, 'error');
        return true;
      }
      matches[0].element.focus();
      this.lastFocusedElement = matches[0].element;
      this.setStatus(`Focused ${focus[1]}.`);
      return true;
    }
    return false;
  }

  async handleControlCommand(command) {
    const commandMatch = command.match(/^(?:please\s+)?(click|press|tap|activate|open|show|start|save|send|submit|approve|reject|delete|remove|cancel|end|resolve|escalate|publish|import|assign|request|arrange|schedule|create|add|generate|download|export|mark|join|view|edit|close|toggle|choose|select|filter)\s+(.+)$/i);
    const checkCommand = command.match(/^(?:please\s+)?(check|uncheck|enable|disable)\s+(.+)$/i);
    const standalone = /^(save|send|submit|approve|reject|delete|remove|cancel|end|resolve|escalate|publish|import|assign|close|reload|go back|confirm|yes|do it|go ahead|no|cancel confirmation|never mind|nevermind)$/i.test(command);
    if (checkCommand) {
      const matches = this.findNamedControls(checkCommand[2]).filter(item => item.element instanceof HTMLInputElement
        && ['checkbox', 'radio'].includes(item.element.type));
      if (matches.length !== 1) {
        this.setStatus(matches.length ? `I found multiple controls named “${checkCommand[2]}”. Add the section name.` : `I could not find a checkbox named “${checkCommand[2]}”.`, 'error');
        return true;
      }
      const checked = ['check', 'enable'].includes(checkCommand[1].toLowerCase());
      matches[0].element.checked = checked;
      matches[0].element.dispatchEvent(new Event('input', { bubbles: true }));
      matches[0].element.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus(checked ? 'Checked.' : 'Unchecked.');
      return true;
    }
    const literalMatches = !commandMatch && !standalone
      ? Array.from(this.voiceScope().querySelectorAll(VOICEABLE_SELECTOR))
        .filter(element => this.isVisible(element) && !element.disabled
          && this.normalizeForMatch(this.primaryControlName(element)) === this.normalizeForMatch(command))
      : [];
    if (!commandMatch && !standalone && literalMatches.length > 1) {
      this.setStatus(`I found ${literalMatches.length} controls with that label. Include a person's name or a section name.`, 'error');
      return true;
    }
    if (!commandMatch && !standalone && literalMatches.length !== 1) return false;
    const verb = commandMatch?.[1]?.toLowerCase() || (literalMatches.length ? 'click' : command.toLowerCase());
    let target = commandMatch?.[2] || command;
    target = target.replace(/^(?:the\s+)?(?:button|link|tab|menu item|control)(?:\s+named)?\s+/i, '')
      .replace(/\s+(?:button|link|tab|menu item|control)$/i, '').trim();
    if (verb === 'go back') {
      window.history.back();
      this.setStatus('Going back.');
      return true;
    }
    if (verb === 'reload') {
      window.location.reload();
      return true;
    }
    if (verb === 'submit') {
      const activeForm = document.activeElement?.closest?.('form');
      const forms = Array.from(this.voiceScope().querySelectorAll('form')).filter(form => this.isVisible(form));
      const form = activeForm && this.isVisible(activeForm) ? activeForm : (forms.length === 1 ? forms[0] : null);
      const submitButton = form?.querySelector('button[type="submit"], input[type="submit"]');
      if (submitButton && !submitButton.disabled) {
        const label = this.controlName(submitButton) || 'form submission';
        this.pendingAction = { element: submitButton, label, expiresAt: Date.now() + 30_000 };
        this.setStatus(`Say “confirm” to submit ${label}, or “cancel” to stop.`);
        this.announce(`This action needs confirmation. Say confirm to submit ${label}, or cancel to stop.`);
        return true;
      }
    }

    if (this.pendingAction) {
      if (/^(?:yes|confirm|confirm action|do it|go ahead)$/i.test(command)) {
        const pending = this.pendingAction;
        this.pendingAction = null;
        if (Date.now() > pending.expiresAt || !pending.element.isConnected || pending.element.disabled) {
          this.setStatus('That action is no longer available. Please say it again.', 'error');
          this.announce('That action is no longer available. Please say it again.');
          return true;
        }
        pending.element.click();
        this.setStatus(`Confirmed: ${pending.label}.`);
        this.announce('Confirmed. The action is complete.');
        return true;
      }
      if (/^(?:no|cancel confirmation|never mind|nevermind)$/i.test(command)) {
        this.pendingAction = null;
        this.setStatus('Action cancelled.');
        this.announce('Action cancelled.');
        return true;
      }
      this.pendingAction = null;
    }

    const scopedOption = command.match(/^(?:please\s+)?(?:choose|select)\s+(.+?)\s+(?:from|in)\s+(.+)$/i);
    if (scopedOption) {
      const selects = this.findNamedFields(scopedOption[2]).filter(item => item.element instanceof HTMLSelectElement);
      if (selects.length !== 1) {
        this.setStatus(selects.length ? `I found multiple menus named “${scopedOption[2]}”. Add the form name.` : `I could not find a menu named “${scopedOption[2]}”.`, 'error');
        return true;
      }
      const options = Array.from(selects[0].element.options).filter(option => !option.disabled && option.value
        && this.queryWords(scopedOption[1]).every(word => this.normalizeForMatch(option.textContent || option.value).includes(word)));
      if (options.length !== 1) {
        this.setStatus(options.length ? `More than one option matches “${scopedOption[1]}”.` : `No option matched “${scopedOption[1]}”.`, 'error');
        return true;
      }
      selects[0].element.value = options[0].value;
      selects[0].element.dispatchEvent(new Event('input', { bubbles: true }));
      selects[0].element.dispatchEvent(new Event('change', { bubbles: true }));
      this.setStatus(`Selected ${options[0].textContent.trim()}.`);
      return true;
    }

    if (verb === 'choose' || verb === 'select') {
      const optionMatches = [];
      for (const select of this.voiceScope().querySelectorAll('select')) {
        if (!this.isVisible(select) || select.disabled) continue;
        for (const option of select.options) {
          const normalizedOption = this.normalizeForMatch(option.textContent || option.value);
          const words = this.queryWords(target);
          if (!option.disabled && option.value && words.length && words.every(word => normalizedOption.includes(word))) {
            optionMatches.push({ select, option });
          }
        }
      }
      if (optionMatches.length === 1) {
        optionMatches[0].select.value = optionMatches[0].option.value;
        optionMatches[0].select.dispatchEvent(new Event('input', { bubbles: true }));
        optionMatches[0].select.dispatchEvent(new Event('change', { bubbles: true }));
        this.setStatus(`Selected ${optionMatches[0].option.textContent.trim()}.`);
        return true;
      }
      if (optionMatches.length > 1) {
        this.setStatus(`More than one menu has an option named “${target}”. Say the option and form name.`, 'error');
        return true;
      }
    }

    const ordinal = this.parseOrdinal(target);
    target = ordinal.query;
    const matches = this.findNamedControls(target);
    if (!matches.length) {
      this.setStatus(`I could not find a visible button, link, or control named “${target}”.`, 'error');
      return true;
    }
    let selected;
    if (ordinal.index !== null) selected = matches[ordinal.index];
    else if (matches.length === 1) selected = matches[0];
    else {
      const choices = matches.slice(0, 3).map(item => this.controlName(item.element).slice(0, 90)).join('; ');
      this.setStatus(`I found ${matches.length} matches. Add a person's name or say a number. Matches: ${choices}`, 'error');
      return true;
    }
    if (!selected) {
      this.setStatus(`There is no match number ${ordinal.index + 1}.`, 'error');
      return true;
    }
    const label = this.controlName(selected.element).slice(0, 120) || target;
    const ownActionLabel = this.normalizeForMatch(this.primaryControlName(selected.element));
    const needsConfirmation = selected.element.dataset.voiceConfirm !== 'false'
      && (DESTRUCTIVE_ACTION.test(ownActionLabel) || /^(approve|reject|delete|remove|cancel|end|resolve|escalate|publish|import|assign|send|submit)$/i.test(verb));
    if (needsConfirmation) {
      this.pendingAction = { element: selected.element, label, expiresAt: Date.now() + 30_000 };
      this.setStatus(`Say “confirm” to ${verb} ${label}, or “cancel” to stop.`);
      this.announce(`This action needs confirmation. Say confirm to ${verb}, or cancel to stop.`);
      return true;
    }
    selected.element.click();
    this.setStatus(`Activated ${label}.`);
    this.announce('Done.');
    return true;
  }

  async handleTranscript(rawText) {
    const text = rawText.trim();
    const command = this.canonicalizeCommand(text);
    if (/^(stop|stop reading|stop speaking|quiet)$/.test(command)) {
      this.stopAll();
      this.setStatus('Stopped.');
      return;
    }
    if (/^(read|read page|read this page|read the page)$/.test(command)) {
      this.readPage();
      return;
    }
    if (/^(help|voice help|what can you do)$/.test(command)) {
      this.speak('Say a page name to open it, the label on a visible button to activate it, or fill a field with a value. You can ask a question, focus a field to dictate, or say read this page. During a live meeting, read aloud is paused. For approvals, rejecting, deleting, and other important actions, say confirm after I ask.');
      return;
    }
    if (/^(open|show) (ai|copilot|assistant)$/.test(command)) {
      window.dispatchEvent(new CustomEvent('lumina:ai-open'));
      this.setStatus('AI assistant opened.');
      return;
    }

    const navigation = this.matchNavigation(command);
    if (navigation) {
      if (navigation.action === 'profile-modal') {
        const { openProfileModal } = await import('/js/components/profile-modal.js');
        openProfileModal();
      } else {
        window.location.hash = navigation.path;
      }
      this.setStatus(`Opening ${navigation.label}.`);
      this.announce(`Opening ${navigation.label}.`);
      return;
    }

    if (await this.handleFieldCommand(command)) return;
    if (await this.handleControlCommand(command)) return;

    if (/^(?:what|who|when|where|why|how|can you|could you|please explain|tell me|suggest|recommend|help me|explain)\b/i.test(command)) {
      if (!document.getElementById('lumina-ai-window')) {
        this.speak('Open your signed-in dashboard to ask the AI assistant a question.');
        return;
      }
      this.speakNextAIResponse = true;
      this.setStatus('Sending your question to the assistant…');
      window.dispatchEvent(new CustomEvent('lumina:ai-prompt', { detail: { prompt: text, autoSend: true } }));
      return;
    }

    const target = this.getDictationTarget();
    if (target) {
      this.insertText(target, text);
      return;
    }

    if (!document.getElementById('lumina-ai-window')) {
      this.speak('Open your signed-in dashboard to ask the AI assistant a question.');
      return;
    }
    this.speakNextAIResponse = true;
    this.setStatus('Sending your question to the assistant…');
    window.dispatchEvent(new CustomEvent('lumina:ai-prompt', { detail: { prompt: text, autoSend: true } }));
  }

  canonicalizeCommand(value) {
    let command = String(value || '').toLowerCase().replace(/[.,!?]+$/g, '').trim();
    const exactTranslations = new Map([
      ['मदत', 'help'], ['मदद', 'help'], ['वाचा', 'read page'], ['पान वाचा', 'read page'],
      ['पुष्टि करें', 'confirm'], ['पुष्टी करा', 'confirm'], ['रद्द करें', 'cancel'], ['रद्द करा', 'cancel'],
      ['हो', 'yes'], ['नाही', 'no'], ['होय', 'yes']
    ]);
    if (exactTranslations.has(command)) return exactTranslations.get(command);
    const suffixCommands = [
      [/(.+?)\s+(?:दिखाओ|दाखवा|दाखवा)$/u, 'show'],
      [/(.+?)\s+(?:खोलो|खोलिए|उघडा|उघड)$/u, 'open'],
      [/(.+?)\s+(?:दबाओ|दाबा|क्लिक करें|क्लिक करा)$/u, 'click'],
      [/(.+?)\s+(?:भरें|भरो|भरा|भरा)$/u, 'fill'],
      [/(.+?)\s+(?:जांचें|तपासा)$/u, 'check'],
      [/(.+?)\s+(?:सहेजें|जतन करा)$/u, 'save']
    ];
    for (const [pattern, verb] of suffixCommands) {
      const match = command.match(pattern);
      if (match) {
        if (verb === 'fill') {
          const fill = match[1].match(/^(.+?)\s+(?:में|मध्ये)\s+(.+)$/u);
          return fill ? `fill ${fill[1]} with ${fill[2]}` : `${verb} ${match[1]}`;
        }
        return `${verb} ${match[1]}`;
      }
    }
    return command;
  }

  matchNavigation(command) {
    const user = getUserProfile();
    if (!user) {
      const publicRoutes = [
        { path: '/login', label: 'sign in', aliases: ['login', 'log in'] },
        { path: '/register', label: 'register', aliases: ['registration', 'create account'] },
        { path: '/landing', label: 'home', aliases: ['landing page'] }
      ];
      const hasPublicNavigationVerb = /^(please\s+)?(go to|open|show|navigate to|take me to)\s+/.test(command);
      const normalizedPublicCommand = command.replace(/^(please\s+)?(go to|open|show|navigate to|take me to)\s+/, '').trim();
      return publicRoutes.flatMap(route => [route.label, ...route.aliases].map(alias => ({ ...route, alias })))
        .find(route => normalizedPublicCommand === route.alias || (hasPublicNavigationVerb && normalizedPublicCommand.includes(route.alias))) || null;
    }
    const role = String(user?.role || '').toUpperCase();
    const items = {
      STUDENT: [
        ['/student/dashboard', 'dashboard', ['home']], ['/chat', 'messages', ['chat']], ['/student/meetings', 'meetings', ['meeting']],
        ['/student/issues', 'issues', ['grievances']], ['/student/tasks', 'tasks', ['goals']], ['/student/profile', 'profile', ['my profile']],
        ['/student/booklet', 'booklet', ['mentorship booklet']], ['/student/academics', 'academics', ['academic record', 'marks']]
      ],
      STAFF: [
        ['/mentor/dashboard', 'dashboard', ['home']], ['/chat', 'messages', ['chat']], ['/mentor/meetings', 'meetings', ['meeting']],
        ['/mentor/issues', 'issues', ['grievances']], ['/mentor/students', 'students', ['my students']], ['/mentor/reports', 'reports', ['analytics']],
        ['#profile-modal', 'profile', ['my profile'], 'profile-modal']
      ],
      HOD: [
        ['/hod/dashboard', 'dashboard', ['home']], ['/hod/allocation', 'allocation', ['mentor allocation']], ['/hod/management', 'management', ['academic management']],
        ['/hod/directory', 'users', ['directory']], ['/hod/risk-students', 'risk students', ['at risk students']], ['/hod/escalations', 'escalations', ['issues']], ['/hod/reports', 'reports', ['analytics']],
        ['#profile-modal', 'profile', ['my profile'], 'profile-modal']
      ],
      DEAN: [
        ['/dean/dashboard', 'dashboard', ['home']], ['/dean/management', 'management', ['academic management']], ['/dean/directory', 'users', ['directory']],
        ['/dean/analytics', 'analytics', ['reports']], ['/dean/allocation', 'allocation', ['mentor allocation']], ['/dean/escalations', 'escalations', ['issues']], ['/dean/reports', 'mentor reports'],
        ['#profile-modal', 'profile', ['my profile'], 'profile-modal']
      ],
      SECTION_HEAD: [
        ['/section/dashboard', 'dashboard', ['home', 'admissions']], ['/section/escalations', 'escalations', ['issues']], ['#profile-modal', 'profile', ['my profile'], 'profile-modal']
      ],
      ADMIN: [
        ['/admin/dashboard', 'dashboard', ['home']], ['/admin/marks', 'marks', ['results']], ['/admin/attendance', 'attendance'], ['/admin/compliance', 'compliance', ['booklet compliance']],
        ['/admin/users', 'users', ['directory']], ['/admin/departments', 'departments', ['classes', 'organization']], ['/admin/allocation', 'allocation', ['mentor allocation']],
        ['/admin/settings', 'settings'], ['/admin/security-logs', 'security logs'], ['/admin/infrastructure', 'system intelligence'], ['#profile-modal', 'profile', ['my profile'], 'profile-modal']
      ]
    };
    const roleKey = role === 'FACULTY' || role === 'MENTOR' ? 'STAFF' : role;
    const routes = items[roleKey] || [];
    const hasNavigationVerb = /^(please\s+)?(go to|open|show|navigate to|take me to)\s+/.test(command);
    const normalized = command.replace(/^(please\s+)?(go to|open|show|navigate to|take me to)\s+/, '').trim();
    const matches = routes.flatMap(([path, label, aliases = [], action]) => [label, ...aliases].map(alias => ({ path, label, action, alias })))
      .filter(item => normalized === item.alias || (hasNavigationVerb && normalized.includes(item.alias)))
      .sort((left, right) => right.alias.length - left.alias.length);
    return matches[0] || null;
  }

  pageText() {
    const root = document.getElementById('app');
    if (!root) return '';
    const text = root.innerText.replace(/\n{3,}/g, '\n\n').trim();
    return text.slice(0, 4200);
  }

  readPage() {
    if (window.location.hash.startsWith('#/meeting-room')) {
      this.setStatus('Use meeting captions during a call. Read aloud is paused to avoid audio feedback.', 'error');
      return;
    }
    const content = this.pageText();
    if (!content) {
      this.setStatus('There is no page content to read.', 'error');
      return;
    }
    this.speak(`Here is this page. ${content}`);
  }

  speak(text) {
    if (window.location.hash.startsWith('#/meeting-room')) {
      this.setStatus('Read aloud is paused during a call to avoid audio feedback.', 'error');
      return;
    }
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) {
      this.setStatus('Read aloud is not supported by this browser.', 'error');
      return;
    }
    const plainText = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '').replace(/[`*_#>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
    if (!plainText) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.lang = this.language();
    utterance.rate = 1;
    utterance.onstart = () => { this.isSpeaking = true; this.setStatus('Reading aloud…'); };
    utterance.onend = () => { this.isSpeaking = false; this.speechMutedUntil = Date.now() + 500; this.setStatus('Finished reading.'); };
    utterance.onerror = () => { this.isSpeaking = false; this.speechMutedUntil = Date.now() + 500; this.setStatus('Could not play speech. Check your device audio settings.', 'error'); };
    window.speechSynthesis.speak(utterance);
  }

  announce(text) {
    if (window.location.hash.startsWith('#/meeting-room')) return;
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return;
    const plainText = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
    if (!plainText) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.lang = this.language();
    utterance.rate = 1;
    utterance.onstart = () => { this.isSpeaking = true; };
    utterance.onend = () => { this.isSpeaking = false; this.speechMutedUntil = Date.now() + 400; };
    utterance.onerror = () => { this.isSpeaking = false; this.speechMutedUntil = Date.now() + 400; };
    window.speechSynthesis.speak(utterance);
  }

  stopSpeech() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.isSpeaking = false;
    this.speechMutedUntil = Date.now() + 300;
  }

  stopAll() {
    this.voiceSessionActive = false;
    this.stopSpeech();
    try { this.recognition?.abort(); } catch (_) {}
    this.isListening = false;
    this.container?.classList.remove('is-listening');
    this.container?.querySelector('[data-voice-listen]')?.setAttribute('aria-pressed', 'false');
  }

  unmount() {
    this.stopAll();
    this.container?.remove();
    this.container = null;
    this.bound = false;
    this.speakNextAIResponse = false;
  }
}

export const voiceAssistantWidget = new VoiceAssistant();
export function initVoiceAssistant() { voiceAssistantWidget.mount(); }
