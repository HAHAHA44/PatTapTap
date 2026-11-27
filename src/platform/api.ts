// Client for the PatPatTap server. The long-lived refresh token lives in the OS
// keychain (Rust side); each window keeps its own short-lived access token in memory.

import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { ChallengeResult, ChallengeSpec } from "../core/challenge";
import type { SessionSummary } from "../core/types";

export const API_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:8787";

/** Broadcast to every window when the user logs in or out. */
export const AUTH_CHANGED = "auth-changed";

export interface PublicUser {
  id: string;
  nickname: string;
}
export interface Me extends PublicUser {
  email: string;
}
export interface DailyInfo {
  date: string;
  spec: ChallengeSpec;
  best: ChallengeResult | null;
  attempts: number;
}
export interface DailySubmit {
  result: ChallengeResult;
  best: number;
  improved: boolean;
  rank: number | null;
}
export type BoardKind = "daily" | "total";
export type BoardScope = "global" | "friends";
export interface Board {
  board: BoardKind;
  scope: BoardScope;
  date: string | null;
  entries: { rank: number; user: PublicUser; score: number; me: boolean }[];
  me: { rank: number; score: number } | null;
}
export interface FriendRequest {
  id: string;
  user: PublicUser;
}
export interface Friends {
  friends: PublicUser[];
  incoming: FriendRequest[];
  outgoing: FriendRequest[];
}
export type PkStatus = "open" | "declined" | "done" | "expired";
export interface PkMatch {
  id: string;
  spec: ChallengeSpec;
  role: "challenger" | "opponent";
  opponent: PublicUser;
  createdAt: string;
  expiresAt: string;
  status: PkStatus;
  mine: ChallengeResult | null;
  theirs: ChallengeResult | null;
  theyPlayed: boolean;
  winner: "me" | "them" | "draw" | null;
}

/** A failed request. `code` is the server's error code, or "network". */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

const REFRESH = "refresh_token";
const secret = {
  get: () => invoke<string | null>("secret_get", { name: REFRESH }).catch(() => null),
  set: (v: string) => invoke("secret_set", { name: REFRESH, value: v }),
  clear: () => invoke("secret_delete", { name: REFRESH }).catch(() => {}),
};

let access: { token: string; until: number } | null = null;
let refreshing: Promise<string | null> | null = null;

async function raw<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  let r: Response;
  try {
    r = await fetch(API_URL + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, (data as { error?: string }).error ?? "server_error");
  return data as T;
}

/** A valid access token, refreshing it from the keychain token if needed; null if logged out. */
async function accessToken(force = false): Promise<string | null> {
  if (!force && access && access.until > Date.now()) return access.token;
  refreshing ??= (async () => {
    const rt = await secret.get();
    if (!rt) return null;
    try {
      const r = await raw<{ accessToken: string }>("POST", "/auth/refresh", { refreshToken: rt });
      access = { token: r.accessToken, until: Date.now() + 10 * 60000 };
      return r.accessToken;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        // token revoked or expired: logged out
        await secret.clear();
        access = null;
        emit(AUTH_CHANGED, null).catch(() => {});
        return null;
      }
      throw e;
    }
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function authed<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await accessToken();
  if (!token) throw new ApiError(401, "unauthorized");
  try {
    return await raw<T>(method, path, body, token);
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401) throw e;
    const again = await accessToken(true);
    if (!again) throw e;
    return raw<T>(method, path, body, again);
  }
}

async function loggedIn(r: { accessToken: string; refreshToken: string; user: Me }): Promise<Me> {
  await secret.set(r.refreshToken);
  access = { token: r.accessToken, until: Date.now() + 10 * 60000 };
  await emit(AUTH_CHANGED, r.user).catch(() => {});
  return r.user;
}

type LoginResponse = { accessToken: string; refreshToken: string; user: Me };

export const api = {
  /** The signed-in user, or null (also null when the server can't be reached and we have no token). */
  async currentUser(): Promise<Me | null> {
    if (!(await secret.get())) return null;
    return authed<Me>("GET", "/me");
  },
  sendCode: (email: string, purpose: "register" | "reset") => raw<{ sent: boolean }>("POST", "/auth/code", { email, purpose }),
  register: async (email: string, code: string, password: string, nickname: string) =>
    loggedIn(await raw<LoginResponse>("POST", "/auth/register", { email, code, password, nickname })),
  login: async (email: string, password: string) => loggedIn(await raw<LoginResponse>("POST", "/auth/login", { email, password })),
  resetPassword: async (email: string, code: string, password: string) =>
    loggedIn(await raw<LoginResponse>("POST", "/auth/reset", { email, code, password })),
  async logout() {
    const rt = await secret.get();
    if (rt) await raw("POST", "/auth/logout", { refreshToken: rt }).catch(() => {});
    await secret.clear();
    access = null;
    await emit(AUTH_CHANGED, null).catch(() => {});
  },
  setNickname: (nickname: string) => authed<Me>("PATCH", "/me", { nickname }),

  pushSessions: (sessions: SessionSummary[]) => authed<{ stored: number }>("POST", "/sessions", { sessions }),
  pullSessions: () => authed<{ sessions: SessionSummary[] }>("GET", "/sessions"),

  daily: () => authed<DailyInfo>("GET", "/daily"),
  submitDaily: (date: string, taps: number[]) => authed<DailySubmit>("POST", "/daily/submit", { date, taps }),
  leaderboard: (board: BoardKind, scope: BoardScope) => authed<Board>("GET", `/leaderboard?board=${board}&scope=${scope}`),

  searchUsers: (q: string) => authed<{ users: (PublicUser & { friend: boolean })[] }>("GET", `/users/search?q=${encodeURIComponent(q)}`),
  friends: () => authed<Friends>("GET", "/friends"),
  requestFriend: (userId: string) => authed<{ friend: boolean }>("POST", "/friends/requests", { userId }),
  acceptFriend: (requestId: string) => authed("POST", `/friends/requests/${requestId}/accept`),
  removeRequest: (requestId: string) => authed("DELETE", `/friends/requests/${requestId}`),
  unfriend: (userId: string) => authed("DELETE", `/friends/${userId}`),

  pkList: () => authed<{ matches: PkMatch[] }>("GET", "/pk"),
  pkCreate: (opponentId: string) => authed<PkMatch>("POST", "/pk", { opponentId }),
  pkSubmit: (id: string, taps: number[]) => authed<PkMatch>("POST", `/pk/${id}/submit`, { taps }),
  pkDecline: (id: string) => authed<PkMatch>("POST", `/pk/${id}/decline`),
};

/** Challenge the widget should play, sent from the settings window. */
export type ChallengeRequest = { kind: "daily"; date: string; spec: ChallengeSpec } | { kind: "pk"; id: string; spec: ChallengeSpec; opponent: string };
/** Widget → settings: a challenge run finished (submitted), failed, or was cancelled. */
export type ChallengeOutcome =
  | { kind: ChallengeRequest["kind"]; status: "submitted"; result: ChallengeResult }
  | { kind: ChallengeRequest["kind"]; status: "cancelled" }
  | { kind: ChallengeRequest["kind"]; status: "error"; code: string };
export const PLAY_CHALLENGE = "play-challenge";
export const CHALLENGE_DONE = "challenge-done";
