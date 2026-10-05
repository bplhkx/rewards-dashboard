import * as U from "../util.js";
import { cached } from "../api.js";

let accountsPayload = null;
let rootEl = null;
let mounted = false;
let context = null;

const launching = new Set();
const selectedForBatch = new Set();
const expandedAccounts = new Set();
let batchRunning = false;

// Two-step delete: a key must be "armed" by a first click before a second
// click on the confirm button actually deletes anything, so there's no way
// to remove an account's dashboard data with a single accidental click.
const deleteArmed = new Set();
const deleting = new Set();

const SOURCE_LABELS = {
  search: "搜索",
  bonus: "加成搜索",
  read: "阅读",
  checkIn: "Check-in",
  claimReward: "领取奖励",
  claimBonus: "领取加成",
  urlReward: "URL reward",
  visualSearch: "视觉搜索",
  appReward: "App 奖励",
  punchcard: "Punchcard",
  searchOnBing: "搜索活动",
};

function controlState() {
  const status = context?.status;
  const usable = Boolean(status?.reachable && status?.authOk !== false);
  const running = Boolean(status?.botRunning);
  return { usable, running };
}

async function runAccount(account) {
  if (!context || !account.configured || !Number.isInteger(account.index)) return;

  launching.add(account.index);
  render(rootEl);
  try {
    await context.api.control("start", { accountIndex: account.index });
    context.toast(
      `Started ACCOUNT_${account.index} only (${account.email}).`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    launching.delete(account.index);
    render(rootEl);
  }
}

function selectableAccounts() {
  return (accountsPayload?.accounts || []).filter(
    (a) => a.configured && Number.isInteger(a.index),
  );
}

// Removes an account's stored data (status, history, activity log) from the
// dashboard's own database. This never touches the bot itself - it's meant
// for accounts the bot no longer runs (removed from .env) whose dashboard
// data would otherwise linger forever.
async function deleteAccount(account) {
  if (!context) return;

  deleteArmed.delete(account.key);
  deleting.add(account.key);
  render(rootEl);
  try {
    await context.api.deleteDashboardAccount(account.email);
    context.toast(`Removed ${account.email} from the dashboard.`, "success");
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    deleting.delete(account.key);
    render(rootEl);
  }
}

async function runSelectedAccounts() {
  if (!context) return;
  const configured = selectableAccounts();
  const selectedIndexes = configured
    .filter((a) => selectedForBatch.has(a.index))
    .map((a) => a.index);
  if (!selectedIndexes.length) return;

  // The control API only accepts an exclusion list, so a "run these x of y"
  // request is expressed as "exclude everyone else".
  const excludedAccountIndexes = configured
    .filter((a) => !selectedForBatch.has(a.index))
    .map((a) => a.index);

  batchRunning = true;
  render(rootEl);
  try {
    await context.api.control("start", { excludedAccountIndexes });
    context.toast(
      `Started ${selectedIndexes.length}/${configured.length} selected accounts.`,
      "success",
    );
    context.invalidate();
    await context.refresh();
  } catch (error) {
    context.toast(error.message, error.status === 409 ? "warn" : "error");
  } finally {
    batchRunning = false;
    render(rootEl);
  }
}

function renderBatchToolbar(root) {
  const configured = selectableAccounts();
  const configuredIndexes = new Set(configured.map((a) => a.index));
  // Drop selections for accounts that disappeared (e.g. .env edited).
  for (const index of [...selectedForBatch]) {
    if (!configuredIndexes.has(index)) selectedForBatch.delete(index);
  }

  const { usable, running } = controlState();
  const count = selectedForBatch.size;
  const total = configured.length;

  U.$("#accountsSelectedCount", root).textContent = `${count}/${total} selected`;

  const allBtn = U.$("#accountsSelectAll", root);
  allBtn.checked = total > 0 && count === total;
  allBtn.indeterminate = count > 0 && count < total;
  allBtn.disabled = total === 0;

  const runBtn = U.$("#accountsRunSelected", root);
  runBtn.disabled = !usable || running || batchRunning || count === 0;
  runBtn.textContent = batchRunning ? "Starting\u2026" : "运行所选";
}

function earnableBadge(account) {
  const earnable = account.earnable || account.live?.earnable;
  const total = earnable
    ? Object.values(earnable).reduce((sum, points) => sum + (Number(points) || 0), 0)
    : 0;
  if (total <= 0) return "";
  return `<span class="point-source point-source--target"><strong>可赚积分</strong> ${U.escapeHtml(U.fmtNumber(total))}</span>`;
}

// Only sources that actually earned something today — ten "+0" chips per
// account is noise, not detail.
function sourceBreakdown(account) {
  const bySource = account.live?.bySource || {};
  return Object.entries(SOURCE_LABELS)
    .filter(([source]) => Number(bySource[source]) > 0)
    .map(
      ([source, label]) =>
        `<span class="point-source"><strong>${U.escapeHtml(label)}</strong> ${U.escapeHtml(U.fmtSigned(Number(bySource[source])))}</span>`,
    )
    .join("");
}

function protectionPresentation(account) {
  if (account.streakProtectionEnabled == null) return null;

  const remaining = account.streakProtectionRemainingDays;
  const days =
    remaining == null
      ? "days unavailable"
      : `${remaining} protection day${remaining === 1 ? "" : "s"} left`;
  const state = account.streakProtectionEnabled ? "On" : "Off";
  const streak =
    account.streakCounter == null
      ? "streak unavailable"
      : `${U.fmtNumber(account.streakCounter)} day${account.streakCounter === 1 ? "" : "s"} current streak`;

  return {
    state,
    days,
    streak,
    pillClass:
      account.streakProtectionEnabled && remaining !== 0
        ? "pill-success"
        : remaining === 0
          ? "pill-warn"
          : "pill-idle",
  };
}

function kv(items) {
  return `<dl class="kv">${items
    .map(
      ([k, v]) =>
        `<div><dt>${U.escapeHtml(k)}</dt><dd>${U.escapeHtml(String(v))}</dd></div>`,
    )
    .join("")}</dl>`;
}

function detailGroups(a, protection) {
  const groups = [];

  groups.push([
    "配置",
    [
      ["在 .env 中配置", a.configured ? "Yes" : "No \u2014 seen in logs only"],
      ...(a.geoLocale ? [["地区", a.geoLocale]] : []),
      ...(a.langCode ? [["语言", a.langCode]] : []),
      ...(a.hasTotp != null ? [["TOTP 密钥", a.hasTotp ? "已设置" : "未设置"]] : []),
      ...(a.hasRecoveryEmail != null
        ? [["找回邮箱", a.hasRecoveryEmail ? "已设置" : "未设置"]]
        : []),
      [
        "代理",
        a.proxy
          ? `${a.proxy.url}${a.proxy.port ? `:${a.proxy.port}` : ""}${a.proxy.hasCredentials ? " (authenticated)" : ""}`
          : "无",
      ],
    ],
  ]);

  groups.push([
    "连击与保护",
    [
      ["成功连击", `${a.successStreak} run${a.successStreak === 1 ? "" : "s"}`],
      ...(protection
        ? [
          [
            "当前连击",
            a.streakCounter == null
              ? "不可用"
              : `${U.fmtNumber(a.streakCounter)} day${a.streakCounter === 1 ? "" : "s"}`,
          ],
          ["连击保护", protection.state === "On" ? "已启用" : "已禁用"],
          [
            "剩余保护天数",
            a.streakProtectionRemainingDays == null
              ? "不可用"
              : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"}`,
          ],
          ...(a.streakProtectionUpdatedAt
            ? [["保护状态检查时间", U.fmtRelative(a.streakProtectionUpdatedAt)]]
            : []),
        ]
        : []),
    ],
  ]);

  groups.push([
    "运行历史",
    [
      ["API 记录的运行次数", U.fmtNumber(a.apiRuns)],
      ["已收集积分（API 历史）", U.fmtSigned(a.apiTotalCollected)],
      ["上次耗时", U.fmtDuration(a.lastDurationSec)],
      ["已加载历史积分", U.fmtNumber(a.historyCount)],
    ],
  ]);

  return `<div class="acc-detail-groups">${groups
    .map(
      ([title, items]) => `
        <div class="acc-detail-group">
            <h3 class="acc-detail-group-title">${title}</h3>
            ${kv(items)}
        </div>`,
    )
    .join("")}</div>`;
}

// Mirrors overview.js's statCard icon convention (stat-icon-check /
// -running / -alert icon-alert-active / -idle with \u2713 / \u25CF / ! / \u2013)
// so an account's live status reads the same way here as it does there.
function statusIconParts(statusKey) {
  switch (statusKey) {
    case "success":
    case "done":
      return { cls: "stat-icon-check", icon: "\u2713", label: "成功" };
    case "running":
    case "starting":
    case "stopping":
      return { cls: "stat-icon-running", icon: "\u25CF", label: U.pillParts(statusKey).label };
    case "pending":
      return { cls: "stat-icon-pending", icon: "\u25CF", label: U.pillParts(statusKey).label };
    case "error":
    case "crashed":
    case "interrupted":
    case "stopped":
      return { cls: "stat-icon-alert icon-alert-active", icon: "!", label: U.pillParts(statusKey).label };
    default:
      return { cls: "stat-icon-idle", icon: "\u2013", label: "空闲" };
  }
}

function renderAccountPanel(a, live) {
  const protection = protectionPresentation(a);
  const { usable, running } = controlState();

  // Accounts now start one at a time (accountDelay), so mid-run there can be
  // several accounts that already finished this run while another is still
  // going - `live` just means "has a record in this run", true for both.
  // a.status is this account's own last-observed outcome (idle/running/
  // success/error), so it correctly tells finished accounts apart from the
  // one actually in progress right now.
  // Mirrors overview.js: while waiting between accounts, the one named by
  // pendingDelay.nextEmail is up next, so it reads as "pending" rather than
  // whatever its last-observed status happened to be.
  const nextAccountEmail = context?.status?.pendingDelay?.nextEmail || null;
  const statusKey = launching.has(a.index)
    ? "starting"
    : a.status !== "running" && nextAccountEmail && a.email === nextAccountEmail
      ? "pending"
      : a.status;

  const runButton =
    a.configured && Number.isInteger(a.index)
      ? `<button type="button" class="btn btn-primary btn-small" data-run-account="${a.index}" ${!usable || running || launching.has(a.index) ? "disabled" : ""
      } title="Run only ACCOUNT_${a.index}">${launching.has(a.index) ? "Starting\u2026" : "仅运行该账号"}</button>`
      : "";

  const selectCheckbox =
    a.configured && Number.isInteger(a.index)
      ? `<label class="check acc-batch-select" title="Include ACCOUNT_${a.index} in a batch run">
          <input type="checkbox" data-select-account="${a.index}" ${selectedForBatch.has(a.index) ? "checked" : ""}>
          <span>选择</span>
        </label>`
      : "";

  const { cls: statusIconCls, icon: statusIcon, label: statusLabel } = statusIconParts(statusKey);
  const isExpanded = expandedAccounts.has(a.key);
  const detailsId = `acc-details-${U.escapeAttr(a.key)}`;

  const isDeleting = deleting.has(a.key);
  const deleteBlocked = a.status === "running" || launching.has(a.index);
  const deleteButton = deleteArmed.has(a.key)
    ? `<span class="acc-delete-confirm">
        <button type="button" class="btn btn-small" data-cancel-delete="${U.escapeAttr(a.key)}" ${isDeleting ? "disabled" : ""}>取消</button>
        <button type="button" class="btn btn-danger btn-small" data-confirm-delete="${U.escapeAttr(a.key)}" ${isDeleting ? "disabled" : ""} title="Permanently remove this account and its history from the dashboard">
            ${isDeleting ? "Removing\u2026" : "Are you sure?"}
        </button>
      </span>`
    : `<button type="button" class="btn btn-danger btn-small" data-arm-delete="${U.escapeAttr(a.key)}" ${deleteBlocked ? "disabled" : ""} title="${deleteBlocked ? "账号需处于空闲状态才能删除" : "Remove this account and its history from the dashboard"}">删除</button>`;

  const chips = [
    protection
      ? `<span class="pill ${protection.pillClass}" title="${U.escapeAttr(protection.streak)}; streak protection is ${protection.state.toLowerCase()}; ${U.escapeAttr(protection.days)}">Protection ${protection.state} \u00b7 ${a.streakProtectionRemainingDays == null ? "days unavailable" : `${a.streakProtectionRemainingDays} day${a.streakProtectionRemainingDays === 1 ? "" : "s"} left`}</span>`
      : "",
    earnableBadge(live || {}),
    sourceBreakdown(live || {}),
  ]
    .filter(Boolean)
    .join("");

  return `
    <div class="panel account-detail-panel">
        <div class="panel-head">
            <h2>
                <button type="button" class="acc-detail-toggle" data-toggle-details="${U.escapeAttr(a.key)}" aria-expanded="${isExpanded}" aria-controls="${detailsId}" title="${isExpanded ? "收起详情" : "展开详情"}">\u25b8</button>
                <span class="acc-status-icon ${statusIconCls}" role="img" aria-label="${U.escapeAttr(statusLabel)}" title="${U.escapeAttr(statusLabel)}">${statusIcon}</span>${U.escapeHtml(a.email)}
            </h2>
            ${a.index != null ? `<span class="tag-mini acc-tag-account-id">ACCOUNT_${a.index}</span>` : ""}
            ${a.configured ? "" : '<span class="tag-mini">未配置</span>'}
            <span class="acc-detail-actions">
                <span class="acc-status-pill">${U.statusPill(statusKey)}</span>
                ${selectCheckbox}
                ${runButton}
                ${deleteButton}
            </span>
        </div>
        <div class="panel-body" id="${detailsId}" ${isExpanded ? "" : "hidden"}>
            ${detailGroups(a, protection)}
        </div>
        ${chips ? `<div class="account-today-row">
            <span class="account-today-label">今天</span>
            <div class="account-today-chips">${chips}</div>
        </div>` : ""}
    </div>`;
}

function render(root) {
  const container = U.$("#accountsContainer", root);
  const accounts = accountsPayload?.accounts || [];

  const liveByEmail = new Map(
    (context?.status?.bot?.run?.accounts || []).map((la) => [la.email, la]),
  );

  const errEl = U.$("#accountsError", root);
  if (errEl) {
    errEl.hidden = !accountsPayload?.apiError;
    if (accountsPayload?.apiError) errEl.textContent = accountsPayload.apiError;
  }

  if (!accounts.length) {
    container.innerHTML = '<p class="empty-note" style="padding:1.25rem">尚未配置或观察到任何账号。</p>';
    renderBatchToolbar(root);
    return;
  }

  container.innerHTML = accounts.map(a => {
    const live = liveByEmail.get(a.email) || null;
    return renderAccountPanel(a, live);
  }).join("");

  container.querySelectorAll("button[data-run-account]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const index = Number(btn.dataset.runAccount);
      const account = accounts.find((a) => a.index === index);
      if (account) runAccount(account);
    }),
  );

  container.querySelectorAll("input[data-select-account]").forEach((input) =>
    input.addEventListener("change", () => {
      const index = Number(input.dataset.selectAccount);
      if (input.checked) selectedForBatch.add(index);
      else selectedForBatch.delete(index);
      renderBatchToolbar(root);
    }),
  );

  container.querySelectorAll("button[data-toggle-details]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.toggleDetails;
      if (expandedAccounts.has(key)) expandedAccounts.delete(key);
      else expandedAccounts.add(key);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-arm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.add(btn.dataset.armDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-cancel-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      deleteArmed.delete(btn.dataset.cancelDelete);
      render(root);
    }),
  );

  container.querySelectorAll("button[data-confirm-delete]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const key = btn.dataset.confirmDelete;
      const account = accounts.find((a) => a.key === key);
      if (account) deleteAccount(account);
    }),
  );

  renderBatchToolbar(root);
}

export default {
  id: "accounts",
  label: "账号",
  interval: 10000,

  mount(root, ctx) {
    rootEl = root;
    context = ctx;
    root.innerHTML = `
      <p class="notice notice--warn" id="accountsError" hidden></p>
      <div class="panel batch-select-box" id="accountsBatchToolbar">
          <div class="batch-select-header">
              <h2 class="batch-select-title">批量运行</h2>
              <div class="batch-select-controls">
                  <label class="check">
                      <input type="checkbox" id="accountsSelectAll">
                      <span>全选</span>
                  </label>
                  <span class="hint" id="accountsSelectedCount">0/0 selected</span>
                  <button type="button" class="btn btn-primary btn-small" id="accountsRunSelected" disabled>运行所选</button>
                  <button type="button" class="btn btn-small" id="accountsAddToggle">添加账号</button>
              </div>
          </div>
      </div>
      <div class="panel" id="accountsAddPanel" hidden>
          <div class="batch-select-header">
              <h2 class="batch-select-title">添加账号</h2>
              <span class="hint">写入 bot 的账号文件（宿主机 accounts.env），下一次运行即生效；新账号首次运行会用它自动登录。</span>
          </div>
          <label class="field field-item">
              <span class="hint-text">邮箱 *</span>
              <input class="input" type="email" id="accountsAddEmail" placeholder="someone@outlook.com" autocomplete="off">
          </label>
          <label class="field field-item">
              <span class="hint-text">密码</span>
              <input class="input" type="password" id="accountsAddPassword" autocomplete="new-password" placeholder="无密码/验证器登录可留空">
          </label>
          <label class="field field-item">
              <span class="hint-text">TOTP 密钥</span>
              <input class="input" type="text" id="accountsAddTotp" autocomplete="off" placeholder="需要两步验证时填写">
          </label>
          <label class="field field-item">
              <span class="hint-text">找回邮箱</span>
              <input class="input" type="email" id="accountsAddRecovery" autocomplete="off">
          </label>
          <label class="field field-item">
              <span class="hint-text">语言</span>
              <input class="input" type="text" id="accountsAddLang" value="zh-CN">
          </label>
          <label class="field field-item">
              <span class="hint-text">地区</span>
              <input class="input" type="text" id="accountsAddGeo" value="CN">
          </label>
          <label class="field field-item">
              <span class="hint-text">跑哪一端</span>
              <select class="input" id="accountsAddPlatforms">
                  <option value="both">全跑（移动端 + 桌面端）</option>
                  <option value="mobile">仅移动端</option>
                  <option value="desktop">仅桌面端</option>
              </select>
          </label>
          <div class="ctl-actions" style="margin-top: .75rem">
              <button type="button" class="btn btn-primary btn-small" id="accountsAddSave">保存并添加</button>
              <button type="button" class="btn btn-small" id="accountsAddCancel">取消</button>
              <span class="hint" id="accountsAddStatus"></span>
          </div>
      </div>
      <div id="accountsContainer">
          <p class="empty-note" style="padding:1.25rem">正在加载账号配置详情&hellip;</p>
      </div>
      <p class="hint" style="margin-top: 1.5rem;">账号在 bot 的 <code>.env</code>（<code>ACCOUNT_N_*</code>）里配置。
      The control API exposes full local email addresses but never sends passwords, recovery addresses, TOTP secrets, or proxy credentials.</p>
    `;
    mounted = true;

    U.$("#accountsSelectAll", root).addEventListener("change", (e) => {
      const configured = selectableAccounts();
      if (e.target.checked) configured.forEach((a) => selectedForBatch.add(a.index));
      else selectedForBatch.clear();
      render(root);
    });

    U.$("#accountsRunSelected", root).addEventListener("click", () => {
      runSelectedAccounts();
    });
    const addPanel = U.$("#accountsAddPanel", root);
    const addStatus = U.$("#accountsAddStatus", root);
    const addSave = U.$("#accountsAddSave", root);

    U.$("#accountsAddToggle", root).addEventListener("click", () => {
      addPanel.hidden = !addPanel.hidden;
      if (!addPanel.hidden) U.$("#accountsAddEmail", root).focus();
    });

    U.$("#accountsAddCancel", root).addEventListener("click", () => {
      addPanel.hidden = true;
      addStatus.textContent = "";
    });

    addSave.addEventListener("click", async () => {
      const val = (sel) => U.$(sel, root).value.trim();
      const payload = { email: val("#accountsAddEmail") };
      const fields = {
        "#accountsAddPassword": "password",
        "#accountsAddTotp": "totpSecret",
        "#accountsAddRecovery": "recoveryEmail",
        "#accountsAddLang": "langCode",
        "#accountsAddGeo": "geoLocale",
        "#accountsAddPlatforms": "platforms",
      };
      for (const [sel, key] of Object.entries(fields)) {
        const v = val(sel);
        if (v) payload[key] = v;
      }
      if (!payload.email) {
        addStatus.textContent = "请填写邮箱。";
        return;
      }
      addSave.disabled = true;
      addStatus.textContent = "提交中…";
      try {
        const res = await context.api.addAccount(payload);
        addStatus.textContent = `已添加为 ACCOUNT_${res.index}，下次运行生效。`;
        context.toast(`已添加账号 ${res.email}`, "success");
        ["#accountsAddEmail", "#accountsAddPassword", "#accountsAddTotp", "#accountsAddRecovery"]
          .forEach((sel) => { U.$(sel, root).value = ""; });
        context.invalidate();
        await context.refresh();
      } catch (error) {
        addStatus.textContent = error.message;
        context.toast(error.message, error.status === 409 ? "warn" : "error");
      } finally {
        addSave.disabled = false;
      }
    });
  },

  async refresh(ctx) {
    context = ctx;
    accountsPayload = await cached("accounts", ctx.api.accounts, 5000);
    this.redraw(ctx);
  },

  redraw(ctx) {
    context = ctx || context;
    if (!mounted || !accountsPayload) return;
    render(rootEl);
  }
};