(function () {
  "use strict";

  var tg = window.Telegram ? window.Telegram.WebApp : null;
  var initData = tg ? tg.initData : "";
  var startParam = tg && tg.initDataUnsafe ? tg.initDataUnsafe.start_param : null;

  var state = {
    role: "client",
    spins: 0,
    items: [],
    redeemed: [],
    sectors: [],
    clubName: "NEXUS",
    nextSpinAt: null,
    cap: 0,
    currency: "₸",
    exportDays: 30,
    clientSort: "recent",
    spinning: false,
    adminDays: 7,
    prizes: null,
    canMessage: true,   // пока не знаем — не пугаем клиента подсказкой
    botLink: null
  };

  var el = {};
  ["clubName", "banner", "strip", "burst", "reelFrame", "timer", "timerValue", "prizeDot",
   "result", "resultIcon", "resultTitle", "resultSub", "resultCode",
   "spinBtn", "hint", "inventoryList", "inventoryEmpty", "historyBlock", "historyList",
   "notifyNotice", "notifyLink",
   "tabs", "adminNav", "periodNav", "statTiles", "funnelTable", "funnelFoot",
   "todayTiles", "chart", "liability", "clientSort", "exportNav", "exportBtn", "configLog",
   "outstandingList", "outstandingFoot", "sourcesList", "activityList",
   "prizeEditor", "clientsList", "clientsFoot", "clientSearch", "grantAmount", "selfGrant",
   "settingsForm", "staffForm", "staffList",
   "remindForm", "remindNow", "remindResult",
   "castText", "castAudience", "castAudienceFoot", "castSend",
   "castProgress", "castBar", "castProgressFoot", "castList",
   "castPhoto", "castPhotoBtn", "castPhotoPreview", "castPhotoImg",
   "castPhotoRemove", "castLimit",
   "deskCode", "deskSubmit", "deskScan", "deskResult", "deskLog", "deskHint",
   "toast"].forEach(function (id) { el[id] = document.getElementById(id); });

  boot();

  /* ============================================================ запуск */

  function boot() {
    if (tg) {
      tg.ready();
      tg.expand();
      if (tg.setHeaderColor) { try { tg.setHeaderColor("#0b0c10"); } catch (e) {} }
    }

    bindTabs();
    bindDesk();
    bindExport();
    el.spinBtn.addEventListener("click", handleSpin);
    el.resultCode.addEventListener("click", function () { copy(el.resultCode.dataset.code); });

    // Конфиг колеса не зависит от чек-ина, поэтому тянем его сразу.
    api("/api/config")
      .then(function (cfg) {
        state.clubName = cfg.clubName || "NEXUS";
        state.sectors = cfg.sectors || [];
        el.clubName.textContent = state.clubName;
        document.title = state.clubName + " Roulette";
        idleStrip();
      })
      .catch(function (err) { console.error("config:", err); });

    // Пришли по QR — начисляем прокрут до того, как покажем баланс,
    // иначе клиент на секунду увидит ноль и решит, что не сработало.
    var first = startParam
      ? api("/api/checkin", { method: "POST" }).then(showCheckin).catch(function (err) {
          console.error("checkin:", err);
        })
      : Promise.resolve();

    first.then(loadState);
  }

  function loadState() {
    return api("/api/inventory")
      .then(function (data) {
        state.role = data.role || "client";
        state.spins = data.spinsAvailable || 0;
        state.nextSpinAt = data.nextSpinAt || null;
        state.cap = data.maxUnusedPrizes || 0;
        state.items = data.items || [];
        state.redeemed = data.redeemed || [];
        state.canMessage = data.canMessage !== false;
        state.botLink = data.botLink || null;

        if (state.role === "owner" || state.role === "staff") {
          document.querySelector('.tab[data-tab="desk"]').hidden = false;
        }
        if (state.role === "owner") {
          document.querySelector('.tab[data-tab="admin"]').hidden = false;
        }

        renderSpins();
        renderInventory();
      })
      .catch(function (err) {
        el.hint.textContent = "Не удалось загрузить данные: " + err.message;
        el.spinBtn.disabled = true;
      });
  }

  function showCheckin(res) {
    if (!res) return;

    if (res.granted) {
      el.banner.textContent = res.bonus
        ? "⚡ Бонус Х2 сработал: начислено два прокрута!"
        : "✅ Визит засчитан. Прокрут открыт — крути!";
      el.banner.className = "banner";
      el.banner.hidden = false;
      haptic("success");
      return;
    }

    if (res.reason === "cooldown" && res.nextAt) {
      state.nextSpinAt = res.nextAt;
      el.banner.textContent = "Прокрут за сегодня уже получен. Следующий — через " + until(res.nextAt) + ".";
      el.banner.className = "banner neutral";
      el.banner.hidden = false;
    }
  }

  /* ============================================================ сеть */

  function api(path, options) {
    var opts = options || {};
    var headers = { "X-Telegram-Init-Data": initData };
    if (opts.body) headers["Content-Type"] = "application/json";

    return fetch(path, {
      method: opts.method || "GET",
      cache: "no-store",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) {}
        if (!r.ok) {
          var err = new Error((data && (data.reason || data.error)) || "HTTP " + r.status);
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ============================================================ навигация */

  function bindTabs() {
    el.tabs.addEventListener("click", function (e) {
      var btn = e.target.closest(".tab");
      if (!btn) return;
      setTab(btn.dataset.tab);
    });

    el.adminNav.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg");
      if (!btn) return;
      setAdminPane(btn.dataset.pane);
    });

    el.clientSearch.addEventListener("input", renderClients);

    el.clientSort.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg");
      if (!btn) return;
      state.clientSort = btn.dataset.sort;
      markActive(el.clientSort, btn);
      renderClients();
    });

    el.selfGrant.addEventListener("click", function () {
      el.selfGrant.disabled = true;
      grantTo(myId(), 1)
        .then(function (res) {
          state.spins = res.spinsAvailable;
          renderSpins();
          toast("Начислено. Прокрутов: " + res.spinsAvailable);
        })
        .catch(function () {})
        .then(function () { el.selfGrant.disabled = false; });
    });

    el.periodNav.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg");
      if (!btn) return;
      state.adminDays = Number(btn.dataset.days);
      markActive(el.periodNav, btn);
      loadStats();
    });

    el.castAudience.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg");
      if (!btn) return;
      castAudience = btn.dataset.aud;
      markActive(el.castAudience, btn);
      renderAudienceFoot();
    });

    el.castSend.addEventListener("click", startBroadcast);
    el.remindNow.addEventListener("click", remindNow);

    el.castText.addEventListener("input", updateCastLimit);
    el.castPhoto.addEventListener("change", attachPhoto);
    el.castPhotoRemove.addEventListener("click", clearPhoto);
  }

  function myId() {
    return tg && tg.initDataUnsafe && tg.initDataUnsafe.user ? tg.initDataUnsafe.user.id : null;
  }

  function setTab(tab) {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    ["wheel", "inventory", "desk", "admin"].forEach(function (name) {
      document.getElementById("view-" + name).hidden = name !== tab;
    });
    if (tab === "admin") loadAdmin();
    window.scrollTo(0, 0);
  }

  function setAdminPane(pane) {
    markActive(el.adminNav, el.adminNav.querySelector('[data-pane="' + pane + '"]'));
    ["stats", "prizes", "clients", "comms", "team"].forEach(function (name) {
      document.getElementById("pane-" + name).hidden = name !== pane;
    });
    if (pane === "prizes") loadPrizes();
    if (pane === "clients") loadClients();
    if (pane === "comms") loadComms();
    if (pane === "team") loadTeam();
  }

  function markActive(container, btn) {
    container.querySelectorAll(".seg").forEach(function (b) { b.classList.remove("active"); });
    if (btn) btn.classList.add("active");
  }

  /* ============================================================ лента призов */

  var WIN_AT = 8;                       // позиция выигрыша в ленте
  var TRAVEL = 42;                      // сколько карточек пролетает мимо метки
  var STRIP_LEN = WIN_AT + TRAVEL + 8;  // хвост слева, чтобы окно не опустело

  // Лента набирается случайными призами, а нужный подставляется в позицию
  // WIN_AT. Порядок не повторяется узором — иначе видно, что это цикл.
  function buildStrip(winnerKey) {
    if (!state.sectors.length) return;

    var frag = document.createDocumentFragment();

    for (var i = 0; i < STRIP_LEN; i++) {
      var sector = null;
      if (i === WIN_AT && winnerKey) sector = findSector(winnerKey);
      if (!sector) sector = state.sectors[Math.floor(Math.random() * state.sectors.length)];
      frag.appendChild(reelCard(sector));
    }

    el.strip.innerHTML = "";
    el.strip.appendChild(frag);
  }

  function reelCard(sector) {
    var card = document.createElement("div");
    card.className = "reel-item";
    card.style.setProperty("--tone", toneOf(sector));

    var icon = document.createElement("div");
    icon.className = "ri-icon";
    icon.textContent = emoji(sector.icon || "🎁");
    card.appendChild(icon);

    var name = document.createElement("div");
    name.className = "ri-name";
    name.textContent = sector.title || sector.shortTitle || "";
    card.appendChild(name);

    if (sector.description) {
      var desc = document.createElement("div");
      desc.className = "ri-desc";
      desc.textContent = sector.description;
      card.appendChild(desc);
    }

    return card;
  }

  // Цвет приза идёт в название карточки. Тёмный оттенок (сектор "Пусто")
  // на тёмном фоне не читается, поэтому подменяем его приглушённым серым.
  function toneOf(sector) {
    var color = sector.color || "#a6ff2f";
    var m = /^#([0-9a-fA-F]{6})$/.exec(color);
    if (!m) return color;
    var n = parseInt(m[1], 16);
    var lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return lum < 0.35 ? "#868c9c" : color;
  }

  function findSector(key) {
    for (var i = 0; i < state.sectors.length; i++) {
      if (state.sectors[i].key === key) return state.sectors[i];
    }
    return null;
  }

  // Шаг ленты меряем по факту, а не берём из константы: если поменяется
  // ширина карточки в CSS, метка иначе перестанет попадать в приз.
  function stripStep() {
    var a = el.strip.children[0];
    var b = el.strip.children[1];
    if (!a || !b) return 96;
    return b.offsetLeft - a.offsetLeft;
  }

  // Приз выбирает сервер, лента лишь доезжает до его карточки и встаёт
  // ровно под меткой. Никакой подкрутки после остановки.
  function rollTo(winnerKey, done) {
    buildStrip(winnerKey);

    var step = stripStep();
    var cardWidth = el.strip.children[0] ? el.strip.children[0].offsetWidth : 86;
    var center = el.strip.parentNode.clientWidth / 2;

    // Карточка встаёт ровно в центр рамки, без случайного сдвига:
    // рамка узкая, и любой разброс сразу читается как перекос.
    var finish = Math.round(center - WIN_AT * step - cardWidth / 2);
    var begin  = Math.round(center - (WIN_AT + TRAVEL) * step - cardWidth / 2);

    // begin меньше finish, поэтому смещение растёт и лента едет слева направо.
    el.strip.classList.remove("rolling");
    el.strip.style.transform = "translateX(" + begin + "px)";

    // Без принудительного пересчёта браузер склеит стартовое и конечное
    // положение в одно и анимации не будет вовсе.
    void el.strip.offsetWidth;

    el.strip.classList.add("rolling");
    el.strip.style.transform = "translateX(" + finish + "px)";

    setTimeout(function () {
      el.reelFrame.classList.add("hit");
      state.spinning = false;
      done();
    }, 4700);
  }

  function clearHit() {
    el.reelFrame.classList.remove("hit");
  }

  // Ширина окна меняется при повороте телефона, и лента, выставленная
  // по старому центру, съезжает с метки. Пересобираем, пока не крутится.
  window.addEventListener("resize", function () {
    if (!state.spinning && el.strip.children.length) idleStrip();
  });

  // Лента в покое: показываем призы, стоящие вокруг центра.
  function idleStrip() {
    buildStrip(null);
    el.strip.classList.remove("rolling");
    var step = stripStep();
    var cardWidth = el.strip.children[0] ? el.strip.children[0].offsetWidth : 86;
    var center = el.strip.parentNode.clientWidth / 2;
    el.strip.style.transform = "translateX(" + Math.round(center - WIN_AT * step - cardWidth / 2) + "px)";
  }

  /* ============================================================ прокрут */

  // Под лентой всегда ровно один блок: кнопка, если прокрут есть,
  // и обратный отсчёт, если ждём следующего.
  function renderSpins() {
    updatePrizeDot();
    if (state.spinning) return;

    // Инвентарь полон: крутить нечего, пока не заберёшь своё.
    // Кнопку показываем неактивной, чтобы было видно, что дело не
    // в отсутствии прокрутов.
    if (state.cap > 0 && state.items.length >= state.cap) {
      stopTicking();
      el.timer.hidden = true;
      el.spinBtn.hidden = false;
      el.spinBtn.disabled = true;
      el.spinBtn.textContent = "Забери призы";
      el.hint.textContent = "У тебя " + state.items.length + " из " + state.cap +
        " призов не получено. Забери их на стойке клуба, чтобы крутить снова.";
      return;
    }

    if (state.spins > 0) {
      stopTicking();
      el.timer.hidden = true;
      el.spinBtn.hidden = false;
      el.spinBtn.disabled = false;
      el.spinBtn.textContent = "Крутить";
      el.hint.textContent = state.spins === 1
        ? "Бесплатный прокрут ждёт тебя"
        : "Доступно прокрутов: " + state.spins;
      return;
    }

    el.spinBtn.hidden = true;

    if (state.nextSpinAt && new Date(state.nextSpinAt).getTime() > Date.now()) {
      el.timer.hidden = false;
      el.hint.textContent = "до следующего бесплатного прокрута";
      startTicking();
    } else {
      stopTicking();
      el.timer.hidden = true;
      el.hint.textContent = "Отсканируй QR-код на ресепшене клуба — прокрут откроется сразу.";
    }
  }

  function updatePrizeDot() {
    el.prizeDot.hidden = state.items.length === 0;
  }

  /* ---------------------------------------------------- обратный отсчёт */

  var ticker = null;

  function startTicking() {
    stopTicking();
    tick();
    ticker = setInterval(tick, 1000);
  }

  function stopTicking() {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function tick() {
    var left = new Date(state.nextSpinAt).getTime() - Date.now();

    if (left <= 0) {
      stopTicking();
      el.timerValue.textContent = "00:00:00";
      // Время вышло — перечитываем состояние с сервера, а не решаем
      // сами: прокрут даётся при сканировании, а не по таймеру.
      loadState();
      return;
    }

    el.timerValue.textContent = clock(left);
  }

  function clock(ms) {
    var total = Math.floor(ms / 1000);
    return pad(Math.floor(total / 3600)) + ":" +
           pad(Math.floor((total % 3600) / 60)) + ":" +
           pad(total % 60);
  }

  function pad(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function handleSpin() {
    if (state.spinning || state.spins <= 0) return;

    state.spinning = true;
    el.spinBtn.disabled = true;
    el.spinBtn.textContent = "Крутим...";
    el.result.hidden = true;
    el.banner.hidden = true;
    el.hint.textContent = "";
    clearHit();
    haptic("impact");

    api("/api/spin", { method: "POST" })
      .then(function (res) {
        state.spins = typeof res.spinsLeft === "number" ? res.spinsLeft : Math.max(0, state.spins - 1);
        rollTo(res.prizeKey, function () { showResult(res); });
      })
      .catch(function (err) {
        state.spinning = false;
        if (err.status === 409) {
          toast("Сначала забери призы на стойке", true);
        } else if (err.status === 403) {
          state.spins = 0;
          toast("Прокрутов больше нет", true);
        } else {
          toast("Не получилось: " + err.message, true);
        }
        renderSpins();
      });
  }


  function showResult(res) {
    var prize = res.prize;

    if (!prize) {
      el.result.className = "result";
      el.resultIcon.textContent = "😔";
      el.resultTitle.textContent = "В этот раз пусто";
      el.resultSub.textContent = "Не расстраивайся — следующий визит, новый прокрут.";
      el.resultCode.hidden = true;
      haptic("warning");
    } else if (res.effect === "respin" || res.effect === "bonus_next") {
      // Мгновенные призы срабатывают сразу и не попадают в инвентарь:
      // гасить на стойке нечего, кода у них нет.
      el.result.className = "result win";
      el.resultIcon.textContent = emoji(prize.icon || "⚡");
      el.resultTitle.textContent = prize.title;
      el.resultSub.textContent = res.effect === "respin"
        ? "Прокрут вернулся — крути ещё раз прямо сейчас"
        : "Следующий визит даст два прокрута вместо одного";
      el.resultCode.hidden = true;
      haptic("success");
      burst(prize.color || "#a6ff2f", 22);
    } else {
      el.result.className = "result win";
      el.resultIcon.textContent = emoji(prize.icon || "🎁");
      el.resultTitle.textContent = prize.title;
      el.resultSub.textContent = "Покажи код сотруднику на стойке · сгорает через " + until(prize.expiresAt);
      el.resultCode.textContent = prize.code;
      el.resultCode.dataset.code = prize.code;
      el.resultCode.hidden = false;

      state.items.unshift({
        title: prize.title,
        code: prize.code,
        icon: prize.icon,
        wonAt: new Date().toISOString(),
        expiresAt: prize.expiresAt
      });

      haptic("success");
      burst(prize.color || "#a6ff2f", prize.tier === "EPIC" ? 26 : 16);
    }

    el.result.hidden = false;
    renderSpins();
    renderInventory();
  }

  function burst(color, count) {
    el.burst.innerHTML = "";
    for (var i = 0; i < count; i++) {
      var spark = document.createElement("i");
      spark.className = "spark";
      var angle = Math.random() * Math.PI * 2;
      var dist = 70 + Math.random() * 90;
      spark.style.setProperty("--dx", Math.cos(angle) * dist + "px");
      spark.style.setProperty("--dy", Math.sin(angle) * dist + "px");
      spark.style.background = Math.random() > 0.5 ? color : "#ffffff";
      spark.style.animationDelay = Math.random() * 160 + "ms";
      el.burst.appendChild(spark);
    }
    setTimeout(function () { el.burst.innerHTML = ""; }, 1500);
  }

  /* ============================================================ инвентарь */

  function renderInventory() {
    updatePrizeDot();
    renderNotifyNotice();
    el.inventoryList.innerHTML = "";
    el.inventoryEmpty.hidden = state.items.length !== 0;

    state.items.forEach(function (item) {
      el.inventoryList.appendChild(prizeCard(item, false));
    });

    el.historyBlock.hidden = state.redeemed.length === 0;
    el.historyList.innerHTML = "";
    state.redeemed.forEach(function (item) {
      el.historyList.appendChild(prizeCard(item, true));
    });
  }

  // Telegram запрещает боту писать первым, пока человек сам не начал с
  // ним переписку. Мини-апп, открытый по ссылке с наклейки, такого
  // разрешения не даёт — поэтому тем, у кого есть что терять, показываем
  // прямой путь включить напоминания.
  function renderNotifyNotice() {
    var needed = !state.canMessage && state.botLink && state.items.length > 0;
    el.notifyNotice.hidden = !needed;
    if (needed) el.notifyLink.href = state.botLink;
  }

  function prizeCard(item, done) {
    var li = document.createElement("li");
    li.className = "card";

    var left = new Date(item.expiresAt).getTime() - Date.now();
    var expiringSoon = !done && left > 0 && left < 24 * 3600000;

    li.appendChild(
      row(
        item.icon || "🎁",
        item.title,
        "", // редкость клиенту не показываем: она ничего не меняет при получении
        done
          ? "получен " + shortDate(item.redeemedAt)
          : span(expiringSoon ? "soon" : "", until(item.expiresAt))
      )
    );

    if (!done) {
      var code = document.createElement("div");
      code.className = "code-line";
      code.textContent = item.code;
      li.appendChild(code);

      // QR рисует сервер: сотруднику быстрее отсканировать его, чем
      // набирать код руками, а тянуть в приложение библиотеку ради
      // одной картинки незачем.
      var qr = document.createElement("div");
      qr.className = "prize-qr";
      var img = document.createElement("img");
      img.src = "/api/qr?code=" + encodeURIComponent(item.code);
      img.alt = item.code;
      img.loading = "lazy";
      qr.appendChild(img);
      li.appendChild(qr);

      var hint = document.createElement("div");
      hint.className = "card-hint";
      hint.textContent = "Нажми, чтобы показать код сотруднику";
      li.appendChild(hint);

      li.addEventListener("click", function () {
        li.classList.toggle("revealed");
        if (li.classList.contains("revealed")) haptic("impact");
      });
    }

    return li;
  }

  /* ============================================================ помощники */

  // Строка карточки. Текст всегда идёт через textContent: имена клиентов
  // приходят из Telegram, а названия призов правит владелец — подставлять
  // это как HTML нельзя.
  function row(icon, title, sub, side) {
    var wrap = document.createElement("div");
    wrap.className = "card-row";

    if (icon) {
      var ic = document.createElement("div");
      ic.className = "card-icon";
      ic.textContent = emoji(icon);
      wrap.appendChild(ic);
    }

    var main = document.createElement("div");
    main.className = "card-main";

    var titleNode = document.createElement("div");
    titleNode.className = "card-title";
    titleNode.textContent = title;
    main.appendChild(titleNode);

    if (sub) main.appendChild(fill("card-sub", sub));
    wrap.appendChild(main);

    if (side) wrap.appendChild(fill("card-side", side));
    return wrap;
  }

  function fill(cls, content) {
    var node = document.createElement("div");
    node.className = cls;
    if (content instanceof Node) node.appendChild(content);
    else node.textContent = content;
    return node;
  }

  function span(cls, text) {
    var node = document.createElement("span");
    if (cls) node.className = cls;
    node.textContent = text;
    return node;
  }

  // Часть символов (секундомер, ярлык) по умолчанию рисуется чёрно-белым
  // текстовым глифом: он уже и ниже цветного эмодзи, из-за чего иконки в
  // списке выглядят разнокалиберными. U+FE0F просит у шрифта цветной
  // вариант; для символов, которые и так цветные, он ничего не меняет.
  // ASCII не трогаем — там цветная форма только испортит вид.
  function emoji(ch) {
    if (!ch) return "";
    var cp = ch.codePointAt(0);
    if (cp < 0x2000) return ch;
    if (String.fromCodePoint(cp).length !== ch.length) return ch;
    return ch + "\uFE0F";
  }

  function until(iso) {
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return "";
    if (ms <= 0) return "истёк";

    var hours = Math.floor(ms / 3600000);
    var days = Math.floor(hours / 24);
    if (days > 0) return days + " д " + (hours % 24) + " ч";
    if (hours > 0) return hours + " ч";
    return Math.max(1, Math.floor(ms / 60000)) + " мин";
  }

  function shortDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
  }

  function ago(iso) {
    if (!iso) return "давно";
    var ms = Date.now() - new Date(iso).getTime();
    if (isNaN(ms)) return "давно";

    var days = Math.floor(ms / 86400000);
    if (days === 0) return "сегодня";
    if (days === 1) return "вчера";
    if (days < 30) return days + " дн назад";
    return shortDate(iso);
  }

  function toast(text, isError) {
    el.toast.textContent = text;
    el.toast.className = "toast" + (isError ? " err" : "");
    el.toast.hidden = false;
    clearTimeout(el.toast._timer);
    el.toast._timer = setTimeout(function () { el.toast.hidden = true; }, 2600);
  }

  function copy(text) {
    if (!text) return;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () { toast("Код скопирован"); }).catch(function () {});
    }
    haptic("impact");
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === "impact") tg.HapticFeedback.impactOccurred("medium");
      else tg.HapticFeedback.notificationOccurred(kind);
    } catch (e) {}
  }

  /* ============================================================ касса */

  function bindDesk() {
    el.deskSubmit.addEventListener("click", check);
    el.deskCode.addEventListener("keydown", function (e) {
      if (e.key === "Enter") check();
    });

    // Сканер есть только в свежих версиях Telegram — кнопку показываем,
    // лишь когда он действительно доступен.
    if (tg && tg.showScanQrPopup) {
      el.deskScan.hidden = false;
      el.deskScan.addEventListener("click", scan);
    }
  }

  function scan() {
    try {
      tg.showScanQrPopup({ text: "Наведите на QR-код приза в телефоне клиента" }, function (text) {
        var code = extractCode(text);
        if (!code) return false;          // не тот QR — оставляем сканер открытым
        el.deskCode.value = code;
        tg.closeScanQrPopup();
        check();
        return true;
      });
    } catch (e) {
      toast("Сканер недоступен в этой версии Telegram", true);
    }
  }

  // В QR может лежать и голый код, и ссылка с ним внутри.
  function extractCode(text) {
    var found = /NX-[A-F0-9]{8}/i.exec(String(text || ""));
    return found ? found[0].toUpperCase() : null;
  }

  // Шаг первый: сотрудник видит, что это за приз и чей он. Ничего
  // не меняется, пока он не подтвердит.
  function check() {
    var code = el.deskCode.value.trim().toUpperCase();
    if (!code) return;

    el.deskSubmit.disabled = true;
    el.deskSubmit.textContent = "Проверяем...";

    api("/api/redeem?peek=1", { method: "POST", body: { code: code } })
      .then(showPeek)
      .catch(function (err) {
        showVerdict({ ok: false, reason: (err.data && err.data.reason) || err.message });
      })
      .then(function () {
        el.deskSubmit.disabled = false;
        el.deskSubmit.textContent = "Проверить код";
      });
  }

  var DENIED = {
    not_found: ["Код не найден", "Проверьте, что код введён целиком и без опечаток."],
    already_redeemed: ["Код уже погашен", "Этот приз уже выдавали. Повторно он не действует."],
    expired: ["Срок кода истёк", "Приз сгорел и выдаче не подлежит."],
    bad_format: ["Неверный формат", "Код выглядит так: NX-1A2B3C4D."]
  };

  function showPeek(res) {
    el.deskResult.innerHTML = "";

    if (!res.found) {
      showVerdict({ ok: false, reason: res.reason || "not_found" });
      return;
    }

    if (res.status !== "ok") {
      showVerdict({ ok: false, reason: res.status, extra: res });
      return;
    }

    var box = document.createElement("div");
    box.className = "verdict ok";
    box.appendChild(fill("verdict-icon", "🎁"));
    box.appendChild(fill("verdict-title", res.title));
    box.appendChild(fill("verdict-sub", "Выигран " + shortDate(res.wonAt) + " · сгорает через " + until(res.expiresAt)));
    box.appendChild(fill("verdict-client", "Клиент: " + res.client));

    var confirm = document.createElement("button");
    confirm.className = "btn";
    confirm.type = "button";
    confirm.textContent = "Погасить и выдать";
    confirm.style.marginTop = "14px";
    confirm.style.width = "100%";
    box.appendChild(confirm);

    confirm.addEventListener("click", function () {
      confirm.disabled = true;
      confirm.textContent = "Гасим...";
      redeem(res.code);
    });

    el.deskResult.appendChild(box);
    haptic("impact");
  }

  function redeem(code) {
    api("/api/redeem", { method: "POST", body: { code: code } })
      .then(function (res) {
        showVerdict(res);
        if (res.ok) {
          el.deskCode.value = "";
          logRedeemed(res);
        }
      })
      .catch(function (err) {
        showVerdict({ ok: false, reason: (err.data && err.data.reason) || err.message });
      });
  }

  function showVerdict(res) {
    el.deskResult.innerHTML = "";

    var box = document.createElement("div");
    box.className = "verdict " + (res.ok ? "ok" : "fail");

    if (res.ok) {
      box.appendChild(fill("verdict-icon", "✅"));
      box.appendChild(fill("verdict-title", res.title));
      box.appendChild(fill("verdict-sub", "Код погашен. Выдайте приз клиенту."));
      if (res.client) box.appendChild(fill("verdict-client", "Клиент: " + res.client));
      haptic("success");
    } else {
      var text = DENIED[res.reason] || ["Не получилось", "Попробуйте ещё раз."];
      box.appendChild(fill("verdict-icon", "⛔"));
      box.appendChild(fill("verdict-title", text[0]));
      box.appendChild(fill("verdict-sub", text[1]));
      if (res.extra && res.extra.client) {
        box.appendChild(fill("verdict-client", "Клиент: " + res.extra.client));
      }
      haptic("error");
    }

    el.deskResult.appendChild(box);
  }

  function logRedeemed(res) {
    var li = document.createElement("li");
    li.className = "card";
    li.appendChild(row("✅", res.title, (res.client || "") + " · " + res.code, timeNow()));
    el.deskLog.insertBefore(li, el.deskLog.firstChild);
  }

  function timeNow() {
    var d = new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* ============================================================ кабинет владельца */

  // Отчёт перечитываем при каждом открытии вкладки: владелец смотрит
  // на живые цифры, а не на срез момента, когда приложение запустилось.
  function loadAdmin() {
    loadStats();
  }

  function loadStats() {
    el.statTiles.innerHTML = '<p class="skeleton">Считаем...</p>';

    api("/api/admin?r=stats&days=" + state.adminDays)
      .then(function (data) {
        state.currency = data.currency || "₸";
        renderToday(data.today);
        renderChart(data.daily);
        renderLiability(data.liability);
        renderTiles(data.summary, data.previous);
        renderFunnel(data.prizes);
        renderOutstanding(data.outstanding, data.liability);
        renderSources(data.sources);
        renderActivity(data.activity);
      })
      .catch(function (err) {
        el.statTiles.innerHTML = "";
        el.statTiles.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function money(value) {
    var n = Number(value) || 0;
    return Math.round(n).toLocaleString("ru-RU") + " " + state.currency;
  }

  function renderToday(t) {
    if (!t) return;
    el.todayTiles.innerHTML = "";

    [
      { value: t.spins,     label: "прокрутов",        cls: "accent" },
      { value: t.checkins,  label: "визитов по QR",    cls: "" },
      { value: t.newcomers, label: "новых клиентов",   cls: "" },
      { value: money(t.spent), label: "выдано призов", cls: "warn" }
    ].forEach(function (item) {
      var box = document.createElement("div");
      box.className = "tile " + item.cls;
      box.appendChild(fill("tile-value", String(item.value)));
      box.appendChild(fill("tile-label", item.label));
      el.todayTiles.appendChild(box);
    });
  }

  // Столбики масштабируем от максимума за неделю: абсолютная высота
  // ничего не сказала бы, а относительная сразу показывает провалы.
  function renderChart(daily) {
    el.chart.innerHTML = "";
    if (!daily || !daily.length) return;

    var peak = daily.reduce(function (m, d) { return Math.max(m, d.spins); }, 0);
    var today = new Date().toISOString().slice(0, 10);

    daily.forEach(function (d) {
      var bar = document.createElement("div");
      bar.className = "bar" + (d.day === today ? " today" : "") + (d.spins === 0 ? " zero" : "");

      bar.appendChild(fill("bar-value", String(d.spins)));

      var fillEl = document.createElement("div");
      fillEl.className = "bar-fill";
      fillEl.style.height = (peak > 0 ? Math.max(3, (d.spins / peak) * 100) : 3) + "%";
      bar.appendChild(fillEl);

      bar.appendChild(fill("bar-day", weekday(d.day)));
      el.chart.appendChild(bar);
    });
  }

  var WEEKDAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

  function weekday(iso) {
    var d = new Date(iso + "T00:00:00");
    return isNaN(d.getTime()) ? "" : WEEKDAYS[d.getDay()];
  }

  function renderLiability(l) {
    if (!l) return;
    el.liability.innerHTML = "";

    var left = document.createElement("div");
    left.appendChild(fill("liability-main", String(l.count)));
    left.appendChild(fill("liability-label", "призов не забрано"));

    el.liability.appendChild(left);
    el.liability.appendChild(fill("liability-money", money(l.cost)));
  }

  function renderTiles(cur, prev) {
    if (!cur) return;

    var takeRate = cur.prizesWon > 0 ? Math.round((cur.redeemed / cur.prizesWon) * 100) : 0;

    var tiles = [
      { value: cur.checkins,      label: "визитов по QR",   cls: "accent", key: "checkins" },
      { value: cur.spins,         label: "прокрутов",       cls: "",       key: "spins" },
      { value: money(cur.spent),  label: "выдано призов",   cls: "warn",   key: "spent" },
      { value: takeRate + "%",    label: "призов забрали",  cls: takeRate >= 50 ? "accent" : "warn" },
      { value: cur.prizesWon,     label: "призов выиграно", cls: "",       key: "prizesWon" },
      { value: cur.uniqueClients, label: "клиентов крутили",cls: "",       key: "uniqueClients" },
      { value: cur.newClients,    label: "новых клиентов",  cls: "",       key: "newClients" },
      { value: cur.totalClients,  label: "всего в базе",    cls: "" }
    ];

    el.statTiles.innerHTML = "";

    tiles.forEach(function (t) {
      var box = document.createElement("div");
      box.className = "tile " + t.cls;
      box.appendChild(fill("tile-value", String(t.value)));
      box.appendChild(fill("tile-label", t.label));

      if (t.key && prev) {
        var d = delta(cur[t.key], prev[t.key]);
        if (d) box.appendChild(d);
      }

      el.statTiles.appendChild(box);
    });
  }

  // Сравнение с предыдущим отрезком той же длины: за 7 дней — с прошлой
  // неделей, за 30 — с прошлым месяцем.
  function delta(now, before) {
    var a = Number(now) || 0;
    var b = Number(before) || 0;

    if (b === 0 && a === 0) return null;

    var node = document.createElement("div");
    node.className = "tile-delta delta ";

    if (b === 0) {
      node.className += "up";
      node.textContent = "↑ новое";
      return node;
    }

    var pct = Math.round(((a - b) / b) * 100);
    node.className += pct > 0 ? "up" : (pct < 0 ? "down" : "flat");
    node.textContent = (pct > 0 ? "↑ +" : (pct < 0 ? "↓ " : "= ")) + pct + "% к прошлому периоду";
    return node;
  }

  // Воронка приза: выпал -> забрали -> висит на руках -> сгорел.
  // Цифры сходятся: выпал = забрали + на руках + сгорел.
  function renderFunnel(prizes) {
    var table = el.funnelTable;
    table.innerHTML = "";

    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Приз", "Выпал", "Забрали", "На руках", "Сгорел", "%", "Потрачено"].forEach(function (label) {
      var th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement("tbody");
    var totals = { won: 0, redeemed: 0, outstanding: 0, expired: 0, spent: 0 };

    (prizes || []).forEach(function (p) {
      totals.won += p.won;
      totals.redeemed += p.redeemed;
      totals.outstanding += p.outstanding;
      totals.expired += p.expired;
      totals.spent += Number(p.spent) || 0;

      var rate = p.won > 0 ? Math.round((p.redeemed / p.won) * 100) : null;
      var tr = document.createElement("tr");

      tr.appendChild(cell(emoji(p.icon || "🎁") + " " + (p.short_title || p.title || p.key), ""));
      tr.appendChild(cell(p.won, "num"));
      tr.appendChild(cell(p.redeemed, "num"));
      tr.appendChild(cell(p.outstanding, "num out"));
      tr.appendChild(cell(p.expired, "num"));
      tr.appendChild(cell(rate === null ? "—" : rate + "%", "num " + rateClass(rate)));
      tr.appendChild(cell(money(p.spent), "num"));

      body.appendChild(tr);
    });

    table.appendChild(body);

    var overall = totals.won > 0 ? Math.round((totals.redeemed / totals.won) * 100) : 0;
    el.funnelFoot.textContent = totals.won === 0
      ? "За выбранный период призов ещё не выигрывали."
      : "Всего за период: выпало " + totals.won + ", забрали " + totals.redeemed +
        " (" + overall + "%), сгорело " + totals.expired + ", потрачено " + money(totals.spent) +
        ". Считаем только забранные призы: невыкупленный код денег клубу не стоит. " +
        "Низкий процент значит, что призы выигрывают, но за ними не приходят — стоит увеличить срок или заменить приз.";
  }

  function cell(text, cls) {
    var td = document.createElement("td");
    if (cls) td.className = cls;
    td.textContent = String(text);
    return td;
  }

  function rateClass(rate) {
    if (rate === null) return "";
    if (rate >= 60) return "rate-good";
    if (rate >= 30) return "rate-mid";
    return "rate-bad";
  }

  // Живые невыкупленные коды — это обязательства клуба: столько бонусов
  // клиенты вправе прийти и забрать в любой момент.
  function renderOutstanding(list, liability) {
    el.outstandingList.innerHTML = "";

    if (!list || !list.length) {
      el.outstandingList.appendChild(fill("skeleton", "Невыкупленных призов нет"));
      el.outstandingFoot.textContent = "";
      return;
    }

    list.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "card";
      var who = item.first_name || (item.username ? "@" + item.username : "клиент " + item.code);
      var left = new Date(item.expires_at).getTime() - Date.now();
      var soon = left < 24 * 3600000;

      li.appendChild(row(
        item.icon || "🎁",
        item.title,
        who + " · " + item.code,
        span(soon ? "soon" : "", until(item.expires_at))
      ));
      el.outstandingList.appendChild(li);
    });

    var total = liability ? liability.count : list.length;
    el.outstandingFoot.textContent = "Всего активных кодов: " + total +
      (list.length < total ? " (показаны ближайшие " + list.length + " по сроку сгорания)" : "") +
      ". Тем, у кого приз сгорает завтра, есть смысл напомнить — это готовый повод для визита.";
  }

  function renderSources(sources) {
    el.sourcesList.innerHTML = "";

    if (!sources || !sources.length) {
      el.sourcesList.appendChild(fill("skeleton", "Переходов по QR пока не было"));
      return;
    }

    sources.forEach(function (s) {
      var li = document.createElement("li");
      li.className = "card";
      li.appendChild(row("📍", s.source, "метка QR-точки", String(s.count)));
      el.sourcesList.appendChild(li);
    });
  }

  var EVENT_LABEL = {
    checkin: "визит по QR",
    spin: "прокрут",
    redeem: "погашен код",
    grant: "начислен прокрут вручную"
  };

  function renderActivity(items) {
    el.activityList.innerHTML = "";

    if (!items || !items.length) {
      el.activityList.appendChild(fill("skeleton", "Пока пусто"));
      return;
    }

    items.forEach(function (e) {
      var li = document.createElement("li");
      li.className = "card";

      var who = e.user_name || (e.user_username ? "@" + e.user_username : "клиент " + (e.user_id || ""));
      var detail = who;
      if (e.code) detail += " · " + e.code;
      if (e.actor_name) detail += " · сотрудник: " + e.actor_name;

      li.appendChild(row(iconFor(e.type), EVENT_LABEL[e.type] || e.type, detail, ago(e.created_at)));
      el.activityList.appendChild(li);
    });
  }

  function iconFor(type) {
    if (type === "checkin") return "📲";
    if (type === "spin") return "🎰";
    if (type === "redeem") return "✅";
    return "➕";
  }

  /* ---------------------------------------------------- редактор призов */

  function loadPrizes() {
    if (state.prizes) return;
    el.prizeEditor.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin?r=prizes")
      .then(function (data) {
        state.prizes = data.prizes || [];
        renderPrizeEditor();
      })
      .catch(function (err) {
        el.prizeEditor.innerHTML = "";
        el.prizeEditor.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function renderPrizeEditor() {
    el.prizeEditor.innerHTML = "";

    var total = state.prizes.reduce(function (s, p) { return s + (p.enabled ? p.weight : 0); }, 0);

    state.prizes.forEach(function (prize) {
      var box = document.createElement("div");
      box.className = "prize-edit" + (prize.enabled ? "" : " off");

      var head = document.createElement("div");
      head.className = "prize-head";

      var icon = document.createElement("div");
      icon.className = "card-icon";
      icon.textContent = emoji(prize.icon || "🎁");
      head.appendChild(icon);

      var name = document.createElement("div");
      name.className = "card-title";
      var chance = total > 0 && prize.enabled ? Math.round((prize.weight / total) * 100) : 0;
      name.textContent = (prize.title || prize.short_title || prize.key) + " — " + chance + "%";
      head.appendChild(name);

      var toggle = document.createElement("label");
      toggle.className = "switch";
      var check = input("checkbox", prize.enabled);
      toggle.appendChild(check);
      head.appendChild(toggle);

      box.appendChild(head);

      var grid = document.createElement("div");
      grid.className = "grid";

      var fTitle = field("Название", input("text", prize.title || ""), true);
      var fDesc  = field("Описание на карточке", input("text", prize.description || ""), true);
      var fShort = field("Короткая подпись", input("text", prize.short_title || ""));
      var fIcon  = field("Иконка", input("text", prize.icon || ""));
      var fWeight = weightField(prize, total);
      var fCost = field("Себестоимость, " + state.currency, input("number", prize.cost));
      var fDays  = field("Сгорает через, дней", input("number", prize.expires_in_days));
      var fLimit = field("Лимит в сутки", input("number", prize.daily_limit === null ? "" : prize.daily_limit));
      var fColor = field("Цвет сектора", input("color", prize.color || "#a6ff2f"));

      [fTitle, fDesc, fShort, fIcon, fWeight, fCost, fDays, fLimit, fColor].forEach(function (f) { grid.appendChild(f.wrap); });
      box.appendChild(grid);

      var save = document.createElement("button");
      save.className = "btn";
      save.type = "button";
      save.textContent = "Сохранить";
      save.style.marginTop = "11px";
      save.style.width = "100%";
      box.appendChild(save);

      save.addEventListener("click", function () {
        save.disabled = true;
        save.textContent = "Сохраняем...";

        var patch = {
          key: prize.key,
          title: fTitle.input.value || null,
          description: fDesc.input.value || null,
          short_title: fShort.input.value || null,
          icon: fIcon.input.value || null,
          weight: Number(fWeight.input.value),
          cost: Number(fCost.input.value),
          expires_in_days: Number(fDays.input.value),
          daily_limit: fLimit.input.value === "" ? null : Number(fLimit.input.value),
          color: fColor.input.value,
          enabled: check.checked
        };

        api("/api/admin?r=prizes", { method: "PATCH", body: patch })
          .then(function (res) {
            Object.assign(prize, res.prize);
            state.prizes = null;
            toast("Сохранено");
            haptic("success");
            // Колесо читает те же строки, поэтому перетягиваем конфиг —
            // сектор сразу меняет ширину, цвет и подпись.
            return api("/api/config").then(function (cfg) {
              state.sectors = cfg.sectors || [];
              idleStrip();
            });
          })
          .then(function () { loadPrizes(); })
          .catch(function (err) { toast("Ошибка: " + err.message, true); })
          .then(function () {
            save.disabled = false;
            save.textContent = "Сохранить";
          });
      });

      el.prizeEditor.appendChild(box);
    });
  }

  // Ползунок вместо голого числа: владелец правит вероятность на ощупь
  // и сразу видит, во сколько процентов это превращается.
  function weightField(prize, total) {
    var wrap = document.createElement("div");
    wrap.className = "field wide";

    var label = document.createElement("label");
    wrap.appendChild(label);

    var slider = document.createElement("input");
    slider.type = "range";
    slider.min = 0;
    slider.max = 100;
    slider.value = prize.weight;
    slider.className = "slider";
    wrap.appendChild(slider);

    function refresh() {
      var w = Number(slider.value);
      // Пересчитываем от суммы без этого приза, иначе процент врёт
      // при перетаскивании.
      var rest = total - (prize.enabled ? prize.weight : 0);
      var pct = w + rest > 0 ? Math.round((w / (w + rest)) * 100) : 0;
      label.textContent = "Вес: " + w + "  —  шанс около " + pct + "%";
    }

    slider.addEventListener("input", refresh);
    refresh();

    return { wrap: wrap, input: slider };
  }

  function field(label, inputNode, wide) {
    var wrap = document.createElement("div");
    wrap.className = "field" + (wide ? " wide" : "");
    var lab = document.createElement("label");
    lab.textContent = label;
    wrap.appendChild(lab);
    wrap.appendChild(inputNode);
    return { wrap: wrap, input: inputNode };
  }

  function input(type, value) {
    var node = document.createElement("input");
    node.type = type;
    if (type === "checkbox") node.checked = Boolean(value);
    else node.value = value === null || value === undefined ? "" : value;
    return node;
  }

  /* ---------------------------------------------------- клиенты */

  var clients = [];

  function loadClients() {
    el.clientsList.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin?r=clients")
      .then(function (data) {
        clients = data.clients || [];

        var lost = clients.filter(function (c) {
          return c.last_seen && Date.now() - new Date(c.last_seen).getTime() > 14 * 86400000;
        }).length;

        el.clientsFoot.textContent = "Всего " + clients.length + " клиентов. " +
          (lost > 0
            ? lost + " не заходили больше двух недель — их можно вернуть бонусным прокрутом."
            : "Все заходили в последние две недели.");

        renderClients();
      })
      .catch(function (err) {
        el.clientsList.innerHTML = "";
        el.clientsList.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function renderClients() {
    var query = el.clientSearch.value.trim().toLowerCase();

    var shown = clients.filter(function (c) {
      if (state.clientSort === "blocked" && !c.blocked) return false;
      if (!query) return true;
      return String(c.id).indexOf(query) !== -1 ||
             (c.first_name || "").toLowerCase().indexOf(query) !== -1 ||
             (c.username || "").toLowerCase().indexOf(query) !== -1 ||
             (c.phone || "").indexOf(query) !== -1;
    });

    // Сервер отдаёт список от свежих к старым; для ретеншена нужен
    // обратный порядок — кто пропал дольше всех.
    if (state.clientSort === "lost") {
      shown = shown.slice().reverse();
    }

    el.clientsList.innerHTML = "";

    if (!shown.length) {
      el.clientsList.appendChild(fill("skeleton", query ? "Никого не нашлось" : "Пусто"));
      return;
    }

    shown.forEach(function (c) { el.clientsList.appendChild(clientCard(c)); });
  }

  function clientCard(c) {
    var li = document.createElement("li");
    li.className = "card" + (c.blocked ? " blocked" : "");

    var nameNode = document.createElement("span");
    nameNode.textContent = c.first_name || (c.username ? "@" + c.username : "ID " + c.id);

    var title = document.createElement("span");
    title.appendChild(nameNode);
    if (c.blocked) title.appendChild(span("badge", "заблокирован"));

    var parts = [ago(c.last_seen), "визитов: " + (c.visits_total || 0),
                 "выиграл: " + c.won, "забрал: " + c.redeemed];
    if (c.holding) parts.push("на руках: " + c.holding);
    if (c.phone) parts.push(c.phone);

    var side = document.createElement("div");
    side.className = "client-side";

    var counter = document.createElement("b");
    counter.textContent = c.visits_available || 0;
    side.appendChild(counter);

    var give = document.createElement("button");
    give.className = "btn tiny";
    give.type = "button";
    give.textContent = "+";
    give.title = "Начислить прокруты";
    side.appendChild(give);

    give.addEventListener("click", function () {
      give.disabled = true;
      grantTo(c.id, grantAmount())
        .then(function (res) {
          c.visits_available = res.spinsAvailable;
          counter.textContent = res.spinsAvailable;
          toast("Начислено " + res.granted + " · у клиента теперь " + res.spinsAvailable);
        })
        .catch(function () {})
        .then(function () { give.disabled = false; });
    });

    var wrap = row("👤", "", null, side);
    // Заголовок собираем узлами: там значок блокировки рядом с именем.
    var titleSlot = wrap.querySelector(".card-title");
    titleSlot.textContent = "";
    titleSlot.appendChild(title);
    wrap.querySelector(".card-main").appendChild(fill("card-sub", parts.join(" · ")));

    li.appendChild(wrap);

    var ban = document.createElement("button");
    ban.className = "btn " + (c.blocked ? "ghost" : "danger");
    ban.type = "button";
    ban.textContent = c.blocked ? "Разблокировать" : "Заблокировать";
    ban.style.marginTop = "9px";
    ban.style.width = "100%";

    ban.addEventListener("click", function () {
      ban.disabled = true;
      api("/api/admin?r=block", { method: "POST", body: { userId: c.id, blocked: !c.blocked } })
        .then(function () {
          c.blocked = !c.blocked;
          toast(c.blocked ? "Клиент заблокирован" : "Клиент разблокирован");
          haptic("success");
          renderClients();
        })
        .catch(function (err) { toast("Ошибка: " + err.message, true); ban.disabled = false; });
    });

    li.appendChild(ban);
    return li;
  }

  function grantAmount() {
    return Math.max(1, Math.min(20, Math.round(Number(el.grantAmount.value)) || 1));
  }

  // Начисление идёт через сервер и попадает в ленту действий: видно,
  // кто и кому выдал прокруты.
  function grantTo(userId, amount) {
    return api("/api/admin?r=grant", { method: "POST", body: { userId: userId, amount: amount } })
      .then(function (res) {
        haptic("success");
        return res;
      })
      .catch(function (err) {
        toast("Ошибка: " + err.message, true);
        throw err;
      });
  }

  /* ---------------------------------------------------- клуб: настройки и персонал */

  function loadTeam() {
    renderSettings();
    renderStaffForm();
    loadStaff();
    loadConfigLog();
  }

  // Файл уходит сообщением в чат бота: мини-апп внутри Telegram не может
  // сохранить файл на устройство, а документ из чата открывается в Excel
  // одним нажатием и никуда не денется.
  function bindExport() {
    el.exportNav.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg");
      if (!btn) return;
      state.exportDays = Number(btn.dataset.days);
      markActive(el.exportNav, btn);
    });

    el.exportBtn.addEventListener("click", function () {
      el.exportBtn.disabled = true;
      el.exportBtn.textContent = "Готовим файл...";

      api("/api/admin?r=export&days=" + state.exportDays, { method: "POST" })
        .then(function (res) {
          if (res.reason === "empty") {
            toast("За этот период призов не было", true);
          } else if (res.ok) {
            toast("Файл отправлен в чат с ботом · строк: " + res.rows);
            haptic("success");
          } else {
            toast("Не удалось отправить файл", true);
          }
        })
        .catch(function (err) { toast("Ошибка: " + err.message, true); })
        .then(function () {
          el.exportBtn.disabled = false;
          el.exportBtn.textContent = "Выгрузить в CSV";
        });
    });
  }

  var FIELD_NAMES = {
    title: "название", description: "описание", short_title: "подпись",
    icon: "иконка", weight: "вес", cost: "себестоимость",
    expires_in_days: "срок", daily_limit: "лимит в сутки", color: "цвет",
    enabled: "включён", sort_order: "порядок", club_name: "название клуба",
    spin_cooldown_hours: "кулдаун", max_unused_prizes: "кап призов",
    checkin_enabled: "начисление по QR", blocked: "блокировка"
  };

  function loadConfigLog() {
    el.configLog.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin?r=log")
      .then(function (data) {
        var items = data.log || [];
        el.configLog.innerHTML = "";

        if (!items.length) {
          el.configLog.appendChild(fill("skeleton", "Настройки пока не меняли"));
          return;
        }

        items.forEach(function (entry) {
          var li = document.createElement("li");
          li.className = "card";
          li.appendChild(row("✏️", describeEntity(entry), describeChanges(entry.changes), ago(entry.created_at)));
          el.configLog.appendChild(li);
        });
      })
      .catch(function (err) {
        el.configLog.innerHTML = "";
        el.configLog.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function describeEntity(entry) {
    if (entry.entity === "settings") return entry.actor + " — настройки клуба";
    if (entry.entity === "client") return entry.actor + " — клиент " + entry.entity_key;
    return entry.actor + " — приз " + entry.entity_key;
  }

  function describeChanges(changes) {
    if (!changes) return "";
    return Object.keys(changes).map(function (field) {
      var c = changes[field];
      var name = FIELD_NAMES[field] || field;
      return c.from === undefined || c.from === null || c.from === ""
        ? name + " → " + c.to
        : name + ": " + c.from + " → " + c.to;
    }).join(" · ");
  }

  /* ---------------------------------------------------- связь с клиентами */

  var castAudience = "all";
  var castSizes = {};
  var castResume = null;   // id прерванной рассылки: её продолжаем, а не начинаем заново

  var AUDIENCE_NOTE = {
    all:     "все, кому бот может писать",
    active:  "были в клубе за последние 30 дней",
    lapsed:  "не были больше 30 дней — повод вернуть",
    holding: "есть невыкупленный приз на руках"
  };

  var AUDIENCE_LABEL = {
    all: "Все", active: "Активные", lapsed: "Пропали", holding: "С призом"
  };

  function loadComms() {
    renderRemindForm();
    loadBroadcasts();
  }

  function renderRemindForm() {
    if (el.remindForm.dataset.ready) return;
    el.remindForm.dataset.ready = "1";
    el.remindForm.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin?r=settings")
      .then(function (data) {
        var s = data.settings;
        el.remindForm.innerHTML = "";

        var toggle = document.createElement("label");
        toggle.className = "switch";
        var check = input("checkbox", s.reminders_enabled !== false);
        toggle.appendChild(check);
        toggle.appendChild(document.createTextNode("Напоминать о сгорании призов"));

        var fHours = field("Предупреждать за, часов", input("number", s.reminder_hours || 24), true);
        var fGrace = field("Добавлять к сроку, минут",
                           input("number", s.reminder_grace_minutes == null ? 30 : s.reminder_grace_minutes), true);

        var save = document.createElement("button");
        save.className = "btn";
        save.type = "button";
        save.textContent = "Сохранить";

        el.remindForm.appendChild(toggle);
        el.remindForm.appendChild(fHours.wrap);
        el.remindForm.appendChild(fGrace.wrap);
        el.remindForm.appendChild(save);

        save.addEventListener("click", function () {
          save.disabled = true;
          api("/api/admin?r=settings", {
            method: "PATCH",
            body: {
              reminders_enabled: check.checked,
              reminder_hours: Number(fHours.input.value),
              reminder_grace_minutes: Number(fGrace.input.value)
            }
          })
            .then(function () { toast("Сохранено"); haptic("success"); })
            .catch(function (err) { toast("Ошибка: " + err.message, true); })
            .then(function () { save.disabled = false; });
        });
      })
      .catch(function (err) {
        el.remindForm.dataset.ready = "";
        el.remindForm.innerHTML = "";
        el.remindForm.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function loadBroadcasts() {
    api("/api/admin?r=broadcast")
      .then(function (data) {
        castSizes = data.audiences || {};
        renderAudienceFoot();
        renderCastHistory(data.broadcasts || []);
      })
      .catch(function (err) {
        el.castList.innerHTML = "";
        el.castList.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  // Владелец должен видеть размер аудитории до отправки, а не после.
  // Отдельной строкой — те, до кого дотянуться нельзя: это не ошибка,
  // а следствие того, что мини-апп можно открыть, ни разу не написав боту.
  function renderAudienceFoot() {
    var count = castSizes[castAudience];
    var text = "Получат: " + (count == null ? "?" : count) + " — " + AUDIENCE_NOTE[castAudience] + ".";

    if (castSizes.unreachable) {
      text += " Ещё " + castSizes.unreachable + " не получат: они открывали приложение, но не запускали бота, " +
              "а Telegram запрещает боту писать первым без разрешения.";
    }

    el.castAudienceFoot.textContent = text;
  }

  /* ------------------------------------------------ вложение рассылки */

  var castPhotoId = null;              // file_id картинки на серверах Telegram
  var CAPTION_LIMIT = 1024;            // столько Telegram разрешает в подписи к фото
  var TEXT_LIMIT = 3500;

  function attachPhoto() {
    var file = el.castPhoto.files && el.castPhoto.files[0];
    if (!file) return;

    el.castPhotoBtn.textContent = "Загружаем...";

    shrinkImage(file, 1600, 0.85)
      .then(function (dataUrl) {
        el.castPhotoImg.src = dataUrl;
        return api("/api/admin?r=photo", { method: "POST", body: { data: dataUrl } });
      })
      .then(function (res) {
        castPhotoId = res.fileId;
        el.castPhotoPreview.hidden = false;
        el.castPhotoBtn.textContent = "Заменить фото";
        updateCastLimit();
        haptic("success");
      })
      .catch(function (err) {
        clearPhoto();
        toast("Не удалось загрузить фото: " + err.message, true);
      })
      .then(function () {
        // Сброс поля: иначе повторный выбор того же файла не вызовет
        // событие change и кнопка залипнет.
        el.castPhoto.value = "";
      });
  }

  function clearPhoto() {
    castPhotoId = null;
    el.castPhoto.value = "";
    el.castPhotoImg.removeAttribute("src");
    el.castPhotoPreview.hidden = true;
    el.castPhotoBtn.textContent = "Прикрепить фото";
    updateCastLimit();
  }

  // Телефон снимает по несколько мегабайт, а тело запроса ограничено.
  // Ужимаем в браузере: Telegram всё равно пережимает фотографии у себя,
  // так что видимого качества это не стоит.
  function shrinkImage(file, maxSide, quality) {
    return loadBitmap(file).then(function (img) {
      var w = img.width, h = img.height;
      var scale = Math.min(1, maxSide / Math.max(w, h));

      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);

      if (img.close) img.close();
      return canvas.toDataURL("image/jpeg", quality);
    });
  }

  // createImageBitmap умеет развернуть снимок по метке EXIF — без этого
  // афиша, снятая вертикально, уходит клиентам боком. Там, где его нет,
  // падаем на обычный Image.
  function loadBitmap(file) {
    if (window.createImageBitmap) {
      try {
        return createImageBitmap(file, { imageOrientation: "from-image" });
      } catch (e) {
        // Старые реализации не знают второго аргумента.
      }
    }

    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("файл не читается"));
      };

      img.src = url;
    });
  }

  function updateCastLimit() {
    var limit = castPhotoId ? CAPTION_LIMIT : TEXT_LIMIT;
    var left = limit - el.castText.value.length;

    if (castPhotoId) {
      el.castLimit.textContent = left < 0
        ? "Текст длиннее подписи к фото на " + (-left) + " симв. Telegram разрешает только " + CAPTION_LIMIT + " — сократите или уберите фото."
        : "С фотографией текст уходит подписью: осталось " + left + " симв. из " + CAPTION_LIMIT + ".";
    } else {
      el.castLimit.textContent = left < 500 ? "Осталось символов: " + left + "." : "";
    }
  }

  function remindNow() {
    el.remindNow.disabled = true;
    el.remindResult.textContent = "Отправляем...";

    api("/api/admin?r=remind", { method: "POST" })
      .then(function (res) {
        el.remindResult.textContent = res.found
          ? "Отправлено " + res.sent + " из " + res.found +
            (res.failed ? ", не дошло: " + res.failed : "") + "."
          : "Предупреждать сейчас некого: призов, сгорающих в ближайшие часы, нет.";
        haptic("success");
      })
      .catch(function (err) { el.remindResult.textContent = "Ошибка: " + err.message; })
      .then(function () { el.remindNow.disabled = false; });
  }

  function startBroadcast() {
    // Прерванную рассылку продолжаем по её id. Создать новую означало бы
    // отправить второе сообщение тем, кто уже получил первое.
    if (castResume) {
      runBroadcast(castResume.id, castResume.total);
      return;
    }

    var text = el.castText.value.trim();
    if (!text) {
      toast("Сначала напишите текст", true);
      return;
    }

    var limit = castPhotoId ? CAPTION_LIMIT : TEXT_LIMIT;
    if (text.length > limit) {
      toast("Текст длиннее " + limit + " символов", true);
      updateCastLimit();
      return;
    }

    var count = castSizes[castAudience] || 0;
    if (!count) {
      toast("В этой аудитории сейчас никого нет", true);
      return;
    }

    askConfirm("Отправить сообщение " + count + " клиентам? Отменить отправку будет нельзя.", function () {
      el.castSend.disabled = true;
      el.castProgressFoot.textContent = "Готовим список получателей...";
      el.castProgress.hidden = false;

      api("/api/admin?r=broadcast", {
        method: "POST",
        body: { text: text, audience: castAudience, photo: castPhotoId }
      })
        .then(function (created) {
          runBroadcast(created.id, created.total);
        })
        .catch(function (err) {
          el.castProgressFoot.textContent = "Не удалось создать рассылку: " + err.message;
          el.castSend.disabled = false;
        });
    });
  }

  // Отправка идёт партиями по 25: столько успевает уйти за один вызов,
  // не упираясь ни в лимит Telegram, ни в лимит времени функции.
  // Каждый ответ приносит прогресс, поэтому владелец видит движение,
  // а не замерший экран.
  function runBroadcast(id, total) {
    castResume = null;
    el.castSend.disabled = true;
    el.castProgress.hidden = false;

    step();

    function step() {
      api("/api/admin?r=broadcast&id=" + id, { method: "PATCH" })
        .then(function (p) {
          updateProgress(p, total);

          if (p.pending > 0) {
            step();
            return;
          }

          el.castSend.disabled = false;
          el.castSend.textContent = "Отправить рассылку";
          el.castText.value = "";
          clearPhoto();
          toast("Рассылка отправлена");
          haptic("success");
          loadBroadcasts();
        })
        .catch(function (err) {
          // Список получателей помнит, кому уже ушло, поэтому продолжить
          // безопасно: повторных сообщений не будет.
          castResume = { id: id, total: total };
          el.castSend.disabled = false;
          el.castSend.textContent = "Продолжить рассылку";
          el.castProgressFoot.textContent = "Прервалось: " + err.message +
            ". Нажмите «Продолжить» — те, кому уже дошло, второй раз не получат.";
        });
    }
  }

  function updateProgress(p, total) {
    var done = (p.sent || 0) + (p.failed || 0);
    var pct = total ? Math.round((done / total) * 100) : 100;

    el.castBar.style.width = pct + "%";
    el.castProgressFoot.textContent = "Отправлено " + done + " из " + total +
      (p.failed ? " · не дошло: " + p.failed : "");
  }

  function renderCastHistory(list) {
    el.castList.innerHTML = "";

    if (!list.length) {
      el.castList.appendChild(fill("skeleton", "Рассылок ещё не было."));
      return;
    }

    list.forEach(function (b) {
      var li = document.createElement("li");
      li.className = "card";

      var side = b.status === "done"
        ? span("", b.sent + " из " + b.total)
        : span("soon", b.sent + " из " + b.total);

      li.appendChild(row(b.photo_file_id ? "🖼" : "📣", firstLine(b.text),
                         AUDIENCE_LABEL[b.audience] || b.audience, side));

      var hint = fill("card-hint", shortDate(b.created_at) +
        (b.failed ? " · не дошло: " + b.failed : ""));
      hint.style.textAlign = "left";
      li.appendChild(hint);

      el.castList.appendChild(li);
    });
  }

  // В списке нужна узнаваемая строка, а не весь текст объявления.
  function firstLine(text) {
    var line = String(text || "").split("\n")[0];
    return line.length > 60 ? line.slice(0, 57) + "..." : line;
  }

  // Telegram рисует свой диалог поверх приложения; window.confirm внутри
  // мини-аппа работает не везде, поэтому он только запасной вариант.
  function askConfirm(text, onYes) {
    if (tg && tg.showConfirm) {
      tg.showConfirm(text, function (ok) { if (ok) onYes(); });
      return;
    }
    if (window.confirm(text)) onYes();
  }

  function renderSettings() {
    if (el.settingsForm.dataset.ready) return;
    el.settingsForm.dataset.ready = "1";
    el.settingsForm.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin?r=settings")
      .then(function (data) {
        var s = data.settings;
        el.settingsForm.innerHTML = "";

        var fName = field("Название клуба", input("text", s.club_name), true);
        var fHours = field("Прокрут по QR не чаще, часов", input("number", s.spin_cooldown_hours), true);
        var fCap = field("Максимум неполученных призов", input("number", s.max_unused_prizes), true);

        var toggleWrap = document.createElement("label");
        toggleWrap.className = "switch";
        var check = input("checkbox", s.checkin_enabled);
        toggleWrap.appendChild(check);
        toggleWrap.appendChild(document.createTextNode("Начислять прокруты по QR"));

        var save = document.createElement("button");
        save.className = "btn";
        save.type = "button";
        save.textContent = "Сохранить настройки";

        el.settingsForm.appendChild(fName.wrap);
        el.settingsForm.appendChild(fHours.wrap);
        el.settingsForm.appendChild(fCap.wrap);
        el.settingsForm.appendChild(toggleWrap);
        el.settingsForm.appendChild(save);

        var note = fill("foot", "24 часа — один прокрут за визит в день. Когда подключим API кассы клуба, здесь можно будет поставить 0 и начислять прокрут за каждую оплату часов. " +
          "Максимум неполученных призов блокирует рулетку, пока клиент не заберёт своё на стойке: 0 снимает ограничение.");
        el.settingsForm.appendChild(note);

        save.addEventListener("click", function () {
          save.disabled = true;
          api("/api/admin?r=settings", {
            method: "PATCH",
            body: {
              club_name: fName.input.value,
              spin_cooldown_hours: Number(fHours.input.value),
              max_unused_prizes: Number(fCap.input.value),
              checkin_enabled: check.checked
            }
          })
            .then(function (res) {
              state.clubName = res.settings.club_name;
              el.clubName.textContent = state.clubName;
              toast("Сохранено");
              haptic("success");
            })
            .catch(function (err) { toast("Ошибка: " + err.message, true); })
            .then(function () { save.disabled = false; });
        });
      })
      .catch(function (err) {
        el.settingsForm.innerHTML = "";
        el.settingsForm.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function renderStaffForm() {
    if (el.staffForm.dataset.ready) return;
    el.staffForm.dataset.ready = "1";

    var fId = field("Telegram ID сотрудника", input("number", ""), true);
    var fTitle = field("Имя (для себя)", input("text", ""), true);

    var add = document.createElement("button");
    add.className = "btn";
    add.type = "button";
    add.textContent = "Добавить сотрудника";

    el.staffForm.appendChild(fId.wrap);
    el.staffForm.appendChild(fTitle.wrap);
    el.staffForm.appendChild(add);
    el.staffForm.appendChild(fill("foot", "Сотрудник узнаёт свой ID командой /id в боте. После добавления он сможет гасить коды призов и начислять прокруты вручную."));

    add.addEventListener("click", function () {
      var id = Number(fId.input.value);
      if (!id) { toast("Введите ID", true); return; }

      add.disabled = true;
      api("/api/admin?r=staff", { method: "POST", body: { id: id, role: "staff", title: fTitle.input.value || null } })
        .then(function () {
          fId.input.value = "";
          fTitle.input.value = "";
          toast("Сотрудник добавлен");
          haptic("success");
          loadStaff();
        })
        .catch(function (err) { toast("Ошибка: " + err.message, true); })
        .then(function () { add.disabled = false; });
    });
  }

  function loadStaff() {
    el.staffList.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin?r=staff")
      .then(function (data) {
        var staff = data.staff || [];
        el.staffList.innerHTML = "";

        staff.forEach(function (member) {
          var li = document.createElement("li");
          li.className = "card";

          var wrap = row(
            member.role === "owner" ? "👑" : "🧑‍💼",
            member.title || ("ID " + member.id),
            member.role === "owner" ? "владелец · ID " + member.id : "сотрудник · ID " + member.id
          );

          if (member.role !== "owner") {
            var del = document.createElement("button");
            del.className = "btn danger";
            del.type = "button";
            del.textContent = "Убрать";
            del.addEventListener("click", function () {
              del.disabled = true;
              api("/api/admin?r=staff&id=" + member.id, { method: "DELETE" })
                .then(function () { toast("Убран"); loadStaff(); })
                .catch(function (err) { toast("Ошибка: " + err.message, true); del.disabled = false; });
            });
            wrap.appendChild(del);
          }

          li.appendChild(wrap);
          el.staffList.appendChild(li);
        });
      })
      .catch(function (err) {
        el.staffList.innerHTML = "";
        el.staffList.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

})();
