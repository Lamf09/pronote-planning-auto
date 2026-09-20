/**
 * Script d'automatisation complète Pronote → Notion
 * Exécute : node auto-sync-complete.js
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { exec } = require('child_process');
const crypto = require('crypto');

// Configuration
const CONFIG = {
  pronote: {
    apiUrl: "https://pronote-api-tz5f.onrender.com/devoirs",
    pythonScript: "get_devoirs.py",
    fallbackHomeworks: [
      { subject: "Maths", description: "Contrôle sur les équations différentielles", due_date: "2026-09-25", difficulty: "⭐⭐⭐", type: "contrôle" },
      { subject: "Français", description: "Dissertation sur le roman du XIXe siècle", due_date: "2026-09-28", difficulty: "⭐⭐", type: "exercice" },
      { subject: "SVT", description: "TP sur la photosynthèse", due_date: "2026-09-22", difficulty: "⭐", type: "exercice" }
    ]
  },
  notion: {
    token: process.env.NOTION_TOKEN,
    databases: {
      homework: "27c9fb28-8742-80c7-a960-000b3ebcbe56",
      revision: "3ab9fb28-8742-8041-889b-000b3d3def45"
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
    maxDailyTime: 240,
    excludedDays: [5],
    difficultyTimeMap: { "⭐": 30, "⭐⭐": 60, "⭐⭐⭐": 120 },
    typeMultipliers: { contrôle: 1.5, examen: 2.0, DM: 1.2, exercice: 1.0 }
  }
};

// 1. Récupérer les devoirs
async function fetchHomeworks() {
  try {
    const response = await axios.get(CONFIG.pronote.apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    if (response.data?.homeworks) return response.data.homeworks;
  } catch (error) {
    console.log("⚠️ API bloquée, tentative avec Python...");
  }

  // Fallback : Python
  return new Promise((resolve) => {
    exec(`python3 ${CONFIG.pronote.pythonScript}`, (error, stdout) => {
      if (error) {
        console.log("⚠️ Python échoué, données par défaut.");
        resolve(CONFIG.pronote.fallbackHomeworks);
      } else {
        try { resolve(JSON.parse(stdout)); }
        catch { resolve(CONFIG.pronote.fallbackHomeworks); }
      }
    });
  });
}

// 2. Analyser les devoirs
function analyzeHomeworks(homeworks) {
  return homeworks.map(hw => {
    const type = hw.description?.toLowerCase().includes("contrôle") ? "contrôle" :
                 hw.description?.toLowerCase().includes("examen") ? "examen" :
                 hw.description?.toLowerCase().includes("dm") ? "DM" : "exercice";
    const baseTime = CONFIG.scheduling.difficultyTimeMap[hw.difficulty] || 60;
    const multiplier = CONFIG.scheduling.typeMultipliers[type] || 1.0;
    const estimatedMinutes = Math.round(baseTime * multiplier);
    const sessionCount = Math.ceil(estimatedMinutes / 90);
    const sessionDuration = Math.min(90, Math.max(30, Math.ceil(estimatedMinutes / sessionCount)));
    return { ...hw, type, estimatedMinutes, sessionCount, sessionDuration };
  });
}

// 3. Générer le planning
function generatePlanning(homeworks) {
  const schedule = [];
  const usedSlots = new Map();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  homeworks.sort((a, b) => new Date(a.due_date) - new Date(b.due_date));

  homeworks.forEach(hw => {
    const dueDate = new Date(hw.due_date);
    const daysUntilDue = Math.ceil((dueDate - today) / (1000 * 60 * 60 * 24));
    for (let i = 0; i < hw.sessionCount; i++) {
      const daysBeforeDue = Math.max(1, daysUntilDue - (hw.sessionCount - 1 - i));
      let sessionDate = new Date(dueDate);
      sessionDate.setDate(sessionDate.getDate() - daysBeforeDue);
      if (sessionDate.getDay() === 5) sessionDate.setDate(sessionDate.getDate() - 1); // Exclure vendredi
      const dayName = sessionDate.toLocaleDateString('fr-FR', { weekday: 'long' });
      const [startHour, endHour] = CONFIG.scheduling.defaultAvailability[dayName] || ["09:00", "17:00"];
      const dateKey = sessionDate.toISOString().split('T')[0];
      const existingSlots = usedSlots.get(dateKey) || [];
      let slotStartHour = parseInt(startHour.split(':')[0]);
      let foundSlot = false;

      while (slotStartHour < parseInt(endHour.split(':')[0]) && !foundSlot) {
        const slotEndHour = slotStartHour + Math.floor(hw.sessionDuration / 60);
        const slotEndMin = hw.sessionDuration % 60;
        const slotKey = `${slotStartHour.toString().padStart(2, '0')}:00-${slotEndHour.toString().padStart(2, '0')}:${slotEndMin.toString().padStart(2, '0')}`;
        if (!existingSlots.includes(slotKey)) {
          const totalMinutesToday = existingSlots.reduce((sum, slot) => {
            const [s, e] = slot.split('-').map(t => t.split(':').reduce((a, b) => a * 60 + parseInt(b), 0));
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
    }
  });
  return schedule.sort((a, b) => new Date(a.date + 'T' + a.startTime) - new Date(b.date + 'T' + b.startTime));
}

// 4. Synchroniser avec Notion
async function syncWithNotion(homeworks, schedule) {
  const { token, databases } = CONFIG.notion;
  const results = { created: 0, updated: 0, errors: [] };

  for (const hw of homeworks) {
    try {
      const properties = {
        "Subject": { title: [{ text: { content: hw.subject } }] },
        "Description": { rich_text: [{ text: { content: hw.description } }] },
        "Date limite": { date: { start: hw.due_date } },
        "Difficulté": { select: { name: hw.difficulty } },
        "Type": { select: { name: hw.type } },
        "Statut": { select: { name: "À faire" } },
        "ID": { rich_text: [{ text: { content: hw.id || `hw_${crypto.randomBytes(4).toString('hex')}` } }] }
      };
      const existing = await findPageById(token, databases.homework, hw.id, "ID");
      if (existing) {
        await updateNotionPage(token, existing.id, properties);
        console.log(`🔄 Devoir mis à jour: ${hw.subject}`);
      } else {
        await createNotionPage(token, databases.homework, properties);
        console.log(`✅ Devoir créé: ${hw.subject}`);
        results.created++;
      }
    } catch (error) {
      results.errors.push({ type: "homework", error: error.message });
      console.log(`❌ Erreur devoir ${hw.subject}: ${error.message}`);
    }
  }

  for (const session of schedule) {
    try {
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
        "Devoir ID": { rich_text: [{ text: { content: session.homeworkId } }] }
      };
      const existing = await findPageById(token, databases.revision, session.id, "Planning ID");
      if (existing) {
        if (!existing.properties?.Verrouillé?.checkbox) {
          await updateNotionPage(token, existing.id, properties);
          console.log(`🔄 Séance mise à jour: ${session.subject}`);
          results.updated++;
        } else {
          console.log(`🔒 Séance verrouillée: ${session.subject} (non modifiée)`);
        }
      } else {
        await createNotionPage(token, databases.revision, properties);
        console.log(`✅ Séance créée: ${session.subject} (${session.date} ${session.startTime})`);
        results.created++;
      }
    } catch (error) {
      results.errors.push({ type: "session", error: error.message });
      console.log(`❌ Erreur séance ${session.subject}: ${error.message}`);
    }
  }
  return results;
}

// Fonctions Notion API
async function createNotionPage(token, databaseId, properties) {
  await axios.post(`https://api.notion.com/v1/databases/${databaseId}/pages`, {
    parent: { database_id: databaseId },
    properties
  }, { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' } });
}

async function updateNotionPage(token, pageId, properties) {
  await axios.patch(`https://api.notion.com/v1/pages/${pageId}`, {
    properties
  }, { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' } });
}

async function findPageById(token, databaseId, id, propertyName) {
  const response = await axios.post(
    `https://api.notion.com/v1/databases/${databaseId}/query`,
    { filter: { property: propertyName, rich_text: { equals: id } } },
    { headers: { 'Authorization': `Bearer ${token}`, 'Notion-Version': '2022-06-28' } }
  );
  return response.data.results[0] || null;
}

// Main
async function main() {
  console.log("🚀 Début de la synchronisation...");
  const homeworks = await fetchHomeworks();
  const analyzedHomeworks = analyzeHomeworks(homeworks);
  const schedule = generatePlanning(analyzedHomeworks);
  const results = await syncWithNotion(analyzedHomeworks, schedule);
  console.log(`✅ Synchronisation terminée: ${results.created} créations, ${results.updated} mises à jour.`);
}

main().catch(console.error);
