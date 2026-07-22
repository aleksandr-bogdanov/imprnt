/* Dev-only live accent picker. Self-gates to localhost so it can never do
   anything in production. Sets the single-source --brand-accent* tokens on
   :root live and persists the pick to localStorage, so it carries across the
   landing and the docs. Pick any color with the swatch input or a preset,
   read the hex + name, tell the agent to bake it into accent.css. */
(() => {
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return;

  const KEY = "imprnt-accent";
  const root = document.documentElement;

  const hx = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const toRgb = (h) => { h = h.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
  const toHex = ([r, g, b]) => "#" + hx(r) + hx(g) + hx(b);
  const mix = (a, b, t) => { const A = toRgb(a), B = toRgb(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); };
  const lum = (h) => { const [r, g, b] = toRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

  function derive(accent) {
    const ink = lum(accent) > 0.4 ? "#1a1a17" : "#fdf9f2";
    const dark = mix(accent, "#ffffff", 0.32);
    return {
      "--brand-accent": accent,
      "--brand-accent-strong": mix(accent, "#000000", 0.16),
      "--brand-accent-ink": ink,
      "--brand-accent-dark": dark,
      "--brand-accent-dark-strong": mix(dark, "#ffffff", 0.12),
      "--brand-accent-dark-ink": mix(accent, "#000000", 0.78),
    };
  }
  function apply(accent, name, persist) {
    const vars = derive(accent);
    for (const k in vars) root.style.setProperty(k, vars[k]);
    if (persist) { localStorage.setItem(KEY, accent); localStorage.setItem(KEY + "-name", name || "custom"); }
    const out = document.getElementById("ap-hex"); if (out) out.textContent = accent;
    const nm = document.getElementById("ap-name"); if (nm) nm.textContent = name || "custom";
    const dk = document.getElementById("ap-dark"); if (dk) dk.textContent = "dark " + vars["--brand-accent-dark"];
    const inp = document.getElementById("ap-input"); if (inp) inp.value = accent;
    document.querySelectorAll("#ap-sw button").forEach((b) => b.setAttribute("aria-current", b.dataset.hex === accent ? "true" : "false"));
  }

  const saved = localStorage.getItem(KEY);
  if (saved) apply(saved, localStorage.getItem(KEY + "-name"), false);

  // distinct hues, spread so every swatch is visibly different (the old set had
  // five near-identical deep reds). A few true wines up front for burgundy hunts.
  const PRESETS = [
    ["oxblood", "#6d2026"], ["burgundy", "#7a1a3a"], ["crimson", "#a11838"], ["signal red", "#d2402f"],
    ["rust", "#a8481e"], ["amber", "#9a6206"], ["terracotta", "#b5533a"], ["plum", "#6a2a6e"],
    ["indigo", "#33409e"], ["cobalt", "#2f6690"], ["teal", "#0e6b6b"], ["forest", "#1c6b43"],
  ];

  function build() {
    if (document.getElementById("ap-panel")) return;
    const cur = localStorage.getItem(KEY) || getComputedStyle(root).getPropertyValue("--brand-accent").trim() || "#6d2026";
    const curName = localStorage.getItem(KEY + "-name") || (PRESETS.find(([, h]) => h === cur) || [])[0] || "custom";
    const p = document.createElement("div");
    p.id = "ap-panel";
    p.innerHTML = `
      <style>
        #ap-panel{position:fixed;right:14px;bottom:14px;z-index:99999;width:268px;
          background:#1c1a15;color:#ece9e0;border:1px solid #2c2a23;border-radius:12px;
          padding:13px 14px;font:12px/1.4 system-ui,sans-serif;box-shadow:0 12px 40px -12px rgba(0,0,0,.6)}
        #ap-panel h4{margin:0 0 10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#a3a094;font-weight:700;display:flex;justify-content:space-between;align-items:center}
        #ap-panel .x{cursor:pointer;color:#75736a;font-size:15px;line-height:1}
        #ap-panel .row{display:flex;align-items:center;gap:9px;margin-bottom:11px}
        #ap-input{width:38px;height:30px;border:none;border-radius:6px;background:none;padding:0;cursor:pointer;flex-shrink:0}
        #ap-meta{min-width:0}
        #ap-name{font-weight:700;font-size:13px;text-transform:capitalize}
        #ap-hex{font:11px/1.3 ui-monospace,monospace;color:#c2c0b6}
        #ap-dark{font:10px/1.3 ui-monospace,monospace;color:#75736a}
        #ap-sw{display:grid;grid-template-columns:repeat(6,1fr);gap:6px}
        #ap-sw button{aspect-ratio:1;border:2px solid transparent;border-radius:6px;cursor:pointer;padding:0;box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}
        #ap-sw button[aria-current="true"]{border-color:#ece9e0}
        #ap-panel .note{margin-top:9px;font-size:10px;color:#75736a}
      </style>
      <h4>accent picker <span class="x" id="ap-close" title="hide">×</span></h4>
      <div class="row">
        <input type="color" id="ap-input" value="${cur}">
        <div id="ap-meta"><div id="ap-name"></div><span id="ap-hex"></span> <span id="ap-dark"></span></div>
      </div>
      <div id="ap-sw"></div>
      <p class="note">dev only. click a swatch or dial any color, then tell the agent the hex.</p>`;
    document.body.appendChild(p);
    const sw = p.querySelector("#ap-sw");
    PRESETS.forEach(([name, hex]) => {
      const b = document.createElement("button");
      b.style.background = hex; b.title = name + " " + hex; b.dataset.hex = hex;
      b.onclick = () => apply(hex, name, true);
      sw.appendChild(b);
    });
    p.querySelector("#ap-input").addEventListener("input", (e) => apply(e.target.value, "custom", true));
    p.querySelector("#ap-close").onclick = () => { p.style.display = "none"; };
    apply(cur, curName, false);
  }

  if (document.body) build();
  else document.addEventListener("DOMContentLoaded", build);
})();
