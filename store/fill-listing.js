// Suno FX — автозаполнение карточки в Chrome Web Store.
//
// СОБРАНО АВТОМАТИЧЕСКИ из cws-listing-filler (fill-core.js + presets.js).
// Правь тексты там и запускай `python build.py`, иначе правки затрутся.
//
// Открой в панели разработчика вкладку «Описание продукта» или
// «Конфиденциальность», нажми F12 → Console, вставь весь этот файл и нажми
// Enter. Chrome при первой вставке в консоль просит набрать «allow pasting» —
// это его защита от чужого кода; наберите и повторите вставку.
//
// Скрипт только заполняет поля и печатает отчёт: он ничего не сохраняет и не
// отправляет на проверку. Картинки из консоли не вставить — файл с диска ей
// недоступен; их перетаскивают мышью из store/screenshots/ либо запускают
// cws_fill.py, который кладёт и картинки.

// fill-core.js — вся работа со страницей панели разработчика.
//
// Разметка панели — Angular Material, и её классы Google меняет без
// предупреждения. Поэтому поля ищутся по видимой подписи, а не по классам, и
// каждое ненайденное поле попадает в отчёт отдельной строкой: заполнить его
// руками — минута, а молча пропустить было бы хуже.
//
// Отсюда же собирается консольный вариант без установки расширения
// (build.py → store/fill-listing.js в репозиториях обоих расширений), поэтому
// здесь нет ни одного обращения к chrome.* : всё, что специфично для
// расширения, живёт в panel.js.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Подпись поля: у Material она либо в mat-label, либо в aria-label, либо в placeholder.
  function labelOf(el) {
    const parts = [];
    const wrap = el.closest('mat-form-field, .mat-mdc-form-field, [class*="form-field"]');
    if (wrap) parts.push(wrap.innerText || '');
    if (el.id) {
      const lbl = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl) parts.push(lbl.innerText || '');
    }
    parts.push(el.getAttribute('aria-label') || '', el.getAttribute('placeholder') || '');
    return parts.join(' ').toLowerCase().replace(/\s+/g, ' ');
  }

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Angular слушает нативные события, а прямое присваивание value их не поднимает.
  function setValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();
  }

  function findField(patterns, options) {
    const long = options && options.long;
    const nodes = [...document.querySelectorAll('textarea, input[type="text"], input[type="url"], input:not([type])')]
      .filter(visible)
      .filter((el) => !el.disabled && !el.readOnly);
    for (const re of patterns) {
      const hit = nodes.find((el) => re.test(labelOf(el)) && (!long || el.tagName === 'TEXTAREA'));
      if (hit) return hit;
    }
    return null;
  }

  function makeFiller(report) {
    const note = (field, status) => report.push({ field, status });
    return {
      note,
      fill(name, patterns, value, options) {
        if (!value) return;
        const el = findField(patterns, options);
        if (!el) { note(name, 'поле не найдено — впиши руками'); return; }
        if (el.value && el.value.trim() && el.value.trim() !== value.trim()) {
          note(name, 'уже заполнено, не трогаю'); return;
        }
        setValue(el, value);
        note(name, 'заполнено');
      },
      // Выпадающие списки Material открываются кликом, а пункты живут в оверлее
      // поверх страницы — отдельным слоем, а не внутри поля.
      async choose(name, labelRe, optionRe) {
        const selects = [...document.querySelectorAll('mat-select, [role="combobox"]')].filter(visible);
        const sel = selects.find((s) => labelRe.test(labelOf(s) + ' ' + (s.innerText || '').toLowerCase()));
        if (!sel) { note(name, 'список не найден — выбери руками'); return; }
        sel.click();
        await sleep(400);
        const options = [...document.querySelectorAll('mat-option, [role="option"]')].filter(visible);
        const opt = options.find((o) => optionRe.test((o.innerText || '').toLowerCase()));
        if (!opt) {
          note(name, 'пункт не найден — выбери руками');
          document.body.click();
          return;
        }
        opt.click();
        await sleep(300);
        note(name, 'выбрано: ' + opt.innerText.trim());
      },
    };
  }

  /** Какая вкладка панели сейчас открыта. */
  function currentPage() {
    const text = document.body.innerText;
    if (/единственн[а-яё]* назначени|single purpose/i.test(text)) return 'privacy';
    if (/описание продукта|store listing/i.test(text)) return 'listing';
    return 'unknown';
  }

  /** Заполняет текстовые поля открытой вкладки. Возвращает отчёт. */
  async function fillListing(data) {
    const report = [];
    const f = makeFiller(report);
    const page = currentPage();

    if (page === 'privacy') {
      // Подписи на этой вкладке не те, что в справке Google: единственное
      // назначение подписано «Описание цели», а разрешение на хосты — целой
      // фразой «Обоснование (Разрешение на доступ к хостам)». Сверено с живой
      // страницей 2026-09-14; английские варианты оставлены на случай, если
      // язык интерфейса другой.
      f.fill('Описание цели', [/описание цели/, /единственн[а-яё]* назначени/, /single purpose/],
             data.singlePurpose, { long: true });
      for (const [perm, text] of Object.entries(data.permissions)) {
        const re = perm === 'host'
          ? /разрешени[а-яё]* на доступ к хостам|host permission|доступ к сайт/
          : new RegExp('\\b' + perm.toLowerCase() + '\\b');
        f.fill('Обоснование: ' + perm, [re], text, { long: true });
      }

      // Удалённый код: у обоих расширений его нет, и это отдельный переключатель.
      // Без ответа на него карточку не отправить, а поле обоснования рядом
      // должно остаться пустым — его заполняют только при ответе «да».
      // Подпись переключателя лежит не на нём и не в ближайшей обёртке, а
      // выше по дереву, поэтому ищем от самих input'ов и поднимаемся вверх.
      // Проверять это обязательно: на живой карточке 2026-09-14 по умолчанию
      // стояло «Да, я использую удалённый код» — для наших расширений это
      // неправда, и с таким ответом карточку ждал бы разговор с проверяющим.
      const radios = [...document.querySelectorAll('input[type="radio"]')];
      const noRemote = radios.find((r) => {
        for (let el = r, k = 0; el && k < 5; el = el.parentElement, k++) {
          if (/нет,? я не использую|no,? i am not using/i.test(el.innerText || '')) return true;
        }
        return false;
      });
      if (!noRemote) {
        f.note('Удалённый код', 'переключатель не найден — ответь руками');
      } else if (noRemote.checked) {
        f.note('Удалённый код', 'уже стоит «нет»');
      } else {
        noRemote.click();
        f.note('Удалённый код', noRemote.checked ? 'отмечено «нет»' : 'нажал, но не переключилось — проверь глазами');
      }
      f.fill('Политика конфиденциальности', [/политик[а-яё]* конфиденциальност|privacy policy/], data.privacyPolicy);

      const boxes = [...document.querySelectorAll('input[type="checkbox"]')].filter(visible);

      // Какие данные расширение собирает. Подписи у этих галочек живут в
      // aria-label, а не рядом в разметке. Отмечаем только перечисленное в
      // пресете: у Suno FX не собирается ничего, у RPC — содержимое сайтов,
      // потому что со страницы Suno читается название трека. То, что данные не
      // покидают компьютер, объясняется в политике конфиденциальности.
      for (const category of data.dataUsage || []) {
        const re = new RegExp(category, 'i');
        const box = boxes.find((b) => re.test(b.getAttribute('aria-label') || labelOf(b)));
        if (!box) f.note('Данные: ' + category, 'галочка не найдена — отметь руками');
        else if (box.checked) f.note('Данные: ' + category, 'уже отмечено');
        else { box.click(); f.note('Данные: ' + category, 'отмечено'); }
      }

      // Подтверждения внизу вкладки. Они верны для обоих расширений, но ставим
      // их, только если они ещё не стоят: снимать уже поставленную отметку —
      // не то, чего ждёшь от кнопки «заполнить».
      let checked = 0;
      for (const box of boxes) {
        const holder = box.closest('mat-checkbox, label, [class*="checkbox"]');
        const label = labelOf(box) + ' ' + ((holder && holder.innerText) || '').toLowerCase();
        if (/не прода|не переда|не использ|comply|disclosure|certif|соответств/.test(label) && !box.checked) {
          box.click();
          checked++;
        }
      }
      f.note('Подтверждения внизу', checked ? 'отмечено: ' + checked : 'не найдены или уже отмечены — проверь глазами');
    } else {
      // Границу слова \b в JS задаёт ASCII-класс \w, поэтому в русской подписи
      // она не срабатывает вовсе. Ищем подпись без границ и полагаемся на то,
      // что нужное поле — единственная доступная для ввода textarea.
      f.fill('Описание', [/описание/, /description/], data.description, { long: true });
      await f.choose('Категория', /категори|category/, new RegExp(data.category.toLowerCase()));
      await f.choose('Язык', /язык|language/, new RegExp('^' + data.language.toLowerCase()));
      f.fill('URL главной страницы', [/url главной страниц|homepage url|сайт продукта/], data.homepage);
      f.fill('URL службы поддержки', [/url служб[а-яё]* поддержк|поддержк[а-яё]* url|support url/], data.support);
    }
    return report;
  }

  /**
   * Помечает поле загрузки нужного вида: значок, скриншот, маленькая, большая.
   *
   * Сам файл отсюда не подставить: страница не может прочитать файл с диска.
   * Кладёт его снаружи cws_fill.py через отладочный порт — ему нужно лишь
   * знать, какое из четырёх полей брать, и пометка выбирает это поле.
   *
   * Поле опознаётся по ближайшему предку, в тексте которого ровно одна из
   * четырёх подписей. Проверка на «ровно одну» обязательна: выше по дереву
   * есть общий контейнер со всеми подписями сразу, и поиск по первому
   * совпадению отправлял файл не в то поле — так картинка 1400×560 уехала в
   * поле для 440×280 и получила «Недопустимый размер изображения».
   */
  function markImageSlot(kind) {
    const LABELS = [[/значок магазина/i, 'значок'], [/скриншот/i, 'скриншот'],
                    [/маленькое рекламное/i, 'маленькая'], [/очень большое рекламное/i, 'большая']];
    let marked = null;
    document.querySelectorAll('input[type="file"]').forEach((input) => {
      input.removeAttribute('data-cws-target');
      let found = null;
      for (let el = input.parentElement, k = 0; el && k < 10 && !found; el = el.parentElement, k++) {
        const hits = LABELS.filter(([re]) => re.test(el.innerText || ''));
        if (hits.length === 1) found = hits[0][1];
        else if (hits.length > 1) break;
      }
      if (found === kind && !marked) {
        input.setAttribute('data-cws-target', '1');
        marked = kind;
      }
    });
    return marked || 'не найдено';
  }

  /** Что уже стоит в полях загрузки: по превью рядом с каждым блоком. */
  function imageSlots() {
    const LABELS = ['Значок магазина', 'Скриншоты', 'Маленькое рекламное', 'Очень большое рекламное'];
    return LABELS.map((name) => {
      // Самый мелкий блок, где есть и подпись, и поле загрузки: у крупных
      // предков подпись тоже найдётся, а считать превью надо в своём блоке.
      const block = [...document.querySelectorAll('div')]
        .filter((d) => (d.innerText || '').includes(name) && d.querySelector('input[type="file"]'))
        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length)[0];
      if (!block) return { блок: name, состояние: 'блок не найден' };
      const images = [...block.querySelectorAll('img')].filter((i) => i.naturalWidth > 8);
      return {
        блок: name,
        картинок: images.length,
        размеры: images.map((i) => i.naturalWidth + '×' + i.naturalHeight).join(', ') || '—',
      };
    });
  }

  window.CWS_FILL = { fillListing, currentPage, markImageSlot, imageSlots };
})();

(async () => {
  const report = await window.CWS_FILL.fillListing({
    id: 'suno-fx',
    repo: 'audio-fx-extension',
    title: 'Suno FX',
    category: 'Развлечения',
    language: 'русский',
    homepage: 'https://github.com/e24x5-Fox/audio-fx-extension',
    support: 'https://github.com/e24x5-Fox/audio-fx-extension/issues',
    privacyPolicy: 'https://e24x5-fox.github.io/audio-fx-extension/',
    description: `Suno FX добавляет на suno.com плавающую панель со звуковыми эффектами. Нажмите кружок в правом нижнем углу — и трек, который уже играет, начнёт звучать так, как вы хотите. Ничего скачивать и никуда заходить не нужно.

ЧТО УМЕЕТ

• Эквалайзер — бас, середина, верх, по ±20 дБ
• Дисторшн с регулировкой тона: от лёгкого тепла до плотного перегруза
• Ревёрб — длина хвоста и задержка перед ним
• Дилей — время повтора и громкость
• Тремоло — пульсация громкости
• 8D — вращение звука между наушниками
• Скорость воспроизведения от 25% до 200% (тон меняется вместе с ней — тот самый эффект slowed)
• Плавный разгон в начале трека и торможение в конце, как у кассеты
• Автовыравнивание громкости между треками
• Готовые пресеты: «Тёплый бас», «Дисторшн-рок», «Slowed + Reverb», «Космос», «Пульс», «Плёнка» — и сохранение своих

КАК ЭТО СДЕЛАНО

Звук обрабатывается прямо во вкладке через Web Audio API. Кривая насыщения дисторшна построена на tanh с асимметрией, а полоса ограничивается фильтрами до и после неё — поэтому перегруз звучит плотно, без металлического звона, который дают простые реализации. Громкость при этом не растёт: компенсация считается по реальному отношению уровней входа и выхода.

ПРИВАТНОСТЬ

Расширение не собирает никаких данных и не обращается к сети вообще: ни одного сетевого запроса, ни аналитики, ни рекламы, ни сторонних библиотек. Настройки и пресеты хранятся только в вашем браузере.

Исходный код открыт: https://github.com/e24x5-Fox/audio-fx-extension`,
    singlePurpose: 'Расширение делает одно: даёт слушателю suno.com панель настройки звучания — ' +
      'эквалайзер, эффекты и скорость воспроизведения — и применяет их к аудио этой страницы прямо в браузере.',
    // Ничего не собирается: расширение не делает ни одного сетевого запроса.
    dataUsage: [],
    permissions: {
      storage: 'Хранит положения ползунков, пресеты пользователя и положение панели на экране, ' +
        'чтобы они не сбрасывались при каждом открытии страницы. Хранилище локальное, данные никуда не отправляются.',
      host: 'Расширение работает только на suno.com: на его страницы добавляется панель и к элементам ' +
        'audio подключается цепочка эффектов Web Audio API. Других сайтов расширение не касается.',
    },
});
  console.log('%cSuno FX · автозаполнение карточки', 'font-weight:bold;color:#8b5cf6');
  console.table(report.map((r) => ({ 'поле': r.field, 'результат': r.status })));
  console.log('Картинки перетащи мышью из store/screenshots/. ' +
              'Ничего не сохранено — проверь поля и нажми «Сохранить черновик».');
})();
