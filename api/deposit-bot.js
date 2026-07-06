/**
 * /api/deposit-bot.js
 *
 * Handles TWO roles in one file:
 *
 * 1. POST ?action=ingest
 *    Google Apps Script posts parsed Gmail credit alerts here.
 *    Auth: header "x-vitel-secret" must match BANK_ALERT_INGEST_SECRET.
 *
 * 2. POST (no ?action) — Telegram webhook for the PUBLIC deposit bot.
 *    Flow:
 *      User sends narration → bot checks if a bank alert exists for it
 *        → if yes: bot asks "how much did you send?" (doesn't reveal the
 *          amount — this is a verification step)
 *        → user replies with the amount → if it matches the received
 *          alert, the deposit is approved immediately
 *        → if not found at all: bot tells them to contact support
 *
 * ── Why "normalize and search" instead of a fixed narration regex ──────────
 * Banks strip or reformat special characters in transfer descriptions
 * unpredictably (that's what broke the original dash-based format). Rather
 * than guessing an exact pattern, both the ingest step and the bot now:
 *   1. Strip everything except letters/numbers and uppercase both sides
 *   2. Check if the deposit's narration appears anywhere inside the email
 * This works regardless of dashes, spaces, or minor reformatting — it also
 * means old dash-format narrations already in your database still match
 * fine, no migration needed.
 *
 * ── Admin visibility ─────────────────────────────────────────────────────
 * Every auto-approval (whether triggered instantly on Gmail ingest, or via
 * a user confirming their amount in this bot) sends a message to your
 * EXISTING admin Telegram bot — same TELEGRAM_BOT_TOKEN and
 * TELEGRAM_ADMIN_CHAT_ID you already set up for api/telegram.js. No new
 * setup needed for that part.
 *
 * Env vars needed:
 *   TELEGRAM_DEPOSIT_BOT_TOKEN  — new bot token from @BotFather
 *                                 (a SEPARATE bot from your admin bot)
 *   BANK_ALERT_INGEST_SECRET    — any random string, shared with the
 *                                 Google Apps Script
 *   TELEGRAM_BOT_TOKEN          — already set (your admin bot)
 *   TELEGRAM_ADMIN_CHAT_ID      — already set (your admin chat)
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — already set
 */

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BOT_TOKEN = process.env.TELEGRAM_DEPOSIT_BOT_TOKEN;
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Reuses your EXISTING admin bot to notify you of auto-approvals.
const ADMIN_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT       = process.env.TELEGRAM_ADMIN_CHAT_ID;
const ADMIN_API        = `https://api.telegram.org/bot${ADMIN_BOT_TOKEN}`;

const AMOUNT_TOLERANCE  = 1;               // naira — allows for rounding
const SESSION_EXPIRY_MS = 15 * 60 * 1000;  // stale "awaiting amount" sessions expire after 15 min
const MAX_ATTEMPTS      = 5;               // wrong-amount attempts before session resets

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalize(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function parseAmount(text) {
  const m = (text || "").match(/[\d,]+(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(/,/g, ""));
  return isNaN(n) ? null : n;
}

async function sendMessage(chat_id, text) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML" }),
  });
}

async function notifyAdmin(text) {
  if (!ADMIN_BOT_TOKEN || !ADMIN_CHAT) return;
  try {
    await fetch(`${ADMIN_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: ADMIN_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (e) { console.warn("[deposit-bot] admin notify failed:", e.message); }
}

async function approveDeposit(deposit, amount, source) {
  const { data, error } = await supabase.rpc("process_deposit", {
    p_reference: deposit.reference,
    p_amount:    amount,
    p_payload:   { source },
  });
  if (error || !data?.ok) return { approved: false, error: error?.message || data?.error };

  const { data: profile } = await supabase
    .from("profiles").select("full_name,email").eq("id", deposit.user_id).single();

  await notifyAdmin(
    `✅ <b>Auto-approved via ${source === "gmail_ingest_match" ? "Gmail match" : "Deposit Bot"}</b>\n\n` +
    `👤 ${profile?.full_name || "Unknown"} (${profile?.email || ""})\n` +
    `💰 ₦${Number(amount).toLocaleString()}\n` +
    `🏷 Narration: <code>${deposit.narration}</code>\n` +
    `🆔 Ref: <code>${deposit.reference}</code>`
  );

  return { approved: true, data };
}

async function findDepositByNarrationInText(text) {
  const normText = normalize(text);
  if (!normText) return null;

  const { data: pending } = await supabase.from("deposits").select("*").eq("status", "pending");
  if (!pending || !pending.length) return null;

  for (const dep of pending) {
    const normNarr = normalize(dep.narration);
    if (normNarr && normText.includes(normNarr)) return dep;
  }
  return null;
}

async function findAlertForNarration(narration) {
  const { data: exact } = await supabase
    .from("bank_credit_alerts")
    .select("*")
    .eq("narration", narration)
    .eq("status", "unmatched")
    .order("received_at", { ascending: false })
    .limit(1);
  if (exact && exact[0]) return exact[0];

  const normNarr = normalize(narration);
  const { data: alerts } = await supabase
    .from("bank_credit_alerts")
    .select("*")
    .eq("status", "unmatched")
    .order("received_at", { ascending: false })
    .limit(50);
  if (!alerts) return null;
  return alerts.find(a => normalize(a.raw_snippet || "").includes(normNarr)) || null;
}

async function getSession(chatId) {
  const { data } = await supabase.from("bot_sessions").select("*").eq("chat_id", chatId).single();
  if (!data) return null;
  if (Date.now() - new Date(data.updated_at).getTime() > SESSION_EXPIRY_MS) return null;
  return data;
}
async function setSession(chatId, fields) {
  await supabase.from("bot_sessions").upsert({ chat_id: chatId, updated_at: new Date().toISOString(), ...fields });
}
async function clearSession(chatId) {
  await supabase.from("bot_sessions").delete().eq("chat_id", chatId);
}

module.exports = async function handler(req, res) {
  const action = req.query.action;

  // ══ INGEST — new bank credit alert from Google Apps Script ═══════════════════
  if (req.method === "POST" && action === "ingest") {
    const secret = req.headers["x-vitel-secret"];
    if (!secret || secret !== process.env.BANK_ALERT_INGEST_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { gmail_message_id, amount, raw_snippet, sender_email } = req.body || {};
    if (!gmail_message_id || !amount) {
      return res.status(400).json({ error: "gmail_message_id and amount required" });
    }

    const matchDep = await findDepositByNarrationInText(raw_snippet || "");

    const { data: alert, error } = await supabase
      .from("bank_credit_alerts")
      .insert({
        gmail_message_id,
        amount: Number(amount),
        narration: matchDep ? matchDep.narration : null,
        raw_snippet,
        sender_email,
        status: "unmatched",
      })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") return res.json({ ok: true, note: "duplicate_email_skipped" });
      return res.status(500).json({ error: error.message });
    }

    let approveResult = { approved: false };
    if (matchDep && Math.abs(Number(amount) - Number(matchDep.amount)) <= AMOUNT_TOLERANCE) {
      approveResult = await approveDeposit(matchDep, Number(amount), "gmail_ingest_match");
      if (approveResult.approved) {
        await supabase.from("bank_credit_alerts")
          .update({ status: "matched", matched_deposit_id: matchDep.id }).eq("id", alert.id);
      }
    }

    return res.json({ ok: true, alert_id: alert.id, narration_found: !!matchDep, ...approveResult });
  }

  // ══ TELEGRAM WEBHOOK — the public deposit bot ═════════════════════════════════
  if (req.method === "POST" && !action) {
    const update = req.body;
    if (!update || !update.message) return res.status(200).json({ ok: true });

    const chatId = String(update.message.chat.id);
    const text = (update.message.text || "").trim();

    if (text === "/start") {
      await clearSession(chatId);
      await sendMessage(chatId,
        "👋 <b>Welcome to Vitel Deposit Bot!</b>\n\n" +
        "After making your bank transfer, send me your <b>narration code</b> " +
        "(e.g. <code>VTLA1B2C3D4E5F</code>) and I'll check it for you.\n\n" +
        "⚠️ You must include the narration in your transfer description — otherwise we can't match your payment."
      );
      return res.status(200).json({ ok: true });
    }

    if (text === "/cancel") {
      await clearSession(chatId);
      await sendMessage(chatId, "Cancelled. Send me your narration code whenever you're ready.");
      return res.status(200).json({ ok: true });
    }

    const matchDep = await findDepositByNarrationInText(text);

    if (matchDep) {
      const alert = await findAlertForNarration(matchDep.narration);

      if (!alert) {
        await clearSession(chatId);
        await sendMessage(chatId,
          "⏳ We haven't received a matching bank alert for this narration yet.\n\n" +
          "This usually means:\n" +
          "• The transfer hasn't reflected yet — try again in a few minutes\n" +
          "• The narration wasn't included in your transfer description\n\n" +
          "If it's been more than 20–30 minutes, please contact customer service and mention this code."
        );
        return res.status(200).json({ ok: true });
      }

      await setSession(chatId, {
        state: "awaiting_amount",
        narration: matchDep.narration,
        alert_id: alert.id,
        deposit_id: matchDep.id,
        attempts: 0,
      });
      await sendMessage(chatId,
        "✅ Found a matching transfer for narration <code>" + matchDep.narration + "</code>!\n\n" +
        "To confirm it's really yours, please reply with the <b>exact amount</b> you sent (numbers only), e.g. <code>5000</code>"
      );
      return res.status(200).json({ ok: true });
    }

    const session = await getSession(chatId);
    if (session && session.state === "awaiting_amount") {
      const entered = parseAmount(text);
      if (entered === null) {
        await sendMessage(chatId, "Please reply with just the amount as a number, e.g. <code>5000</code>");
        return res.status(200).json({ ok: true });
      }

      const { data: alertRow } = await supabase.from("bank_credit_alerts").select("*").eq("id", session.alert_id).single();
      const { data: depRow }   = await supabase.from("deposits").select("*").eq("id", session.deposit_id).single();

      if (!alertRow || !depRow || depRow.status !== "pending") {
        await clearSession(chatId);
        await sendMessage(chatId, "This deposit is no longer pending — it may already have been approved. Check your wallet balance!");
        return res.status(200).json({ ok: true });
      }

      if (Math.abs(entered - Number(alertRow.amount)) <= AMOUNT_TOLERANCE) {
        const result = await approveDeposit(depRow, Number(alertRow.amount), "deposit_bot_confirmed");
        await clearSession(chatId);
        if (result.approved) {
          await supabase.from("bank_credit_alerts")
            .update({ status: "matched", matched_deposit_id: depRow.id }).eq("id", alertRow.id);
          await sendMessage(chatId,
            "🎉 <b>Confirmed!</b> ₦" + Number(alertRow.amount).toLocaleString() + " has been credited to your wallet."
          );
        } else {
          await sendMessage(chatId,
            "⚠️ We matched your transfer but couldn't complete the credit. Please contact customer service and mention narration <code>" + depRow.narration + "</code>."
          );
        }
      } else {
        const attempts = (session.attempts || 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await clearSession(chatId);
          await sendMessage(chatId, "❌ Too many incorrect attempts. Please send your narration code again to restart, or contact customer service.");
        } else {
          await setSession(chatId, { state: "awaiting_amount", narration: session.narration, alert_id: session.alert_id, deposit_id: session.deposit_id, attempts });
          await sendMessage(chatId, "That amount doesn't match what we received. Please check and try again, or send /cancel to start over.");
        }
      }
      return res.status(200).json({ ok: true });
    }

    await sendMessage(chatId,
      "🤔 I couldn't find a pending deposit matching that.\n\n" +
      "Send me your narration code from the Recharge page (e.g. <code>VTLA1B2C3D4E5F</code>), or /start for help."
    );
    return res.status(200).json({ ok: true });
  }

  return res.status(400).json({ error: "Unknown request" });
};
