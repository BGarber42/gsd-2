import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertValidDebugSessionSlug,
  createDebugSession,
  debugSessionArtifactPath,
  debugSessionsDir,
  listDebugSessions,
  loadDebugSession,
  slugifyDebugSessionIssue,
  updateDebugSession,
} from "../debug-session-store.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-debug-session-store-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

describe("debug-session-store: create/list/load/update", () => {
  test("creates first session under .gsd/debug/sessions with deterministic metadata", () => {
    const base = makeBase();
    try {
      const created = createDebugSession(base, {
        issue: "Login fails on Safari",
        createdAt: 1000,
      });

      assert.equal(created.session.slug, "login-fails-on-safari");
      assert.ok(created.artifactPath.includes(join(".gsd", "debug", "sessions")));
      assert.ok(created.artifactPath.endsWith("login-fails-on-safari.json"));
      assert.ok(created.session.logPath.includes(join(".gsd", "debug")));
      assert.ok(!created.session.logPath.includes(join("debug", "sessions")));
      assert.equal(created.session.status, "active");
      assert.equal(created.session.phase, "queued");
      assert.equal(created.session.createdAt, 1000);
      assert.equal(created.session.updatedAt, 1000);

      assert.ok(existsSync(created.artifactPath), "session artifact should exist");
      const raw = readFileSync(created.artifactPath, "utf-8");
      assert.ok(raw.includes('"slug": "login-fails-on-safari"'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("collision-safe slugging allows multiple same-title sessions", () => {
    const base = makeBase();
    try {
      const a = createDebugSession(base, { issue: "Auth issue" });
      const b = createDebugSession(base, { issue: "Auth issue" });
      const c = createDebugSession(base, { issue: "Auth issue" });

      assert.equal(a.session.slug, "auth-issue");
      assert.equal(b.session.slug, "auth-issue-2");
      assert.equal(c.session.slug, "auth-issue-3");
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue")));
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue-2")));
      assert.ok(existsSync(debugSessionArtifactPath(base, "auth-issue-3")));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("list returns deterministic ordering by updatedAt desc then slug", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "First", createdAt: 100 });
      createDebugSession(base, { issue: "Second", createdAt: 200 });
      createDebugSession(base, { issue: "Third", createdAt: 300 });

      updateDebugSession(base, "first", { phase: "triage", updatedAt: 500 });

      const listed = listDebugSessions(base);
      assert.equal(listed.malformed.length, 0);
      assert.deepEqual(
        listed.sessions.map(s => s.session.slug),
        ["first", "third", "second"],
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("load returns null when slug does not exist", () => {
    const base = makeBase();
    try {
      const loaded = loadDebugSession(base, "missing-slug");
      assert.equal(loaded, null);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("update persists status/phase/error metadata for observability", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Rate limit flake", createdAt: 10 });
      const updated = updateDebugSession(base, "rate-limit-flake", {
        status: "failed",
        phase: "diagnosing",
        lastError: "Timeout waiting for health check",
        updatedAt: 42,
      });

      assert.equal(updated.session.status, "failed");
      assert.equal(updated.session.phase, "diagnosing");
      assert.equal(updated.session.lastError, "Timeout waiting for health check");
      assert.equal(updated.session.updatedAt, 42);

      const listed = listDebugSessions(base);
      assert.equal(listed.sessions[0].session.status, "failed");
      assert.equal(listed.sessions[0].session.phase, "diagnosing");
      assert.equal(listed.sessions[0].session.updatedAt, 42);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("debug-session-store: malformed artifacts + negative paths", () => {
  test("list continues healthy sessions while surfacing malformed artifact paths", () => {
    const base = makeBase();
    try {
      createDebugSession(base, { issue: "Healthy issue", createdAt: 1 });
      const sessionsPath = debugSessionsDir(base);
      writeFileSync(join(sessionsPath, "corrupt.json"), "{ this is not json", "utf-8");

      const listed = listDebugSessions(base);
      assert.equal(listed.sessions.length, 1);
      assert.equal(listed.sessions[0].session.slug, "healthy-issue");
      assert.equal(listed.malformed.length, 1);
      assert.ok(listed.malformed[0].artifactPath.endsWith(join("sessions", "corrupt.json")));
      assert.match(listed.malformed[0].message, /parse debug session artifact/i);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("rejects empty issue text and unsupported tokens that slugify to empty", () => {
    const base = makeBase();
    try {
      assert.throws(
        () => createDebugSession(base, { issue: "   " }),
        /Issue text is required/i,
      );

      assert.throws(
        () => slugifyDebugSessionIssue("🔥🔥🔥"),
        /alphanumeric/i,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("slugify normalizes unsupported characters into deterministic tokens", () => {
    assert.equal(
      slugifyDebugSessionIssue(" API / login 🚨 flaky  "),
      "api-login-flaky",
    );
  });

  test("invalid slug tokens are rejected for load/path validation", () => {
    const base = makeBase();
    try {
      assert.throws(() => assertValidDebugSessionSlug("../escape"), /Invalid debug session slug/);
      assert.throws(() => loadDebugSession(base, "../escape"), /Invalid debug session slug/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("create surfaces write failures and leaves no visible artifact", () => {
    const base = makeBase();
    try {
      assert.throws(
        () => createDebugSession(
          base,
          { issue: "Write failure case" },
          {
            atomicWrite: () => {
              throw new Error("simulated write failure");
            },
          },
        ),
        /simulated write failure/,
      );

      assert.equal(existsSync(debugSessionArtifactPath(base, "write-failure-case")), false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("creates sessions directory on first write boundary condition", () => {
    const base = makeBase();
    try {
      const dir = debugSessionsDir(base);
      assert.equal(existsSync(dir), false);

      createDebugSession(base, { issue: "First session" });
      assert.equal(existsSync(dir), true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
