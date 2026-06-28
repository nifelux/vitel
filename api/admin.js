/**
 * /api/admin.js — All admin actions
 * GET  ?action=deposits&status=&admin_id=   → list deposits
 * GET  ?action=withdrawals&status=          → list withdrawals
 * GET  ?action=users                        → list users
 * GET  ?action=products                     → list products
 * POST ?action=set-method                   → switch deposit method
 * POST ?action=process-deposit              → approve/reject deposit
 * POST ?action=process-withdrawal           → approve/reject withdrawal
 * POST ?action=send-message                 → send message to user(s)
 * POST ?action=save-product                 → create/edit product
 * POST ?action=delete-product               → delete product
 * POST ?action=toggle-product               → lock/unlock product
 * POST ?action=set-user-admin               → make user admin
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function isAdmin(id) {
  if(!id) return false;
  const { data } = await supabase.from("profiles").select("is_admin").eq("id",id).single();
  return !!data?.is_admin;
}

module.exports = async function(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();

  const action = req.query.action;
  const admin_id = req.method==="GET" ? req.query.admin_id : req.body?.admin_id;
  if(!await isAdmin(admin_id)) return res.status(403).json({ error:"Unauthorized" });

  // ── GETs ──────────────────────────────────────────────────────────────────
  if(req.method==="GET") {
    if(action==="deposits") {
      const status = req.query.status||"pending";
      let q = supabase.from("deposits").select("*,profiles(full_name,email,referral_code)").order("created_at",{ascending:false}).limit(100);
      if(status!=="all") q=q.eq("status",status);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, deposits:data||[] });
    }
    if(action==="withdrawals") {
      const status = req.query.status||"pending";
      let q = supabase.from("withdrawals").select("*,profiles(full_name,email)").order("created_at",{ascending:false}).limit(100);
      if(status!=="all") q=q.eq("status",status);
      const { data,error } = await q;
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, withdrawals:data||[] });
    }
    if(action==="users") {
      const { data,error } = await supabase.from("profiles").select("*,wallets(balance)").order("created_at",{ascending:false}).limit(200);
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, users:data||[] });
    }
    if(action==="products") {
      const { data,error } = await supabase.from("products").select("*").order("sort_order");
      if(error) return res.status(500).json({ error:error.message });
      return res.json({ ok:true, products:data||[] });
    }
    if(action==="stats") {
      const [d,w,u,p] = await Promise.all([
        supabase.from("deposits").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("withdrawals").select("id",{count:"exact",head:true}).eq("status","pending"),
        supabase.from("profiles").select("id",{count:"exact",head:true}),
        supabase.from("user_products").select("id",{count:"exact",head:true}).eq("status","active"),
      ]);
      return res.json({ ok:true, pending_deposits:d.count||0, pending_withdrawals:w.count||0, total_users:u.count||0, active_products:p.count||0 });
    }
    return res.status(400).json({ error:"Unknown action" });
  }

  if(req.method!=="POST") return res.status(405).json({ error:"Method not allowed" });

  // ── POSTs ─────────────────────────────────────────────────────────────────
  if(action==="set-method") {
    const { method } = req.body;
    if(!["manual","paystack","ipayng"].includes(method)) return res.status(400).json({ error:"Invalid method" });
    const { error } = await supabase.from("site_settings").upsert({ key:"deposit_method", value:method, updated_at:new Date().toISOString() });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, method });
  }

  if(action==="process-deposit") {
    const { deposit_id, act } = req.body;
    if(!deposit_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"deposit_id and act required" });
    const { data:dep } = await supabase.from("deposits").select("*").eq("id",deposit_id).single();
    if(!dep) return res.status(404).json({ error:"Not found" });
    if(dep.status==="completed") return res.json({ ok:true, note:"already_completed" });
    if(dep.status==="rejected") return res.json({ ok:true, note:"already_rejected" });
    if(act==="reject") {
      await supabase.from("deposits").update({ status:"rejected", approved_by:admin_id, approved_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",deposit_id);
      return res.json({ ok:true, action:"rejected" });
    }
    await supabase.from("deposits").update({ approved_by:admin_id, approved_at:new Date().toISOString(), updated_at:new Date().toISOString() }).eq("id",deposit_id);
    const { data,error } = await supabase.rpc("process_deposit",{ p_reference:dep.reference, p_amount:dep.amount, p_payload:{ source:"admin_approval", admin_id } });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, action:"approved", data });
  }

  if(action==="process-withdrawal") {
    const { withdrawal_id, act, note } = req.body;
    if(!withdrawal_id||!["approve","reject"].includes(act)) return res.status(400).json({ error:"withdrawal_id and act required" });
    const { data:w } = await supabase.from("withdrawals").select("*").eq("id",withdrawal_id).single();
    if(!w) return res.status(404).json({ error:"Not found" });
    if(w.status!=="pending") return res.json({ ok:true, note:"already_processed" });
    await supabase.from("withdrawals").update({ status:act==="approve"?"approved":"rejected", note:note||null, processed_by:admin_id, processed_at:new Date().toISOString() }).eq("id",withdrawal_id);
    if(act==="reject") {
      // Refund
      await supabase.from("wallets").update({ balance:supabase.raw("balance + "+w.amount) }).eq("user_id",w.user_id);
      await supabase.from("wallet_transactions").insert({ user_id:w.user_id, type:"withdrawal_refund", amount:w.amount, description:"Withdrawal refunded" });
    }
    return res.json({ ok:true, action:act });
  }

  if(action==="send-message") {
    const { user_id, title, content } = req.body;
    if(!title||!content) return res.status(400).json({ error:"title and content required" });
    const { error } = await supabase.from("messages").insert({ user_id:user_id||null, sender_id:admin_id, title, content });
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="save-product") {
    const { id, name, description, type, vip_level, price, daily_income, duration_days, total_return, sort_order } = req.body;
    const payload = { name, description, type, vip_level:Number(vip_level||0), price:Number(price), daily_income:Number(daily_income), duration_days:Number(duration_days), total_return:Number(total_return), sort_order:Number(sort_order||0), updated_at:new Date().toISOString() };
    let error;
    if(id) { ({ error } = await supabase.from("products").update(payload).eq("id",id)); }
    else { ({ error } = await supabase.from("products").insert(payload)); }
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="delete-product") {
    const { product_id } = req.body;
    const { error } = await supabase.from("products").delete().eq("id",product_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="toggle-product") {
    const { product_id, status } = req.body;
    const { error } = await supabase.from("products").update({ status, updated_at:new Date().toISOString() }).eq("id",product_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  if(action==="set-admin") {
    const { target_user_id, is_admin } = req.body;
    const { error } = await supabase.from("profiles").update({ is_admin:!!is_admin }).eq("id",target_user_id);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true });
  }

  return res.status(400).json({ error:"Unknown action: "+action });
};
  
