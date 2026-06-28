/* assets/js/supabase.js
   Initialises window.sb from body data attributes.
   Load BEFORE auth.js and page scripts. */
(function () {
  var url  = document.body.dataset.supabaseUrl;
  var anon = document.body.dataset.supabaseAnon;
  if (!url || !anon) { console.error("Supabase config missing on <body>"); return; }
  window.sb = window.supabase.createClient(url, anon);
})();
