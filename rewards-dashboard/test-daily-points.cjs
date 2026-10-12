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

// recordLivePoints 只在"面板有进行中的轮次"时记账（空闲时 /status 还缓存着上一轮，
// 再记一遍就是把同一轮算两次），所以测试要先开一轮。
const openRun = (id) => {
  store.db.prepare("UPDATE runs SET status = 'done' WHERE status = 'running'").run();
  store.db.prepare("INSERT OR REPLACE INTO runs (id, status) VALUES (?, 'running')").run(id);
};
openRun("run-1");

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

// 幻影日回归：一轮跑完后 Control API 的 /status 会长期缓存同一份 run.accounts
// （live.bySource + 那一轮自己的 lastUpdateTs）。归日必须跟着观测时间走，
// 否则跨过北京零点后的每次轮询都会把昨天整轮再记成"今天"。
const cached = [
  { email: "c@outlook.com", live: { bySource: { urlReward: 30 }, lastUpdateTs: "2026-10-11T13:00:00Z" } },
];
ok(store.recordLivePoints(cached, new Date("2026-10-11T13:00:00Z")) === 1, "带 lastUpdateTs 的快照正常写入");
store.recordLivePoints(cached, new Date("2026-10-12T01:00:00Z"));
store.recordLivePoints(cached, new Date("2026-10-12T16:30:00Z")); // 北京 10-13 00:30 的轮询
dp = store.dailyPointsByAccount({ days: 30 });
const cd = dp["c@outlook.com"] || [];
ok(
  cd.length === 1 && cd[0].day === "2026-10-11" && cd[0].total === 30,
  "缓存快照跨零点重轮询不会多出幻影日",
  cd.map((x) => `${x.day}:${x.total}`).join(",")
);

store.recordLivePoints(
  [{ email: "d@outlook.com", live: { bySource: { search: 9 }, lastUpdateTs: "不是时间" } }],
  new Date("2026-10-11T02:00:00Z")
);
dp = store.dailyPointsByAccount({ days: 30 });
ok(dp["d@outlook.com"][0].day === "2026-10-11", "lastUpdateTs 非法时退回轮询时间");

ok(store.recordLivePoints(undefined) === 0, "accounts 非数组时安全返回 0");
ok(store.recordLivePoints([{ email: null }, { live: {} }, {}]) === 0, "缺字段时安全跳过");

// ---- 一天跑两轮：第二轮必须加进来，不能被第一轮的大值吞掉 ----
// 这就是实机上 10-12 的"今日"比机器人自己记的少 101 分的原因：
// 以前 (账号,天,分类) 只存一个 MAX，第二轮的小值直接被第一轮盖掉。
const F = "f@outlook.com";
const todayIso = new Date().toISOString();
const liveF = (v) => [{ email: F, live: { bySource: { search: v }, lastUpdateTs: todayIso } }];
store.recordLivePoints(liveF(60));
openRun("run-2");
store.recordLivePoints(liveF(30));
store.recordLivePoints(liveF(30)); // 同一轮被 SSE + 轮询重复采样
let fdp = store.dailyPointsByAccount({ days: 5 })[F];
ok(fdp[0].sources.search === 90, "两轮相加、同轮重复采样不重复计", JSON.stringify(fdp[0].sources));
store.db.prepare("UPDATE runs SET status = 'done' WHERE id = 'run-2'").run();
ok(store.recordLivePoints(liveF(30)) === 0, "没有进行中的轮次时不记账（缓存快照不算第二轮）");
fdp = store.dailyPointsByAccount({ days: 5 })[F];
ok(fdp[0].sources.search === 90, "空闲期轮询没有改动当天合计");
// 账本重算出来的聚合值必须和逐轮相加一致
const ledger = store.db
  .prepare("SELECT COALESCE(SUM(points), 0) s FROM run_points WHERE email = ? AND day = ? AND source = 'search'")
  .get(F, fdp[0].day).s;
ok(ledger === fdp[0].sources.search, "聚合表与 run_points 账本一致", `${ledger} vs ${fdp[0].sources.search}`);

// ---- 打卡情况（checkinSummary）：连续天数 + 默认搜索引擎进度 ----
openRun("run-3"); // 上面把轮次关掉了，记账要先有进行中的轮次
// 这一段刻意用"相对真实今天"的天数造数据：checkinSummary 的 today 就是真实北京今天，
// 写死日期会像上面的幻影日测试那样随挂钟漂移。
const relDay = (back) =>
  new Date(Date.now() - back * 86400000).toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
const relAt = (back) => new Date(Date.now() - back * 86400000);
const E = "e@outlook.com";

// search 今天+昨天+前天=3；read 今天+前天（昨天断）=1；checkIn 只有昨天+前天=2 且今天未打卡
store.recordLivePoints([{ email: E, live: { bySource: { search: 30 } } }], relAt(0));
store.recordLivePoints([{ email: E, live: { bySource: { search: 30, checkIn: 15 } } }], relAt(1));
store.recordLivePoints([{ email: E, live: { bySource: { search: 30, checkIn: 15 } } }], relAt(2));
store.recordLivePoints([{ email: E, live: { bySource: { read: 30 } } }], relAt(0));
store.recordLivePoints([{ email: E, live: { bySource: { read: 30 } } }], relAt(2));
let ci = store.checkinSummary({ days: 90 })[E];
ok(ci.tasks.search.streak === 3 && ci.tasks.search.todayDone === true, "连续 3 天", JSON.stringify(ci.tasks.search));
ok(ci.tasks.read.streak === 1, "昨天断了就从今天重新数", JSON.stringify(ci.tasks.read));
ok(ci.tasks.checkIn.streak === 2 && ci.tasks.checkIn.todayDone === false, "今天还没跑不算断，只标今日未打卡", JSON.stringify(ci.tasks.checkIn));
ok(ci.checkins["default-search"] === undefined, "没有打卡日志时不编造进度");

// 默认搜索引擎进度来自日志行：先要有 accounts 行才能把 userName 反查成 email
const ev = (event) => store.apply({ kind: "generic", level: "info", ...event });
ok(
  ev({
    ts: "2026-10-12T01:00:01.000Z",
    kind: "account-start",
    title: "ACCOUNT-START",
    email: E,
    userName: "eee",
  }) === true,
  "ACCOUNT-START 落库（供 userName 反查邮箱）"
);
ev({
  ts: "2026-10-12T01:00:02.000Z",
  title: "DEFAULT-SEARCH-ENGINE",
  message: "默认搜索引擎打卡成功 | 4/14 天 | 来源=app",
  userName: "eee",
});
ci = store.checkinSummary({ days: 90 })[E];
ok(
  ci.checkins["default-search"]?.days === 4 &&
    ci.checkins["default-search"].daysMax === 14 &&
    ci.checkins["default-search"].status === "advanced",
  "按 userName 反查邮箱并记下进度",
  JSON.stringify(ci.checkins["default-search"])
);
// apply() 自己有 lastTs 顺序闸门，乱序行到不了这里；直接测捕获函数 + SQL 的时间闸门
ok(
  store._captureCheckins({
    ts: "2026-10-12T00:30:00.000Z",
    title: "DEFAULT-SEARCH-ENGINE",
    message: "开始默认搜索引擎打卡 | 进度=2/14 天 | 来源=web",
    email: E,
  }) === 1,
  "进度行按 email 也能捕获"
);
ci = store.checkinSummary({ days: 90 })[E];
ok(ci.checkins["default-search"].days === 4, "ts 更早的行不把进度往回带", JSON.stringify(ci.checkins["default-search"]));
ok(
  store._captureCheckins({
    ts: "2026-10-12T01:10:00.000Z",
    title: "DEFAULT-SEARCH-ENGINE",
    message: "默认搜索引擎活动在本账户不可用（仪表板未提供 hva_dse 进度）",
    email: E,
  }) === 0,
  "没有数字的行忽略"
);
// 回归：同一张卡的"第 2/3 次尝试"也含 x/y，早先的规则会把重试次数当成 2/3 天写进去
ok(
  store._captureCheckins({
    ts: "2026-10-12T01:10:01.000Z",
    title: "DEFAULT-SEARCH-ENGINE",
    message: '第 2/3 次尝试 | query="某条搜索词"',
    email: E,
  }) === 0,
  "重试次数行不能被当成进度（必须带『天』）"
);
ok(store.checkinSummary({ days: 90 })[E].checkins["default-search"].daysMax === 14, "进度上限仍是 14 天");
ok(
  store._captureCheckins({
    ts: "2026-10-12T01:10:02.000Z",
    title: "DEFAULT-SEARCH-ENGINE",
    message: "默认搜索引擎打卡成功 | 5/14 天",
    userName: "查不到的人",
  }) === 0,
  "认不出账号时不写，也不硬塞给某个账号"
);
ci = store.checkinSummary({ days: 90 })[E];
ok(ci.checkins["default-search"].days === 4, "被忽略的行不影响已记进度");
// 昨天的记录要能被界面认出来（today=false），否则"今日已完成"会一直挂着昨天的状态
ok(
  store._captureCheckins({
    ts: relAt(1).toISOString(),
    title: "REACT-PARSE",
    message: "Quest list | parents=4 | incomplete=2",
    email: E,
  }) === 1,
  "写一条昨天的印章记录"
);
ci = store.checkinSummary({ days: 90 })[E];
ok(ci.checkins["punch"].today === false && ci.checkins["punch"].day === relDay(1),
  "昨天的记录不会冒充今天", JSON.stringify(ci.checkins["punch"]));

// ---- 其余几种打卡：全部来自真实日志行的形状 ----
const cap = (title, message, ts) =>
  store._captureCheckins({ ts, title, message, email: E });
ok(cap("SEARCH-MANAGER", "Mobile: run (3/10, missing 7) | Desktop: run (24/30, missing 6)", "2026-10-12T01:20:00.000Z") === 1, "今日搜索进度取 Desktop");
ok(cap("SEARCH-MANAGER", "Mobile: skip (complete, 0/0) | Desktop: skip (complete, 60/60)", "2026-10-12T01:20:01.000Z") === 1, "搜索跑满也记一行");
ok(cap("REACT-PARSE", "Quest list | parents=3 | incomplete=1", "2026-10-12T01:20:02.000Z") === 1, "印章收集按组数算");
ok(cap("DAILY-SET", 'All "Daily Set" items have already been completed', "2026-10-12T01:20:03.000Z") === 1, "每日套装完成态");
ok(cap("DAILY-CHECK-IN", "Daily Check-In completed but no points gained | type=103", "2026-10-12T01:20:04.000Z") === 1, "App 签到完成态");
ok(cap("FLOW", "Starting session for someone", "2026-10-12T01:20:05.000Z") === 0, "不相关的 title 一行都不写");

ci = store.checkinSummary({ days: 90 })[E];
const k = ci.checkins;
ok(k["search-today"].days === 60 && k["search-today"].daysMax === 60 && k["search-today"].status === "complete",
  "搜索进度保留最新那条", JSON.stringify(k["search-today"]));
ok(k["punch"].days === 2 && k["punch"].daysMax === 3, "印章 3 组里已完成 2 组", JSON.stringify(k["punch"]));
ok(k["daily-set-today"].status === "complete" && k["app-checkin-today"].status === "complete", "两个完成态都记上了");
ok(Object.keys(k).length === 5, `一共 5 种打卡：${Object.keys(k).join(", ")}`);

// ---- bot 的 CHECKIN-PROGRESS 行：一行里塞好几种升级活动天数 ----
ok(
  cap("CHECKIN-PROGRESS", "dse=6/14 | dailyset=2/4 | dailystreaks_mobile=5/7", "2026-10-12T01:30:00.000Z") === 3,
  "一行三种进度全部收下",
);
ci = store.checkinSummary({ days: 90 })[E];
ok(ci.checkins["default-search"].days === 6, "dse 与打卡行共用同一个 kind，新值覆盖旧值", JSON.stringify(ci.checkins["default-search"]));
ok(ci.checkins["level-dailyset"].days === 2 && ci.checkins["level-dailyset"].daysMax === 4, "每日活动天数", JSON.stringify(ci.checkins["level-dailyset"]));
ok(ci.checkins["level-dailystreaks_mobile"].status === "progress", "App 签到进度", JSON.stringify(ci.checkins["level-dailystreaks_mobile"]));
ok(cap("CHECKIN-PROGRESS", "gamepass=true | puzzle=0/0 | broken=9/3", "2026-10-12T01:30:01.000Z") === 0, "没有分母/分母为 0/超过分母的行都不写");
ok(Object.keys(store.checkinSummary({ days: 90 })[E].checkins).length === 7, "非法行没多出 kind，也没覆盖掉好数据");

// 印章收集：页面里那句 "3 / 12 个任务" 才是用户看的进度，bot 打成 stamps=3/12；
// 有了它就优先用它，别再报"0/2 组"那种没有信息量的口径。
ok(
  cap("REACT-PARSE", "Quest list | parents=2 | incomplete=2 | stamps=3/12", "2026-10-12T01:25:00.000Z") === 1,
  "带 stamps 的印章行也能捕获"
);
ci = store.checkinSummary({ days: 90 })[E];
ok(
  ci.checkins["punch"].days === 3 && ci.checkins["punch"].daysMax === 12,
  "印章进度改用 stamps=3/12，不再是 0/2 组",
  JSON.stringify(ci.checkins["punch"])
);
// 同一轮里后面的行没有 stamps（比如另一张卡的列表），也不能把已有的 3/12 覆盖成 0/2
ok(cap("REACT-PARSE", "Quest list | parents=2 | incomplete=2", "2026-10-12T01:26:00.000Z") === 1, "无 stamps 时仍按组数写");
ci = store.checkinSummary({ days: 90 })[E];
ok(ci.checkins["punch"].days === 0 && ci.checkins["punch"].daysMax === 2, "后到的组数行按最新时间覆盖");

ok(store.checkinSummary({ days: 0 }).constructor === Object, "days 非法也不炸");

console.log(fails ? `\n${fails} 项失败` : "\n全部通过");
process.exit(fails ? 1 : 0);
