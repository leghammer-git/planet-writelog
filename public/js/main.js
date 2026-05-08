/* ── Theme toggle ──────────────────────────────────────────────────────── */
(function () {
  const root = document.documentElement;
  const btn = document.querySelector(".theme-toggle");
  const icon = btn?.querySelector(".theme-toggle__icon");

  const saved = localStorage.getItem("theme");
  const apply = (theme) => {
    root.dataset.theme = theme;
    if (icon) icon.textContent = theme === "dark" ? "☽" : "☀";
    btn?.setAttribute("aria-pressed", String(theme === "dark"));
  };

  if (saved) {
    apply(saved);
  } else {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    apply(prefersDark ? "dark" : "light");
  }

  btn?.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    apply(next);
    localStorage.setItem("theme", next);
  });
})();

/* ── Filter pills ──────────────────────────────────────────────────────── */
(function () {
  const grid = document.getElementById("feed-results");
  const countEl = document.getElementById("visible-count");
  if (!grid) return;

  const cards = Array.from(grid.querySelectorAll(".item-card"));
  let activeType = "all";
  let activePerson = "all";

  function applyFilters() {
    let visible = 0;
    for (const card of cards) {
      const typeMatch = activeType === "all" || card.dataset.type === activeType;
      const personMatch = activePerson === "all" || card.dataset.person === activePerson;
      const show = typeMatch && personMatch;
      card.hidden = !show;
      if (show) visible++;
    }
    if (countEl) countEl.textContent = visible;
  }

  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    const groupName = group.dataset.filterGroup;
    group.querySelectorAll(".pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        group.querySelectorAll(".pill").forEach((p) => p.classList.remove("pill--active"));
        pill.classList.add("pill--active");
        if (groupName === "type") activeType = pill.dataset.value;
        if (groupName === "person") activePerson = pill.dataset.value;
        applyFilters();
      });
    });
  });
})();

/* ── View Transitions ──────────────────────────────────────────────────── */
if (!document.startViewTransition) {
  document.querySelectorAll("a[href]").forEach((a) => {
    if (a.hostname === location.hostname && !a.hash) {
      a.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        // native fallback — do nothing, browser handles it
      });
    }
  });
}
