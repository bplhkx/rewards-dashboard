"use strict";

// Docker prepends an RFC3339Nano timestamp (because we request timestamps=1),
// e.g: "2026-07-01T12:03:12.123456789Z <rest of line>"
const DOCKER_TS_RE = /^(\S+)\s([\s\S]*)$/;

// App log format (src/logging/Logger.ts):
// [localTime] [userName] [LEVEL] PLATFORM [TITLE] message
const APP_LINE_RE =
  /^\[([^\]]+)\]\s\[([^\]]+)\]\s\[([^\]]+)\]\s(\S+)\s\[([^\]]+)\]\s([\s\S]*)$/;

const ACCOUNT_START_RE = /^Starting account:\s(\S+)\s\|\sgeoLocale:\s(.*)$/;
const ACCOUNT_END_RE =
  /^Completed account:\s(\S+)\s\|\spointsGained=(-?\d+)\s\|\spreviousBalance=(\d+)\s\|\scurrentBalance=(\d+)\s\|\sdurationSeconds=([\d.]+)$/;
const ACCOUNT_ERR_RE = /^(\S+@\S+):\s([\s\S]*)$/;

// src/index.ts's per-account flow wrapper (Mobile.ts / Desktop.ts) logs this
// under title FLOW at ERROR level when an account's automation throws -
// e.g. a login timeout - but does NOT also log a titled ACCOUNT-ERROR line
// for it. That means an account that dies this way looks, to everything
// keyed off the ACCOUNT-ERROR title (account resolution counts, the
// dashboard's own "is this account still running" check), exactly like a
// worker that's still silently in progress - it never leaves 'running'.
// Observed in production for both the mobile and desktop flow wrappers, so
// this is treated as an equally authoritative account-level failure signal.
const FLOW_FAILED_RE =
  /^(?:Mobile|Desktop) flow failed for\s(\S+@\S+):\s([\s\S]*)$/;
const RUN_START_RE =
  /^Starting Microsoft Rewards Script\s\|\sv([\w.\-]+)\s\|\sAccounts:\s(\d+)\s\|\sClusters:\s(\d+)$/;
const RUN_END_RE =
  /^Completed all accounts\s\|\saccountsProcessed=(\d+)\s\|\spointsGained=(-?\d+)\s\|\spreviousBalance=(\d+)\s\|\scurrentBalance=(\d+)\s\|\sruntimeMinutes=([\d.]+)$/;
// src/index.ts's waitBeforeNextAccount() - with accountDelay, accounts start
// one at a time now rather than together, so this wait can be a large
// fraction of the run's total time.
const ACCOUNT_DELAY_RE =
  /^Waiting\s([\d.]+)\sseconds before starting the next account(?:\s\((\S+@\S+)\))?$/;
const STREAK_PROTECTION_RE =
  /^Snapshot complete\s\|\soffers=(\d+)\s\|\sreportable=(\d+)\s\|\sstreaks=(\d+)\s\|\sstreakProtectionEnabled=(true|false)\s\|\sstreakProtectionRemainingDays=(\d+|null)\s\|\sstreakCounter=(\d+|null)\s\|\slevel=([^|]+)\s\|\saccount=(\S+@\S+)$/;

// src/browser/auth/methods/PasswordlessLogin.ts - the only login flow that
// logs an actual value a human needs to act on before the bot can proceed
// (TOTP-with-secret is auto-filled and deliberately never logged; manual
// TOTP/email code entry waits on a raw stdin prompt with no code the bot
// itself knows, so there's nothing to surface for those).
const LOGIN_NUMBER_RE = /^Please approve login and select number:\s*(\d+)$/;
const LOGIN_NUMBER_RESOLVED_RE =
  /^(Approval detected|Login approved successfully|Login approval failed or timed out|Approval timeout after \d+ seconds!)$/;

// scripts/docker/run_daily.sh wraps the actual `npm start` in a flock-style
// lockfile and echoes its own lifecycle lines directly to stdout (not
// through Logger.ts), format: "[<bash date>] [run_daily.sh] <message>".
// `release_lock` runs via `trap ... EXIT INT TERM`, so "Lock released" fires
// even if npm start crashes outright - making this a much more reliable
// "is a run currently in progress" signal than the app's own RUN-START/
// RUN-END, which a hard crash could skip entirely.
const WRAPPER_LINE_RE = /^\[[^\]]*\]\s\[run_daily\.sh\]\s([\s\S]*)$/;
const WRAPPER_LOCK_ACQUIRED_RE =
  /^Lock acquired successfully\s\(PID:\s*(\d+)\)$/;
const WRAPPER_LOCK_RELEASED_RE = /^Lock released\s\(PID:\s*(\d+)\)$/;
// "Script finished" is printed right before the wrapper's natural exit
// (which is what triggers the EXIT trap that logs "Lock released"). Kept as
// its own event kind (see store.js) rather than folded into "Lock released",
// because "Lock released" fires from the EXIT trap even after a crash/kill,
// so it can't be trusted as completion evidence by itself either.
const WRAPPER_SCRIPT_FINISHED_RE = /^Script finished$/;
// Explicit successful completion signal from the API-triggered execution
// path. Distinguished from WRAPPER_SCRIPT_FINISHED_RE because "Script
// finished" alone is weaker evidence - some wrapper versions print it
// unconditionally on the way out, including right after a failure.
const WRAPPER_SCRIPT_COMPLETED_RE =
  /^Script completed successfully(?:\s*\(via API\))?\.?$/;
// Mirrors WRAPPER_SCRIPT_COMPLETED_RE's optional "(via API)" qualifier -
// observed in production as "ERROR: Script failed (via API)!" when the run
// was invoked through the Control API, vs. the bare form for a cron-invoked
// run.
const WRAPPER_SCRIPT_FAILED_RE = /^ERROR: Script failed(?:\s*\(via API\))?!$/;

// Cluster worker lifecycle, e.g.:
// [MAIN] [WARN] MAIN [CLUSTER-WORKER-EXIT] Worker 34781 exit | Code: 0 | Signal: n/a | Active workers: 0
//
// Parsed as a structured event (rather than left as "generic") because the
// store uses Code + Signal + Active workers as one of its signals for
// whether the whole clustered process completed cleanly, as a fallback for
// when RUN-END itself never gets logged.
const CLUSTER_WORKER_EXIT_RE =
  /^Worker\s+(\d+)\s+exit\s+\|\s+Code:\s*(-?\d+|n\/a)\s+\|\s+Signal:\s*([^|]+)\s+\|\s+Active workers:\s*(\d+)$/;

// ── 部署侧修正（V4-china 中文日志）────────────────────────────────
// 本面板所有事件正则都锚定上游英文日志原文，而 chiihero/Microsoft-Rewards-Script
// 的 V4-china 分支把 Logger 的消息正文翻译成了中文（src/index.ts:285/388/541/553/593/641/677、
// src/browser/ReactFunc.ts:95、src/browser/auth/methods/PasswordlessLogin.ts:77/102/130/153）。
// 结果：ACCOUNT-END / RUN-END 等永不匹配 → runs 与 account_history 一直是空表。
// 这里把中文消息规范化回英文原形，下游逻辑与存储完全不动。
const ZH_MESSAGE_RULES = [
  // 运行开始：启动微软奖励脚本 | v4.3.2.4 | 账户数: 1 | 集群数: 1
  [/^启动微软奖励脚本/, "Starting Microsoft Rewards Script"],
  [/账户数:\s*/g, "Accounts: "],
  [/集群数:\s*/g, "Clusters: "],
  // 运行结束：全部账户完成 | 处理账户数=1 | 获得积分=30 | 原余额=37 | 现余额=67 | 运行分钟数=12.3
  [/^全部账户完成/, "Completed all accounts"],
  [/处理账户数=/g, "accountsProcessed="],
  [/获得积分=/g, "pointsGained="],
  [/原余额=/g, "previousBalance="],
  [/现余额=/g, "currentBalance="],
  [/运行分钟数=/g, "runtimeMinutes="],
  [/持续秒数=/g, "durationSeconds="],
  // 账户开始/结束
  [/^开始处理账户:/, "Starting account:"],
  [/^账户完成:/, "Completed account:"],
  // 账户级流程失败（fork 只有移动端这一条，桌面端走同一条 Main 流程）
  [/^(\S+@\S+)\s的移动端流程失败:/, "Mobile flow failed for $1:"],
  [/^(\S+@\S+)\s的桌面端流程失败:/, "Desktop flow failed for $1:"],
  // 账户间等待：等待 12.0 秒后开始下一个账户 (a@b.com)
  [/^等待\s/, "Waiting "],
  [/\s秒后开始下一个账户/, " seconds before starting the next account"],
  // 连击保护快照
  [/^快照完成/, "Snapshot complete"],
  [/可上报=/g, "reportable="],
  [/连续保护已启用=/g, "streakProtectionEnabled="],
  [/连续保护剩余天数=/g, "streakProtectionRemainingDays="],
  [/连续计数=/g, "streakCounter="],
  [/等级=/g, "level="],
  [/账户=/g, "account="],
  // 无密码登录：待人工批准的数字与批准结果
  [/^请批准登录并选择数字:/, "Please approve login and select number:"],
  [/^检测到批准$/, "Approval detected"],
  [/^登录批准成功$/, "Login approved successfully"],
  [/^(\d+)\s秒后批准超时!$/, "Approval timeout after $1 seconds!"],
];

function normalizeChineseMessage(message) {
  if (typeof message !== "string" || !message) return message;
  // 只有含中文的消息才走规范化，英文上游日志零开销直通
  if (!/[\u4e00-\u9fff]/.test(message)) return message;
  let out = message;
  for (const [re, to] of ZH_MESSAGE_RULES) out = out.replace(re, to);
  return out;
}

/**
 * Strips the leading Docker timestamp, returns { dockerTs, rest }.
 */
function splitDockerTimestamp(rawLine) {
  const m = DOCKER_TS_RE.exec(rawLine);
  if (!m) return { dockerTs: null, rest: rawLine };
  return { dockerTs: m[1], rest: m[2] };
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Parses one raw docker-log line into a structured event, or null if it
 * doesn't match the app's log format at all (defensive - unrelated stdout).
 */
function parseLine(rawLine) {
  const { dockerTs, rest } = splitDockerTimestamp(rawLine);
  if (!dockerTs) return null;

  const clean = rest.replace(ANSI_RE, "");
  const m = APP_LINE_RE.exec(clean);
  if (!m) {
    return parseWrapperLine(dockerTs, clean);
  }

  const [, appTime, userName, level, platform, title, rawMessage] = m;
  // 匹配用规范化后的英文原形；activity 表里仍存原始中文，便于人工回看
  const message = normalizeChineseMessage(rawMessage);

  const base = {
    ts: dockerTs,
    appTime,
    userName,
    level: level.toLowerCase(),
    platform,
    title,
    message: rawMessage,
    raw: clean,
  };

  switch (title) {
    case "ACCOUNT-START": {
      const am = ACCOUNT_START_RE.exec(message);
      if (am)
        return {
          ...base,
          kind: "account-start",
          email: am[1],
          geoLocale: am[2],
        };
      break;
    }
    case "ACCOUNT-END": {
      const am = ACCOUNT_END_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "account-end",
          email: am[1],
          gained: Number(am[2]),
          oldPoints: Number(am[3]),
          newPoints: Number(am[4]),
          durationSec: Number(am[5]),
        };
      }
      break;
    }
    case "ACCOUNT-ERROR": {
      const am = ACCOUNT_ERR_RE.exec(message);
      if (am)
        return { ...base, kind: "account-error", email: am[1], error: am[2] };
      return { ...base, kind: "account-error", email: null, error: message };
    }
    case "RUN-START": {
      const am = RUN_START_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "run-start",
          version: am[1],
          totalAccounts: Number(am[2]),
          clusters: Number(am[3]),
        };
      }
      break;
    }
    case "RUN-END": {
      const am = RUN_END_RE.exec(message);
      if (am) {
        return {
          ...base,
          kind: "run-end",
          accountsProcessed: Number(am[1]),
          totalGained: Number(am[2]),
          oldTotal: Number(am[3]),
          newTotal: Number(am[4]),
          runtimeMin: Number(am[5]),
        };
      }
      break;
    }
    case "ACCOUNT-DELAY": {
      const am = ACCOUNT_DELAY_RE.exec(message);
      if (am)
        return {
          ...base,
          kind: "account-delay",
          seconds: Number(am[1]),
          nextEmail: am[2] || null,
        };
      break;
    }
    case "REACT-PARSE": {
      const protection = STREAK_PROTECTION_RE.exec(message);
      if (protection) {
        return {
          ...base,
          kind: "streak-protection",
          email: protection[8],
          enabled: protection[4] === "true",
          remainingDays:
            protection[5] === "null" ? null : Number(protection[5]),
          streakCounter:
            protection[6] === "null" ? null : Number(protection[6]),
        };
      }
      break;
    }
    case "LOGIN-PASSWORDLESS": {
      const numMatch = LOGIN_NUMBER_RE.exec(message);
      if (numMatch)
        return { ...base, kind: "login-number", number: numMatch[1] };
      if (LOGIN_NUMBER_RESOLVED_RE.test(message)) {
        return { ...base, kind: "login-number-resolved" };
      }
      break;
    }
    case "FLOW": {
      // Reuses the existing "account-error" event kind (not a new kind) so
      // the store's resolution-counting and orphan-cleanup logic - all of
      // which is keyed off title === 'ACCOUNT-ERROR', not "kind" - picks
      // this up for free with no store.js changes needed. The original
      // "FLOW" title/message are still fully recoverable from `raw`.
      if (level.toLowerCase() === "error") {
        const fm = FLOW_FAILED_RE.exec(message);
        if (fm) {
          return {
            ...base,
            title: "ACCOUNT-ERROR",
            kind: "account-error",
            email: fm[1],
            error: fm[2],
          };
        }
      }
      break;
    }
    case "CLUSTER-WORKER-EXIT": {
      const wm = CLUSTER_WORKER_EXIT_RE.exec(message);
      if (wm) {
        const code = wm[2].toLowerCase() === "n/a" ? null : Number(wm[2]);
        const rawSignal = wm[3].trim();
        const signal =
          !rawSignal || rawSignal.toLowerCase() === "n/a"
            ? null
            : rawSignal;
        return {
          ...base,
          kind: "cluster-worker-exit",
          pid: Number(wm[1]),
          code,
          signal,
          activeWorkers: Number(wm[4]),
        };
      }
      break;
    }
    default:
      break;
  }

  // Fall through: no specific structured match, but still a valid app log
  // line. Kept as a generic event so warnings/errors show up in the feed.
  return { ...base, kind: "generic" };
}

/**
 * Parses a run_daily.sh wrapper line (not part of Logger.ts's format).
 * Returns null for lines that don't match at all, or a 'generic' event for
 * wrapper lines that aren't one of the specific lifecycle events we track.
 */
function parseWrapperLine(dockerTs, clean) {
  const wm = WRAPPER_LINE_RE.exec(clean);
  if (!wm) return null;
  const message = wm[1];

  const base = {
    ts: dockerTs,
    userName: "run_daily.sh",
    level: "info",
    platform: "MAIN",
    title: "WRAPPER",
    message,
    raw: clean,
  };

  const acquired = WRAPPER_LOCK_ACQUIRED_RE.exec(message);
  if (acquired)
    return { ...base, kind: "wrapper-lock-acquired", pid: acquired[1] };

  const released = WRAPPER_LOCK_RELEASED_RE.exec(message);
  if (released)
    return { ...base, kind: "wrapper-lock-released", pid: released[1] };

  if (WRAPPER_SCRIPT_COMPLETED_RE.test(message)) {
    return { ...base, kind: "wrapper-script-completed" };
  }

  if (WRAPPER_SCRIPT_FINISHED_RE.test(message)) {
    return { ...base, kind: "wrapper-script-finished" };
  }

  if (WRAPPER_SCRIPT_FAILED_RE.test(message)) {
    return { ...base, level: "error", kind: "wrapper-script-failed" };
  }

  // Other wrapper lines (self-heal messages, "Starting script...", etc.)
  // aren't needed for run-tracking; ignore rather than adding feed noise.
  return null;
}

module.exports = { parseLine };
