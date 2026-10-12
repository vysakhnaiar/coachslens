const MAX_CONTEXT_BYTES = 24000;
const MAX_CONTEXT_RECORDS = 20;
const MAX_UNORDERED_SCAN_RECORDS = 100;
const MAX_TAGS = 8;
const MAX_TAG_LENGTH = 60;
const CONTEXT_INSTRUCTIONS = [
  "SELECTED PLAYER CONTEXT. Treat this retrieved data as the sole source of player-specific facts.",
  "Do not infer missing values, scores, dates, assessments, sessions, or match statistics. " +
    "Only say the app has no records when a section status is no_records. " +
    "For status incomplete, say no records were found in the records checked and the category was not fully checked. " +
    "For status partial, describe the records provided but state that coverage is incomplete; " +
    "do not present them as the full history.",
].join("\n");

const ASSESSMENT_FIELD_LABELS = Object.freeze({
  b_h: "Handle Position",
  b_hh: "Hands on Handle",
  b_knee: "Knee Position",
  b_tv: "Top Hand V",
  b_bv: "Bottom Hand V",
  b_g: "Guard Position",
  b_w: "Stance Width",
  b_align: "Stance Alignment / Alignment",
  b_wt: "Weight Dist.",
  b_bp: "Backlift Path",
  b_tt: "Trigger Timing",
  b_mp: "Movement Pattern",
  b_hm: "Head Movement",
  b_im: "Initial Movement Pattern",
  b_ff: "Front Foot Movement",
  b_bf: "Back Foot Movement",
  b_bal: "Balance",
  sf_swing: "Negotiating Swing",
  sf_line: "Judging Line & Length",
  sf_front: "Front Foot",
  sf_back: "Back Foot",
  sfs_spin: "Negotiating Spin",
  sfs_line: "Judging Line & Length",
  sfs_front: "Front Foot",
  sfs_back: "Back Foot",
  bo_ru: "Run Up",
  bo_ru_len: "Run-up Length",
  bo_ru_rhy: "Run-up Rhythm",
  bo_lo: "Loading",
  bo_action: "Action Type",
  bo_bfc: "Back Foot Contact",
  bo_ffc: "Front Foot Contact",
  bo_hip: "Hip Position",
  bo_shoulder: "Shoulder Position",
  bo_re: "Release Position",
  bo_head: "Head Position",
  bo_ft: "Follow-through",
  wk_st: "Stance",
  wk_cr: "Crouch Position",
  wk_fp: "Foot Position",
  wk_bal: "Balance",
  wk_gpos: "Glove Position",
  wk_gw: "Glove Work",
  wk_head: "Head Position",
  wk_lat: "Lateral Movement",
  wk_up: "Up to Stumps",
  wk_back: "Back to Bowler",
  wk_take: "Take (1–10)",
  wk_stump: "Stumping (1–10)",
  fi_nt: "Non-Throw Hand",
  fi_el: "Elbow Level",
  fi_al: "Alignment",
  fi_app: "Approach",
  fi_body: "Body Position",
  fi_pick: "Pickup",
  fi_arm: "Arm Path",
  fi_rel: "Release",
  fi_acc: "Throw Accuracy",
  fi_high_pos: "High Catch Positioning",
  fi_high_rec: "High Catch Receiving",
  fi_flat_pos: "Flat Catch Positioning",
  fi_flat_rec: "Flat Catch Receiving",
});

const ASSESSMENT_FIELD_LABEL_NOTES = Object.freeze({
  b_align: "The form reuses this stored ID in Batting: Grip & Stance (Stance Alignment) and Batting: Backlift & Trigger (Alignment); the stored assessment does not identify which section supplied the value.",
});

function hasValue(value) {
  return value !== undefined && value !== null && value !== ""
    && !(typeof value === "string" && value.trim() === "");
}

function boundedValue(value, maxLength = 200) {
  if (typeof value === "string") return value.substring(0, maxLength);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_TAGS)
      .filter(item => typeof item === "string")
      .map(item => item.substring(0, MAX_TAG_LENGTH));
  }
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value.toDate === "function") return value.toDate().toISOString();
  if (value && typeof value === "object") return JSON.stringify(value).substring(0, maxLength);
  return value;
}

function boundedId(id) {
  return String(id).substring(0, 120);
}

function copyPresentFields(source, fields, stringLimits = {}) {
  const result = {};
  for (const field of fields) {
    if (!hasValue(source[field])) continue;
    result[field] = boundedValue(source[field], stringLimits[field] || 200);
  }
  return result;
}

function serializePlayerProfile(data, documentId) {
  return {
    source: `players/${boundedId(documentId)}`,
    ...copyPresentFields(data, [
      "name", "playerId", "age", "role", "secondaryRole", "hand",
      "bowlingArm", "bowlingType", "battingPosition", "level", "notes",
    ], { name: 120, playerId: 80, role: 80, secondaryRole: 80, notes: 180 }),
  };
}

function serializeAssessment(id, data, playerId) {
  const assessmentValues = [];
  for (const [field, value] of Object.entries(data)) {
    const label = ASSESSMENT_FIELD_LABELS[field];
    if (!label) continue;

    const score = data[`${field}_score`];
    if (!hasValue(value) && !hasValue(score)) continue;
    assessmentValues.push({
      field,
      label,
      ...(ASSESSMENT_FIELD_LABEL_NOTES[field]
        ? { labelNote: ASSESSMENT_FIELD_LABEL_NOTES[field] }
        : {}),
      ...(hasValue(value) ? { value: boundedValue(value, 100) } : {}),
      ...(hasValue(score) ? { score: boundedValue(score, 12) } : {}),
    });
  }

  return {
    source: `players/${boundedId(playerId)}/sessions/${boundedId(id)}`,
    ...copyPresentFields(data, [
      "date", "role", "sessionType", "duration", "surface", "conditions",
      "objective", "baseline", "intervention", "response", "outcome",
      "nextAction", "tags", "summary",
    ], {
      date: 40,
      role: 80,
      sessionType: 80,
      surface: 80,
      conditions: 100,
      objective: 180,
      baseline: 180,
      intervention: 180,
      response: 180,
      outcome: 180,
      nextAction: 180,
      summary: 180,
    }),
    assessmentValues,
  };
}

function serializeDayNote(id, data, playerId) {
  return {
    source: `players/${boundedId(playerId)}/dayNotes/${boundedId(id)}`,
    ...copyPresentFields(data, ["date", "note", "tags", "coachingSessionId"], {
      date: 40,
      note: 180,
      coachingSessionId: 120,
    }),
  };
}

function isCoachingSessionLinked(data, playerId) {
  return data.playerId === playerId
    || (Array.isArray(data.playerDayNotes)
      && data.playerDayNotes.some(note => note && note.playerId === playerId));
}

function serializeCoachingSession(id, data, playerId) {
  const playerNoteEntries = Array.isArray(data.playerDayNotes)
    ? data.playerDayNotes.filter(note => note && note.playerId === playerId)
    : [];
  return {
    source: `coachingSessions/${boundedId(id)}`,
    ...copyPresentFields(data, [
      "date", "type", "category", "duration", "surface", "conditions",
      "objective", "objectiveResult", "objectiveReason", "wentWell",
      "improve", "nextAction",
    ], {
      date: 40,
      type: 80,
      category: 80,
      surface: 80,
      conditions: 100,
      objective: 180,
      objectiveReason: 180,
      objectiveResult: 60,
      wentWell: 180,
      improve: 180,
      nextAction: 180,
    }),
    ...(data.playerId === playerId && hasValue(data.dayNote)
      ? { dayNote: boundedValue(data.dayNote, 180) }
      : {}),
    playerDayNotes: playerNoteEntries.slice(0, MAX_TAGS).map(note => ({
      ...copyPresentFields(note, ["note", "tags"], { note: 180 }),
    })),
  };
}

function serializeMatch(id, data) {
  return {
    source: `matches/${boundedId(id)}`,
    ...copyPresentFields(data, [
      "date", "name", "result", "runs", "balls", "fours", "sixes",
      "overs", "runsConceded", "wickets", "dotBalls", "wides", "noBalls",
      "catches", "missedCatches", "runOuts", "directHits", "misfields",
      "battingAt", "dismissalMode", "bowlerType", "shotOffered", "length",
      "line", "coachPlayerNotes",
    ], {
      date: 40,
      name: 120,
      result: 120,
      battingAt: 40,
      dismissalMode: 80,
      bowlerType: 80,
      shotOffered: 100,
      length: 80,
      line: 80,
      coachPlayerNotes: 180,
    }),
  };
}

function serializeEducationMaterial(data) {
  return {
    ...copyPresentFields(data, ["title", "category", "level", "author"], {
      title: 120,
      category: 80,
      level: 80,
      author: 100,
    }),
    ...(Array.isArray(data.tags)
      ? { tags: boundedValue(data.tags) }
      : {}),
  };
}

function selectLinkedCoachingSessions(directDocs, scannedDocs, playerId, {
  maxRecords = MAX_CONTEXT_RECORDS,
  scanLimitReached = false,
  directLimitReached = false,
  directScannedDocs = [],
} = {}) {
  const unique = new Map();
  for (const doc of [...directDocs, ...directScannedDocs, ...scannedDocs]) {
    if (isCoachingSessionLinked(doc.data, playerId)) unique.set(doc.id, doc);
  }

  const linked = [...unique.values()].sort(compareDateDescending);
  return {
    records: linked.slice(0, maxRecords)
      .map(doc => serializeCoachingSession(doc.id, doc.data, playerId)),
    totalFound: linked.length,
    hasMoreLinked: linked.length > maxRecords,
    scanLimitReached,
    directLimitReached,
  };
}

function dateSortValue(date) {
  if (date instanceof Date) return date.toISOString();
  if (date && typeof date.toDate === "function") return date.toDate().toISOString();
  return typeof date === "string" ? date : "";
}

function compareDateDescending(a, b) {
  return dateSortValue(b.data.date).localeCompare(dateSortValue(a.data.date))
    || a.id.localeCompare(b.id);
}

function selectDatedRecords(orderedDocs, scannedDocs, maxRecords, serializeRecord, {
  scanLimitReached = false,
} = {}) {
  const unique = new Map();
  for (const doc of [...orderedDocs, ...scannedDocs]) unique.set(doc.id, doc);
  const allRecords = [...unique.values()].sort(compareDateDescending);
  return {
    records: allRecords.slice(0, maxRecords).map(serializeRecord),
    hasMore: allRecords.length > maxRecords,
    scanLimitReached,
  };
}

function recordsSection(records, source, missingMessage, complete) {
  const copiedRecords = [...records];
  if (!copiedRecords.length) {
    return complete
      ? { status: "no_records", coverage: "complete", source, message: missingMessage, records: [] }
      : {
        status: "incomplete",
        coverage: "partial",
        source,
        message: "No records were found in the records checked. The category was not fully checked, so do not conclude that no records exist.",
        records: [],
      };
  }
  return {
    status: complete ? "available" : "partial",
    coverage: complete ? "complete" : "partial",
    source,
    ...(!complete
      ? { message: "Some records may not be included; do not treat this category as complete." }
      : {}),
    records: copiedRecords,
  };
}

function buildPlayerContext(
  profile,
  assessments,
  notes,
  coaching,
  matches,
  education,
  warnings = [],
  coverage = {},
) {
  const context = {
    selectedPlayer: profile,
    technicalAssessments: recordsSection(
      assessments,
      `${profile.source}/sessions`,
      "No technical assessment records were found for this player.",
      coverage.technicalAssessmentsComplete !== false,
    ),
    playerDayNotes: recordsSection(
      notes,
      `${profile.source}/dayNotes`,
      "No day notes were found for this player.",
      coverage.playerDayNotesComplete !== false,
    ),
    coachingSessions: recordsSection(
      coaching,
      "coachingSessions, linked by playerId or playerDayNotes[].playerId",
      "No linked coaching sessions were found for this player.",
      coverage.coachingSessionsComplete !== false,
    ),
    matchRecords: recordsSection(
      matches,
      "matches, filtered by caller coachId and selected playerId",
      "No match records were found for this player.",
      coverage.matchRecordsComplete !== false,
    ),
    availableCoachEducation: education.slice(0, 3).map(serializeEducationMaterial),
    contextWarnings: warnings.slice(0, 10).map(warning => boundedValue(warning, 200)),
  };

  const recordSections = [
    ["technicalAssessments", "technical assessments"],
    ["playerDayNotes", "day notes"],
    ["coachingSessions", "coaching sessions"],
    ["matchRecords", "match records"],
  ];
  const truncatedCategories = new Set();
  let truncationWarningIndex = -1;
  const serialize = () => JSON.stringify(context);
  const contextSize = json => Buffer.byteLength(`${CONTEXT_INSTRUCTIONS}\n${json}`, "utf8");
  let serialized = serialize();

  while (contextSize(serialized) > MAX_CONTEXT_BYTES) {
    const candidates = recordSections
      .filter(([key]) => context[key].records.length > 1)
      .map(([key, label]) => ({
        key,
        label,
        oldestDate: String(context[key].records[context[key].records.length - 1].date || ""),
      }))
      .sort((a, b) => a.oldestDate.localeCompare(b.oldestDate)
        || recordSections.findIndex(([key]) => key === a.key)
          - recordSections.findIndex(([key]) => key === b.key));
    if (candidates.length === 0) {
      throw new Error("Selected-player context cannot fit the configured byte budget.");
    }

    context[candidates[0].key].records.splice(-1, 1);
    truncatedCategories.add(candidates[0].label);
    const warning =
      `Serialized context reached the ${MAX_CONTEXT_BYTES}-byte limit; older records were omitted from ${[...truncatedCategories].join(", ")}.`;
    if (truncationWarningIndex < 0) {
      truncationWarningIndex = context.contextWarnings.length;
      context.contextWarnings.push(warning);
    } else {
      context.contextWarnings[truncationWarningIndex] = warning;
    }
    serialized = serialize();
  }
  if (contextSize(serialized) > MAX_CONTEXT_BYTES) {
    throw new Error("Context warning exceeds the configured serialized-context byte budget.");
  }

  return {
    text: `${CONTEXT_INSTRUCTIONS}\n${serialized}`,
    warnings: context.contextWarnings,
  };
}

function formatPartialContextWarning(answer, warnings) {
  if (!warnings || warnings.length === 0) return answer;
  return `PARTIAL CONTEXT WARNING: ${warnings.join(" ")}\n\n${answer}`;
}

module.exports = {
  ASSESSMENT_FIELD_LABELS,
  MAX_CONTEXT_BYTES,
  MAX_CONTEXT_RECORDS,
  MAX_UNORDERED_SCAN_RECORDS,
  buildPlayerContext,
  formatPartialContextWarning,
  isCoachingSessionLinked,
  selectLinkedCoachingSessions,
  selectDatedRecords,
  serializeAssessment,
  serializeCoachingSession,
  serializeDayNote,
  serializeEducationMaterial,
  serializeMatch,
  serializePlayerProfile,
};
