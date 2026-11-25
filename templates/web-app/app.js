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

/** First-touch attribution from the landing URL (creator links carry utm_* and ref). */
export function attributionFrom(search, referrer) {
  const p = new URLSearchParams(search);
  const out = {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "ref", "cell"]) {
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

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "onclick") node.addEventListener("click", v);
    else if (v !== undefined && v !== null) node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
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

  function screen(...children) {
    root.replaceChildren(...children);
    window.scrollTo(0, 0);
  }

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
  const session = checkoutSessionFrom(location.search);
  if (session) {
    history.replaceState(null, "", location.pathname);
    try {
      await api("/v1/web/claim", { sessionId: session });
      store.set("subscribed", "1");
      track("trial_start");
    } catch (e) {
      screen(el("p", {}, e.message));
      return;
    }
  }

  const profile = JSON.parse(store.get("profile") ?? "{}");

  function onboarding(i = 0) {
    if (i === 0) track("onboarding_start");
    const step = cfg.onboarding[i];
    if (!step) {
      track("onboarding_complete");
      store.set("onboarded", "1");
      return consent();
    }
    track("onboarding_step", { step: step.id, index: i });
    const next = (answer) => {
      if (step.storeAs && answer !== undefined) {
        profile[step.storeAs] = answer;
        store.set("profile", JSON.stringify(profile));
        if (step.storeAs === "attribution") track("attribution_answer", { answer });
      }
      onboarding(i + 1);
    };
    const options = step.options.length ? step.options.map((o) => el("button", { class: "option", onclick: () => next(o) }, o)) : [el("button", { class: "primary", onclick: () => next() }, "Continue")];
    screen(el("h1", {}, step.title), step.subtitle ? el("p", { class: "muted" }, step.subtitle) : "", el("div", { class: "options" }, options));
  }

  function consent() {
    if (store.get("consent") === "1") return input();
    screen(
      el("h1", {}, "Before we start"),
      el("p", {}, cfg.aiDisclosure),
      el("button", { class: "primary", onclick: () => (store.set("consent", "1"), track("ai_consent_granted"), input()) }, "Allow and continue"),
      el("button", { class: "link", onclick: () => (track("ai_consent_declined"), screen(el("p", {}, "You can come back any time."))) }, "Not now"),
    );
  }

  function input() {
    const kind = cfg.inputKind;
    const field =
      kind === "photo" || kind === "screenshot"
        ? el("input", { type: "file", accept: "image/*", id: "in" })
        : kind === "none"
          ? el("span")
          : el("textarea", { id: "in", rows: 5, maxlength: 4000, placeholder: cfg.inputLabel });
    screen(el("h1", {}, cfg.inputLabel), field, el("button", { class: "primary", onclick: () => submit(field) }, "Get my result"));
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

  async function submit(field) {
    const value = await readInput(field);
    if (!value) return;
    screen(el("p", { class: "muted" }, cfg.loadingMessages[0] ?? "Working on it…"));
    try {
      const r = await api("/v1/verdict", { installToken, consent: true, input: value });
      if (!store.get("activated")) {
        store.set("activated", "1");
        track("activated");
      }
      result(r);
    } catch (e) {
      if (e.status === 402) return paywall();
      screen(el("p", {}, e.message), el("button", { class: "primary", onclick: input }, "Try again"));
    }
  }

  function result(r) {
    const text = r.sections.map((s) => `${s.title}\n${s.body}`).join("\n\n");
    const share = async () => {
      const data = { title: cfg.appName, text: `${cfg.share.caption}\n${location.origin}/?ref=share` };
      try {
        if (navigator.share) await navigator.share(data);
        else await navigator.clipboard.writeText(`${data.text}`);
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
      el("h1", {}, cfg.share.cardHeadline),
      ...r.sections.map((s) => el("section", {}, el("h2", {}, s.title), el("p", {}, s.body))),
      el("p", { class: "muted small" }, "Made with AI. It can be wrong; for entertainment and general information."),
      el("button", { class: "primary", onclick: share }, "Share"),
      el("button", { class: "link", onclick: input }, "Another one"),
      el("button", { class: "link", onclick: () => api("/v1/report", { resultId: r.id, reason: "user report" }).then(() => alert("Thanks, we'll look at it.")) }, "Report this result"),
      el("textarea", { hidden: true }, text),
    );
  }

  function paywall() {
    track("paywall_view");
    const products = cfg.products.filter((p) => p.checkoutUrl);
    screen(
      el("h1", {}, cfg.paywall.headline),
      el("ul", {}, cfg.paywall.bullets.map((b) => el("li", {}, b))),
      ...products.map((p) =>
        el(
          "div",
          { class: `plan${p.ladderId === cfg.paywall.highlighted ? " highlighted" : ""}` },
          el("p", {}, el("strong", {}, p.label)),
          el("p", { class: "small" }, p.terms),
          el("a", { class: "primary", href: checkoutUrl(p.checkoutUrl, userId) }, p.trialDays > 0 ? "Start free trial" : "Subscribe"),
        ),
      ),
      el("p", { class: "small muted" }, "Payments are processed by Stripe. Cancel any time from the link in your receipt email", cfg.customerPortalUrl ? " or " : ".", cfg.customerPortalUrl ? el("a", { href: cfg.customerPortalUrl }, "manage your subscription") : ""),
    );
  }

  if (store.get("onboarded")) consent();
  else onboarding();
}

if (typeof document !== "undefined") boot().catch((e) => console.error(e));
