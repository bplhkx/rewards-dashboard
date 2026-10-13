"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "dashboard.sqlite");

const MAX_ACTIVITY_ROWS = 5000;

// Last-resort cutoff for a 'running' row whose account roster never filled
// (see the run-start case in apply() below) - e.g. the process died after
// only 1 of N accounts ever started, so nothing will ever complete that
// roster to trigger the normal check. Deliberately very long: a user can
// configure any number of accounts, the first run of the day can take hours
// to work through all of them, and any single account can sit blocked far
// longer still waiting on a manual login-approval prompt - so this only
// exists to bound a truly abandoned run, not to police normal durations.
const RUN_STALE_BACKSTOP_MS = 20 * 60 * 60 * 1000;

// How long to wait after the last ACCOUNT-END/ACCOUNT-ERROR before assuming
// the bot's own RUN-END is never coming and closing the run ourselves. The
// bot normally logs RUN-END within ~1s of the last account finishing; this
// only kicks in for a known bot-side clustering bug where worker-exit
// tracking undercounts and the run's own master process waits forever for
// exits that already happened, so RUN-END never fires despite every account
// having actually completed.
const AUTO_CLOSE_GRACE_MS = 15 * 1000;

// No legitimate run takes more than a couple minutes to log its very first
// ACCOUNT-START - the app logs it within ~1s of RUN-START in every observed
// case. accountDelay/manual-login waits only explain a SUBSEQUENT account
// being slow to start, never the first one. So "zero accounts started" this
// long after RUN-START is a much stronger and much faster signal of a dead
// process than RUN_STALE_BACKSTOP_MS's 20-hour window (which exists for a
// different problem: a run that died partway through a roster that DID
// start filling). Kept deliberately short.
const ZERO_START_STALE_MS = 5 * 60 * 1000;

// General safety net for a run that hangs PARTWAY through - e.g. the
// process deadlocks on a local resource (observed in production: a
// "database is locked" error from the bot's own local cache DB) without
// crashing, exiting any worker, or logging anything else ever again. Unlike
// ZERO_START_STALE_MS this can't be just a few minutes, since a run
// legitimately produces bursty gaps (accountDelay waits, slow searches) -
// but a run that's produced ABSOLUTELY NOTHING for this long, across every
// account, is well beyond any gap seen in normal operation.
const RUN_NO_ACTIVITY_STALE_MS = 90 * 60 * 1000;

// How often the zero-start watchdog checks, independent of incoming events -
// needed because a run stuck in the zero-start state produces no further
// log lines at all to trigger a check from apply().
const ZERO_START_WATCHDOG_INTERVAL_MS = 60 * 1000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS accounts (
    email TEXT PRIMARY KEY,
    user_name TEXT,
    geo_locale TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    last_start_at TEXT,
    last_end_at TEXT,
    last_gained INTEGER,
    last_points INTEGER,
    last_duration_sec REAL,
    last_error TEXT,
    streak_protection_enabled INTEGER,
    streak_protection_remaining_days INTEGER,
    streak_counter INTEGER,
    streak_protection_updated_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS account_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    ts TEXT NOT NULL,
    points INTEGER NOT NULL,
    gained INTEGER NOT NULL,
    duration_sec REAL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_history_email_ts ON account_history(email, ts);

CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    start_ts TEXT,
    end_ts TEXT,
    version TEXT,
    total_accounts INTEGER,
    clusters INTEGER,
    accounts_processed INTEGER,
    total_gained INTEGER,
    old_total INTEGER,
    new_total INTEGER,
    runtime_min REAL,
    exit_code INTEGER,
    exit_signal TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_runs_start ON runs(start_ts);

CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT,
    title TEXT,
    kind TEXT,
    user_name TEXT,
    platform TEXT,
    email TEXT,
    message TEXT,
    raw TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity(ts);

-- Per-account, per-day, per-source points. The bot only keeps live.bySource in
-- memory (cleared on every new run and on an API restart), so this table is the
-- durable copy: one row per (email, Beijing day, source). "Today" is just the
-- row for the current day, which is why nothing needs to be reset at midnight -
-- a new day simply starts writing a new key.
CREATE TABLE IF NOT EXISTS daily_points (
    email TEXT NOT NULL,
    day TEXT NOT NULL,
    source TEXT NOT NULL,
    points INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, day, source)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_daily_points_day ON daily_points(day);

-- daily_points 是聚合表，真正的账本在这里：一行 = 一个账号在一轮里某个分类的得分。
-- 为什么必须按轮存：live.bySource 是"本轮累计"，每轮开始就归零。以前只按
-- (账号,天,分类) 存 MAX，同一天跑两轮时第二轮的小值会被第一轮的大值盖掉，
-- 当天合计就比机器人自己记的少（实测 10-12 少了 101 分）。
CREATE TABLE IF NOT EXISTS run_points (
    email TEXT NOT NULL,
    run_id TEXT NOT NULL,
    day TEXT NOT NULL,
    source TEXT NOT NULL,
    points INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (email, run_id, day, source)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_run_points_day ON run_points(day);

-- Multi-day check-ins whose progress Microsoft only reports in the log stream
-- (the bot reads hva_dse_days from the App's level_info and prints "3/14 天").
-- The activity feed is noisy and gets pruned, so the latest number per
-- (account, kind) lives here instead - one row that moves forward as days pass.
CREATE TABLE IF NOT EXISTS checkin_progress (
    email TEXT NOT NULL,
    kind TEXT NOT NULL,
    days INTEGER NOT NULL,
    days_max INTEGER NOT NULL,
    status TEXT NOT NULL,
    ts TEXT NOT NULL,
    user_name TEXT,
    PRIMARY KEY (email, kind)
) STRICT;
`;

// Daily-set / search offers are keyed by the account's own day, and every
// account here is CN, so "today" means Beijing regardless of the host TZ.
function beijingDay(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

// The bot stamps every point event with entry.receivedAt (true UTC ISO). Anything
// else - null, a log line's local string, junk - falls back to the sample time.
function parseIsoTs(value) {
  if (typeof value !== "string" || !value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// "YYYY-MM-DD" 往前 n 天。按 UTC 正午解析再回推，避开任何时区/夏令时的整日偏移。
function prevDay(key, n = 1) {
  const d = new Date(`${key}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

// 面板看到的每一行日志都会经过 apply()，这些规则把文本里的进度摘成结构化的一行。
// 一条规则 = 一个 title + 一个解析函数，返回 {kind, days, daysMax, status} 或 null。
// 加新的打卡类型只要在这里添一条，App 侧靠 kind 查表显示，不用改接口。
const CHECKIN_RULES = [
  {
    title: 'DEFAULT-SEARCH-ENGINE',
    parse(message) {
      // 必须带"天"：同一张卡的"第 2/3 次尝试"也是 x/y，混进来会把重试次数当成 2/3 天
      const m = /(\d+)\s*\/\s*(\d+)\s*天/.exec(message);
      if (!m) return null;
      let status = 'progress';
      if (/打卡成功/.test(message)) status = 'advanced';
      else if (/活动已完成/.test(message)) status = 'complete';
      else if (/未确认成功|进度未变/.test(message)) status = 'stalled';
      else if (/开始默认搜索引擎打卡/.test(message)) status = 'started';
      return { kind: 'default-search', days: Number(m[1]), daysMax: Number(m[2]), status };
    },
  },
  {
    title: 'SEARCH-MANAGER',
    parse(message) {
      // "Desktop: run (24/30, missing 6)" / "Desktop: skip (complete, 60/60)"
      const m = /Desktop:[^()]*\(\s*(?:complete,\s*)?(\d+)\s*\/\s*(\d+)/.exec(message);
      if (!m) return null;
      return {
        kind: 'search-today',
        days: Number(m[1]),
        daysMax: Number(m[2]),
        status: /Desktop:\s*skip/.test(message) ? 'complete' : 'progress',
      };
    },
  },
  {
    title: 'CHECKIN-PROGRESS',
    // bot 把 level_info 里的 hva_* 天数成对拼在一行：
    //   "dse=3/14 | dailyset=2/4 | dailystreaks_mobile=5/7"
    // dse 与 DEFAULT-SEARCH-ENGINE 是同一个活动，归到同一个 kind，谁新用谁。
    parse(message) {
      const out = [];
      // 名字里可能有连字符（streak-cn-bing-com），别把它截断成 "com"
      for (const m of message.matchAll(/([a-z0-9_-]+)\s*=\s*(\d+)\s*\/\s*(\d+)/gi)) {
        const name = m[1].toLowerCase();
        const days = Number(m[2]);
        const daysMax = Number(m[3]);
        if (!daysMax || days > daysMax) continue;
        out.push({
          // kind 直接用 bot 打出来的名字（dse / dailyset / streak-bing / tasks-bing…），
          // 只有默认搜索引擎沿用已有的 kind 名；界面按关键字归类，不再加 level- 前缀
          kind: name === "dse" ? "default-search" : name,
          days,
          daysMax,
          status: days >= daysMax ? "complete" : "progress",
        });
      }
      return out;
    },
  },
  {
    title: 'REACT-PARSE',
    parse(message) {
      // 两种口径必须分成两个 kind：
      //   stamps=3/12  → 页面里那句 "3 / 12 个任务"，就是用户看的"印章 n/12"
      //   parents/incomplete → 只是"几张卡、几张没完成"
      // 以前两者都写成 punch，于是解析不到 stamps 时界面会画出两个格子，
      // 看着像"总共只有 2 枚印章"。
      const stamps = /stamps\s*=\s*(\d+)\s*\/\s*(\d+)/.exec(message);
      if (stamps) {
        const done = Number(stamps[1]);
        const total = Number(stamps[2]);
        if (total > 0 && done <= total) {
          return { kind: 'punch', days: done, daysMax: total, status: done >= total ? 'complete' : 'progress' };
        }
      }
      const m = /parents\s*=\s*(\d+)[^|]*\|[^|]*incomplete\s*=\s*(\d+)/.exec(message);
      if (!m) return null;
      const max = Number(m[1]);
      const incomplete = Number(m[2]);
      if (!max) return null;
      return {
        kind: 'punch-cards',
        days: Math.max(0, max - incomplete),
        daysMax: max,
        status: incomplete === 0 ? 'complete' : 'progress',
      };
    },
  },
  {
    title: 'DAILY-SET',
    parse(message) {
      if (!/already been completed/i.test(message)) return null;
      return { kind: 'daily-set-today', days: 1, daysMax: 1, status: 'complete' };
    },
  },
  {
    title: 'DAILY-CHECK-IN',
    parse(message) {
      if (!/completed/i.test(message)) return null;
      return { kind: 'app-checkin-today', days: 1, daysMax: 1, status: 'complete' };
    },
  },
];

class Store {
  /// 捕获规则覆盖到的日志 title，回填脚本按这个集合筛行
  static CHECKIN_TITLES = [...new Set(CHECKIN_RULES.map((r) => r.title))];

  constructor() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(DB_FILE);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec(SCHEMA);
    this._migrate();
    this._prepare();
    this._lastTs = this._readMeta("lastTs");
    this._autoCloseTimer = null;
    // Ephemeral (not persisted) - transient "waiting between accounts" state
    // is only meaningful while live, unlike everything else in this class.
    this._pendingDelay = null;

    // Completion evidence for the currently running process. Deliberately
    // NOT persisted - describes evidence from the live log stream only. If
    // the dashboard restarts, it should not assume an old process completed
    // successfully merely because it had partial evidence before restart.
    this._resetCompletionEvidence();

    // Watchdog for runs whose very first account never even logged
    // ACCOUNT-START (see _tryCloseZeroStartRun below for why this needs its
    // own, much shorter timeout than RUN_STALE_BACKSTOP_MS). Runs
    // independently of incoming events, since a truly dead run produces no
    // further events to trigger a check.
    this._zeroStartWatchdog = setInterval(() => {
      try {
        this._tryCloseZeroStartRun();
      } catch {
        /* best-effort safety net */
      }
      try {
        this._tryCloseStaleNoActivityRun();
      } catch {
        /* best-effort safety net */
      }
    }, ZERO_START_WATCHDOG_INTERVAL_MS);
    if (this._zeroStartWatchdog.unref) this._zeroStartWatchdog.unref();
  }

  _migrate() {
    const runCols = new Set(
      this.db
        .prepare("PRAGMA table_info(runs)")
        .all()
        .map((c) => c.name),
    );
    if (!runCols.has("exit_code"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_code INTEGER");
    if (!runCols.has("exit_signal"))
      this.db.exec("ALTER TABLE runs ADD COLUMN exit_signal TEXT");

    const accountCols = new Set(
      this.db
        .prepare("PRAGMA table_info(accounts)")
        .all()
        .map((c) => c.name),
    );
    const accountMigrations = [
      ["streak_protection_enabled", "INTEGER"],
      ["streak_protection_remaining_days", "INTEGER"],
      ["streak_counter", "INTEGER"],
      ["streak_protection_updated_at", "TEXT"],
    ];
    for (const [name, type] of accountMigrations) {
      if (!accountCols.has(name))
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${name} ${type}`);
    }
  }

  _prepare() {
    this.stmts = {
      getMeta: this.db.prepare("SELECT value FROM meta WHERE key = ?"),      setMeta: this.db.prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ),

      // MAX() keeps this idempotent: the bot's bySource is cumulative within a
      // run, so re-reporting the same (or a smaller, post-restart) value must
      // never add points twice or shrink what a day already earned.
      upsertDailyPoint: this.db.prepare(`
                INSERT INTO daily_points (email, day, source, points, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(email, day, source) DO UPDATE SET
                    points = MAX(daily_points.points, excluded.points),
                    updated_at = excluded.updated_at
            `),
      dailyPointsSince: this.db.prepare(
        "SELECT email, day, source, points, updated_at FROM daily_points WHERE day >= ? ORDER BY day, email, source",
      ),

      // 账本：一行 = 某账号某轮某分类的得分。同一轮被反复采样取 MAX（幂等），
      // 不同轮之间相加，所以一天跑两轮不会再丢第二轮的分。
      upsertRunPoint: this.db.prepare(`
                INSERT INTO run_points (email, run_id, day, source, points, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(email, run_id, day, source) DO UPDATE SET
                    points = MAX(run_points.points, excluded.points),
                    updated_at = excluded.updated_at
            `),
      rebuildDailyPoint: this.db.prepare(`
                INSERT INTO daily_points (email, day, source, points, updated_at)
                SELECT email, day, source, SUM(points), MAX(updated_at)
                FROM run_points WHERE email = ? AND day = ? AND source = ?
                GROUP BY email, day, source
                ON CONFLICT(email, day, source) DO UPDATE SET
                    points = excluded.points,
                    updated_at = excluded.updated_at
            `),
      countRunPoints: this.db.prepare("SELECT COUNT(*) AS n FROM run_points"),
      seedRunPoints: this.db.prepare(`
                INSERT OR IGNORE INTO run_points (email, run_id, day, source, points, updated_at)
                SELECT email, 'legacy', day, source, points, updated_at FROM daily_points
            `),

      // 进度只能往前走：同一账号同一 kind 只留 ts 最新的那条，晚到的旧日志行不覆盖。
      upsertCheckinProgress: this.db.prepare(`
                INSERT INTO checkin_progress (email, kind, days, days_max, status, ts, user_name)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(email, kind) DO UPDATE SET
                    days = excluded.days,
                    days_max = excluded.days_max,
                    status = excluded.status,
                    ts = excluded.ts,
                    user_name = excluded.user_name
                WHERE excluded.ts >= checkin_progress.ts
            `),
      checkinsByEmail: this.db.prepare(
        "SELECT kind, days, days_max, status, ts, user_name FROM checkin_progress WHERE email = ?",
      ),
      allCheckinProgress: this.db.prepare(
        "SELECT email, kind, days, days_max, status, ts, user_name FROM checkin_progress ORDER BY email, kind",
      ),
      // 日志行的 [user] 只有邮箱前缀，而多域账号的前缀会撞车
      // （bplhkd@outlook.com 与 bplhkd@gmail.com 都是 bplhkd）。以前这里是
      // `... LIMIT 1`，等于把两个账号的打卡进度全记到"扫到的第一行"那个邮箱上，
      // 另一个账号在 App 里就永远显示"未记录"。现在一律取全部匹配，只在唯一时采信。
      emailsByUserName: this.db.prepare(
        "SELECT email FROM accounts WHERE lower(user_name) = lower(?) AND email IS NOT NULL",
      ),
      // 撞车时优先认"当前正在跑的那个"；开了多 cluster 并行时这里会返回多行，
      // 调用方按"不唯一就不猜"处理。
      runningEmailsByUserName: this.db.prepare(
        "SELECT email FROM accounts WHERE lower(user_name) = lower(?) AND status = 'running' AND email IS NOT NULL",
      ),

      upsertAccountStart: this.db.prepare(`
                INSERT INTO accounts (email, user_name, geo_locale, status, last_start_at)
                VALUES (?, ?, ?, 'running', ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    geo_locale = excluded.geo_locale,
                    status = 'running',
                    last_start_at = excluded.last_start_at
            `),
      upsertAccountEnd: this.db.prepare(`
                INSERT INTO accounts (email, user_name, status, last_end_at, last_gained, last_points, last_duration_sec, last_error)
                VALUES (?, ?, 'success', ?, ?, ?, ?, NULL)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'success',
                    last_end_at = excluded.last_end_at,
                    last_gained = excluded.last_gained,
                    last_points = excluded.last_points,
                    last_duration_sec = excluded.last_duration_sec,
                    last_error = NULL
            `),
      upsertAccountError: this.db.prepare(`
                INSERT INTO accounts (email, status, last_end_at, last_error)
                VALUES (?, 'error', ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    status = 'error',
                    last_end_at = excluded.last_end_at,
                    last_error = excluded.last_error
            `),
      upsertStreakProtection: this.db.prepare(`
                INSERT INTO accounts (
                    email, user_name, status, streak_protection_enabled,
                    streak_protection_remaining_days, streak_counter,
                    streak_protection_updated_at
                )
                VALUES (?, ?, 'idle', ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    user_name = excluded.user_name,
                    streak_protection_enabled = excluded.streak_protection_enabled,
                    streak_protection_remaining_days = excluded.streak_protection_remaining_days,
                    streak_counter = excluded.streak_counter,
                    streak_protection_updated_at = excluded.streak_protection_updated_at
            `),
      insertHistory: this.db.prepare(
        "INSERT INTO account_history (email, ts, points, gained, duration_sec) VALUES (?, ?, ?, ?, ?)",
      ),
      historyForEmail: this.db.prepare(
        "SELECT ts, points, gained, duration_sec as durationSec FROM account_history WHERE email = ? ORDER BY ts ASC",
      ),
      deleteAccountRow: this.db.prepare("DELETE FROM accounts WHERE email = ?"),
      deleteAccountHistory: this.db.prepare(
        "DELETE FROM account_history WHERE email = ?",
      ),
      deleteAccountActivity: this.db.prepare(
        "DELETE FROM activity WHERE email = ?",
      ),
      allAccounts: this.db.prepare(`
                SELECT email, user_name as userName, geo_locale as geoLocale, status,
                       last_start_at as lastStartAt, last_end_at as lastEndAt,
                       last_gained as lastGained, last_points as lastPoints,
                       last_duration_sec as lastDurationSec, last_error as lastError,
                       streak_protection_enabled as streakProtectionEnabled,
                       streak_protection_remaining_days as streakProtectionRemainingDays,
                       streak_counter as streakCounter,
                       streak_protection_updated_at as streakProtectionUpdatedAt
                FROM accounts
                ORDER BY COALESCE(last_end_at, last_start_at) DESC
            `),

      insertRunStart: this.db.prepare(`
                INSERT INTO runs (id, status, start_ts, version, total_accounts, clusters)
                VALUES (?, 'running', ?, ?, ?, ?)
                ON CONFLICT(id) DO NOTHING
            `),
      findRunningRun: this.db.prepare(
        `SELECT id, start_ts as startTs, total_accounts as totalAccounts FROM runs WHERE status = 'running' ORDER BY start_ts DESC LIMIT 1`,
      ),
      accountsStartedSince: this.db.prepare(`
                SELECT COUNT(DISTINCT email) as n
                FROM activity
                WHERE title = 'ACCOUNT-START' AND email IS NOT NULL AND ts >= ?
            `),
      accountsResolvedSince: this.db.prepare(`
                SELECT COUNT(DISTINCT email) as n, MAX(ts) as lastTs
                FROM activity
                WHERE title IN ('ACCOUNT-END', 'ACCOUNT-ERROR') AND email IS NOT NULL AND ts >= ?
            `),
      lastActivitySince: this.db.prepare(`
                SELECT MAX(ts) as ts FROM activity WHERE ts >= ?
            `),
      lastLoginPromptKindSince: this.db.prepare(`
                SELECT kind FROM activity
                WHERE ts >= ? AND kind IN ('login-number', 'login-number-resolved')
                ORDER BY ts DESC LIMIT 1
            `),
      sumHistorySince: this.db.prepare(`
                SELECT COALESCE(SUM(gained), 0) as gained, COALESCE(SUM(points), 0) as points
                FROM account_history WHERE ts >= ?
            `),

      closeRun: this.db.prepare(`
                UPDATE runs SET status = 'done', end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?
                WHERE id = ?
            `),
      insertOrphanRunEnd: this.db.prepare(`
                INSERT INTO runs (id, status, end_ts, accounts_processed, total_gained, old_total, new_total, runtime_min)
                VALUES (?, 'done', ?, ?, ?, ?, ?, ?)
            `),
      recentRuns: this.db.prepare(`
                SELECT id, status, start_ts as startTs, end_ts as endTs, version,
                       total_accounts as totalAccounts, clusters,
                       accounts_processed as accountsProcessed, total_gained as totalGained,
                       old_total as oldTotal, new_total as newTotal, runtime_min as runtimeMin,
                       exit_code as exitCode, exit_signal as exitSignal
                FROM runs ORDER BY COALESCE(start_ts, end_ts) DESC LIMIT ?
            `),
      // Unified terminal-state closer used whenever we're ending a run
      // without the bot's own authoritative RUN-END data (crash/stop/
      // interrupt/auto-close) - stats are derived from account_history
      // instead, see _closeRunningRun().
      closeRunFull: this.db.prepare(`
                UPDATE runs SET status = ?, end_ts = ?, accounts_processed = ?,
                    total_gained = ?, old_total = ?, new_total = ?, runtime_min = ?,
                    exit_code = ?, exit_signal = ?
                WHERE id = ?
            `),
      orphanedRunningAccounts: this.db.prepare(
        "SELECT email FROM accounts WHERE status = 'running' AND last_start_at >= ?",
      ),
      markAccountInterrupted: this.db.prepare(`
                UPDATE accounts SET status = 'error', last_end_at = ?, last_error = ?
                WHERE email = ? AND status = 'running'
            `),
      // RUN-END is authoritative proof that the overall run completed.
      // An account still marked 'running' at this point did not emit its own
      // ACCOUNT-END/ACCOUNT-ERROR, but it must not remain 'running' forever.
      // Keep the diagnostic in last_error so the missing worker result is
      // visible without incorrectly classifying the completed run as an error.
      markAccountCompletedWithoutResult: this.db.prepare(`
                UPDATE accounts SET status = 'success', last_end_at = ?, last_error = ?
                WHERE email = ? AND status = 'running'
            `),
      allHistories: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                ORDER BY email ASC, ts ASC
            `),
      allHistoriesSince: this.db.prepare(`
                SELECT email, ts, points, gained, duration_sec as durationSec
                FROM account_history
                WHERE ts >= ?
                ORDER BY email ASC, ts ASC
            `),

      insertActivity: this.db.prepare(`
                INSERT INTO activity (ts, level, title, kind, user_name, platform, email, message, raw)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
      recentActivity: this.db.prepare(`
                SELECT ts, level, title, kind, user_name as userName, platform, email, message, raw
                FROM activity ORDER BY id DESC LIMIT ?
            `),
      countActivity: this.db.prepare("SELECT COUNT(*) as n FROM activity"),
      pruneActivity: this.db.prepare(`
                DELETE FROM activity WHERE id IN (
                    SELECT id FROM activity ORDER BY id ASC LIMIT ?
                )
            `),
    };

    // 账本上线之前留下的聚合行没有轮次身份，先把它们原样登记成一轮 "legacy"，
    // 之后的新轮次就是加在它上面，而不是被 MAX 吞掉。只在账本为空时做一次。
    if (this.stmts.countRunPoints.get().n === 0) {
      this.stmts.seedRunPoints.run();
    }
  }

  /// 当前这一轮的身份：面板自己的 runs 表里那条 running 行。
  /// 没有进行中的轮次就返回 null —— 此时 /status 里那份缓存快照属于已经记过账的轮次，
  /// 再记一遍就是把同一轮算两次。
  activeRunId() {
    const row = this.db
      .prepare("SELECT id FROM runs WHERE status = 'running' ORDER BY start_ts DESC LIMIT 1")
      .get();
    return row ? String(row.id) : null;
  }

  _readMeta(key) {
    const row = this.stmts.getMeta.get(key);
    return row ? row.value : null;
  }

  _writeMeta(key, value) {
    this.stmts.setMeta.run(key, value);
  }

  get lastTs() {
    return this._lastTs;
  }

  // Null once no wait is in progress (never set, resolved by the next
  // ACCOUNT-START, or cleared because the run itself ended/closed).
  get pendingDelay() {
    return this._pendingDelay;
  }

  _resetCompletionEvidence() {
    this._workersExitedCleanly = false;
    this._workersExitedAt = null;
    this._anyWorkerExitedUncleanly = false;

    this._successfulWrapperCompletion = false;
    this._successfulWrapperCompletionAt = null;
    this._wrapperFailureSeen = false;
  }

  // Successful completion requires BOTH:
  //   1. The final cluster worker exited with Code 0, no signal, and
  //      Active workers: 0, AND no other worker this run ever exited
  //      uncleanly (see the cluster-worker-exit case in apply()).
  //   2. The wrapper reported successful completion.
  // This is the fallback for the bot-side clustering bug where RUN-END
  // itself never gets logged even though the process really did finish
  // cleanly - it must NOT fire on its own from "Lock released"/"Script
  // finished" alone, since those also happen after crashes/kills.
  _tryCloseFromSuccessfulProcessCompletion(eventTs) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (!this._workersExitedCleanly || !this._successfulWrapperCompletion) {
      return false;
    }

    const endTs =
      this._successfulWrapperCompletionAt ||
      this._workersExitedAt ||
      eventTs ||
      new Date().toISOString();

    const totals = this.stmts.sumHistorySince.get(running.startTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    const gained = totals.gained || 0;
    const newTotal = totals.points || 0;
    const oldTotal = newTotal - gained;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      "done",
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      0,
      null,
      running.id,
    );

    // The overall process completed successfully, so any account still
    // marked 'running' failed to emit its own terminal event. Mark it
    // success (not error) since the run itself succeeded - keep the
    // diagnostic in last_error so the missing per-account result stays
    // visible.
    for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
      this.stmts.markAccountCompletedWithoutResult.run(
        endTs,
        "Run completed successfully, but this account's own result was never logged (its worker likely failed silently).",
        row.email,
      );
    }

    this._pendingDelay = null;
    this._resetCompletionEvidence();
    return true;
  }

  // Watchdog for a run whose first account never even started (see
  // ZERO_START_STALE_MS above). Left unhandled, this also wedges every
  // future run: the run-start echo check below treats "roster incomplete"
  // as "same run continuing" for up to RUN_STALE_BACKSTOP_MS (20h), and a
  // run with zero accounts started can NEVER complete its roster, so every
  // subsequent RUN-START within that window would otherwise be silently
  // swallowed as a supposed echo of this dead run instead of starting a new
  // one.
  _tryCloseZeroStartRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const startedCount = this.stmts.accountsStartedSince.get(running.startTs).n;
    if (startedCount > 0) return;

    const ageMs = Date.now() - Date.parse(running.startTs);
    if (!Number.isFinite(ageMs) || ageMs < ZERO_START_STALE_MS) return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  // General safety net for a run that hung PARTWAY through - covers the
  // zero-start case too (no activity since start is a special case of "no
  // activity for a long time"), but is deliberately much more generous
  // (RUN_NO_ACTIVITY_STALE_MS) since a run that already has accounts in
  // flight can have legitimate bursty gaps that a brand-new run can't.
  //
  // Explicitly does NOT fire while the run is waiting on a still-open
  // manual login-approval prompt - that can legitimately take a long time
  // (this is exactly why RUN_STALE_BACKSTOP_MS is 20h instead of something
  // short), and is a real, expected reason for silence rather than a hang.
  _tryCloseStaleNoActivityRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running) return;

    const lastActivity = this.stmts.lastActivitySince.get(running.startTs);
    const lastTs = (lastActivity && lastActivity.ts) || running.startTs;
    const ageMs = Date.now() - Date.parse(lastTs);
    if (!Number.isFinite(ageMs) || ageMs < RUN_NO_ACTIVITY_STALE_MS) return;

    const pendingApproval = this.stmts.lastLoginPromptKindSince.get(running.startTs);
    if (pendingApproval && pendingApproval.kind === "login-number") return;

    this._closeRunningRun(running, "stalled", new Date().toISOString());
  }

  _pushActivity(event) {
    this.stmts.insertActivity.run(
      event.ts,
      event.level || null,
      event.title || null,
      event.kind || null,
      event.userName || null,
      event.platform || null,
      event.email || null,
      event.message || null,
      event.raw || null,
    );
    const { n } = this.stmts.countActivity.get();
    if (n > MAX_ACTIVITY_ROWS) {
      this.stmts.pruneActivity.run(n - MAX_ACTIVITY_ROWS);
    }
  }

  apply(event) {
    if (!event || !event.ts) return false;

    if (this._lastTs && event.ts <= this._lastTs) {
      return false;
    }
    this._lastTs = event.ts;
    this._writeMeta("lastTs", event.ts);

    // 打卡进度走的是 info/warn 普通行，落在下面 switch 的 generic 分支里会被丢掉
    // （只有 warn/error 才进 activity），所以必须在 switch 之前先摘出来。
    this._captureCheckins(event);

    let changed = true;

    switch (event.kind) {
      case "account-start": {
        if (!this._pendingDelay || !this._pendingDelay.nextEmail || this._pendingDelay.nextEmail === event.email) {
          this._pendingDelay = null;
        }
        this.stmts.upsertAccountStart.run(
          event.email,
          event.userName || null,
          event.geoLocale || null,
          event.ts,
        );
        this._pushActivity(event);
        break;
      }
      case "account-end": {
        this.stmts.upsertAccountEnd.run(
          event.email,
          event.userName || null,
          event.ts,
          event.gained,
          event.newPoints,
          event.durationSec,
        );
        this.stmts.insertHistory.run(
          event.email,
          event.ts,
          event.newPoints,
          event.gained,
          event.durationSec,
        );
        this._pushActivity(event);
        this._scheduleAutoCloseCheck();
        break;
      }
      case "account-error": {
        if (event.email) {
          this.stmts.upsertAccountError.run(event.email, event.ts, event.error);
        }
        this._pushActivity(event);
        this._scheduleAutoCloseCheck();
        break;
      }
      case "account-delay": {
        this._pendingDelay = {
          seconds: event.seconds,
          sinceTs: event.ts,
          nextEmail: event.nextEmail || null,
        };
        this._pushActivity(event);
        break;
      }
      case "streak-protection": {
        this.stmts.upsertStreakProtection.run(
          event.email,
          event.userName || null,
          event.enabled ? 1 : 0,
          event.remainingDays,
          event.streakCounter,
          event.ts,
        );
        break;
      }
      case "run-start": {
        // With clustering on, the bot logs one RUN-START line per worker
        // spawned for the SAME run, not once per run - e.g. Clusters: 3
        // can produce several near-identical RUN-START lines, one per
        // worker, and workers have been observed spawning minutes apart
        // rather than seconds (accountDelay-dependent) - so elapsed time
        // alone can't tell an echo apart from a genuinely new run. Only
        // the first one (nothing currently 'running') starts a new row;
        // later ones for the same run are redundant echoes and must be
        // ignored, not treated as evidence the previous row crashed.
        //
        // Use the account roster instead of a clock: while the currently
        // 'running' row hasn't yet seen ACCOUNT-START for all the accounts
        // it declared, any further RUN-START is still just another worker
        // of that same run. Once every declared account has started, the
        // roster is complete and a new RUN-START can only mean a new run -
        // this also catches a 'running' row stuck by a lost RUN-END/exit
        // signal (e.g. a container restart mid-run, or a missed cluster
        // worker exit), which otherwise permanently wedges every future run
        // (this event would be dropped forever, never even reaching the
        // activity feed, and any later RUN-END would misattribute to that
        // ancient row instead of getting a fresh one of its own).
        //
        // The one gap the roster check can't cover is a run that died
        // before its roster ever filled (e.g. crashed after account 1 of
        // 3) - nothing will ever complete that roster, so fall back to a
        // generous time backstop just for that case.
        this._resetCompletionEvidence();

        const alreadyRunning = this.stmts.findRunningRun.get();
        if (alreadyRunning) {
          const startedCount = alreadyRunning.totalAccounts
            ? this.stmts.accountsStartedSince.get(alreadyRunning.startTs).n
            : 0;
          const rosterIncomplete =
            alreadyRunning.totalAccounts != null && startedCount < alreadyRunning.totalAccounts;
          const ageMs = Date.parse(event.ts) - Date.parse(alreadyRunning.startTs);
          const withinBackstop = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < RUN_STALE_BACKSTOP_MS;
          // A run whose roster never even started (startedCount === 0) can
          // never complete its roster, so it would otherwise look like an
          // "echo" forever (up to the 20h backstop) and swallow every
          // subsequent RUN-START. The zero-start watchdog normally closes
          // these well before another RUN-START arrives, but this is a
          // safety net for e.g. the dashboard process itself having
          // restarted and lost that timer.
          const zeroStartStale =
            startedCount === 0 &&
            Number.isFinite(ageMs) &&
            ageMs >= ZERO_START_STALE_MS;
          const isEcho = rosterIncomplete && withinBackstop && !zeroStartStale;
          if (isEcho) {
            changed = false;
            break;
          }
          // We only know a new run started before the old one finished
          // normally - not why (could be a real crash, or just as likely an
          // intentional container recreate, e.g. pulling an updated image
          // mid-run). "interrupted" reflects that honestly instead of
          // guessing "crashed". markInterruptedByBackendRestart() below
          // handles the common container-recreate case immediately instead
          // of leaving it to this backstop.
          this._closeRunningRun(
            alreadyRunning,
            zeroStartStale ? "stalled" : "interrupted",
            event.ts,
          );
        }
        this.stmts.insertRunStart.run(
          event.ts,
          event.ts,
          event.version,
          event.totalAccounts,
          event.clusters,
        );
        this._pushActivity(event);
        break;
      }
      case "cluster-worker-exit": {
        // Worker PIDs are deliberately irrelevant to the decision - every
        // account can have a different PID and every run can use completely
        // different PIDs.
        //
        // IMPORTANT: an earlier worker in the same run can exit uncleanly
        // (crash/signal) before a LATER worker happens to be the one that
        // reports "Active workers: 0". Only checking the final exit line
        // would miss that earlier crash, so an unclean exit is latched for
        // the whole run and blocks treating a later clean "Active workers:
        // 0" line as proof the overall process completed cleanly.
        const exitedCleanly = event.code === 0 && event.signal == null;
        if (!exitedCleanly) {
          this._anyWorkerExitedUncleanly = true;
        }
        if (
          exitedCleanly &&
          event.activeWorkers === 0 &&
          !this._anyWorkerExitedUncleanly
        ) {
          this._workersExitedCleanly = true;
          this._workersExitedAt = event.ts;
          // May close the run immediately if wrapper completion evidence
          // already arrived.
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-completed": {
        // "Script completed successfully (via API)." is an explicit,
        // unambiguous positive completion signal.
        this._successfulWrapperCompletion = true;
        this._successfulWrapperCompletionAt = event.ts;
        this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-finished": {
        // Weaker evidence than "Script completed successfully": some
        // wrapper versions print this unconditionally on the way out,
        // including right after "ERROR: Script failed!". Only count it as
        // completion evidence if no failure has been seen yet this run, so
        // it can't silently resurrect a run we already know failed.
        if (!this._wrapperFailureSeen) {
          this._successfulWrapperCompletion = true;
          this._successfulWrapperCompletionAt = event.ts;
          this._tryCloseFromSuccessfulProcessCompletion(event.ts);
        }
        this._pushActivity(event);
        break;
      }
      case "wrapper-script-failed": {
        // Explicit wrapper failure is not completion evidence, and it
        // "poisons" the rest of this run so a later bare "Script finished"
        // line can't flip it back to success.
        this._wrapperFailureSeen = true;
        this._successfulWrapperCompletion = false;
        this._successfulWrapperCompletionAt = null;
        this._pushActivity(event);
        break;
      }
      case "wrapper-lock-acquired": {
        this._pushActivity({
          ...event,
          message: `Cron run starting (lock acquired, PID ${event.pid})`,
        });
        break;
      }
      case "wrapper-lock-released": {
        // Fires via run_daily.sh's bash EXIT trap, including after a
        // crash/kill - so by itself it's never proof of success. If worker +
        // wrapper evidence already proves a clean completion, this may be
        // the event that finally closes the run (e.g. if it arrived before
        // RUN-END for some reason). Otherwise, if a run is still marked
        // 'running' by the time this shows up, that's proof nothing else is
        // coming for it and it's genuinely abnormal - close it out rather
        // than leaving a permanent ghost. This only covers wrapper-invoked
        // runs (cron/RUN_ON_START); a run started directly via the
        // dashboard/API still relies on closeRunOnExit for that case.
        const closedSuccessfully = this._tryCloseFromSuccessfulProcessCompletion(
          event.ts,
        );

        if (!closedSuccessfully) {
          const stillRunning = this.stmts.findRunningRun.get();
          if (stillRunning) {
            this._closeRunningRun(stillRunning, "interrupted", event.ts);
          }
        }

        if (event.pid) {
          this._pushActivity({
            ...event,
            message: closedSuccessfully
              ? `Cron run finished successfully (lock released, PID ${event.pid})`
              : `Cron run finished (lock released, PID ${event.pid})`,
          });
        }
        break;
      }
      case "run-end": {
        this._pendingDelay = null;
        const running = this.stmts.findRunningRun.get();
        if (running) {
          // RUN-END only ever gets logged by the app itself, so we know the
          // process didn't crash or get signaled - use closeRunFull (not
          // closeRun) so exit_code/exit_signal stay consistent with the
          // other closing paths.
          this.stmts.closeRunFull.run(
            "done",
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
            0,
            null,
            running.id,
          );
          // RUN-END firing is proof the run is genuinely over - any account
          // still marked 'running' from it never got its own ACCOUNT-END or
          // ACCOUNT-ERROR (worker died silently), and would otherwise stay
          // stuck 'running' forever. Since this is a successfully completed
          // overall run, finalize those accounts as success while retaining
          // the diagnostic that their individual result was missing.
          for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
            this.stmts.markAccountCompletedWithoutResult.run(
              event.ts,
              "Run completed, but this account's own result was never logged (its worker likely failed silently).",
              row.email,
            );
          }
        } else {
          this.stmts.insertOrphanRunEnd.run(
            event.ts,
            event.ts,
            event.accountsProcessed,
            event.totalGained,
            event.oldTotal,
            event.newTotal,
            event.runtimeMin,
          );
        }
        this._resetCompletionEvidence();
        this._pushActivity(event);
        break;
      }
      case "login-number": {
        this._pushActivity({
          ...event,
          level: "warn",
          message: `Login approval needed for ${event.userName}: select number ${event.number}`,
        });
        break;
      }
      case "generic": {
        if (event.level === "warn" || event.level === "error") {
          this._pushActivity(event);
        } else {
          changed = false;
        }
        break;
      }
      default:
        changed = false;
    }

    return changed;
  }

  // Defers the stale-running-run check rather than running it inline: the
  // bot's own RUN-END normally follows within ~1s of the last account, so
  // firing immediately would race it and risk closing the run ourselves
  // right before the real RUN-END arrives, which would then find no
  // 'running' row and create a duplicate orphan instead of just updating
  // this one. Rescheduling on every account-end/error also means the timer
  // only ever fires AUTO_CLOSE_GRACE_MS after the LAST one in a batch.
  _scheduleAutoCloseCheck() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    this._autoCloseTimer = setTimeout(() => {
      this._autoCloseTimer = null;
      try {
        this._tryAutoCloseStaleRun();
      } catch {
        /* best-effort safety net - a miss here just leaves the row as-is */
      }
    }, AUTO_CLOSE_GRACE_MS);
    if (this._autoCloseTimer.unref) this._autoCloseTimer.unref();
  }

  // Shared terminal-state closer for any 'running' row being ended without
  // the bot's own authoritative RUN-END line (auto-close/crash/stop/
  // interrupt) - derives accountsProcessed/gained/totals from
  // account_history instead, and demotes any account this run left stuck at
  // 'running' to 'error', since nothing else is coming for it once the run
  // itself is closed.
  _closeRunningRun(running, status, endTs, { code = null, signal = null } = {}) {
    this._pendingDelay = null;
    const totals = this.stmts.sumHistorySince.get(running.startTs);
    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    const gained = totals.gained || 0;
    const newTotal = totals.points || 0;
    const oldTotal = newTotal - gained;
    const runtimeMin = Number(
      ((Date.parse(endTs) - Date.parse(running.startTs)) / 60000).toFixed(1),
    );

    this.stmts.closeRunFull.run(
      status,
      endTs,
      resolved.n || 0,
      gained,
      oldTotal,
      newTotal,
      runtimeMin,
      code,
      signal,
      running.id,
    );

    for (const row of this.stmts.orphanedRunningAccounts.all(running.startTs)) {
      this.stmts.markAccountInterrupted.run(
        endTs,
        `Run ${status} before this account finished`,
        row.email,
      );
    }

    this._resetCompletionEvidence();
  }

  // Safety net for the bot-side clustering bug where a worker's exit is
  // never observed by its primary, so 'activeWorkers' never reaches 0 and
  // RUN-END is never logged even though every account actually finished.
  // Once every account the run declared (total_accounts) has resolved
  // (ACCOUNT-END or ACCOUNT-ERROR) since it started, treat the run as done
  // and derive its totals from account_history instead of waiting forever.
  _tryAutoCloseStaleRun() {
    const running = this.stmts.findRunningRun.get();
    if (!running || !running.totalAccounts) return;

    const resolved = this.stmts.accountsResolvedSince.get(running.startTs);
    if (!resolved || resolved.n < running.totalAccounts) return;

    this._closeRunningRun(running, "done", resolved.lastTs || new Date().toISOString());
  }

  closeRunOnExit(exit) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    const code = exit?.code ?? null;
    const signal = exit?.signal ?? null;

    // A clean exit (code 0, no signal) almost always means the app already
    // logged its own RUN-END line, which the "run-end" event handler above
    // closes with the real accounts/points data. Racing ahead here would
    // stamp this row 'done' with everything NULL, then force run-end into
    // creating a second, orphaned row once it can't find this one anymore -
    // exactly the empty "Done -/N" duplicates this was producing. Only step
    // in for crashes/kills, where no RUN-END line is ever coming.
    if (!signal && code === 0) return false;

    // This path comes from the Control API directly observing its own child
    // process exit, so (unlike the "interrupted" paths above) we have real
    // evidence here: a signal means something intentionally stopped it
    // (stopped), while a bare non-zero code with no signal means the app
    // exited on its own with a failure (crashed).
    const status = signal ? "stopped" : "crashed";
    this._closeRunningRun(
      running,
      status,
      exit?.at || new Date().toISOString(),
      { code, signal },
    );
    return true;
  }

  // Called when the dashboard detects the Control API/container itself
  // restarted mid-poll (health.uptimeSec went backwards) - a much faster and
  // more direct signal than waiting for a new RUN-START to eventually prove
  // the old row is stale. Covers container recreation for any reason
  // (image update, manual restart, OOM kill, host reboot), which is why the
  // result is "interrupted" rather than "crashed": we only know the backend
  // vanished, not why.
  //
  // notStartedAfter guards a race with the SSE log stream, which can notice
  // the same disconnect on its own and reconnect - possibly processing a
  // brand new RUN-START - before this poll-driven check runs. Only close a
  // row that was already 'running' as of the last known-good health check;
  // never one that could be that legitimate new run.
  markInterruptedByBackendRestart(at = new Date().toISOString(), { notStartedAfter = null } = {}) {
    const running = this.stmts.findRunningRun.get();
    if (!running) return false;
    if (notStartedAfter && running.startTs >= notStartedAfter) return false;
    this._closeRunningRun(running, "interrupted", at);
    return true;
  }

  // schedule
  getSchedule() {
    const raw = this._readMeta("schedule");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  setSchedule(config) {
    this._writeMeta("schedule", JSON.stringify(config));
    return config;
  }

  snapshotAccounts() {
    return this.stmts.allAccounts.all();
  }

  /**
   * Persist the live per-source points the bot reports for the current run.
   * @param accounts status.run.accounts[] - each may carry live.bySource
   * @param at       Date the sample was taken (only the fallback day bucket)
   * @param runId    本轮身份；默认取面板正在跑的那条 runs 行
   * @returns number of rows written
   */
  recordLivePoints(accounts, at = new Date(), runId = this.activeRunId()) {
    if (!Array.isArray(accounts) || !accounts.length) return 0;
    // 没有进行中的轮次 = 这份 run.accounts 是 /status 缓存的上一轮，已经记过账了
    if (!runId) return 0;
    const stamp = at.toISOString();
    let written = 0;
    for (const account of accounts) {
      const email = account?.email;
      const bySource = account?.live?.bySource;
      if (!email || !bySource || typeof bySource !== "object") continue;
      // 按 bot 自己的观测时间归日，不能按轮询的挂钟：轮询会长期拿到同一份缓存快照，
      // 若用 new Date()，跨过北京零点后就会把昨天那一轮再记成"今天"。
      const observed = parseIsoTs(account.live.lastUpdateTs) ?? at;
      const day = beijingDay(observed);
      for (const [source, raw] of Object.entries(bySource)) {
        const points = Number(raw);
        if (!Number.isFinite(points) || points <= 0) continue;
        this.stmts.upsertRunPoint.run(email, String(runId), day, String(source), Math.round(points), stamp);
        this.stmts.rebuildDailyPoint.run(email, day, String(source));
        written++;
      }
    }
    return written;
  }

  /**
   * Daily per-source totals, newest day first, for the app's account detail.
   * @returns { [email]: [{ day, total, sources: { search: 30, ... } }] }
   */
  dailyPointsByAccount({ days = 30 } = {}) {
    const since = new Date(Date.now() - days * 86400000).toLocaleDateString("en-CA", {
      timeZone: "Asia/Shanghai",
    });
    const grouped = {};
    for (const row of this.stmts.dailyPointsSince.all(since)) {
      const perDay = (grouped[row.email] ??= {});
      const entry = (perDay[row.day] ??= { day: row.day, total: 0, sources: {} });
      entry.sources[row.source] = row.points;
      entry.total += row.points;
    }
    const out = {};
    for (const [email, perDay] of Object.entries(grouped)) {
      out[email] = Object.values(perDay).sort((a, b) => (a.day < b.day ? 1 : -1));
    }
    return out;
  }

  /**
   * 决定一行进度日志该记到哪个邮箱名下。顺序：
   * 1. 事件自带 email（ACCOUNT-* 那几类）；
   * 2. [user] 位直接就是邮箱（新版 bot 打的是完整邮箱）；
   * 3. 前缀唯一对应"正在跑"的那个账号；
   * 4. 前缀在 accounts 里只匹配到一个邮箱；
   * 5. 以上都不满足就返回 null —— 宁可这条不记账，也不要把它塞给同前缀的另一个账号。
   * 第 3、4 步都要求"唯一"，所以开多 cluster 并行跑同前缀账号时会选择丢弃。
   */
  _checkinEmail(event) {
    if (event.email) return event.email;
    const name = String(event.userName || "").trim();
    if (!name) return null;
    if (name.includes("@")) return name.toLowerCase();
    const running = this.stmts.runningEmailsByUserName.all(name);
    if (running.length === 1) return running[0].email;
    const all = this.stmts.emailsByUserName.all(name);
    return all.length === 1 ? all[0].email : null;
  }

  /**
   * 按 CHECKIN_RULES 把一行日志里的进度摘进 checkin_progress。
   * 这类行大多只带 userName（DESKTOP/MOBILE 会话的账号名），邮箱要靠 _checkinEmail 反查。
   * @returns 写入了几条（同一行命中多条规则时可能 >1）
   */
  _captureCheckins(event) {
    if (!event || typeof event.title !== "string") return 0;
    const msg = String(event.message || "");
    if (!msg) return 0;
    let email = null; // 懒查：多数日志行一条规则都不命中，别白白查库
    let written = 0;
    for (const rule of CHECKIN_RULES) {
      if (rule.title !== event.title) continue;
      let result = null;
      try {
        result = rule.parse(msg);
      } catch {
        continue; // 规则解析失败不能把整行 ingest 带崩
      }
      // 一行可能带好几种进度（CHECKIN-PROGRESS），规则返回数组或单个对象
      const entries = Array.isArray(result) ? result : result ? [result] : [];
      for (const parsed of entries) {
        const { kind, days, daysMax, status } = parsed || {};
        if (!kind || !Number.isFinite(days) || !Number.isFinite(daysMax) || daysMax <= 0 || days > daysMax) {
          continue;
        }
        email ??= this._checkinEmail(event);
        if (!email) continue;
        this.stmts.upsertCheckinProgress.run(
          email,
          kind,
          Math.round(days),
          Math.round(daysMax),
          status || "progress",
          event.ts,
          event.userName || null,
        );
        written++;
      }
    }
    return written;
  }

  /**
   * 每个账号的打卡情况：跨天连续型活动（默认搜索引擎 x/y 天）+ 各分类的连续得分天数。
   * 连续天数从 daily_points 往前倒推；今天还没跑不算断，另外用 todayDone 标出来。
   * @returns { [email]: { today, tasks: { search: {streak, todayDone}, ... }, checkins: { 'default-search': {...} } } }
   */
  checkinSummary({ days = 90 } = {}) {
    const today = beijingDay();
    const since = prevDay(today, Math.max(1, Math.min(3650, Number(days) || 90)));
    const seen = {}; // email -> source -> Set(day)
    for (const row of this.stmts.dailyPointsSince.all(since)) {
      const bySource = (seen[row.email] ??= {});
      (bySource[row.source] ??= new Set()).add(row.day);
    }
    const checkins = {};
    for (const row of this.stmts.allCheckinProgress.all()) {
      // 带 day/today 是为了让界面分得清"今天已经推过"和"这条还是昨天那轮的数"
      const at = parseIsoTs(row.ts);
      const day = at ? beijingDay(at) : "";
      (checkins[row.email] ??= {})[row.kind] = {
        days: row.days,
        daysMax: row.days_max,
        status: row.status,
        ts: row.ts,
        day,
        today: day === today,
      };
    }
    const streakOf = (set) => {
      if (!set || !set.size) return { streak: 0, todayDone: false };
      const todayDone = set.has(today);
      let cursor = todayDone ? today : prevDay(today);
      let streak = 0;
      while (set.has(cursor)) {
        streak++;
        cursor = prevDay(cursor);
      }
      return { streak, todayDone };
    };

    const out = {};
    for (const [email, bySource] of Object.entries(seen)) {
      const tasks = {};
      for (const [source, set] of Object.entries(bySource)) tasks[source] = streakOf(set);
      out[email] = { today, tasks, checkins: checkins[email] ?? {} };
    }
    // 只有打卡进度、还没有积分记录的账号也要出现在结果里
    for (const [email, c] of Object.entries(checkins)) {
      out[email] ??= { today, tasks: {}, checkins: {} };
      out[email].checkins = c;
    }
    return out;
  }

  snapshotRuns(limit = 30) {
    return this.stmts.recentRuns.all(limit);
  }
  allAccountHistories({ since = null } = {}) {
    const rows = since
      ? this.stmts.allHistoriesSince.all(since)
      : this.stmts.allHistories.all();
    const byEmail = {};
    for (const row of rows) {
      if (!byEmail[row.email]) byEmail[row.email] = [];
      byEmail[row.email].push({
        ts: row.ts,
        points: row.points,
        gained: row.gained,
        durationSec: row.durationSec,
      });
    }
    return byEmail;
  }

  snapshotActivity(limit = 100) {
    return this.stmts.recentActivity.all(limit);
  }

  accountHistory(email) {
    return this.stmts.historyForEmail.all(email);
  }

  // Purges everything the dashboard has ever recorded for an account it no
  // longer tracks (e.g. removed from the bot's .env) - the accounts row
  // itself plus its point history and activity log entries - so it stops
  // showing up anywhere (accounts list, overview, history charts).
  deleteAccount(email) {
    this.db.exec("BEGIN");
    try {
      this.stmts.deleteAccountRow.run(email);
      this.stmts.deleteAccountHistory.run(email);
      this.stmts.deleteAccountActivity.run(email);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  saveNow() {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  close() {
    if (this._autoCloseTimer) clearTimeout(this._autoCloseTimer);
    if (this._zeroStartWatchdog) clearInterval(this._zeroStartWatchdog);
    this.saveNow();
    this.db.close();
  }
}

module.exports = { Store };