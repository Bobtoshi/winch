const $ = (selector) => document.querySelector(selector);
const state = { runs: [], attempts: [], actions: [], events: [], meta: { harnesses: [], tools: [] } };

function node(tag, { className, text, dataset } = {}) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  for (const [key, value] of Object.entries(dataset || {})) element.dataset[key] = String(value);
  return element;
}

function append(parent, ...children) {
  parent.append(...children.filter(Boolean));
  return parent;
}

function time(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function harnessName(id) {
  return state.meta.harnesses.find((item) => item.id === id)?.name || id || "—";
}

function renderHarnesses() {
  const list = $("#harness-list");
  list.replaceChildren();
  const preferred = $("#preferred");
  const selected = preferred.value;
  preferred.replaceChildren(node("option", { text: "Automatic" }));
  preferred.firstChild.value = "";
  state.meta.harnesses.forEach((harness) => {
    const option = node("option", { text: `${harness.name} · ${harness.status}` });
    option.value = harness.id;
    option.disabled = !harness.enabled || !harness.available || harness.capabilities.includes("verify") && harness.capabilities.length === 1;
    preferred.append(option);

    const head = append(node("div", { className: "harness-head" }), node("h3", { text: harness.name }), node("mark", { className: harness.status, text: harness.status }));
    const meter = append(node("div", { className: "harness-meter" }), node("span"));
    meter.firstChild.style.width = `${Math.round((harness.reliability || 0) * 100)}%`;
    append(list, append(node("article", { className: "harness" }), head, node("p", { text: harness.capabilities.join(" · ").replaceAll("_", " ") }), meter));
  });
  if ([...preferred.options].some((option) => option.value === selected && !option.disabled)) preferred.value = selected;
  $("#registry-count").textContent = `${state.meta.harnesses.length} REGISTERED`;
  $("#ready-count").textContent = state.meta.harnesses.filter((item) => item.enabled && item.available && !item.capabilities.every((capability) => capability === "verify")).length;
  $("#rail-mode").textContent = state.meta.mode === "simulation-only" ? "Simulation only" : "Live enabled";
  const tools = $("#tool-list");
  tools.replaceChildren();
  state.meta.tools.forEach((tool) => append(tools, append(node("div", { className: "tool" }), node("b", { text: tool.type }), node("small", { className: tool.enabled ? "enabled" : "", text: tool.enabled ? "GRANTED" : "LOCKED" }))));
  $("#tool-count").textContent = `${state.meta.tools.filter((tool) => tool.enabled).length}/${state.meta.tools.length} GRANTED`;
}

function renderRoute() {
  const run = state.runs[0];
  const track = $("#route-track");
  track.replaceChildren();
  if (!run?.route) {
    append(track, routeNode("01", "Intent", "Awaiting command"), routeNode("02", "Capability", "Unclassified"), routeNode("03", "Harness", "Not routed"), routeNode("04", "Receipt", "Pending"));
    $("#route-status").textContent = "WAITING FOR INTENT";
    return;
  }
  append(track,
    routeNode("01", "Intent", run.risk),
    routeNode("02", "Capability", run.route.capability.replaceAll("_", " ")),
    routeNode("03", "Primary", harnessName(run.route.primary)),
    run.route.verifier ? routeNode("04", "Verifier", harnessName(run.route.verifier)) : null,
    routeNode(run.route.verifier ? "05" : "04", "Receipt", run.status)
  );
  $("#route-status").textContent = run.status.replaceAll("_", " ").toUpperCase();
  $("#route-rationale").textContent = run.route.rationale;
}

function routeNode(index, label, value) {
  return append(node("div", { className: "route-node" }), node("small", { text: `${index} / ${label}` }), node("b", { text: value }), node("em", { text: "locked route state" }));
}

function renderApprovals() {
  const waiting = state.runs.filter((run) => run.status === "awaiting_approval");
  const actions = state.actions.filter((action) => action.status === "awaiting_approval");
  const list = $("#approval-list");
  list.replaceChildren();
  $("#approval-count").textContent = `${waiting.length + actions.length} WAITING`;
  if (!waiting.length && !actions.length) {
    list.append(node("div", { className: "empty", text: "Nothing is waiting. Consequential routes stop here before any live harness receives the request." }));
    return;
  }
  waiting.forEach((run) => {
    const details = append(node("div"), node("h3", { text: `Dispatch to ${harnessName(run.route.primary)}` }), node("p", { text: run.intent }), node("code", { text: `APPROVAL ${run.approvalCode} · ${run.route.capability.toUpperCase()}` }));
    const decisions = append(node("div", { className: "decision" }), node("button", { text: "Reject", dataset: { targetId: run.id, targetKind: "runs", decision: "reject" } }), node("button", { className: "approve", text: "Approve route", dataset: { targetId: run.id, targetKind: "runs", decision: "approve" } }));
    decisions.querySelectorAll("button").forEach((button) => { button.type = "button"; });
    append(list, append(node("article", { className: "approval" }), details, decisions));
  });
  actions.forEach((action) => {
    const details = append(node("div"), node("h3", { text: action.title }), node("p", { text: JSON.stringify(action.arguments, null, 2) }), node("code", { text: `ACTION ${action.approvalCode} · ${action.type.toUpperCase()}` }));
    const decisions = append(node("div", { className: "decision" }), node("button", { text: "Reject", dataset: { targetId: action.id, targetKind: "actions", decision: "reject" } }), node("button", { className: "approve", text: "Run action", dataset: { targetId: action.id, targetKind: "actions", decision: "approve" } }));
    decisions.querySelectorAll("button").forEach((button) => { button.type = "button"; });
    append(list, append(node("article", { className: "approval action-approval" }), details, decisions));
  });
}

function renderOutput() {
  const run = state.runs.find((item) => item.result?.primary) || state.runs[0];
  const output = $("#output");
  output.replaceChildren();
  if (!run?.result?.primary) {
    output.append(node("div", { className: "empty", text: run?.result?.summary || "A normalized harness result and verification receipt will appear here." }));
    $("#output-harness").textContent = "NO RECEIPT";
    return;
  }
  $("#output-harness").textContent = `${harnessName(run.result.selectedHarness).toUpperCase()} RECEIPT`;
  append(output, node("h3", { text: run.result.primary.summary }), node("p", { text: run.result.primary.result }));
  if (run.result.verification) {
    append(output, append(node("div", { className: "verification" }), node("b", { text: "INDEPENDENT VERIFICATION" }), node("p", { text: run.result.verification.result })));
  }
  const receipts = state.actions.filter((action) => action.runId === run.id && action.result);
  receipts.forEach((action) => append(output, append(node("div", { className: "action-receipt" }), node("b", { text: `${action.type} · ${action.status}` }), node("p", { text: action.result.summary || "Action receipt recorded." }), node("pre", { text: JSON.stringify(action.result.output ?? action.result, null, 2) }))));
}

function renderRuns() {
  const list = $("#run-list");
  list.replaceChildren();
  if (!state.runs.length) {
    list.append(node("li", { text: "No runs yet." }));
    return;
  }
  state.runs.slice(0, 8).forEach((run) => append(list, append(node("li"), node("time", { text: time(run.createdAt) }), node("span", { text: run.intent }), node("b", { className: run.status, text: run.status.replaceAll("_", " ") }))));
}

function renderEvents() {
  const list = $("#event-list");
  list.replaceChildren();
  if (!state.events.length) {
    list.append(append(node("li"), node("time", { text: "NOW" }), node("i"), append(node("div"), node("b", { text: "Ready" }), document.createTextNode("Waiting for the first routed intent."))));
    return;
  }
  state.events.slice(0, 16).forEach((event) => append(list, append(node("li"), node("time", { text: time(event.created_at) }), node("i"), append(node("div"), node("b", { text: event.kind }), document.createTextNode(event.message)))));
}

function render() {
  renderHarnesses();
  renderRoute();
  renderApprovals();
  renderOutput();
  renderRuns();
  renderEvents();
}

async function refresh() {
  const response = await fetch("/api/state");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Could not load WINCH state.");
  Object.assign(state, data);
  render();
}

function toast(message) {
  const target = $("#toast");
  target.textContent = message;
  target.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => target.classList.remove("show"), 3200);
}

$("#run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const intent = $("#intent").value.trim();
  if (!intent) return;
  const button = $(".dispatch");
  button.disabled = true;
  button.querySelector("span").textContent = "Routing…";
  try {
    const response = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent, preferredHarness: $("#preferred").value || null }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Routing failed.");
    Object.assign(state, data);
    $("#intent").value = "";
    render();
    toast(state.runs[0]?.status === "awaiting_approval" ? "Route prepared. Human approval is required." : "Harness route completed with a receipt.");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.querySelector("span").textContent = "Route intent"; }
});

$("#approval-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-decision]");
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/${button.dataset.targetKind}/${encodeURIComponent(button.dataset.targetId)}/${button.dataset.decision}`, { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Decision failed.");
    Object.assign(state, data);
    render();
    toast(button.dataset.decision === "approve" ? "Approval processed and a receipt was recorded." : "Rejected. Nothing ran.");
  } catch (error) { toast(error.message); button.disabled = false; }
});

document.querySelectorAll("[data-intent]").forEach((button) => button.addEventListener("click", () => {
  $("#intent").value = button.dataset.intent;
  $("#intent").focus();
}));

refresh().catch((error) => toast(error.message));
setInterval(() => refresh().catch(() => {}), 5_000);
