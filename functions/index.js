const {setGlobalOptions} = require("firebase-functions");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {defineSecret} = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const https = require("https");
const admin = require("firebase-admin");

// Initialize Firebase Admin
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

// Securely access the OpenRouter API key from Firebase Secret Manager.
const CEREBRAS_API_KEY = defineSecret("CEREBRAS_API_KEY");

// Cost and performance control.
setGlobalOptions({
  maxInstances: 10,
  region: "asia-south1",
});

// ============================================================
// AUTHENTICATION HELPER
// ============================================================

/**
 * Verify the request is authenticated and return coach metadata.
 * Throws HttpsError if not authenticated.
 * SECURITY: Only extracts uid and email from auth, never exposes tokens or API keys.
 */
function verifyAuth(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "You must be signed in to use CoachLens AI.");
  }
  const coachId = request.auth.uid;
  const email = request.auth.token.email || "";
  return { coachId, email };
}

// ============================================================
// SECURE DATA ACCESS HELPER FUNCTIONS
// ============================================================

/**
 * Safely extract player profile fields for AI consumption.
 * SECURITY: Never exposes contact, emergencyContact, coachEmail, coachId.
 */
function safePlayerProfile(playerDoc, coachId) {
  const data = playerDoc.data();
  if (!data) return null;

  // SECURITY: Verify coach ownership
  if (data.coachId !== coachId) {
    throw new HttpsError("permission-denied", "Access denied: not the coach of this player.");
  }

  return {
    name: data.name || "Unknown",
    playerId: data.playerId || "N/A",
    age: data.age || "N/A",
    role: data.role || "N/A",
    secondaryRole: data.secondaryRole || "",
    hand: data.hand || "N/A",
    bowlingArm: data.bowlingArm || "N/A",
    bowlingType: data.bowlingType || "N/A",
    battingPosition: data.battingPosition || "N/A",
    level: data.level || "N/A",
    notes: data.notes ? data.notes.substring(0, 150) : "",
  };
}

/**
 * Securely load player sessions/technical assessments.
 * SECURITY: Queries scoped to coachId; slices to 5 for context.
 */
async function loadPlayerSessions(playerId, coachId) {
  const snap = await db
    .collectionGroup("sessions")
    .where("coachId", "==", coachId)
    .where("playerId", "==", playerId)
    .orderBy("date", "desc")
    .limit(10)
    .get();

  const sessions = [];
  snap.forEach(doc => {
    const d = doc.data();
    sessions.push({
      date: d.date,
      role: d.role || "N/A",
      sessionType: d.sessionType || "Training",
      duration: d.duration || null,
      surface: d.surface || null,
      conditions: d.conditions || null,
      objective: d.objective || "",
      baseline: d.baseline || "",
      intervention: d.intervention || "",
      response: d.response || "",
      outcome: d.outcome || "",
      nextAction: d.nextAction || "",
      tags: d.tags || [],
      videoUrl: d.videoUrl || "",
      summary: d.summary ? d.summary.substring(0, 150) : null,
    });
  });
  return sessions.slice(0, 5);
}

/**
 * Securely load player day notes.
 * SECURITY: Only date, note, tags returned (no PII).
 */
async function loadPlayerDayNotes(playerId, coachId) {
  const snap = await db
    .collectionGroup("dayNotes")
    .where("coachId", "==", coachId)
    .where("playerId", "==", playerId)
    .orderBy("date", "desc")
    .limit(20)
    .get();

  const notes = [];
  snap.forEach(doc => {
    const d = doc.data();
    notes.push({
      date: d.date,
      note: d.note ? d.note.substring(0, 100) : "",
      tags: d.tags || [],
    });
  });
  return notes.slice(0, 5);
}

/**
 * Securely load coaching sessions for a player.
 * SECURITY: Where clause enforces coachId ownership.
 */
async function loadCoachCoachingSessions(playerId, coachId, sinceDate) {
  let query = db.collection("coachingSessions")
    .where("coachId", "==", coachId);
  if (playerId) query = query.where("playerId", "==", playerId);
  if (sinceDate) query = query.where("date", ">=", sinceDate);
  const snap = await query.orderBy("date", "desc").limit(15).get();
  const sessions = [];
  snap.forEach(doc => {
    const d = doc.data();
    sessions.push({
      date: d.date,
      type: d.type || "Session",
      category: d.category || "",
      objective: d.objective ? d.objective.substring(0, 150) : "",
      objectiveResult: d.objectiveResult || "",
      wentWell: d.wentWell ? d.wentWell.substring(0, 150) : "",
      improve: d.improve ? d.improve.substring(0, 150) : "",
      nextAction: d.nextAction ? d.nextAction.substring(0, 150) : "",
    });
  });
  return sessions.slice(0, 3);
}

/**
 * Securely load match records for a player.
 * SECURITY: Returns limited fields; no contact or internal notes.
 */
async function loadMatchRecords(playerId, coachId) {
  const snap = await db
    .collection("matches")
    .where("coachId", "==", coachId)
    .where("playerId", "==", playerId)
    .orderBy("date", "desc")
    .limit(15)
    .get();

  const matches = [];
  snap.forEach(doc => {
    const m = doc.data();
    matches.push({
      date: m.date,
      matchName: m.name || "Match",
      result: m.result || "N/A",
      runs: m.runs || 0,
      balls: m.balls || 0,
      fours: m.fours || 0,
      sixes: m.sixes || 0,
      battingAt: m.battingAt || null,
      dismissalMode: m.dismissalMode || null,
      overs: m.overs || null,
      wickets: m.wickets || 0,
      runsConceded: m.runsConceded || 0,
      dotBalls: m.dotBalls || 0,
      catches: m.catches || 0,
      runOuts: m.runOuts || 0,
      missedCatches: m.missedCatches || 0,
      coachPlayerNotes: m.coachPlayerNotes ? m.coachPlayerNotes.substring(0, 150) : "",
    });
  });
  return matches.slice(0, 5);
}

/**
 * Securely load all players for coach-level queries.
 * SECURITY: Only returns public-facing fields needed for team overview.
 */
async function loadCoachPlayers(coachId) {
  const snap = await db
    .collection("players")
    .where("coachId", "==", coachId)
    .select("name", "playerId", "role", "level", "sessionCount", "lastSessionAt")
    .get();

  const players = [];
  snap.forEach(doc => {
    const d = doc.data();
    players.push({
      id: doc.id,
      name: d.name || "Unknown",
      playerId: d.playerId || "N/A",
      role: d.role || "Batter",
      level: d.level || "Development",
      sessionCount: d.sessionCount || 0,
      lastSessionAt: d.lastSessionAt,
    });
  });
  return players;
}

/**
 * Securely load education materials metadata.
 * SECURITY: Only returns metadata, never storagePath or allowedCoachIds.
 */
async function loadEducationMaterials(coachId) {
  const snap = await db
    .collection("educationMaterials")
    .where("allowedCoachIds", "array-contains", coachId)
    .where("status", "==", "approved")
    .select("title", "category", "level", "author", "tags")
    .limit(50)
    .get();

  const materials = [];
  snap.forEach(doc => {
    const d = doc.data();
    materials.push({
      title: d.title || "Untitled",
      category: d.category || "General",
      level: d.level || "All Levels",
      author: d.author || "Unknown",
      tags: d.tags || [],
    });
  });
  return materials.slice(0, 3); // Limit for context
}

// ============================================================
// CONTEXT BUILDERS FOR AI
// ============================================================

function buildPlayerContext(profile, sessions, notes, coaching, matches, education) {
  let text = "PLAYER CONTEXT:\n";

  // Profile
  text += `You are analyzing ${profile.name} (${profile.playerId}), `;
  text += `a ${profile.age}-year-old ${profile.role}`;
  if (profile.secondaryRole) text += ` / ${profile.secondaryRole}`;
  text += `. Level: ${profile.level}.\n\n`;

  // Recent assessments
  if (sessions && sessions.length > 0) {
    text += `RECENT TECHNICAL ASSESSMENTS (Last ${sessions.length} sessions):\n`;
    sessions.forEach(s => {
      text += `- ${s.date}: ${s.sessionType} (${s.role})\n`;
      if (s.objective) text += `  Objective: ${s.objective}\n`;
      if (s.outcome) text += `  Outcome: ${s.outcome}\n`;
      if (s.nextAction) text += `  Next Action: ${s.nextAction}\n`;
      if (s.summary) text += `  Summary: ${s.summary}\n`;
    });
    text += "\n";
  }

  // Matches
  if (matches && matches.length > 0) {
    text += `RECENT MATCH PERFORMANCE (Last ${matches.length} matches):\n`;
    matches.forEach(m => {
      let line = `- ${m.date}: ${m.matchName} (${m.result})`;
      if (m.runs || m.balls) line += ` - Bat: ${m.runs}(${m.balls})`;
      if (m.fours || m.sixes) line += ` [4s:${m.fours} 6s:${m.sixes}]`;
      if (m.battingAt) line += ` | Bat at: ${m.battingAt}`;
      if (m.dismissalMode) line += ` | Dismissal: ${m.dismissalMode}`;
      if (m.overs) line += ` | Bowl: ${m.overs}ov ${m.runsConceded}r ${m.wickets}w`;
      if (m.dotBalls) line += ` | Dots: ${m.dotBalls}`;
      if (m.catches || m.runOuts || m.missedCatches) line += ` | Field: C${m.catches} RO${m.runOuts} MC${m.missedCatches}`;
      if (m.coachPlayerNotes) line += ` | Notes: ${m.coachPlayerNotes}`;
      text += `${line}\n`;
    });
    text += "\n";
  }

  // Notes
  if (notes && notes.length > 0) {
    text += `RECENT COACHING NOTES:\n`;
    notes.forEach(n => {
      text += `- ${n.date}: ${n.note}${n.tags && n.tags.length ? ` [${n.tags.join(", ")}]` : ""}\n`;
    });
    text += "\n";
  }

  // Coaching focus
  if (coaching && coaching.length > 0) {
    text += `RECENT COACHING FOCUS:\n`;
    coaching.forEach(c => {
      text += `- ${c.date}: ${c.type} / ${c.category}: ${c.objective}\n`;
      if (c.objectiveResult) text += `  Result: ${c.objectiveResult}\n`;
      if (c.wentWell) text += `  Went well: ${c.wentWell}\n`;
      if (c.improve) text += `  Improve: ${c.improve}\n`;
      if (c.nextAction) text += `  Next action: ${c.nextAction}\n`;
    });
    text += "\n";
  }

  // Education
  if (education && education.length > 0) {
    text += `RELEVANT COACHING RESOURCES:\n`;
    education.forEach(e => {
      text += `- "${e.title}" (${e.category}) by ${e.author}\n`;
    });
    text += "\n";
  }

  text += `Use this context to provide specific, personalized recommendations for ${profile.name}.`;
  return text;
}

function buildCoachContext(players, sessions, matches, coaching, education) {
  let text = "COACH TEAM CONTEXT:\n";

  // Player overview
  if (players && players.length > 0) {
    text += `Your Squad (${players.length} players):\n`;
    players.slice(0, 5).forEach(p => {
      text += `- ${p.name} (${p.role}), Level: ${p.level}, ${p.sessionCount} sessions\n`;
    });
    text += "\n";
  }

  // Recent coaching topics
  if (coaching && coaching.length > 0) {
    text += `RECENT TEAM COACHING:\n`;
    coaching.slice(0, 3).forEach(c => {
      text += `- ${c.date}: ${c.type} - ${c.objective}\n`;
    });
    text += "\n";
  }

  // Education resources available
  if (education && education.length > 0) {
    text += `YOUR COACHING LIBRARY (${education.length} resources):\n`;
    const cats = [...new Set(education.map(e => e.category))];
    text += `Categories: ${cats.join(", ")}\n`;
    text += "\n";
  }

  text += `Use this context to provide specific, coach-level recommendations and squad-wide insights.`;
  return text;
}

// ============================================================
// COACHSLENS AI - Main callable function
// ============================================================
exports.coachLensAI = onCall(
  {
    secrets: [CEREBRAS_API_KEY],
  },
  async (request) => {
    // 1. AUTHENTICATION - required for all calls
    const { coachId } = verifyAuth(request);

    const prompt = request.data?.prompt;
    const playerId = request.data?.playerId;

    // Validate prompt
    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError("invalid-argument", "A valid prompt is required.");
    }

    // Validate playerId if provided
    if (playerId && typeof playerId !== "string") {
      throw new HttpsError("invalid-argument", "Invalid player ID format.");
    }

    try {
      const apiKey = CEREBRAS_API_KEY.value();
      const messages = [
        {
          role: "system",
          content:
            "You are CoachLens AI, an expert cricket coaching assistant. " +
            "Provide practical, evidence-informed and coach-friendly answers. " +
            "Focus on player development, cricket technique, training, " +
            "performance analysis, match analysis and coaching methodology. " +
            "Use clear structure and actionable recommendations.",
        },
      ];

      // 2. DATA RETRIEVAL - either player-specific or coach-level
      if (playerId) {
        // Player-specific mode with parallel queries
        try {
          logger.info(`Retrieving player context for ${playerId}`);

          // QUICK: Get player profile (for name display)
          const playerSnap = await db.collection("players").doc(playerId).get();
          if (!playerSnap.exists) {
            throw new HttpsError("not-found", "Player not found.");
          }

          // SECURITY: Verify ownership
          const playerData = playerSnap.data();
          if (playerData.coachId !== coachId) {
            throw new HttpsError("permission-denied", "You do not have access to this player.");
          }

          const profile = safePlayerProfile(playerSnap, coachId);

          // PARALLEL: Load all other data concurrently
          const [sessions, notes, coaching, matches, education] = await Promise.all([
            loadPlayerSessions(playerId, coachId),
            loadPlayerDayNotes(playerId, coachId),
            loadCoachCoachingSessions(playerId, coachId),
            loadMatchRecords(playerId, coachId),
            loadEducationMaterials(coachId)
          ]);

          const contextText = buildPlayerContext(profile, sessions, notes, coaching, matches, education);
          messages.push({ role: "system", content: contextText });

        } catch (contextError) {
          if (contextError instanceof HttpsError) throw contextError;
          logger.warn("Failed to get player context, falling back to generic:", contextError.message);
        }
      } else {
        // Coach-level mode (team overview)
        try {
          logger.info(`Retrieving coach-level context for ${coachId}`);
          // Coach-level coaching sessions filtered by coachId, recent 6 months only.
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
          const [players, coaching, education] = await Promise.all([
            loadCoachPlayers(coachId),
            loadCoachCoachingSessions(null, coachId, sixMonthsAgo.toISOString()),
            loadEducationMaterials(coachId)
          ]);

          // Get recent match counts per player (lightweight)
          let matches = [];
          try {
            const matchSnap = await db
              .collection("matches")
              .where("coachId", "==", coachId)
              .orderBy("date", "desc")
              .limit(10)
              .get();
            matches = matchSnap.docs.map(d => ({ id: d.id, date: d.data().date }));
          } catch (e) { /* ignore */ }

          const contextText = buildCoachContext(players, null, matches, coaching, education);
          messages.push({ role: "system", content: contextText });

        } catch (contextError) {
          logger.warn("Failed to get coach context, falling back to generic:", contextError.message);
        }
      }

      // 3. ADD USER PROMPT
      messages.push({ role: "user", content: prompt });

      // 4. CALL CEREBRAS
      const requestBody = JSON.stringify({
        model: "gpt-oss-120b",
        messages: messages,
        temperature: 0.4,
        max_tokens: 2000,
      });

      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: "api.cerebras.ai",
          path: "/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Content-Length": Buffer.byteLength(requestBody),
          },
        };

        const req = https.request(options, (res) => {
          let responseData = "";
          res.on("data", (chunk) => { responseData += chunk; });
          res.on("end", () => {
            try {
              const parsed = JSON.parse(responseData);
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(parsed);
              } else {
                reject(new Error(`Cerebras API ${res.statusCode}: ${responseData}`));
              }
            } catch {
              reject(new Error("Failed to parse Cerebras response."));
            }
          });
        });

        req.on("error", reject);
        req.write(requestBody);
        req.end();
      });

      const answer = data?.choices?.[0]?.message?.content || "";

      return {
        success: true,
        answer: answer,
      };
    } catch (error) {
      logger.error("CoachLens AI error", error);
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("internal", "CoachLens AI could not process the request.");
    }
  }
);
