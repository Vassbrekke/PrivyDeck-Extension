import { PRIVYDECK_EXTENSION_CONFIG } from "./config.js";
import { engineLabel } from "./engine-info.js";

const authSection = document.getElementById("authSection");
const rulesSection = document.getElementById("rulesSection");
const lockdownModesEl = document.getElementById("lockdownModes");
const blocklistsEl = document.getElementById("blocklists");
const domainListEl = document.getElementById("domainList");
const addDomainForm = document.getElementById("addDomainForm");
const domainInput = document.getElementById("domainInput");
const allowListEl = document.getElementById("allowList");
const addAllowForm = document.getElementById("addAllowForm");
const allowInput = document.getElementById("allowInput");
const baselineListEl = document.getElementById("baselineList");
const addBaselineForm = document.getElementById("addBaselineForm");
const baselineInput = document.getElementById("baselineInput");
const rulesCountEl = document.getElementById("rulesCount");
const rulesVersionEl = document.getElementById("rulesVersion");
const syncBtn = document.getElementById("syncBtn");
const statusEl = document.getElementById("status");
const alertListEl = document.getElementById("alertList");
const notifListEl = document.getElementById("notifList");
const recsListEl = document.getElementById("recsList");
const markAllReadBtn = document.getElementById("markAllReadBtn");

function hubUrl() {
  return PRIVYDECK_EXTENSION_CONFIG.defaultHubUrl;
}

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = `status ${kind}`.trim();
}

async function getToken() {
  const { token } = await chrome.storage.local.get(["token"]);
  return token || null;
}

async function api(path, options = {}) {
  const token = await getToken();
  if (!token) throw new Error("Connect your PrivyDeck account from the extension popup.");

  const res = await fetch(`${hubUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function lockdownOption(value, name, description, { checked, disabled } = {}) {
  const label = document.createElement("label");
  label.className = `option${checked ? " active" : ""}`;

  const input = document.createElement("input");
  input.type = "radio";
  input.name = "lockdown";
  input.value = value;
  input.checked = Boolean(checked);
  input.disabled = Boolean(disabled);

  const span = document.createElement("span");
  const strong = document.createElement("strong");
  strong.textContent = name;
  const small = document.createElement("small");
  small.textContent = description;
  span.appendChild(strong);
  span.appendChild(small);

  label.appendChild(input);
  label.appendChild(span);
  return label;
}

function renderLockdownModes(state) {
  lockdownModesEl.replaceChildren();
  lockdownModesEl.appendChild(
    lockdownOption("", "None", "Only protection lists and your custom domains", {
      checked: !state.lockdownMode,
    })
  );

  for (const mode of state.lockdownModes) {
    const locked = mode.premium && state.tier === "free";
    lockdownModesEl.appendChild(
      lockdownOption(mode.id, mode.name, mode.description + (locked ? " · Premium" : ""), {
        checked: mode.active,
        disabled: locked,
      })
    );
  }

  lockdownModesEl.querySelectorAll('input[name="lockdown"]').forEach((input) => {
    input.addEventListener("change", async () => {
      if (!input.checked) return;
      setStatus("Saving lockdown mode…");
      try {
        const modeId = input.value || null;
        const next = await api("/api/extension/rules", {
          method: "PATCH",
          body: JSON.stringify({ action: "setLockdown", modeId }),
        });
        renderAll(next);
        await applyRules();
        setStatus("Lockdown mode updated.", "ok");
      } catch (err) {
        setStatus(String(err.message || err), "err");
      }
    });
  });
}

function listRowMeta(title, subtitle) {
  const meta = document.createElement("div");
  const p = document.createElement("p");
  p.textContent = title;
  const small = document.createElement("small");
  small.textContent = subtitle;
  meta.appendChild(p);
  meta.appendChild(small);
  return meta;
}

function renderBlocklists(state) {
  blocklistsEl.replaceChildren();
  for (const list of state.blocklists) {
    const row = document.createElement("div");
    row.className = "list-row";
    const locked = list.premium && state.tier === "free";
    row.appendChild(
      listRowMeta(
        list.name,
        `${list.category ? String(list.category).charAt(0).toUpperCase() + String(list.category).slice(1) + " · " : ""}${list.source}`
      )
    );
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = list.enabled;
    toggle.disabled = locked;
    toggle.addEventListener("change", async () => {
      setStatus("Saving blocklist…");
      try {
        const next = await api("/api/extension/rules", {
          method: "PATCH",
          body: JSON.stringify({
            action: "toggleBlocklist",
            id: list.id,
            enabled: toggle.checked,
          }),
        });
        renderAll(next);
        await applyRules();
        setStatus("Blocklist updated.", "ok");
      } catch (err) {
        toggle.checked = !toggle.checked;
        setStatus(String(err.message || err), "err");
      }
    });
    row.appendChild(toggle);
    blocklistsEl.appendChild(row);
  }
}

function renderDomains(state) {
  domainListEl.replaceChildren();
  if (state.customDomains.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No custom domains yet.";
    domainListEl.appendChild(empty);
    return;
  }

  for (const row of state.customDomains) {
    const li = document.createElement("li");
    li.textContent = row.domain;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      setStatus("Removing domain…");
      try {
        const next = await api("/api/extension/rules", {
          method: "PATCH",
          body: JSON.stringify({ action: "removeDomain", domain: row.domain }),
        });
        renderAll(next);
        await applyRules();
        setStatus("Domain removed.", "ok");
      } catch (err) {
        setStatus(String(err.message || err), "err");
      }
    });
    li.appendChild(removeBtn);
    domainListEl.appendChild(li);
  }
}

function renderAllowDomains(state) {
  allowListEl.replaceChildren();
  const rows = state.allowDomains ?? [];
  if (rows.length === 0) {
    const empty = document.createElement("li");
    empty.textContent = "No exceptions yet.";
    allowListEl.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const li = document.createElement("li");
    li.textContent = row.domain;
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "danger";
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", async () => {
      setStatus("Removing exception…");
      try {
        const next = await api("/api/extension/rules", {
          method: "PATCH",
          body: JSON.stringify({ action: "removeAllowDomain", domain: row.domain }),
        });
        renderAll(next);
        await applyRules();
        setStatus("Exception removed.", "ok");
      } catch (err) {
        setStatus(String(err.message || err), "err");
      }
    });
    li.appendChild(removeBtn);
    allowListEl.appendChild(li);
  }
}

function renderBaselineDomains(state) {
  baselineListEl.replaceChildren();
  const rows = state.baselineDomains ?? [];
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No baseline rules yet.";
    baselineListEl.appendChild(empty);
    return;
  }

  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "list-row";

    const meta = listRowMeta(row.domain, row.isDefault ? "Built-in" : "Custom");
    item.appendChild(meta);

    const controls = document.createElement("div");
    controls.className = "row";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = row.enabled;
    toggle.title = "Enabled";
    toggle.addEventListener("change", async () => {
      setStatus("Saving baseline rule…");
      try {
        const next = await api("/api/extension/rules", {
          method: "PATCH",
          body: JSON.stringify({
            action: "setBaselineEnabled",
            domain: row.domain,
            enabled: toggle.checked,
          }),
        });
        renderAll(next);
        await applyRules();
        setStatus("Baseline rule updated.", "ok");
      } catch (err) {
        toggle.checked = !toggle.checked;
        setStatus(String(err.message || err), "err");
      }
    });
    controls.appendChild(toggle);

    if (!row.isDefault) {
      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "danger";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        setStatus("Removing baseline rule…");
        try {
          const next = await api("/api/extension/rules", {
            method: "PATCH",
            body: JSON.stringify({ action: "removeBaselineDomain", domain: row.domain }),
          });
          renderAll(next);
          await applyRules();
          setStatus("Baseline rule removed.", "ok");
        } catch (err) {
          setStatus(String(err.message || err), "err");
        }
      });
      controls.appendChild(removeBtn);
    }

    item.appendChild(controls);
    baselineListEl.appendChild(item);
  }
}

function renderAlerts(dash) {
  alertListEl.replaceChildren();
  if (!dash.alerts?.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No unresolved tracker alerts. Nice and quiet.";
    alertListEl.appendChild(empty);
    return;
  }

  for (const alert of dash.alerts) {
    const row = document.createElement("div");
    row.className = "alert-row";

    const title = document.createElement("p");
    title.textContent = `${alert.site} - ${alert.trackers} hits`;
    row.appendChild(title);

    const detail = document.createElement("small");
    detail.textContent = alert.suggestion || alert.categories.join(", ");
    row.appendChild(detail);

    const actions = document.createElement("div");
    actions.className = "row";

    const blockBtn = document.createElement("button");
    blockBtn.type = "button";
    blockBtn.className = "danger";
    blockBtn.textContent = "Block domain";
    blockBtn.addEventListener("click", () => resolveAlertAction(alert.id, true));
    actions.appendChild(blockBtn);

    const dismissBtn = document.createElement("button");
    dismissBtn.type = "button";
    dismissBtn.className = "secondary";
    dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => resolveAlertAction(alert.id, false));
    actions.appendChild(dismissBtn);

    row.appendChild(actions);
    alertListEl.appendChild(row);
  }
}

async function resolveAlertAction(id, blockDomain) {
  setStatus(blockDomain ? "Blocking tracker…" : "Dismissing alert…");
  try {
    const dash = await api("/api/extension/dashboard", {
      method: "POST",
      body: JSON.stringify({ action: "resolveAlert", id, blockDomain }),
    });
    renderDashboardSections(dash);
    if (blockDomain) await applyRules();
    setStatus(blockDomain ? "Tracker blocked everywhere." : "Alert dismissed.", "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
}

function renderNotifications(dash) {
  notifListEl.replaceChildren();
  if (!dash.notifications?.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No notifications.";
    notifListEl.appendChild(empty);
    return;
  }

  for (const notif of dash.notifications) {
    const row = document.createElement("div");
    row.className = `notif-row${notif.read ? "" : " unread"}`;

    const meta = document.createElement("div");
    const title = document.createElement("p");
    title.textContent = notif.title;
    const body = document.createElement("small");
    body.textContent = `${notif.body} · ${new Date(notif.createdAt).toLocaleString()}`;
    meta.appendChild(title);
    meta.appendChild(body);
    row.appendChild(meta);

    if (!notif.read) {
      const readBtn = document.createElement("button");
      readBtn.type = "button";
      readBtn.className = "secondary";
      readBtn.textContent = "Mark read";
      readBtn.addEventListener("click", async () => {
        try {
          const dash2 = await api("/api/extension/dashboard", {
            method: "POST",
            body: JSON.stringify({ action: "markNotificationRead", id: notif.id }),
          });
          renderDashboardSections(dash2);
        } catch (err) {
          setStatus(String(err.message || err), "err");
        }
      });
      row.appendChild(readBtn);
    }

    notifListEl.appendChild(row);
  }
}

function renderRecommendations(dash) {
  recsListEl.replaceChildren();
  if (!dash.recommendations?.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "You're all caught up.";
    recsListEl.appendChild(empty);
    return;
  }

  for (const rec of dash.recommendations) {
    const row = document.createElement("div");
    row.className = "rec-row";
    const title = document.createElement("p");
    const badge = document.createElement("span");
    badge.className = `priority-${rec.priority}`;
    badge.textContent = `[${rec.priority}] `;
    title.appendChild(badge);
    title.appendChild(document.createTextNode(rec.title));
    const desc = document.createElement("small");
    desc.textContent = rec.description;
    row.appendChild(title);
    row.appendChild(desc);
    recsListEl.appendChild(row);
  }
}

function renderDashboardSections(dash) {
  renderAlerts(dash);
  renderNotifications(dash);
  renderRecommendations(dash);
}

async function loadDashboard() {
  try {
    const dash = await api("/api/extension/dashboard");
    renderDashboardSections(dash);
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
}

function renderAll(state) {
  renderLockdownModes(state);
  renderBlocklists(state);
  renderDomains(state);
  renderAllowDomains(state);
  renderBaselineDomains(state);
  rulesCountEl.textContent = String(state.blockDomains.length);
  rulesVersionEl.textContent = state.rulesVersion;
  const engineEl = document.getElementById("engineHint");
  if (engineEl) {
    const isFx = typeof browser !== "undefined" && !!browser.runtime?.getBrowserInfo;
    engineEl.textContent = `Engine: ${engineLabel(isFx)}.`;
  }
}

async function applyRules() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "PRIVYDECK_SYNC" }, (res) => {
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(err));
      else if (!res?.ok) reject(new Error(res?.error || "Sync failed"));
      else resolve(res);
    });
  });
}

async function loadRules() {
  const token = await getToken();
  if (!token) {
    authSection.classList.remove("hidden");
    rulesSection.classList.add("hidden");
    return;
  }

  authSection.classList.add("hidden");
  rulesSection.classList.remove("hidden");
  setStatus("Loading rules…");

  try {
    const state = await api("/api/extension/rules");
    renderAll(state);
    setStatus("", "");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }

  loadDashboard().catch(() => {});
}

markAllReadBtn.addEventListener("click", async () => {
  try {
    const dash = await api("/api/extension/dashboard", {
      method: "POST",
      body: JSON.stringify({ action: "markAllNotificationsRead" }),
    });
    renderDashboardSections(dash);
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

addDomainForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const domain = domainInput.value.trim();
  if (!domain) return;

  setStatus("Adding domain…");
  try {
    const next = await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "addDomain", domain }),
    });
    domainInput.value = "";
    renderAll(next);
    await applyRules();
    setStatus("Domain added.", "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

addAllowForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const domain = allowInput.value.trim();
  if (!domain) return;

  setStatus("Adding exception…");
  try {
    const next = await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "addAllowDomain", domain }),
    });
    allowInput.value = "";
    renderAll(next);
    await applyRules();
    setStatus("Exception added.", "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

addBaselineForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const domain = baselineInput.value.trim();
  if (!domain) return;

  setStatus("Adding baseline rule…");
  try {
    const next = await api("/api/extension/rules", {
      method: "PATCH",
      body: JSON.stringify({ action: "addBaselineDomain", domain }),
    });
    baselineInput.value = "";
    renderAll(next);
    await applyRules();
    setStatus("Baseline rule added.", "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

syncBtn.addEventListener("click", async () => {
  setStatus("Applying rules…");
  try {
    await applyRules();
    setStatus("Rules applied.", "ok");
  } catch (err) {
    setStatus(String(err.message || err), "err");
  }
});

loadRules().catch(() => {});
