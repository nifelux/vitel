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
      const { data:claim } = await supabase.from("monthly_salary_claims").select("id,amount").eq("user_id",user_id).eq("month",month).single();

      if(claim) {
        return res.json({ ok:true, claimed:true, amount:claim.amount, month, can_claim:day>=5 });
      }

      // Not claimed yet this month — compute a LIVE estimate so the user
      // can see what they'd get, instead of always showing ₦0.
      const { data:l1 } = await supabase.from("profiles").select("id").eq("referred_by",user_id);
      const l1Ids = (l1||[]).map(r=>r.id);

      let l2Ids = [];
      if(l1Ids.length) {
        const { data:l2 } = await supabase.from("profiles").select("id").in("referred_by",l1Ids);
        l2Ids = (l2||[]).map(r=>r.id);
      }

      let l3Ids = [];
      if(l2Ids.length) {
        const { data:l3 } = await supabase.from("profiles").select("id").in("referred_by",l2Ids);
        l3Ids = (l3||[]).map(r=>r.id);
      }

      const allTeamIds = [...l1Ids, ...l2Ids, ...l3Ids];
      let estimate = 0;

      if(allTeamIds.length) {
        const monthStart = month + "-01";
        const { data:deps } = await supabase.from("deposits")
          .select("amount")
          .eq("status","completed")
          .in("user_id", allTeamIds)
          .gte("paid_at", monthStart);
        const total = (deps||[]).reduce((s,d)=>s+Number(d.amount||0),0);
        estimate = Math.round(total * 0.05 * 100) / 100;
      }

      return res.json({ ok:true, claimed:false, amount:estimate, month, can_claim:day>=5 });
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

    const cleanCode = String(code).trim().toUpperCase();
    const { data:gift } = await supabase.from("gift_codes").select("*").eq("code",cleanCode).single();
    if(!gift) return res.json({ ok:false, error:"Invalid gift code" });
    if(gift.status!=="active") return res.json({ ok:false, error:"Gift code is inactive" });
    if(gift.expires_at && new Date(gift.expires_at)<new Date()) return res.json({ ok:false, error:"Gift code has expired" });
    if(gift.uses>=gift.max_uses) return res.json({ ok:false, error:"Gift code has been fully used" });

    // Check already redeemed
    const { data:red } = await supabase.from("gift_code_redemptions").select("id").eq("gift_code_id",gift.id).eq("user_id",user_id).single();
    if(red) return res.json({ ok:false, error:"You have already redeemed this code" });

    // Record the redemption — unique constraint on (gift_code_id, user_id)
    // catches any race condition from a double-tap on the button.
    const { error:redErr } = await supabase.from("gift_code_redemptions").insert({ gift_code_id:gift.id, user_id, amount:gift.amount });
    if(redErr) {
      if(redErr.code === "23505") return res.json({ ok:false, error:"You have already redeemed this code" });
      return res.status(500).json({ ok:false, error:redErr.message });
    }

    // Bump usage count on the code
    const newUses = gift.uses + 1;
    await supabase.from("gift_codes").update({
      uses: newUses,
      ...(newUses >= gift.max_uses ? { status:"used" } : {})
    }).eq("id",gift.id);

    // Credit wallet exactly once: read current balance, add gift amount, write back.
    const { data:wallet } = await supabase.from("wallets").select("balance").eq("user_id",user_id).single();
    const newBalance = Number(wallet?.balance || 0) + Number(gift.amount);
    await supabase.from("wallets").upsert({
      user_id, balance:newBalance, updated_at:new Date().toISOString()
    }, { onConflict:"user_id" });

    await supabase.from("wallet_transactions").insert({
      user_id, type:"gift_code", amount:gift.amount, description:"Gift code: "+cleanCode
    });

    return res.json({ ok:true, amount:gift.amount, code:gift.code });
  }

  return res.status(400).json({ error:"Unknown action" });
};
    
