import { useCallback, useEffect, useState } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { ChallengeResult, ChallengeSpec, phraseCells } from "../core/challenge";
import { MessageKey, t } from "../i18n";
import {
  api,
  ApiError,
  AUTH_CHANGED,
  Board,
  BoardScope,
  CHALLENGE_DONE,
  ChallengeOutcome,
  ChallengeRequest,
  DailyInfo,
  Friends,
  Me,
  PkMatch,
  PLAY_CHALLENGE,
  PublicUser,
} from "../platform/api";
import { PatternPreview } from "./PatternEditor";

const ERRORS = [
  "network",
  "email_taken",
  "bad_code",
  "bad_login",
  "too_many",
  "not_friends",
  "already_friends",
  "self",
  "not_found",
  "expired",
  "closed",
  "already_played",
  "bad_request",
] as const;

function errText(e: unknown): string {
  const code = e instanceof ApiError ? e.code : "";
  return (ERRORS as readonly string[]).includes(code) ? t(`err.${code}` as MessageKey) : t("err.generic");
}

const pct = (score: number) => `${(score / 100).toFixed(2)}%`;
const who = (u: PublicUser) => `${u.nickname} #${u.id}`;

function specText(spec: ChallengeSpec) {
  const min = Math.round((spec.bars * spec.beats * 60) / spec.bpm / 60);
  return t("online.spec", { beats: spec.beats, bpm: spec.bpm, min: Math.max(1, min) });
}

/** The repeating rhythm of a chart, bar by bar. */
function SpecPreview({ spec }: { spec: ChallengeSpec }) {
  return (
    <span className="phrase">
      {phraseCells(spec).map((bar, i) => (
        <PatternPreview key={i} cells={bar} beats={bar.length} />
      ))}
    </span>
  );
}

function resultLine(r: ChallengeResult) {
  return t("online.resultLine", { p: pct(r.score), perfect: r.perfect, great: r.great, good: r.good, miss: r.miss, combo: r.maxCombo });
}

/** Button that runs an async action, shows its error, and blocks double clicks. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export default function OnlineTab() {
  /** undefined while loading */
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [offline, setOffline] = useState(false);

  const load = useCallback(() => {
    setOffline(false);
    api
      .currentUser()
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.code === "network") setOffline(true);
        setMe(null);
      });
  }, []);

  useEffect(() => {
    load();
    const un = listen(AUTH_CHANGED, load);
    return () => void un.then((f) => f());
  }, [load]);

  if (offline)
    return (
      <section>
        <p className="warn-text">{t("err.network")}</p>
        <button onClick={load}>{t("online.retry")}</button>
      </section>
    );
  if (me === undefined) return <p className="note">{t("common.loading")}</p>;
  if (!me) return <AuthForms />;
  return <Signed me={me} onMe={setMe} />;
}

// ---------------------------------------------------------------- sign in / up
type AuthMode = "login" | "register" | "reset";

function AuthForms() {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [codeSent, setCodeSent] = useState(false);
  const act = useAction();

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const sendCode = () =>
    act.run(async () => {
      await api.sendCode(email, mode === "register" ? "register" : "reset");
      setCodeSent(true);
      setCooldown(60);
    });

  const submit = () =>
    act.run(async () => {
      if (mode !== "login" && password.length < 8) throw new ApiError(400, "bad_request");
      if (mode === "login") await api.login(email, password);
      else if (mode === "register") await api.register(email, code, password, nickname);
      else await api.resetPassword(email, code, password);
    });

  const needsCode = mode !== "login";
  return (
    <section className="auth">
      <div className="seg">
        {(["login", "register", "reset"] as const).map((m) => (
          <button
            key={m}
            className={mode === m ? "on" : ""}
            onClick={() => {
              setMode(m);
              act.setError("");
            }}
          >
            {t(`online.${m}` as MessageKey)}
          </button>
        ))}
      </div>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          <span>{t("online.email")}</span>
          <input className="text" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        {needsCode && (
          <label>
            <span>{t("online.code")}</span>
            <span className="row">
              <input className="text short" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
              <button type="button" disabled={!email || cooldown > 0 || act.busy} onClick={sendCode}>
                {cooldown > 0 ? t("online.resendIn", { n: cooldown }) : t("online.sendCode")}
              </button>
            </span>
          </label>
        )}
        {needsCode && codeSent && <p className="note">{t("online.codeSent")}</p>}
        {mode === "register" && (
          <label>
            <span>{t("online.nickname")}</span>
            <input className="text" maxLength={20} value={nickname} onChange={(e) => setNickname(e.target.value)} required />
          </label>
        )}
        <label>
          <span>{mode === "reset" ? t("online.newPassword") : t("online.password")}</span>
          <input
            className="text"
            type="password"
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            minLength={mode === "login" ? undefined : 8}
            placeholder={mode === "login" ? undefined : t("online.passwordRule")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <div className="row">
          <button className="primary" type="submit" disabled={act.busy || (needsCode && code.length !== 6)}>
            {t(`online.${mode}Submit` as MessageKey)}
          </button>
          {act.error && <span className="warn-text">{act.error}</span>}
        </div>
      </form>
    </section>
  );
}

// ---------------------------------------------------------------- signed in
function Signed({ me, onMe }: { me: Me; onMe: (m: Me) => void }) {
  const [friends, setFriends] = useState<Friends | null>(null);
  const [matches, setMatches] = useState<PkMatch[] | null>(null);
  const [daily, setDaily] = useState<DailyInfo | null>(null);
  const [boardRev, setBoardRev] = useState(0);
  const [notice, setNotice] = useState("");
  const [loadErr, setLoadErr] = useState("");

  const reload = useCallback(() => {
    setLoadErr("");
    api.daily().then(setDaily).catch((e) => setLoadErr(errText(e)));
    api.friends().then(setFriends).catch(() => {});
    api.pkList().then((r) => setMatches(r.matches)).catch(() => {});
    setBoardRev((v) => v + 1);
  }, []);

  useEffect(() => {
    reload();
    const un = listen<ChallengeOutcome>(CHALLENGE_DONE, (e) => {
      const o = e.payload;
      if (o.status === "submitted") setNotice(t("online.submitted", { line: resultLine(o.result) }));
      else if (o.status === "error") setNotice(t("err.submit"));
      else setNotice(t("widget.challengeCancelled"));
      reload();
    });
    return () => void un.then((f) => f());
  }, [reload]);

  const play = (req: ChallengeRequest) => {
    setNotice("");
    emit(PLAY_CHALLENGE, req).catch(() => {});
  };

  return (
    <>
      <AccountSection me={me} onMe={onMe} />
      {notice && <p className="note notice">{notice}</p>}
      {loadErr && <p className="warn-text">{loadErr}</p>}

      <section>
        <h3>
          {t("online.daily")} {daily && <span className="note">{daily.date}</span>}
        </h3>
        {daily && (
          <>
            <div className="row wrap">
              <span>{specText(daily.spec)}</span>
              <SpecPreview spec={daily.spec} />
            </div>
            <div className="row">
              <button className="primary" onClick={() => play({ kind: "daily", date: daily.date, spec: daily.spec })}>
                {daily.attempts ? t("online.playAgain") : t("online.play")}
              </button>
              <span className="note">
                {daily.best ? t("online.best", { line: resultLine(daily.best), n: daily.attempts }) : t("online.notPlayed")}
              </span>
            </div>
          </>
        )}
      </section>

      <LeaderboardSection rev={boardRev} />
      <PkSection matches={matches} onPlay={play} onChange={reload} />
      <FriendsSection friends={friends} onChange={reload} onPk={() => api.pkList().then((r) => setMatches(r.matches))} />
    </>
  );
}

function AccountSection({ me, onMe }: { me: Me; onMe: (m: Me) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(me.nickname);
  const act = useAction();
  return (
    <section>
      <h3>{t("online.account")}</h3>
      <div className="row wrap">
        {editing ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              act.run(async () => {
                onMe({ ...me, ...(await api.setNickname(name)) });
                setEditing(false);
              });
            }}
          >
            <input className="text" maxLength={20} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <button className="primary" type="submit" disabled={act.busy || !name.trim()}>
              {t("common.save")}
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
          </form>
        ) : (
          <>
            <b>{me.nickname}</b>
            <span className="note">
              #{me.id} · {me.email}
            </span>
            <button onClick={() => setEditing(true)}>{t("online.rename")}</button>
            <button onClick={() => act.run(() => api.logout())}>{t("online.logout")}</button>
          </>
        )}
        {act.error && <span className="warn-text">{act.error}</span>}
      </div>
    </section>
  );
}

function LeaderboardSection({ rev }: { rev: number }) {
  const [scope, setScope] = useState<BoardScope>("global");
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    setErr("");
    api.leaderboard(scope).then(setBoard).catch((e) => setErr(errText(e)));
  }, [scope, rev]);
  const fmt = pct;
  return (
    <section>
      <h3>{t("online.leaderboard")}</h3>
      <div className="seg">
        {(["global", "friends"] as const).map((k) => (
          <button key={k} className={scope === k ? "on" : ""} onClick={() => setScope(k)}>
            {t(`online.scope.${k}` as MessageKey)}
          </button>
        ))}
      </div>
      {err && <p className="warn-text">{err}</p>}
      {board && !board.entries.length && <p className="note">{t("online.boardEmpty")}</p>}
      {board && board.entries.length > 0 && (
        <table className="board">
          <tbody>
            {board.entries.map((e) => (
              <tr key={e.user.id} className={e.me ? "hl" : ""}>
                <td className="rank">{e.rank}</td>
                <td>{who(e.user)}</td>
                <td className="num">{fmt(e.score)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {board?.me && scope === "global" && !board.entries.some((e) => e.me) && (
        <p className="note">{t("online.myRank", { rank: board.me.rank, score: fmt(board.me.score) })}</p>
      )}
    </section>
  );
}

function hoursLeft(iso: string) {
  return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 3600000));
}

function PkSection({ matches, onPlay, onChange }: { matches: PkMatch[] | null; onPlay: (r: ChallengeRequest) => void; onChange: () => void }) {
  const act = useAction();
  if (!matches) return null;
  return (
    <section>
      <h3>{t("online.pk")}</h3>
      {!matches.length && <p className="note">{t("online.pkEmpty")}</p>}
      <div className="pk-list">
        {matches.map((m) => {
          const canPlay = m.status === "open" && !m.mine;
          let state: string;
          if (m.status === "declined") state = m.role === "challenger" ? t("online.pkDeclinedByThem") : t("online.pkDeclinedByMe");
          else if (m.status === "open") state = m.mine ? t("online.pkWaitThem", { h: hoursLeft(m.expiresAt) }) : t("online.pkYourTurn", { h: hoursLeft(m.expiresAt) });
          else if (m.winner === "me") state = t("online.pkWin");
          else if (m.winner === "them") state = t("online.pkLose");
          else if (m.winner === "draw") state = t("online.pkDraw");
          else state = t("online.pkExpired");
          return (
            <div key={m.id} className={`pk ${canPlay ? "todo" : ""}`}>
              <div className="pk-head">
                <b>{t("online.pkVs", { name: who(m.opponent) })}</b>
                <span className={`pk-state ${m.winner ?? ""}`}>{state}</span>
              </div>
              <div className="note">{specText(m.spec)}</div>
              {(m.mine || m.theirs) && (
                <div className="note">
                  {t("online.pkScores", { mine: m.mine ? pct(m.mine.score) : "–", theirs: m.theirs ? pct(m.theirs.score) : m.theyPlayed ? "?" : "–" })}
                </div>
              )}
              {canPlay && (
                <div className="row">
                  <button className="primary" onClick={() => onPlay({ kind: "pk", id: m.id, spec: m.spec, opponent: m.opponent.nickname })}>
                    {t("online.pkPlay")}
                  </button>
                  {m.role === "opponent" && (
                    <button disabled={act.busy} onClick={() => act.run(async () => (await api.pkDecline(m.id), onChange()))}>
                      {t("online.pkDecline")}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {act.error && <p className="warn-text">{act.error}</p>}
    </section>
  );
}

function FriendsSection({ friends, onChange, onPk }: { friends: Friends | null; onChange: () => void; onPk: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<(PublicUser & { friend: boolean })[] | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const act = useAction();
  const outgoing = new Set(friends?.outgoing.map((r) => r.user.id));
  return (
    <section>
      <h3>{t("online.friends")}</h3>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) act.run(async () => setFound((await api.searchUsers(q.trim())).users));
        }}
      >
        <input className="text" placeholder={t("online.searchHint")} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" disabled={act.busy || !q.trim()}>
          {t("online.search")}
        </button>
      </form>
      {found && !found.length && <p className="note">{t("online.noUsers")}</p>}
      {found?.map((u) => (
        <div key={u.id} className="row friend">
          <span>{who(u)}</span>
          {u.friend ? (
            <span className="note">{t("online.isFriend")}</span>
          ) : outgoing.has(u.id) ? (
            <span className="note">{t("online.requested")}</span>
          ) : (
            <button
              disabled={act.busy}
              onClick={() =>
                act.run(async () => {
                  const r = await api.requestFriend(u.id);
                  setMsg(r.friend ? t("online.nowFriends", { name: u.nickname }) : t("online.requestSent"));
                  onChange();
                })
              }
            >
              {t("online.addFriend")}
            </button>
          )}
        </div>
      ))}
      {msg && <p className="note">{msg}</p>}
      {act.error && <p className="warn-text">{act.error}</p>}

      {friends && friends.incoming.length > 0 && (
        <>
          <h4>{t("online.incoming")}</h4>
          {friends.incoming.map((r) => (
            <div key={r.id} className="row friend">
              <span>{who(r.user)}</span>
              <button className="primary" disabled={act.busy} onClick={() => act.run(async () => (await api.acceptFriend(r.id), onChange()))}>
                {t("online.accept")}
              </button>
              <button disabled={act.busy} onClick={() => act.run(async () => (await api.removeRequest(r.id), onChange()))}>
                {t("online.decline")}
              </button>
            </div>
          ))}
        </>
      )}
      {friends && friends.outgoing.length > 0 && (
        <>
          <h4>{t("online.outgoing")}</h4>
          {friends.outgoing.map((r) => (
            <div key={r.id} className="row friend">
              <span>{who(r.user)}</span>
              <button disabled={act.busy} onClick={() => act.run(async () => (await api.removeRequest(r.id), onChange()))}>
                {t("online.cancelRequest")}
              </button>
            </div>
          ))}
        </>
      )}
      {friends && (
        <>
          <h4>{t("online.friendList", { n: friends.friends.length })}</h4>
          {!friends.friends.length && <p className="note">{t("online.noFriends")}</p>}
          {friends.friends.map((u) => (
            <div key={u.id} className="row friend">
              <span>{who(u)}</span>
              <button
                className="primary"
                disabled={act.busy}
                onClick={() =>
                  act.run(async () => {
                    await api.pkCreate(u.id);
                    setMsg(t("online.pkSent", { name: u.nickname }));
                    onPk();
                  })
                }
              >
                {t("online.challenge")}
              </button>
              {confirm === u.id ? (
                <button className="danger" onClick={() => act.run(async () => (await api.unfriend(u.id), setConfirm(null), onChange()))}>
                  {t("online.unfriendConfirm", { name: u.nickname })}
                </button>
              ) : (
                <button onClick={() => setConfirm(u.id)}>{t("online.unfriend")}</button>
              )}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
