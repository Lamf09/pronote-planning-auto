/**
 * Script FINAL d'automatisation Pronote → Notion
 * Adapté aux bases de Loan Faure :
 * - Devoirs : 3e19fb28-8742-80d3-bca9-000bfa207cd1
 * - Séances : 3e19fb28-8742-8050-b511-000b7ec86591
 * Token : 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
 */

const axios = require('axios');
const { exec } = require('child_process');
const crypto = require('crypto');

// ============================================
// CONFIGURATION (TES IDS + TON TOKEN)
const CONFIG = {
  pronote: {
    apiUrl: "https://pronote-api-tz5f.onrender.com/devoirs",
    pythonScript: "get_devoirs.py",
    fallbackHomeworks: [
      {
        id: "hw_maths_contrôle",
        subject: "Maths",
        description: "Contrôle sur les équations différentielles",
        due_date: "2026-09-25",
        difficulty: "⭐⭐⭐",
        type: "contrôle"
      },
      {
        id: "hw_francais_dissertation",
        subject: "Français",
        description: "Dissertation sur le roman du XIXe siècle",
        due_date: "2026-09-28",
        difficulty: "⭐⭐",
        type: "exercice"
      },
      {
        id: "hw_svt_tp",
        subject: "SVT",
        description: "TP sur la photosynthèse",
        due_date: "2026-09-22",
        difficulty: "⭐",
        type: "exercice"
      }
    ]
  notion: {
  token: "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",
  databases: {
    homework: "3e19fb2887428027acd3c326d126a7b6",  
    revision: "3e19fb2887428050b511000b7ec86591"   
  }
}
}
  }
}
    }
  },
  scheduling: {
    defaultAvailability: {
      Monday: ["15:00", "19:00"],
      Tuesday: ["15:00", "19:00"],
      Wednesday: ["15:00", "19:00"],
      Thursday: ["15:00", "19:00"],
      Friday: ["09:00", "12:00"],
      Saturday: ["09:00", "17:00"],
      Sunday: ["09:00", "17:00"]
    },
    maxDailyTime: 240,  // 4h en minutes
    excludedDays: [5],  // Vendredi
    difficultyTimeMap: { "⭐": 30, "⭐⭐": 60, "⭐⭐⭐": 120 },
    typeMultipliers: { contrôle: 1.5, examen: 2.0, DM: 1.2, exercice: 1.0 }
  }
};

// ============================================
// FONCTIONS NOTION (avec gestion d'erreurs)
async function notionApiCall(method, endpoint, data = null) {
  const url = `https://api.notion.com/v1${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${CONFIG.notion.token}`,
    'Notion-Version': '2022-06-28',
    'Content-Type': 'application/json'
  };

  try {
    const response = await axios({
      method,
      url,
      headers,
      data
    });
    return response.data;
  } catch (error) {
    if (error.response) {
      throw new Error(`Notion API Error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Notion API Error: ${error.message}`);
  }
}

async function createNotionPage(databaseId, properties) {
  return await notionApiCall('POST', `/databases/${databaseId}/pages`, {
    parent: { database_id: databaseId },
    properties
  });
}

async function updateNotionPage(pageId, properties) {
  return await notionApiCall('PATCH', `/pages/${pageId}`, { properties });
}

async function findPageByProperty(databaseId, propertyName, value) {
  const response = await notionApiCall('POST', `/databases/${databaseId}/query`, {
    filter: {
      property: propertyName,
      rich_text: { equals: value }
    }
  });
  return response.results[0] || null;
}

// ============================================
// 1. RÉCUPÉRER LES DEVOIRS (Pronote → JSON)
async function fetchHomeworks() {
  console.log("📚 Récupération des devoirs depuis Pronote...");

  try {
    const response = await axios.get(CONFIG.pronote.apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });

    if (response.data?.homeworks?.length) {
      console.log(`✅ ${response.data.homeworks.length} devoirs récupérés depuis l'API.`);
      return response.data.homeworks.map(hw => ({
        ...hw,
        id: hw.id ? `pronote_${hw.id}` : `hw_${crypto.randomBytes(4).toString('hex')}`
      }));
    }
  } catch (error) {
    console.log(`⚠️ API Pronote inaccessible: ${error.message}. Tentative avec Python...`);
  }

  try {
    return new Promise((resolve) => {
      exec(`python3 ${CONFIG.pronote.pythonScript}`, {
        timeout: 30000,
        env: {
          PRONOTE_USERNAME: process.env.PRONOTE_USERNAME || "LFAURE",
          PRONOTE_PASSWORD: process.env.PRONOTE_PASSWORD || "Lamf29223556#",
          PRONOTE_URL: CONFIG.pronote.apiUrl
        }
      }, (error, stdout, stderr) => {
        if (error) {
          console.log(`⚠️ Script Python échoué: ${error.message}. Utilisation des données par défaut.`);
          resolve(CONFIG.pronote.fallbackHomeworks);
        } else {
          try {
            const homeworks = JSON.parse(stdout);
            console.log(`✅ ${homeworks.length} devoirs récupérés via Python.`);
            resolve(homeworks.map(hw => ({
              ...hw,
              id: hw.id || `hw_${crypto.randomBytes(4).toString('hex')}`
            })));
          } catch (parseError) {
            console.log(`⚠️ Erreur de parsing Python: ${parseError.message}. Utilisation des données par défaut.`);
            resolve(CONFIG.pronote.fallbackHomeworks);
          }
        }
      });
    });
  } catch (error) {
    console.log(`❌ Erreur script Python: ${error.message}. Utilisation des données par défaut.`);
    return CONFIG.pronote.fallbackHomeworks;
  }
}

// ============================================
// 2. ANALYSER LES DEVOIRS
function analyzeHomeworks(homeworks) {
  return homeworks.map(hw => {
    const description = (hw.description || '').toLowerCase();
    const type = description.includes('contrôle') ? 'contrôle' :
                 description.includes('examen') ? 'examen' :
                 description.includes('dm') ? 'DM' : 'exercice';

    const baseTime = CONFIG.scheduling.difficultyTimeMap[hw.difficulty] || 60;
    const multiplier = CONFIG.scheduling.typeMultipliers[type] || 1.0;
    const estimatedMinutes = Math.round(baseTime * multiplier);
    const sessionCount = Math.ceil(estimatedMinutes / 90);
    const sessionDuration = Math.min(90, Math.max(30, Math.ceil(estimatedMinutes / sessionCount)));

    return {
      ...hw,
      type,
      estimatedMinutes,
      sessionCount,
      sessionDuration
    };
  });
}

// ============================================
// 3. GÉNÉRER LE PLANNING
function generatePlanning(homeworks) {
  const schedule = [];
  const usedSlots = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  homeworks.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  homeworks.forEach(hw => {
    const dueDate = new Date(hw.due_date);
    const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));

    for (let i = 0; i < hw.sessionCount; i++) {
      const daysBeforeDue = Math.max(1, daysUntilDue - (hw.sessionCount - 1 - i));
      let sessionDate = new Date(dueDate);
      sessionDate.setDate(sessionDate.getDate() - daysBeforeDue);

      if (sessionDate.getDay() === 5) {
        sessionDate.setDate(sessionDate.getDate() - 1);
      }

      const dayName = sessionDate.toLocaleDateString('fr-FR', { weekday: 'long' });
      const availability = CONFIG.scheduling.defaultAvailability[dayName] || ["09:00", "17:00"];
      const startHour = parseInt(availability[0].split(':')[0]);
      const endHour = parseInt(availability[1].split(':')[0]);
      const dateKey = sessionDate.toISOString().split('T')[0];
      const existingSlots = usedSlots.get(dateKey) || [];

      let slotStartHour = startHour;
      let foundSlot = false;

      while (slotStartHour < endHour && !foundSlot) {
        const slotEndHour = slotStartHour + Math.floor(hw.sessionDuration / 60);
        const slotEndMin = hw.sessionDuration % 60;
        const slotKey = `${slotStartHour.toString().padStart(2, '0')}:00-${slotEndHour.toString().padStart(2, '0')}:${slotEndMin.toString().padStart(2, '0')}`;

        if (!existingSlots.includes(slotKey)) {
          const totalMinutesToday = existingSlots.reduce((sum, slot) => {
            const [s, e] = slot.split('-').map(t => {
              const [h, m] = t.split(':').map(Number);
              return h * 60 + m;
            });
            return sum + (e - s);
          }, 0) + hw.sessionDuration;

          if (totalMinutesToday <= CONFIG.scheduling.maxDailyTime) {
            existingSlots.push(slotKey);
            usedSlots.set(dateKey, existingSlots);

            schedule.push({
              id: `session_${hw.id}_${i}`,
              homeworkId: hw.id,
              subject: hw.subject,
              description: `${hw.description} (Session ${i + 1}/${hw.sessionCount})`,
              date: dateKey,
              day: sessionDate.toLocaleDateString('fr-FR', { weekday: 'long' }),
              startTime: `${slotStartHour.toString().padStart(2, '0')}:00`,
              endTime: `${slotEndHour.toString().padStart(2, '0')}:${slotEndMin.toString().padStart(2, '0')}`,
              duration: `${Math.floor(hw.sessionDuration / 60)}h${slotEndMin > 0 ? slotEndMin + 'min' : ''}`,
              difficulty: hw.difficulty,
              type: hw.type,
              status: "Pas commencé",
              locked: false
            });
            foundSlot = true;
          }
        }
        slotStartHour++;
      }

      if (!foundSlot) {
        console.log(`⚠️ Impossible de placer la séance ${i + 1} pour ${hw.subject} (${hw.sessionDuration} min).`);
      }
    }
  });

  return schedule.sort((a, b) => new Date(a.date + 'T' + a.startTime) - new Date(b.date + 'T' + b.startTime));
}

// ============================================
// 4. SYNCHRONISER AVEC NOTION (AVEC RELATIONS)
async function syncWithNotion(homeworks, schedule) {
  const { databases } = CONFIG.notion;
  const results = { created: 0, updated: 0, deleted: 0, errors: [] };

  console.log("\n📚 Synchronisation des devoirs...");
  for (const hw of homeworks) {
    try {
      const properties = {
        "Nom": { title: [{ text: { content: hw.subject } }] },
        "Description": { rich_text: [{ text: { content: hw.description } }] },
        "Date limite": { date: { start: hw.due_date } },
        "Difficulté": { select: { name: hw.difficulty } },
        "Type": { select: { name: hw.type } },
        "Statut": { select: { name: "À faire" } },
        "ID": { rich_text: [{ text: { content: hw.id } }] }
      };

      const existing = await findPageByProperty(databases.homework, "ID", hw.id);
      if (existing) {
        await updateNotionPage(existing.id, properties);
        console.log(`🔄 Devoir mis à jour: ${hw.subject}`);
        results.updated++;
      } else {
        await createNotionPage(databases.homework, properties);
        console.log(`✅ Devoir créé: ${hw.subject}`);
        results.created++;
      }
    } catch (error) {
      results.errors.push({ type: "homework", id: hw.id, error: error.message });
      console.log(`❌ Erreur devoir ${hw.subject}: ${error.message}`);
    }
  }

  console.log("\n📅 Synchronisation des séances...");
  for (const session of schedule) {
    try {
      const homeworkPage = await findPageByProperty(databases.homework, "ID", session.homeworkId);

      const properties = {
        "Matière": { select: { name: session.subject } },
        "Description": { rich_text: [{ text: { content: session.description } }] },
        "Date": { date: { start: session.date } },
        "Heure de début": { time: { start: session.startTime } },
        "Heure de fin": { time: { start: session.endTime } },
        "Durée": { rich_text: [{ text: { content: session.duration } }] },
        "Difficulté": { select: { name: session.difficulty } },
        "Type": { select: { name: session.type } },
        "Statut": { select: { name: session.status } },
        "Verrouillé": { checkbox: session.locked },
        "Planning ID": { rich_text: [{ text: { content: session.id } }] },
        "🔗 Devoir": { relation: homeworkPage ? [{ id: homeworkPage.id }] : [] }
      };

      const existing = await findPageByProperty(databases.revision, "Planning ID", session.id);
      if (existing) {
        if (!existing.properties?.Verrouillé?.checkbox) {
          await updateNotionPage(existing.id, properties);
          console.log(`🔄 Séance mise à jour: ${session.subject} (${session.date} ${session.startTime})`);
          results.updated++;
        } else {
          console.log(`🔒 Séance verrouillée: ${session.subject} (non modifiée)`);
        }
      } else {
        await createNotionPage(databases.revision, properties);
        console.log(`✅ Séance créée: ${session.subject} (${session.date} ${session.startTime})`);
        results.created++;
      }
    } catch (error) {
      results.errors.push({ type: "session", id: session.id, error: error.message });
      console.log(`❌ Erreur séance ${session.subject}: ${error.message}`);
    }
  }

  return results;
}

// ============================================
// MAIN
async function main() {
  console.log("=".repeat(60));
  console.log("🚀 DÉMARRAGE DE LA SYNCHRONISATION AUTOMATIQUE");
  console.log("=".repeat(60));

  try {
    const homeworks = await fetchHomeworks();
    const analyzedHomeworks = analyzeHomeworks(homeworks);
    console.log(`✅ ${analyzedHomeworks.length} devoirs analysés.`);
    const schedule = generatePlanning(analyzedHomeworks);
    console.log(`✅ ${schedule.length} séances générées.`);
    const results = await syncWithNotion(analyzedHomeworks, schedule);

    console.log("\n" + "=".repeat(60));
    console.log("📊 RAPPORT FINAL");
    console.log("=".repeat(60));
    console.log(`✅ Devoirs traités: ${analyzedHomeworks.length}`);
    console.log(`✅ Séances générées: ${schedule.length}`);
    console.log(`✅ Séances créées dans Notion: ${results.created}`);
    console.log(`🔄 Séances mises à jour dans Notion: ${results.updated}`);

    if (results.errors.length > 0) {
      console.log("\n⚠️ Erreurs:");
      results.errors.forEach(error => {
        console.log(`   - ${error.type} (${error.id}): ${error.error}`);
      });
    } else {
      console.log("\n✅ Aucune erreur !");
    }

    console.log("\n" + "=".repeat(60));
    console.log("✅ SYNCHRONISATION TERMINÉE");
    console.log("=".repeat(60));
  } catch (error) {
    console.log(`\n❌ ERREUR FATALE: ${error.message}`);
    console.log(error.stack);
  }
}

main();
// ============================================
// VALIDATION DES VARIABLES D'ENVIRONNEMENT
// ============================================
const requiredEnv = [
  "NOTION_TOKEN",
  "PRONOTE_USERNAME",
  "PRONOTE_PASSWORD"
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    console.error(`❌ ERREUR: Variable d'environnement manquante: ${name}`);
    process.exit(1);
  }
}

// ============================================
// GESTION DES ERREURS GLOBALE
// ============================================
process.on('unhandledRejection', (error) => {
  console.error("❌ Erreur non gérée :");
  console.error(error.stack || error);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error("❌ Erreur non capturée :");
  console.error(error.stack || error);
  process.exit(1);
});
