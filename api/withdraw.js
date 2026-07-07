/**
 * /api/withdraw.js
 * POST → request withdrawal
 * GET  ?action=history&user_id=
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  // Public status check — no admin_id needed, just tells the withdraw
  // page whether the button should be disabled.
  if(req.method==="GET" && req.query.action==="lock-status") {
    const { data } = await supabase.from("site_settings").select("value").eq("key","withdrawals_locked").single();
    return res.json({ ok:true, locked: data?.value === "true" });
  }

  // Public limits check — lets the withdraw page show/validate against
  // the admin's currently configured min/max before submitting.
  if(req.method==="GET" && req.query.action==="limits") {
    const { data } = await supabase.from("site_settings").select("key,value").in("key",["min_withdraw","max_withdraw"]);
    const min = Number(data?.find(s=>s.key==="min_withdraw")?.value || 1000);
    const max = Number(data?.find(s=>s.key==="max_withdraw")?.value || 0);
    return res.json({ ok:true, min, max });
  }

  const user_id = req.method==="GET" ? req.query.user_id : req.body?.user_id;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  if(req.method==="GET") {
    const { data,error } = await supabase.from("withdrawals").select("*").eq("user_id",user_id).order("created_at",{ascending:false}).limit(50);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, withdrawals:data||[] });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  // Enforce the admin's global lock — checked here too (not just on the
  // frontend) so the lock can't be bypassed by calling the API directly.
  const { data:lockSetting } = await supabase.from("site_settings").select("value").eq("key","withdrawals_locked").single();
  if(lockSetting?.value === "true") {
    return res.json({ ok:false, error:"Withdrawals are temporarily paused. Please check back later." });
  }

  const { amount, bank_name, account_number, account_name } = req.body;
  if(!amount||!bank_name||!account_number||!account_name) return res.status(400).json({ error:"All fields required" });
  const num = Number(amount);

  // Dynamic min/max — admin-configurable, no longer hardcoded.
  const { data:limitSettings } = await supabase.from("site_settings").select("key,value").in("key",["min_withdraw","max_withdraw"]);
  const minW = Number(limitSettings?.find(s=>s.key==="min_withdraw")?.value || 1000);
  const maxW = Number(limitSettings?.find(s=>s.key==="max_withdraw")?.value || 0);

  if(num < minW) return res.json({ ok:false, error:`Minimum withdrawal is ₦${minW.toLocaleString()}` });
  if(maxW > 0 && num > maxW) return res.json({ ok:false, error:`Maximum withdrawal is ₦${maxW.toLocaleString()}` });

  // Check balance
  const { data:w } = await supabase.from("wallets").select("balance").eq("user_id",user_id).single();
  if(!w || w.balance < num) return res.json({ ok:false, error:"Insufficient balance" });

  // Get profile for Telegram notification
  const { data:profile } = await supabase
    .from("profiles").select("full_name,email").eq("id",user_id).single();

  // Deduct balance
  await supabase.from("wallets").update({ balance:w.balance-num, total_withdrawn:(w.total_withdrawn||0)+num, updated_at:new Date().toISOString() }).eq("user_id",user_id);
  await supabase.from("wallet_transactions").insert({ user_id, type:"withdrawal", amount:-num, description:"Withdrawal request" });

  const { data:wit, error } = await supabase.from("withdrawals")
    .insert({ user_id, amount:num, bank_name, account_number, account_name, status:"pending" })
    .select().single();
  if(error) return res.status(500).json({ error:error.message });

  // Ping Telegram bot — non-blocking
  try {
    const { notifyWithdrawal } = require("./telegram");
    await notifyWithdrawal({
      id: wit.id, amount: num,
      bank_name, account_number, account_name,
      user_name:  profile?.full_name || "Unknown",
      user_email: profile?.email || "",
    });
  } catch(e) { console.warn("[withdraw] Telegram notify failed:", e.message); }

  return res.json({ ok:true });
};
