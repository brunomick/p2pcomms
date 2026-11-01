// DOM layer: shows screens, texts and media. No connection logic here.
// Peer-supplied text is only ever written with textContent.

const SCREENS = ['start', 'waiting', 'session'];

const pad = n => String(n).padStart(2, '0');

export function createUi(doc = document) {
  const $ = id => doc.getElementById(id);
  const show = (id, on) => {
    $(id).hidden = !on;
  };
  // The status/notice block is a single element, moved into the slot of the visible view.
  const placeStatus = slot => $(`slot-${slot}`).append($('statusbar'));

  let countdownTimer;
  let callTimer;
  let copiedTimer;

  const ui = {
    $,

    showScreen(name) {
      for (const s of SCREENS) show(`screen-${s}`, s === name);
      if (name === 'start') ui.showHome();
      else placeStatus(name);
    },

    showHome() {
      show('join-form', false);
      show('start-home', true);
      placeStatus('home');
    },

    // tone: '' | 'ok' | 'bad'. Any new status ends the waiting countdown.
    setStatus(text, tone = '') {
      ui.stopCountdown();
      const el = $('status');
      el.textContent = text;
      el.className = tone;
    },

    // Shown after the status text: "Waiting… expires in 9:41".
    startCountdown(ms) {
      ui.stopCountdown();
      const end = Date.now() + ms;
      const tick = () => {
        const s = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        $('countdown').textContent = ` expires in ${Math.floor(s / 60)}:${pad(s % 60)}`;
        if (s === 0) clearInterval(countdownTimer);
      };
      tick();
      countdownTimer = setInterval(tick, 1000);
    },

    stopCountdown() {
      clearInterval(countdownTimer);
      $('countdown').textContent = '';
    },

    setError(text) {
      $('error').textContent = text ?? '';
      show('error', Boolean(text));
    },

    showJoinForm() {
      show('start-home', false);
      show('join-form', true);
      placeStatus('join');
      $('code-input').focus();
    },

    togglePrivacy() {
      const open = $('privacy').hidden;
      show('privacy', open);
      $('btn-privacy').setAttribute('aria-expanded', String(open));
    },

    // One word per line; the hidden separators keep textContent equal to the code.
    showCode(code) {
      const box = $('code-display');
      box.textContent = '';
      (code ? code.split('-') : []).forEach((word, i) => {
        if (i > 0) {
          const sep = doc.createElement('span');
          sep.className = 'sep';
          sep.textContent = '-';
          box.append(sep);
        }
        const w = doc.createElement('span');
        w.textContent = word;
        box.append(w);
      });
      clearTimeout(copiedTimer);
      $('btn-copy').textContent = 'Copy';
      show('code-box', Boolean(code));
      show('btn-copy', Boolean(code));
    },

    setCopied() {
      $('btn-copy').textContent = 'Copied';
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => {
        $('btn-copy').textContent = 'Copy';
      }, 1500);
    },

    addChat(who, text) {
      const log = $('chat-log');
      const line = doc.createElement('div');
      line.className = `msg ${who}`;
      line.textContent = text;
      log.append(line);
      log.scrollTop = log.scrollHeight;
    },

    // words: string[] or null while the exchange runs.
    setSas(words, verified = false) {
      $('sas-words').textContent = words ? words.join(' ') : '…';
      const state = $('sas-state');
      state.textContent = verified ? 'Verified' : 'Unverified';
      state.className = verified ? 'ok' : '';
      // Once verified, the whole verify block is hidden (CSS); the status line keeps "Verified".
      $('screen-session').classList.toggle('verified', verified);
      $('btn-sas-ok').disabled = !words || verified;
      $('btn-sas-bad').disabled = !words;
    },

    // state: idle | outgoing | incoming | active (from the call controller)
    renderCall(state, kind) {
      const idle = state === 'idle';
      const video = kind === 'video';
      // Incoming and in-call states are laid out as their own screens (CSS keys off data-call).
      $('screen-session').dataset.call = state;
      show('btn-call-audio', idle);
      show('btn-call-video', idle);
      show('incoming', state === 'incoming');
      if (state === 'incoming') {
        $('incoming-text').textContent = video ? 'Video call' : 'Audio call';
        // An audio call is accepted with audio only, so its single "Accept" is the audio button.
        show('btn-accept-video', video);
        $('btn-accept-audio').textContent = video ? 'Audio only' : 'Accept';
        $('btn-accept-audio').className = video ? 'ghost' : '';
      }
      show('btn-hangup', state === 'outgoing' || state === 'active');
      show('btn-mute', state === 'active');
      show('btn-camera', state === 'active' && ui.hasLocalVideo());
      show('videos', state === 'outgoing' || state === 'active');
      // While active, #call-state holds the call timer (started from the 'active' event).
      if (state !== 'active') {
        ui.stopCallTimer();
        $('call-state').textContent = state === 'outgoing' ? 'Calling…' : '';
      }
      if (idle) {
        ui.setStream('video-local', null);
        ui.setStream('video-remote', null);
        ui.setMicLabel(true);
        ui.setCameraLabel(true);
      }
    },

    startCallTimer() {
      ui.stopCallTimer();
      const start = Date.now();
      const tick = () => {
        const s = Math.floor((Date.now() - start) / 1000);
        $('call-state').textContent = `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
      };
      tick();
      callTimer = setInterval(tick, 1000);
    },

    stopCallTimer() {
      clearInterval(callTimer);
      callTimer = undefined;
    },

    // The element still plays audio while hidden; it is only shown when the stream carries video
    // (re-checked when tracks arrive later), so audio-only calls show no black box.
    setStream(id, stream) {
      const v = $(id);
      const prev = v.srcObject;
      if (prev && prev !== stream) prev.onaddtrack = prev.onremovetrack = null;
      v.srcObject = stream;
      const update = () => show(id, Boolean(stream && stream.getVideoTracks().length > 0));
      update();
      if (stream) {
        stream.onaddtrack = stream.onremovetrack = update;
        v.play().catch(() => {});
      }
    },

    hasLocalVideo() {
      const s = $('video-local').srcObject;
      return Boolean(s && s.getVideoTracks().length > 0);
    },

    setMicLabel(on) {
      $('btn-mute').textContent = on ? 'Mute' : 'Unmute';
    },

    setCameraLabel(on) {
      $('btn-camera').textContent = on ? 'Camera off' : 'Camera on';
    },

    // Clears everything that belongs to one connection.
    resetSession() {
      $('chat-log').textContent = '';
      $('chat-input').value = '';
      ui.setSas(null);
      ui.renderCall('idle');
    }
  };
  return ui;
}
