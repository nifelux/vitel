/* assets/js/supabase.js
   ⚠️  UPDATE THE TWO VALUES BELOW WITH YOUR REAL SUPABASE CREDENTIALS
   Get them from: Supabase Dashboard → Settings → API */

(function () {

  // ── EDIT THESE TWO LINES ─────────────────────────────────────────────────
  var SUPABASE_URL  = "https://ihsyblusjoagcrfxqceb.supabase.co";   // e.g. https://abcxyz.supabase.co
  var SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imloc3libHVzam9hZ2NyZnhxY2ViIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI2MjM4MzQsImV4cCI6MjA5ODE5OTgzNH0.zLrUqYgzAcEec4v40cNc2-MZcoOk83salJj68T9Qnvc"; // starts with eyJhbGci...
  // ─────────────────────────────────────────────────────────────────────────

  // Fallback: body data attributes (legacy, keep for compatibility)
  var url  = (SUPABASE_URL  && !SUPABASE_URL.includes("YOUR_"))  ? SUPABASE_URL  : document.body?.dataset?.supabaseUrl;
  var anon = (SUPABASE_ANON && !SUPABASE_ANON.includes("YOUR_")) ? SUPABASE_ANON : document.body?.dataset?.supabaseAnon;

  if (!url || url.includes("YOUR_") || !anon || anon.includes("YOUR_")) {
    console.error("❌ Supabase not configured. Open assets/js/supabase.js and replace YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY with your real credentials.");
    return;
  }

  if (!window.supabase) {
    console.error("❌ @supabase/supabase-js not loaded. Check your script tags.");
    return;
  }

  window.sb = window.supabase.createClient(url, anon, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true,
    }
  });

  console.log("✅ Supabase initialized");
})();
                           



/* assets/js/supabase.js
   Initialises window.sb from body data attributes.
   Load BEFORE auth.js and page scripts. */
(function () {
  var url  = document.body.dataset.supabaseUrl;
  var anon = document.body.dataset.supabaseAnon;
  if (!url || !anon) { console.error("Supabase config missing on <body>"); return; }
  window.sb = window.supabase.createClient(url, anon);
})();
