const { after, afterEach, before, test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} = require("@firebase/rules-unit-testing");
const {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} = require("firebase/firestore");
const {
  deleteObject,
  getBytes,
  ref,
  uploadBytes,
} = require("firebase/storage");

const projectId = "demo-coachslens";
const primaryAdminEmail = "vyshakbnambiar@gmail.com";
const rulesRoot = path.resolve(__dirname, "../..");
let testEnv;

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId,
    firestore: {
      rules: readFileSync(path.join(rulesRoot, "firestore.rules"), "utf8"),
    },
    storage: {
      rules: readFileSync(path.join(rulesRoot, "storage.rules"), "utf8"),
    },
  });
});

after(async () => {
  await testEnv.cleanup();
});

afterEach(async () => {
  await testEnv.clearFirestore();
  await testEnv.clearStorage();
});

function coachContext(uid, email = `${uid}@example.test`) {
  return testEnv.authenticatedContext(uid, {
    email,
    email_verified: true,
  });
}

function primaryAdminContext(uid = "primary-admin") {
  return testEnv.authenticatedContext(uid, {
    email: primaryAdminEmail,
    email_verified: true,
  });
}

async function seedUser(uid, overrides = {}) {
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "users", uid), {
      name: uid,
      email: `${uid}@example.test`,
      role: "viewer",
      status: "approved",
      active: true,
      emailVerified: true,
      createdAt: new Date(),
      ...overrides,
    });
  });
}

test("signup creates only a pending viewer profile", async () => {
  const db = testEnv.authenticatedContext("new-coach", {
    email: "new-coach@example.test",
    email_verified: false,
  }).firestore();

  await assertSucceeds(setDoc(doc(db, "users", "new-coach"), {
    name: "New Coach",
    email: "new-coach@example.test",
    role: "viewer",
    status: "pending",
    active: false,
    emailVerified: false,
    createdAt: serverTimestamp(),
  }));
});

test("users cannot self-promote or change approval metadata", async () => {
  await seedUser("self", {
    role: "viewer",
    status: "pending",
    active: false,
    emailVerified: false,
  });
  const db = coachContext("self").firestore();
  const userRef = doc(db, "users", "self");

  await assertFails(updateDoc(userRef, { role: "admin" }));
  await assertFails(updateDoc(userRef, { status: "approved" }));
  await assertFails(updateDoc(userRef, { active: true }));
  await assertFails(updateDoc(userRef, {
    approvedAt: serverTimestamp(),
    approvedBy: "self",
  }));

  const createDb = testEnv.authenticatedContext("self-create", {
    email: "self-create@example.test",
    email_verified: false,
  }).firestore();
  await assertFails(setDoc(doc(createDb, "users", "self-create"), {
    name: "Self Admin",
    email: "self-create@example.test",
    role: "admin",
    status: "approved",
    active: true,
    emailVerified: true,
    createdAt: serverTimestamp(),
    approvedBy: "self-create",
    approvedAt: serverTimestamp(),
  }));
});

test("verified users can mirror verification and the primary admin can approve", async () => {
  await seedUser("pending-coach", {
    email: "pending-coach@example.test",
    status: "pending",
    active: false,
    emailVerified: false,
  });
  await seedUser("primary-admin", {
    email: primaryAdminEmail,
    role: "admin",
    status: "approved",
    active: true,
  });

  const userRef = doc(coachContext("pending-coach").firestore(), "users", "pending-coach");
  await assertSucceeds(updateDoc(userRef, {
    emailVerified: true,
    emailVerifiedAt: serverTimestamp(),
  }));

  const adminRef = doc(primaryAdminContext().firestore(), "users", "pending-coach");
  await assertSucceeds(updateDoc(adminRef, {
    role: "contributor",
    status: "approved",
    active: true,
    approvedAt: serverTimestamp(),
    approvedBy: "primary-admin",
  }));

  await seedUser("rejected-coach", {
    status: "pending",
    active: false,
    emailVerified: false,
  });
  await assertSucceeds(updateDoc(
    doc(primaryAdminContext().firestore(), "users", "rejected-coach"),
    {
      status: "rejected",
      active: false,
      rejectedAt: serverTimestamp(),
      rejectedBy: "primary-admin",
    },
  ));
});

test("a user-edited admin profile does not grant admin access", async () => {
  await seedUser("attacker", {
    role: "admin",
    status: "approved",
    active: true,
  });
  const db = coachContext("attacker").firestore();

  await assertFails(getDocs(collection(db, "users")));
  await assertFails(updateDoc(doc(db, "users", "attacker"), {
    status: "rejected",
    active: false,
    revokedAt: serverTimestamp(),
    revokedBy: "attacker",
  }));
});

test("player, session, note, and match data stay with the owning coach", async () => {
  await seedUser("coach-a");
  await seedUser("coach-b");
  await seedUser("primary-admin", {
    email: primaryAdminEmail,
    role: "admin",
    status: "approved",
    active: true,
  });
  const ownerDb = coachContext("coach-a").firestore();
  const otherDb = coachContext("coach-b").firestore();
  const adminDb = primaryAdminContext().firestore();
  const playerRef = doc(ownerDb, "players", "player-a");

  await assertSucceeds(setDoc(playerRef, {
    name: "Player A",
    coachId: "coach-a",
  }));
  await assertSucceeds(getDoc(playerRef));
  await assertFails(getDoc(doc(otherDb, "players", "player-a")));
  await assertFails(getDoc(doc(adminDb, "players", "player-a")));
  await assertSucceeds(setDoc(doc(playerRef, "sessions", "session-a"), {
    date: "2026-10-11",
    coachId: "coach-a",
  }));
  await assertSucceeds(setDoc(doc(playerRef, "dayNotes", "note-a"), {
    date: "2026-10-11",
    coachId: "coach-a",
  }));
  const technicalNoteRef = doc(playerRef, "technicalNotes", "technical-note-a");
  await assertSucceeds(setDoc(technicalNoteRef, {
    date: "2026-10-12",
    observations: "Recorded observation",
    suggestions: "Suggested drill",
    coachId: "coach-a",
    coachName: "Coach A",
    coachEmail: "coach-a@example.test",
    createdAt: serverTimestamp(),
  }));
  const savedTechnicalNote = await getDoc(technicalNoteRef);
  assert.equal(savedTechnicalNote.data().observations, "Recorded observation");
  assert.equal(savedTechnicalNote.data().suggestions, "Suggested drill");
  assert.equal(savedTechnicalNote.data().coachId, "coach-a");
  assert.ok(savedTechnicalNote.data().createdAt);
  assert.equal(
    (await getDocs(collection(ownerDb, "players", "player-a", "technicalNotes"))).size,
    1,
  );
  await assertFails(getDoc(doc(otherDb, "players", "player-a", "technicalNotes", "technical-note-a")));
  await assertFails(setDoc(doc(otherDb, "players", "player-a", "technicalNotes", "foreign-note"), {
    date: "2026-10-12",
    observations: "Unauthorized",
    suggestions: "Unauthorized",
    coachId: "coach-b",
  }));
  await assertFails(getDoc(doc(
    testEnv.unauthenticatedContext().firestore(),
    "players",
    "player-a",
    "technicalNotes",
    "technical-note-a",
  )));
  await assertFails(getDoc(doc(otherDb, "players", "player-a", "sessions", "session-a")));
  await assertFails(setDoc(doc(otherDb, "matches", "match-a"), {
    coachId: "coach-a",
    playerId: "player-a",
  }));
  await assertSucceeds(setDoc(doc(ownerDb, "matches", "match-a"), {
    coachId: "coach-a",
    playerId: "player-a",
  }));
});

test("contributors can upload bounded PDFs only under their own request prefix", async () => {
  await seedUser("contributor", { role: "contributor" });
  await seedUser("viewer", { role: "viewer" });
  await seedUser("primary-admin", {
    email: primaryAdminEmail,
    role: "admin",
    status: "approved",
    active: true,
  });
  const storage = coachContext("contributor").storage();
  const ownPath = "educationRequests/contributor/request-a";

  await assertSucceeds(uploadBytes(
    ref(storage, ownPath),
    new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    { contentType: "application/pdf" },
  ));
  await assertFails(getBytes(ref(storage, ownPath)));
  await assertSucceeds(getBytes(ref(primaryAdminContext().storage(), ownPath)));
  await assertSucceeds(deleteObject(ref(storage, ownPath)));
  await assertFails(uploadBytes(
    ref(storage, "educationRequests/other/request-b"),
    new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    { contentType: "application/pdf" },
  ));
  await assertFails(uploadBytes(
    ref(storage, "educationRequests/contributor/not-pdf"),
    new Uint8Array([1, 2, 3]),
    { contentType: "text/plain" },
  ));
  await assertFails(uploadBytes(
    ref(storage, "educationRequests/contributor/too-large"),
    new Uint8Array(25 * 1024 * 1024 + 1),
    { contentType: "application/pdf" },
  ));
  await assertFails(uploadBytes(
    ref(coachContext("viewer").storage(), "educationRequests/viewer/request-c"),
    new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    { contentType: "application/pdf" },
  ));
});

test("approved education PDFs are readable only by authorized coaches and admins", async () => {
  await seedUser("primary-admin", {
    email: primaryAdminEmail,
    role: "admin",
    status: "approved",
    active: true,
  });
  await seedUser("allowed-coach");
  await seedUser("other-coach");
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "educationMaterials", "material-a"), {
      status: "approved",
      allowedCoachIds: ["allowed-coach"],
    });
  });
  const allowedDb = coachContext("allowed-coach").firestore();
  const otherDb = coachContext("other-coach").firestore();
  await assertSucceeds(getDoc(doc(allowedDb, "educationMaterials", "material-a")));
  await assertFails(getDoc(doc(otherDb, "educationMaterials", "material-a")));
  await assertSucceeds(getDocs(query(
    collection(allowedDb, "educationMaterials"),
    where("status", "==", "approved"),
    where("allowedCoachIds", "array-contains", "allowed-coach"),
  )));
  await assertFails(getDocs(collection(allowedDb, "educationMaterials")));

  const adminStorage = primaryAdminContext().storage();
  const approvedRef = ref(adminStorage, "education/material-a");
  await assertSucceeds(uploadBytes(
    approvedRef,
    new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    { contentType: "application/pdf" },
  ));
  await assertSucceeds(uploadBytes(
    approvedRef,
    new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x32]),
    { contentType: "application/pdf" },
  ));
  await assertSucceeds(getBytes(ref(coachContext("allowed-coach").storage(), "education/material-a")));
  await assertSucceeds(getBytes(approvedRef));
  await assertFails(getBytes(ref(coachContext("other-coach").storage(), "education/material-a")));
  await assertFails(deleteObject(ref(coachContext("allowed-coach").storage(), "education/material-a")));
  await assertSucceeds(deleteObject(approvedRef));
});

test("request metadata cannot be created by a viewer or altered by its owner", async () => {
  await seedUser("contributor", { role: "contributor" });
  await seedUser("viewer");
  await seedUser("primary-admin", {
    email: primaryAdminEmail,
    role: "admin",
    status: "approved",
    active: true,
  });
  const requestData = {
    title: "Practice PDF",
    category: "Batting",
    level: "Foundation",
    description: "",
    author: "",
    source: "",
    tags: [],
    allowedCoachIds: [],
    storagePath: "educationRequests/contributor/request-a",
    status: "pending",
    createdAt: serverTimestamp(),
    createdBy: "contributor",
    createdByEmail: "contributor@example.test",
  };

  const contributorDb = coachContext("contributor").firestore();
  const requestRef = doc(contributorDb, "educationMaterialRequests", "request-a");
  await assertSucceeds(setDoc(requestRef, requestData));
  await assertFails(updateDoc(requestRef, { status: "approved" }));
  await assertSucceeds(updateDoc(
    doc(primaryAdminContext().firestore(), "educationMaterialRequests", "request-a"),
    {
      status: "approved",
      approvedAt: serverTimestamp(),
      approvedBy: "primary-admin",
      approvedStoragePath: "education/request-a",
    },
  ));
  await assertFails(setDoc(
    doc(coachContext("viewer").firestore(), "educationMaterialRequests", "request-b"),
    { ...requestData, createdBy: "viewer", createdByEmail: "viewer@example.test" },
  ));
});

test("unapproved and unauthenticated users cannot read player or education data", async () => {
  await seedUser("pending", {
    status: "pending",
    active: false,
    emailVerified: false,
  });
  await testEnv.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "players", "private-player"), {
      coachId: "pending",
    });
    await setDoc(doc(context.firestore(), "educationMaterials", "private-material"), {
      status: "approved",
      allowedCoachIds: ["pending"],
    });
  });

  const pendingDb = coachContext("pending").firestore();
  await assertFails(getDoc(doc(pendingDb, "players", "private-player")));
  await assertFails(getDoc(doc(pendingDb, "educationMaterials", "private-material")));
  await assertFails(getDoc(doc(testEnv.unauthenticatedContext().firestore(), "players", "private-player")));
});
