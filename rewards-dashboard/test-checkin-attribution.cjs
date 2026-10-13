// checkin_progress 的归属回归测试：同前缀的多域账号（bplhkd@outlook / bplhkd@gmail）
// 不能把打卡进度记到同一个邮箱上。跑法：node test-checkin-attribution.cjs
const fs = require("fs");
const path = require("path");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-attr-"));
process.env.DATA_DIR = dir;
const { Store } = require(path.join(__dirname, "lib", "store.js"));

const store = new Store();
let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  :: " + extra : ""}`);
  if (!cond) fails++;
};

let seq = 0;
const ts = () => new Date(Date.parse("2026-10-13T10:00:00Z") + ++seq * 1000).toISOString();
const start = (email) => ({
  ts: ts(),
  kind: "account-start",
  title: "ACCOUNT-START",
  level: "info",
  userName: email.split("@")[0],
  email,
  message: `Starting account: ${email} | geoLocale: CN | locale: zh-CN`,
});
const end = (email) => ({
  ts: ts(),
  kind: "account-end",
  title: "ACCOUNT-END",
  level: "info",
  userName: email.split("@")[0],
  email,
  // account-end 会写 account_history（STRICT 表），这几个数值必须给，
  // 传 undefined 直接 ERR_INVALID_ARG_TYPE
  gained: 10,
  newPoints: 11,
  durationSec: 60,
  message: `Completed account: ${email} | pointsGained=10 | previousBalance=1 | currentBalance=11 | durationSeconds=60`,
});
const progress = (user, msg) => ({
  ts: ts(),
  kind: "generic",
  title: "CHECKIN-PROGRESS",
  level: "info",
  userName: user,
  message: msg,
});

// checkinSummary() 直接返回 email -> { today, tasks, checkins:{kind:{...}} }
const kindsOf = (email) => store.checkinSummary({ days: 30 })[email]?.checkins || {};

// —— 两个账号共用前缀 bplhkd，串行跑 ——
store.apply(start("bplhkd@outlook.com"));
store.apply(progress("bplhkd", "dailyset=2/7 | dse=2/14"));
store.apply(end("bplhkd@outlook.com"));

store.apply(start("bplhkd@gmail.com"));
store.apply(progress("bplhkd", "dailyset=5/7 | dse=9/14"));
store.apply(end("bplhkd@gmail.com"));

const a = kindsOf("bplhkd@outlook.com");
const b = kindsOf("bplhkd@gmail.com");
ok(a.dailyset?.days === 2 && a["default-search"]?.days === 2, "账号1 拿到自己的 2/7 与 2/14", JSON.stringify({ d: a.dailyset?.days, s: a["default-search"]?.days }));
ok(b.dailyset?.days === 5 && b["default-search"]?.days === 9, "账号2 拿到自己的 5/7 与 9/14（旧实现这里会是空的）", JSON.stringify({ d: b.dailyset?.days, s: b["default-search"]?.days }));

// —— 没有账号在跑、且前缀撞车：宁可丢弃，也不要塞给同前缀的另一个账号 ——
const before = JSON.stringify(kindsOf("bplhkd@outlook.com"));
store.apply(progress("bplhkd", "dailyset=7/7 | dse=14/14"));
ok(JSON.stringify(kindsOf("bplhkd@outlook.com")) === before, "撞车且无人运行时不写入（不猜归属）");

// —— 前缀唯一时，空闲也能记账（老配置不受影响）——
store.apply(start("solo@outlook.com"));
store.apply(end("solo@outlook.com"));
store.apply(progress("solo", "dailyset=3/7"));
ok(kindsOf("solo@outlook.com").dailyset?.days === 3, "前缀唯一时按唯一匹配入账");

// —— 新版 bot 把邮箱直接放在 [user] 位 ——
store.apply(progress("bplhkd@outlook.com", "dailyset=6/7"));
ok(kindsOf("bplhkd@outlook.com").dailyset?.days === 6, "[user] 就是邮箱时直接入账");

// —— 归属只认 ts 最新的那条：晚到的行覆盖先到的（upsert 的 WHERE 是 ts 比较）——
store.apply(progress("bplhkd@outlook.com", "dailyset=1/7"));
ok(kindsOf("bplhkd@outlook.com").dailyset?.days === 1, "同一 kind 以最新 ts 为准");

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
