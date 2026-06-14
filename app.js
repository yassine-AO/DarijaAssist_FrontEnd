/* ========================================
   DarijaAssist — App Logic
   ======================================== */

(() => {
  'use strict';

  // --- Configuration ---
  const API_BASE = 'http://localhost:8000';
  const HEALTH_POLL_MS = 3000;
  const CHAR_REVEAL_MS = 30; // milliseconds per character for streaming text

  // --- DOM Refs ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    loadingOverlay: $('#loading-overlay'),
    loadingModels: $('#loading-models'),
    app: $('#app'),
    headerStatus: $('#header-status'),
    stateIdle: $('#state-idle'),
    stateListening: $('#state-listening'),
    stateProcessing: $('#state-processing'),
    stateAnswer: $('#state-answer'),
    stateError: $('#state-error'),
    servicesGrid: $('#services-grid'),
    waveformCanvas: $('#waveform-canvas'),
    answerCard: $('#answer-card'),
    answerAudioIndicator: $('#answer-audio-indicator'),
    answerText: $('#answer-text'),
    answerSource: $('#answer-source'),
    btnAskAgain: $('#btn-ask-again'),
    errorMessage: $('#error-message'),
    errorDetail: $('#error-detail'),
    btnRetry: $('#btn-retry'),
    micButton: $('#mic-button'),
    micIconRecord: $('#mic-icon-record'),
    micIconStop: $('#mic-icon-stop'),
    micPulse: $('#mic-pulse'),
  };

  // --- State ---
  let currentState = 'loading'; // loading | idle | listening | processing | answer | error
  let mediaRecorder = null;
  let audioChunks = [];
  let audioStream = null;
  let analyserNode = null;
  let animFrameId = null;
  let currentAudio = null;

  // --- Service Icons (SVG paths) ---
  const serviceIcons = {
    cnss: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    amo: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    cin: '<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="7" y1="15" x2="13" y2="15"/>',
    moqawala: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>',
  };

  // =====================
  //  State Machine
  // =====================
  function switchState(newState) {
    currentState = newState;

    // Hide all states
    [dom.stateIdle, dom.stateListening, dom.stateProcessing, dom.stateAnswer, dom.stateError].forEach(s => {
      s.classList.remove('active');
    });

    // Show target state
    const stateMap = {
      idle: dom.stateIdle,
      listening: dom.stateListening,
      processing: dom.stateProcessing,
      answer: dom.stateAnswer,
      error: dom.stateError,
    };

    if (stateMap[newState]) {
      stateMap[newState].classList.add('active');
    }

    // Mic button visibility
    if (newState === 'processing') {
      dom.micButton.disabled = true;
    } else {
      dom.micButton.disabled = false;
    }

    // Mic icon
    if (newState === 'listening') {
      dom.micIconRecord.classList.add('hidden');
      dom.micIconStop.classList.remove('hidden');
      dom.micButton.classList.add('recording');
      dom.micPulse.classList.add('active');
    } else {
      dom.micIconRecord.classList.remove('hidden');
      dom.micIconStop.classList.add('hidden');
      dom.micButton.classList.remove('recording');
      dom.micPulse.classList.remove('active');
    }
  }

  // =====================
  //  Health Check
  // =====================
  async function checkHealth() {
    try {
      const res = await fetch(`${API_BASE}/ping`);
      if (!res.ok) throw new Error('ping failed');
      const data = await res.json();
      return data;
    } catch {
      return null;
    }
  }

  function renderModelTags(models) {
    if (!models) return;
    dom.loadingModels.innerHTML = Object.entries(models)
      .map(([name, loaded]) => `
        <span class="model-tag ${loaded ? 'loaded' : ''}">
          <span class="tag-dot"></span>
          ${name.charAt(0).toUpperCase() + name.slice(1)}
        </span>
      `).join('');
  }

  async function initHealthLoop() {
    const poll = async () => {
      const data = await checkHealth();
      if (data && data.models_loaded) {
        renderModelTags(data.models_loaded);
        const allReady = Object.values(data.models_loaded).every(v => v === true);
        if (allReady) {
          // All models loaded — reveal app
          setTimeout(() => {
            dom.loadingOverlay.classList.add('hidden');
            dom.app.classList.remove('hidden');
            switchState('idle');
          }, 600);
          return;
        }
      }
      setTimeout(poll, HEALTH_POLL_MS);
    };
    poll();
  }

  // =====================
  //  Services
  // =====================
  async function loadServices() {
    try {
      const res = await fetch(`${API_BASE}/services`);
      if (!res.ok) throw new Error('services failed');
      const data = await res.json();
      renderServices(data.services);
    } catch {
      // Fallback services
      renderServices([
        { id: 'cnss', label_darija: 'الصندوق الوطني للضمان الاجتماعي', label_latin: 'CNSS' },
        { id: 'amo', label_darija: 'التأمين الإجباري عن المرض', label_latin: 'AMO' },
        { id: 'cin', label_darija: 'البطاقة الوطنية', label_latin: 'CIN' },
        { id: 'moqawala', label_darija: 'المقاولة', label_latin: 'Moqawala' },
      ]);
    }
  }

  function renderServices(services) {
    dom.servicesGrid.innerHTML = services.map((s, i) => `
      <div class="service-card" data-service="${s.id}" style="animation-delay: ${i * 80}ms" tabindex="0" role="button" aria-label="${s.label_latin}">
        <div class="service-icon">
          <svg viewBox="0 0 24 24">${serviceIcons[s.id] || serviceIcons.cnss}</svg>
        </div>
        <span class="service-label-ar" dir="rtl">${s.label_darija}</span>
        <span class="service-label-lat">${s.label_latin}</span>
      </div>
    `).join('');

    // Add staggered entrance animation
    dom.servicesGrid.querySelectorAll('.service-card').forEach((card, i) => {
      card.style.opacity = '0';
      card.style.transform = 'translateY(12px)';
      setTimeout(() => {
        card.style.transition = `all ${300}ms var(--ease-out)`;
        card.style.opacity = '1';
        card.style.transform = 'translateY(0)';
      }, 100 + i * 80);
    });
  }

  // =====================
  //  Audio Recording
  // =====================
  async function startRecording() {
    try {
      audioChunks = [];
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Set up analyser for waveform
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(audioStream);
      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      mediaRecorder = new MediaRecorder(audioStream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm'
      });

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        stopWaveformAnimation();
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        sendAudio(blob);
      };

      mediaRecorder.start(100);
      switchState('listening');
      startWaveformAnimation();
    } catch (err) {
      console.error('Mic access denied:', err);
      showError('ما قدرناش نوصلو للميكروفون', 'Please allow microphone access in your browser settings.');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    if (audioStream) {
      audioStream.getTracks().forEach(t => t.stop());
      audioStream = null;
    }
    switchState('processing');
  }

  // =====================
  //  Waveform Visualization
  // =====================
  function startWaveformAnimation() {
    const canvas = dom.waveformCanvas;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const bufLen = analyserNode.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);

    const barCount = 48;
    const barWidth = 3;
    const gap = (w - barCount * barWidth) / (barCount - 1);

    function draw() {
      analyserNode.getByteFrequencyData(dataArr);
      ctx.clearRect(0, 0, w, h);

      for (let i = 0; i < barCount; i++) {
        const dataIndex = Math.floor(i * bufLen / barCount);
        const value = dataArr[dataIndex] / 255;
        const barH = Math.max(3, value * h * 0.8);
        const x = i * (barWidth + gap);
        const y = (h - barH) / 2;

        // Gradient fill
        const gradient = ctx.createLinearGradient(0, y, 0, y + barH);
        gradient.addColorStop(0, `rgba(129, 140, 248, ${0.4 + value * 0.6})`);
        gradient.addColorStop(1, `rgba(99, 102, 241, ${0.3 + value * 0.5})`);

        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barH, barWidth / 2);
        ctx.fill();
      }

      animFrameId = requestAnimationFrame(draw);
    }

    draw();
  }

  function stopWaveformAnimation() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  // =====================
  //  API — Send Audio
  // =====================
  async function sendAudio(audioBlob) {
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');

      const res = await fetch(`${API_BASE}/ask`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || `Server error: ${res.status}`);
      }

      const data = await res.json();
      showAnswer(data);
    } catch (err) {
      console.error('Pipeline error:', err);
      showError('وقع مشكل فالمعالجة', err.message || 'An error occurred while processing your question.');
    }
  }

  // =====================
  //  Show Answer
  // =====================
  function showAnswer(data) {
    switchState('answer');

    // Reset
    dom.answerText.innerHTML = '';
    dom.answerSource.classList.remove('visible');
    dom.answerSource.innerHTML = '';
    dom.answerAudioIndicator.classList.remove('done');
    const audioLabel = dom.answerAudioIndicator.querySelector('.audio-label');
    audioLabel.textContent = 'كيتكلم...';

    // Play audio automatically
    if (data.answer_audio_b64) {
      playBase64Audio(data.answer_audio_b64);
    }

    // Stream text with character reveal
    if (data.answer_text_darija) {
      streamText(data.answer_text_darija);
    }

    // Show source
    if (data.source && data.source.document_name) {
      setTimeout(() => {
        dom.answerSource.innerHTML = `
          <span class="source-tag">
            <svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            ${data.source.document_name}
          </span>
        `;
        dom.answerSource.classList.add('visible');
      }, Math.min(data.answer_text_darija.length * CHAR_REVEAL_MS, 3000));
    }
  }

  function streamText(text) {
    dom.answerText.innerHTML = '';
    const chars = text.split('');
    chars.forEach((char, i) => {
      const span = document.createElement('span');
      span.className = 'char';
      span.textContent = char;
      span.style.animationDelay = `${i * CHAR_REVEAL_MS}ms`;
      dom.answerText.appendChild(span);
    });
  }

  // =====================
  //  Audio Playback
  // =====================
  function playBase64Audio(b64) {
    try {
      // Stop any currently playing audio
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }

      const byteChars = atob(b64);
      const byteArray = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        byteArray[i] = byteChars.charCodeAt(i);
      }

      const blob = new Blob([byteArray], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      currentAudio = audio;

      audio.addEventListener('ended', () => {
        dom.answerAudioIndicator.classList.add('done');
        const audioLabel = dom.answerAudioIndicator.querySelector('.audio-label');
        audioLabel.textContent = 'سالي';
        URL.revokeObjectURL(url);
        currentAudio = null;
      });

      audio.addEventListener('error', () => {
        dom.answerAudioIndicator.classList.add('done');
        const audioLabel = dom.answerAudioIndicator.querySelector('.audio-label');
        audioLabel.textContent = 'خطأ';
        currentAudio = null;
      });

      audio.play().catch(err => {
        console.warn('Autoplay blocked:', err);
        dom.answerAudioIndicator.classList.add('done');
      });
    } catch (err) {
      console.error('Audio decode error:', err);
    }
  }

  // =====================
  //  Error
  // =====================
  function showError(message, detail) {
    dom.errorMessage.textContent = message;
    dom.errorDetail.textContent = detail || '';
    switchState('error');
  }

  // =====================
  //  Event Listeners
  // =====================
  dom.micButton.addEventListener('click', () => {
    if (currentState === 'listening') {
      stopRecording();
    } else if (currentState === 'idle' || currentState === 'answer' || currentState === 'error') {
      // Stop any playing audio
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }
      startRecording();
    }
  });

  dom.btnAskAgain.addEventListener('click', () => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    switchState('idle');
  });

  dom.btnRetry.addEventListener('click', () => {
    switchState('idle');
  });

  // Keyboard accessibility
  dom.micButton.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      dom.micButton.click();
    }
  });

  // =====================
  //  Initialization
  // =====================
  function init() {
    loadServices();
    initHealthLoop();
  }

  // Start when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Dev mode: skip health check with ?dev query param
  if (window.location.search.includes('dev')) {
    setTimeout(() => {
      dom.loadingOverlay.classList.add('hidden');
      dom.app.classList.remove('hidden');
      switchState('idle');
    }, 500);
  }
})();
