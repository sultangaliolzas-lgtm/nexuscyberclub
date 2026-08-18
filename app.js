(function () {
  "use strict";

  var tg = window.Telegram ? window.Telegram.WebApp : null;
  var initData = tg ? tg.initData : "";

  var rouletteView = document.getElementById("rouletteView");
  var inventoryView = document.getElementById("inventoryView");
  var tabBtns = document.querySelectorAll(".tab-btn");

  var wheel = document.getElementById("wheel");
  var spinBtn = document.getElementById("spinBtn");
  var spinHint = document.getElementById("spinHint");
  var resultEl = document.getElementById("result");
  var resultTitle = document.getElementById("resultTitle");
  var resultCode = document.getElementById("resultCode");

  var inventoryList = document.getElementById("inventoryList");
  var inventoryEmpty = document.getElementById("inventoryEmpty");

  var state = { spinsAvailable: 0, items: [] };

  init();

  function init() {
    if (tg) {
      tg.ready();
      tg.expand();
      applyTheme();
      tg.onEvent("themeChanged", applyTheme);
    }

    tabBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        setTab(btn.dataset.tab);
      });
    });

    spinBtn.addEventListener("click", handleSpin);

    loadStatus();
  }

  function applyTheme() {
    if (!tg || !tg.themeParams) return;
    var root = document.documentElement;
    var params = tg.themeParams;
    if (params.bg_color) root.style.setProperty("--tg-bg-color", params.bg_color);
    if (params.text_color) root.style.setProperty("--tg-text-color", params.text_color);
    if (params.hint_color) root.style.setProperty("--tg-hint-color", params.hint_color);
  }

  function setTab(tab) {
    tabBtns.forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tab); });
    rouletteView.hidden = tab !== "roulette";
    inventoryView.hidden = tab !== "inventory";
    if (tab === "inventory") renderInventory();
  }

  function loadStatus() {
    fetch("/api/inventory?t=" + Date.now(), { cache: "no-store", headers: { "X-Telegram-Init-Data": initData } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        state.spinsAvailable = data.spinsAvailable || 0;
        state.items = data.items || [];
        updateSpinAvailability();
        renderInventory();
      })
      .catch(function () {
        spinHint.textContent = "Не удалось загрузить данные. Обновите страницу.";
      });
  }

  function updateSpinAvailability() {
    if (state.spinsAvailable > 0) {
      spinBtn.disabled = false;
      spinHint.textContent = "Доступно прокрутов: " + state.spinsAvailable;
    } else {
      spinBtn.disabled = true;
      spinHint.textContent = "Прокрут откроется после следующего визита в клуб";
    }
  }

  function handleSpin() {
    if (spinBtn.disabled) return;
    spinBtn.disabled = true;
    resultEl.hidden = true;
    wheel.classList.remove("spinning");
    void wheel.offsetWidth;
    wheel.classList.add("spinning");

    fetch("/api/spin", { method: "POST", cache: "no-store", headers: { "X-Telegram-Init-Data": initData } })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        setTimeout(function () { showResult(res); }, 2200);
      })
      .catch(function () {
        setTimeout(function () {
          spinHint.textContent = "Ошибка. Попробуйте ещё раз.";
          spinBtn.disabled = false;
        }, 2200);
      });
  }

  function showResult(res) {
    if (!res.ok) {
      spinHint.textContent = res.data && res.data.error === "no_spins_available"
        ? "Прокрут откроется после следующего визита в клуб"
        : "Не получилось выполнить прокрут.";
      state.spinsAvailable = 0;
      updateSpinAvailability();
      return;
    }

    haptic();
    state.spinsAvailable = Math.max(0, state.spinsAvailable - 1);

    if (!res.data.prize) {
      resultTitle.textContent = "В этот раз без приза. Повезёт на следующем визите!";
      resultCode.textContent = "";
    } else {
      var p = res.data.prize;
      resultTitle.textContent = "🎉 " + p.title + " (" + p.tier + ")";
      resultCode.textContent = "Код: " + p.code;
      state.items.unshift({ title: p.title, tier: p.tier, code: p.code, expiresAt: p.expiresAt, wonAt: new Date().toISOString() });
    }

    resultEl.hidden = false;
    updateSpinAvailability();
  }

  function renderInventory() {
    inventoryList.innerHTML = "";
    var items = state.items;

    inventoryEmpty.hidden = items.length !== 0;

    items.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "inventory-item";

      var top = document.createElement("div");
      top.className = "inventory-item-top";

      var left = document.createElement("div");
      var title = document.createElement("div");
      title.className = "inventory-title";
      title.textContent = item.title;
      var tier = document.createElement("div");
      tier.className = "inventory-tier";
      tier.textContent = item.tier;
      left.appendChild(title);
      left.appendChild(tier);

      var expiry = document.createElement("div");
      expiry.className = "inventory-expiry";
      expiry.textContent = formatExpiry(item.expiresAt);

      top.appendChild(left);
      top.appendChild(expiry);

      var code = document.createElement("div");
      code.className = "inventory-code";
      code.textContent = item.code;

      var hint = document.createElement("div");
      hint.className = "inventory-hint";
      hint.textContent = "Нажми, чтобы показать код сотруднику";

      li.appendChild(top);
      li.appendChild(code);
      li.appendChild(hint);

      li.addEventListener("click", function () {
        li.classList.toggle("revealed");
      });

      inventoryList.appendChild(li);
    });
  }

  function formatExpiry(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (ms <= 0) return "истёк";
    var hours = Math.floor(ms / 3600000);
    var days = Math.floor(hours / 24);
    if (days > 0) return days + "д " + (hours % 24) + "ч";
    return hours + "ч";
  }

  function haptic() {
    if (tg && tg.HapticFeedback) {
      try { tg.HapticFeedback.notificationOccurred("success"); } catch (e) {}
    }
  }
})();
