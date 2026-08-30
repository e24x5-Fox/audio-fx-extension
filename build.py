#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build.py — пакует расширение в архив для установки в браузер.

    python build.py

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
SKIP_NAMES = {"build.py", "README.md", ".gitignore", ".DS_Store", "Thumbs.db", "desktop.ini"}
SKIP_EXT = {".pem", ".crx", ".zip", ".xpi", ".log", ".bak", ".md"}
SKIP_DIRS = {".git", "dist", "node_modules", "__pycache__"}

# Дата внутри архива фиксирована, иначе одинаковый исходник давал бы разные
# файлы при каждой сборке (в ZIP пишется время модификации).
FIXED_DATE = (2026, 1, 1, 0, 0, 0)


def collect():
    files = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in sorted(filenames):
            if name in SKIP_NAMES or os.path.splitext(name)[1].lower() in SKIP_EXT:
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, ROOT).replace(os.sep, "/")
            files.append((full, rel))
    return sorted(files, key=lambda t: t[1])


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
    zip_path = os.path.join(OUT_DIR, base + ".zip")

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for full, rel in files:
            info = zipfile.ZipInfo(rel, date_time=FIXED_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            with open(full, "rb") as f:
                z.writestr(info, f.read())

    size = os.path.getsize(zip_path) / 1024
    print("Собрано «%s» v%s, файлов: %d" % (manifest.get("name", base), version, len(files)))
    for _, rel in files:
        print("   ", rel)
    print("
  dist/%s.zip  (%.1f КБ)  — Chrome / Edge / Яндекс / Opera" % (base, size))

    if FIREFOX:
        # .xpi — тот же ZIP под другим именем, отдельная сборка не нужна.
        xpi_path = os.path.join(OUT_DIR, base + ".xpi")
        with open(zip_path, "rb") as fr, open(xpi_path, "wb") as fw:
            fw.write(fr.read())
        print("  dist/%s.xpi  (%.1f КБ)  — Firefox" % (base, size))

    return 0


if __name__ == "__main__":
    sys.exit(main())
