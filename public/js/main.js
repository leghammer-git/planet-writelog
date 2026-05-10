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

/* ── Filter pills + keyword + pagination ───────────────────────────────── */
(function () {
  const grid = document.getElementById("feed-results");
  const countEl = document.getElementById("visible-count");
  const totalEl = document.getElementById("total-count");
  const loadMoreBtn = document.getElementById("load-more");
  if (!grid) return;

  const PAGE_SIZE = 50;
  const cards = Array.from(grid.querySelectorAll(".item-card"));
  let activeType = "all";
  let activePerson = "all";
  let activeSource = "all";
  let activeKeyword = "";
  let page = 1;

  const sourceSelect = document.getElementById("source-select");
  if (sourceSelect) {
    const sources = [...new Set(cards.map((c) => c.dataset.source).filter(Boolean))].sort();
    for (const s of sources) {
      const opt = document.createElement("option");
      opt.value = s;
      opt.textContent = s;
      sourceSelect.appendChild(opt);
    }
  }

  function applyFilters() {
    const keyword = activeKeyword.toLowerCase();
    const matched = [];
    for (const card of cards) {
      const typeMatch = activeType === "all" || card.dataset.type === activeType;
      const personMatch = activePerson === "all" || card.dataset.person === activePerson;
      const sourceMatch = activeSource === "all" || card.dataset.source === activeSource;
      const keywordMatch = !keyword || (card.dataset.title || "").includes(keyword);
      if (typeMatch && personMatch && sourceMatch && keywordMatch) matched.push(card);
    }

    const limit = page * PAGE_SIZE;
    for (const card of cards) card.hidden = true;
    for (let i = 0; i < Math.min(matched.length, limit); i++) matched[i].hidden = false;

    if (countEl) countEl.textContent = Math.min(matched.length, limit);
    if (totalEl) totalEl.textContent = matched.length;
    if (loadMoreBtn) loadMoreBtn.hidden = matched.length <= limit;
  }

  function resetAndFilter() {
    page = 1;
    applyFilters();
  }

  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    const groupName = group.dataset.filterGroup;
    group.querySelectorAll(".pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        group.querySelectorAll(".pill").forEach((p) => p.classList.remove("pill--active"));
        pill.classList.add("pill--active");
        if (groupName === "type") activeType = pill.dataset.value;
        resetAndFilter();
      });
    });
  });

  document.querySelectorAll("[data-filter-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const groupName = select.dataset.filterSelect;
      if (groupName === "person") activePerson = select.value;
      if (groupName === "source") activeSource = select.value;
      resetAndFilter();
    });
  });

  const keywordInput = document.getElementById("keyword-input");
  if (keywordInput) {
    keywordInput.addEventListener("input", () => {
      activeKeyword = keywordInput.value.trim();
      resetAndFilter();
    });
  }

  if (loadMoreBtn) {
    loadMoreBtn.addEventListener("click", () => {
      page++;
      applyFilters();
    });
  }

  applyFilters();
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
