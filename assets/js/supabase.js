/* assets/js/supabase.js
   ⚠️  PUT YOUR REAL SUPABASE CREDENTIALS BELOW
   Supabase Dashboard → Settings → API */

(function () {

  // ── EDIT THESE TWO LINES ──────────────────────────────────────────────────
  var SUPABASE_URL  = "https://ihsyblusjoagcrfxqceb.supabase.co";     // https://xxxx.supabase.co
  var SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imloc3libHVzam9hZ2NyZnhxY2ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MjM4MzQsImV4cCI6MjA5ODE5OTgzNH0.zLrUqYgzAcEec4v40cNc2-MZcoOk83salJj68T9Qnvc"; // eyJhbGci...
  // ──────────────────────────────────────────────────────────────────────────

  var url  = SUPABASE_URL;
  var anon = SUPABASE_ANON;

  if (!url || url === "YOUR_SUPABASE_URL") {
    console.error("❌ VITEL: Supabase not configured. Open assets/js/supabase.js and add your credentials.");
    return;
  }

  if (typeof window.supabase === "undefined") {
    console.error("❌ VITEL: @supabase/supabase-js not loaded yet.");
    return;
  }

  window.sb = window.supabase.createClient(url, anon, {
    auth: {
      autoRefreshToken:    true,
      persistSession:      true,
      detectSessionInUrl:  true,
    }
  });

  console.log("✅ Vitel: Supabase ready");
})();
