/**
 * Synchronisation Pronote -> Notion
 * Récupération des devoirs : Pawnote (compatible Pronote 2026)
 * Base Devoirs : 3e19fb28-8742-8084-97f0-f3a77dc86f14 (titre: "Subject")
 * Base Séances : 3e19fb28-8742-8013-8fde-d87d8df115c4 (titre: "Nom")
 * Séances = plages d'événements (Date avec début+fin), sans chevauchement.
 */

const axios = require('axios');
const crypto = require('crypto');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  pronote: {
    url: process.env.PRONOTE_URL || "https://0560101f.index-education.net/pronote/eleve.html",
    username: process.env.PRONOTE_USERNAME,
    password: process.env.PRONOTE_PASSWORD
  },
  // ... (notion, scheduling inchangés)
};,
  notion: {
    token: process.env.NOTION_TOKEN,
    databases: {
      homework: "3e19fb28-8742-8084-97f0-f3a77dc86f14",
      revision: "3e19fb28-8742-8013-8fde-d87d8df115c4"
    }
  },
  scheduling: {
    defaultAvailability: {
      "lundi": ["15:00", "19:00"], "mardi": ["15:00", "19:00"],
      "mercredi": ["15:00", "19:00"], "jeudi": ["15:00", "19:00"],
      "vendredi": ["09:00", "12:00"], "samedi": ["09:00", "17:00"],
      "dimanche": ["09:00", "17:00"]
    },
    maxDailyTime: 240,
    difficultyTimeMap: { "⭐": 30, "⭐⭐": 60, "⭐⭐⭐": 120 },
    typeMultipliers: { "contrôle": 1.5, "examen": 2.0, "DM": 1.2, "exercice": 1.0 }
  }
};

if (!process.env.NOTION_TOKEN) {
  console.error("❌ ERREUR: Variable d'environnement NOTION_TOKEN manquante.");
  process.exit(1);
}

process.on('unhandledRejection', (error) => {
  console.error("❌ Erreur non gérée :", error && error.stack ? error.stack : error);
  process.exit(1);
});

// ============================================
// FONCTIONS NOTION (fetch natif)
// ============================================
const NOTION_API_URL = "https://api.notion.com/v1";

async function notionApiCall(method, path, data) {
  const headers = {
    'Authorization': `Bearer ${CONFIG.notion.token}`,
    'Notion-Version': '2022-06-28'
  };
  let body;
  if (data !== undefined && data !== null) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  }
  const response = await fetch(`${NOTION_API_URL}${path}`, { method, headers, body });
  const json = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(`❌ Erreur Notion sur ${method} ${path} → ${response.status}`, json ? JSON.stringify(json).slice(0, 500) : response.statusText);
    throw new Error(`Notion ${response.status}: ${json && json.message ? json.message : response.statusText}`);
  }
  return json;
}

async function createNotionPage(databaseId, properties) {
  return notionApiCall('POST', '/pages', { parent: { database_id: databaseId }, properties });
}

async function validateNotionDatabases() {
  for (const [label, databaseId] of Object.entries(CONFIG.notion.databases)) {
    const db = await notionApiCall('GET', `/databases/${encodeURIComponent(databaseId)}`);
    const name = db.title && db.title[0] ? db.title[0].plain_text : databaseId;
    console.log(`✅ Base Notion "${label}" accessible : ${name}`);
  }
}

const schemaCache = new Map();
async function getSchema(databaseId, label) {
  if (schemaCache.has(databaseId)) return schemaCache.get(databaseId);
  const db = await notionApiCall('GET', `/databases/${databaseId}`);
  console.log(`🔎 Schéma base ${label} chargé (${Object.keys(db.properties).length} propriétés).`);
  schemaCache.set(databaseId, db.properties);
  return db.properties;
}

function buildProp(schema, name, value) {
  const prop = schema[name];
  if (!prop) { console.log(`   ⚠️ Propriété "${name}" absente de la base (ignorée).`); return undefined; }
  const type = prop.type;
  if (type === 'title') return { title: [{ text: { content: String(value) } }] };
  if (type === 'rich_text') return { rich_text: [{ text: { content: String(value) } }] };
  if (type === 'select') return { select: { name: String(value) } };
  if (type === 'status') {
    const opts = (prop.status.options || []).map(o => o.name);
    if (!opts.includes(String(value))) {
      console.log(`   ⚠️ Statut "${value}" invalide pour "${name}" (valides: ${opts.join(', ')}). Propriété ignorée.`);
      return undefined;
    }
    return { status: { name: String(value) } };
  }
  if (type === 'checkbox') return { checkbox: Boolean(value) };
  if (type === 'number') return { number: Number(value) };
  if (type === 'date') {
    if (value && typeof value === 'object' && value.start) {
      return { date: { start: String(value.start), end: value.end ? String(value.end) : undefined } };
    }
    return { date: { start: String(value) } };
  }
  if (type === 'url') return { url: String(value) };
  if (type === 'relation') return { relation: [{ id: String(value) }] };
  console.log(`   ⚠️ Type non géré (${type}) pour "${name}" (ignorée).`);
  return undefined;
}

function cleanProps(payload) {
  const out = {};
  for (const [k, v] of Object.entries(payload)) if (v !== undefined) out[k] = v;
  return out;
}

async function findPageByProperty(databaseId, schema, propertyName, value) {
  const prop = schema[propertyName];
  if (!prop) return null;
  const filterType = prop.type === 'title' ? 'title' : prop.type === 'rich_text' ? 'rich_text' : null;
  if (!filterType) return null;
  const response = await notionApiCall('POST', `/databases/${databaseId}/query`, {
    filter: { property: propertyName, [filterType]: { equals: value } }
  });
  return response.results[0] || null;
}

// ============================================
// 1. RÉCUPÉRER LES DEVOIRS (Pawnote — API officielle 1.6.2)
// ============================================
async function fetchHomeworks() {
  console.log("📚 Récupération des devoirs depuis Pronote (Pawnote)...");
  const pronote = await import('pawnote');

  // API officielle Pawnote 1.6.2 :
  //   createSessionHandle() puis loginCredentials(session, {...}) puis assignmentsFromWeek(session, from, to)
  const session = pronote.createSessionHandle();
  await pronote.loginCredentials(session, {
    url: CONFIG.pronote.url,
    username: CONFIG.pronote.username,
    password: CONFIG.pronote.password,
    deviceUUID: "pronote-planning-auto-9f2b", // identifiant d'appareil fixe (obligatoire)
    kind: pronote.AccountKind.STUDENT
  });
  console.log("✅ Connecté à Pronote.");

  // Devoirs : de la semaine actuelle (0) jusqu'à 3 semaines après
  const items = await pronote.assignmentsFromWeek(session, 0, 3);
  console.log(`🔎 ${items.length} devoirs trouvés (semaines 0 à 3).`);

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + 21);

  const difficultyMap = { 1: "⭐", 2: "⭐⭐", 3: "⭐⭐⭐" }; // AssignmentDifficulty -> étoiles

  const homeworks = items
    .filter(hw => hw.deadline && new Date(hw.deadline) >= today && new Date(hw.deadline) <= horizon)
    .map(hw => ({
      id: `pronote_${hw.id}`,
      subject: (hw.subject && hw.subject.name) || "Sans matière",
      description: (hw.description || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      due_date: new Date(hw.deadline).toISOString().split('T')[0],
      difficulty: difficultyMap[hw.difficulty] || "⭐⭐",
      type: "exercice"
    }));

  console.log(`✅ ${homeworks.length} devoirs récupérés (15-21 prochains jours).`);
  pronote.logout?.(session);
  return homeworks;
}
// ============================================
// 2. ANALYSER LES DEVOIRS
// ============================================
function analyzeHomeworks(homeworks) {
  return homeworks.map(hw => {
    const description = (hw.description || '').toLowerCase();
    const rawType = description.includes('contrôle') || description.includes('controle') ? 'contrôle'
      : description.includes('examen') ? 'examen'
      : description.includes('dm') ? 'DM' : (hw.type || 'exercice');
    const baseTime = CONFIG.scheduling.difficultyTimeMap[hw.difficulty] || 60;
    const estimatedMinutes = Math.round(baseTime * (CONFIG.scheduling.typeMultipliers[rawType] || 1.0));
    const sessionCount = Math.max(1, Math.ceil(estimatedMinutes / 90));
    const sessionDuration = Math.min(90, Math.max(30, Math.ceil(estimatedMinutes / sessionCount)));
    return { ...hw, type: rawType, estimatedMinutes, sessionCount, sessionDuration };
  });
}

// ============================================
// 3. GÉNÉRER LE PLANNING (plages SANS chevauchement)
// ============================================
function toMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function toHHMM(minutes) { return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; }

function generatePlanning(homeworks) {
  const schedule = [];
  const booked = new Map();
  const usedMinutes = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sorted = [...homeworks].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  function overlaps(dateKey, start, end) {
    for (const [s, e] of (booked.get(dateKey) || [])) {
      if (start < e && s < end) return true;
    }
    return false;
  }

  for (const hw of sorted) {
    const dueDate = new Date(hw.due_date + 'T00:00:00');
    const daysUntilDue = Math.max(1, Math.round((dueDate - today) / 86400000));
    for (let i = 0; i < hw.sessionCount; i++) {
      let placed = false;
      const maxBack = Math.min(daysUntilDue, 14);
      for (let offset = 1; offset <= maxBack && !placed; offset++) {
        const sessionDate = new Date(dueDate);
        sessionDate.setDate(sessionDate.getDate() - offset);
        const dateKey = sessionDate.toISOString().split('T')[0];
        if (sessionDate < today) continue;
        if ((usedMinutes.get(dateKey) || 0) + hw.sessionDuration > CONFIG.scheduling.maxDailyTime) continue;
        const dayName = sessionDate.toLocaleDateString('fr-FR', { weekday: 'long' });
        const availability = CONFIG.scheduling.defaultAvailability[dayName] || ["09:00", "17:00"];
        const winStart = toMinutes(availability[0]);
        const winEnd = toMinutes(availability[1]);
        for (let start = winStart; start + hw.sessionDuration <= winEnd && !placed; start += 15) {
          const end = start + hw.sessionDuration;
          if (overlaps(dateKey, start, end)) continue;
          if (!booked.has(dateKey)) booked.set(dateKey, []);
          booked.get(dateKey).push([start, end]);
          usedMinutes.set(dateKey, (usedMinutes.get(dateKey) || 0) + hw.sessionDuration);
          const startTime = toHHMM(start);
          const endTime = toHHMM(end);
          const hours = Math.floor(hw.sessionDuration / 60);
          const mins = hw.sessionDuration % 60;
          const duration = `${hours > 0 ? hours + 'h' : ''}${mins > 0 ? mins + 'min' : ''}` || "1h";
          schedule.push({
            id: `session_${hw.id}_${i}`,
            homeworkId: hw.id,
            subject: hw.subject,
            description: `${hw.description} (Session ${i + 1}/${hw.sessionCount})`,
            date: dateKey,
            startTime, endTime, duration,
            difficulty: hw.difficulty,
            type: hw.type,
            status: "Pas commencé",
            locked: false
          });
          placed = true;
        }
      }
      if (!placed) console.log(`⚠️ Impossible de placer la séance ${i + 1} pour ${hw.subject} (aucun créneau libre).`);
    }
  }
  return schedule.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
}

// ============================================
// 4. SYNCHRONISER AVEC NOTION
// ============================================
async function syncWithNotion(homeworks, schedule) {
  const { databases } = CONFIG.notion;
  const results = { created: 0, updated: 0, errors: [] };

  let hwSchema, revSchema;
  try {
    hwSchema = await getSchema(databases.homework, "Devoirs");
    revSchema = await getSchema(databases.revision, "Séances");
  } catch (error) {
    throw new Error(`Impossible d'accéder aux bases Notion: ${error.message}`);
  }

  console.log("\n📚 Synchronisation des devoirs...");
  const homeworkPageIds = new Map();
  for (const hw of homeworks) {
    try {
      const props = cleanProps({
        "Subject": buildProp(hwSchema, "Subject", hw.subject),
        "Description": buildProp(hwSchema, "Description", hw.description),
        "Date limite": buildProp(hwSchema, "Date limite", hw.due_date),
        "Difficulté": buildProp(hwSchema, "Difficulté", hw.difficulty),
        "Type": buildProp(hwSchema, "Type", hw.type),
        "Statut": buildProp(hwSchema, "Statut", "Pas commencé"),
        "ID": buildProp(hwSchema, "ID", hw.id)
      });
      const existing = await findPageByProperty(databases.homework, hwSchema, "ID", hw.id);
      if (existing) {
        await notionApiCall('PATCH', `/pages/${existing.id}`, { properties: props });
        homeworkPageIds.set(hw.id, existing.id);
        console.log(`🔄 Devoir mis à jour: ${hw.subject}`);
        results.updated++;
      } else {
        const created = await createNotionPage(databases.homework, props);
        homeworkPageIds.set(hw.id, created.id);
        console.log(`✅ Devoir créé: ${hw.subject}`);
        results.created++;
      }
    } catch (error) {
      results.errors.push({ type: "devoir", id: hw.id, error: error.message });
      console.log(`❌ Erreur devoir ${hw.subject}: ${error.message}`);
    }
  }

  console.log("\n📅 Synchronisation des séances...");
  for (const session of schedule) {
    try {
      const relationProp = revSchema["Devoirs"];
      const relatedId = homeworkPageIds.get(session.homeworkId);
      const relation = (relationProp && relatedId) ? buildProp(revSchema, "Devoirs", relatedId) : undefined;

      const dateRange = {
        start: `${session.date}T${session.startTime}:00`,
        end: `${session.date}T${session.endTime}:00`
      };

      const props = cleanProps({
        "Nom": buildProp(revSchema, "Nom", `${session.subject} — ${session.description.slice(0, 60)}`),
        "Matière": buildProp(revSchema, "Matière", session.subject),
        "Description": buildProp(revSchema, "Description", session.description),
        "Date": buildProp(revSchema, "Date", dateRange),
        "Durée": buildProp(revSchema, "Durée", session.duration),
        "Difficulté": buildProp(revSchema, "Difficulté", session.difficulty),
        "Type": buildProp(revSchema, "Type", session.type),
        "Statut": buildProp(revSchema, "Statut", session.status),
        "Verrouillé": buildProp(revSchema, "Verrouillé", session.locked),
        "Planning ID": buildProp(revSchema, "Planning ID", session.id),
        "Devoirs": relation
      });
      const existing = await findPageByProperty(databases.revision, revSchema, "Planning ID", session.id);
      if (existing) {
        const isLocked = existing.properties && existing.properties["Verrouillé"] && existing.properties["Verrouillé"].checkbox;
        if (!isLocked) {
          await notionApiCall('PATCH', `/pages/${existing.id}`, { properties: props });
          console.log(`🔄 Séance mise à jour: ${session.subject} (${session.date} ${session.startTime}-${session.endTime})`);
          results.updated++;
        } else {
          console.log(`🔒 Séance verrouillée: ${session.subject} (non modifiée)`);
        }
      } else {
        await createNotionPage(databases.revision, props);
        console.log(`✅ Séance créée: ${session.subject} (${session.date} ${session.startTime}-${session.endTime})`);
        results.created++;
      }
    } catch (error) {
      results.errors.push({ type: "séance", id: session.id, error: error.message });
      console.log(`❌ Erreur séance ${session.subject}: ${error.message}`);
    }
  }
  return results;
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log("============================================================");
  console.log("🚀 DÉMARRAGE DE LA SYNCHRONISATION AUTOMATIQUE");
  console.log("============================================================");
  await validateNotionDatabases();
  const homeworks = await fetchHomeworks();
  const analyzed = analyzeHomeworks(homeworks);
  console.log(`✅ ${analyzed.length} devoirs analysés.`);
  const schedule = generatePlanning(analyzed);
  console.log(`✅ ${schedule.length} séances générées (créneaux sans chevauchement).`);
  const results = await syncWithNotion(analyzed, schedule);

  console.log("\n============================================================");
  console.log("📊 RAPPORT FINAL");
  console.log(`✅ Créations: ${results.created} | 🔄 Mises à jour: ${results.updated} | ❌ Erreurs: ${results.errors.length}`);
  results.errors.forEach(e => console.log(`   - ${e.type} (${e.id}): ${e.error}`));
  console.log("============================================================");
  if (results.errors.length > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error("❌ ERREUR FATALE:", error && error.stack ? error.stack : error);
  process.exit(1);
});
