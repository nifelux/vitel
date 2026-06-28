/**
 * /api/webhooks/index.js
 * Handles Paystack + iPayNG webhooks
 */
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function rawBody(req) {
  return new Promise((resolve, reject) => {
    if(Buffer.isBuffer(req.body)) return resolve(req.body);
    if(typeof req.body==="string") return resolve(Buffer.from(req.body));
    const c=[]; req.on("data",d=>c.push(d)); req.on("end",()=>resolve(Buffer.concat(c))); req.on("error",reject);
  });
}

module.exports = async function(req, res) {
  if(req.method==="GET") return res.json({ ok:true, service:"Vitel Webhook" });
  if(req.method!=="POST") return res.status(405).end();
  const body = await rawBody(req);
  if(!body||!body.length) return res.json({ ok:true });

  const psSig = req.headers["x-paystack-signature"]||"";
  const ipSig = req.headers["signed-data"]||req.headers["signeddata"]||"";

  async function process(reference, amount, payload) {
    const { data,error } = await supabase.rpc("process_deposit",{ p_reference:reference, p_amount:amount, p_payload:payload });
    return { data, error };
  }

  // Paystack
  if(psSig) {
    const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY||"").update(body).digest("hex");
    if(hash!==psSig) return res.status(401).json({ error:"Invalid signature" });
    let p; try{ p=JSON.parse(body); }catch{ return res.status(400).end(); }
    if(p?.event!=="charge.success") return res.json({ ok:true, skipped:true });
    const { data,error } = await process(p.data.reference, p.data.amount/100, p);
    if(error) return res.status(500).json({ error:error.message });
    return res.json({ ok:true, data });
  }

  // iPayNG
  const secret = process.env.IPAYNG_SECRET;
  if(secret && ipSig) {
    const exp = crypto.createHmac("sha512",secret).update(body).digest("hex");
    try{ if(!crypto.timingSafeEqual(Buffer.from(exp,"hex"),Buffer.from(ipSig,"hex"))) return res.status(401).json({error:"Invalid signature"}); }
    catch{ return res.status(401).json({error:"Invalid signature"}); }
  }
  let p; try{ p=JSON.parse(body); }catch{ return res.json({ok:true}); }
  const ev=p?.event||p?.status;
  if(ev!=="payment.success"&&ev!=="successful") return res.json({ok:true,skipped:true});
  const ref=p?.data?.reference||p?.reference;
  const raw=p?.data?.amount||p?.amount||0;
  const amt=raw>100000?raw/100:raw;
  if(!ref) return res.status(400).json({error:"Missing reference"});
  const { data,error } = await process(ref, amt, p);
  if(error) return res.status(500).json({error:error.message});
  return res.json({ok:true,data});
};
module.exports.config = { api:{ bodyParser:false } };
      
