#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from datetime import date, timedelta
import pronotepy
import json
import os

PRONOTE_URL = os.getenv("PRONOTE_URL", "https://0560101f.index-education.net/pronote/eleve.html")
USERNAME = os.getenv("PRONOTE_USERNAME")
PASSWORD = os.getenv("PRONOTE_PASSWORD")

pronotepy.pronoteAPI.HEADERS["User-Agent"] = "Mozilla/5.0"

try:
    client = pronotepy.Client(PRONOTE_URL, username=USERNAME, password=PASSWORD)
    if not client.logged_in:
        print(json.dumps([]))
        exit(1)

    today = date.today()
    end = today + timedelta(days=15)

    homeworks = []
    for item in client.homework(today, end):
        homeworks.append({
            "id": f"pronote_{item.id}",
            "subject": item.subject.name,
            "description": item.description or "",
            "due_date": str(item.date),
            "difficulty": "⭐⭐",
            "type": "exercice"
        })
    print(json.dumps(homeworks, ensure_ascii=False))

except Exception as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False), file=os.sys.stderr)
    print(json.dumps([]))
    exit(1)
