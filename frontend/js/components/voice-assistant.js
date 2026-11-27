import { getUserProfile } from '/js/auth.js';
import { AIService } from '/js/services/ai-service.js';

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
    this.lastCommandText = '';
    this.pendingAction = null;
    this.bound = false;
    this.voiceSessionId = 0;
    this.restartTimer = null;
    this.mediaRecorder = null;
    this.recordingStream = null;
    this.recordingChunks = [];
    this.recordingFallback = false;
    this.transcribeRecordingOnStop = false;
    this.recordingTimeout = null;
    this.speechSequence = 0;
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
        <div class="lumina-voice-heading"><div><strong>Voice assistant</strong><p>Say “open meetings”, “fill topic with exam planning”, “make a study plan”, or “quiz me on algebra”.</p></div><button type="button" data-voice-close aria-label="Close voice assistant">×</button></div>
        <div class="lumina-voice-actions">
          <button type="button" class="btn btn-primary" data-voice-listen aria-label="Start voice input" aria-pressed="false"><i class="ph ph-microphone" aria-hidden="true"></i> Start speaking</button>
          <button type="button" class="btn btn-secondary" data-voice-read><i class="ph ph-speaker-high"></i> Read this page</button>
          <button type="button" class="btn btn-ghost" data-voice-stop><i class="ph ph-stop"></i> Stop</button>
        </div>
        <p class="lumina-voice-status" data-voice-status role="status" aria-live="polite">Press Start, then speak naturally. Voice works on buttons and forms and can ask Lumina AI for study plans, quizzes, and meeting preparation.</p>
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
    this.container.querySelector('[data-voice-listen]')?.addEventListener('click', () => {
      if (this.voiceSessionActive) this.stopAll();
      else this.startListening();
    });
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
    if (!open && this.voiceSessionActive) this.stopAll();
    panel.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    if (open) {
      window.dispatchEvent(new CustomEvent('lumina:voice-opened'));
      this.setStatus(this.getRecognition()
        ? 'Speak naturally: navigate, activate visible controls, fill forms, request a mentor meeting, or ask for an AI study plan or quiz.'
        : 'This browser will record one voice command at a time. Press Stop after speaking to transcribe it.');
    }
  }

  setStatus(message, state = 'info') {
    const status = this.container?.querySelector('[data-voice-status]');
    if (status) {
      status.textContent = message;
      status.dataset.state = state;
    }
    if (state === 'error' && !/no speech detected/i.test(message)) this.announce(message);
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
      this.startRecordingFallback();
      return;
    }
    if (!resume) {
      this.voiceSessionId += 1;
      this.voiceSessionActive = true;
      this.stopSpeech();
    }
    const sessionId = this.voiceSessionId;
    clearTimeout(this.restartTimer);
    if (this.recognition) {
      this.recognition.onend = null;
      this.recognition.onerror = null;
      try { this.recognition.abort(); } catch (_) {}
      this.recognition = null;
    }
    let recognition;
    try { recognition = new SpeechRecognition(); }
    catch (_) {
      this.voiceSessionActive = false;
      this.setStatus('Voice recognition could not start. Check microphone access and try again.', 'error');
      return;
    }
    this.recognition = recognition;
    recognition.lang = this.language();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (sessionId !== this.voiceSessionId || this.recognition !== recognition) return;
      this.isListening = true;
      this.recordingFallback = false;
      this.container?.classList.add('is-listening');
      this.updateListenButton(true);
      this.setStatus('Listening… speak a command or question.');
    };
    recognition.onresult = event => {
      if (sessionId !== this.voiceSessionId || this.recognition !== recognition) return;
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
        this.handleTranscript(text).catch(error => {
          console.error('Voice command failed:', error);
          this.setStatus('I could not complete that voice command. Please try again.', 'error');
        });
      }
    };
    recognition.onerror = event => {
      if (sessionId !== this.voiceSessionId || this.recognition !== recognition || event.error === 'aborted') return;
      const message = event.error === 'not-allowed' || event.error === 'service-not-allowed'
        ? 'Microphone access is blocked. Allow it in your browser settings, then try again.'
        : event.error === 'audio-capture' ? 'No microphone was found. Connect or enable a microphone, then try again.'
          : event.error === 'network' ? 'Speech recognition lost its network connection. Check the connection and start again.'
            : event.error === 'no-speech' ? 'I did not hear speech. Keep speaking or try again.'
              : 'Voice input stopped. Check microphone access and try again.';
      this.setStatus(message, event.error === 'no-speech' ? 'info' : 'error');
      if (event.error !== 'no-speech') this.voiceSessionActive = false;
    };
    recognition.onend = () => {
      if (sessionId !== this.voiceSessionId || this.recognition !== recognition) return;
      this.isListening = false;
      this.container?.classList.remove('is-listening');
      this.recognition = null;
      if (this.voiceSessionActive && this.container?.isConnected) {
        this.updateListenButton(true);
        if (!this.isSpeaking) {
          this.setStatus('Reconnecting microphone…');
          this.restartTimer = setTimeout(() => {
            if (this.voiceSessionActive && this.container?.isConnected && sessionId === this.voiceSessionId) this.startListening(true);
          }, 450);
        }
      } else if (this.container?.isConnected && this.container.querySelector('[data-voice-status]')?.textContent.startsWith('Listening')) {
        this.updateListenButton(false);
        this.setStatus('Ready. Press the microphone when you want to speak.');
      } else this.updateListenButton(false);
    };
    this.setTranscript('');
    try { recognition.start(); }
    catch (error) {
      this.recognition = null;
      this.isListening = false;
      if (error?.name === 'InvalidStateError' && this.voiceSessionActive && sessionId === this.voiceSessionId) {
        this.restartTimer = setTimeout(() => this.startListening(true), 700);
      } else {
        this.voiceSessionActive = false;
        this.updateListenButton(false);
        this.setStatus('Voice input could not start. Check microphone access, then try again.', 'error');
      }
    }
  }

  updateListenButton(listening) {
    const button = this.container?.querySelector('[data-voice-listen]');
    if (!button) return;
    button.setAttribute('aria-pressed', String(listening));
    button.setAttribute('aria-label', listening ? 'Stop voice input' : 'Start voice input');
    button.innerHTML = listening
      ? '<i class="ph ph-stop" aria-hidden="true"></i> Stop speaking'
      : '<i class="ph ph-microphone" aria-hidden="true"></i> Start speaking';
  }

  async startRecordingFallback() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      this.setStatus('Voice input is unavailable here. Use Chrome or Edge with microphone access enabled.', 'error');
      return;
    }
    this.voiceSessionId += 1;
    const sessionId = this.voiceSessionId;
    this.voiceSessionActive = true;
    this.recordingFallback = true;
    this.stopSpeech();
    this.setStatus('Requesting microphone access…');
    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.voiceSessionActive || sessionId !== this.voiceSessionId || !this.container?.isConnected) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const preferredType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(type => MediaRecorder.isTypeSupported?.(type));
      const recorder = preferredType ? new MediaRecorder(stream, { mimeType: preferredType }) : new MediaRecorder(stream);
      this.recordingStream = stream;
      this.mediaRecorder = recorder;
      this.recordingChunks = [];
      this.transcribeRecordingOnStop = true;
      recorder.ondataavailable = event => { if (event.data?.size) this.recordingChunks.push(event.data); };
      recorder.onerror = () => this.setStatus('Microphone recording failed. Check the microphone and try again.', 'error');
      recorder.onstop = () => this.transcribeRecording(recorder, sessionId);
      recorder.start(250);
      this.isListening = true;
      this.container?.classList.add('is-listening');
      this.updateListenButton(true);
      this.setStatus('Recording… say one command, then press Stop to process it.');
      this.recordingTimeout = setTimeout(() => this.stopAll(), 30_000);
    } catch (error) {
      stream?.getTracks().forEach(track => track.stop());
      this.recordingStream?.getTracks().forEach(track => track.stop());
      this.recordingStream = null;
      this.mediaRecorder = null;
      this.voiceSessionActive = false;
      this.recordingFallback = false;
      this.isListening = false;
      this.updateListenButton(false);
      const message = error?.name === 'NotAllowedError'
        ? 'Microphone access is blocked. Allow it in your browser settings, then try again.'
        : 'Could not access the microphone. Check its connection and browser permissions.';
      this.setStatus(message, 'error');
    }
  }

  async transcribeRecording(recorder, sessionId) {
    clearTimeout(this.recordingTimeout);
    this.recordingStream?.getTracks().forEach(track => track.stop());
    this.recordingStream = null;
    this.mediaRecorder = null;
    this.recordingFallback = false;
    this.isListening = false;
    this.container?.classList.remove('is-listening');
    this.updateListenButton(false);
    const chunks = this.recordingChunks;
    this.recordingChunks = [];
    const shouldTranscribe = this.transcribeRecordingOnStop;
    this.transcribeRecordingOnStop = false;
    if (!shouldTranscribe || !chunks.length) {
      if (shouldTranscribe) this.setStatus('No audio was captured. Press the microphone and try again.', 'error');
      return;
    }
    this.setStatus('Transcribing your voice command…');
    try {
      const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type || 'audio/webm' });
      const text = await AIService.transcribeAudioBlob(blob);
      if (sessionId !== this.voiceSessionId || !this.container?.isConnected) return;
      this.setTranscript(text);
      await this.handleTranscript(text);
    } catch (error) {
      if (sessionId !== this.voiceSessionId) return;
      console.error('Voice transcription failed:', error);
      const message = /sign in to transcribe/i.test(error.message || '')
        ? 'Please sign in to use voice commands in this browser.'
        : error.message || 'Could not transcribe this recording. Try again.';
      this.setStatus(message, 'error');
    }
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

  insertText(target, text, replace = false) {
    if (target instanceof HTMLSelectElement) {
      const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const options = Array.from(target.options).filter(option => !option.disabled && option.value);
      const words = this.queryWords(text);
      const matched = options.find(option => this.normalizeForMatch(option.textContent) === this.normalizeForMatch(text))
        || options.find(option => words.length && words.every(word => this.normalizeForMatch(option.textContent).includes(word)))
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
    if (replace && target.isContentEditable) {
      target.textContent = text;
    } else if (replace) {
      target.value = text;
    } else if (target.isContentEditable) {
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
    const ignored = new Set(['the', 'a', 'an', 'button', 'link', 'tab', 'menu', 'item', 'option', 'please', 'for', 'to', 'on', 'in', 'me', 'my', 'this', 'and', 'with']);
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

  voiceCoachPrompt(command) {
    const normalized = String(command || '').trim()
      .replace(/^(?:please\s+)?(?:help me|i want to|can you|could you)\s+/i, '');
    const studyPlan = /\b(study|revision|exam(?:ination)? prep|catch[- ]?up|attendance recovery|academic recovery)\b.{0,24}\b(plan|timetable|schedule)\b|\b(plan|timetable|schedule)\b.{0,24}\b(study|revision|exam|catch[- ]?up|attendance|academic recovery)\b/i.test(normalized);
    if (/^(?:please\s+)?(?:make|create|build|generate|plan)\b/i.test(normalized) && studyPlan) {
      const subjectCandidate = normalized.match(/\b(?:for|on)\s+(.+)$/i)?.[1]?.trim();
      const subject = subjectCandidate && !/^(?:(?:the|next|this|coming)\s+)?(?:one|two|three|four|1|2|3|4)?[- ]?weeks?\b/i.test(subjectCandidate)
        ? subjectCandidate : '';
      const duration = /\b(two[- ]weeks?|fortnight)\b/i.test(normalized) ? 'two weeks'
        : /\b(month|four weeks?)\b/i.test(normalized) ? 'four weeks'
          : /\b(today|daily|day)\b/i.test(normalized) ? 'one day' : 'one week';
      return `Create a practical ${duration} study and learning recovery plan${subject ? ` for ${subject}` : ''}. Keep it supportive and realistic: focused study blocks, active recall, short breaks, a catch-up buffer, and a simple end-of-week review. Do not assume grades, attendance, available hours, or personal circumstances. State any assumptions briefly and ask at most one useful follow-up question. Answer in the same language as the student and keep it concise enough to read aloud.`;
    }

    const quiz = normalized.match(/^(?:please\s+)?(?:quiz|test)\s+me\s+(?:on|about)\s+(.+)$/i)
      || normalized.match(/^(?:please\s+)?(?:give|make|create)\s+me\s+(?:a\s+)?(?:quiz|practice questions?)\s+(?:on|about)\s+(.+)$/i);
    if (quiz) {
      const topic = quiz[2] || quiz[1];
      return `Run an interactive practice quiz on ${topic}. Ask only one clear question now and wait for my spoken or typed answer. After I answer, explain briefly, then ask the next question. Do not show the answer before I respond. Use the same language as the student.`;
    }

    if (/^(?:please\s+)?(?:prepare|plan)\s+(?:me\s+)?(?:for\s+)?(?:(?:my|the|next)\s+)?(?:mentor|mentorship)\s+meeting\b/i.test(normalized)
      || /^(?:please\s+)?what should i discuss with my mentor\??$/i.test(normalized)) {
      return 'Help me prepare for a mentor meeting. Give me a short, respectful agenda and a few open questions I can ask. Do not assume any attendance, marks, or personal circumstances. Include space to explain what support I want and agree on a follow-up. Answer in the same language as the student and keep it easy to read aloud.';
    }
    return null;
  }

  sendVoiceAIPrompt(prompt, fallbackMessage = 'Open the signed-in dashboard to use the AI coach.') {
    if (!document.getElementById('lumina-ai-window')) {
      this.setStatus(fallbackMessage, 'error');
      return false;
    }
    this.speakNextAIResponse = true;
    this.setStatus('Sending your request to the AI coach…');
    window.dispatchEvent(new CustomEvent('lumina:ai-prompt', { detail: { prompt, displayText: this.lastCommandText || prompt, autoSend: true } }));
    return true;
  }

  handleMeetingVoiceIntent(command) {
    const isStudent = String(getUserProfile()?.role || '').toUpperCase() === 'STUDENT';
    if (!isStudent) return false;
    const bookingIntent = /^(?:please\s+)?(?:book|request|arrange|schedule|create|open|start)\s+(?:a\s+)?(?:(?:new|mentor|mentorship)\s+)*(?:meeting|session)\b/i.test(command)
      || /^(?:please\s+)?(?:request|book|arrange)\s+(?:a\s+)?mentor meeting\b/i.test(command);
    const submitIntent = /^(?:please\s+)?(?:schedule now|schedule (?:my )?(?:mentor )?meeting request|submit (?:my )?(?:meeting )?request|send (?:my )?meeting request|send request)$/i.test(command);
    if (!bookingIntent && !submitIntent) return false;

    if (!window.location.hash.startsWith('#/student/meetings')) {
      window.location.hash = '#/student/meetings';
      this.setStatus('Opening your meetings. When the page loads, say “arrange a meeting” to open the request form.');
      this.announce('Opening your meetings.');
      return true;
    }
    const form = document.getElementById('req-form');
    if (!form || form.style.display === 'none') {
      document.getElementById('btn-new')?.click();
      this.setStatus('Meeting request form opened. Say a mentor name, fill the agenda and date, or select an open time slot.');
      this.announce('Meeting request form opened. I can help you fill it in by voice.');
      return true;
    }
    if (submitIntent) {
      const button = document.getElementById('btn-submit');
      if (!button || button.disabled) {
        this.setStatus('The meeting request cannot be submitted yet. Complete the required fields first.', 'error');
        return true;
      }
      this.pendingAction = { element: button, label: 'meeting request', expiresAt: Date.now() + 30_000 };
      this.setStatus('Say “confirm” to send your meeting request to your mentor, or “cancel” to stop.');
      this.announce('Your meeting request is ready. Say confirm to send it to your mentor, or cancel to stop.');
      return true;
    }
    this.setStatus('The meeting request form is open. Choose a mentor, topic and time, then say “schedule now” to review the request.');
    return bookingIntent;
  }

  async handleFieldCommand(command, originalCommand = command) {
    const source = String(originalCommand || command).trim();
    const search = source.match(/^(?:please\s+)?search(?:\s+for)?\s+(.+)$/i) || command.match(/^(?:please\s+)?search(?:\s+for)?\s+(.+)$/i);
    if (search) {
      const matches = this.findNamedFields('search').filter(item => item.element instanceof HTMLInputElement);
      if (matches.length === 1) {
        this.insertText(matches[0].element, search[1], true);
        matches[0].element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      } else {
        this.setStatus(matches.length ? 'I found multiple search boxes. Focus the section you want to search.' : 'There is no search box on this page.', 'error');
      }
      return true;
    }

    const fill = source.match(/^(?:please\s+)?(?:fill|enter|type|write|set|put)\s+(.+?)\s+(?:with|to|as)\s+(.+)$/i)
      || source.match(/^(?:please\s+)?(?:enter|type|write)\s+(.+?)\s+in(?:to)?\s+(.+)$/i)
      || command.match(/^(?:please\s+)?(?:fill|enter|type|write|set|put)\s+(.+?)\s+(?:with|to|as)\s+(.+)$/i)
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
      this.insertText(matches[0].element, value, true);
      return true;
    }

    const clear = source.match(/^(?:please\s+)?clear\s+(.+)$/i) || command.match(/^(?:please\s+)?clear\s+(.+)$/i);
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

    const focus = source.match(/^(?:please\s+)?(?:focus|move to)\s+(.+)$/i) || command.match(/^(?:please\s+)?(?:focus|move to)\s+(.+)$/i);
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
    const commandMatch = command.match(/^(?:please\s+)?(click|press|tap|activate|open|show|start|save|send|submit|approve|reject|delete|remove|cancel|end|resolve|escalate|publish|import|assign|request|arrange|schedule|book|create|add|generate|download|export|mark|join|view|edit|close|toggle|choose|select|filter|scroll)\s+(.+)$/i);
    const checkCommand = command.match(/^(?:please\s+)?(check|uncheck|enable|disable)\s+(.+)$/i);
    const standalone = /^(save|send|submit|approve|reject|delete|remove|cancel|end|resolve|escalate|publish|import|assign|close|reload|go back|confirm|confirm it|confirm action|yes|yes confirm|do it|go ahead|no|cancel confirmation|never mind|nevermind)$/i.test(command);
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
    const scrollCommand = command.match(/^(?:please\s+)?(?:scroll|move)\s+(?:to\s+)?(up|down|top|bottom)$/i);
    if (scrollCommand) {
      const direction = scrollCommand[1].toLowerCase();
      window.scrollTo({ top: direction === 'top' ? 0 : direction === 'bottom' ? document.documentElement.scrollHeight : window.scrollY + (direction === 'down' ? 650 : -650), behavior: 'smooth' });
      this.setStatus(`Scrolled ${direction}.`);
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
      if (/^(?:yes|yes confirm|confirm|confirm it|confirm action|do it|go ahead)$/i.test(command)) {
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
    const needsConfirmation = selected.element.dataset.voiceConfirm === 'true'
      || (selected.element.dataset.voiceConfirm !== 'false'
        && (DESTRUCTIVE_ACTION.test(ownActionLabel) || /^(approve|reject|delete|remove|cancel|end|resolve|escalate|publish|import|assign|send|submit)$/i.test(verb)));
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
    this.lastCommandText = text;
    const command = this.canonicalizeCommand(text);
    if (/^(stop|stop reading|stop speaking|stop listening|pause listening|quiet)$/.test(command)) {
      this.stopAll();
      this.setStatus('Stopped.');
      return;
    }
    if (/^(read|read page|read this page|read the page)$/.test(command)) {
      this.readPage();
      return;
    }
    if (/^(help|voice help|what can you do)$/.test(command)) {
      this.speak('Say a page name to open it, a visible button label to activate it, or fill a field with a value. Ask for a study plan, say quiz me on a topic, or prepare me for a mentor meeting. On the student meetings page, say arrange a meeting, fill the form by voice, then say schedule now and confirm. Say read this page or stop listening at any time.');
      return;
    }
    if (/^(?:close|hide) (?:the )?voice assistant$/.test(command)) {
      this.togglePanel(false);
      return;
    }
    if (/^(open|show) (ai|copilot|assistant)$/.test(command)) {
      window.dispatchEvent(new CustomEvent('lumina:ai-open'));
      this.setStatus('AI assistant opened.');
      return;
    }

    if (/^(?:please\s+)?(?:show me|tell me|explain|teach me|draft|summarize|compare|review|improve)\b/i.test(command)) {
      this.sendVoiceAIPrompt(text + '\n\nAnswer concisely in the same language as my question. Do not assume academic data or claim a platform action was completed.');
      return;
    }

    const coachPrompt = this.voiceCoachPrompt(command);
    if (coachPrompt) {
      this.sendVoiceAIPrompt(coachPrompt);
      return;
    }

    if (this.handleMeetingVoiceIntent(command)) return;

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

    if (await this.handleFieldCommand(command, text)) return;
    if (await this.handleControlCommand(command)) return;

    if (/^(?:what|who|when|where|why|how|can you|could you|please explain|tell me|suggest|recommend|help me|explain|draft|summarize|compare|review|improve|teach me|show me)\b/i.test(command)) {
      if (!document.getElementById('lumina-ai-window')) {
        this.speak('Open your signed-in dashboard to ask the AI assistant a question.');
        return;
      }
      this.sendVoiceAIPrompt(`${text}\n\nAnswer concisely in the same language as my question. If I ask you to take a platform action, explain how to do it and do not claim it was completed unless I explicitly confirmed it in the interface.`);
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
    this.sendVoiceAIPrompt(`${text}\n\nAnswer concisely in the same language as my question. If I ask you to take a platform action, explain how to do it and do not claim it was completed unless I explicitly confirmed it in the interface.`);
  }

  canonicalizeCommand(value) {
    let command = String(value || '').toLowerCase().replace(/[.,!?]+$/g, '').trim()
      .replace(/^(?:hey\s+)?lumina[,:\s-]+/i, '').trim();
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
    const sequence = ++this.speechSequence;
    window.speechSynthesis.cancel();
    this.isSpeaking = true;
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.lang = this.language();
    utterance.rate = 1;
    utterance.onstart = () => {
      if (sequence !== this.speechSequence) return;
      this.isSpeaking = true;
      this.setStatus('Reading aloud…');
    };
    utterance.onend = () => {
      if (sequence !== this.speechSequence) return;
      this.isSpeaking = false;
      this.speechMutedUntil = Date.now() + 600;
      this.setStatus('Finished reading.');
      this.resumeListeningAfterSpeech(sequence);
    };
    utterance.onerror = () => {
      if (sequence !== this.speechSequence) return;
      this.isSpeaking = false;
      this.speechMutedUntil = Date.now() + 600;
      this.setStatus('Could not play speech. Check your device audio settings.', 'error');
      this.resumeListeningAfterSpeech(sequence);
    };
    try { window.speechSynthesis.speak(utterance); }
    catch (_) {
      this.isSpeaking = false;
      this.setStatus('Could not start read aloud. Check your device audio settings.', 'error');
    }
  }

  announce(text) {
    if (window.location.hash.startsWith('#/meeting-room')) return;
    if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return;
    const plainText = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 260);
    if (!plainText) return;
    const sequence = ++this.speechSequence;
    window.speechSynthesis.cancel();
    this.isSpeaking = true;
    const utterance = new SpeechSynthesisUtterance(plainText);
    utterance.lang = this.language();
    utterance.rate = 1;
    utterance.onstart = () => { if (sequence === this.speechSequence) this.isSpeaking = true; };
    utterance.onend = () => {
      if (sequence !== this.speechSequence) return;
      this.isSpeaking = false;
      this.speechMutedUntil = Date.now() + 600;
      this.resumeListeningAfterSpeech(sequence);
    };
    utterance.onerror = () => {
      if (sequence !== this.speechSequence) return;
      this.isSpeaking = false;
      this.speechMutedUntil = Date.now() + 600;
      this.resumeListeningAfterSpeech(sequence);
    };
    try { window.speechSynthesis.speak(utterance); }
    catch (_) { this.isSpeaking = false; }
  }

  resumeListeningAfterSpeech(sequence) {
    if (!this.voiceSessionActive || this.isListening || !this.getRecognition()) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      if (sequence === this.speechSequence && this.voiceSessionActive && !this.isListening) this.startListening(true);
    }, 300);
  }

  stopSpeech() {
    this.speechSequence += 1;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.isSpeaking = false;
    this.speechMutedUntil = Date.now() + 300;
  }

  stopAll() {
    this.voiceSessionActive = false;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.stopSpeech();
    clearTimeout(this.recordingTimeout);
    this.recordingTimeout = null;
    if (this.mediaRecorder?.state === 'recording') {
      this.transcribeRecordingOnStop = true;
      try { this.mediaRecorder.stop(); } catch (_) {}
    } else {
      this.voiceSessionId += 1;
      if (this.recognition) {
        this.recognition.onend = null;
        this.recognition.onerror = null;
        try { this.recognition.abort(); } catch (_) {}
        this.recognition = null;
      }
    }
    this.isListening = false;
    this.container?.classList.remove('is-listening');
    this.updateListenButton(false);
    this.pendingAction = null;
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
