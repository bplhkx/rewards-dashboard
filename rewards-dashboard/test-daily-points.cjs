// daily_points 的回归测试：建表、MAX 幂等（重复采样、bot 重启后的小值都不能污染当天）、
// 北京日界（UTC 16:30 要落到次日）、脏数据不炸。跑法：node test-daily-points.cjs
// 用系统临时目录当 DATA_DIR，不碰 data/dashboard.sqlite。
const fs = require("fs");
const path = require("path");
const os = require("os");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-daily-"));
process.env.DATA_DIR = dir;
const { Store } = require(path.join(__dirname, "lib", "store.js"));

const store = new Store();
let fails = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  :: " + extra : ""}`);
  if (!cond) fails++;
};

const accounts = [
  { email: "a@outlook.com", live: { bySource: { search: 30, read: 30, checkIn: 15 } } },
  { email: "b@gmail.com", live: { bySource: { urlReward: 100, search: 21 } } },
];

const n1 = store.recordLivePoints(accounts, new Date("2026-10-11T01:00:00Z"));
ok(n1 === 5, "首次写入 5 行", String(n1));
let dp = store.dailyPointsByAccount({ days: 30 });
ok(dp["a@outlook.com"][0].total === 75, "账号 a 合计 75", JSON.stringify(dp["a@outlook.com"][0]));
ok(dp["a@outlook.com"][0].day === "2026-10-11", "北京日 = 10-11（UTC 01:00 已是北京 09:00）");

store.recordLivePoints(accounts, new Date("2026-10-11T01:05:00Z"));
dp = store.dailyPointsByAccount({ days: 30 });
ok(dp["a@outlook.com"][0].total === 75, "SSE + 轮询重复采样不翻倍", String(dp["a@outlook.com"][0].total));

// 必须显式给时间戳：不传 at 时 recordLivePoints 用真实"今天"，
// 这个测试就会随挂钟跨天而漂移失败（10-12 之后写成 10-12 的行，10-11 的断言永远碰不到）。
store.recordLivePoints([{ email: "a@outlook.com", live: { bySource: { search: 3 } } }], new Date("2026-10-11T01:10:00Z"));
dp = store.dailyPointsByAccount({ days: 30 });
ok(dp["a@outlook.com"].find((x) => x.day === "2026-10-11").sources.search === 30, "bot 重启后的小值不覆盖当天已记分");

store.recordLivePoints(
  [{ email: "a@outlook.com", live: { bySource: { search: 30, read: 30, checkIn: 15, urlReward: 100 } } }],
  new Date("2026-10-11T01:15:00Z")
);
dp = store.dailyPointsByAccount({ days: 30 });
ok(dp["a@outlook.com"].find((x) => x.day === "2026-10-11").total === 175, "同轮新增分类累加进当天");

store.recordLivePoints([{ email: "a@outlook.com", live: { bySource: { search: 60 } } }], new Date("2026-10-11T16:30:00Z"));
dp = store.dailyPointsByAccount({ days: 30 });
ok(dp["a@outlook.com"][0].day === "2026-10-12", "零点后落到新的一天", dp["a@outlook.com"].map((x) => x.day).join(","));
ok(dp["a@outlook.com"].length === 2, "前一天记录保留（历史不清）");

ok(store.recordLivePoints(undefined) === 0, "accounts 非数组时安全返回 0");
ok(store.recordLivePoints([{ email: null }, { live: {} }, {}]) === 0, "缺字段时安全跳过");

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
