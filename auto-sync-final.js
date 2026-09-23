/**
 * Synchronisation Pronote -> Notion
 * Base Devoirs : 3e19fb28-8742-80d3-bca9-000bfa207cd1 (titre: "Subject")
 * Base Séances : 3e19fb28-8742-8050-b511-000b7ec86591 (titre: "Nom")
 * Secrets passés par variables d'environnement (GitHub Secrets).
 * Les matières sont envoyées telles quelles : si l'option n'existe pas
 * dans le select "Matière", Notion la crée automatiquement.
 */

const axios = require('axios');
const crypto = require('crypto');

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  pronote: {
    apiUrl: "https://pronote-api-tz5f.onrender.com/devoirs",
    fallbackHomeworks: [
      { id: "hw_maths_controle", subject: "Math", description: "Contrôle sur les équations différentielles", due_date: "2026-09-25", difficulty: "⭐⭐⭐", type: "contrôle" },
      { id: "hw_francais_dissertation", subject: "Français", description: "Dissertation sur le roman du XIXe siècle", due_date: "2026-09-28", difficulty: "⭐⭐", type: "exercice" },
      { id: "hw_svt_tp", subject: "SVT", description: "TP sur la photosynthèse", due_date: "2026-09-22", difficulty: "⭐", type: "exercice" }
    ]
  },
  notion: {
    token: process.env.NOTION_TOKEN,
    databases: {
      homework: "3e19fb28-8742-8084-97f0-f3a77dc86f14", // base Devoirs (ID base, pas data source)
      revision: "3e19fb28-8742-8013-8fde-d87d8df115c4"  // base Séances (ID base, pas data source)
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

// Validation des variables d'environnement
if (!process.env.NOTION_TOKEN) {
  console.error("❌ ERREUR: Variable d'environnement NOTION_TOKEN manquante.");
  process.exit(1);
}

process.on('unhandledRejection', (error) => {
  console.error("❌ Erreur non gérée :", error && error.stack ? error.stack : error);
  process.exit(1);
});

// ============================================
// FONCTIONS NOTION
// ============================================
async function notionApiCall(method, endpoint, data) {
  try {
    const config = {
      method,
      url: `https://api.notion.com/v1${endpoint}`,
      headers: {
        'Authorization': `Bearer ${CONFIG.notion.token}`,
        'Notion-Version': '2022-06-28'
      },
      timeout: 15000
    };
    // Body uniquement si présent : les GET ne doivent PAS avoir de Content-Type/body
    if (data !== undefined && data !== null) {
      config.headers['Content-Type'] = 'application/json';
      config.data = data;
    }
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const status = error.response ? error.response.status : null;
    const body = error.response ? error.response.data : null;
    console.error(`❌ Erreur Notion sur ${method} ${endpoint} → ${status || 'réseau'}`, body ? JSON.stringify(body).slice(0, 500) : error.message);
    throw new Error(`Notion ${status || 'réseau'}: ${body && body.message ? body.message : error.message}`);
  }
}

// Validation d'accès aux bases avant toute synchronisation
async function validateNotionDatabases() {
  for (const [label, databaseId] of Object.entries(CONFIG.notion.databases)) {
    const db = await notionApiCall('GET', `/databases/${databaseId}`);
    const name = db.title && db.title[0] ? db.title[0].plain_text : databaseId;
    console.log(`✅ Base Notion "${label}" accessible : ${name}`);
  }
}

// Cache des schémas de bases (types de propriétés)
const schemaCache = new Map();
async function getSchema(databaseId, label) {
  if (schemaCache.has(databaseId)) return schemaCache.get(databaseId);
  const db = await notionApiCall('GET', `/databases/${databaseId}`);
  console.log(`🔎 Schéma base ${label} chargé (${Object.keys(db.properties).length} propriétés).`);
  schemaCache.set(databaseId, db.properties);
  return db.properties;
}

// Construit le payload d'une propriété selon son type réel dans Notion
function buildProp(schema, name, value) {
  const prop = schema[name];
  if (!prop) { console.log(`   ⚠️ Propriété "${name}" absente de la base (ignorée).`); return undefined; }
  const type = prop.type;
  if (type === 'title') return { title: [{ text: { content: String(value) } }] };
  if (type === 'rich_text') return { rich_text: [{ text: { content: String(value) } }] };
  // select : si l'option n'existe pas, Notion la crée automatiquement
  if (type === 'select') return { select: { name: String(value) } };
  // status : les options sont figées -> on vérifie qu'elle existe
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
  if (type === 'date') return { date: { start: String(value) } };
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
// 1. RÉCUPÉRER LES DEVOIRS
// ============================================
async function fetchHomeworks() {
  console.log("📚 Récupération des devoirs depuis Pronote...");
  try {
    const response = await axios.get(CONFIG.pronote.apiUrl, { timeout: 15000 });
    const list = Array.isArray(response.data) ? response.data : response.data.homeworks || response.data.devoirs || [];
    if (list.length) {
      console.log(`✅ ${list.length} devoirs récupérés depuis l'API.`);
      return list.map(hw => ({
        id: hw.id ? `pronote_${hw.id}` : `hw_${crypto.randomBytes(4).toString('hex')}`,
        subject: hw.subject || hw.matiere || "Sans matière",
        description: hw.description || hw.description_html || "",
        due_date: (hw.due_date || hw.date || "").slice(0, 10),
        difficulty: hw.difficulty || "⭐⭐",
        type: hw.type || "exercice"
      })).filter(hw => hw.due_date);
    }
    console.log("⚠️ API sans devoirs, utilisation des données de secours.");
  } catch (error) {
    console.log(`⚠️ API Pronote inaccessible: ${error.message}. Données de secours.`);
  }
  return CONFIG.pronote.fallbackHomeworks;
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
    // La base n'accepte que: contrôle, exercice, DM (sinon option auto-créée, pas grave pour select)
    const baseTime = CONFIG.scheduling.difficultyTimeMap[hw.difficulty] || 60;
    const estimatedMinutes = Math.round(baseTime * (CONFIG.scheduling.typeMultipliers[rawType] || 1.0));
    const sessionCount = Math.max(1, Math.ceil(estimatedMinutes / 90));
    const sessionDuration = Math.min(90, Math.max(30, Math.ceil(estimatedMinutes / sessionCount)));
    return { ...hw, type: rawType, estimatedMinutes, sessionCount, sessionDuration };
  });
}

// ============================================
// 3. GÉNÉRER LE PLANNING
// ============================================
function generatePlanning(homeworks) {
  const schedule = [];
  const usedMinutes = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const sorted = [...homeworks].sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  for (const hw of sorted) {
    const dueDate = new Date(hw.due_date + 'T00:00:00');
    const daysUntilDue = Math.max(1, Math.round((dueDate - today) / 86400000));
    for (let i = 0; i < hw.sessionCount; i++) {
      let placed = false;
      const maxBack = Math.min(daysUntilDue, 14);
      for (let back = Math.min(maxBack, hw.sessionCount + 1); back >= 1 && !placed; back--) {
        const sessionDate = new Date(dueDate);
        sessionDate.setDate(sessionDate.getDate() - back);
        const dateKey = sessionDate.toISOString().split('T')[0];
        if (sessionDate < today) continue;
        if ((usedMinutes.get(dateKey) || 0) + hw.sessionDuration > CONFIG.scheduling.maxDailyTime) continue;
        const dayName = sessionDate.toLocaleDateString('fr-FR', { weekday: 'long' });
        const availability = CONFIG.scheduling.defaultAvailability[dayName] || ["09:00", "17:00"];
        const startHour = parseInt(availability[0].split(':')[0]);
        const endHour = parseInt(availability[1].split(':')[0]);
        for (let h = startHour; h + Math.ceil(hw.sessionDuration / 60) <= endHour && !placed; h++) {
          const startMin = h * 60;
          const endMin = startMin + hw.sessionDuration;
          const startTime = `${String(h).padStart(2, '0')}:00`;
          const endTime = `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`;
          const hours = Math.floor(hw.sessionDuration / 60);
          const mins = hw.sessionDuration % 60;
          const duration = `${hours > 0 ? hours + 'h' : ''}${mins > 0 ? mins + 'min' : ''}` || "1h";
          usedMinutes.set(dateKey, (usedMinutes.get(dateKey) || 0) + hw.sessionDuration);
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
      if (!placed) console.log(`⚠️ Impossible de placer la séance ${i + 1} pour ${hw.subject}.`);
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
      // Base Devoirs : titre = "Subject"
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
        const created = await notionApiCall('POST', `/databases/${databases.homework}/pages`, { parent: { database_id: databases.homework }, properties: props });
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
      // Relation vers le devoir (propriété "Devoirs" de la base Séances)
      const relationProp = revSchema["Devoirs"];
      const relatedId = homeworkPageIds.get(session.homeworkId);
      const relation = (relationProp && relatedId) ? buildProp(revSchema, "Devoirs", relatedId) : undefined;

      // "Heure de début" / "Heure de fin" sont de type date -> datetime ISO complet
      const startDateTime = `${session.date}T${session.startTime}:00`;
      const endDateTime = `${session.date}T${session.endTime}:00`;

      // Base Séances : titre = "Nom", matière envoyée telle quelle (option auto-créée si besoin)
      const props = cleanProps({
        "Nom": buildProp(revSchema, "Nom", `${session.subject} — ${session.description.slice(0, 60)}`),
        "Matière": buildProp(revSchema, "Matière", session.subject),
        "Description": buildProp(revSchema, "Description", session.description),
        "Date": buildProp(revSchema, "Date", session.date),
        "Heure de début": buildProp(revSchema, "Heure de début", startDateTime),
        "Heure de fin": buildProp(revSchema, "Heure de fin", endDateTime),
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
          console.log(`🔄 Séance mise à jour: ${session.subject} (${session.date} ${session.startTime})`);
          results.updated++;
        } else {
          console.log(`🔒 Séance verrouillée: ${session.subject} (non modifiée)`);
        }
      } else {
        await notionApiCall('POST', `/databases/${databases.revision}/pages`, { parent: { database_id: databases.revision }, properties: props });
        console.log(`✅ Séance créée: ${session.subject} (${session.date} ${session.startTime})`);
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
  console.log(`✅ ${schedule.length} séances générées.`);
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
