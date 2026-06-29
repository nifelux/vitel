/* assets/js/auth.js — shared helpers, exposes window.VitelAuth */
(function () {
  window.VitelAuth = {

    requireAuth: async function () {
      if (!window.sb) { location.href = "/index.html"; return null; }
      try {
        var { data: { session } } = await window.sb.auth.getSession();
        if (!session) { location.href = "/index.html"; return null; }
        return session;
      } catch(e) { location.href = "/index.html"; return null; }
    },

    requireAdmin: async function () {
      var session = await this.requireAuth();
      if (!session) return null;
      try {
        var { data } = await window.sb.from("profiles")
          .select("is_admin").eq("id", session.user.id).single();
        if (!data?.is_admin) { location.href = "/dashboard.html"; return null; }
        return session;
      } catch(e) { location.href = "/dashboard.html"; return null; }
    },

    loadProfile: async function (userId) {
      if (!window.sb) return null;
      try {
        var { data: p } = await window.sb.from("profiles").select("*").eq("id", userId).single();
        if (!p) return null;
        document.querySelectorAll("[data-auth]").forEach(function (el) {
          var key = el.dataset.auth;
          if (p[key] !== undefined && p[key] !== null) el.textContent = p[key];
        });
        document.querySelectorAll("[data-vip]").forEach(function (el) {
          el.className = el.className.replace(/\bvip-\d\b/g, "");
          el.classList.add("vip-" + (p.vip_level || 0));
          el.textContent = p.vip_level > 0 ? "VIP " + p.vip_level : "Member";
        });
        return p;
      } catch(e) { console.warn("loadProfile error:", e); return null; }
    },

    logout: async function () {
      if (window.sb) { try { await window.sb.auth.signOut(); } catch(e){} }
      location.href = "/index.html";
    },

    money: function (v) {
      return "₦" + Number(v || 0).toLocaleString("en-NG", {
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
    },

    toast: function (msg, duration) {
      var el = document.getElementById("toast");
      if (!el) {
        el = document.createElement("div");
        el.id = "toast";
        el.style.cssText = "position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:#1E293B;color:#fff;padding:11px 20px;border-radius:30px;font-size:13px;font-weight:600;z-index:9999;opacity:0;transition:opacity .25s;pointer-events:none;white-space:nowrap;font-family:DM Sans,sans-serif";
        document.body.appendChild(el);
      }
      el.textContent = msg;
      el.style.opacity = "1";
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.style.opacity = "0"; }, duration || 2500);
    },

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
         
