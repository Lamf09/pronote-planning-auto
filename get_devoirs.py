#!/usr/bin/env python3
# -*- coding: utf-8 -*-
from datetime import date
import pronotepy
import json
import os

PRONOTE_URL = os.getenv("PRONOTE_URL", "https://0560101f.index-education.net/pronote/eleve.html")
USERNAME = os.getenv("PRONOTE_USERNAME", "LFAURE")
PASSWORD = os.getenv("PRONOTE_PASSWORD", "Lamf29223556#")

pronotepy.pronoteAPI.HEADERS["User-Agent"] = "Mozilla/5.0"

try:
    client = pronotepy.Client(PRONOTE_URL, username=USERNAME, password=PASSWORD)
    if not client.logged_in:
        print(json.dumps([{"subject": "Erreur", "description": "Connexion Pronote échouée", "due_date": str(date.today()), "difficulty": "⭐"}]))
        exit(1)

    homeworks = []
    for item in client.homework(date.today()):
        homeworks.append({
            "id": f"pronote_{item.id}",
            "subject": item.subject.name,
            "description": item.description or "",
            "due_date": str(item.date),
            "difficulty": "⭐⭐"
        })
    print(json.dumps(homeworks))

except Exception as e:
    print(json.dumps([{"subject": "Erreur", "description": str(e), "due_date": str(date.today()), "difficulty": "⭐"}]))
