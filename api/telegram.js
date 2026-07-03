/**
 * /api/telegram.js
 * Telegram Bot webhook — admin approval of deposits & withdrawals
 *
 * Setup:
 * 1. Create a bot via @BotFather → get TELEGRAM_BOT_TOKEN
 * 2. Get your Telegram chat ID → set as TELEGRAM_ADMIN_CHAT_ID
 * 3. Register webhook:
 *    https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://YOUR_DOMAIN/api/telegram
 *
 * Vercel env vars needed:
 *   TELEGRAM_BOT_TOKEN      — from @BotFather
 *   TELEGRAM_ADMIN_CHAT_ID  — your personal Telegram chat ID
 */

const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT = process.env.TELEGRAM_ADMIN_CHAT_ID;
const API_BASE   = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ─────────────────────────────────────────────────────
async function sendMessage(chat_id, text, reply_markup) {
  const body = { chat_id, text, parse_mode: "HTML" };
  if(reply_markup) body.reply_markup = reply_markup;
  await fetch(`${API_BASE}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function editMessage(chat_id, message_id, text) {
  await fetch(`${API_BASE}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, message_id, text, parse_mode: "HTML" }),
  });
}

async function answerCallback(callback_query_id, text) {
  await fetch(`${API_BASE}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id, text }),
  });
}

// ── Notify admin of new deposit (called by deposit.js) ────────────────────────
// This function is exported so deposit.js can import and call it.
async function notifyDeposit(deposit) {
  if(!BOT_TOKEN || !ADMIN_CHAT) return;
  const text =
    `💳 <b>New Manual Deposit</b>\n\n` +
    `👤 User: ${deposit.user_name || "Unknown"}\n` +
    `📧 Email: ${deposit.user_email || "—"}\n` +
    `💰 Amount: <b>₦${Number(deposit.amount).toLocaleString()}</b>\n` +
    `🏷 Narration: <code>${deposit.narration}</code>\n` +
    `🆔 Deposit ID: <code>${deposit.id}</code>\n` +
    `⏰ Time: ${new Date().toLocaleString("en-NG")}`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Approve",  callback_data: `dep_approve:${deposit.id}` },
      { text: "❌ Reject",   callback_data: `dep_reject:${deposit.id}`  },
    ]]
  };

  await sendMessage(ADMIN_CHAT, text, keyboard);
}

// ── Notify admin of new withdrawal ────────────────────────────────────────────
async function notifyWithdrawal(withdrawal) {
  if(!BOT_TOKEN || !ADMIN_CHAT) return;
  const text =
    `💸 <b>New Withdrawal Request</b>\n\n` +
    `👤 User: ${withdrawal.user_name || "Unknown"}\n` +
    `📧 Email: ${withdrawal.user_email || "—"}\n` +
    `💰 Amount: <b>₦${Number(withdrawal.amount).toLocaleString()}</b>\n` +
    `🏦 Bank: ${withdrawal.bank_name}\n` +
    `🔢 Account: <code>${withdrawal.account_number}</code>\n` +
    `👁 Name: ${withdrawal.account_name}\n` +
    `🆔 ID: <code>${withdrawal.id}</code>\n` +
    `⏰ Time: ${new Date().toLocaleString("en-NG")}`;

  const keyboard = {
    inline_keyboard: [[
      { text: "✅ Approve",  callback_data: `wit_approve:${withdrawal.id}` },
      { text: "❌ Reject",   callback_data: `wit_reject:${withdrawal.id}`  },
    ]]
  };

  await sendMessage(ADMIN_CHAT, text, keyboard);
}

// ── Main webhook handler ──────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Telegram always sends POST
  if(req.method !== "POST") return res.status(200).end();

  const update = req.body;

  // ── Handle /start and /pending commands ──────────────────────────────────
  if(update.message) {
    const msg  = update.message;
    const text = (msg.text || "").trim();
    const chatId = String(msg.chat.id);

    // Only respond to admin
    if(chatId !== ADMIN_CHAT) {
      await sendMessage(chatId, "⛔ You are not authorized to use this bot.");
      return res.status(200).json({ ok:true });
    }

    if(text === "/start") {
      await sendMessage(ADMIN_CHAT,
        `👋 <b>Vitel Admin Bot</b>\n\n` +
        `I'll notify you instantly when:\n` +
        `• 💳 A new manual deposit is submitted\n` +
        `• 💸 A new withdrawal is requested\n\n` +
        `You can approve or reject directly from Telegram.\n\n` +
        `<b>Commands:</b>\n` +
        `/pending — view pending deposits & withdrawals\n` +
        `/stats — quick dashboard stats`
      );
    }

    if(text === "/pending") {
      // Fetch pending deposits
      const { data:deps } = await supabase
        .from("deposits")
        .select("*, profiles!user_id(full_name,email)")
        .eq("status","pending")
        .order("created_at",{ascending:false})
        .limit(10);

      // Fetch pending withdrawals
      const { data:wits } = await supabase
        .from("withdrawals")
        .select("*, profiles!user_id(full_name,email)")
        .eq("status","pending")
        .order("created_at",{ascending:false})
        .limit(10);

      const dCount = (deps||[]).length;
      const wCount = (wits||[]).length;

      if(!dCount && !wCount) {
        await sendMessage(ADMIN_CHAT, "✅ No pending deposits or withdrawals.");
        return res.status(200).json({ ok:true });
      }

      await sendMessage(ADMIN_CHAT,
        `📋 <b>Pending Queue</b>\n\n` +
        `💳 Deposits: ${dCount}\n` +
        `💸 Withdrawals: ${wCount}`
      );

      // Send each deposit with buttons
      for(const d of (deps||[])) {
        const t =
          `💳 <b>Pending Deposit</b>\n` +
          `👤 ${d.profiles?.full_name||"Unknown"} (${d.profiles?.email||""})\n` +
          `💰 ₦${Number(d.amount).toLocaleString()}\n` +
          `🏷 Narration: <code>${d.narration||"—"}</code>\n` +
          `🆔 <code>${d.id}</code>`;
        await sendMessage(ADMIN_CHAT, t, {
          inline_keyboard:[[
            { text:"✅ Approve", callback_data:`dep_approve:${d.id}` },
            { text:"❌ Reject",  callback_data:`dep_reject:${d.id}`  },
          ]]
        });
      }

      // Send each withdrawal with buttons
      for(const w of (wits||[])) {
        const t =
          `💸 <b>Pending Withdrawal</b>\n` +
          `👤 ${w.profiles?.full_name||"Unknown"} (${w.profiles?.email||""})\n` +
          `💰 ₦${Number(w.amount).toLocaleString()}\n` +
          `🏦 ${w.bank_name} · ${w.account_number}\n` +
          `👁 ${w.account_name}\n` +
          `🆔 <code>${w.id}</code>`;
        await sendMessage(ADMIN_CHAT, t, {
          inline_keyboard:[[
            { text:"✅ Approve", callback_data:`wit_approve:${w.id}` },
            { text:"❌ Reject",  callback_data:`wit_reject:${w.id}`  },
          ]]
        });
      }
    }

    if(text === "/stats") {
      const [d,w,u,p] = await Promise.all([
        supabase.from("deposits").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("withdrawals").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("profiles").select("id",{count:"exact",head:true}),
        supabase.from("user_products").select("id",{count:"exact",head:true}).eq("status","active"),
      ]);
      await sendMessage(ADMIN_CHAT,
        `📊 <b>Vitel Stats</b>\n\n` +
        `👥 Total Users: ${u.count||0}\n` +
        `📦 Active Products: ${p.count||0}\n` +
        `💳 Pending Deposits: ${d.count||0}\n` +
        `💸 Pending Withdrawals: ${w.count||0}`
      );
    }

    return res.status(200).json({ ok:true });
  }

  // ── Handle inline button taps (callback_query) ────────────────────────────
  if(update.callback_query) {
    const cb      = update.callback_query;
    const chatId  = String(cb.message.chat.id);
    const msgId   = cb.message.message_id;
    const data    = cb.data || "";

    if(chatId !== ADMIN_CHAT) {
      await answerCallback(cb.id, "⛔ Not authorized");
      return res.status(200).json({ ok:true });
    }

    const [action, id] = data.split(":");

    // ── Deposit actions ─────────────────────────────────────────────────────
    if(action === "dep_approve" || action === "dep_reject") {
      const act = action === "dep_approve" ? "approve" : "reject";
      await answerCallback(cb.id, act === "approve" ? "Processing approval…" : "Rejecting…");

      const { data:dep } = await supabase.from("deposits").select("*").eq("id",id).single();

      if(!dep) {
        await editMessage(chatId, msgId, "❌ Deposit not found.");
        return res.status(200).json({ ok:true });
      }
      if(dep.status === "completed") {
        await editMessage(chatId, msgId, cb.message.text + "\n\n✅ <b>Already approved</b>");
        return res.status(200).json({ ok:true });
      }
      if(dep.status === "rejected") {
        await editMessage(chatId, msgId, cb.message.text + "\n\n❌ <b>Already rejected</b>");
        return res.status(200).json({ ok:true });
      }

      if(act === "reject") {
        await supabase.from("deposits").update({
          status:"rejected", updated_at:new Date().toISOString()
        }).eq("id",id);
        await editMessage(chatId, msgId, cb.message.text + "\n\n❌ <b>REJECTED</b>");
        // Notify user via in-app message
        await supabase.from("messages").insert({
          user_id: dep.user_id, sender_id: null,
          title: "Deposit Rejected",
          content: `Your deposit of ₦${Number(dep.amount).toLocaleString()} was rejected. Please contact support if this is an error.`,
        });
      } else {
        // Approve — run the RPC
        const { data:result } = await supabase.rpc("process_deposit", {
          p_reference: dep.reference,
          p_amount:    dep.amount,
          p_payload:   { source:"telegram_admin_approval" },
        });
        if(!result?.ok) {
          await editMessage(chatId, msgId, cb.message.text + "\n\n⚠️ Error: " + (result?.error||"Unknown"));
          return res.status(200).json({ ok:true });
        }
        await editMessage(chatId, msgId, cb.message.text + "\n\n✅ <b>APPROVED — ₦" + Number(dep.amount).toLocaleString() + " credited</b>");
        // Notify user
        await supabase.from("messages").insert({
          user_id: dep.user_id, sender_id: null,
          title: "Deposit Approved ✅",
          content: `Your deposit of ₦${Number(dep.amount).toLocaleString()} has been approved and credited to your wallet!`,
        });
      }
    }

    // ── Withdrawal actions ──────────────────────────────────────────────────
    if(action === "wit_approve" || action === "wit_reject") {
      const act = action === "wit_approve" ? "approve" : "reject";
      await answerCallback(cb.id, act === "approve" ? "Marking approved…" : "Rejecting…");

      const { data:wit } = await supabase.from("withdrawals").select("*").eq("id",id).single();

      if(!wit) {
        await editMessage(chatId, msgId, "❌ Withdrawal not found.");
        return res.status(200).json({ ok:true });
      }
      if(wit.status !== "pending") {
        await editMessage(chatId, msgId, cb.message.text + `\n\n⚠️ Already <b>${wit.status}</b>`);
        return res.status(200).json({ ok:true });
      }

      await supabase.from("withdrawals").update({
        status: act === "approve" ? "approved" : "rejected",
        processed_at: new Date().toISOString(),
      }).eq("id",id);

      if(act === "reject") {
        // Refund wallet
        const { data:wallet } = await supabase.from("wallets").select("balance,total_withdrawn").eq("user_id",wit.user_id).single();
        await supabase.from("wallets").update({
          balance: Number(wallet?.balance||0) + Number(wit.amount),
          total_withdrawn: Math.max(0, Number(wallet?.total_withdrawn||0) - Number(wit.amount)),
          updated_at: new Date().toISOString(),
        }).eq("user_id",wit.user_id);
        await supabase.from("wallet_transactions").insert({
          user_id:wit.user_id, type:"withdrawal_refund", amount:wit.amount, description:"Withdrawal refunded"
        });
        await editMessage(chatId, msgId, cb.message.text + "\n\n❌ <b>REJECTED — ₦" + Number(wit.amount).toLocaleString() + " refunded</b>");
        await supabase.from("messages").insert({
          user_id:wit.user_id, sender_id:null,
          title:"Withdrawal Rejected",
          content:`Your withdrawal of ₦${Number(wit.amount).toLocaleString()} was rejected and the funds have been returned to your wallet.`,
        });
      } else {
        await editMessage(chatId, msgId, cb.message.text + "\n\n✅ <b>APPROVED — Please process the bank transfer manually</b>");
        await supabase.from("messages").insert({
          user_id:wit.user_id, sender_id:null,
          title:"Withdrawal Approved ✅",
          content:`Your withdrawal of ₦${Number(wit.amount).toLocaleString()} to ${wit.bank_name} (${wit.account_number}) has been approved and is being processed.`,
        });
      }
    }

    return res.status(200).json({ ok:true });
  }

  return res.status(200).json({ ok:true });
};

// Export notify helpers so deposit.js and withdraw.js can call them
module.exports.notifyDeposit    = notifyDeposit;
module.exports.notifyWithdrawal = notifyWithdrawal;
