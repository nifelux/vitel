/**
 * /api/deposit-bot.js
 *
 * Handles THREE roles in one file (keeps serverless function count down —
 * you're already at 9 functions, this adds only 1 instead of 2):
 *
 * 1. POST ?action=ingest
 *    Google Apps Script posts parsed Gmail credit alerts here.
 *    Auth: header "x-vitel-secret" must match BANK_ALERT_INGEST_SECRET.
 *
 * 2. GET ?action=lookup&narration=XXX
 *    Checks a narration against pending deposits + bank alerts, and
 *    auto-approves if a match is found. Callable directly for debugging.
 *
 * 3. POST (no ?action) — Telegram webhook for the PUBLIC deposit bot.
 *    Anyone can message this bot their narration code and get an
 *    instant status check / auto-approval.
 *
 * Env vars needed:
 *   TELEGRAM_DEPOSIT_BOT_TOKEN   — new bot token from @BotFather
 *                                  (a SEPARATE bot from your admin bot)
 *   BANK_ALERT_INGEST_SECRET     — any random string you choose, shared
 *                                  with the Google Apps Script
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — already set
 */

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BOT_TOKEN = process.env.TELEGRAM_DEPOSIT_BOT_TOKEN;
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Tolerant narration extractor ──────────────────────────────────────────────
// Reconstructs the canonical VTL-XXXXX-XXXXXX form even if the source text
// has slightly different spacing/casing/dashes (common in copy-pasted text
// or emails that reformat things).
function extractNarration(text) {
  const m = (text || "").match(/VTL[\s\-]{0,3}([A-F0-9]{5})[\s\-]{0,3}([A-F0-9]{6})/i);
  if (!m) return null;
  return `VTL-${m[1]}-${m[2]}`.toUpperCase();
}

function normalizeNarration(s) {
  return (s || "").trim().toUpperCase();
}

async function sendMessage(chat_id, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML" }),
  });
}

// ── Core matching logic — shared by ingest, lookup, and the bot ──────────────
async function tryMatchAndApprove(narration, amount, alertId) {
  const { data: deps } = await supabase
    .from("deposits")
    .select("*")
    .eq("narration", narration)
    .eq("status", "pending")
    .limit(1);

  const deposit = deps && deps[0];
  if (!deposit) return { matched: false };

  if (alertId) {
    await supabase
      .from("bank_credit_alerts")
      .update({ status: "matched", matched_deposit_id: deposit.id })
      .eq("id", alertId);
  }

  // Credit whatever the bank alert actually says was received — this is
  // the ground truth of what came into the account, more reliable than
  // trusting the originally-requested amount.
  const { data, error } = await supabase.rpc("process_deposit", {
    p_reference: deposit.reference,
    p_amount:    amount,
    p_payload:   { source: "gmail_auto_match", narration },
  });

  if (error || !data?.ok) {
    return { matched: true, approved: false, error: error?.message || data?.error, deposit };
  }
  return { matched: true, approved: true, deposit, amount };
}

async function lookupNarration(narrationRaw) {
  const narration = normalizeNarration(narrationRaw);
  if (!narration) return { ok: false, error: "narration required" };

  const { data: deps } = await supabase.from("deposits").select("*").eq("narration", narration).limit(1);
  const dep = deps && deps[0];
  if (!dep) return { ok: true, found: false };

  if (dep.status === "completed") return { ok: true, found: true, status: "completed", amount: dep.amount };
  if (dep.status === "rejected")  return { ok: true, found: true, status: "rejected" };

  const { data: alerts } = await supabase
    .from("bank_credit_alerts")
    .select("*")
    .eq("narration", narration)
    .order("created_at", { ascending: false })
    .limit(1);

  const alert = alerts && alerts[0];
  if (!alert) return { ok: true, found: true, status: "pending", alert_found: false, created_at: dep.created_at };

  const result = await tryMatchAndApprove(narration, alert.amount, alert.id);
  return { ok: true, found: true, status: result.approved ? "completed" : "pending", alert_found: true, ...result };
}

// ── Main handler ───────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const action = req.query.action;

  // ══ 1. INGEST — new bank credit alert from Google Apps Script ══════════════
  if (req.method === "POST" && action === "ingest") {
    const secret = req.headers["x-vitel-secret"];
    if (!secret || secret !== process.env.BANK_ALERT_INGEST_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { gmail_message_id, amount, narration, raw_snippet, sender_email } = req.body || {};
    if (!gmail_message_id || !amount) {
      return res.status(400).json({ error: "gmail_message_id and amount required" });
    }

    const cleanNarr = narration ? normalizeNarration(narration) : null;

    const { data: alert, error } = await supabase
      .from("bank_credit_alerts")
      .insert({
        gmail_message_id,
        amount: Number(amount),
        narration: cleanNarr,
        raw_snippet,
        sender_email,
        status: "unmatched",
      })
      .select()
      .single();

    if (error) {
      // Same email already ingested — Apps Script re-scanned it, just skip.
      if (error.code === "23505") return res.json({ ok: true, note: "duplicate_email_skipped" });
      return res.status(500).json({ error: error.message });
    }

    let matchResult = { matched: false };
    if (cleanNarr) matchResult = await tryMatchAndApprove(cleanNarr, Number(amount), alert.id);

    return res.json({ ok: true, alert_id: alert.id, ...matchResult });
  }

  // ══ 2. LOOKUP — check/approve by narration (used internally + debuggable) ══
  if (req.method === "GET" && action === "lookup") {
    const result = await lookupNarration(req.query.narration);
    return res.json(result);
  }

  // ══ 3. TELEGRAM WEBHOOK — the public deposit bot ════════════════════════════
  if (req.method === "POST" && !action) {
    const update = req.body;
    if (!update || !update.message) return res.status(200).json({ ok: true });

    const chatId = String(update.message.chat.id);
    const text = (update.message.text || "").trim();

    if (text === "/start") {
      await sendMessage(chatId,
        "👋 <b>Welcome to Vitel Deposit Bot!</b>\n\n" +
        "After making your bank transfer, send me your <b>narration code</b> " +
        "(e.g. <code>VTL-ABCDE-123456</code>) and I'll check it for you.\n\n" +
        "⚠️ You must include the narration in your transfer description — otherwise we can't match your payment."
      );
      return res.status(200).json({ ok: true });
    }

    const narration = extractNarration(text);
    if (!narration) {
      await sendMessage(chatId,
        "🤔 I couldn't find a narration code in that message.\n\n" +
        "Please send just your code, e.g. <code>VTL-ABCDE-123456</code> — you'll find it on the Recharge page after starting a manual deposit."
      );
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId, "🔎 Checking <code>" + narration + "</code>…");

    try {
      const d = await lookupNarration(narration);

      if (!d.found) {
        await sendMessage(chatId,
          "❌ No deposit found with narration <code>" + narration + "</code>.\n\n" +
          "Double-check the code, or contact customer service if you believe this is a mistake."
        );
      } else if (d.status === "completed") {
        await sendMessage(chatId, "✅ This deposit is already <b>confirmed and credited</b> to your wallet!");
      } else if (d.status === "rejected") {
        await sendMessage(chatId, "⚠️ This deposit was rejected. Please contact customer service.");
      } else if (d.alert_found && d.approved) {
        await sendMessage(chatId,
          "🎉 <b>Deposit confirmed!</b> ₦" + Number(d.amount || 0).toLocaleString() + " has been credited to your wallet."
        );
      } else if (d.alert_found && !d.approved) {
        await sendMessage(chatId,
          "⚠️ We found a matching bank alert but couldn't complete the credit automatically.\n\n" +
          "Please contact customer service and mention narration <code>" + narration + "</code>."
        );
      } else {
        await sendMessage(chatId,
          "⏳ We haven't received a matching bank alert for this narration yet.\n\n" +
          "This usually means:\n" +
          "• The transfer hasn't reflected yet — try again in a few minutes\n" +
          "• The narration wasn't included in your transfer description\n\n" +
          "If it's been more than 20–30 minutes, please contact customer service and mention this code."
        );
      }
    } catch (e) {
      console.error("[deposit-bot]", e);
      await sendMessage(chatId, "⚠️ Something went wrong. Please try again shortly or contact customer service.");
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown request" });
};
