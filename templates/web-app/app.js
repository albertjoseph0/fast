// Web-lane app runtime: one ES module, no build step. The studio renders config.json next to it.
// Flow: geofence → onboarding → AI consent → input → verdict (free uses) → paywall → Stripe
// payment link → back with ?checkout=<session> → /v1/web/claim (RevenueCat) → verdicts.
// Pure helpers are exported for tests; boot() runs only in a browser.

/** Payment link URL carrying the user id, so the purchase attaches to this user. */
export function checkoutUrl(linkUrl, appUserId) {
  const url = new URL(linkUrl);
  url.searchParams.set("client_reference_id", appUserId);
  return url.toString();
}

/** The Stripe Checkout session id the payment link redirected back with, if any. */
export function checkoutSessionFrom(search) {
  const id = new URLSearchParams(search).get("checkout");
  return id && /^cs_[A-Za-z0-9_]+$/.test(id) ? id : null;
}

/** Whether a visitor's country is one of the app's test territories (P4: no nationwide tests). */
export function allowedGeo(country, territories) {
  return typeof country === "string" && territories.includes(country.toUpperCase());
}

/** First-touch attribution from the landing URL (creator links carry utm_* and ref; share links i and ch). */
export function attributionFrom(search, referrer) {
  const p = new URLSearchParams(search);
  const out = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "ref", "cell", "i", "ch"]) {
    const v = p.get(key);
    if (v) out[key] = v.slice(0, 100);
  }
  if (referrer) {
    try {
      out.referrer_host = new URL(referrer).host;
    } catch {
      /* ignore malformed referrers */
    }
  }
  return out;
}

/** A stable random user id ("web_" + 32 hex), kept in localStorage. */
/** A friend's share id from the landing URL, or null. */
export function shareIdFrom(search) {
  const id = new URLSearchParams(search).get("s");
  return id && /^[A-Za-z0-9_-]{16,32}$/.test(id) ? id : null;
}

/** The link a share sends: opens on the sharer's result (s) and names the sharer (i). */
export function shareLink(origin, shareId, userId) {
  const p = new URLSearchParams();
  if (shareId) p.set("s", shareId);
  p.set("i", userId);
  p.set("ch", "share_loop");
  return `${origin}/?${p}`;
}

export function newUserId(random = () => crypto.getRandomValues(new Uint8Array(16))) {
  return `web_${Array.from(random(), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// -- browser runtime ----------------------------------------------------------------

const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode */
    }
  },
};

/** Onboarding steps the web lane shows: no push opt-in (no notifications on the web), and no
 * "your result is ready, unlock it" teaser before the user has given any input. */
export function stepsForWeb(steps) {
  return steps.filter((s) => s.kind !== "notification_preprompt" && s.kind !== "result_teaser");
}

/** Adult-only apps ask for age before anything else, like the native app's /age route. */
export function needsAgeGate(minimumAge) {
  return Number(minimumAge) >= 18;
}

const NEEDS_ANSWER = new Set(["goal_picker", "single_choice", "multi_choice", "text_input", "date_input", "time_input", "place_input", "slider", "attribution_survey"]);
const TAP_TO_ANSWER = new Set(["goal_picker", "single_choice", "attribution_survey", "slider"]);
const FIELD = { text_input: ["text", "Type here"], date_input: ["date", ""], time_input: ["time", ""], place_input: ["text", "City, country"] };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") node.addEventListener("click", v);
    else if (k === "oninput") node.addEventListener("input", v);
    else if (k === "onchange") node.addEventListener("change", v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== "") node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

async function boot() {
  const cfg = await (await fetch("/config.json")).json();
  const root = document.getElementById("app");
  const userId = store.get("uid") ?? newUserId();
  store.set("uid", userId);
  const firstVisit = !store.get("seen");
  const props = { app_slug: cfg.slug, platform: "web", ...JSON.parse(store.get("attr") ?? "{}") };
  if (firstVisit) {
    Object.assign(props, attributionFrom(location.search, document.referrer));
    store.set("attr", JSON.stringify(props));
    store.set("seen", "1");
  }

  function track(event, extra = {}) {
    if (!cfg.posthog.key) return;
    const body = JSON.stringify({ api_key: cfg.posthog.key, event, distinct_id: userId, properties: { ...props, ...extra } });
    navigator.sendBeacon?.(`${cfg.posthog.host}/capture/`, body) || fetch(`${cfg.posthog.host}/capture/`, { method: "POST", body, keepalive: true }).catch(() => {});
  }

  async function api(path, body) {
    const res = await fetch(`${cfg.backendUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug: cfg.slug, appUserId: userId, ...body }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message ?? "Something went wrong."), { code: data.error, status: res.status });
    return data;
  }

  let ticker = null;
  function screen(...children) {
    clearInterval(ticker);
    root.replaceChildren(...children);
    window.scrollTo(0, 0);
  }
  const actions = (...buttons) => el("div", { class: "actions" }, buttons);
  const notice = (text) => el("p", { class: "notice" }, text);
  const disclaimer = () => el("p", { class: "muted small" }, "Made with AI. It can be wrong; for entertainment and general information.");

  // Geofence: outside the test territories the app explains and stops.
  // geo.json is written at deploy time, so scaling to new territories is a redeploy, not a rebuild.
  const [geo, fence] = await Promise.all([
    fetch("/api/geo").then((r) => r.json()).catch(() => ({ country: null })),
    fetch("/geo.json").then((r) => r.json()).catch(() => ({ territories: [] })),
  ]);
  if (!allowedGeo(geo.country, fence.territories)) {
    screen(el("h1", {}, cfg.appName), el("p", {}, `${cfg.appName} isn't available in your region yet.`));
    return;
  }
  if (firstVisit) track("install");
  track("session");

  let installToken = store.get("install");
  if (!installToken) {
    installToken = (await api("/v1/install", {})).installToken;
    store.set("install", installToken);
  }

  // Back from checkout: attach the purchase, then continue to the input screen.
  let justSubscribed = false;
  const session = checkoutSessionFrom(location.search);
  if (session) {
    history.replaceState(null, "", location.pathname);
    try {
      await api("/v1/web/claim", { sessionId: session });
      store.set("subscribed", "1");
      justSubscribed = true;
      track("trial_start");
    } catch (e) {
      screen(el("h1", {}, "We couldn't confirm that"), el("p", {}, e.message));
      return;
    }
  }

  const profile = JSON.parse(store.get("profile") ?? "{}");
  const steps = stepsForWeb(cfg.onboarding);

  // Arrived from a friend's share: their result comes first, then the way to make one's own.
  const arrivedShare = shareIdFrom(location.search);
  const friend = arrivedShare
    ? await fetch(`${cfg.backendUrl}/v1/shared?slug=${encodeURIComponent(cfg.slug)}&id=${encodeURIComponent(arrivedShare)}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)
    : null;

  function friendResult(next) {
    track("share_landing_view");
    screen(
      el("p", { class: "eyebrow" }, `Your friend's ${cfg.appName} result`),
      el("div", { class: "card hero" }, el("h2", {}, friend.title), el("p", {}, friend.body)),
      el("p", { class: "muted small" }, "Made with AI. It can be wrong."),
      actions(el("button", { class: "primary", onclick: next }, `Make yours`)),
    );
  }

  function ageGate(next) {
    if (store.get("age") === "adult") return next();
    if (store.get("age") === "under_age") return underAge();
    screen(
      el("h1", {}, `Are you ${cfg.minimumAge} or older?`),
      el("p", { class: "muted" }, `${cfg.appName} is for adults only.`),
      actions(
        el("button", { class: "primary", onclick: () => (store.set("age", "adult"), track("age_gate", { age_confirmed: true }), next()) }, `Yes, I'm ${cfg.minimumAge} or older`),
        el("button", { class: "secondary", onclick: () => (store.set("age", "under_age"), track("age_gate", { age_confirmed: false }), underAge()) }, "No"),
      ),
    );
  }

  function underAge() {
    screen(el("h1", {}, "Sorry"), el("p", {}, `${cfg.appName} is only for people ${cfg.minimumAge} and older.`));
  }

  function progress(i) {
    const bar = el("div", { class: "progress" }, el("div"));
    bar.firstChild.style.width = `${Math.round(((i + 1) / steps.length) * 100)}%`;
    return bar;
  }

  function onboarding(i = 0) {
    if (i === 0) track("onboarding_start", { steps: steps.length });
    const step = steps[i];
    if (!step) {
      track("onboarding_complete");
      store.set("onboarded", "1");
      return consent();
    }
    track("onboarding_step", { step: step.id, kind: step.kind, index: i });
    const key = step.storeAs ?? step.id;
    const save = (value) => {
      profile[key] = value;
      if (step.storeAs) store.set("profile", JSON.stringify(profile));
    };
    const next = () => {
      if (step.kind === "attribution_survey" && typeof profile[key] === "string") track("attribution_answer", { answer: profile[key] });
      onboarding(i + 1);
    };
    const head = [progress(i), el("h1", {}, step.title), step.subtitle ? el("p", { class: "muted" }, step.subtitle) : ""];
    const cont = el("button", { class: "primary", onclick: next }, "Continue");
    const needs = NEEDS_ANSWER.has(step.kind) && step.kind !== "time_input";
    const answered = () => {
      const a = profile[key];
      return Array.isArray(a) ? a.length > 0 : typeof a === "string" && a.trim() !== "";
    };
    const refresh = () => (cont.disabled = needs && !answered());

    if (step.kind === "ai_data_consent") {
      return screen(
        ...head,
        el("div", { class: "card" }, el("p", {}, cfg.aiDisclosure)),
        actions(
          el("button", { class: "primary", onclick: () => (store.set("consent", "1"), track("ai_consent_granted"), next()) }, "I agree"),
          el("button", { class: "secondary", onclick: () => (track("ai_consent_declined"), declined()) }, "Not now"),
        ),
      );
    }
    if (step.kind === "loading_personalization") {
      screen(...head, el("div", { class: "spinner" }), ...cfg.loadingMessages.map((m) => el("p", { class: "muted center" }, m)));
      ticker = setTimeout(next, 2500);
      return;
    }
    if (step.kind === "value_preview") {
      return screen(
        ...head,
        el("div", { class: "card hero" }, el("p", { class: "eyebrow" }, cfg.share.cardHeadline), ...cfg.outputSections.map((t) => el("p", { class: "section-name" }, t)), el("p", { class: "small muted" }, "Generated by AI")),
        actions(cont),
      );
    }
    if (TAP_TO_ANSWER.has(step.kind) && step.options.length) {
      // One tap answers and moves on: the fastest path through a single choice.
      return screen(...head, el("div", { class: "options" }, step.options.map((o) => el("button", { class: "option", onclick: () => (save(o), next()) }, o))));
    }
    if (step.kind === "multi_choice" && step.options.length) {
      const picked = new Set(Array.isArray(profile[key]) ? profile[key] : []);
      const buttons = step.options.map((o) => {
        const b = el("button", { class: `option${picked.has(o) ? " selected" : ""}`, "aria-pressed": picked.has(o) ? "true" : "false" }, o);
        b.addEventListener("click", () => {
          if (picked.has(o)) picked.delete(o);
          else picked.add(o);
          b.classList.toggle("selected", picked.has(o));
          b.setAttribute("aria-pressed", picked.has(o) ? "true" : "false");
          save([...picked]);
          refresh();
        });
        return b;
      });
      screen(...head, el("div", { class: "options" }, buttons), actions(cont));
      return refresh();
    }
    if (FIELD[step.kind]) {
      const [type, placeholder] = FIELD[step.kind];
      const field = el("input", { class: "field", type, placeholder, value: typeof profile[key] === "string" ? profile[key] : "", maxlength: 200, oninput: (e) => (save(e.target.value), refresh()) });
      screen(...head, field, actions(cont));
      return refresh();
    }
    screen(...head, actions(cont));
  }

  function declined() {
    screen(el("h1", {}, "No problem"), el("p", {}, `${cfg.appName} needs to send what you share to its AI to make a result. You can come back any time.`), actions(el("button", { class: "secondary", onclick: () => onboarding(0) }, "Start over")));
  }

  function consent() {
    if (store.get("consent") === "1") return input();
    screen(
      el("h1", {}, "Before we start"),
      el("div", { class: "card" }, el("p", {}, cfg.aiDisclosure)),
      actions(
        el("button", { class: "primary", onclick: () => (store.set("consent", "1"), track("ai_consent_granted"), input()) }, "Allow and continue"),
        el("button", { class: "secondary", onclick: () => (track("ai_consent_declined"), declined()) }, "Not now"),
      ),
    );
  }

  function input(banner) {
    const kind = cfg.inputKind;
    const go = el("button", { class: "primary", onclick: () => submit(field) }, "Get my result");
    let field;
    let body;
    if (kind === "photo" || kind === "screenshot") {
      const preview = el("img", { class: "preview", alt: "" });
      const hint = el("span", {}, kind === "photo" ? "Tap to choose a photo" : "Tap to choose a screenshot");
      field = el("input", { type: "file", accept: "image/*", id: "in", class: "visually-hidden" });
      field.addEventListener("change", () => {
        const file = field.files?.[0];
        if (file) {
          preview.src = URL.createObjectURL(file);
          hint.textContent = "Tap to change";
        }
        go.disabled = !file;
      });
      go.disabled = true;
      body = el("label", { class: "drop", for: "in" }, preview, hint, field);
    } else if (kind === "none") {
      field = el("span");
      body = field;
    } else {
      field = el("textarea", { id: "in", class: "field", rows: 5, maxlength: 4000, placeholder: cfg.inputLabel });
      body = field;
    }
    screen(banner ? notice(banner) : "", el("h1", {}, cfg.inputLabel), body, actions(go));
  }

  async function readInput(field) {
    if (field.type === "file") {
      const file = field.files?.[0];
      if (!file) return null;
      const b64 = await new Promise((ok) => {
        const r = new FileReader();
        r.onload = () => ok(String(r.result).split(",")[1]);
        r.readAsDataURL(file);
      });
      return { kind: cfg.inputKind, imageBase64: b64, mediaType: file.type, profile };
    }
    if (field.tagName === "TEXTAREA") return field.value.trim() ? { kind: "text", text: field.value.trim(), profile } : null;
    return { kind: cfg.inputKind, profile };
  }

  function loading() {
    const messages = cfg.loadingMessages.length ? cfg.loadingMessages : ["Working on it…"];
    const line = el("p", { class: "muted center" }, messages[0]);
    screen(el("div", { class: "spinner" }), line);
    let i = 0;
    ticker = setInterval(() => (line.textContent = messages[++i % messages.length]), 1500);
  }

  async function submit(field) {
    const value = await readInput(field);
    if (!value) return;
    loading();
    try {
      const r = await api("/v1/verdict", { installToken, consent: true, input: value });
      if (!store.get("activated")) {
        store.set("activated", "1");
        track("activated");
      }
      result(r);
    } catch (e) {
      if (e.status === 402) return paywall();
      screen(el("p", {}, e.message), actions(el("button", { class: "primary", onclick: () => input() }, "Try again")));
    }
  }

  function result(r) {
    const [lead, ...rest] = r.sections;
    const status = el("p", { class: "notice", hidden: true });
    const share = async () => {
      // Publish the lead section so the link opens on this result; share the plain link if that fails.
      const published = await api("/v1/share", { installToken, resultId: r.id }).catch(() => null);
      const link = shareLink(location.origin, published?.shareId, userId);
      const data = { title: cfg.appName, text: cfg.share.caption, url: link };
      try {
        if (navigator.share) await navigator.share(data);
        else {
          await navigator.clipboard.writeText(`${cfg.share.caption}\n${link}`);
          status.textContent = "Link copied. Paste it to a friend.";
          status.hidden = false;
        }
        track("share");
        if (!store.get("shared")) {
          store.set("shared", "1");
          track("share_first");
        }
      } catch {
        /* cancelled */
      }
    };
    screen(
      el("p", { class: "eyebrow" }, cfg.share.cardHeadline),
      el("div", { class: "card hero" }, el("h2", {}, lead.title), el("p", {}, lead.body)),
      ...rest.map((s) => el("section", { class: "card" }, el("h2", {}, s.title), el("p", {}, s.body))),
      disclaimer(),
      status,
      actions(el("button", { class: "primary", onclick: share }, "Share with a friend"), el("button", { class: "secondary", onclick: () => input() }, "Another one")),
      el("button", { class: "link", onclick: () => api("/v1/report", { resultId: r.id, reason: "user report" }).then(() => alert("Thanks, we'll look at it.")) }, "Report this result"),
    );
  }

  function paywall() {
    track("paywall_view");
    const products = cfg.products.filter((p) => p.checkoutUrl);
    screen(
      el("h1", {}, cfg.paywall.headline),
      el("ul", { class: "bullets" }, cfg.paywall.bullets.map((b) => el("li", {}, b))),
      ...products.map((p) =>
        el(
          "div",
          { class: `plan${p.ladderId === cfg.paywall.highlighted ? " highlighted" : ""}` },
          el("p", { class: "plan-price" }, p.label),
          el("p", { class: "small muted" }, p.terms),
          el("a", { class: p.ladderId === cfg.paywall.highlighted ? "button primary" : "button secondary", href: checkoutUrl(p.checkoutUrl, userId) }, p.trialDays > 0 ? `Start ${p.trialDays}-day free trial` : "Subscribe"),
        ),
      ),
      el("p", { class: "small muted" }, "Payments are processed by Stripe. Cancel any time from the link in your receipt email", cfg.customerPortalUrl ? " or " : ".", cfg.customerPortalUrl ? el("a", { href: cfg.customerPortalUrl }, "manage your subscription") : ""),
      el("button", { class: "link", onclick: () => input() }, "Not now"),
    );
  }

  const afterAge = () => (store.get("onboarded") ? consent() : onboarding());
  const start = () => (needsAgeGate(cfg.minimumAge) ? ageGate(afterAge) : afterAge());
  if (justSubscribed) return input("You're subscribed. Results are unlimited now.");
  if (friend && typeof friend.title === "string" && typeof friend.body === "string") friendResult(start);
  else start();
}

if (typeof document !== "undefined") boot().catch((e) => console.error(e));
