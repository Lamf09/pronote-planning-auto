#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Récupère les devoirs depuis le flux iCal Pronote (aucune connexion requise)
import os
import sys
import json
import re
import requests
from icalendar import Calendar
from datetime import date, timedelta

ICAL_URL = os.environ.get("PRONOTE_ICAL_URL", "").strip()
if not ICAL_URL:
    sys.exit("❌ PRONOTE_ICAL_URL absent")

resp = requests.get(ICAL_URL, timeout=30, headers={"User-Agent": "Mozilla/5.0"})
resp.raise_for_status()

cal = Calendar.from_ical(resp.text)

today = date.today()
horizon = today + timedelta(days=15)

def strip_html(text):
    text = re.sub(r"<br\s*/?>", " ", text or "")
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    return re.sub(r"\s+", " ", text).strip()

homeworks = []
for comp in cal.walk("VEVENT"):
    summary = strip_html(comp.get("SUMMARY"))
    description = strip_html(comp.get("DESCRIPTION"))
    dt = comp.get("DTSTART") or comp.get("DTEND")
    if not dt:
        continue
    d = dt.dt.date() if hasattr(dt.dt, "date") else dt.dt
    if d < today or d > horizon:
        continue
    homeworks.append({
        "id": f"pronote_{d.isoformat()}_{re.sub(r'[^a-zA-Z0-9]', '', summary)[:20]}",
        "subject": summary,
        "description": description,
        "due_date": d.isoformat(),
        "difficulty": "⭐⭐",
        "type": "exercice"
    })

print(json.dumps(homeworks, ensure_ascii=False))
print(f"📚 {len(homeworks)} devoirs récupérés depuis l'iCal Pronote.", file=sys.stderr)
