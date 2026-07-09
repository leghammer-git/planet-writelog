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
  const activeTypes = new Set(["blog", "youtube"]);
  let activePerson = "all";
  let activeKeyword = "";
  let page = 1;

  const TYPE_ACTIVE_CLASS = {
    "blog": "pill--active-blog",
    "github-releases": "pill--active-releases",
    "youtube": "pill--active-youtube",
  };

  function applyFilters() {
    const keyword = activeKeyword.toLowerCase();
    const matched = [];
    for (const card of cards) {
      const typeMatch = activeTypes.has(card.dataset.type);
      const personMatch = activePerson === "all" || card.dataset.person === activePerson;
      const keywordMatch = !keyword || (card.dataset.title || "").includes(keyword);
      if (typeMatch && personMatch && keywordMatch) matched.push(card);
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
        if (groupName === "type") {
          const type = pill.dataset.value;
          const cls = TYPE_ACTIVE_CLASS[type];
          if (activeTypes.has(type)) {
            activeTypes.delete(type);
            pill.classList.remove(cls);
          } else {
            activeTypes.add(type);
            pill.classList.add(cls);
          }
        }
        resetAndFilter();
      });
    });
  });

  const personPicker = document.getElementById("person-picker");
  if (personPicker) {
    const trigger = personPicker.querySelector(".person-picker__trigger");
    const list = personPicker.querySelector(".person-picker__list");
    const options = list.querySelectorAll(".person-picker__option");

    const closePicker = () => {
      list.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
    };
    const openPicker = () => {
      list.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
    };

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      list.hidden ? openPicker() : closePicker();
    });

    options.forEach((opt) => {
      opt.addEventListener("click", () => {
        options.forEach((o) => o.setAttribute("aria-selected", "false"));
        opt.setAttribute("aria-selected", "true");
        activePerson = opt.dataset.value;
        trigger.textContent = opt.querySelector(".person-picker__name").textContent.trim();
        closePicker();
        resetAndFilter();
      });
    });

    document.addEventListener("click", closePicker);
    list.addEventListener("click", (e) => e.stopPropagation());
    personPicker.addEventListener("keydown", (e) => { if (e.key === "Escape") closePicker(); });
  }

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

/* ── Wayback Machine availability check ───────────────────────────────── */
(function () {
  const cache = new Map();

  function applyResult(link, result) {
    if (result.available) {
      link.href = result.archiveUrl;
      link.title = "View archived version on Wayback Machine";
      link.classList.add("archive-link--available");
    } else {
      link.title = "Not yet archived by Wayback Machine";
      link.classList.add("archive-link--unavailable");
    }
  }

  document.querySelectorAll(".archive-link").forEach((link) => {
    let timer = null;

    link.addEventListener("mouseenter", function check() {
      link.removeEventListener("mouseenter", check);
      const url = link.dataset.url;
      if (!url) return;

      timer = setTimeout(() => {
        if (cache.has(url)) { applyResult(link, cache.get(url)); return; }
        fetch("https://archive.org/wayback/available?url=" + encodeURIComponent(url))
          .then((r) => r.json())
          .then((data) => {
            const snap = data.archived_snapshots?.closest;
            const result = snap?.available
              ? { available: true, archiveUrl: snap.url }
              : { available: false, archiveUrl: null };
            cache.set(url, result);
            applyResult(link, result);
          })
          .catch(() => {
            link.title = "View on Wayback Machine";
          });
      }, 600);
    });

    link.addEventListener("mouseleave", () => {
      clearTimeout(timer);
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
