// End-to-end test against a running stack (deploy/compose.yml + compose.dev.yml):
//   API_URL (default http://127.0.0.1:8787), MAILPIT_URL (default http://127.0.0.1:8025)
// Reads the verification codes from Mailpit, like a user reading their mail.

import assert from "node:assert/strict";
import test from "node:test";
import { noteTimes } from "../../src/core/challenge";

const API = process.env.API_URL ?? "http://127.0.0.1:8787";
const MAILPIT = process.env.MAILPIT_URL ?? "http://127.0.0.1:8025";
const run = Date.now().toString(36);

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  const r = await fetch(API + path, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
}

async function codeFor(email: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const r = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    const j = (await r.json()) as { messages: { Subject: string }[] };
    const m = j.messages?.[0]?.Subject.match(/(\d{6})/);
    if (m) return m[1];
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error(`no mail for ${email}`);
}

async function signUp(name: string) {
  const email = `${name}-${run}@example.test`;
  assert.equal((await call("POST", "/auth/code", { email, purpose: "register" })).status, 200);
  const code = await codeFor(email);
  const r = await call("POST", "/auth/register", { email, code, password: "correct horse 1", nickname: `${name}${run}` });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return { email, ...r.data } as { email: string; accessToken: string; refreshToken: string; user: { id: string; nickname: string } };
}

test("accounts, sync, daily challenge, leaderboards, friends, PK", async () => {
  // --- accounts
  const a = await signUp("alice");
  const b = await signUp("bob");
  assert.equal((await call("POST", "/auth/code", { email: a.email, purpose: "register" })).data.error, "email_taken");
  assert.equal((await call("POST", "/auth/login", { email: a.email, password: "wrong password" })).status, 401);
  const login = await call("POST", "/auth/login", { email: a.email.toUpperCase(), password: "correct horse 1" });
  assert.equal(login.status, 200);
  assert.equal((await call("GET", "/me", undefined, a.accessToken)).data.nickname, `alice${run}`);
  assert.equal((await call("GET", "/me")).status, 401);
  const refreshed = await call("POST", "/auth/refresh", { refreshToken: login.data.refreshToken });
  assert.equal(refreshed.status, 200);
  await call("POST", "/auth/logout", { refreshToken: login.data.refreshToken });
  assert.equal((await call("POST", "/auth/refresh", { refreshToken: login.data.refreshToken })).status, 401);
  // wrong codes burn after a few tries
  assert.equal((await call("POST", "/auth/register", { email: `x-${run}@example.test`, code: "000000", password: "12345678", nickname: "x" })).data.error, "bad_code");

  // password reset signs out other sessions
  await new Promise((r) => setTimeout(r, 61_000 - 0)); // per-address resend limit is 60 s
  assert.equal((await call("POST", "/auth/code", { email: b.email, purpose: "reset" })).status, 200);
  const reset = await call("POST", "/auth/reset", { email: b.email, code: await codeFor(b.email), password: "new password 2" });
  assert.equal(reset.status, 200);
  assert.equal((await call("POST", "/auth/refresh", { refreshToken: b.refreshToken })).status, 401);
  b.accessToken = reset.data.accessToken;

  // --- history sync
  const s1 = { startedAt: 1700000000000, bpm: 120, accuracy: 0.9 };
  assert.equal((await call("POST", "/sessions", { sessions: [s1, s1] }, a.accessToken)).data.stored, 1);
  assert.equal((await call("GET", "/sessions", undefined, a.accessToken)).data.sessions[0].bpm, 120);

  // --- daily challenge: the server judges the raw taps
  const daily = (await call("GET", "/daily", undefined, a.accessToken)).data;
  const notes = noteTimes(daily.spec);
  const good = await call("POST", "/daily/submit", { date: daily.date, taps: notes.map((t) => t + 5) }, a.accessToken);
  assert.equal(good.data.result.score, 10000);
  assert.equal(good.data.rank, 1);
  const half = await call("POST", "/daily/submit", { date: daily.date, taps: notes.slice(0, notes.length / 2) }, b.accessToken);
  assert.ok(half.data.result.score < 6000);
  const worse = await call("POST", "/daily/submit", { date: daily.date, taps: [] }, a.accessToken);
  assert.equal(worse.data.improved, false);
  assert.equal(worse.data.best, 10000);
  assert.equal((await call("POST", "/daily/submit", { date: "2000-01-01", taps: [] }, a.accessToken)).data.error, "expired");
  assert.equal((await call("POST", "/daily/submit", { date: daily.date, taps: ["x"] }, a.accessToken)).status, 400);

  const board = (await call("GET", "/leaderboard?board=daily", undefined, b.accessToken)).data;
  const ia = board.entries.findIndex((e: any) => e.user.id === a.user.id);
  const ib = board.entries.findIndex((e: any) => e.user.id === b.user.id);
  assert.ok(ia >= 0 && ib > ia);
  assert.equal(board.me.score, half.data.result.score);
  assert.ok((await call("GET", "/leaderboard?board=total", undefined, a.accessToken)).data.me.score >= 10000);

  // --- friends
  const found = (await call("GET", `/users/search?q=${encodeURIComponent("bob" + run)}`, undefined, a.accessToken)).data.users;
  assert.equal(found[0].id, b.user.id);
  assert.equal((await call("GET", `/users/search?q=%23${b.user.id}`, undefined, a.accessToken)).data.users[0].id, b.user.id);
  assert.equal((await call("POST", "/pk", { opponentId: b.user.id }, a.accessToken)).data.error, "not_friends");
  assert.equal((await call("POST", "/friends/requests", { userId: b.user.id }, a.accessToken)).data.friend, false);
  const incoming = (await call("GET", "/friends", undefined, b.accessToken)).data.incoming;
  assert.equal(incoming[0].user.id, a.user.id);
  await call("POST", `/friends/requests/${incoming[0].id}/accept`, undefined, b.accessToken);
  assert.equal((await call("GET", "/friends", undefined, a.accessToken)).data.friends[0].id, b.user.id);
  const fb = (await call("GET", "/leaderboard?board=daily&scope=friends", undefined, b.accessToken)).data;
  assert.deepEqual(fb.entries.map((e: any) => e.user.id), [a.user.id, b.user.id]);

  // --- PK
  const pk = (await call("POST", "/pk", { opponentId: b.user.id }, a.accessToken)).data;
  assert.equal(pk.status, "open");
  const pkNotes = noteTimes(pk.spec);
  const p1 = (await call("POST", `/pk/${pk.id}/submit`, { taps: pkNotes.map((t) => t + 45) }, a.accessToken)).data;
  assert.equal(p1.status, "open");
  assert.equal(p1.mine.great, pkNotes.length);
  // bob can't see alice's score before playing
  const seen = (await call("GET", `/pk/${pk.id}`, undefined, b.accessToken)).data;
  assert.equal(seen.theirs, null);
  assert.equal(seen.theyPlayed, true);
  assert.equal((await call("POST", `/pk/${pk.id}/submit`, { taps: [] }, a.accessToken)).data.error, "already_played");
  const p2 = (await call("POST", `/pk/${pk.id}/submit`, { taps: pkNotes }, b.accessToken)).data;
  assert.equal(p2.status, "done");
  assert.equal(p2.winner, "me");
  assert.equal((await call("GET", `/pk/${pk.id}`, undefined, a.accessToken)).data.winner, "them");
  assert.equal((await call("GET", "/pk", undefined, a.accessToken)).data.matches[0].id, pk.id);
  // decline
  const pk2 = (await call("POST", "/pk", { opponentId: b.user.id }, a.accessToken)).data;
  assert.equal((await call("POST", `/pk/${pk2.id}/decline`, undefined, b.accessToken)).data.status, "declined");

  // unfriend
  await call("DELETE", `/friends/${a.user.id}`, undefined, b.accessToken);
  assert.equal((await call("GET", "/friends", undefined, a.accessToken)).data.friends.length, 0);
});
