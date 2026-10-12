const assert = require("node:assert/strict");
const { after, afterEach, before, test } = require("node:test");
const { EventEmitter } = require("node:events");
const https = require("node:https");
const { Readable } = require("node:stream");

const projectId = "demo-coachslens";
const fixturePrefix = `coachlens-ai-emulator-${process.pid}-${Date.now()}`;
const fixtureRefs = [];
let admin;
let db;
let coachLensAI;
let wrappedCoachLensAI;

process.env.CEREBRAS_API_KEY = "emulator-test-placeholder-not-a-real-key";

before(() => {
  assert.ok(
    process.env.FIRESTORE_EMULATOR_HOST,
    "Refusing to run without FIRESTORE_EMULATOR_HOST.",
  );
  assert.equal(
    process.env.GCLOUD_PROJECT,
    projectId,
    "Refusing to run outside the demo Firestore Emulator project.",
  );

  admin = require("firebase-admin");
  if (!admin.apps.length) admin.initializeApp({ projectId });
  db = admin.firestore();
  ({ coachLensAI } = require("../index"));
  wrappedCoachLensAI = require("firebase-functions-test")().wrap(coachLensAI);
});

afterEach(async () => {
  const refs = fixtureRefs.splice(0);
  await Promise.all(refs.map(ref => ref.delete()));
});

after(async () => {
  await admin.app().delete();
});

function track(ref) {
  fixtureRefs.push(ref);
  return ref;
}

async function seed(ref, data) {
  await track(ref).set(data);
}

async function seedApprovedCoach(uid) {
  await seed(db.collection("users").doc(uid), {
    name: uid,
    email: `${uid}@example.test`,
    role: "viewer",
    status: "approved",
    active: true,
  });
}

async function seedPlayer(coachId, id, name) {
  const ref = db.collection("players").doc(id);
  await seed(ref, {
    name,
    playerId: `${fixturePrefix}-${id}`,
    role: "Batter",
    coachId,
  });
  return ref;
}

async function invokeWithStubbedCerebras(uid, playerId, requestBodies) {
  const originalRequest = https.request;
  https.request = (options, callback) => {
    assert.equal(options.hostname, "api.cerebras.ai");
    assert.equal(options.path, "/v1/chat/completions");

    let body = "";
    const request = new EventEmitter();
    request.write = chunk => {
      body += chunk;
      return true;
    };
    request.end = () => {
      requestBodies.push(JSON.parse(body));
      const response = Readable.from([
        JSON.stringify({
          choices: [{ message: { content: "Controlled emulator response." } }],
        }),
      ]);
      response.statusCode = 200;
      callback(response);
    };
    return request;
  };

  try {
    return await wrappedCoachLensAI({
      data: { prompt: "Summarize the available records.", playerId },
      auth: {
        uid,
        token: {
          email: `${uid}@example.test`,
          email_verified: true,
        },
      },
    });
  } finally {
    https.request = originalRequest;
  }
}

function playerContextFrom(requestBody) {
  const contextMessage = requestBody.messages.find(message =>
    message.role === "system" && message.content.startsWith("SELECTED PLAYER CONTEXT."),
  );
  assert.ok(contextMessage, "Expected selected-player context in the Cerebras payload.");
  const jsonStart = contextMessage.content.lastIndexOf("\n{");
  assert.notEqual(jsonStart, -1, "Expected serialized context JSON after its instructions.");
  return JSON.parse(contextMessage.content.substring(jsonStart + 1));
}

test("callable builds real player context and deduplicates overlapping dated and undated scans", async () => {
  const coachId = `${fixturePrefix}-coach-context`;
  const playerId = `${fixturePrefix}-player-context`;
  await seedApprovedCoach(coachId);
  const playerRef = await seedPlayer(coachId, playerId, "Fixture Batter");

  await seed(playerRef.collection("sessions").doc("assessment-dated"), {
    date: "2026-09-01",
    role: "Batter",
    b_h: "Ideal (Middle-MH)",
    b_h_score: 4,
  });
  await seed(playerRef.collection("sessions").doc("assessment-undated"), {
    role: "Batter",
    b_align: "Open",
    b_align_score: 0,
  });
  await seed(playerRef.collection("dayNotes").doc("note-dated"), {
    date: "2026-09-02",
    note: "Dated note",
  });
  await seed(playerRef.collection("dayNotes").doc("note-undated"), {
    note: "Undated note",
  });
  await seed(db.collection("coachingSessions").doc("individual-overlap"), {
    coachId,
    playerId,
    date: "2026-09-03",
    type: "Individual",
    objective: "Front-foot movement",
  });
  await seed(db.collection("matches").doc("match-dated"), {
    coachId,
    playerId,
    date: "2026-09-04",
    runs: 27,
  });
  await seed(db.collection("matches").doc("match-undated"), {
    coachId,
    playerId,
    runs: 0,
  });

  const requestBodies = [];
  const result = await invokeWithStubbedCerebras(coachId, playerId, requestBodies);
  const context = playerContextFrom(requestBodies[0]);

  assert.equal(result.answer, "Controlled emulator response.");
  assert.equal(context.technicalAssessments.status, "available");
  assert.deepEqual(
    context.technicalAssessments.records.map(record => record.source),
    [
      `players/${playerId}/sessions/assessment-dated`,
      `players/${playerId}/sessions/assessment-undated`,
    ],
  );
  assert.deepEqual(context.technicalAssessments.records[0].assessmentValues, [
    { field: "b_h", label: "Handle Position", value: "Ideal (Middle-MH)", score: 4 },
  ]);
  assert.deepEqual(context.technicalAssessments.records[1].assessmentValues, [
    {
      field: "b_align",
      label: "Stance Alignment / Alignment",
      labelNote: "The form reuses this stored ID in Batting: Grip & Stance (Stance Alignment) and Batting: Backlift & Trigger (Alignment); the stored assessment does not identify which section supplied the value.",
      value: "Open",
      score: 0,
    },
  ]);
  assert.equal(context.playerDayNotes.records.length, 2);
  assert.equal(context.coachingSessions.records.length, 1);
  assert.equal(context.coachingSessions.records[0].source, "coachingSessions/individual-overlap");
  assert.equal(context.matchRecords.records.length, 2);
  assert.deepEqual(result.contextWarnings, []);
});

test("callable marks an empty category incomplete when linked team records fall beyond bounded scans", async () => {
  const coachId = `${fixturePrefix}-coach-limits`;
  const playerId = `${fixturePrefix}-player-limits`;
  await seedApprovedCoach(coachId);
  await seedPlayer(coachId, playerId, "Empty Fixture Batter");

  const teamSessions = db.collection("coachingSessions");
  const batch = db.batch();
  for (let index = 0; index < 101; index += 1) {
    const id = `a-team-session-${String(index).padStart(3, "0")}`;
    batch.set(track(teamSessions.doc(id)), {
      coachId,
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      type: "Team",
      playerDayNotes: [],
    });
  }
  batch.set(track(teamSessions.doc("z-undated-team-link-outside-scan")), {
    coachId,
    type: "Team",
    playerDayNotes: [{ playerId, note: "Older linked note outside bounded scan" }],
  });
  await batch.commit();

  const requestBodies = [];
  const result = await invokeWithStubbedCerebras(coachId, playerId, requestBodies);
  const context = playerContextFrom(requestBodies[0]);

  assert.equal(context.technicalAssessments.status, "no_records");
  assert.equal(context.playerDayNotes.status, "no_records");
  assert.equal(context.matchRecords.status, "no_records");
  assert.equal(context.coachingSessions.status, "incomplete");
  assert.equal(context.coachingSessions.records.length, 0);
  assert.match(context.coachingSessions.message, /records checked/);
  assert.match(context.coachingSessions.message, /do not conclude that no records exist/);
  assert.ok(result.contextWarnings.some(warning =>
    /100-record team-session scan limit was reached/.test(warning),
  ));
  assert.match(result.answer, /^PARTIAL CONTEXT WARNING:/);
  assert.match(
    result.answer,
    /No linked sessions were found in the records checked does not mean that no linked sessions exist/,
  );
});

test("callable denies another coach's player before attempting the Cerebras request", async () => {
  const ownerId = `${fixturePrefix}-owner`;
  const callerId = `${fixturePrefix}-caller`;
  const playerId = `${fixturePrefix}-private-player`;
  await seedApprovedCoach(callerId);
  await seedPlayer(ownerId, playerId, "Private Fixture Player");

  let providerRequestCount = 0;
  const originalRequest = https.request;
  https.request = () => {
    providerRequestCount += 1;
    throw new Error("Provider request must not be attempted for an unauthorized player.");
  };

  try {
    await assert.rejects(
      wrappedCoachLensAI({
        data: { prompt: "Summarize this player.", playerId },
        auth: {
          uid: callerId,
          token: {
            email: `${callerId}@example.test`,
            email_verified: true,
          },
        },
      }),
      error => error.code === "permission-denied",
    );
  } finally {
    https.request = originalRequest;
  }
  assert.equal(providerRequestCount, 0);
});
