#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from datetime import date, timedelta
from urllib.parse import urlparse
import pronotepy
import json
import os
import sys

PRONOTE_URL = os.getenv("PRONOTE_URL", "").strip()
USERNAME = os.getenv("PRONOTE_USERNAME")
PASSWORD = os.getenv("PRONOTE_PASSWORD")

# --- Validation de l'URL avant tout ---
if not PRONOTE_URL:
    sys.exit("❌ PRONOTE_URL absent")
parsed = urlparse(PRONOTE_URL)
if parsed.scheme not in ("http", "https") or not parsed.netloc:
    sys.exit("❌ PRONOTE_URL doit être une URL http(s) complète")
if "index-education.net" not in parsed.netloc and "pronote" not in parsed.netloc:
    print(f"⚠️ Attention: l'hôte '{parsed.netloc}' ne semble pas être un serveur Pronote direct.")
print(f"🔗 Connexion à : {parsed.netloc}{parsed.path}", file=sys.stderr)
print(f"📦 pronotepy version : {pronotepy.__version__ if hasattr(pronotepy, '__version__') else 'inconnue'}", file=sys.stderr)

pronotepy.pronoteAPI.HEADERS["User-Agent"] = "Mozilla/5.0"

try:
    client = pronotepy.Client(PRONOTE_URL, username=USERNAME, password=PASSWORD)
    if not client.logged_in:
        print(json.dumps([]))
        sys.exit(1)

    today = date.today()
    end = today + timedelta(days=15)

    homeworks = []
    for item in client.homework(today, end):
        homeworks.append({
            "id": f"pronote_{item.id}",
            "subject": item.subject.name,
            "description": (item.description or "").replace("\n", " ").strip(),
            "due_date": str(item.date),
            "difficulty": "⭐⭐",
            "type": "exercice"
        })
    print(json.dumps(homeworks, ensure_ascii=False))
    print(f"📚 {len(homeworks)} devoirs récupérés.", file=sys.stderr)

except pronotepy.exceptions.PronoteAPIError as e:
    print(f"❌ Erreur pronotepy : {e}", file=sys.stderr)
    print(json.dumps([]))
    sys.exit(1)
except Exception as e:
    print(f"❌ Erreur inattendue : {type(e).__name__}: {e}", file=sys.stderr)
    print(json.dumps([]))
    sys.exit(1)
