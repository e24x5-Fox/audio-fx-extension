#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — пакует расширение в архивы для установки в браузер.

    python build.py

Архивов два, и отличаются они только манифестом: в .xpi для Firefox он идёт
как есть, в .zip для Chromium из него выкидываются ключи Gecko — см.
chromium_manifest().

Пишем архив вручную через zipfile, а не Compress-Archive из PowerShell:
последний в некоторых версиях кладёт в записи обратные слэши, из-за чего
браузер не находит файлы внутри архива. Пути здесь всегда с прямыми слэшами,
время фиксировано — сборка одного и того же исходника даёт одинаковый файл.
"""

import json
import os
import sys
import zipfile

# Консоль Windows по умолчанию в cp1251, а печатать приходится и кириллицу,
# и название расширения со стрелкой «→».
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(ROOT, "dist")

# Firefox поддерживает это расширение? От этого зависит, собирать ли .xpi.
FIREFOX = True

# В архив идёт только само расширение: файлы репозитория браузеру не нужны,
# а валидатор addons.mozilla.org на посторонние файлы ругается.
#
# Список задан перечислением, а не «всё, кроме известного мусора»: при обратном
# подходе в архив уезжало всё, что просто лежит рядом в рабочей папке — .bat-обёртки,
# заметки, «Новая папка», — и заметить это можно было только по размеру архива.
# Цена — добавляя расширению новый файл, его нужно вписать сюда же.
INCLUDE_FILES = {"manifest.json", "content.js", "panel.css"}
INCLUDE_DIRS = {"icons"}

# Внутри включённых папок всё равно может завестись мусор от системы и редакторов.
SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
SKIP_EXT = {".pem", ".crx", ".zip", ".xpi", ".log", ".bak", ".md"}

# Дата внутри архива фиксирована, иначе одинаковый исходник давал бы разные
# файлы при каждой сборке (в ZIP пишется время модификации).
FIXED_DATE = (2026, 1, 1, 0, 0, 0)

# Ключи манифеста, которые понимает только Gecko. Chromium о них не знает: при
# загрузке распакованного расширения он пишет предупреждение о нераспознанном
# ключе, а валидатор Chrome Web Store на посторонние ключи может и придраться.
# На работу это обычно не влияет, но отдавать в магазин манифест с настройками
# чужого движка незачем.
#
# В обратную сторону так делать НЕЛЬЗЯ: без browser_specific_settings у
# расширения в Firefox не будет постоянного идентификатора, а без него нет ни
# подписи на AMO, ни сохранения настроек между обновлениями.
GECKO_ONLY_KEYS = ("browser_specific_settings",)


def skipped(name):
    return name in SKIP_NAMES or os.path.splitext(name)[1].lower() in SKIP_EXT


def collect():
    files = []
    for name in sorted(os.listdir(ROOT)):
        full = os.path.join(ROOT, name)
        if os.path.isdir(full):
            if name not in INCLUDE_DIRS:
                continue
            for dirpath, _dirnames, filenames in os.walk(full):
                for fname in sorted(filenames):
                    if skipped(fname):
                        continue
                    f = os.path.join(dirpath, fname)
                    files.append((f, os.path.relpath(f, ROOT).replace(os.sep, "/")))
        elif name in INCLUDE_FILES and not skipped(name):
            files.append((full, name))
    return sorted(files, key=lambda t: t[1])


def chromium_manifest(manifest):
    """Тот же манифест, но без ключей Gecko."""
    m = {k: v for k, v in manifest.items() if k not in GECKO_ONLY_KEYS}
    # ensure_ascii=False: описание расширения на кириллице, и превращать его в
    # экранированные последовательности незачем — манифест читает человек,
    # когда разбирает замечания магазина.
    return (json.dumps(m, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def write_archive(path, files, manifest_bytes=None):
    """Собирает архив и возвращает его размер в килобайтах.

    manifest_bytes, если задан, кладётся вместо файла с диска.
    """
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            if rel == "manifest.json" and manifest_bytes is not None:
                data = manifest_bytes
            else:
                with open(full, "rb") as f:
                    data = f.read()
            info = zipfile.ZipInfo(rel, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, data)
    return os.path.getsize(path) / 1024


def main():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    version = manifest.get("version", "0.0.0")

    files = collect()
    if not any(rel == "manifest.json" for _, rel in files):
        print("[ОШИБКА] manifest.json не попал в архив")
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)
    base = "audio-fx-extension-" + version

    print("Собрано «%s» v%s, файлов: %d" % (manifest.get("name", base), version, len(files)))
    for _, rel in files:
        print("   ", rel)
    print("")

    zip_path = os.path.join(OUT_DIR, base + ".zip")
    size = write_archive(zip_path, files, chromium_manifest(manifest))
    print("  dist/%s.zip  (%.1f КБ)  — Chrome / Edge / Яндекс / Opera" % (base, size))
    dropped = [k for k in GECKO_ONLY_KEYS if k in manifest]
    if dropped:
        print("      манифест без ключей Gecko: %s" % ", ".join(dropped))

    if FIREFOX:
        xpi_path = os.path.join(OUT_DIR, base + ".xpi")
        size = write_archive(xpi_path, files)
        print("  dist/%s.xpi  (%.1f КБ)  — Firefox" % (base, size))
        print("      манифест как есть, с browser_specific_settings")

    return 0


if __name__ == "__main__":
    sys.exit(main())
