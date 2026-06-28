/**
 * /api/user.js
 * POST ?action=update-profile   → update profile
 * POST ?action=add-bank-card    → add bank card
 * POST ?action=delete-bank-card → remove bank card
 * POST ?action=collect-income   → collect daily income from products
 * GET  ?action=bank-cards&user_id= → list bank cards
 * GET  ?action=my-products&user_id= → list user products
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const action   = req.query.action;
  const user_id  = req.method==="GET" ? req.query.user_id : req.body?.user_id;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  if(req.method==="GET") {
    if(action==="bank-cards") {
      const { data,error } = await supabase.from("bank_cards").select("*").eq("user_id",user_id).order("is_default",{ascending:false});
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, cards:data||[] });
    }
    if(action==="my-products") {
      const { data,error } = await supabase.from("user_products").select("*,products(name,description)").eq("user_id",user_id).order("created_at",{ascending:false});
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, products:data||[] });
    }
    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  if(action==="update-profile") {
    const { full_name, phone } = req.body;
    const { error } = await supabase.from("profiles").update({ full_name, phone, updated_at:new Date().toISOString() }).eq("id",user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="add-bank-card") {
    const { bank_name, account_number, account_name, is_default } = req.body;
    if(!bank_name||!account_number||!account_name) return res.status(400).json({ error:"All fields required" });
    if(is_default) {
      await supabase.from("bank_cards").update({ is_default:false }).eq("user_id",user_id);
    }
    const { error } = await supabase.from("bank_cards").insert({ user_id, bank_name, account_number, account_name, is_default:!!is_default });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-bank-card") {
    const { card_id } = req.body;
    const { error } = await supabase.from("bank_cards").delete().eq("id",card_id).eq("user_id",user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="collect-income") {
    const today = new Date().toISOString().slice(0,10);
    // Get active products not yet claimed today
    const { data:prods } = await supabase.from("user_products")
      .select("*").eq("user_id",user_id).eq("status","active")
      .or(`last_claim_date.is.null,last_claim_date.lt.${today}`);

    if(!prods||!prods.length) return res.json({ ok:false, error:"Nothing to collect today" });

    let total = 0;
    for(const p of prods) {
      const newDays = (p.days_collected||0) + 1;
      const earned  = (p.total_earned||0) + p.daily_income;
      const done    = newDays >= p.duration_days;
      await supabase.from("user_products").update({
        days_collected: newDays,
        total_earned:   earned,
        last_claim_date: today,
        status: done ? "completed" : "active",
      }).eq("id",p.id);
      total += p.daily_income;
    }

    // Credit wallet
    const { data:w } = await supabase.from("wallets").select("balance,total_profit").eq("user_id",user_id).single();
    await supabase.from("wallets").update({
      balance:       (w?.balance||0) + total,
      total_profit:  (w?.total_profit||0) + total,
      updated_at:    new Date().toISOString(),
    }).eq("user_id",user_id);
    await supabase.from("wallet_transactions").insert({ user_id, type:"daily_income", amount:total, description:"Daily income from "+prods.length+" product(s)" });

    return res.json({ ok:true, amount:total, products:prods.length });
  }

  return res.status(400).json({ error:"Unknown action" });
};
    
