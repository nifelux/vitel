/**
 * /api/bonus.js
 * POST ?action=daily-checkin
 * POST ?action=monthly-salary
 * POST ?action=redeem-gift
 * GET  ?action=checkin-status&user_id=
 * GET  ?action=salary-status&user_id=
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const user_id = req.method==="GET" ? req.query.user_id : req.body?.user_id;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  if(req.method==="GET") {
    if(action==="checkin-status") {
      const today = new Date().toISOString().slice(0,10);
      const { data } = await supabase.from("daily_checkins").select("id,date").eq("user_id",user_id).eq("date",today).single();
      return res.json({ ok:true, claimed: !!data, date:today });
    }
    if(action==="salary-status") {
      const month = new Date().toISOString().slice(0,7);
      const day   = new Date().getDate();
      const { data } = await supabase.from("monthly_salary_claims").select("id,amount").eq("user_id",user_id).eq("month",month).single();
      return res.json({ ok:true, claimed:!!data, amount:data?.amount||0, month, can_claim:day>=5 });
    }
    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  if(action==="daily-checkin") {
    const { data,error } = await supabase.rpc("claim_daily_bonus",{ p_user_id:user_id });
    if(error) return res.status(500).json({ error:error.message });
    return res.json(data);
  }

  if(action==="monthly-salary") {
    const { data,error } = await supabase.rpc("claim_monthly_salary",{ p_user_id:user_id });
    if(error) return res.status(500).json({ error:error.message });
    return res.json(data);
  }

  if(action==="redeem-gift") {
    const { code } = req.body;
    if(!code) return res.status(400).json({ error:"code required" });
    const { data:gift } = await supabase.from("gift_codes").select("*").eq("code",code.toUpperCase()).single();
    if(!gift) return res.json({ ok:false, error:"Invalid gift code" });
    if(gift.status!=="active") return res.json({ ok:false, error:"Gift code is inactive" });
    if(gift.expires_at && new Date(gift.expires_at)<new Date()) return res.json({ ok:false, error:"Gift code has expired" });
    if(gift.uses>=gift.max_uses) return res.json({ ok:false, error:"Gift code has been fully used" });
    // Check already redeemed
    const { data:red } = await supabase.from("gift_code_redemptions").select("id").eq("gift_code_id",gift.id).eq("user_id",user_id).single();
    if(red) return res.json({ ok:false, error:"You have already redeemed this code" });
    // Redeem
    await supabase.from("gift_code_redemptions").insert({ gift_code_id:gift.id, user_id, amount:gift.amount });
    await supabase.from("gift_codes").update({ uses:gift.uses+1, ...(gift.uses+1>=gift.max_uses?{status:"used"}:{}) }).eq("id",gift.id);
    await supabase.from("wallets").upsert({ user_id, balance:gift.amount },{ onConflict:"user_id" });
    await supabase.rpc("", {}); // handled below
    // Direct credit
    const { error:we } = await supabase.from("wallets").update({ balance:supabase.rpc }).eq("user_id",user_id);
    // Simpler approach
    await supabase.from("wallets").select("balance").eq("user_id",user_id).single().then(async ({data:w})=>{
      await supabase.from("wallets").update({ balance:(w?.balance||0)+gift.amount, updated_at:new Date().toISOString() }).eq("user_id",user_id);
    });
    await supabase.from("wallet_transactions").insert({ user_id, type:"gift_code", amount:gift.amount, description:"Gift code: "+code.toUpperCase() });
    return res.json({ ok:true, amount:gift.amount, code:gift.code });
  }

  return res.status(400).json({ error:"Unknown action" });
};
                                                                                           
