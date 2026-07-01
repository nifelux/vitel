/**
 * /api/team.js
 * GET ?user_id=UUID
 * Returns L1/L2/L3 team members with active status + referral earnings.
 * Uses service-role key to bypass RLS — the client-side query was
 * returning 0 rows because RLS only allows users to see their own profile.
 */
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="GET") return res.status(405).json({ error:"Method not allowed" });

  const { user_id } = req.query;
  if(!user_id) return res.status(400).json({ error:"user_id required" });

  try {
    // L1 members
    const { data:l1 } = await supabase
      .from("profiles")
      .select("id,full_name,email,created_at")
      .eq("referred_by", user_id)
      .order("created_at",{ascending:false});
    const l1List = l1||[];

    // Which L1 members have made a deposit (= "active")
    const l1Ids = l1List.map(m=>m.id);
    let activeSet = new Set();
    if(l1Ids.length){
      const { data:deps } = await supabase
        .from("deposits")
        .select("user_id")
        .eq("status","completed")
        .in("user_id", l1Ids);
      (deps||[]).forEach(d=>activeSet.add(d.user_id));
    }
    const l1WithStatus = l1List.map(m=>({...m, isActive:activeSet.has(m.id)}));

    // L2 members
    let l2List = [];
    if(l1Ids.length){
      const { data:l2 } = await supabase
        .from("profiles")
        .select("id,full_name,email,created_at,referred_by")
        .in("referred_by", l1Ids)
        .order("created_at",{ascending:false});
      l2List = l2||[];
    }

    // L3 members
    let l3List = [];
    const l2Ids = l2List.map(m=>m.id);
    if(l2Ids.length){
      const { data:l3 } = await supabase
        .from("profiles")
        .select("id,full_name,email,created_at")
        .in("referred_by", l2Ids)
        .order("created_at",{ascending:false});
      l3List = l3||[];
    }

    // Referral earnings
    const { data:rewards } = await supabase
      .from("referral_rewards")
      .select("amount")
      .eq("referrer_id", user_id);
    const totalEarned = (rewards||[]).reduce((s,r)=>s+Number(r.amount||0),0);

    return res.json({
      ok: true,
      l1: l1WithStatus,
      l2: l2List,
      l3: l3List,
      active_count: activeSet.size,
      total_team: l1List.length + l2List.length + l3List.length,
      earned: totalEarned,
    });

  } catch(e) {
    console.error("[team]", e);
    return res.status(500).json({ error: e.message });
  }
};
  
