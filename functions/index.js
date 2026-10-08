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
const OPENROUTER_API_KEY = defineSecret("OPENROUTER_API_KEY");

// Cost and performance control.
setGlobalOptions({
  maxInstances: 10,
  region: "asia-south1",
});

// ============================================================
// HELPER FUNCTIONS FOR PLAYER CONTEXT
// ============================================================

/**
 * Extract technical issues from a session (fields marked "Needs improvement" or score <= 2)
 */
function extractTechnicalIssues(session) {
  const issues = [];
  for (const [key, value] of Object.entries(session)) {
    if (typeof value === "string" && value.includes("Needs improvement")) {
      issues.push(key);
    }
    if (key.endsWith("_score") && typeof value === "number" && value <= 2) {
      const fieldName = key.replace("_score", "");
      if (!issues.includes(fieldName)) {
        issues.push(fieldName);
      }
    }
  }
  return issues.length > 0 ? issues.join(", ") : null;
}

/**
 * Calculate bowling economy rate
 */
function calculateEconomy(overs, runsConceded) {
  if (!overs || overs === "0") return "0.00";
  const oversNum = parseFloat(overs);
  return oversNum > 0 ? (runsConceded / oversNum).toFixed(2) : "0.00";
}

/**
 * Calculate average batting score from matches
 */
function calculateAverageBattingScore(matches) {
  if (matches.length === 0) return "0.0";
  const totalRuns = matches.reduce((sum, m) => sum + (m.runs || 0), 0);
  return (totalRuns / matches.length).toFixed(1);
}

/**
 * Determine recent form based on last few matches
 */
function determineRecentForm(recentMatches) {
  if (recentMatches.length === 0) return "No recent matches";
  const avgRuns = recentMatches.reduce((sum, m) => sum + (m.runs || 0), 0) / recentMatches.length;
  if (avgRuns > 40) return "Excellent";
  if (avgRuns > 25) return "Good";
  if (avgRuns > 15) return "Average";
  return "Needs improvement";
}

/**
 * Retrieve comprehensive player context from Firestore
 */
async function getPlayerContext(playerId, coachId) {
  try {
    // 1. Get player profile and verify ownership
    const playerDoc = await db.collection("players").doc(playerId).get();

    if (!playerDoc.exists) {
      throw new HttpsError("not-found", "Player not found.");
    }

    const playerData = playerDoc.data();

    // SECURITY: Verify coach owns this player
    if (playerData.coachId !== coachId) {
      throw new HttpsError(
        "permission-denied",
        "You do not have access to this player."
      );
    }

    // 2. Get technical assessment sessions (limit to recent 10)
    const sessionsSnap = await db
      .collection("players")
      .doc(playerId)
      .collection("sessions")
      .orderBy("date", "desc")
      .limit(10)
      .get();

    const sessions = sessionsSnap.docs.map((d) => d.data());

    // 3. Get player day notes (limit to recent 20)
    const notesSnap = await db
      .collection("players")
      .doc(playerId)
      .collection("dayNotes")
      .orderBy("date", "desc")
      .limit(20)
      .get();

    const dayNotes = notesSnap.docs.map((d) => d.data());

    // 4. Get coaching sessions involving this player (limit to recent 15)
    const coachingSnap = await db
      .collection("coachingSessions")
      .where("coachId", "==", coachId)
      .where("playerId", "==", playerId)
      .orderBy("date", "desc")
      .limit(15)
      .get();

    const coachingSessions = coachingSnap.docs.map((d) => d.data());

    // 5. Get match records for this player (limit to recent 15)
    const matchesSnap = await db
      .collection("matches")
      .where("coachId", "==", coachId)
      .where("playerId", "==", playerId)
      .orderBy("date", "desc")
      .limit(15)
      .get();

    const matches = matchesSnap.docs.map((d) => d.data());

    return {
      player: playerData,
      sessions,
      dayNotes,
      coachingSessions,
      matches,
    };
  } catch (error) {
    // Re-throw HttpsError instances
    if (error instanceof HttpsError) {
      throw error;
    }
    // Log and throw generic error for unexpected issues
    logger.error("Error retrieving player context:", error);
    throw new HttpsError(
      "internal",
      "Failed to retrieve player data: " + error.message
    );
  }
}

/**
 * Build structured player context for AI prompt
 */
function buildPlayerContext(rawContext) {
  const {player, sessions, dayNotes, coachingSessions, matches} = rawContext;

  // Build summarized context
  const context = {
    profile: {
      name: player.name || "Unknown",
      playerId: player.playerId || "N/A",
      age: player.age || "N/A",
      role: player.role || "N/A",
      secondaryRole: player.secondaryRole || "",
      hand: player.hand || "N/A",
      bowlingArm: player.bowlingArm || "N/A",
      bowlingType: player.bowlingType || "N/A",
      battingPosition: player.battingPosition || "N/A",
      level: player.level || "N/A",
      notes: player.notes || "",
    },

    recentAssessments: sessions.slice(0, 5).map((s) => ({
      date: s.date || "Unknown date",
      role: s.role || player.role,
      technicalIssues: extractTechnicalIssues(s),
      summary: s.summary ? s.summary.substring(0, 200) : null,
    })),

    recentNotes: dayNotes.slice(0, 10).map((n) => ({
      date: n.date || "Unknown date",
      note: n.note || "",
      tags: n.tags || "",
    })),

    recentCoachingSessions: coachingSessions.slice(0, 5).map((cs) => ({
      date: cs.date || "Unknown date",
      type: cs.type || "N/A",
      category: cs.category || "N/A",
      objective: cs.objective || "",
      objectiveResult: cs.objectiveResult || "N/A",
      wentWell: cs.wentWell || "",
      improve: cs.improve || "",
      nextAction: cs.nextAction || "",
    })),

    recentMatches: matches.slice(0, 10).map((m) => ({
      date: m.date || "Unknown date",
      matchName: m.name || "Unknown match",
      result: m.result || "N/A",
      batting: {
        runs: m.runs || 0,
        balls: m.balls || 0,
        strikeRate: m.balls > 0 ? ((m.runs / m.balls) * 100).toFixed(1) : "0.0",
        fours: m.fours || 0,
        sixes: m.sixes || 0,
        battingAt: m.battingAt || "",
        dismissalMode: m.dismissalMode || "",
      },
      bowling: {
        overs: m.overs || "0",
        wickets: m.wickets || 0,
        runsConceded: m.runsConceded || 0,
        economy: calculateEconomy(m.overs, m.runsConceded),
        dotBalls: m.dotBalls || 0,
      },
      fielding: {
        catches: m.catches || 0,
        runOuts: m.runOuts || 0,
        missedCatches: m.missedCatches || 0,
      },
      notes: m.coachPlayerNotes || "",
    })),

    statistics: {
      totalSessions: sessions.length,
      totalMatches: matches.length,
      totalCoachingSessions: coachingSessions.length,
      averageBattingScore: calculateAverageBattingScore(matches),
      recentForm: determineRecentForm(matches.slice(0, 5)),
    },
  };

  return context;
}

/**
 * Format player context into AI-readable text
 */
function formatPlayerContextForAI(context) {
  let text = `PLAYER CONTEXT:\n`;
  text += `You are analyzing ${context.profile.name} (${context.profile.playerId}), `;
  text += `a ${context.profile.age}-year-old ${context.profile.role}.\n\n`;

  text += `PROFILE:\n`;
  text += `- Role: ${context.profile.role}`;
  if (context.profile.secondaryRole) {
    text += ` / ${context.profile.secondaryRole}`;
  }
  text += `\n`;
  text += `- Batting: ${context.profile.hand}, ${context.profile.battingPosition}\n`;
  text += `- Bowling: ${context.profile.bowlingArm}, ${context.profile.bowlingType}\n`;
  text += `- Level: ${context.profile.level}\n`;
  if (context.profile.notes) {
    text += `- Coach notes: ${context.profile.notes.substring(0, 150)}\n`;
  }
  text += `\n`;

  if (context.recentAssessments.length > 0) {
    text += `RECENT TECHNICAL ASSESSMENTS (Last ${context.recentAssessments.length} sessions):\n`;
    context.recentAssessments.forEach((s) => {
      text += `- ${s.date}:`;
      if (s.technicalIssues) {
        text += ` Issues: ${s.technicalIssues}`;
      } else {
        text += ` No major issues identified`;
      }
      if (s.summary) {
        text += `\n  Summary: ${s.summary}`;
      }
      text += `\n`;
    });
    text += `\n`;
  }

  if (context.recentMatches.length > 0) {
    text += `RECENT MATCH PERFORMANCE (Last ${context.recentMatches.length} matches):\n`;
    context.recentMatches.slice(0, 5).forEach((m) => {
      text += `- ${m.date} (${m.matchName}, ${m.result}): `;
      text += `${m.batting.runs}(${m.batting.balls}) SR ${m.batting.strikeRate}, `;
      text += `${m.bowling.wickets} wkts, ${m.bowling.economy} econ`;
      if (m.dismissalMode) {
        text += `, out ${m.dismissalMode}`;
      }
      if (m.notes) {
        text += `\n  Notes: ${m.notes.substring(0, 100)}`;
      }
      text += `\n`;
    });
    text += `\n`;
  }

  if (context.recentCoachingSessions.length > 0) {
    text += `COACHING FOCUS AREAS (Last ${context.recentCoachingSessions.length} sessions):\n`;
    context.recentCoachingSessions.slice(0, 3).forEach((cs) => {
      text += `- ${cs.date}: ${cs.objective} (${cs.objectiveResult})\n`;
      if (cs.improve) {
        text += `  To improve: ${cs.improve.substring(0, 150)}\n`;
      }
      if (cs.nextAction) {
        text += `  Next: ${cs.nextAction.substring(0, 100)}\n`;
      }
    });
    text += `\n`;
  }

  if (context.recentNotes.length > 0) {
    text += `RECENT COACHING NOTES:\n`;
    context.recentNotes.slice(0, 5).forEach((n) => {
      text += `- ${n.date}: ${n.note.substring(0, 100)}`;
      if (n.tags) {
        text += ` [${n.tags}]`;
      }
      text += `\n`;
    });
    text += `\n`;
  }

  text += `STATISTICS:\n`;
  text += `- Total assessments: ${context.statistics.totalSessions}\n`;
  text += `- Total matches: ${context.statistics.totalMatches}\n`;
  text += `- Average batting score: ${context.statistics.averageBattingScore}\n`;
  text += `- Recent form: ${context.statistics.recentForm}\n\n`;

  text += `Use this context to provide specific, personalized recommendations for ${context.profile.name}.`;

  return text;
}

// ============================================================
// COACHSLENS AI - Main callable function
// ============================================================
exports.coachLensAI = onCall(
  {
    secrets: [OPENROUTER_API_KEY],
  },
  async (request) => {
    // Only authenticated CoachLens users can use the AI.
    if (!request.auth) {
      throw new HttpsError(
        "unauthenticated",
        "You must be signed in to use CoachLens AI."
      );
    }

    const coachId = request.auth.uid;
    const prompt = request.data?.prompt;
    const playerId = request.data?.playerId; // Optional

    // Validate prompt
    if (!prompt || typeof prompt !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "A valid prompt is required."
      );
    }

    // Validate playerId if provided
    if (playerId && typeof playerId !== "string") {
      throw new HttpsError(
        "invalid-argument",
        "Invalid player ID format."
      );
    }

    try {
      const apiKey = OPENROUTER_API_KEY.value();

      // Build messages array starting with system message
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

      // If playerId is provided, retrieve and add player context
      if (playerId) {
        try {
          logger.info(`Retrieving context for player ${playerId}`);

          const rawContext = await getPlayerContext(playerId, coachId);

          // Check if player has any recorded data
          const hasData =
            rawContext.sessions.length > 0 ||
            rawContext.matches.length > 0 ||
            rawContext.coachingSessions.length > 0 ||
            rawContext.dayNotes.length > 0;

          if (hasData) {
            const playerContext = buildPlayerContext(rawContext);
            const contextText = formatPlayerContextForAI(playerContext);

            // Add player context as a system message
            messages.push({
              role: "system",
              content: contextText,
            });

            logger.info(
              `Player context added: ${rawContext.sessions.length} sessions, ` +
              `${rawContext.matches.length} matches, ` +
              `${rawContext.coachingSessions.length} coaching sessions`
            );
          } else {
            logger.info(
              `Player ${playerId} has no recorded data. Providing generic advice.`
            );
            // Add minimal context
            messages.push({
              role: "system",
              content:
                `You are being asked about player ${rawContext.player.name || "Unknown"}, ` +
                `but this player has no recorded sessions or match data yet. ` +
                `Provide general coaching advice relevant to their role: ${rawContext.player.role || "cricket player"}.`,
            });
          }
        } catch (contextError) {
          // If context retrieval fails but it's not a permission/auth error, log and continue
          if (contextError instanceof HttpsError) {
            throw contextError; // Re-throw permission/auth errors
          }
          logger.warn(
            `Failed to retrieve player context: ${contextError.message}. Falling back to generic AI.`
          );
          // Continue without player context (generic AI mode)
        }
      }

      // Add user's question
      messages.push({
        role: "user",
        content: prompt,
      });

      // Prepare OpenRouter API request
      const requestBody = JSON.stringify({
        model: "openrouter/free",
        messages: messages,
        temperature: 0.4,
        max_tokens: 2000,
      });

      // Make request to OpenRouter
      const data = await new Promise((resolve, reject) => {
        const options = {
          hostname: "openrouter.ai",
          path: "/api/v1/chat/completions",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
            "Content-Length": Buffer.byteLength(requestBody),
          },
        };

        const req = https.request(options, (res) => {
          let responseData = "";

          res.on("data", (chunk) => {
            responseData += chunk;
          });

          res.on("end", () => {
            try {
              const parsed = JSON.parse(responseData);
              if (res.statusCode >= 200 && res.statusCode < 300) {
                resolve(parsed);
              } else {
                reject(
                  new Error(
                    parsed?.error?.message || "OpenRouter API request failed."
                  )
                );
              }
            } catch (parseError) {
              reject(new Error("Failed to parse OpenRouter response."));
            }
          });
        });

        req.on("error", (error) => {
          reject(error);
        });

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

      // Re-throw HttpsError instances with their original code
      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        "internal",
        "CoachLens AI could not process the request."
      );
    }
  }
);