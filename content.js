// Audio FX — Universal Sound Enhancer
// Перехватывает все <audio>/<video> на странице через Web Audio API и прогоняет
// звук через цепочку: дисторшн → бас/средние/высокие (эквалайзер) → ревёрб.
// Скорость воспроизведения (замедление/ускорение) регулируется напрямую через
// HTMLMediaElement.playbackRate (естественно тянет за собой изменение тона —
// это и есть эффект "slowed", а не тайм-стрейтчинг без изменения питча).

if (!window.__afxLoaded) {
  window.__afxLoaded = true;

  const DEFAULTS = {
    enabled: true,
    distortion: 0,   // 0..100
    bass: 0,          // -15..15 дБ
    mid: 0,           // -15..15 дБ
    treble: 0,        // -15..15 дБ
    reverb: 0,        // 0..100 — микс (wet) хвоста
    reverbDecay: 2.2, // 0.5..6 сек — длина хвоста импульсного отклика
    reverbPreDelay: 0, // 0..200 мс — пауза перед началом хвоста
    delay: 0,         // 0..100 — микс дилея
    delayTime: 300,   // 50..800 мс — время задержки повтора
    tremolo: 0,       // 0..100 — глубина/частота пульсации громкости
    autopan: 0,       // 0..100 — глубина/частота вращения стерео-картины (8D)
    normalize: 0,     // 0..100 — 0 выключено; иначе цель по громкости для автовыравнивания между треками
    rate: 100,        // 25..200 (%), 100 = обычная скорость
    pos: { x: 0.95, y: 0.92 }, // положение кружка — доля от ширины/высоты страницы
  };

  // Ключи, которые входят в пресет (без pos/enabled — те не про звук, а про UI-состояние).
  const PRESET_KEYS = [
    "distortion", "bass", "mid", "treble",
    "reverb", "reverbDecay", "reverbPreDelay",
    "delay", "delayTime", "tremolo", "autopan", "normalize", "rate",
  ];

  const BUILT_IN_PRESETS = {
    "Чисто": { distortion: 0, bass: 0, mid: 0, treble: 0, reverb: 0, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100 },
    "Тёплый бас": { distortion: 0, bass: 8, mid: 0, treble: -3, reverb: 0, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100 },
    "Дисторшн-рок": { distortion: 55, bass: 4, mid: -2, treble: 3, reverb: 10, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100 },
    "Slowed + Reverb": { distortion: 0, bass: 3, mid: 0, treble: -2, reverb: 55, reverbDecay: 4.5, reverbPreDelay: 30, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 60 },
    "Космос": { distortion: 0, bass: 0, mid: 0, treble: 2, reverb: 40, reverbDecay: 5, reverbPreDelay: 20, delay: 20, delayTime: 400, tremolo: 0, autopan: 70, normalize: 0, rate: 100 },
    "Пульс": { distortion: 10, bass: 5, mid: 0, treble: 0, reverb: 10, delay: 0, tremolo: 55, autopan: 0, normalize: 0, rate: 100 },
  };

  let settings = { ...DEFAULTS };
  let userPresets = {}; // имя -> { ...PRESET_KEYS }
  let audioCtx = null;
  const hooked = new WeakMap(); // HTMLMediaElement -> { nodes }
  const hookedSet = new Set();  // те же { nodes } бандлы, но для перебора в loudnessTick()

  // ── Хранилище настроек ──────────────────────────────────────────────────
  function loadSettings(cb) {
    try {
      chrome.storage.local.get(["afxSettings"], (res) => {
        if (res && res.afxSettings) settings = { ...DEFAULTS, ...res.afxSettings };
        cb();
      });
    } catch (e) {
      cb();
    }
  }

  function saveSettings() {
    try { chrome.storage.local.set({ afxSettings: settings }); } catch (e) {}
  }

  function loadUserPresets(cb) {
    try {
      chrome.storage.local.get(["afxUserPresets"], (res) => {
        userPresets = (res && res.afxUserPresets) || {};
        cb();
      });
    } catch (e) {
      cb();
    }
  }

  function saveUserPresets() {
    try { chrome.storage.local.set({ afxUserPresets: userPresets }); } catch (e) {}
  }

  function presetFromSettings() {
    const p = {};
    PRESET_KEYS.forEach((k) => { p[k] = settings[k]; });
    return p;
  }

  function applyPreset(preset) {
    PRESET_KEYS.forEach((k) => { if (preset[k] !== undefined) settings[k] = preset[k]; });
  }

  // ── DSP-хелперы ──────────────────────────────────────────────────────────
  // Важно: рост громкости от дисторшна — это в основном буст ТИХИХ и средних
  // участков (кривая у нуля становится очень крутой и быстро выходит на полку),
  // а не рост пика — пик как раз наоборот прижимается. Фиксированная компенсация
  // числами компрессора не работает одинаково хорошо на любом материале: то, что
  // ровно компенсирует тихий подкаст, "перекомпенсирует" плотный трек, и наоборот.
  // Поэтому громкость не подгоняется заранее подобранными цифрами — она меряется
  // в реальном времени (RMS до/после дисторшна) и выравнивается на лету узлом
  // makeupGain, см. loudnessTick() ниже. Компрессор в цепочке остаётся, но только
  // как мягкий защитный лимитер пиков, а не как инструмент выравнивания громкости.
  function makeDistortionCurve(amount) {
    const k = amount * 6;
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1;
      curve[i] = k === 0 ? x : ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
    }
    return curve;
  }

  function makeImpulseResponse(ctx, duration = 2.2, decay = 3) {
    const rate = ctx.sampleRate;
    const length = Math.floor(rate * duration);
    const impulse = ctx.createBuffer(2, length, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return impulse;
  }

  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  // ── Подключение одного media-элемента к графу эффектов ─────────────────
  function hookElement(el) {
    if (hooked.has(el)) return;
    if (el.__afxFailed) return;

    let ctx, source;
    try {
      ctx = getAudioCtx();
      source = ctx.createMediaElementSource(el);
    } catch (e) {
      // Элемент уже подключён к другому AudioContext/ноде — пропускаем без шума.
      el.__afxFailed = true;
      return;
    }

    const preGain = ctx.createGain(); // небольшой запас на вход перед дисторшном

    const distortion = ctx.createWaveShaper();
    distortion.oversample = "4x";

    // Мягкий защитный лимитер пиков — фиксированные консервативные параметры,
    // не зависят от drive. За выравнивание громкости отвечает не он, а
    // makeupGain ниже (см. loudnessTick).
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.ratio.value = 3;
    compressor.knee.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.15;

    // Анализаторы для измерения RMS до дисторшна и сразу после неё (до того,
    // как громкость выровнена). Им не нужно подключение к destination — они
    // просто читают сигнал, который через них проходит транзитом.
    const preAnalyser = ctx.createAnalyser();
    preAnalyser.fftSize = 1024;
    const postAnalyser = ctx.createAnalyser();
    postAnalyser.fftSize = 1024;

    // Эта нода реально удерживает громкость на месте: её gain непрерывно
    // подстраивается в loudnessTick() под соотношение RMS(вход)/RMS(выход)
    // дисторшн-цепочки, независимо от drive и от того, что играет.
    const makeupGain = ctx.createGain();

    const bass   = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 200;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    mid.Q.value = 1;

    const treble = ctx.createBiquadFilter();
    treble.type = "highshelf";
    treble.frequency.value = 3000;

    const dryGain = ctx.createGain();
    const wetGain = ctx.createGain();
    const convolver = ctx.createConvolver();
    // Буфер impulse response выставляется в applySettingsToNode() при первом
    // же вызове (nodes.reverbDecayApplied стартует как null) — там же он
    // пересчитывается только когда decay реально меняется, см. комментарий там.

    // Pre-delay ревёрба: пауза перед началом хвоста, отдельная ветка перед convolver.
    const reverbPreDelay = ctx.createDelay(1);

    // Дилей/эхо: отдельная параллельная ветка с обратной связью. FeedbackGain —
    // фиксированное значение (не выведено в UI), чтобы при высоком "Дилей"+"Время"
    // не улететь в самовозбуждение — только творческие ручки наружу, как и с лимитером.
    const delayNode = ctx.createDelay(1);
    const delayFeedback = ctx.createGain();
    delayFeedback.gain.value = 0.35;
    const delayWetGain = ctx.createGain();
    delayNode.connect(delayFeedback);
    delayFeedback.connect(delayNode);

    // Тремоло — пульсация громкости от LFO. tremoloGain — несущая нода в цепи,
    // её gain.value (базовый уровень) двигает applySettingsToNode, а
    // tremoloDepthGain добавляет к нему переменную составляющую от синус-осциллятора.
    // При глубине 0 базовый уровень = 1 и вклад LFO = 0 — прозрачный bypass без
    // отдельного disconnect/connect, осциллятор дешёвый и может крутиться вхолостую.
    const tremoloGain = ctx.createGain();
    const tremoloLFO = ctx.createOscillator();
    tremoloLFO.type = "sine";
    // Дефолт OscillatorNode.frequency — 440 Гц, а не 0: если не выставить сразу
    // нужный диапазон, первый applySettingsToNode() будет полавно (через ramp(),
    // это ~100мс) стягивать частоту с 440 Гц вниз к целевым 2–10 Гц, и это же
    // касается depthGain (дефолт GainNode.gain — 1, а не 0) — вместе на пару
    // сотен миллисекунд получится слышимый "зип" по громкости при подключении
    // элемента, даже если ползунок Тремоло стоит на нуле.
    tremoloLFO.frequency.value = 2;
    const tremoloDepthGain = ctx.createGain();
    tremoloDepthGain.gain.value = 0;
    tremoloLFO.connect(tremoloDepthGain);
    tremoloDepthGain.connect(tremoloGain.gain);
    tremoloLFO.start();

    // 8D/авто-панорама — тот же принцип LFO, но модулирует StereoPannerNode.pan
    // вместо громкости: звук "вращается" между левым и правым каналом. Та же
    // оговорка с дефолтами осциллятора/gain, что и у тремоло — см. комментарий выше.
    const panNode = ctx.createStereoPanner();
    const panLFO = ctx.createOscillator();
    panLFO.type = "sine";
    panLFO.frequency.value = 0.15;
    const panDepthGain = ctx.createGain();
    panDepthGain.gain.value = 0;
    panLFO.connect(panDepthGain);
    panDepthGain.connect(panNode.pan);
    panLFO.start();

    source.connect(preGain);
    preGain.connect(preAnalyser);
    preGain.connect(distortion);
    distortion.connect(compressor);
    compressor.connect(postAnalyser);
    compressor.connect(makeupGain);
    makeupGain.connect(bass);
    bass.connect(mid);
    mid.connect(treble);

    treble.connect(tremoloGain);
    tremoloGain.connect(panNode);
    panNode.connect(dryGain);
    panNode.connect(delayNode);
    delayNode.connect(delayWetGain);
    // convolver подключается к графу только когда ревёрб реально используется —
    // см. setReverbConnected(). Свёртка — тяжёлая операция, гонять её постоянно
    // вхолостую (Ревёрб=0) — лишняя нагрузка на CPU телефона, которая увеличивает
    // риск щелчков/подвисаний звука.

    // Автовыравнивание громкости между треками (см. loudnessTick) — тот же
    // принцип, что и makeupGain у дисторшна (RMS в реальном времени → подстройка
    // gain), но здесь на ИТОГОВОМ смешанном сигнале (dry+wet+delay) и с гораздо
    // более медленной реакцией: цель не "выровнять компрессией внутри трека", а
    // мягко подтянуть средний уровень К ДРУГИМ трекам, без "дыхания" на слух.
    const masterGain = ctx.createGain();
    const normAnalyser = ctx.createAnalyser();
    normAnalyser.fftSize = 1024;

    dryGain.connect(normAnalyser);
    wetGain.connect(normAnalyser);
    delayWetGain.connect(normAnalyser);

    dryGain.connect(masterGain);
    wetGain.connect(masterGain);
    delayWetGain.connect(masterGain);
    masterGain.connect(ctx.destination);

    const nodes = {
      source, preGain, distortion, compressor, preAnalyser, postAnalyser, makeupGain,
      bass, mid, treble, convolver, reverbPreDelay, dryGain, wetGain,
      delayNode, delayFeedback, delayWetGain, masterGain, normAnalyser,
      tremoloGain, tremoloLFO, tremoloDepthGain, panNode, panLFO, panDepthGain,
      drive: 0,
      reverbConnected: false,
      reverbDecayApplied: null,
      preBuf: new Float32Array(preAnalyser.fftSize),
      postBuf: new Float32Array(postAnalyser.fftSize),
      normBuf: new Float32Array(normAnalyser.fftSize),
      normCurrentGain: null, // текущая коррекция автогромкости (множитель) — для UI, см. updateNormalizeStatus
      normLevelSmoothed: null, // долгосрочное сглаженное измерение громкости, см. loudnessTick
    };
    hooked.set(el, nodes);
    hookedSet.add(nodes);

    applySettingsToNode(nodes);
    applyRateToElement(el);

    el.addEventListener("play", () => {
      getAudioCtx();
      applyRateToElement(el);
    });
  }

  // Плавно подводим AudioParam к новому значению вместо мгновенного скачка
  // (`param.value = x`) — скачок создаёт разрыв в форме волны, который на
  // слух звучит как щелчок, особенно при быстром движении ползунка.
  const RAMP_TC = 0.02; // 20 мс — отклик ощущается мгновенным, но без разрыва
  function ramp(param, value) {
    param.setTargetAtTime(value, audioCtx.currentTime, RAMP_TC);
  }

  // Подключает/отключает ветку ревёрба (convolver) целиком. Держать свёртку
  // постоянно в графе, даже когда Ревёрб=0, — это лишняя постоянная нагрузка
  // на CPU без какого-либо слышимого эффекта.
  function setReverbConnected(nodes, connected) {
    if (connected === nodes.reverbConnected) return;
    if (connected) {
      nodes.panNode.connect(nodes.reverbPreDelay);
      nodes.reverbPreDelay.connect(nodes.convolver);
      nodes.convolver.connect(nodes.wetGain);
    } else {
      nodes.panNode.disconnect(nodes.reverbPreDelay);
      nodes.reverbPreDelay.disconnect(nodes.convolver);
      nodes.convolver.disconnect(nodes.wetGain);
    }
    nodes.reverbConnected = connected;
  }

  // ── Применение текущих настроек ─────────────────────────────────────────
  function applySettingsToNode(nodes) {
    const on = settings.enabled;
    const drive = on ? settings.distortion : 0;
    const t = drive / 100; // 0..1

    ramp(nodes.preGain.gain, 1 - t * 0.1); // небольшой запас на вход, чтобы 4x-oversample не клиппинговал раньше времени

    // Пересобираем кривую дисторшна (аллокация 44100-элементного Float32Array)
    // только когда drive реально изменился — а не на каждое движение любого
    // другого ползунка. Лишние аллокации на каждый input-event — это мусор
    // для GC, а его паузы во время рендера звука тоже слышны как щелчки.
    if (nodes.drive !== drive) {
      nodes.distortion.curve = makeDistortionCurve(drive);
      nodes.drive = drive;
    }

    if (drive <= 0) {
      // Дисторшн выключен — выравнивать нечего, сразу unity, не дожидаясь измерений RMS.
      nodes.makeupGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.05);
    }

    ramp(nodes.bass.gain,   on ? settings.bass   : 0);
    ramp(nodes.mid.gain,    on ? settings.mid    : 0);
    ramp(nodes.treble.gain, on ? settings.treble : 0);
    nodes.dryGain.gain.value = 1; // константа, скачков не бывает

    // Пересобираем impulse response (аллокация ~sampleRate*decay*2 канала) только
    // когда decay реально изменился — по той же причине, что и с кривой дисторшна:
    // не хотим GC-паузу на каждое движение любого другого ползунка.
    if (nodes.reverbDecayApplied !== settings.reverbDecay) {
      nodes.convolver.buffer = makeImpulseResponse(audioCtx, settings.reverbDecay, 3);
      nodes.reverbDecayApplied = settings.reverbDecay;
    }
    ramp(nodes.reverbPreDelay.delayTime, (on ? settings.reverbPreDelay : 0) / 1000);

    const reverbOn = on && settings.reverb > 0;
    setReverbConnected(nodes, reverbOn);
    ramp(nodes.wetGain.gain, reverbOn ? settings.reverb / 100 : 0);

    // Дилей/эхо — всегда в графе (DelayNode дешёвый), микс на нуле эквивалентен bypass.
    ramp(nodes.delayNode.delayTime, (on ? settings.delayTime : 0) / 1000);
    ramp(nodes.delayWetGain.gain, on && settings.delay > 0 ? settings.delay / 100 : 0);

    // Тремоло: один ползунок задаёт и глубину, и частоту пульсации — при 0 depth=0
    // и базовый gain=1, эффект прозрачен, LFO просто крутится вхолостую.
    const tremT = (on ? settings.tremolo : 0) / 100;
    ramp(nodes.tremoloLFO.frequency, 2 + tremT * 8);      // 2–10 Гц
    ramp(nodes.tremoloDepthGain.gain, tremT / 2);
    ramp(nodes.tremoloGain.gain, 1 - tremT / 2);

    // 8D/авто-панорама: аналогично, один ползунок на глубину+скорость вращения.
    const panT = (on ? settings.autopan : 0) / 100;
    ramp(nodes.panLFO.frequency, 0.15 + panT * 0.6);      // 0.15–0.75 Гц — полный оборот за ~1.3–6.7с
    ramp(nodes.panDepthGain.gain, panT);
  }

  // ── Автовыравнивание громкости после дисторшна ──────────────────────────
  // Дисторшн по своей природе задирает RMS тихих/средних участков сигнала —
  // это неотъемлемое свойство формы кривой (см. комментарий у
  // makeDistortionCurve), а не баг компрессора. Подобранные заранее цифры
  // компрессора не могут одинаково хорошо это компенсировать на любом
  // материале. Поэтому громкость меряется в реальном времени (RMS входа и
  // выхода дисторшн-цепочки) и подгоняется узлом makeupGain на лету, чтобы
  // итоговая громкость совпадала со входом независимо от drive и контента.
  function rms(analyser, buf) {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  const SILENCE = 0.002; // ниже этого — тишина/шум квантования, подстройку не делаем, чтобы gain не «гулял»

  // Целевой RMS для автовыравнивания громкости между треками, по слайдеру
  // "Автогромкость" (0..100 → -26дБ..-8дБ). Диапазон дБ, не линейный — так
  // совпадает с тем, как громкость реально воспринимается на слух.
  function normalizeTargetRms(sliderValue) {
    const t = sliderValue / 100;
    const targetDb = -26 + t * 18;
    return Math.pow(10, targetDb / 20);
  }

  function loudnessTick() {
    if (!audioCtx) return;
    const now = audioCtx.currentTime;
    hookedSet.forEach((nodes) => {
      if (nodes.drive > 0) {
        const inLevel  = rms(nodes.preAnalyser,  nodes.preBuf);
        const outLevel = rms(nodes.postAnalyser, nodes.postBuf);
        if (inLevel >= SILENCE && outLevel >= SILENCE) {
          const target = Math.min(4, Math.max(0.1, inLevel / outLevel));
          nodes.makeupGain.gain.setTargetAtTime(target, now, 0.15);
        }
      } // иначе makeupGain уже в unity, см. applySettingsToNode

      // Автовыравнивание громкости — независимо от makeupGain (тот компенсирует
      // именно дисторшн, этот — общий уровень итогового сигнала между треками).
      if (settings.enabled && settings.normalize > 0) {
        const instant = rms(nodes.normAnalyser, nodes.normBuf);
        if (instant >= SILENCE) {
          // Долгое сглаживание САМОГО ИЗМЕРЕНИЯ (не только применения gain) —
          // без этого gain гоняется за каждым моментальным значением RMS, и
          // получается не выравнивание между треками, а компрессия внутри
          // одного трека: на громкой секции (дроп, бас/барабаны) gain тут же
          // проседает — "съедает" их, а на тихой мелодии наоборот задирается
          // слишком высоко. Экспоненциальное усреднение с постоянной ~12с
          // сначала усредняет секции трека между собой, и только потом на это
          // реагирует коррекция — так она видит "трек в среднем", а не "что
          // играет прямо сейчас".
          if (nodes.normLevelSmoothed == null) {
            nodes.normLevelSmoothed = instant;
          } else {
            const tickSec = 0.05; // интервал самого тика, см. setInterval ниже
            const tc = 12;
            const a = tickSec / (tc + tickSec);
            nodes.normLevelSmoothed += a * (instant - nodes.normLevelSmoothed);
          }

          const targetRms = normalizeTargetRms(settings.normalize);
          // Широкий клэмп (0.2x..6x): не пытаемся вытянуть почти тишину в
          // полную громкость (звучало бы как шумодав, вытягивающий шипение
          // между нотами) и не режем неожиданно громкий материал в ноль.
          const gain = Math.min(6, Math.max(0.2, targetRms / nodes.normLevelSmoothed));
          nodes.masterGain.gain.setTargetAtTime(gain, now, 4);
          nodes.normCurrentGain = gain; // для UI, см. updateNormalizeStatus
        }
      } else {
        nodes.masterGain.gain.setTargetAtTime(1, now, 0.3);
        nodes.normCurrentGain = null;
        nodes.normLevelSmoothed = null; // следующее включение — измеряем заново, без "памяти" от прошлого раза
      }
    });
  }
  setInterval(loudnessTick, 50);

  function applyRateToElement(el) {
    try {
      el.playbackRate = settings.enabled ? settings.rate / 100 : 1;
      // По умолчанию браузер сам "выравнивает" тон при смене playbackRate —
      // именно это и даёт металлический/роботический призвук на низкой скорости.
      // Отключаем эту коррекцию: получаем честное винтажное "slowed" (тон падает
      // вместе со скоростью), звучит естественно, без артефактов алгоритма.
      el.preservesPitch = false;
      el.mozPreservesPitch = false;
      el.webkitPreservesPitch = false;
    } catch (e) {}
  }

  function applyAll() {
    for (const el of document.querySelectorAll("audio, video")) {
      hookElement(el);
      const nodes = hooked.get(el);
      if (nodes) applySettingsToNode(nodes);
      applyRateToElement(el);
    }
  }

  // ── Наблюдение за DOM: сайты подгружают/пересоздают плееры динамически ──
  function scanNode(node) {
    if (node.nodeType !== 1) return;
    if (node.tagName === "AUDIO" || node.tagName === "VIDEO") hookElement(node);
    node.querySelectorAll && node.querySelectorAll("audio, video").forEach(hookElement);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(scanNode);
    }
  });

  function startObserving() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    document.querySelectorAll("audio, video").forEach(hookElement);
  }

  // Первый пользовательский жест на странице — шанс снять suspended-статус контекста.
  ["click", "keydown", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, () => { if (audioCtx) getAudioCtx(); }, { once: true, capture: true });
  });

  // ── Плавающая панель управления ──────────────────────────────────────────
  function buildPanel() {
    const root = document.createElement("div");
    root.id = "afx-root";
    root.innerHTML = `
      <div id="afx-toggle" title="Audio FX"><img alt=""></div>
      <div id="afx-panel">
        <div id="afx-header">
          <span class="afx-title">Audio FX</span>
          <span id="afx-close">✕</span>
        </div>

        <div class="afx-row afx-preset-row">
          <div class="afx-row-label"><span>Пресет</span></div>
          <div class="afx-preset-controls">
            <select id="afx-preset-select"></select>
            <div class="afx-btn afx-btn-sm" id="afx-preset-save" title="Сохранить текущие настройки как пресет">💾</div>
            <div class="afx-btn afx-btn-sm" id="afx-preset-del" title="Удалить выбранный пресет">🗑</div>
          </div>
        </div>

        <div class="afx-row">
          <div class="afx-row-label"><span>Дисторшн</span><span class="afx-val" data-out="distortion"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="distortion">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Бас</span><span class="afx-val" data-out="bass"></span></div>
          <input type="range" min="-15" max="15" step="1" data-key="bass">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Средние</span><span class="afx-val" data-out="mid"></span></div>
          <input type="range" min="-15" max="15" step="1" data-key="mid">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Высокие</span><span class="afx-val" data-out="treble"></span></div>
          <input type="range" min="-15" max="15" step="1" data-key="treble">
        </div>

        <div class="afx-section">Ревёрб</div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Микс</span><span class="afx-val" data-out="reverb"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="reverb">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Хвост</span><span class="afx-val" data-out="reverbDecay"></span></div>
          <input type="range" min="0.5" max="6" step="0.1" data-key="reverbDecay">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Пре-дилей</span><span class="afx-val" data-out="reverbPreDelay"></span></div>
          <input type="range" min="0" max="200" step="5" data-key="reverbPreDelay">
        </div>

        <div class="afx-section">Дилей</div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Микс</span><span class="afx-val" data-out="delay"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="delay">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Время</span><span class="afx-val" data-out="delayTime"></span></div>
          <input type="range" min="50" max="800" step="10" data-key="delayTime">
        </div>

        <div class="afx-section">Громкость</div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Автогромкость</span><span class="afx-val" data-out="normalize"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="normalize"
            title="0 — выключено. Дальше — медленное (несколько секунд) выравнивание среднего уровня к целевой громкости, растёт с числом; треки перестают заметно отличаться друг от друга по громкости.">
          <div class="afx-sub-status" id="afx-normalize-status"></div>
        </div>

        <div class="afx-section">Другое</div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Тремоло</span><span class="afx-val" data-out="tremolo"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="tremolo">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>8D</span><span class="afx-val" data-out="autopan"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="autopan">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Скорость</span><span class="afx-val" data-out="rate"></span></div>
          <input type="range" min="25" max="200" step="1" data-key="rate">
        </div>

        <div class="afx-actions">
          <div class="afx-btn" id="afx-reset">Сброс</div>
          <div class="afx-btn afx-primary" id="afx-power">Вкл</div>
        </div>
        <div class="afx-status" id="afx-status">Эффекты применяются к audio/video на странице</div>
      </div>
    `;
    // src ставим отдельно (не через innerHTML/template-строку с подстановкой) —
    // addons-linter помечает динамические подстановки в innerHTML как unsafe,
    // даже когда значение полностью контролируется самим расширением.
    root.querySelector("#afx-toggle img").src = chrome.runtime.getURL("icons/toggle-icon.png");

    document.documentElement.appendChild(root);
    return root;
  }

  function fmtVal(key, v) {
    if (key === "bass" || key === "mid" || key === "treble") return (v > 0 ? "+" : "") + v + " дБ";
    if (key === "rate") return (v / 100).toFixed(2) + "×";
    if (key === "reverbDecay") return v.toFixed(1) + " с";
    if (key === "reverbPreDelay" || key === "delayTime") return v + " мс";
    return String(v);
  }

  // Пересобирает список пресетов в select (встроенные + пользовательские).
  // Вызывается при инициализации панели и после сохранения/удаления пресета.
  function refreshPresetOptions(root) {
    const sel = root.querySelector("#afx-preset-select");
    const prevValue = sel.value;
    sel.innerHTML = '<option value="">— выбрать пресет —</option>';

    const builtGroup = document.createElement("optgroup");
    builtGroup.label = "Встроенные";
    Object.keys(BUILT_IN_PRESETS).forEach((name) => {
      const opt = document.createElement("option");
      opt.value = "b:" + name;
      opt.textContent = name;
      builtGroup.appendChild(opt);
    });
    sel.appendChild(builtGroup);

    const userNames = Object.keys(userPresets);
    if (userNames.length) {
      const userGroup = document.createElement("optgroup");
      userGroup.label = "Мои";
      userNames.forEach((name) => {
        const opt = document.createElement("option");
        opt.value = "u:" + name;
        opt.textContent = name;
        userGroup.appendChild(opt);
      });
      sel.appendChild(userGroup);
    }

    if ([...sel.options].some((o) => o.value === prevValue)) sel.value = prevValue;
  }

  // Живое отображение текущей коррекции автогромкости (в духе "Текущее значение"
  // у AIMP) — сколько дБ прямо сейчас добавляет/убирает masterGain.
  function updateNormalizeStatus(root) {
    const el = root.querySelector("#afx-normalize-status");
    if (!el) return;
    if (!settings.normalize) { el.textContent = ""; return; }
    let node = null;
    hookedSet.forEach((n) => { if (!node) node = n; });
    if (!node || node.normCurrentGain == null) { el.textContent = "измеряю…"; return; }
    const db = 20 * Math.log10(node.normCurrentGain);
    el.textContent = (db >= 0 ? "+" : "") + db.toFixed(1) + " дБ";
  }

  function syncPanelUI(root) {
    root.querySelectorAll("input[type=range]").forEach((inp) => {
      const key = inp.dataset.key;
      inp.value = settings[key];
      const out = root.querySelector(`[data-out="${key}"]`);
      if (out) out.textContent = fmtVal(key, settings[key]);
    });
    updateNormalizeStatus(root);
    const powerBtn = root.querySelector("#afx-power");
    powerBtn.textContent = settings.enabled ? "Вкл" : "Выкл";
    powerBtn.classList.toggle("afx-primary", settings.enabled);
    root.querySelector("#afx-toggle").classList.toggle("active", settings.enabled);
  }

  function applyAndPersist(root) {
    for (const el of document.querySelectorAll("audio, video")) {
      const nodes = hooked.get(el);
      if (nodes) applySettingsToNode(nodes);
      applyRateToElement(el);
    }
    syncPanelUI(root);
    saveSettings();
  }

  // ── Позиционирование кружка: доля от разрешения страницы ─────────────────
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function positionRoot(root) {
    const size = 44;
    const left = clamp(settings.pos.x * window.innerWidth  - size / 2, 4, window.innerWidth  - size - 4);
    const top  = clamp(settings.pos.y * window.innerHeight - size / 2, 4, window.innerHeight - size - 4);
    root.style.left = left + "px";
    root.style.top  = top  + "px";
  }

  // Панель открывается в сторону, где есть место по вертикали (вверх/вниз),
  // а по горизонтали не прилипает жёстко к одному углу кружка — она едет
  // вместе с ним, центрируясь по его X, и только у самых краёв экрана
  // упирается в отступ, чтобы не улететь за пределы viewport. Так панель
  // свободно следует за кружком вдоль всей грани экрана, а не прыгает между
  // двумя фиксированными позициями.
  function positionPanel(root) {
    const panel  = root.querySelector("#afx-panel");
    const size   = 44; // ширина/высота кружка, см. #afx-root в panel.css
    const margin = 4;
    const rect   = root.getBoundingClientRect(); // координаты кружка во viewport

    const openUp = rect.top > window.innerHeight / 2;
    panel.style.top    = openUp ? "auto" : (size + 12) + "px";
    panel.style.bottom = openUp ? (size + 12) + "px" : "auto";

    // #afx-panel — position:absolute внутри #afx-root, поэтому left считаем
    // в координатах viewport и переводим в координаты относительно root.
    const panelW = panel.offsetWidth || 264;
    const desiredLeft = rect.left + size / 2 - panelW / 2;
    const clampedLeft = clamp(desiredLeft, margin, window.innerWidth - panelW - margin);
    panel.style.left  = (clampedLeft - rect.left) + "px";
    panel.style.right = "auto";
  }

  // Общий механизм drag для кружка и заголовка панели: если мышь/палец
  // сдвинулись меньше порога — считаем это кликом (onClick), иначе — перетаскиванием.
  function makeDraggable(root, handleEl, { onClick } = {}) {
    let dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

    function down(e) {
      const p = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      startX = p.clientX; startY = p.clientY;
      const rect = root.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
    }
    function move(e) {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      root.style.left = clamp(startLeft + dx, 4, window.innerWidth  - 44 - 4) + "px";
      root.style.top  = clamp(startTop  + dy, 4, window.innerHeight - 44 - 4) + "px";
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      if (moved) {
        const rect = root.getBoundingClientRect();
        settings.pos = { x: (rect.left + 22) / window.innerWidth, y: (rect.top + 22) / window.innerHeight };
        saveSettings();
        positionPanel(root);
      } else if (onClick) {
        onClick();
      }
    }

    handleEl.addEventListener("mousedown", down);
    handleEl.addEventListener("touchstart", down, { passive: false });
    window.addEventListener("mousemove", move);
    window.addEventListener("touchmove", move, { passive: false });
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
  }

  function wirePanel(root) {
    const toggleBtn = root.querySelector("#afx-toggle");
    const panel     = root.querySelector("#afx-panel");
    const closeBtn  = root.querySelector("#afx-close");
    const header    = root.querySelector("#afx-header");

    makeDraggable(root, toggleBtn, {
      onClick: () => {
        panel.classList.toggle("open");
        applyAll(); // на случай, если плеер появился, пока панель была закрыта
      },
    });
    makeDraggable(root, header); // перетаскивание панели за заголовок, без onClick

    closeBtn.addEventListener("click", () => panel.classList.remove("open"));

    root.querySelectorAll("input[type=range]").forEach((inp) => {
      inp.addEventListener("input", () => {
        const key = inp.dataset.key;
        settings[key] = Number(inp.value);
        const out = root.querySelector(`[data-out="${key}"]`);
        if (out) out.textContent = fmtVal(key, settings[key]);
        applyAndPersist(root);
      });
    });

    root.querySelector("#afx-reset").addEventListener("click", () => {
      settings = { ...DEFAULTS, pos: settings.pos, enabled: settings.enabled };
      root.querySelector("#afx-preset-select").value = ""; // сброс — это не пресет, список не должен врать
      applyAndPersist(root);
    });

    root.querySelector("#afx-power").addEventListener("click", () => {
      settings.enabled = !settings.enabled;
      applyAndPersist(root);
    });

    root.querySelector("#afx-preset-select").addEventListener("change", (e) => {
      const val = e.target.value;
      if (!val) return;
      const name = val.slice(2);
      const preset = val.startsWith("b:") ? BUILT_IN_PRESETS[name] : userPresets[name];
      if (!preset) return;
      applyPreset(preset);
      applyAndPersist(root);
    });

    root.querySelector("#afx-preset-save").addEventListener("click", () => {
      const name = window.prompt("Название пресета:");
      if (!name) return;
      userPresets[name] = presetFromSettings();
      saveUserPresets();
      refreshPresetOptions(root);
      root.querySelector("#afx-preset-select").value = "u:" + name;
    });

    root.querySelector("#afx-preset-del").addEventListener("click", () => {
      const sel = root.querySelector("#afx-preset-select");
      if (!sel.value.startsWith("u:")) return;
      delete userPresets[sel.value.slice(2)];
      saveUserPresets();
      refreshPresetOptions(root);
    });

    window.addEventListener("resize", () => {
      positionRoot(root);
      positionPanel(root);
    });
  }

  // ── Инициализация ────────────────────────────────────────────────────────
  function initPanel() {
    try {
      const root = buildPanel();
      positionRoot(root);
      positionPanel(root);
      syncPanelUI(root);
      refreshPresetOptions(root);
      wirePanel(root);
    } catch (e) {
      console.error("[Audio FX] не удалось создать панель:", e);
    }
  }

  loadUserPresets(() => {
    loadSettings(() => {
      initPanel();
      startObserving();

      // Некоторые SPA-сайты после нашей инициализации полностью пересобирают
      // <body> (гидратация/роутинг) и вместе с ним стирают наш узел — сторожок
      // раз в 2 сек проверяет, на месте ли панель, и пересоздаёт при необходимости.
      setInterval(() => {
        if (!document.getElementById("afx-root")) initPanel();
      }, 2000);

      // Текущая коррекция автогромкости меняется сама по себе (не только при
      // изменении настроек) — обновляем строку под ползунком отдельным тиком.
      setInterval(() => {
        const root = document.getElementById("afx-root");
        if (root) updateNormalizeStatus(root);
      }, 500);
    });
  });
}
