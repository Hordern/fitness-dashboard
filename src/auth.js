// Sign-in for the parts of the dashboard that spend Anthropic credit or change
// the plan (chats, Sync now, check-ins). The rest of the dashboard stays public.
//
//   - Passkeys (Face ID / Touch ID / Windows Hello) via WebAuthn. Registering a
//     new device needs a signed-in session, so the first device signs in with
//     the PIN once and then adds a passkey.
//   - COACH_PIN as the fallback, with a lockout after repeated wrong PINs.
//
// A successful sign-in sets a signed, httpOnly session cookie (SESSION_SECRET)
// for 30 days. Passkeys are stored in settings 'passkeys'. They're bound to the
// domain they were made on, so moving to a new domain means adding them again.

import crypto from "node:crypto";
import {
  generateAuthenticationOptions, generateRegistrationOptions,
  verifyAuthenticationResponse, verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { getSetting, setSetting } from "./db.js";

const SESSION_COOKIE = "hd_session";
const CHALLENGE_COOKIE = "hd_challenge";
const SESSION_DAYS = 30;
const PASSKEYS = "passkeys";
const cookieOpts = { httpOnly: true, secure: true, sameSite: "strict", path: "/" };

// ---- Signed cookies: base64url(JSON) + "." + HMAC ----
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("Sign-in is off (SESSION_SECRET not set)");
  return s;
}
const hmac = (data) => crypto.createHmac("sha256", secret()).update(data).digest("base64url");
const sign = (value) => { const data = Buffer.from(JSON.stringify(value)).toString("base64url"); return `${data}.${hmac(data)}`; };
function unsign(token) {
  const [data, mac] = String(token ?? "").split(".");
  if (!data || !mac) return null;
  const expected = hmac(data);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const value = JSON.parse(Buffer.from(data, "base64url").toString());
  return value.exp > Date.now() ? value : null;
}
const readCookie = (req, name) => (req.headers.cookie ?? "").match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1];

function startSession(res, method) {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  res.cookie(SESSION_COOKIE, sign({ method, exp }), { ...cookieOpts, maxAge: SESSION_DAYS * 86_400_000 });
}

// Wrong-PIN lockout: 5 misses in 15 minutes locks PIN sign-in for that address.
const PIN_TRIES = 5, PIN_WINDOW_MS = 15 * 60_000;
const pinMisses = new Map(); // ip -> [timestamps]
function pinLocked(ip) {
  const recent = (pinMisses.get(ip) ?? []).filter((t) => Date.now() - t < PIN_WINDOW_MS);
  pinMisses.set(ip, recent);
  return recent.length >= PIN_TRIES;
}

function pinMatches(given) {
  const pin = process.env.COACH_PIN;
  given = String(given ?? "");
  return Boolean(pin) && given.length === pin.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(pin));
}

export function isSignedIn(req) {
  try { return Boolean(unsign(readCookie(req, SESSION_COOKIE))); } catch { return false; }
}

export function requireAuth(req, res, next) {
  if (isSignedIn(req)) return next();
  res.status(401).json({ error: "Sign in first" });
}

// The relying party is whatever domain the page is served from.
const rp = (req) => ({ rpID: req.hostname, origin: `https://${req.get("host")}` });
const toStored = (c) => ({ id: c.id, publicKey: Buffer.from(c.publicKey).toString("base64url"), counter: c.counter, transports: c.transports });
const fromStored = (c) => ({ ...c, publicKey: new Uint8Array(Buffer.from(c.publicKey, "base64url")) });

export function mountAuth(app, express) {
  const json = express.json();
  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req, res));
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message });
    }
  };
  const fail = (message, status = 401) => Object.assign(new Error(message), { status });
  const challenge = (req, res, kind) => {
    const c = unsign(readCookie(req, CHALLENGE_COOKIE));
    res.clearCookie(CHALLENGE_COOKIE, cookieOpts);
    if (c?.kind !== kind) throw fail("Sign-in timed out, try again");
    return c.challenge;
  };
  const saveChallenge = (res, kind, options) =>
    res.cookie(CHALLENGE_COOKIE, sign({ kind, challenge: options.challenge, exp: Date.now() + 5 * 60_000 }), { ...cookieOpts, maxAge: 5 * 60_000 });

  app.get("/api/auth/status", handle(async (req) => ({
    signed_in: isSignedIn(req),
    passkeys: ((await getSetting(PASSKEYS)) ?? []).map((p) => ({ name: p.name, created: p.created })),
  })));

  app.post("/api/auth/pin", json, handle((req, res) => {
    if (pinLocked(req.ip)) throw fail("Too many wrong PINs. Try again in 15 minutes, or use a passkey.", 429);
    if (!pinMatches(req.body?.pin)) {
      pinMisses.get(req.ip).push(Date.now());
      throw fail(process.env.COACH_PIN ? "Wrong PIN" : "PIN sign-in is off (COACH_PIN not set)");
    }
    startSession(res, "pin");
    return { signed_in: true };
  }));

  app.post("/api/auth/logout", handle((req, res) => {
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    return { signed_in: false };
  }));

  // Adding a passkey for this device (must already be signed in).
  app.post("/api/auth/passkey/register/options", requireAuth, handle(async (req, res) => {
    const existing = (await getSetting(PASSKEYS)) ?? [];
    const options = await generateRegistrationOptions({
      rpName: "Daniel's Fitness Dashboard", rpID: rp(req).rpID,
      userName: "daniel", userDisplayName: "Daniel Hordern",
      userID: new TextEncoder().encode("daniel"),
      attestationType: "none",
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    });
    saveChallenge(res, "register", options);
    return options;
  }));

  app.post("/api/auth/passkey/register/verify", requireAuth, json, handle(async (req, res) => {
    const { origin, rpID } = rp(req);
    const result = await verifyRegistrationResponse({
      response: req.body.response, expectedChallenge: challenge(req, res, "register"),
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
    });
    if (!result.verified) throw fail("Passkey couldn't be verified");
    const existing = (await getSetting(PASSKEYS)) ?? [];
    const name = String(req.body.name ?? "").slice(0, 40) || "Passkey";
    await setSetting(PASSKEYS, [...existing, { ...toStored(result.registrationInfo.credential), name, created: new Date().toISOString() }]);
    return { added: name };
  }));

  // Signing in with a passkey.
  app.post("/api/auth/passkey/login/options", handle(async (req, res) => {
    const existing = (await getSetting(PASSKEYS)) ?? [];
    if (!existing.length) throw fail("No passkeys yet: sign in with the PIN, then add one", 400);
    const options = await generateAuthenticationOptions({
      rpID: rp(req).rpID, userVerification: "required",
      allowCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
    });
    saveChallenge(res, "login", options);
    return options;
  }));

  app.post("/api/auth/passkey/login/verify", json, handle(async (req, res) => {
    const { origin, rpID } = rp(req);
    const existing = (await getSetting(PASSKEYS)) ?? [];
    const stored = existing.find((c) => c.id === req.body.response?.id);
    if (!stored) throw fail("That passkey isn't registered here");
    const result = await verifyAuthenticationResponse({
      response: req.body.response, expectedChallenge: challenge(req, res, "login"),
      expectedOrigin: origin, expectedRPID: rpID, credential: fromStored(stored), requireUserVerification: true,
    });
    if (!result.verified) throw fail("Passkey couldn't be verified");
    stored.counter = result.authenticationInfo.newCounter;
    await setSetting(PASSKEYS, existing);
    startSession(res, "passkey");
    return { signed_in: true };
  }));
}
