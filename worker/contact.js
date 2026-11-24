// devey.co contact form handler (Cloudflare Worker).
//
// Receives the contact form (and the easter-egg ping) from devey.co and
// emails it through Cloudflare Email Routing. Replaces FormSubmit.
//
// Settings live on the Worker in Cloudflare, not in this public repo:
//   MAIL     send_email binding
//   MAIL_TO  where messages go (an Email Routing address)
//   MAIL_FROM sender on devey.co
import { EmailMessage } from "cloudflare:email";

const ALLOWED_ORIGINS = ["https://devey.co", "https://steve.devey.co"];
const LIMITS = { name: 200, email: 320, message: 5000 };

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin",
  };
}

function reply(origin, status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

// One line, no control characters: stops header injection via name/email.
const oneLine = (s, max) => String(s || "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, max);

function buildMime({ from, to, replyTo, subject, text }) {
  const headers = [
    `From: devey.co contact form <${from}>`,
    `To: ${to}`,
    replyTo ? `Reply-To: ${replyTo}` : null,
    `Subject: ${subject}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@devey.co>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ].filter(Boolean);
  return headers.join("\r\n") + "\r\n\r\n" + text.replace(/\r?\n/g, "\r\n") + "\r\n";
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== "POST") return reply(origin, 405, { success: false, message: "POST only" });
    if (!ALLOWED_ORIGINS.includes(origin)) return reply(origin, 403, { success: false, message: "Forbidden" });

    let data;
    try {
      const type = request.headers.get("Content-Type") || "";
      data = type.includes("application/json")
        ? await request.json()
        : Object.fromEntries(await request.formData());
    } catch {
      return reply(origin, 400, { success: false, message: "Bad request" });
    }

    // Honeypot: real visitors never see this field. Pretend success to bots.
    if (data._honey) return reply(origin, 200, { success: true });

    let subject, text, replyTo = null;

    if (data.type === "easter-egg") {
      subject = "Easter Egg Discovered!";
      text = `Someone found the flight simulator easter egg on ${origin}.`;
    } else {
      const name = oneLine(data.name, LIMITS.name);
      const email = oneLine(data.email, LIMITS.email);
      const message = String(data.message || "").slice(0, LIMITS.message).trim();
      if (!name || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
        return reply(origin, 400, { success: false, message: "Please give your name and a valid email." });
      }
      replyTo = email;
      subject = `devey.co contact form: ${name}`;
      text = `Name: ${name}\nEmail: ${email}\nSent from: ${origin}\n\n${message || "(no message)"}`;
    }

    // Without JavaScript the browser posts the form directly; send the visitor back.
    const wantsJson = (request.headers.get("Accept") || "").includes("application/json");
    const done = (ok, status, message) => wantsJson
      ? reply(origin, status, ok ? { success: true } : { success: false, message })
      : Response.redirect(`${origin}/#contact`, 303);

    try {
      const raw = buildMime({ from: env.MAIL_FROM, to: env.MAIL_TO, replyTo, subject, text });
      await env.MAIL.send(new EmailMessage(env.MAIL_FROM, env.MAIL_TO, raw));
    } catch (err) {
      console.log("send failed:", err && err.message);
      return done(false, 502, "Could not send right now.");
    }
    return done(true, 200);
  },
};
