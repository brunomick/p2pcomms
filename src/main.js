import { joinRoom, getRelaySockets, pauseRelayReconnection, resumeRelayReconnection, selfId } from 'trystero/nostr';
import { generateCode } from './code.js';
import { createSession, WAIT_TIMEOUT_MS } from './session.js';
import { extractFingerprint, runSasExchange } from './sas.js';
import { createCall } from './call.js';
import { createUi } from './ui.js';

const MAX_CHAT = 4000;
const SAS_TIMEOUT_MS = 20000;

const TEXT = {
  preparing: 'Preparing…',
  waiting: 'Waiting…',
  connecting: 'Connecting…',
  connected: 'Direct',
  invalidCode: 'Invalid code. Use 4 words.',
  expired: 'Code expired.',
  failed:
    'No direct route. Likely CGNAT or a mobile/work network.\n' +
    "Check: if your router's WAN IP differs from your public IP, you're behind CGNAT.",
  peerLeft: 'Peer left.',
  sasMismatch: "Words didn't match. Disconnected.",
  sasFailed: "Couldn't verify. Disconnected.",
  rejected: 'Declined.',
  noCamera: 'No camera. Audio only.',
  noMic: "No mic. They can't hear you.",
  noDevices: 'No camera or mic. Receive only.'
};

const ui = createUi(document);
const $ = ui.$;

// State of the current direct connection; null when there is none.
let conn = null;

const getUserMedia = navigator.mediaDevices
  ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
  : () => Promise.reject(new Error('no-media-devices'));

const session = createSession({
  trystero: { joinRoom, getRelaySockets, pauseRelayReconnection, resumeRelayReconnection },
  RTCPeerConnection: window.RTCPeerConnection,
  onEvent: onSessionEvent
});

function backToStart(statusText = '', tone = '') {
  if (conn) {
    conn.call.dispose();
    conn = null;
  }
  ui.resetSession();
  ui.showCode(null);
  ui.setError(null);
  ui.showScreen('start');
  ui.setStatus(statusText, tone);
}

function onSessionEvent(type, detail) {
  switch (type) {
    case 'invalid-code':
      backToStart(TEXT.invalidCode, 'bad');
      ui.showJoinForm();
      break;
    case 'waiting':
      ui.setStatus(TEXT.waiting);
      ui.startCountdown(WAIT_TIMEOUT_MS);
      break;
    case 'connecting':
      ui.setStatus(TEXT.connecting);
      break;
    case 'connected':
      ui.showCode(null);
      ui.showScreen('session');
      ui.setStatus(TEXT.connected, 'ok');
      startConnection(detail.peerId);
      break;
    case 'expired':
      backToStart(TEXT.expired, 'bad');
      break;
    case 'failed':
      backToStart(TEXT.failed, 'bad');
      break;
    case 'peer-left':
      backToStart(TEXT.peerLeft, 'bad');
      break;
  }
}

function startConnection(peerId) {
  const room = session.room;
  const c = {
    peerId,
    micOn: true,
    cameraOn: true,
    call: null,
    sendChat: null
  };
  conn = c;
  const isCurrent = () => conn === c;

  const chat = room.makeAction('chat');
  chat.onMessage = (data, ctx) => {
    if (!isCurrent() || ctx?.peerId !== peerId || typeof data !== 'string') return;
    ui.addChat('them', data.slice(0, MAX_CHAT));
  };
  c.sendChat = text => chat.send(text, { target: peerId }).catch(() => {});

  c.call = createCall({
    room,
    peerId,
    getUserMedia,
    MediaStream: window.MediaStream,
    onEvent: (type, detail) => {
      if (isCurrent()) onCallEvent(c, type, detail);
    }
  });

  ui.resetSession();
  startSas(c, room);
}

// Handlers are attached synchronously from the 'connected' event, so the peer's first SAS
// message (sent once it is connected too) cannot arrive before we listen.
function startSas(c, room) {
  const sas = room.makeAction('sas');
  let deliver = null;
  let settled = false;
  sas.onMessage = (data, ctx) => {
    if (!settled && ctx?.peerId === c.peerId) deliver?.(data);
  };
  const run = async () => {
    const pc = session.getPeerConnection();
    const localSdp = pc?.localDescription?.sdp;
    const remoteSdp = pc?.remoteDescription?.sdp;
    if (!localSdp || !remoteSdp) throw new Error('no-peer-connection');
    return runSasExchange({
      selfId,
      peerId: c.peerId,
      localFp: extractFingerprint(localSdp),
      remoteFp: extractFingerprint(remoteSdp),
      send: msg => {
        sas.send(msg, { target: c.peerId }).catch(() => {});
      },
      subscribe: handler => {
        deliver = handler;
      }
    });
  };
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('sas-timeout')), SAS_TIMEOUT_MS);
  });
  Promise.race([run(), timeout]).then(
    words => {
      clearTimeout(timer);
      settled = true;
      if (conn === c) {
        c.words = words;
        ui.setSas(words);
      }
    },
    () => {
      // Timeout, missing peer connection/fingerprint or a broken exchange: the words were never
      // compared, so say verification failed rather than that they did not match.
      clearTimeout(timer);
      settled = true;
      if (conn === c) abortForSecurity(TEXT.sasFailed);
    }
  );
}

function abortForSecurity(message) {
  session.leave();
  backToStart();
  ui.setError(message);
}

function onCallEvent(c, type, detail) {
  switch (type) {
    case 'incoming':
      c.incomingKind = detail.kind;
      break;
    case 'active':
      ui.startCallTimer();
      break;
    case 'local-stream':
      ui.setStream('video-local', detail.stream);
      break;
    case 'remote-stream':
      ui.setStream('video-remote', detail.stream);
      break;
    case 'media-warning': {
      const m = detail.missing;
      ui.setError(m.length > 1 ? TEXT.noDevices : m[0] === 'video' ? TEXT.noCamera : TEXT.noMic);
      break;
    }
    case 'rejected':
      ui.setError(TEXT.rejected);
      break;
    case 'ended':
      ui.setError(null);
      break;
  }
  renderCall(c);
}

function renderCall(c) {
  if (c.call.state === 'idle') c.micOn = c.cameraOn = true;
  ui.renderCall(c.call.state, c.incomingKind);
}

// --- Start screen ---

$('btn-new').addEventListener('click', () => {
  const code = generateCode();
  ui.setError(null);
  ui.showCode(code);
  ui.showScreen('waiting');
  ui.setStatus(TEXT.preparing);
  session.start(code);
});

$('btn-have-code').addEventListener('click', () => ui.showJoinForm());

$('btn-back').addEventListener('click', () => {
  ui.setStatus('');
  ui.setError(null);
  ui.showHome();
});

$('btn-privacy').addEventListener('click', () => ui.togglePrivacy());

$('join-form').addEventListener('submit', e => {
  e.preventDefault();
  ui.setError(null);
  ui.showCode(null);
  ui.showScreen('waiting');
  ui.setStatus(TEXT.preparing);
  session.start($('code-input').value);
});

// --- Waiting screen ---

$('btn-copy').addEventListener('click', () => {
  const code = $('code-display').textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(code).then(() => ui.setCopied(), () => selectCode());
  } else {
    selectCode();
  }
});

function selectCode() {
  const range = document.createRange();
  range.selectNodeContents($('code-display'));
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

$('btn-cancel').addEventListener('click', () => {
  session.leave();
  backToStart();
});

// --- Session screen ---

$('btn-sas-ok').addEventListener('click', () => {
  if (conn?.words) ui.setSas(conn.words, true);
});

$('btn-sas-bad').addEventListener('click', () => {
  if (conn) abortForSecurity(TEXT.sasMismatch);
});

$('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('chat-input');
  const text = input.value.trim().slice(0, MAX_CHAT);
  if (!conn || !text) return;
  conn.sendChat(text);
  ui.addChat('me', text);
  input.value = '';
});

function callAction(fn) {
  return async () => {
    const c = conn;
    if (!c) return;
    ui.setError(null);
    const pending = fn(c);
    renderCall(c);
    await pending;
    if (conn === c) renderCall(c);
  };
}

$('btn-call-audio').addEventListener('click', callAction(c => c.call.invite('audio')));
$('btn-call-video').addEventListener('click', callAction(c => c.call.invite('video')));
$('btn-accept-video').addEventListener('click', callAction(c => c.call.accept(true)));
$('btn-accept-audio').addEventListener('click', callAction(c => c.call.accept(false)));
$('btn-reject').addEventListener('click', callAction(c => c.call.reject()));
$('btn-hangup').addEventListener('click', callAction(c => c.call.hangup()));

$('btn-mute').addEventListener('click', () => {
  if (!conn) return;
  conn.micOn = !conn.micOn;
  conn.call.setMicEnabled(conn.micOn);
  ui.setMicLabel(conn.micOn);
});

$('btn-camera').addEventListener('click', () => {
  if (!conn) return;
  conn.cameraOn = !conn.cameraOn;
  conn.call.setCameraEnabled(conn.cameraOn);
  ui.setCameraLabel(conn.cameraOn);
});

$('btn-leave').addEventListener('click', () => {
  session.leave();
  backToStart();
});
