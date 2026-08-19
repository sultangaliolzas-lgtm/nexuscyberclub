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
    rotation: 0,      // накопленный угол: колесо всегда крутится вперёд
    spinning: false,
    adminDays: 7,
    prizes: null
  };

  var el = {};
  ["clubName", "spins", "spinsCount", "banner", "rotor", "wheelSvg", "hubLabel", "burst",
   "result", "resultIcon", "resultTitle", "resultSub", "resultCode",
   "spinBtn", "hint", "inventoryList", "inventoryEmpty", "historyBlock", "historyList",
   "tabs", "adminNav", "periodNav", "statTiles", "funnelTable", "funnelFoot",
   "outstandingList", "outstandingFoot", "sourcesList", "activityList",
   "prizeEditor", "clientsList", "clientsFoot", "settingsForm", "staffForm", "staffList",
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
    el.spinBtn.addEventListener("click", handleSpin);
    el.resultCode.addEventListener("click", function () { copy(el.resultCode.dataset.code); });

    // Конфиг колеса не зависит от чек-ина, поэтому тянем его сразу.
    api("/api/config")
      .then(function (cfg) {
        state.clubName = cfg.clubName || "NEXUS";
        state.sectors = cfg.sectors || [];
        el.clubName.textContent = state.clubName;
        el.hubLabel.textContent = state.clubName.slice(0, 2).toUpperCase();
        document.title = state.clubName + " Roulette";
        renderWheel();
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
        state.items = data.items || [];
        state.redeemed = data.redeemed || [];

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
      el.banner.textContent = "✅ Визит засчитан. Прокрут открыт — крути!";
      el.banner.className = "banner";
      el.banner.hidden = false;
      haptic("success");
      return;
    }

    if (res.reason === "cooldown" && res.nextAt) {
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

    el.periodNav.addEventListener("click", function (e) {
      var btn = e.target.closest(".seg");
      if (!btn) return;
      state.adminDays = Number(btn.dataset.days);
      markActive(el.periodNav, btn);
      loadStats();
    });
  }

  function setTab(tab) {
    document.querySelectorAll(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    ["wheel", "inventory", "admin"].forEach(function (name) {
      document.getElementById("view-" + name).hidden = name !== tab;
    });
    if (tab === "admin") loadAdmin();
    window.scrollTo(0, 0);
  }

  function setAdminPane(pane) {
    markActive(el.adminNav, el.adminNav.querySelector('[data-pane="' + pane + '"]'));
    ["stats", "prizes", "clients", "team"].forEach(function (name) {
      document.getElementById("pane-" + name).hidden = name !== pane;
    });
    if (pane === "prizes") loadPrizes();
    if (pane === "clients") loadClients();
    if (pane === "team") loadTeam();
  }

  function markActive(container, btn) {
    container.querySelectorAll(".seg").forEach(function (b) { b.classList.remove("active"); });
    if (btn) btn.classList.add("active");
  }

  /* ============================================================ колесо */

  var R = 92;          // радиус колеса в системе координат SVG (viewBox 200x200)
  var CX = 100, CY = 100;
  var SVG_NS = "http://www.w3.org/2000/svg";

  // Сектор занимает долю круга, равную своей доле в общем весе. То есть
  // шанс, который клиент видит глазами, совпадает с настоящим — и когда
  // владелец правит вес в кабинете, колесо перерисовывается вместе с ним.
  function layout() {
    var total = state.sectors.reduce(function (s, x) { return s + x.weight; }, 0);
    if (total <= 0) return [];

    var acc = 0;
    return state.sectors.map(function (sector) {
      var span = (sector.weight / total) * 360;
      var item = { sector: sector, start: acc, span: span, mid: acc + span / 2 };
      acc += span;
      return item;
    });
  }

  function renderWheel() {
    var svg = el.wheelSvg;
    svg.innerHTML = "";

    var slices = layout();
    if (!slices.length) return;

    slices.forEach(function (slice) {
      var color = slice.sector.color || "#a6ff2f";

      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", arcPath(slice.start, slice.start + slice.span));
      path.setAttribute("fill", color);
      path.setAttribute("stroke", "#0b0c10");
      path.setAttribute("stroke-width", "0.8");
      svg.appendChild(path);

      var ink = readableOn(color);

      if (slice.sector.icon) {
        svg.appendChild(radialText(slice.sector.icon, slice.mid, 66, "sector-icon", ink));
      }

      // В узкий сектор подпись не влезет и превратится в кашу — там
      // оставляем только иконку.
      if (slice.span >= 24 && slice.sector.shortTitle) {
        svg.appendChild(radialText(trim(slice.sector.shortTitle, 12), slice.mid, 41, "sector-label", ink));
      }
    });

    var rim = document.createElementNS(SVG_NS, "circle");
    rim.setAttribute("cx", CX);
    rim.setAttribute("cy", CY);
    rim.setAttribute("r", R + 3);
    rim.setAttribute("fill", "none");
    rim.setAttribute("stroke", "#a6ff2f");
    rim.setAttribute("stroke-width", "2.5");
    svg.appendChild(rim);

    slices.forEach(function (slice) {
      var p = pointAt(slice.start, R + 3);
      var dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", p.x);
      dot.setAttribute("cy", p.y);
      dot.setAttribute("r", "2.4");
      dot.setAttribute("fill", "#0b0c10");
      dot.setAttribute("stroke", "#a6ff2f");
      dot.setAttribute("stroke-width", "1");
      svg.appendChild(dot);
    });
  }

  // Угол отсчитываем от 12 часов по часовой стрелке — так же, как стоит
  // указатель, поэтому целевой угол считается без пересчёта систем.
  function pointAt(angle, radius) {
    var a = (angle - 90) * Math.PI / 180;
    return { x: CX + radius * Math.cos(a), y: CY + radius * Math.sin(a) };
  }

  function arcPath(from, to) {
    var a = pointAt(from, R);
    var b = pointAt(to, R);
    var large = to - from > 180 ? 1 : 0;

    // Полный круг одной дугой не рисуется: начало и конец совпадают,
    // и браузер не понимает, куда вести линию.
    if (to - from >= 359.9) {
      return "M " + CX + " " + (CY - R) +
             " A " + R + " " + R + " 0 1 1 " + (CX - 0.01) + " " + (CY - R) + " Z";
    }

    return "M " + CX + " " + CY +
           " L " + a.x.toFixed(2) + " " + a.y.toFixed(2) +
           " A " + R + " " + R + " 0 " + large + " 1 " + b.x.toFixed(2) + " " + b.y.toFixed(2) +
           " Z";
  }

  // Текст вдоль радиуса: в узком секторе ограничением становится высота
  // строки, а не её длина, поэтому подписи влезают даже в тонкие доли.
  function radialText(content, angle, radius, cls, fill) {
    var p = pointAt(angle, radius);
    var node = document.createElementNS(SVG_NS, "text");
    node.setAttribute("x", p.x.toFixed(2));
    node.setAttribute("y", p.y.toFixed(2));
    node.setAttribute("text-anchor", "middle");
    node.setAttribute("dominant-baseline", "central");
    node.setAttribute("class", cls);
    if (fill) node.setAttribute("fill", fill);

    // В левой половине круга строку разворачиваем, иначе она встанет вверх ногами.
    var rot = angle > 180 ? angle + 90 : angle - 90;
    node.setAttribute("transform", "rotate(" + rot.toFixed(2) + " " + p.x.toFixed(2) + " " + p.y.toFixed(2) + ")");
    node.textContent = content;
    return node;
  }

  // Тёмная подпись на тёмном секторе не читается, поэтому цвет чернил
  // выбираем по яркости фона.
  function readableOn(hex) {
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return "#0b0c10";
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    var lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return lum > 0.55 ? "#0b0c10" : "#f2f4f8";
  }

  function trim(text, max) {
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  /* ============================================================ прокрут */

  function renderSpins() {
    el.spinsCount.textContent = state.spins;
    el.spins.classList.toggle("hot", state.spins > 0);

    if (state.spinning) return;

    if (state.spins > 0) {
      el.spinBtn.disabled = false;
      el.spinBtn.textContent = "Крутить";
      el.hint.textContent = state.spins === 1
        ? "Один прокрут ждёт тебя"
        : "Доступно прокрутов: " + state.spins;
    } else {
      el.spinBtn.disabled = true;
      el.spinBtn.textContent = "Прокрутов нет";
      el.hint.textContent = "Отсканируй QR-код на ресепшене клуба — прокрут откроется сразу.";
    }
  }

  function handleSpin() {
    if (state.spinning || state.spins <= 0) return;

    state.spinning = true;
    el.spinBtn.disabled = true;
    el.spinBtn.textContent = "Крутим...";
    el.result.hidden = true;
    el.banner.hidden = true;
    el.hint.textContent = "";
    haptic("impact");

    api("/api/spin", { method: "POST" })
      .then(function (res) {
        state.spins = typeof res.spinsLeft === "number" ? res.spinsLeft : Math.max(0, state.spins - 1);
        spinTo(findSlice(res.prizeKey), function () { showResult(res); });
      })
      .catch(function (err) {
        state.spinning = false;
        if (err.status === 403) {
          state.spins = 0;
          toast("Прокрутов больше нет", true);
        } else {
          toast("Не получилось: " + err.message, true);
        }
        renderSpins();
      });
  }

  function findSlice(prizeKey) {
    var slices = layout();
    for (var i = 0; i < slices.length; i++) {
      if (slices[i].sector.key === prizeKey) return slices[i];
    }
    return slices[0] || null;
  }

  // Приз выбирает сервер, колесо лишь доезжает до нужного сектора.
  // Никакой подкрутки после остановки: где встало — то и выпало.
  function spinTo(slice, done) {
    if (!slice) { state.spinning = false; done(); return; }

    // Останавливаемся не строго в центре, а в случайной точке внутри
    // сектора — так остановка выглядит живой, а не отрепетированной.
    var jitter = (Math.random() - 0.5) * slice.span * 0.6;
    var landing = slice.mid + jitter;

    var target = ((360 - landing) % 360 + 360) % 360;
    var current = ((state.rotation % 360) + 360) % 360;
    var delta = ((target - current) % 360 + 360) % 360;

    // Всегда добавляем угол вперёд: если крутить назад, колесо дёргается.
    state.rotation += 360 * 6 + delta;

    el.rotor.classList.add("spinning");
    el.rotor.style.transform = "rotate(" + state.rotation + "deg)";

    setTimeout(function () {
      state.spinning = false;
      done();
    }, 4300);
  }

  function showResult(res) {
    var prize = res.prize;

    if (!prize) {
      el.result.className = "result";
      el.resultIcon.textContent = "🎲";
      el.resultTitle.textContent = "В этот раз пусто";
      el.resultSub.textContent = "Не расстраивайся — следующий визит, новый прокрут.";
      el.resultCode.hidden = true;
      haptic("warning");
    } else {
      el.result.className = "result win";
      el.resultIcon.textContent = prize.icon || "🎁";
      el.resultTitle.textContent = prize.title;
      el.resultSub.textContent = "Покажи код сотруднику на стойке · сгорает через " + until(prize.expiresAt);
      el.resultCode.textContent = prize.code;
      el.resultCode.dataset.code = prize.code;
      el.resultCode.hidden = false;

      state.items.unshift({
        title: prize.title,
        tier: prize.tier,
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

  function prizeCard(item, done) {
    var li = document.createElement("li");
    li.className = "card";

    var left = new Date(item.expiresAt).getTime() - Date.now();
    var expiringSoon = !done && left > 0 && left < 24 * 3600000;

    li.appendChild(
      row(
        item.icon || "🎁",
        item.title,
        span("tier tier-" + (item.tier || "COMMON"), item.tier || ""),
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
      ic.textContent = icon;
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

  /* ============================================================ кабинет владельца */

  // Отчёт перечитываем при каждом открытии вкладки: владелец смотрит
  // на живые цифры, а не на срез момента, когда приложение запустилось.
  function loadAdmin() {
    loadStats();
  }

  function loadStats() {
    el.statTiles.innerHTML = '<p class="skeleton">Считаем...</p>';

    api("/api/admin/stats?days=" + state.adminDays)
      .then(function (data) {
        renderTiles(data.summary);
        renderFunnel(data.prizes);
        renderOutstanding(data.outstanding, data.summary);
        renderSources(data.sources);
        renderActivity(data.activity);
      })
      .catch(function (err) {
        el.statTiles.innerHTML = "";
        el.statTiles.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  function renderTiles(s) {
    if (!s) return;

    var takeRate = s.prizesWon > 0 ? Math.round((s.redeemed / s.prizesWon) * 100) : 0;

    var tiles = [
      { value: s.checkins, label: "визитов по QR", cls: "accent" },
      { value: s.spins, label: "прокрутов", cls: "" },
      { value: s.prizesWon, label: "призов выиграно", cls: "" },
      { value: takeRate + "%", label: "призов забрали", cls: takeRate >= 50 ? "accent" : "warn" },
      { value: s.outstandingAll, label: "кодов на руках прямо сейчас", cls: "warn" },
      { value: s.uniqueClients, label: "клиентов крутили", cls: "" },
      { value: s.newClients, label: "новых клиентов", cls: "" },
      { value: s.totalClients, label: "всего в базе", cls: "" }
    ];

    el.statTiles.innerHTML = "";
    tiles.forEach(function (t) {
      var box = document.createElement("div");
      box.className = "tile " + t.cls;
      box.appendChild(fill("tile-value", String(t.value)));
      box.appendChild(fill("tile-label", t.label));
      el.statTiles.appendChild(box);
    });
  }

  // Воронка приза: выпал -> забрали -> висит на руках -> сгорел.
  // Цифры сходятся: выпал = забрали + на руках + сгорел.
  function renderFunnel(prizes) {
    var table = el.funnelTable;
    table.innerHTML = "";

    var head = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["Приз", "Выпал", "Забрали", "На руках", "Сгорел", "%"].forEach(function (label) {
      var th = document.createElement("th");
      th.textContent = label;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = document.createElement("tbody");
    var totals = { won: 0, redeemed: 0, outstanding: 0, expired: 0 };

    (prizes || []).forEach(function (p) {
      totals.won += p.won;
      totals.redeemed += p.redeemed;
      totals.outstanding += p.outstanding;
      totals.expired += p.expired;

      var rate = p.won > 0 ? Math.round((p.redeemed / p.won) * 100) : null;
      var tr = document.createElement("tr");

      tr.appendChild(cell((p.icon || "🎁") + " " + (p.short_title || p.title || p.key), ""));
      tr.appendChild(cell(p.won, "num"));
      tr.appendChild(cell(p.redeemed, "num"));
      tr.appendChild(cell(p.outstanding, "num out"));
      tr.appendChild(cell(p.expired, "num"));
      tr.appendChild(cell(rate === null ? "—" : rate + "%", "num " + rateClass(rate)));

      body.appendChild(tr);
    });

    table.appendChild(body);

    var overall = totals.won > 0 ? Math.round((totals.redeemed / totals.won) * 100) : 0;
    el.funnelFoot.textContent = totals.won === 0
      ? "За выбранный период призов ещё не выигрывали."
      : "Всего за период: выпало " + totals.won + ", забрали " + totals.redeemed +
        " (" + overall + "%), сгорело " + totals.expired +
        ". Низкий процент означает, что призы выигрывают, но за ними не приходят — стоит увеличить срок или заменить приз.";
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
  function renderOutstanding(list, summary) {
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

    var total = summary ? summary.outstandingAll : list.length;
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

    api("/api/admin/prizes")
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
      icon.textContent = prize.icon || "🎁";
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
      var fShort = field("Подпись в секторе", input("text", prize.short_title || ""));
      var fIcon  = field("Иконка", input("text", prize.icon || ""));
      var fWeight = field("Вес (шанс)", input("number", prize.weight));
      var fDays  = field("Сгорает через, дней", input("number", prize.expires_in_days));
      var fLimit = field("Лимит в сутки", input("number", prize.daily_limit === null ? "" : prize.daily_limit));
      var fColor = field("Цвет сектора", input("color", prize.color || "#a6ff2f"));

      [fTitle, fShort, fIcon, fWeight, fDays, fLimit, fColor].forEach(function (f) { grid.appendChild(f.wrap); });
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
          short_title: fShort.input.value || null,
          icon: fIcon.input.value || null,
          weight: Number(fWeight.input.value),
          expires_in_days: Number(fDays.input.value),
          daily_limit: fLimit.input.value === "" ? null : Number(fLimit.input.value),
          color: fColor.input.value,
          enabled: check.checked
        };

        api("/api/admin/prizes", { method: "PATCH", body: patch })
          .then(function (res) {
            Object.assign(prize, res.prize);
            state.prizes = null;
            toast("Сохранено");
            haptic("success");
            // Колесо читает те же строки, поэтому перетягиваем конфиг —
            // сектор сразу меняет ширину, цвет и подпись.
            return api("/api/config").then(function (cfg) {
              state.sectors = cfg.sectors || [];
              renderWheel();
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

  function loadClients() {
    el.clientsList.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin/clients")
      .then(function (data) {
        var clients = data.clients || [];
        el.clientsList.innerHTML = "";

        if (!clients.length) {
          el.clientsList.appendChild(fill("skeleton", "В базе пока никого"));
          return;
        }

        var lost = clients.filter(function (c) {
          return c.last_seen && Date.now() - new Date(c.last_seen).getTime() > 14 * 86400000;
        }).length;

        el.clientsFoot.textContent = "Всего " + clients.length + " клиентов. " +
          (lost > 0
            ? lost + " не заходили больше двух недель — их можно вернуть бонусным прокрутом."
            : "Все заходили в последние две недели.");

        clients.forEach(function (c) {
          var li = document.createElement("li");
          li.className = "card";

          var name = c.first_name || (c.username ? "@" + c.username : "ID " + c.id);
          var sub = "визитов: " + (c.visits_total || 0) +
                    " · выиграл: " + c.won +
                    " · забрал: " + c.redeemed;

          li.appendChild(row("👤", name, sub, ago(c.last_seen)));
          el.clientsList.appendChild(li);
        });
      })
      .catch(function (err) {
        el.clientsList.innerHTML = "";
        el.clientsList.appendChild(fill("skeleton", "Не удалось загрузить: " + err.message));
      });
  }

  /* ---------------------------------------------------- клуб: настройки и персонал */

  function loadTeam() {
    renderSettings();
    renderStaffForm();
    loadStaff();
  }

  function renderSettings() {
    if (el.settingsForm.dataset.ready) return;
    el.settingsForm.dataset.ready = "1";
    el.settingsForm.innerHTML = '<p class="skeleton">Загружаем...</p>';

    api("/api/admin/settings")
      .then(function (data) {
        var s = data.settings;
        el.settingsForm.innerHTML = "";

        var fName = field("Название клуба", input("text", s.club_name), true);
        var fHours = field("Прокрут по QR не чаще, часов", input("number", s.spin_cooldown_hours), true);

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
        el.settingsForm.appendChild(toggleWrap);
        el.settingsForm.appendChild(save);

        var note = fill("foot", "24 часа — один прокрут за визит в день. Когда подключим API кассы клуба, здесь можно будет поставить 0 и начислять прокрут за каждую оплату часов.");
        el.settingsForm.appendChild(note);

        save.addEventListener("click", function () {
          save.disabled = true;
          api("/api/admin/settings", {
            method: "PATCH",
            body: {
              club_name: fName.input.value,
              spin_cooldown_hours: Number(fHours.input.value),
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
      api("/api/admin/staff", { method: "POST", body: { id: id, role: "staff", title: fTitle.input.value || null } })
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

    api("/api/admin/staff")
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
              api("/api/admin/staff?id=" + member.id, { method: "DELETE" })
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
