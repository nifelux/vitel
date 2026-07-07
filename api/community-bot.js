/**
 * /api/community-bot.js
 *
 * Telegram bot for your Vitel discussion GROUP (not DMs).
 * Passively watches messages and auto-replies to:
 *   1. Greetings / "I'm new here"      → welcome message
 *   2. "How do I deposit?"             → deposit guide (matches live method)
 *   3. "How do I withdraw?"            → withdrawal guide (mentions if paused)
 *   4. "How does referral work?"       → referral bonus breakdown
 *   5. "What is VIP?"                  → VIP level requirements
 *
 * ══════════════════════════════════════════════════════════════════════════
 * CRITICAL SETUP STEP — read this or the bot will do nothing
 * ══════════════════════════════════════════════════════════════════════════
 * By default, Telegram bots in GROUPS only see messages that start with "/"
 * or that @mention them — NOT normal chat like "hi" or "how do I deposit".
 * You MUST disable this:
 *   1. Message @BotFather
 *   2. /setprivacy → select your new bot → choose "Disable"
 *   3. Do this BEFORE adding the bot to the group (or remove + re-add after)
 *
 * ── FULL SETUP ──────────────────────────────────────────────────────────────
 * 1. @BotFather → /newbot → get a token
 * 2. /setprivacy → Disable (see above — do not skip this)
 * 3. Add the bot to your Vitel discussion group as a member
 * 4. (Optional) Get the group's chat ID — forward any group message to
 *    @userinfobot — so the bot only ever replies in THIS group
 * 5. Set Vercel env vars (below)
 * 6. Register the webhook:
 *    https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://vitel-five.vercel.app/api/community-bot
 *
 * Env vars:
 *   TELEGRAM_COMMUNITY_BOT_TOKEN — new bot token from BotFather
 *   TELEGRAM_COMMUNITY_GROUP_ID  — (optional) restricts replies to just
 *                                  this group's chat ID
 *   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — already set
 */

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const BOT_TOKEN = process.env.TELEGRAM_COMMUNITY_BOT_TOKEN;
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;
const GROUP_ID  = process.env.TELEGRAM_COMMUNITY_GROUP_ID; // optional scoping

// ── Trigger patterns ───────────────────────────────────────────────────────
const GREETING_RE   = /^(hi+|hello+|hey+|hiya|yo|good\s?(morning|afternoon|evening)|greetings)\b/i;
const NEW_MEMBER_RE = /\b(i'?m\s*new|just\s*joined|new\s*here|new\s*to\s*(this|the)\s*group|newbie|new\s*member)\b/i;

// Every guide below requires a topic word AND a question-style word —
// so "I made a deposit yesterday" won't trigger, but "how do I deposit"
// or "deposit guide" will.
const HOWTO_RE    = /\b(how|what|guide|steps?|instructions?|help|process|explain)\b/i;
const DEPOSIT_RE  = /\b(deposit|recharge|top\s?-?up|fund(ing)?)\b/i;
const WITHDRAW_RE = /\b(withdraw(al)?|cash\s?-?out|payout)\b/i;
const REFERRAL_RE = /\b(refer(ral)?s?|invite|inviting)\b/i;
const VIP_RE      = /\bvip\b/i;

async function sendMessage(chat_id, text, reply_to_message_id) {
  await fetch(`${TG_API}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", reply_to_message_id }),
  });
}

// ── Guide builders — some check live settings so they never go stale ────────
async function getDepositGuideText() {
  const { data } = await supabase.from("site_settings").select("value").eq("key", "deposit_method").single();
  const method = data?.value || "manual";

  if (method === "paystack") {
    return "📋 <b>How to Deposit on Vitel</b>\n\n" +
      "1️⃣ Open the app → tap <b>Recharge</b>\n" +
      "2️⃣ Choose an amount (min ₦500) or enter a custom one\n" +
      "3️⃣ Tap Continue — a secure Paystack checkout opens\n" +
      "4️⃣ Pay by card, bank transfer, or USSD\n" +
      "5️⃣ Your wallet credits instantly after payment\n" +
      "6️⃣ Head to <b>Products</b> to invest and start earning daily! 🚀";
  }
  if (method === "ipayng") {
    return "📋 <b>How to Deposit on Vitel</b>\n\n" +
      "1️⃣ Open the app → tap <b>Recharge</b>\n" +
      "2️⃣ Choose an amount (min ₦500) or enter a custom one\n" +
      "3️⃣ You'll get bank transfer details via iPayNG\n" +
      "4️⃣ Complete the transfer\n" +
      "5️⃣ Your wallet credits automatically once confirmed\n" +
      "6️⃣ Head to <b>Products</b> to invest and start earning daily! 🚀";
  }
  return "📋 <b>How to Deposit on Vitel</b>\n\n" +
    "1️⃣ Open the app → tap <b>Recharge</b>\n" +
    "2️⃣ Choose an amount (min ₦500) or enter a custom one\n" +
    "3️⃣ You'll see a bank account + a unique <b>narration code</b>\n" +
    "4️⃣ Transfer the exact amount — and type the narration code as your transfer description\n" +
    "5️⃣ Your wallet credits automatically, usually within minutes\n" +
    "6️⃣ Head to <b>Products</b> to invest and start earning daily! 🚀\n\n" +
    "⚠️ Forgetting the narration code is the #1 reason deposits get delayed — always include it!";
}

async function getWithdrawalGuideText() {
  const { data } = await supabase.from("site_settings").select("value").eq("key", "withdrawals_locked").single();
  const locked = data?.value === "true";

  const base = "📋 <b>How to Withdraw on Vitel</b>\n\n" +
    "1️⃣ Open the app → tap <b>Withdraw</b>\n" +
    "2️⃣ Enter an amount (min ₦1,000)\n" +
    "3️⃣ Select a saved bank account, or add a new one\n" +
    "4️⃣ Submit — your request goes to the admin for approval\n" +
    "5️⃣ Funds arrive in your bank once approved\n\n" +
    "💡 Tip: Save your bank details once in <b>Bank Card</b> so future withdrawals are one tap.";

  return locked
    ? base + "\n\n⏸ <b>Note:</b> Withdrawals are temporarily paused right now — check back soon!"
    : base;
}

function getReferralGuideText() {
  return "📋 <b>How Referrals Work on Vitel</b>\n\n" +
    "Share your referral link from the <b>Team</b> page. When someone you invite deposits, you earn instantly:\n\n" +
    "🔹 Level 1 (Direct) → <b>20%</b>\n" +
    "🔹 Level 2 → <b>3%</b>\n" +
    "🔹 Level 3 → <b>2%</b>\n\n" +
    "Rewards go 3 levels deep and land in your wallet the moment your referral's deposit is approved.\n\n" +
    "💰 Build a big enough team and you also unlock a <b>monthly team salary</b> — 5% of your entire team's deposits, claimable on the 5th of each month!";
}

function getVipGuideText() {
  return "📋 <b>VIP Levels on Vitel</b>\n\n" +
    "Growing your team unlocks exclusive VIP plans with higher daily returns:\n\n" +
    "🥉 VIP 1 → 3 active referrals\n" +
    "🥈 VIP 2 → 5 active referrals\n" +
    "🔷 VIP 3 → 10 active referrals\n" +
    "💎 VIP 4 → 25 active referrals\n\n" +
    "An \"active\" referral is someone who has made at least one deposit. Check your progress anytime on the <b>Team</b> page!";
}

const WELCOME_TEXT =
  "👋 <b>Welcome to the Vitel community!</b> ⚡\n\n" +
  "We're glad to have you here. Vitel is an investment platform where you deposit, invest in a plan, and earn daily income.\n\n" +
  "💬 Ask any questions here — the community and team are happy to help.\n" +
  "📋 Try asking <b>\"how do I deposit\"</b>, <b>\"how does referral work\"</b>, or <b>\"what is VIP\"</b> anytime.";

// ── Ordered trigger list — first match wins, easy to extend later ───────────
const TRIGGERS = [
  { test: (t) => GREETING_RE.test(t) || NEW_MEMBER_RE.test(t), reply: async () => WELCOME_TEXT },
  { test: (t) => DEPOSIT_RE.test(t)  && HOWTO_RE.test(t),       reply: getDepositGuideText },
  { test: (t) => WITHDRAW_RE.test(t) && HOWTO_RE.test(t),       reply: getWithdrawalGuideText },
  { test: (t) => REFERRAL_RE.test(t) && HOWTO_RE.test(t),       reply: async () => getReferralGuideText() },
  { test: (t) => VIP_RE.test(t)      && HOWTO_RE.test(t),       reply: async () => getVipGuideText() },
];

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).end();

  const update = req.body;
  if (!update || !update.message) return res.status(200).json({ ok: true });

  const msg = update.message;
  if (msg.from?.is_bot) return res.status(200).json({ ok: true });

  if (GROUP_ID && String(msg.chat.id) !== String(GROUP_ID)) {
    return res.status(200).json({ ok: true });
  }

  const text = (msg.text || "").trim();
  if (!text) return res.status(200).json({ ok: true });

  const lower = text.toLowerCase();

  try {
    for (const trigger of TRIGGERS) {
      if (trigger.test(lower)) {
        const reply = await trigger.reply();
        await sendMessage(msg.chat.id, reply, msg.message_id);
        break;
      }
    }
  } catch (e) {
    console.error("[community-bot]", e);
  }

  return res.status(200).json({ ok: true });
};
