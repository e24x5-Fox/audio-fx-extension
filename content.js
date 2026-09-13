// Suno FX — панель звуковых эффектов для suno.com
// Перехватывает все <audio>/<video> на странице через Web Audio API и прогоняет
// звук через цепочку: дисторшн → бас/средние/высокие (эквалайзер) → ревёрб.
// Скорость воспроизведения (замедление/ускорение) регулируется напрямую через
// HTMLMediaElement.playbackRate (естественно тянет за собой изменение тона —
// это и есть эффект "slowed", а не тайм-стрейтчинг без изменения питча).
// Поверх постоянной скорости есть «плавный старт/финал»: в начале трека скорость
// разгоняется к выбранной, в конце тормозит, и по той же огибающей на краях
// может нарастать ревёрб — см. блок «Плавный старт/финал» ниже.

if (!window.__afxLoaded) {
  window.__afxLoaded = true;

  const DEFAULTS = {
    enabled: true,
    distortion: 0,   // 0..100
    // 0..100 — яркость перегруза: куда опускаются два ФНЧ вокруг шейпера при
    // полном «Дисторшне». Это регулятор, а не константа, потому что размен
    // здесь неустранимый: чем выше пороги, тем больше верха доживает до
    // выхода — и тем больше вместе с ним заворачивающихся гармоник, тех самых,
    // что слышны звоном. Спецификация Web Audio не описывает фильтр
    // оверсэмплинга WaveShaperNode, он отдан на усмотрение движка, поэтому
    // одна и та же точка размена в разных браузерах звучит по-разному, и
    // подобрать её раз и навсегда из кода нельзя.
    distTone: 50,
    bass: 0,          // -20..20 дБ
    mid: 0,           // -20..20 дБ
    treble: 0,        // -20..20 дБ
    reverb: 0,        // 0..100 — микс (wet) хвоста
    reverbDecay: 2.2, // 0.5..6 сек — длина хвоста импульсного отклика
    reverbPreDelay: 0, // 0..200 мс — пауза перед началом хвоста
    delay: 0,         // 0..100 — микс дилея
    delayTime: 300,   // 50..800 мс — время задержки повтора
    tremolo: 0,       // 0..100 — глубина/частота пульсации громкости
    autopan: 0,       // 0..100 — глубина/частота вращения стерео-картины (8D)
    normalize: 0,     // 0..100 — 0 выключено; иначе цель по громкости для автовыравнивания между треками
    rate: 100,        // 25..200 (%), 100 = обычная скорость
    fadeIn: 0,        // 0..15 с — плавный разгон скорости в начале трека (0 = выключено)
    fadeOut: 0,       // 0..15 с — плавное торможение скорости в конце трека (0 = выключено)
    fadeDepth: 70,    // 0..100 — насколько низко проседает скорость на самом краю
    fadeReverb: 0,    // 0..100 — добавка ревёрба, нарастающая по той же огибающей
    pos: { x: 0.95, y: 0.92 }, // положение кружка — доля от ширины/высоты страницы
  };

  // Ключи, которые входят в пресет (без pos/enabled — те не про звук, а про UI-состояние).
  const PRESET_KEYS = [
    "distortion", "distTone", "bass", "mid", "treble",
    "reverb", "reverbDecay", "reverbPreDelay",
    "delay", "delayTime", "tremolo", "autopan", "normalize", "rate",
    "fadeIn", "fadeOut", "fadeDepth", "fadeReverb",
  ];

  const BUILT_IN_PRESETS = {
    "Чисто": { distortion: 0, bass: 0, mid: 0, treble: 0, reverb: 0, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100, fadeIn: 0, fadeOut: 0, fadeReverb: 0 },
    "Тёплый бас": { distortion: 0, bass: 8, mid: 0, treble: -3, reverb: 0, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100, fadeIn: 0, fadeOut: 0, fadeReverb: 0 },
    "Дисторшн-рок": { distortion: 55, bass: 4, mid: -2, treble: 3, reverb: 10, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100, fadeIn: 0, fadeOut: 0, fadeReverb: 0 },
    "Slowed + Reverb": { distortion: 0, bass: 3, mid: 0, treble: -2, reverb: 55, reverbDecay: 4.5, reverbPreDelay: 30, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 60, fadeIn: 0, fadeOut: 0, fadeReverb: 0 },
    "Космос": { distortion: 0, bass: 0, mid: 0, treble: 2, reverb: 40, reverbDecay: 5, reverbPreDelay: 20, delay: 20, delayTime: 400, tremolo: 0, autopan: 70, normalize: 0, rate: 100, fadeIn: 0, fadeOut: 0, fadeReverb: 0 },
    "Пульс": { distortion: 10, bass: 5, mid: 0, treble: 0, reverb: 10, delay: 0, tremolo: 55, autopan: 0, normalize: 0, rate: 100, fadeIn: 0, fadeOut: 0, fadeReverb: 0 },
    // «Плёнка» — кассетный запуск и остановка: трек трогается с места и уезжает
    // в конце, вместе со скоростью уплывает вниз тон, а хвост ревёрба на краях
    // разрастается — как будто песню отпустили в пустой зал.
    "Плёнка": { distortion: 0, bass: 2, mid: 0, treble: -1, reverb: 15, reverbDecay: 4, reverbPreDelay: 20, delay: 0, tremolo: 0, autopan: 0, normalize: 0, rate: 100, fadeIn: 3, fadeOut: 6, fadeDepth: 80, fadeReverb: 45 },
  };

  let settings = { ...DEFAULTS };
  let userPresets = {}; // имя -> { ...PRESET_KEYS }
  let audioCtx = null;
  const hooked = new WeakMap(); // HTMLMediaElement -> { nodes }
  const hookedSet = new Set();  // те же { nodes } бандлы, но для перебора в общем тике (см. tick())

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

  // Запись отложена: каждое движение ползунка — это десятки input-событий в
  // секунду, а chrome.storage.local на Android пишет на диск (IndexedDB). Писать
  // на каждое событие — значит занимать диск всё время перетаскивания и мешать
  // тому самому воспроизведению, ради которого всё и делается.
  let saveTimer = null;

  function flushSettings() {
    if (saveTimer !== null) { clearTimeout(saveTimer); saveTimer = null; }
    try { chrome.storage.local.set({ afxSettings: settings }); } catch (e) {}
  }

  function saveSettings() {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSettings, 300);
  }

  // Вкладку могут закрыть или увести в фон раньше, чем сработает таймер, —
  // тогда последнее движение ползунка потерялось бы.
  window.addEventListener("pagehide", () => { if (saveTimer !== null) flushSettings(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && saveTimer !== null) flushSettings();
  });

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

  // Ключ, которого в пресете нет, берётся из DEFAULTS, а не остаётся от прошлых
  // настроек. Встроенные пресеты задают не все параметры (например «Хвост» и
  // «Пре-дилей» указаны только там, где они важны), и при переносе прежнего
  // значения один и тот же пресет звучал по-разному в зависимости от того, что
  // стояло до него.
  function applyPreset(preset) {
    PRESET_KEYS.forEach((k) => {
      settings[k] = preset[k] !== undefined ? preset[k] : DEFAULTS[k];
    });
  }

  // ── DSP-хелперы ──────────────────────────────────────────────────────────
  // Важно: рост громкости от дисторшна — это в основном буст ТИХИХ и средних
  // участков (кривая у нуля становится очень крутой и быстро выходит на полку),
  // а не рост пика — пик как раз наоборот прижимается. Фиксированная компенсация
  // числами компрессора не работает одинаково хорошо на любом материале: то, что
  // ровно компенсирует тихий подкаст, "перекомпенсирует" плотный трек, и наоборот.
  // Поэтому громкость не подгоняется заранее подобранными цифрами — она меряется
  // в реальном времени (RMS до/после дисторшна) и выравнивается на лету узлом
  // makeupGain, см. updateLoudness() ниже. Компрессор в цепочке остаётся, но только
  // как мягкий защитный лимитер пиков, а не как инструмент выравнивания громкости.

  // Форма насыщения — гиперболический тангенс.
  //
  // Раньше здесь была расхожая формула ((3+k)·x·20°)/(π + k·|x|). У неё в нуле
  // ИЗЛОМ производной — из-за |x| в знаменателе, — а ноль это ровно та область,
  // где живёт основная часть музыкального сигнала. Излом порождает гармоники,
  // затухающие очень медленно (как 1/n²): они уходят далеко за Найквиста, при
  // дискретизации заворачиваются обратно уже не кратными основному тону и
  // слышатся как металлический, «звенящий» призвук поверх звука. Никакой
  // оверсэмплинг это не лечит — заворачивается то, что выше и его частоты
  // среза. В Firefox было заметнее, чем в Chrome, из-за более простого
  // ресемплера в самом оверсэмплинге WaveShaperNode.
  //
  // tanh — аналитическая функция без изломов, её гармоники спадают
  // экспоненциально: почти всё, что она добавляет, укладывается в первые
  // несколько обертонов, и 4x-оверсэмплинг с ними справляется. На слух это
  // ламповое насыщение, а не «цифровой звон».
  //
  // Диапазон drive тоже стал вменяемым: прежний k доходил до 600, то есть
  // ползунок на максимуме работал жёстким клиппером, а не дисторшном.
  //
  // Числа ниже подобраны по измерениям на двух сигналах — низ+середина
  // (бас, гитара) и яркий (верх, тарелки), оба RMS 0.15, то есть на уровне,
  // где реально играет музыка. Мерилась «грязь» (остаток после вычитания
  // наилучшего линейного приближения входа) и «заворот» — разница между
  // обработкой на 4x, как её делает браузер, и на 32x, где заворота нет:
  //
  //   конфигурация              грязь(низ)  низ<200Гц   заворот(яркий)
  //   прежняя кривая               54.1 %   32.5→26.6 %      1.99 %
  //   симметричный tanh d20        45.6 %   32.5→28.8 %      0.01 %
  //   эта (d45, асимм., бас, ФНЧ)  65.1 %   32.5→50.7 %      0.03 %
  //
  // Главное здесь во втором столбце: и прежняя кривая, и симметричный tanh
  // низ СРЕЗАЛИ. Так и должно быть — симметричное насыщение сильнее всего
  // жмёт самые громкие компоненты, а в музыке это бас. Поэтому «тяжёлый»
  // перегруз получается не самой кривой, а подкачкой низа ПЕРЕД ней
  // (см. preBass в hookElement).
  const DISTORTION_CURVE_POINTS = 8192; // при гладкой кривой этого с запасом
                                        // хватает: между точками WaveShaper
                                        // интерполирует линейно
  function makeDistortionCurve(amount) {
    const t = Math.max(0, Math.min(100, amount)) / 100;
    const n = DISTORTION_CURVE_POINTS;
    const curve = new Float32Array(n);
    if (t <= 0) {
      for (let i = 0; i < n; i++) curve[i] = (i * 2) / (n - 1) - 1;
      return curve;
    }

    // Смещение внутри tanh делает кривую АСИММЕТРИЧНОЙ: верхняя и нижняя полки
    // приходят к разным уровням, и в спектре появляются ЧЁТНЫЕ гармоники.
    // Симметричная кривая даёт только нечётные — это «чистый», стерильный
    // перегруз; чётные и слышатся как та самая грязь.
    //
    // Смещение НЕ умножается на drive. Если умножить (а это первое, что
    // приходит в голову), то при большом drive tanh(drive·bias) насыщается к
    // единице, нормировочный знаменатель схлопывается к ~1e-7 и «кривая»
    // вырождается в двоичный компаратор — не дисторшн, а меандр по знаку.
    const drive = 45 * Math.pow(t, 0.75);
    const bias = 0.35 * t;
    const dc = Math.tanh(bias); // чтобы точка x = 0 осталась в нуле

    let peak = 0;
    for (let i = 0; i < n; i++) {
      // Шаг по (n-1): точка x = 0 попадает в отсчёт ровно.
      const x = (i * 2) / (n - 1) - 1;
      const v = Math.tanh(drive * x + bias) - dc;
      curve[i] = v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    // Нормировка по фактическому максимуму, а не по формуле: у асимметричной
    // кривой полки разной высоты, и считать знаменатель аналитически незачем.
    for (let i = 0; i < n; i++) curve[i] /= peak;
    return curve;
  }

  // Импульсный отклик — не просто шум под общей огибающей.
  //
  // Прежде обе половины отклика были независимым белым шумом с ОДНОЙ огибающей
  // на весь спектр. Формально отклик такого шума ровный, но на слух хвост
  // получался светлым и «без низа», и причин тому две.
  //
  // Первая: одинаковая скорость затухания на всех частотах. В настоящем
  // помещении низ гудит заметно дольше верха — воздух и отделка гасят прежде
  // всего высокие. Когда весь спектр гаснет с одной скоростью, бас пропадает
  // раньше, чем ухо успевает услышать его как «зал»: низкую частоту слух
  // набирает за несколько её периодов, а не мгновенно, как щелчок в верхах.
  //
  // Вторая: низ у каналов был некоррелирован. Расходящийся по фазе бас не
  // складывается в плотный звук — он размазывается между ушами, а при сведении
  // в моно ещё и частично гасится.
  //
  // Поэтому шум делится однополюсным фильтром на низ и верх. У низа отдельная,
  // более медленная огибающая, и он ОБЩИЙ для двух каналов; верх у каналов
  // остаётся независимым — именно он и даёт ширину «зала».
  const REVERB_SPLIT_HZ = 250;   // граница между «низом» и «верхом» отклика
  const REVERB_LOW_DECAY = 0.7;  // множители к показателю затухания: низ гаснет
  const REVERB_HIGH_DECAY = 1.4; // медленнее выбранного «Хвоста», верх — быстрее
  // Однополюсный ФНЧ имеет единичное усиление на нуле Герц, поэтому при
  // множителе 1 низ вернулся бы в отклик ровно с той же плотностью, что и был
  // в шуме. 1.6 — это примерно +4 дБ подъёма низа в хвосте: слышно как тепло,
  // но ещё не как гул.
  const REVERB_LOW_GAIN = 1.6;

  function makeImpulseResponse(ctx, duration = 2.2, decay = 3) {
    const rate = ctx.sampleRate;
    const length = Math.max(1, Math.floor(rate * duration));
    const impulse = ctx.createBuffer(2, length, rate);
    const left = impulse.getChannelData(0);
    const right = impulse.getChannelData(1);

    // Доля нового отсчёта, входящая в состояние однополюсного ФНЧ. Фильтр
    // считается прямо по ходу генерации: гонять буфер через OfflineAudioContext
    // ради двух умножений на отсчёт значило бы делать сборку асинхронной.
    const a = 1 - Math.exp((-2 * Math.PI * REVERB_SPLIT_HZ) / rate);
    let lowState = 0;   // общий низ обоих каналов
    let leftState = 0;  // состояния ФНЧ, из которых вычитанием получается верх
    let rightState = 0;

    for (let i = 0; i < length; i++) {
      const x = 1 - i / length;
      const envLow = Math.pow(x, decay * REVERB_LOW_DECAY);
      const envHigh = Math.pow(x, decay * REVERB_HIGH_DECAY);

      // Отдельный шум на общий низ: брать низ из шума одного из каналов значило
      // бы отдать этому каналу и часть верха вторым экземпляром.
      const mono = Math.random() * 2 - 1;
      lowState += a * (mono - lowState);
      const low = lowState * REVERB_LOW_GAIN * envLow;

      const nl = Math.random() * 2 - 1;
      leftState += a * (nl - leftState);
      left[i] = low + (nl - leftState) * envHigh;

      const nr = Math.random() * 2 - 1;
      rightState += a * (nr - rightState);
      right[i] = low + (nr - rightState) * envHigh;
    }
    return impulse;
  }

  // ── Отложенная пересборка тяжёлых буферов ───────────────────────────────
  // Кривая дисторшна (44100 отсчётов) и импульсный отклик ревёрба (до
  // sampleRate × 6 с × 2 канала, это мегабайты) пересобираются целиком при
  // каждом изменении «Дисторшна» и «Хвоста». Пока ползунок едет под пальцем,
  // браузер шлёт десятки input-событий в секунду — пересобирать на каждое
  // значит держать GC в постоянной работе, а его паузы во время рендера звука
  // слышны как щелчки (на телефоне особенно). Поэтому пересборка откладывается
  // до момента, когда ползунок остановился: остальные параметры (микс,
  // пре-дилей) при этом продолжают меняться мгновенно.
  let heavyRebuildTimer = null;

  function rebuildHeavy(nodes) {
    if (!audioCtx) return;
    const drive = settings.enabled ? settings.distortion : 0;
    if (nodes.drive !== drive) {
      // На нуле кривая СНИМАЕТСЯ (null), а не заменяется линейной.
      //
      // WaveShaperNode с любой заданной кривой зажимает вход в диапазон ±1 —
      // так требует спецификация. Линейная кривая выглядит прозрачной, но на
      // деле это жёсткий клиппер на всём, что выходит за единицу, а декодеры
      // mp3/aac регулярно отдают межсэмпловые пики выше неё, и тем чаще, чем
      // громче сведён трек. Отсюда же брались и расхождения между браузерами:
      // насколько именно декодер вылезает за единицу, каждый решает сам.
      //
      // Проявлялось это тем, что звук «портился» ПОСЛЕ того, как «Дисторшн»
      // подняли и вернули в ноль: до первого движения ползунка curve был null,
      // после — линейная кривая, и снять её обратно было уже нечем.
      //
      // 4-кратный оверсэмплинг на нуле тоже не нужен: он ничего не даёт, кроме
      // постоянной нагрузки на CPU на каждом элементе страницы.
      nodes.distortion.curve = drive > 0 ? makeDistortionCurve(drive) : null;
      nodes.distortion.oversample = drive > 0 ? "4x" : "none";
      nodes.drive = drive;
    }
    if (nodes.reverbDecayApplied !== settings.reverbDecay) {
      nodes.convolver.buffer = makeImpulseResponse(audioCtx, settings.reverbDecay, 3);
      nodes.reverbDecayApplied = settings.reverbDecay;
    }
  }

  function scheduleHeavyRebuild() {
    if (heavyRebuildTimer !== null) clearTimeout(heavyRebuildTimer);
    heavyRebuildTimer = setTimeout(() => {
      heavyRebuildTimer = null;
      hookedSet.forEach(rebuildHeavy);
    }, 200);
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

  // ── Плавный старт/финал ──────────────────────────────────────────────────
  // «Кассетный» разгон в начале трека и торможение в конце: скорость (а вместе
  // с ней, из-за preservesPitch = false, и тон) плавно выходит из проседания к
  // норме и так же плавно уезжает вниз к концу песни. По той же огибающей, если
  // включён ползунок «Ревёрб на краях», разрастается хвост ревёрба.
  //
  // Огибающая считается от ПОЗИЦИИ в треке, а не от момента нажатия play:
  // поэтому пауза и продолжение в середине песни ничего не запускают, перемотка
  // в конец сразу попадает в торможение, а зацикленный трек честно разгоняется
  // заново после каждого оборота.

  // Насколько низко может просесть скорость относительно выбранной, при
  // «Глубине» = 100 (0.15 — 15% от обычной).
  const FADE_MIN_FACTOR = 0.15;
  // Абсолютный пол по playbackRate. Во-первых, ниже ~0.25 браузер вправе
  // заглушить звук элемента (Firefox так и делает), а глушить его нельзя — весь
  // звук идёт из этого элемента в наш граф. Во-вторых, в торможении скорость
  // пропорциональна остатку трека, то есть остаток тает экспоненциально: при
  // скорости, стремящейся к нулю, песня бы никогда не доиграла до конца.
  const FADE_RATE_FLOOR = 0.25;

  // 1 — вне зоны эффекта (обычная скорость), 0 — самый край трека.
  function fadeEnvelope(el) {
    if (!settings.enabled) return 1;
    if (settings.fadeIn <= 0 && settings.fadeOut <= 0) return 1;

    const t = el.currentTime;
    if (!isFinite(t)) return 1;

    let e = 1;
    if (settings.fadeIn > 0) e = Math.min(e, t / settings.fadeIn);

    const dur = el.duration;
    // У прямых трансляций duration — Infinity или NaN: конца нет, тормозить не к чему.
    if (settings.fadeOut > 0 && isFinite(dur) && dur > 0) {
      e = Math.min(e, (dur - t) / settings.fadeOut);
    }

    e = clamp(e, 0, 1);
    // Smoothstep вместо линейной огибающей: у «нормального» её конца стык
    // получается без излома. На линейной момент выхода на обычную скорость
    // слышен как резкий перелом — характер разгона меняется мгновенно.
    return e * e * (3 - 2 * e);
  }

  // Итоговый микс ревёрба: ползунок «Микс» плюс добавка от плавного старта/финала,
  // которая растёт ровно там, где проседает скорость.
  function reverbMixFor(env) {
    if (!settings.enabled) return 0;
    const base = settings.reverb / 100;
    const extra = (settings.fadeReverb / 100) * (1 - env);
    return Math.min(1, base + extra);
  }

  // Огибающая живёт своей жизнью (позиция в треке едет сама), поэтому её нельзя
  // применять только по событию изменения настроек — её ведёт общий тик (см.
  // tick() ниже). Работы функция не делает, пока значение реально не изменилось,
  // так что при выключенной плавности (env всегда 1) это сравнение двух чисел.
  function updateFade(nodes) {
    const env = fadeEnvelope(nodes.el);
    if (env === nodes.fadeEnv) return;
    // Микро-изменения огибающей не слышны, а запись playbackRate на каждое из
    // них — лишняя работа для ресемплера элемента 20 раз в секунду. Крайние
    // значения пропускать нельзя: именно на них эффект должен точно сойтись к
    // обычной скорости (1) и к самому дну проседания (0).
    if (env !== 1 && env !== 0 && Math.abs(env - nodes.fadeEnv) < 0.002) return;
    nodes.fadeEnv = env;
    applyRateToElement(nodes.el);
    const mix = reverbMixFor(env);
    setReverbConnected(nodes, mix > 0);
    ramp(nodes.wetGain.gain, mix);
  }

  // Отцепляет весь граф элемента от выхода или возвращает его обратно. Узлы Web
  // Audio считаются, только пока от них есть путь к destination, — значит, для
  // выброшенного со страницы плеера достаточно снять одно последнее соединение,
  // чтобы звуковой поток перестал прогонять через себя его свёртку, компрессор,
  // фильтры и два осциллятора. Отсоединять сам источник от элемента нельзя:
  // createMediaElementSource() разрешён ровно один раз за жизнь элемента, и
  // отменить его невозможно — поэтому граф именно приглушается, а не сносится.
  function setGraphConnected(nodes, connected) {
    if (connected === nodes.graphConnected) return;
    if (connected) nodes.masterGain.connect(audioCtx.destination);
    else nodes.masterGain.disconnect(audioCtx.destination);
    nodes.graphConnected = connected;
  }

  // ── Подключение одного media-элемента к графу эффектов ─────────────────
  function hookElement(el) {
    if (hooked.has(el)) {
      // Элемент уже подключён, но его могли выбросить из тика как «мёртвый»
      // (см. tick) — а раз он снова в документе, за ним снова надо следить.
      // Повторно createMediaElementSource() при этом не вызывается: он
      // разрешён ровно один раз за жизнь элемента.
      const known = hooked.get(el);
      setGraphConnected(known, true);
      hookedSet.add(known);
      return;
    }
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

    // Подкачка низа ПЕРЕД шейпером. Насыщение сильнее всего жмёт самые громкие
    // компоненты сигнала, а в музыке это бас, — поэтому сам по себе перегруз
    // низ не добавляет, а убирает (измерено: доля полосы ниже 200 Гц падала с
    // 32.5 % до 26.6 %). Чтобы получить тяжёлый, «низовой» перегруз, бас нужно
    // загнать в насыщение специально: эта полка поднимает его до входа в
    // кривую, а не после неё. После кривой поднимать бесполезно — грязи в нём
    // от этого не появится.
    const preBass = ctx.createBiquadFilter();
    preBass.type = "lowshelf";
    preBass.frequency.value = 120;

    // Ограничение полосы НА ВХОДЕ шейпера — то же, что делает входной каскад
    // настоящего усилителя. Чем меньше верха приходит в кривую, тем меньше она
    // порождает гармоник, улетающих за Найквиста, — а именно они и
    // заворачиваются обратно металлическим звоном. На ярком материале это
    // снимает заворот с 0.26 % до 0.03 %, то есть в разы ниже, чем было у
    // прежней кривой (1.99 %), при большей грязи.
    const preTone = ctx.createBiquadFilter();
    preTone.type = "lowpass";
    preTone.Q.value = 0.7;

    // Асимметричная кривая по определению даёт на выходе постоянную
    // составляющую: полки у неё разной высоты. Постоянка съедает запас по
    // громкости и щёлкает при изменениях усиления, поэтому её сразу снимаем.
    const dcBlock = ctx.createBiquadFilter();
    dcBlock.type = "highpass";
    dcBlock.frequency.value = 25;
    dcBlock.Q.value = 0.7;

    const distortion = ctx.createWaveShaper();
    // Кривая и oversample выставляются в rebuildHeavy(); до тех пор нода
    // прозрачна (curve = null — сигнал проходит как есть).
    distortion.oversample = "none";

    // Сглаживающий ФНЧ сразу после шейпера. Даже у гладкого tanh на большом
    // drive верхние обертоны заходят за Найквиста и заворачиваются обратно
    // «песком» в верхах. Срез едет вниз вместе с ползунком: на нуле фильтр
    // практически прозрачен (стоит у самого Найквиста), на максимуме подрезает
    // сверху так, как это делает динамик реального гитарного кабинета.
    const toneFilter = ctx.createBiquadFilter();
    toneFilter.type = "lowpass";
    toneFilter.Q.value = 0.7;
    // Biquad у самой границы Найквиста считается неточно, поэтому потолок —
    // доля от частоты дискретизации, а не круглые 20 кГц.
    const TONE_MAX_HZ = Math.min(20000, ctx.sampleRate * 0.45);
    toneFilter.frequency.value = TONE_MAX_HZ;
    preTone.frequency.value = TONE_MAX_HZ;

    // Мягкий защитный лимитер пиков — фиксированные консервативные параметры,
    // не зависят от drive. За выравнивание громкости отвечает не он, а
    // makeupGain ниже (см. updateLoudness).
    const compressor = ctx.createDynamicsCompressor();
    // Порог и степень мягче прежних (-6 дБ, 3:1): после насыщения сигнал
    // плотный и почти весь сидит выше порога, то есть компрессор работал
    // непрерывно и приглаживал ровно ту резкость, ради которой перегруз и
    // включают. Его задача — поймать пик, а не задавать характер.
    compressor.threshold.value = -3;
    compressor.ratio.value = 2;
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
    // подстраивается в updateLoudness() под соотношение RMS(вход)/RMS(выход)
    // дисторшн-цепочки, независимо от drive и от того, что играет.
    const makeupGain = ctx.createGain();

    const bass   = ctx.createBiquadFilter();
    bass.type = "lowshelf";
    bass.frequency.value = 200;

    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    mid.frequency.value = 1000;
    // Q = 0.8, а не 1: полоса шире примерно на треть октавы. Узкая середина
    // при том же числе децибел на слух работает заметно слабее — ползунок
    // «Средние» ощущался вялым именно из-за этого, а не из-за диапазона.
    mid.Q.value = 0.8;

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
    // Анализаторы включены В РАЗРЫВ цепи, а не отводом в никуда.
    //
    // AnalyserNode сигнал не меняет — что пришло, то и отдаёт, — поэтому на
    // звук это не влияет вообще. Влияет на другое: граф Web Audio считается
    // обходом ОТ destination назад по связям, и узел, из которого нет пути к
    // выходу, движок вправе не считать вовсе. Анализатор-тупик (connect в него
    // есть, из него — нет) в такой обход не попадает, и тогда
    // getFloatTimeDomainData() отдаёт нули. Ошибка при этом не возникает
    // нигде: RMS просто всегда ниже порога SILENCE, автовыравнивание молча
    // никогда не срабатывает, а «Автогромкость» выглядит неработающей.
    // Включение в разрыв убирает этот класс отказа целиком и ничего не стоит.
    //
    // Анализатор входа стоит ДО подкачки низа: makeupGain должен возвращать
    // громкость к исходной, а не к поднятой нами же.
    preGain.connect(preAnalyser);
    preAnalyser.connect(preBass);
    preBass.connect(preTone);
    preTone.connect(distortion);
    distortion.connect(dcBlock);
    dcBlock.connect(toneFilter);
    toneFilter.connect(compressor);
    compressor.connect(postAnalyser);
    postAnalyser.connect(makeupGain);
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

    // Автовыравнивание громкости между треками (см. updateLoudness) — тот же
    // принцип, что и makeupGain у дисторшна (RMS в реальном времени → подстройка
    // gain), но здесь на ИТОГОВОМ смешанном сигнале (dry+wet+delay) и с гораздо
    // более медленной реакцией: цель не "выровнять компрессией внутри трека", а
    // мягко подтянуть средний уровень К ДРУГИМ трекам, без "дыхания" на слух.
    const masterGain = ctx.createGain();
    const normAnalyser = ctx.createAnalyser();
    normAnalyser.fftSize = 1024;

    // Здесь тот же приём: три ветки сходятся В анализатор, а он уже отдаёт
    // сумму в masterGain. Раньше анализатор висел тупиком параллельно трём
    // прямым связям в masterGain — см. комментарий про обход графа выше.
    dryGain.connect(normAnalyser);
    wetGain.connect(normAnalyser);
    delayWetGain.connect(normAnalyser);
    normAnalyser.connect(masterGain);
    masterGain.connect(ctx.destination);

    const nodes = {
      el, // нужен в updateFade(): огибающая считается от currentTime/duration элемента
      source, preGain, preBass, preTone, distortion, dcBlock, toneFilter,
      toneMaxHz: TONE_MAX_HZ,
      compressor, preAnalyser, postAnalyser, makeupGain,
      bass, mid, treble, convolver, reverbPreDelay, dryGain, wetGain,
      delayNode, delayFeedback, delayWetGain, masterGain, normAnalyser,
      tremoloGain, tremoloLFO, tremoloDepthGain, panNode, panLFO, panDepthGain,
      drive: 0,
      // Цепочка собрана подключённой (см. connect ниже), а applySettingsToNode
      // ниже сразу выключит её, если «Дисторшн» стоит в нуле.
      distortionConnected: true,
      graphConnected: true, // есть ли путь от графа к выходу, см. setGraphConnected
      // Текущее значение огибающей плавного старта/финала (см. updateFade).
      // Считается сразу здесь, а не оставляется единицей до первого тика: элемент
      // могли подключить уже стоящим в начале трека — тогда первые миллисекунды
      // прозвучали бы на полной скорости, то есть эффект «спотыкался» бы на старте.
      fadeEnv: fadeEnvelope(el),
      reverbConnected: false,
      reverbDecayApplied: null,
      preBuf: new Float32Array(preAnalyser.fftSize),
      postBuf: new Float32Array(postAnalyser.fftSize),
      normBuf: new Float32Array(normAnalyser.fftSize),
      normCurrentGain: null, // текущая коррекция автогромкости (множитель) — для UI, см. updateNormalizeStatus
      normLevelSmoothed: null, // долгосрочное сглаженное измерение громкости, см. updateLoudness
    };
    hooked.set(el, nodes);
    hookedSet.add(nodes);

    applySettingsToNode(nodes);
    // Для только что подключённого элемента тяжёлые буферы собираем сразу, без
    // задержки: иначе первые 200 мс он играл бы без дисторшна и без хвоста.
    rebuildHeavy(nodes);
    applyRateToElement(el);

    el.addEventListener("play", () => {
      getAudioCtx();
      // Плеер мог быть признан мёртвым и отцеплен от выхода (см. tick). Это
      // единственный надёжный момент вернуть его в строй: элемент могли увести
      // из DOM и запустить заново, не трогая документ, — тогда никаких мутаций,
      // на которые смотрит наблюдатель, не будет вовсе.
      setGraphConnected(nodes, true);
      hookedSet.add(nodes);
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

  // Выключает всю дисторшн-цепочку из графа, когда «Дисторшн» на нуле: вместо
  // неё анализатор входа соединяется с анализатором выхода напрямую.
  //
  // Приглушить цепочку параметрами не получается, и это не вопрос экономии CPU.
  //
  // WaveShaperNode с любой заданной кривой зажимает вход в диапазон ±1 — так
  // требует спецификация. Линейная кривая выглядит прозрачной, но на деле это
  // жёсткий клиппер на всём, что выходит за единицу, а декодеры mp3 и aac
  // регулярно отдают межсэмпловые пики выше неё, тем чаще, чем громче сведён
  // трек. Клиппинг такого рода как раз и слышен металлическим призвуком.
  // Отсюда же и расхождения между браузерами: насколько именно декодер вылезает
  // за единицу, каждый решает сам.
  //
  // DynamicsCompressorNode с порогом −3 дБ и коленом 6 дБ начинает сжимать уже
  // с −6 дБ, то есть на музыке работает непрерывно. Степень 1 по определению
  // означает отсутствие сжатия, но проверить это в каждом движке нельзя, а
  // внутренняя задержка предпросмотра у ноды остаётся в любом случае.
  //
  // Оба фильтра вокруг шейпера при нуле стоят у самого Найквиста, где biquad
  // считается наименее точно, и это тоже разные числа в разных браузерах.
  //
  // Ни один из трёх пунктов сам по себе не громкий. Но вместе они означают
  // простую вещь: «все ползунки в нуле» звучало не так, как выключенное
  // расширение, и разница зависела от браузера.
  function setDistortionConnected(nodes, connected) {
    if (connected === nodes.distortionConnected) return;
    if (connected) {
      nodes.preAnalyser.disconnect(nodes.postAnalyser);
      nodes.preAnalyser.connect(nodes.preBass);
      nodes.compressor.connect(nodes.postAnalyser);
    } else {
      nodes.preAnalyser.disconnect(nodes.preBass);
      nodes.compressor.disconnect(nodes.postAnalyser);
      nodes.preAnalyser.connect(nodes.postAnalyser);
    }
    nodes.distortionConnected = connected;
  }

  // ── Применение текущих настроек ─────────────────────────────────────────
  function applySettingsToNode(nodes) {
    const on = settings.enabled;
    const drive = on ? settings.distortion : 0;
    const t = drive / 100; // 0..1

    ramp(nodes.preGain.gain, 1 - t * 0.1); // небольшой запас на вход, чтобы 4x-oversample не клиппинговал раньше времени

    // Кривая дисторшна пересобирается не здесь, а в rebuildHeavy() — с
    // задержкой после того, как ползунок остановился (см. scheduleHeavyRebuild).
    if (nodes.drive !== drive) scheduleHeavyRebuild();

    // Подкачка низа перед шейпером — до +10 дБ на 120 Гц (см. preBass).
    // Это и есть источник «тяжёлого» перегруза; сама кривая низ только жмёт.
    ramp(nodes.preBass.gain, t * 10);

    // Оба ФНЧ едут вниз вместе с «Дисторшном», шаг геометрический (высота на
    // слух воспринимается именно так). preTone — вход шейпера: чем меньше
    // верха приходит в кривую, тем меньше она порождает того, что завернётся.
    // toneFilter — выход: снимает оставшийся «песок».
    //
    // Важно, что оба стоят ПОСЛЕДОВАТЕЛЬНО В ОСНОВНОМ ТРАКТЕ, а не в отдельной
    // ветке дисторшна: через них идёт вся музыка целиком, и эквалайзер стоит
    // ПОСЛЕ них. Однажды пороги были выбраны как 7 и 13 кГц — на максимуме
    // «Дисторшна» это давало −9.3 дБ на 10 кГц и −21.4 дБ на 14 кГц, то есть
    // верхнюю октаву выбрасывало у всего сигнала, «Высокие» поднимали уже
    // вырезанное, и на слух в полсилы работали сразу оба эффекта.
    //
    // Куда именно опускаются пороги, задаёт «Тон»: 0 — 6 и 8 кГц (темно, зато
    // заворот 0.01 %), 100 — фильтры прозрачны (весь верх на месте, заворот
    // 0.31 %). Размен неустранимый, поэтому это ползунок, а не константа.
    //
    // Math.min нужен на случай низкой частоты дискретизации (некоторые потоки
    // идут в 22 кГц): там потолок сам ниже любого из порогов.
    const toneT = Math.max(0, Math.min(100, settings.distTone)) / 100;
    const preFloor  = Math.min(nodes.toneMaxHz, 6000 * Math.pow(nodes.toneMaxHz / 6000, toneT));
    const postFloor = Math.min(nodes.toneMaxHz, 8000 * Math.pow(nodes.toneMaxHz / 8000, toneT));
    ramp(nodes.preTone.frequency,    nodes.toneMaxHz * Math.pow(preFloor  / nodes.toneMaxHz, t));
    ramp(nodes.toneFilter.frequency, nodes.toneMaxHz * Math.pow(postFloor / nodes.toneMaxHz, t));

    if (drive <= 0) {
      // Дисторшн выключен — выравнивать нечего, сразу unity, не дожидаясь измерений RMS.
      nodes.makeupGain.gain.setTargetAtTime(1, audioCtx.currentTime, 0.05);
    }

    // Дисторшн на нуле — вся его цепочка выключается ИЗ ГРАФА, см.
    // setDistortionConnected(). Приглушить её параметрами (линейная кривая,
    // степень сжатия 1, фильтры у Найквиста) недостаточно: см. там же.
    setDistortionConnected(nodes, drive > 0);

    ramp(nodes.bass.gain,   on ? settings.bass   : 0);
    ramp(nodes.mid.gain,    on ? settings.mid    : 0);
    ramp(nodes.treble.gain, on ? settings.treble : 0);
    nodes.dryGain.gain.value = 1; // константа, скачков не бывает

    // Импульсный отклик — там же и по той же причине, см. scheduleHeavyRebuild.
    if (nodes.reverbDecayApplied !== settings.reverbDecay) scheduleHeavyRebuild();
    ramp(nodes.reverbPreDelay.delayTime, (on ? settings.reverbPreDelay : 0) / 1000);

    // Микс ревёрба складывается из ползунка «Микс» и добавки от плавного
    // старта/финала (см. reverbMixFor/updateFade), поэтому берётся не напрямую
    // из настроек, а с учётом текущей огибающей.
    const reverbMix = reverbMixFor(nodes.fadeEnv);
    setReverbConnected(nodes, reverbMix > 0);
    ramp(nodes.wetGain.gain, reverbMix);

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

  function updateLoudness(nodes, now) {
    if (nodes.drive > 0) {
      const inLevel  = rms(nodes.preAnalyser,  nodes.preBuf);
      const outLevel = rms(nodes.postAnalyser, nodes.postBuf);
      if (inLevel >= SILENCE && outLevel >= SILENCE) {
        // Нижний предел 0.02, а не 0.1. При включённой подкачке низа и
        // большом drive тихому материалу требуется ослабление до ~0.077, и на
        // прежнем пределе компенсация упиралась — то есть на тихих треках
        // громкость прыгала вверх, стоило тронуть «Дисторшн». От разгона на
        // тишине защищает не этот предел, а порог SILENCE выше.
        const target = Math.min(4, Math.max(0.02, inLevel / outLevel));
        // Постоянная времени большая (0.5 с, не 0.15): нужная коррекция при
        // выбранном drive практически не меняется, а быстрая подстройка
        // гонялась за каждым моментальным RMS и сама слышалась как «дыхание»
        // громкости поверх дисторшна.
        nodes.makeupGain.gain.setTargetAtTime(target, now, 0.5);
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
          const tickSec = TICK_MS / 1000;
          const tc = 12;
          const a = tickSec / (tc + tickSec);
          nodes.normLevelSmoothed += a * (instant - nodes.normLevelSmoothed);
        }

        const targetRms = normalizeTargetRms(settings.normalize);
        // Широкий клэмп (0.2x..6x): не пытаемся вытянуть почти тишину в
        // полную громкость (звучало бы как шумодав, вытягивающий шипение
        // между нотами) и не режем неожиданно громкий материал в ноль.
        const gain = Math.min(6, Math.max(0.2, targetRms / nodes.normLevelSmoothed));
        // Постоянная времени 0.5 с, а не 4 с. Медленность, ради которой всё
        // затевалось, уже обеспечена сглаживанием САМОГО ИЗМЕРЕНИЯ (12 с выше):
        // gain и так не может дёрнуться быстро, потому что не может дёрнуться
        // normLevelSmoothed. Четырёхсекундная постоянная поверх этого ничего не
        // добавляла к плавности, зато складывалась с 12 с в общий отклик под
        // двадцать секунд — а ползунок-то меняет ЦЕЛЬ мгновенно. Человек двигал
        // «Автогромкость», за пару секунд не слышал ничего и делал единственно
        // разумный вывод: не работает.
        nodes.masterGain.gain.setTargetAtTime(gain, now, 0.5);
        nodes.normCurrentGain = gain; // для UI, см. updateNormalizeStatus
      }
    } else if (nodes.normCurrentGain !== null) {
      // Возврат к единице нужен ровно один раз — в тот тик, когда автогромкость
      // выключили. Планировать одну и ту же автоматизацию 20 раз в секунду до
      // конца жизни страницы (а именно так было раньше) незачем.
      nodes.masterGain.gain.setTargetAtTime(1, now, 0.3);
      nodes.normCurrentGain = null;
      nodes.normLevelSmoothed = null; // следующее включение — измеряем заново, без "памяти" от прошлого раза
    }
  }

  // ── Общий тик ───────────────────────────────────────────────────────────
  // Один таймер на всё, что должно жить своей жизнью между изменениями
  // настроек: огибающая плавного старта/финала и оба автовыравнивания
  // громкости. Один таймер вместо двух — на телефоне каждое срабатывание это
  // отдельное пробуждение процессора, а работа тут в любом случае общая: обойти
  // те же ноды и посмотреть на те же элементы.
  const TICK_MS = 50;

  function tick() {
    // Ни одного подключённого плеера — обходить нечего; на странице без звука
    // тик не должен будить процессор двадцать раз в секунду.
    if (!audioCtx || hookedSet.size === 0) return;
    const now = audioCtx.currentTime;
    let anyPlaying = false;
    hookedSet.forEach((nodes) => {
      const el = nodes.el;
      // SPA (тот же suno.com) пересоздают плееры пачками, а отключить элемент от
      // Web Audio graph нельзя — он остаётся в переборе навсегда. Выброшенный из
      // документа и остановленный элемент из тика убираем: если он вернётся,
      // hookElement() зарегистрирует его обратно. Играющий, но откреплённый от
      // DOM элемент не трогаем — часть плееров сознательно держит <audio> вне DOM.
      if (!el.isConnected && el.paused) {
        setGraphConnected(nodes, false);
        hookedSet.delete(nodes);
        return;
      }
      updateFade(nodes);
      // Пока элемент стоит на паузе, мерять нечего, а RMS по трём анализаторам
      // (три прохода по 1024 отсчёта) на каждый элемент 20 раз в секунду — самая
      // дорогая часть тика. На странице с десятком плееров это заметно.
      if (el.paused) return;
      anyPlaying = true;
      updateLoudness(nodes, now);
    });

    // Последняя страховка от самого болезненного отказа: элемент подключён к
    // suspended-контексту и играет молча. Ловится это только здесь — жеста
    // могло не быть вовсе (автозапуск после перехода по ссылке), а событие
    // play уже отработало. Вызов дешёвый, при отказе (нет user activation)
    // промис просто отклоняется.
    if (anyPlaying && audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
  }
  setInterval(tick, TICK_MS);

  function applyRateToElement(el) {
    try {
      let rate = settings.enabled ? settings.rate / 100 : 1;
      if (settings.enabled) {
        // Огибающая берётся из бандла нод (её ведёт updateFade), а для ещё не
        // подключённого элемента считается на месте — иначе первый кадр
        // воспроизведения успел бы прозвучать на полной скорости.
        const nodes = hooked.get(el);
        const env = nodes ? nodes.fadeEnv : fadeEnvelope(el);
        const minFactor = 1 - (settings.fadeDepth / 100) * (1 - FADE_MIN_FACTOR);
        rate = Math.max(FADE_RATE_FLOOR, rate * (minFactor + (1 - minFactor) * env));
      }
      el.playbackRate = rate;
      // По умолчанию браузер сам "выравнивает" тон при смене playbackRate —
      // именно это и даёт металлический/роботический призвук на низкой скорости.
      // Отключаем эту коррекцию: получаем честное винтажное "slowed" (тон падает
      // вместе со скоростью), звучит естественно, без артефактов алгоритма.
      // Выключенное расширение возвращает браузеру его умолчание: иначе своя
      // регулировка скорости у сайта продолжала бы плыть по тону из-за нас.
      const keepPitch = !settings.enabled;
      el.preservesPitch = keepPitch;
      el.mozPreservesPitch = keepPitch;
      el.webkitPreservesPitch = keepPitch;
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
  // Раньше на каждый добавленный узел вызывался querySelectorAll("audio, video")
  // по всему его поддереву. На SPA вроде suno.com узлы прилетают пачками по
  // сотне за кадр (виртуальные списки, ререндеры), и такой обход — постоянная
  // нагрузка на главный поток, то есть подтормаживание прокрутки на телефоне.
  // Любая пачка мутаций сводится к одному проходу по документу, не чаще пяти
  // раз в секунду; сам проход дешевле, потому что querySelectorAll по документу
  // идёт через нативный обход, а не через сотни вызовов из JS.
  const SCAN_THROTTLE_MS = 200;
  let scanTimer = null;
  let lastScan = 0;

  function scanDocument() {
    scanTimer = null;
    lastScan = Date.now();
    document.querySelectorAll("audio, video").forEach(hookElement);
  }

  function scheduleScan() {
    if (scanTimer !== null) return;
    // Первая мутация после затишья обрабатывается сразу (в следующей задаче
    // очереди), а не через SCAN_THROTTLE_MS: новый плеер надо подхватить
    // быстро, иначе первые доли секунды трек играет мимо эффектов.
    scanTimer = setTimeout(scanDocument, Math.max(0, SCAN_THROTTLE_MS - (Date.now() - lastScan)));
  }

  const observer = new MutationObserver(scheduleScan);

  function startObserving() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scanDocument();
  }

  // Пользовательский жест на странице — шанс снять suspended-статус контекста.
  //
  // Слушатели НЕ одноразовые, и это не мелочь: пока контекст в suspended, звук
  // подключённого элемента уходит в него и наружу не выходит вовсе — плеер
  // «играет» молча. А контекст обычно появляется уже ПОСЛЕ первого клика: на
  // SPA плеер и создаётся в ответ на этот самый клик по треку. С одноразовым
  // слушателем единственный жест тратился впустую (контекста ещё нет — будить
  // нечего), и следующего шанса не было. Поэтому слушатели живут до тех пор,
  // пока контекст не ожил, и снимают себя сами.
  //
  // passive: true — обработчик ничего не отменяет, а неpassive-слушатель
  // touchstart на document заставляет браузер ждать его перед каждой прокруткой.
  const GESTURE_EVENTS = ["click", "keydown", "touchstart"];

  function onGesture() {
    if (!audioCtx) return;
    if (audioCtx.state === "running") {
      GESTURE_EVENTS.forEach((evt) => document.removeEventListener(evt, onGesture, true));
      return;
    }
    audioCtx.resume().catch(() => {});
  }

  GESTURE_EVENTS.forEach((evt) => {
    document.addEventListener(evt, onGesture, { capture: true, passive: true });
  });

  // ── Плавающая панель управления ──────────────────────────────────────────
  function buildPanel() {
    const root = document.createElement("div");
    root.id = "afx-root";
    root.innerHTML = `
      <div id="afx-toggle" title="Suno FX"><img alt=""></div>
      <div id="afx-panel">
        <div id="afx-header">
          <span class="afx-title">Suno FX</span>
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
          <div class="afx-row-label"><span>Тон перегруза</span><span class="afx-val" data-out="distTone"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="distTone"
            title="Яркость перегруза. Влево — темнее и чище: верх срезается сильнее, вместе с ним уходит металлический звон. Вправо — весь верх на месте, но звона больше. Действует тем сильнее, чем выше «Дисторшн»; на нуле дисторшна не делает ничего.">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Бас</span><span class="afx-val" data-out="bass"></span></div>
          <input type="range" min="-20" max="20" step="1" data-key="bass">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Средние</span><span class="afx-val" data-out="mid"></span></div>
          <input type="range" min="-20" max="20" step="1" data-key="mid">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Высокие</span><span class="afx-val" data-out="treble"></span></div>
          <input type="range" min="-20" max="20" step="1" data-key="treble">
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

        <div class="afx-section">Плавный старт/финал</div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Разгон</span><span class="afx-val" data-out="fadeIn"></span></div>
          <input type="range" min="0" max="15" step="0.5" data-key="fadeIn"
            title="Сколько секунд в НАЧАЛЕ трека скорость (и вместе с ней тон) плавно поднимается от заниженной к обычной. 0 — выключено.">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Торможение</span><span class="afx-val" data-out="fadeOut"></span></div>
          <input type="range" min="0" max="15" step="0.5" data-key="fadeOut"
            title="Сколько секунд до КОНЦА трека скорость (и вместе с ней тон) плавно уезжает вниз. 0 — выключено.">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Глубина</span><span class="afx-val" data-out="fadeDepth"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="fadeDepth"
            title="Насколько низко проседает скорость на самом краю трека: 0 — эффекта нет, 100 — до 15% от обычной (но не ниже 0.25×, иначе браузер глушит звук).">
        </div>
        <div class="afx-row">
          <div class="afx-row-label"><span>Ревёрб на краях</span><span class="afx-val" data-out="fadeReverb"></span></div>
          <input type="range" min="0" max="100" step="1" data-key="fadeReverb"
            title="Добавка к миксу ревёрба, нарастающая по той же плавности: на разгоне и торможении хвост разрастается, в середине трека его нет. 0 — выключено.">
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

  // Ползунки со шкалой 0..100: у них подпись в процентах, а ноль подписан
  // словом — «0» рядом с «Автогромкостью» читалось как «выровнять в тишину»,
  // хотя на самом деле это «эффект выключен».
  const PERCENT_KEYS = new Set([
    "distortion", "reverb", "delay", "tremolo", "autopan",
    "normalize", "fadeDepth", "fadeReverb",
  ]);

  function fmtVal(key, v) {
    if (key === "bass" || key === "mid" || key === "treble") return (v > 0 ? "+" : "") + v + " дБ";
    if (key === "rate") return (v / 100).toFixed(2) + "×";
    if (key === "reverbDecay") return v.toFixed(1) + " с";
    if (key === "reverbPreDelay" || key === "delayTime") return v + " мс";
    if (key === "fadeIn" || key === "fadeOut") return v > 0 ? v.toFixed(1) + " с" : "выкл";
    // «Тон» — не глубина эффекта, а положение размена: ноль здесь означает
    // «самый тёмный», а не «выключено».
    if (key === "distTone") return v + " %";
    if (PERCENT_KEYS.has(key)) return v > 0 ? v + " %" : "выкл";
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
    // Берём играющий элемент, а не первый попавшийся: на странице обычно висит
    // ещё несколько молчащих плееров, и по ним коррекция не считается вовсе.
    let node = null;
    hookedSet.forEach((n) => {
      if (!node || (node.el.paused && !n.el.paused)) node = n;
    });
    // Состояния разделены намеренно. Раньше на всё было одно «измеряю…», и по
    // нему нельзя было отличить «плеер не подключён» от «подключён, но
    // измерение не идёт» — а это разные неисправности с разными причинами.
    if (!node) { el.textContent = "плеер не подключён"; return; }
    if (node.el.paused) { el.textContent = "пауза"; return; }
    if (node.normCurrentGain == null) { el.textContent = "измеряю…"; return; }
    const db = 20 * Math.log10(node.normCurrentGain);
    const level = 20 * Math.log10(node.normLevelSmoothed);
    el.textContent = (db >= 0 ? "+" : "") + db.toFixed(1) + " дБ · трек " +
      level.toFixed(0) + " дБ";
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

  // Разнесено на две функции намеренно. Пока ползунок едет под пальцем,
  // пересинхронизировать панель не нужно: подпись значения обработчик input уже
  // обновил сам, а syncPanelUI обходит все семнадцать ползунков и переписывает
  // value в том числе тому, который прямо сейчас тащат, — на Android это
  // способно сбить жест.
  function applyToMedia() {
    for (const el of document.querySelectorAll("audio, video")) {
      const nodes = hooked.get(el);
      if (nodes) applySettingsToNode(nodes);
      applyRateToElement(el);
    }
  }

  function applyAndPersist(root) {
    applyToMedia();
    syncPanelUI(root);
    saveSettings();
  }

  // ── Позиционирование кружка: доля от разрешения страницы ─────────────────
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function positionRoot(root) {
    const size = root.offsetWidth || 44; // на тач-экране кружок крупнее, см. panel.css
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
    const size   = root.offsetWidth || 44; // ширина/высота кружка, см. #afx-root в panel.css
    const margin = 4;
    const gap    = 12; // зазор между кружком и панелью
    const rect   = root.getBoundingClientRect(); // координаты кружка во viewport

    // Сторону выбираем по тому, где реально больше места, а не по половине
    // экрана: кружок ровно посередине высокой панели телефона раскрывался вниз
    // и упирался в нижнюю кромку.
    const spaceAbove = rect.top - gap - margin;
    const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
    const openUp = spaceAbove > spaceBelow;
    panel.style.top    = openUp ? "auto" : (size + gap) + "px";
    panel.style.bottom = openUp ? (size + gap) + "px" : "auto";

    // Высоту ограничиваем оставшимся местом. Без этого на телефоне панель
    // просто не помещалась: кружок по умолчанию стоит внизу (pos.y = 0.92),
    // список ползунков раскрывался вверх на свои 520 px, и на экране 600–700 px
    // верх панели — заголовок, выбор пресета, дисторшн — уезжал за границу
    // экрана и был недоступен вообще, даже прокруткой.
    panel.style.maxHeight = Math.max(180, openUp ? spaceAbove : spaceBelow) + "px";

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
  //
  // Слушатели движения висят на window только пока идёт перетаскивание. Это не
  // косметика: постоянный неpassive-слушатель touchmove на window заставляет
  // браузер на каждый жест прокрутки ждать JS вместо того, чтобы скроллить
  // страницу в отдельном потоке, — на телефоне это ощущается как «залипающая»
  // прокрутка всего сайта, даже когда панель закрыта. Вдобавок панель
  // пересоздаётся сторожком (см. initPanel), и при постоянных слушателях каждая
  // пересборка навсегда добавляла бы к window ещё четыре обработчика.
  function makeDraggable(root, handleEl, { onClick } = {}) {
    let dragging = false, moved = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    let size = 44; // фактический размер кружка, снимается в down()

    function move(e) {
      if (!dragging) return;
      const p = e.touches ? e.touches[0] : e;
      const dx = p.clientX - startX;
      const dy = p.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
      root.style.left = clamp(startLeft + dx, 4, window.innerWidth  - size - 4) + "px";
      root.style.top  = clamp(startTop  + dy, 4, window.innerHeight - size - 4) + "px";
      if (moved && e.touches) e.preventDefault(); // палец тащит кружок, а не страницу
    }
    function up() {
      if (!dragging) return;
      dragging = false;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
      if (moved) {
        const rect = root.getBoundingClientRect();
        settings.pos = {
          x: (rect.left + size / 2) / window.innerWidth,
          y: (rect.top  + size / 2) / window.innerHeight,
        };
        saveSettings();
        positionPanel(root);
      } else if (onClick) {
        onClick();
      }
    }
    function down(e) {
      const p = e.touches ? e.touches[0] : e;
      dragging = true; moved = false;
      startX = p.clientX; startY = p.clientY;
      size = root.offsetWidth || 44;
      const rect = root.getBoundingClientRect();
      startLeft = rect.left; startTop = rect.top;
      e.preventDefault();
      window.addEventListener("mousemove", move);
      window.addEventListener("touchmove", move, { passive: false });
      window.addEventListener("mouseup", up);
      window.addEventListener("touchend", up);
      window.addEventListener("touchcancel", up);
    }

    handleEl.addEventListener("mousedown", down);
    handleEl.addEventListener("touchstart", down, { passive: false });
  }

  function wirePanel(root) {
    const toggleBtn = root.querySelector("#afx-toggle");
    const panel     = root.querySelector("#afx-panel");
    const closeBtn  = root.querySelector("#afx-close");
    const header    = root.querySelector("#afx-header");

    makeDraggable(root, toggleBtn, {
      onClick: () => {
        const opening = !panel.classList.contains("open");
        panel.classList.toggle("open");
        // Раскладка считается именно здесь: кружок мог переехать, экран —
        // повернуться, а у скрытой панели offsetWidth равен нулю, то есть
        // прошлый расчёт шёл по запасному числу, а не по реальной ширине.
        if (opening) positionPanel(root);
        applyAll(); // на случай, если плеер появился, пока панель была закрыта
      },
    });
    makeDraggable(root, header); // перетаскивание панели за заголовок, без onClick

    closeBtn.addEventListener("click", () => panel.classList.remove("open"));

    root.querySelectorAll("input[type=range]").forEach((inp) => {
      const key = inp.dataset.key;
      // Ссылку на подпись берём один раз, а не ищем её заново на каждое из
      // десятков input-событий в секунду.
      const out = root.querySelector(`[data-out="${key}"]`);
      inp.addEventListener("input", () => {
        settings[key] = Number(inp.value);
        if (out) out.textContent = fmtVal(key, settings[key]);
        applyToMedia();
        saveSettings();
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
      const raw = window.prompt("Название пресета:");
      if (raw === null) return;
      const name = raw.trim();
      if (!name) return;
      // Раньше сохранение поверх занятого имени проходило молча — пресет,
      // который собирали долго, исчезал без единого следа.
      if (userPresets[name] && !window.confirm("Пресет «" + name + "» уже есть. Заменить его?")) return;
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

    // Панель пересоздаётся сторожком, если SPA стёр её вместе с <body>, — и
    // обработчик от прошлой панели остался бы на window навсегда, дёргая
    // раскладку для узла, которого уже нет в документе. Поэтому он снимает
    // сам себя, как только его панель исчезла со страницы.
    function onResize() {
      if (!root.isConnected) {
        window.removeEventListener("resize", onResize);
        return;
      }
      positionRoot(root);
      positionPanel(root);
    }
    window.addEventListener("resize", onResize);
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
      console.error("[Suno FX] не удалось создать панель:", e);
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
        // Панель закрыта — строку всё равно никто не видит.
        if (!root || !root.querySelector("#afx-panel.open")) return;
        updateNormalizeStatus(root);
      }, 500);
    });
  });
}
