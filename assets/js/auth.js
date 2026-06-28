/* assets/js/auth.js
   Shared auth helpers. Exposes window.VitelAuth. */
(function () {
  window.VitelAuth = {

    /* Require auth — redirects to login if not logged in */
    requireAuth: async function () {
      var { data: { session } } = await window.sb.auth.getSession();
      if (!session) { location.href = "/index.html"; return null; }
      return session;
    },

    /* Require admin */
    requireAdmin: async function () {
      var session = await this.requireAuth();
      if (!session) return null;
      var { data: p } = await window.sb.from("profiles").select("is_admin").eq("id", session.user.id).single();
      if (!p?.is_admin) { location.href = "/dashboard.html"; return null; }
      return session;
    },

    /* Load profile and fill [data-auth] elements */
    loadProfile: async function (userId) {
      var { data: p } = await window.sb.from("profiles").select("*").eq("id", userId).single();
      if (!p) return null;
      document.querySelectorAll("[data-auth]").forEach(function (el) {
        var key = el.dataset.auth;
        if (p[key] !== undefined) el.textContent = p[key] || "—";
      });
      // VIP badge
      document.querySelectorAll("[data-vip]").forEach(function (el) {
        el.className = el.className.replace(/vip-\d/g, "");
        el.classList.add("vip-" + (p.vip_level || 0));
        el.textContent = p.vip_level > 0 ? "VIP " + p.vip_level : "Member";
      });
      return p;
    },

    /* Logout */
    logout: async function () {
      await window.sb.auth.signOut();
      location.href = "/index.html";
    },

    /* Format money */
    money: function (v) {
      return "₦" + Number(v || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    /* Show toast */
    toast: function (msg, duration) {
      var el = document.getElementById("toast");
      if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
      el.textContent = msg;
      el.classList.add("show");
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.classList.remove("show"); }, duration || 2500);
    },

    /* Time ago */
    timeAgo: function (dateStr) {
      var diff = Date.now() - new Date(dateStr).getTime();
      var m = Math.floor(diff / 60000);
      if (m < 1) return "just now";
      if (m < 60) return m + "m ago";
      var h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }
  };
})();
 
