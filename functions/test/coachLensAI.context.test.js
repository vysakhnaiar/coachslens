const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  ASSESSMENT_FIELD_LABELS,
  buildPlayerContext,
  formatPartialContextWarning,
  MAX_CONTEXT_BYTES,
  MAX_UNORDERED_SCAN_RECORDS,
  isCoachingSessionLinked,
  selectLinkedCoachingSessions,
  selectDatedRecords,
  serializeAssessment,
  serializeCoachingSession,
  serializeDayNote,
  serializeMatch,
  serializePlayerProfile,
} = require("../coachLensAIContext");

test("player profile serialization excludes private account fields and keeps missing data absent", () => {
  const profile = serializePlayerProfile({
    name: "Alan",
    role: "Batter",
    coachId: "private-coach-id",
    emergencyContact: "private-contact",
  }, "player-doc-id");

  assert.deepEqual(profile, {
    source: "players/player-doc-id",
    name: "Alan",
    role: "Batter",
  });
});

test("assessment serialization includes actual rubric values, matching scores, dates, and source", () => {
  const assessment = serializeAssessment("assessment-1", {
    date: "2026-05-10",
    sessionType: "Technical Assessment",
    objective: "Improve front-foot movement",
    b_h: "Ideal (Middle-MH)",
    b_h_score: 0,
    bo_ru: "Ideal (Straight)",
    bo_ru_score: 3,
    unrelatedPrivateField: "must not be included",
  }, "player-doc-id");

  assert.equal(assessment.source, "players/player-doc-id/sessions/assessment-1");
  assert.equal(assessment.date, "2026-05-10");
  assert.equal(assessment.sessionType, "Technical Assessment");
  assert.deepEqual(assessment.assessmentValues, [
    { field: "b_h", label: "Handle Position", value: "Ideal (Middle-MH)", score: 0 },
    { field: "bo_ru", label: "Run Up", value: "Ideal (Straight)", score: 3 },
  ]);
  assert.equal("unrelatedPrivateField" in assessment, false);
});

test("rubric labels are copied from existing form labels, including the duplicate stored ID", () => {
  assert.equal(ASSESSMENT_FIELD_LABELS.sf_swing, "Negotiating Swing");
  assert.equal(ASSESSMENT_FIELD_LABELS.wk_take, "Take (1–10)");
  assert.equal(ASSESSMENT_FIELD_LABELS.b_align, "Stance Alignment / Alignment");

  const assessment = serializeAssessment("assessment-2", {
    b_h: "Top(TH)",
    b_align: "Open",
    invented_rubric: "not an existing field",
  }, "player-doc-id");
  assert.deepEqual(assessment.assessmentValues, [
    { field: "b_h", label: "Handle Position", value: "Top(TH)" },
    {
      field: "b_align",
      label: "Stance Alignment / Alignment",
      labelNote: "The form reuses this stored ID in Batting: Grip & Stance (Stance Alignment) and Batting: Backlift & Trigger (Alignment); the stored assessment does not identify which section supplied the value.",
      value: "Open",
    },
  ]);
});

test("every stored rubric key is mapped to its existing form label", () => {
  const html = readFileSync(path.resolve(__dirname, "../../index.html"), "utf8");
  const labelsById = new Map();
  for (const match of html.matchAll(/id: '([a-z][a-z0-9_]*)', label: '([^']+)'/g)) {
    const labels = labelsById.get(match[1]) || [];
    if (!labels.includes(match[2])) labels.push(match[2]);
    labelsById.set(match[1], labels);
  }

  assert.ok(labelsById.size > 0);
  assert.deepEqual(
    Object.keys(ASSESSMENT_FIELD_LABELS).sort(),
    [...labelsById.keys()].sort(),
  );
  for (const [field, labels] of labelsById) {
    assert.equal(ASSESSMENT_FIELD_LABELS[field], labels.join(" / "));
  }
});

test("day notes preserve source date and coaching-session relationship", () => {
  const note = serializeDayNote("note-1", {
    date: "2026-05-11",
    note: "Worked on balance",
    tags: ["batting"],
    coachingSessionId: "coaching-1",
    coachId: "private-coach-id",
  }, "player-doc-id");

  assert.deepEqual(note, {
    source: "players/player-doc-id/dayNotes/note-1",
    date: "2026-05-11",
    note: "Worked on balance",
    tags: ["batting"],
    coachingSessionId: "coaching-1",
  });
});

test("coaching sessions include direct and individual-note links only for the selected player", () => {
  const session = {
    playerId: "another-player",
    date: "2026-05-12",
    type: "Team",
    playerDayNotes: [
      { playerId: "player-doc-id", note: "Good intent", tags: "batting" },
      { playerId: "another-player", note: "Other player note" },
    ],
  };

  assert.equal(isCoachingSessionLinked(session, "player-doc-id"), true);
  assert.deepEqual(
    serializeCoachingSession("coaching-1", session, "player-doc-id"),
    {
      source: "coachingSessions/coaching-1",
      date: "2026-05-12",
      type: "Team",
      playerDayNotes: [{ note: "Good intent", tags: "batting" }],
    },
  );
  assert.equal(isCoachingSessionLinked(session, "unrelated-player"), false);
});

test("linked-session selection merges bounded direct and team scans without duplicates", () => {
  const direct = [
    { id: "direct-1", data: { playerId: "player-1", date: "2026-06-03", type: "Individual" } },
  ];
  const scanned = [
    { id: "team-1", data: {
      date: "2026-06-04",
      playerDayNotes: [{ playerId: "player-1", note: "Team-linked note" }],
    } },
    direct[0],
    { id: "unrelated", data: {
      date: "2026-06-05",
      playerDayNotes: [{ playerId: "player-2", note: "Other player" }],
    } },
  ];

  const selected = selectLinkedCoachingSessions(direct, scanned, "player-1", {
    maxRecords: 20,
    scanLimitReached: true,
    directLimitReached: false,
  });

  assert.deepEqual(selected.records.map(record => record.source), [
    "coachingSessions/team-1",
    "coachingSessions/direct-1",
  ]);
  assert.equal(selected.records.length, 2);
  assert.equal(selected.scanLimitReached, true);
  assert.equal(selected.hasMoreLinked, false);
});

test("bounded unordered retrieval retains undated records and reports a saturated scan", () => {
  const dated = { id: "dated", data: { date: "2026-06-04", value: "dated" } };
  const undated = { id: "undated", data: { value: "undated" } };
  const selected = selectDatedRecords(
    [dated],
    [dated, undated],
    20,
    doc => ({ source: doc.id, ...doc.data }),
    { scanLimitReached: true },
  );

  assert.deepEqual(selected.records, [
    { source: "dated", date: "2026-06-04", value: "dated" },
    { source: "undated", value: "undated" },
  ]);
  assert.equal(selected.scanLimitReached, true);
  assert.equal(MAX_UNORDERED_SCAN_RECORDS, 100);
});

test("incomplete empty categories do not claim there are no records", () => {
  const context = buildPlayerContext(
    serializePlayerProfile({ name: "Alan" }, "player-doc-id"),
    [],
    [],
    [],
    [],
    [],
    ["The bounded scan reached its limit."],
    {
      technicalAssessmentsComplete: false,
      playerDayNotesComplete: false,
      coachingSessionsComplete: false,
      matchRecordsComplete: false,
    },
  );
  const parsed = JSON.parse(context.text.substring(context.text.indexOf("\n{") + 1));

  for (const key of [
    "technicalAssessments",
    "playerDayNotes",
    "coachingSessions",
    "matchRecords",
  ]) {
    assert.equal(parsed[key].status, "incomplete");
    assert.equal(parsed[key].coverage, "partial");
    assert.match(parsed[key].message, /do not conclude that no records exist/);
    assert.doesNotMatch(parsed[key].message, /^No .* records were found/);
  }
  assert.match(context.text, /Only say the app has no records when a section status is no_records/);
});

test("empty coaching results remain incomplete when the team-session scan hits its limit", () => {
  const coaching = selectLinkedCoachingSessions(
    [],
    Array.from({ length: MAX_UNORDERED_SCAN_RECORDS }, (_, index) => ({
      id: `unrelated-${index}`,
      data: { playerDayNotes: [{ playerId: "another-player" }] },
    })),
    "player-1",
    { scanLimitReached: true },
  );
  assert.equal(coaching.records.length, 0);
  assert.equal(coaching.scanLimitReached, true);

  const context = buildPlayerContext(
    serializePlayerProfile({ name: "Alan" }, "player-doc-id"),
    [],
    [],
    coaching.records,
    [],
    [],
    ["The team scan reached its limit."],
    { coachingSessionsComplete: false },
  );
  const parsed = JSON.parse(context.text.substring(context.text.indexOf("\n{") + 1));
  assert.equal(parsed.coachingSessions.status, "incomplete");
  assert.match(parsed.coachingSessions.message, /records checked/);
  assert.match(parsed.contextWarnings[0], /team scan reached its limit/i);
});

test("human-readable player fallback is caller-scoped, indexed, and duplicate-bounded", () => {
  const source = readFileSync(path.resolve(__dirname, "../index.js"), "utf8");
  assert.match(
    source,
    /\.where\("coachId",\s*"==",\s*coachId\)\s*\.where\("playerId",\s*"==",\s*playerReference\)\s*\.limit\(2\)/,
  );
  assert.match(source, /if \(ownedPlayers\.size > 1\)/);
  assert.doesNotMatch(source, /const ownedPlayers = db\.collection\("players"\)\s*\.where\("coachId",\s*"==",\s*coachId\)\s*\.get\(\)/);
});

test("match serialization keeps actual zero statistics and detailed cricket fields", () => {
  const match = serializeMatch("match-1", {
    date: "2026-05-13",
    name: "League match",
    runs: 0,
    balls: 4,
    wides: 1,
    noBalls: 0,
    battingAt: "3",
    dismissalMode: "Caught",
    bowlerType: "Off spin",
    shotOffered: "Cover drive",
    length: "Good length",
    line: "Outside off",
    coachId: "private-coach-id",
  });

  assert.deepEqual(match, {
    source: "matches/match-1",
    date: "2026-05-13",
    name: "League match",
    runs: 0,
    balls: 4,
    wides: 1,
    noBalls: 0,
    battingAt: "3",
    dismissalMode: "Caught",
    bowlerType: "Off spin",
    shotOffered: "Cover drive",
    length: "Good length",
    line: "Outside off",
  });
});

test("empty categories are explicitly identified as missing records", () => {
  const context = buildPlayerContext(
    serializePlayerProfile({ name: "Alan" }, "player-doc-id"),
    [],
    [],
    [],
    [],
    [],
  );
  const parsed = JSON.parse(context.text.substring(context.text.indexOf("\n{") + 1));

  assert.equal(parsed.technicalAssessments.status, "no_records");
  assert.match(parsed.technicalAssessments.message, /No technical assessment records/);
  assert.equal(parsed.selectedPlayer.name, "Alan");
  assert.equal(parsed.contextWarnings.length, 0);
});

test("serialized context is byte-bounded, deterministic, and warns when older records are removed", () => {
  const profile = serializePlayerProfile({ name: "Alan" }, "player-doc-id");
  const assessments = Array.from({ length: 20 }, (_, index) => ({
    source: `players/player-doc-id/sessions/a-${index}`,
    date: `2026-${String(20 - index).padStart(2, "0")}-01`,
    assessmentValues: Array.from({ length: 30 }, (_, rubric) => ({
      field: `field-${rubric}`,
      label: "Assessment label",
      value: "A".repeat(100),
      score: 5,
    })),
  }));

  const args = [profile, assessments, [], [], [], [], []];
  const first = buildPlayerContext(...args);
  const second = buildPlayerContext(...args);
  const parsed = JSON.parse(first.text.substring(first.text.indexOf("\n{") + 1));

  assert.deepEqual(first, second);
  assert.ok(Buffer.byteLength(first.text, "utf8") <= MAX_CONTEXT_BYTES);
  assert.ok(parsed.technicalAssessments.records.length < assessments.length);
  assert.equal(parsed.technicalAssessments.records[0].date, "2026-20-01");
  assert.ok(first.warnings.some(warning => /older records were omitted/.test(warning)));
  assert.match(
    formatPartialContextWarning("Answer", first.warnings),
    /^PARTIAL CONTEXT WARNING:/,
  );
});
