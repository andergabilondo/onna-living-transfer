const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "mantainance.js"), "utf8");
const start = source.indexOf("async function eliminarNotificacionesAntiguas(");
const end = source.indexOf("\n// ==========================================", start);
assert.ok(start >= 0 && end > start);
const now = Date.UTC(2026, 9, 7);
const day = 24 * 60 * 60 * 1000;

function notifications(count) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `notification-${index}`,
      { createdAt: now - 61 * day },
    ]),
  );
}

async function cleanup(users, write = async () => {}) {
  const attempts = [];
  const confirmed = [];
  const errors = [];
  const warnings = [];
  const db = {
    ref(refPath) {
      if (refPath === "users") {
        return { once: async () => ({ val: () => users }) };
      }
      assert.equal(refPath, undefined);
      return {
        async update(updates) {
          assert.ok(Object.keys(updates).length <= 100);
          assert.ok(Buffer.byteLength(JSON.stringify(updates), "utf8") <= 1024 * 1024);
          assert.ok(Object.values(updates).every(value => value === null));
          attempts.push(updates);
          await write(updates, attempts.length);
          confirmed.push(...Object.keys(updates));
        },
      };
    },
  };
  const context = vm.createContext({
    Buffer,
    Date: class extends Date {
      static now() { return now; }
    },
    console: {
      log() {},
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
  });
  vm.runInContext(source.slice(start, end), context);
  await context.eliminarNotificacionesAntiguas(db, 60);
  return { attempts, confirmed, errors, warnings };
}

test("deletes old numeric and ISO dates only, keeping the exact cutoff", async () => {
  const old = now - 61 * day;
  const result = await cleanup({
    a: { notifications: {
      old: { createdAt: old },
      iso: { createdAt: new Date(old).toISOString() },
      boundary: { createdAt: now - 60 * day },
      recent: { createdAt: now - day },
      invalid: { createdAt: "not-a-date" },
      missing: {},
    } },
    b: { notifications: { old: { createdAt: old } } },
  });
  assert.deepEqual(result.confirmed, [
    "users/a/notifications/old",
    "users/a/notifications/iso",
    "users/b/notifications/old",
  ]);
  assert.equal(result.errors.length, 0);
});

test("writes bounded batches and flushes the remainder without duplicates", async () => {
  const result = await cleanup({ a: { notifications: notifications(205) } });
  assert.deepEqual(result.attempts.map(batch => Object.keys(batch).length), [100, 100, 5]);
  assert.equal(result.confirmed.length, 205);
  assert.equal(new Set(result.confirmed).size, 205);
  assert.equal(result.errors.length, 0);
});

test("recursively splits WRITE_TOO_BIG batches and confirms each deletion once", async () => {
  const result = await cleanup({ a: { notifications: notifications(7) } }, async updates => {
    if (Object.keys(updates).length > 2) {
      throw Object.assign(new Error("too big"), { code: "WRITE_TOO_BIG" });
    }
  });
  assert.equal(result.confirmed.length, 7);
  assert.equal(new Set(result.confirmed).size, 7);
  assert.ok(result.warnings.length > 0);
  assert.equal(result.errors.length, 0);
});

test("stops on other write errors and reports confirmed partial progress", async () => {
  const failure = Object.assign(new Error("denied"), { code: "PERMISSION_DENIED" });
  const result = await cleanup({ a: { notifications: notifications(205) } }, async (_, attempt) => {
    if (attempt === 2) throw failure;
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.confirmed.length, 100);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0][0], /100 eliminadas antes del error/);
  assert.equal(result.errors[0][1], failure);
});

test("reports an oversized single notification without infinite retries", async () => {
  const failure = Object.assign(new Error("too big"), { code: "WRITE_TOO_BIG" });
  const result = await cleanup({ a: { notifications: notifications(2) } }, async () => {
    throw failure;
  });
  assert.equal(result.attempts.length, 2);
  assert.equal(result.confirmed.length, 0);
  assert.equal(result.errors[0][1], failure);
});

test("does not write when users are absent or no old notifications exist", async () => {
  for (const users of [null, {}, { a: { notifications: {} } }]) {
    const result = await cleanup(users);
    assert.equal(result.attempts.length, 0);
    assert.equal(result.errors.length, 0);
  }
});

async function cleanupUsers(users, deleteUser = async () => {}, remove = async () => {}) {
  const calls = [];
  const errors = [];
  const warnings = [];
  const logs = [];
  const db = {
    ref(refPath) {
      if (refPath === "users") {
        return { once: async () => ({ val: () => users }) };
      }
      return {
        async remove() {
          calls.push(["database", refPath]);
          await remove(refPath);
        },
      };
    },
  };
  const auth = {
    async deleteUser(uid) {
      calls.push(["auth", uid]);
      await deleteUser(uid);
    },
  };
  const functionStart = source.indexOf("async function eliminarUsuariosNoValidados(");
  const functionEnd = source.indexOf("\n/**", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  const context = vm.createContext({
    console: {
      log: (...args) => logs.push(args),
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
  });
  vm.runInContext(source.slice(functionStart, functionEnd), context);
  await context.eliminarUsuariosNoValidados(db, auth);
  return { calls, errors, warnings, logs };
}

test("deletes the node UID from Auth before removing the matching database entry", async () => {
  const result = await cleanupUsers({
    "node-uid": { validated: false, uid: "different-field-uid" },
    validated: { validated: true },
    missing: {},
    string: { validated: "false" },
    empty: null,
  });
  assert.deepEqual(result.calls, [
    ["auth", "node-uid"],
    ["database", "users/node-uid"],
  ]);
  assert.equal(result.errors.length, 0);
});

test("removes an unvalidated database entry if the UID is already absent from Auth", async () => {
  const result = await cleanupUsers({ uid: { validated: false } }, async () => {
    throw Object.assign(new Error("missing"), { code: "auth/user-not-found" });
  });
  assert.deepEqual(result.calls, [["auth", "uid"], ["database", "users/uid"]]);
  assert.equal(result.warnings.length, 1);
  assert.equal(result.errors.length, 0);
});

test("preserves entries on Auth errors, continues with other users and reports incomplete cleanup", async () => {
  const failure = Object.assign(new Error("denied"), { code: "auth/insufficient-permission" });
  const result = await cleanupUsers({
    failed: { validated: false },
    ok: { validated: false },
  }, async uid => {
    if (uid === "failed") throw failure;
  });
  assert.deepEqual(result.calls, [
    ["auth", "failed"],
    ["auth", "ok"],
    ["database", "users/ok"],
  ]);
  assert.equal(result.errors[0][1], failure);
  assert.match(result.errors[1][0], /Usuarios eliminados: 1.*errores de Auth: 1/);
  assert.ok(!result.logs.some(args => args[0].includes("Proceso finalizado")));
});

test("reports database removal failures after the Auth deletion", async () => {
  const failure = new Error("database denied");
  const result = await cleanupUsers({ uid: { validated: false } }, undefined, async () => {
    throw failure;
  });
  assert.deepEqual(result.calls, [["auth", "uid"], ["database", "users/uid"]]);
  assert.equal(result.errors[0][1], failure);
  assert.ok(!result.logs.some(args => args[0].includes("Proceso finalizado")));
});

function transferContext({ sourceAuth = {}, targetAuth = {}, env = {} } = {}) {
  const configStart = source.indexOf("function getImportOptions(");
  const configEnd = source.indexOf("\n// ==========================================", configStart);
  const transferStart = source.indexOf("function mapUserForImport(");
  const transferEnd = source.indexOf("\n// ==========================================", transferStart);
  assert.ok(configStart >= 0 && configEnd > configStart);
  assert.ok(transferStart >= 0 && transferEnd > transferStart);
  const errors = [];
  const logs = [];
  const warnings = [];
  const context = vm.createContext({
    Buffer, sourceAuth, targetAuth,
    process: { env },
    console: {
      log: (...args) => logs.push(args),
      warn: (...args) => warnings.push(args),
      error: (...args) => errors.push(args),
    },
  });
  vm.runInContext(source.slice(configStart, configEnd) + source.slice(transferStart, transferEnd), context);
  return { context, errors, logs, warnings };
}

const testHashEnv = {
  FIREBASE_SOURCE_HASH_KEY: Buffer.from("test-key").toString("base64"),
  FIREBASE_SOURCE_SALT_SEPARATOR: Buffer.from("test-separator").toString("base64"),
  FIREBASE_SOURCE_HASH_ROUNDS: "8",
  FIREBASE_SOURCE_HASH_MEMORY_COST: "14",
};

function passwordUser() {
  return {
    uid: "test-uid", email: "test@example.com", emailVerified: true,
    passwordHash: Buffer.from("test-hash").toString("base64"),
    passwordSalt: Buffer.from("test-salt").toString("base64"),
    providerData: [{ providerId: "password", uid: "test@example.com", email: "test@example.com" }],
    customClaims: { role: "user" },
    disabled: false,
  };
}

test("maps password credentials as Buffers and retains providers and access claims", () => {
  const { context } = transferContext({ env: testHashEnv });
  const user = passwordUser();
  const mapped = context.mapUserForImport(user);
  assert.ok(Buffer.isBuffer(mapped.passwordHash));
  assert.ok(Buffer.isBuffer(mapped.passwordSalt));
  assert.equal(mapped.passwordHash.toString(), "test-hash");
  assert.equal(mapped.passwordSalt.toString(), "test-salt");
  assert.equal(mapped.providerData[0].providerId, "password");
  assert.equal(mapped.customClaims, user.customClaims);
  assert.equal(mapped.disabled, false);
  const options = context.getImportOptions([mapped]);
  assert.equal(options.hash.key.toString(), "test-key");
  assert.equal(options.hash.rounds, 8);
});

test("rejects missing password exports and missing or invalid source hash configuration", () => {
  const { context } = transferContext();
  assert.throws(() => context.mapUserForImport({
    ...passwordUser(), passwordHash: undefined, passwordSalt: undefined,
  }), /firebaseauth.configs.getHashConfig/);
  const mapped = context.mapUserForImport(passwordUser());
  assert.throws(() => context.getImportOptions([mapped]), /FIREBASE_SOURCE_HASH_KEY/);
  for (const invalid of [
    { FIREBASE_SOURCE_HASH_KEY: "............................" },
    { FIREBASE_SOURCE_HASH_ROUNDS: "0" },
    { FIREBASE_SOURCE_HASH_MEMORY_COST: "invalid" },
  ]) {
    const configured = transferContext({ env: { ...testHashEnv, ...invalid } }).context;
    assert.throws(() => configured.getImportOptions([mapped]));
  }
});

test("retains federated providers without requiring password hash configuration", () => {
  const { context } = transferContext();
  const mapped = context.mapUserForImport({
    uid: "federated", providerData: [{ providerId: "google.com", uid: "google-uid" }],
  });
  assert.equal(mapped.providerData[0].uid, "google-uid");
  assert.equal(mapped.passwordHash, undefined);
  assert.equal(context.getImportOptions([mapped]), undefined);
});

function transferFixture({ existing = false, emailUid, importError, verifiedProvider = "password" } = {}) {
  const user = passwordUser();
  const imported = [];
  const pages = [];
  const missing = () => Object.assign(new Error("missing"), { code: "auth/user-not-found" });
  const result = transferContext({
    env: testHashEnv,
    sourceAuth: {
      async listUsers(limit, token) {
        assert.equal(limit, 1000);
        pages.push(token);
        return token ? { users: [user] } : { users: [], pageToken: "next" };
      },
    },
    targetAuth: {
      async getUser(uid) {
        assert.equal(uid, user.uid);
        if (!existing && imported.length === 0) throw missing();
        return { uid, providerData: [{ providerId: verifiedProvider }] };
      },
      async getUserByEmail(email) {
        assert.equal(email, user.email);
        if (!existing && !emailUid) throw missing();
        return { uid: emailUid || user.uid };
      },
      async importUsers(users, options) {
        imported.push({ users, options });
        return importError
          ? { successCount: 0, failureCount: 1, errors: [{ index: 0, error: importError }] }
          : { successCount: 1, failureCount: 0, errors: [] };
      },
    },
  });
  return { ...result, user, imported, pages };
}

test("exports a single user through paginated listUsers, imports credentials and verifies provider", async () => {
  const result = transferFixture();
  await result.context.transferirUsuario(result.user.uid);
  assert.deepEqual(result.pages, [undefined, "next"]);
  assert.equal(result.imported.length, 1);
  assert.ok(Buffer.isBuffer(result.imported[0].users[0].passwordHash));
  assert.equal(result.errors.length, 0);
});

test("requires explicit repair and never overwrites a different UID with the same email", async () => {
  const defaultTransfer = transferFixture({ existing: true });
  await defaultTransfer.context.transferirUsuario(defaultTransfer.user.uid);
  assert.equal(defaultTransfer.imported.length, 0);
  assert.equal(defaultTransfer.warnings.length, 1);

  const repair = transferFixture({ existing: true });
  await repair.context.transferirUsuario(repair.user.uid, { repararExistente: true });
  assert.equal(repair.imported.length, 1);
  assert.equal(repair.errors.length, 0);

  const conflict = transferFixture({ emailUid: "other-uid" });
  await conflict.context.transferirUsuario(conflict.user.uid, { repararExistente: true });
  assert.equal(conflict.imported.length, 0);
  assert.equal(conflict.warnings.length, 1);
});

test("does not announce success for per-user import failures or missing password provider", async () => {
  const failure = new Error("import failed");
  const failed = transferFixture({ importError: failure });
  await failed.context.transferirUsuario(failed.user.uid);
  assert.equal(failed.errors[0][1], failure);
  assert.ok(!failed.logs.some(args => args[0].includes("transferido con éxito")));

  const missingProvider = transferFixture({ verifiedProvider: "google.com" });
  await missingProvider.context.transferirUsuario(missingProvider.user.uid);
  assert.match(missingProvider.errors[0][1].message, /no tiene el proveedor/);
});

test("bulk migration uses the same credential mapping and reports partial failures", async () => {
  let imported = false;
  const failure = new Error("rejected");
  const result = transferContext({
    env: testHashEnv,
    sourceAuth: { listUsers: async () => ({ users: [passwordUser()] }) },
    targetAuth: {
      async importUsers(users, options) {
        imported = true;
        assert.ok(Buffer.isBuffer(users[0].passwordHash));
        assert.equal(users[0].providerData[0].providerId, "password");
        assert.equal(options.hash.algorithm, "SCRYPT");
        return { successCount: 0, failureCount: 1, errors: [{ index: 0, error: failure }] };
      },
    },
  });
  await result.context.transferirTodosLosUsuarios();
  assert.ok(imported);
  assert.match(result.errors.at(-1)[0], /Transferencia incompleta.*Fallidos: 1/);
  assert.ok(!result.logs.some(args => args[0].includes("completada")));
});

test("mapped password import is accepted by the installed Firebase SDK request builder", () => {
  const sdkPath = path.dirname(require.resolve("firebase-admin/app"));
  const { UserImportBuilder } = require(path.join(sdkPath, "..", "auth", "user-import-builder.js"));
  const { context } = transferContext({
    env: { ...testHashEnv, FIREBASE_SOURCE_SALT_SEPARATOR: "" },
  });
  const users = [context.mapUserForImport(passwordUser())];
  const builder = new UserImportBuilder(users, context.getImportOptions(users));
  const request = builder.buildRequest();
  const response = builder.buildResponse([]);
  assert.equal(response.failureCount, 0);
  assert.equal(request.users[0].localId, "test-uid");
  assert.equal(Buffer.from(request.users[0].passwordHash, "base64").toString(), "test-hash");
  assert.equal(request.users[0].providerUserInfo[0].providerId, "password");
  assert.equal(request.hashAlgorithm, "SCRYPT");
  assert.equal(request.saltSeparator, "");
});

function executionContext(run, deleteApp) {
  const executionStart = source.indexOf("async function ejecutar(");
  assert.ok(executionStart >= 0);
  const errors = [];
  const processState = {};
  const context = vm.createContext({
    run, deleteApp,
    sourceApp: { name: "source" },
    targetApp: { name: "target" },
    process: processState,
    console: { error: (...args) => errors.push(args) },
  });
  const executionSource = source.slice(executionStart).replace(/ejecutar\(\);\s*$/, "");
  vm.runInContext(executionSource, context);
  return { context, errors, processState, executionSource };
}

test("closes both Firebase apps only after the operations finish", async () => {
  const calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const result = executionContext(
    async () => { calls.push("run"); await pending; calls.push("finished"); },
    async app => { calls.push(app.name); },
  );
  const execution = result.context.ejecutar();
  assert.deepEqual(calls, ["run"]);
  finish();
  await execution;
  assert.deepEqual(calls, ["run", "finished", "source", "target"]);
  assert.equal(result.errors.length, 0);
  assert.equal(result.processState.exitCode, undefined);
});

test("closes both apps and reports failure when an operation throws", async () => {
  const failure = new Error("operation failed");
  const closed = [];
  const result = executionContext(
    async () => { throw failure; },
    async app => { closed.push(app.name); },
  );
  await result.context.ejecutar();
  assert.deepEqual(closed, ["source", "target"]);
  assert.equal(result.errors[0][1], failure);
  assert.equal(result.processState.exitCode, 1);
});

test("attempts to close both apps even when one cleanup fails", async () => {
  const failure = new Error("cleanup failed");
  const closed = [];
  const result = executionContext(async () => {}, async app => {
    closed.push(app.name);
    if (app.name === "source") throw failure;
  });
  await result.context.ejecutar();
  assert.deepEqual(closed, ["source", "target"]);
  assert.match(result.errors[0][0], /source/);
  assert.equal(result.errors[0][1], failure);
  assert.equal(result.processState.exitCode, 1);
});

test("process terminates naturally after cleanup releases persistent connections", () => {
  const { spawnSync } = require("node:child_process");
  const { executionSource } = executionContext(async () => {}, async () => {});
  const child = spawnSync(process.execPath, ["-e", `
    const sourceApp = { name: "source", connection: setInterval(() => {}, 1000) };
    const targetApp = { name: "target", connection: setInterval(() => {}, 1000) };
    async function run() { await new Promise(resolve => setTimeout(resolve, 10)); }
    async function deleteApp(app) { clearInterval(app.connection); }
    ${executionSource}
    ejecutar();
  `], { encoding: "utf8", timeout: 5000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
});
